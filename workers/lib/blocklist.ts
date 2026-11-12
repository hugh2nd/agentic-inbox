// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Persistent storage and lookup for Blocked Senders backed by Cloudflare R2.
 *
 * Supports both:
 * - Global blocklist (`blocked-senders/global/<id>.json`)
 * - Per-mailbox blocklist (`blocked-senders/mailboxes/<mailboxKey>/<id>.json`)
 *
 * Each rule is stored as an independent, deterministically-keyed R2 object so
 * concurrent additions/deletions never suffer from read-modify-write races,
 * and inbound email checks only require lightweight metadata listing without
 * Worker memory state or Durable Object writes.
 */

import {
	type BlockedSender,
	type BlockedSenderScope,
	type BlockedSenderType,
	BlocklistValidationError,
	decodeBlockedSenderId,
	encodeBlockedSenderId,
	findMatchingBlockedRule,
	normalizeBlockPattern,
} from "../../shared/blocklist";

export {
	type BlockedSender,
	type BlockedSenderScope,
	type BlockedSenderType,
	BlocklistValidationError,
	findMatchingBlockedRule,
	normalizeBlockPattern,
};

export type BlocklistTarget = "global" | { mailboxId: string };

const GLOBAL_PREFIX = "blocked-senders/global/";
const MAILBOX_ROOT_PREFIX = "blocked-senders/mailboxes/";
const MAX_REASON_LENGTH = 200;

function getPrefix(target: BlocklistTarget): string {
	if (target === "global") {
		return GLOBAL_PREFIX;
	}
	const normalizedMailbox = target.mailboxId.trim().toLowerCase();
	const mailboxKey = encodeBlockedSenderId(normalizedMailbox);
	return `${MAILBOX_ROOT_PREFIX}${mailboxKey}/`;
}

function getObjectKey(target: BlocklistTarget, id: string): string {
	return `${getPrefix(target)}${id}.json`;
}

function resolveRuleId(idOrPattern: string): string | null {
	const raw = decodeURIComponent(idOrPattern).trim();
	if (!raw) return null;

	// If caller passed a raw pattern (e.g. "spam@example.com" or "@example.com"),
	// normalize and encode it to the canonical base64url ID.
	if (raw.includes("@") || raw.includes(".")) {
		try {
			const { pattern } = normalizeBlockPattern(raw);
			return encodeBlockedSenderId(pattern);
		} catch {
			return null;
		}
	}

	// Verify it decodes to a valid pattern
	const decoded = decodeBlockedSenderId(raw);
	if (!decoded) return null;
	return raw;
}

function entryFromR2Object(
	obj: R2Object,
	prefix: string,
	target: BlocklistTarget,
): BlockedSender | null {
	if (!obj.key.startsWith(prefix) || !obj.key.endsWith(".json")) {
		return null;
	}

	const id = obj.key.slice(prefix.length, -".json".length);
	const meta = obj.customMetadata;
	const decodedPattern = meta?.pattern || decodeBlockedSenderId(id);
	if (!decodedPattern) return null;

	const pattern = decodedPattern.toLowerCase();
	const type: BlockedSenderType =
		meta?.type === "domain" || pattern.startsWith("@") ? "domain" : "email";
	const scope: BlockedSenderScope = target === "global" ? "global" : "mailbox";
	const mailboxId =
		target === "global"
			? undefined
			: meta?.mailboxId
				? decodeURIComponent(meta.mailboxId)
				: target.mailboxId.toLowerCase();
	const reason = meta?.reason ? decodeURIComponent(meta.reason) : undefined;
	const createdAt =
		meta?.createdAt ||
		(obj.uploaded instanceof Date
			? obj.uploaded.toISOString()
			: new Date(0).toISOString());

	return {
		id,
		pattern,
		type,
		scope,
		...(mailboxId ? { mailboxId } : {}),
		...(reason ? { reason } : {}),
		createdAt,
	};
}

/**
 * List all blocked senders for either the global blocklist or a specific mailbox.
 */
export async function listBlockedSenders(
	bucket: R2Bucket,
	target: BlocklistTarget,
): Promise<BlockedSender[]> {
	const prefix = getPrefix(target);
	const entries: BlockedSender[] = [];
	let cursor: string | undefined;

	do {
		const list = await bucket.list({
			prefix,
			cursor,
			include: ["customMetadata"],
		});
		for (const obj of list.objects) {
			const parsed = entryFromR2Object(obj, prefix, target);
			if (parsed) {
				entries.push(parsed);
			}
		}
		cursor = list.truncated ? list.cursor : undefined;
	} while (cursor);

	entries.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1));
	return entries;
}

/**
 * Persist a blocked sender rule in R2.
 * Returns `{ entry, created: false }` if the normalized pattern already exists in the same scope.
 */
export async function addBlockedSender(
	bucket: R2Bucket,
	params: {
		pattern: string;
		reason?: string;
		target: BlocklistTarget;
	},
): Promise<{ entry: BlockedSender; created: boolean }> {
	const { pattern, type } = normalizeBlockPattern(params.pattern);
	const id = encodeBlockedSenderId(pattern);
	const key = getObjectKey(params.target, id);

	const existingObj = await bucket.get(key);
	if (existingObj) {
		try {
			const existing = (await existingObj.json()) as BlockedSender;
			return { entry: existing, created: false };
		} catch {
			const fallback = entryFromR2Object(
				existingObj,
				getPrefix(params.target),
				params.target,
			);
			if (fallback) return { entry: fallback, created: false };
		}
	}

	const scope: BlockedSenderScope =
		params.target === "global" ? "global" : "mailbox";
	const mailboxId =
		params.target === "global"
			? undefined
			: params.target.mailboxId.trim().toLowerCase();
	const trimmedReason = params.reason?.trim().slice(0, MAX_REASON_LENGTH) || undefined;
	const createdAt = new Date().toISOString();

	const entry: BlockedSender = {
		id,
		pattern,
		type,
		scope,
		...(mailboxId ? { mailboxId } : {}),
		...(trimmedReason ? { reason: trimmedReason } : {}),
		createdAt,
	};

	const customMetadata: Record<string, string> = {
		id,
		pattern,
		type,
		scope,
		createdAt,
		...(mailboxId ? { mailboxId: encodeURIComponent(mailboxId) } : {}),
		...(trimmedReason ? { reason: encodeURIComponent(trimmedReason) } : {}),
	};

	await bucket.put(key, JSON.stringify(entry), {
		httpMetadata: { contentType: "application/json" },
		customMetadata,
	});

	return { entry, created: true };
}

/**
 * Remove a blocked sender entry by ID (or normalized pattern) from R2.
 * Returns `true` if deleted, `false` if not found.
 */
export async function removeBlockedSender(
	bucket: R2Bucket,
	idOrPattern: string,
	target: BlocklistTarget,
): Promise<boolean> {
	const id = resolveRuleId(idOrPattern);
	if (!id) return false;

	const key = getObjectKey(target, id);
	const exists = await bucket.head(key);
	if (!exists) return false;

	await bucket.delete(key);
	return true;
}

/**
 * Delete all per-mailbox blocked sender entries when a mailbox is deleted.
 */
export async function deleteMailboxBlockedSenders(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<void> {
	const prefix = getPrefix({ mailboxId });
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const list = await bucket.list({ prefix, cursor });
		for (const obj of list.objects) {
			keys.push(obj.key);
		}
		cursor = list.truncated ? list.cursor : undefined;
	} while (cursor);

	if (keys.length > 0) {
		await bucket.delete(keys);
	}
}
