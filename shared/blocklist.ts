// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared sender blocklist normalization, validation, ID encoding,
 * and boundary-safe matching logic.
 *
 * Used across Workers API routes, inbound Email Routing handler,
 * and React frontend components.
 */

export type BlockedSenderType = "email" | "domain";
export type BlockedSenderScope = "global" | "mailbox";

export interface BlockedSender {
	id: string;
	pattern: string;
	type: BlockedSenderType;
	scope: BlockedSenderScope;
	mailboxId?: string;
	reason?: string;
	createdAt: string;
}

export class BlocklistValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlocklistValidationError";
	}
}

const LOCAL_PART_REGEX =
	/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_ALPHA_REGEX = /[a-z]/;

/**
 * Validate a DNS domain name (lowercase) with strict label boundaries.
 * Requires at least two labels (e.g. `example.com`) and a non-numeric TLD.
 */
export function isValidDomain(domain: string): boolean {
	if (!domain || domain.length > 253) return false;
	if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
		return false;
	}

	const labels = domain.split(".");
	if (labels.length < 2) return false;

	for (const label of labels) {
		if (!label || label.length > 63 || !DOMAIN_LABEL_REGEX.test(label)) {
			return false;
		}
	}

	const tld = labels[labels.length - 1];
	if (tld.length < 2 || !TLD_ALPHA_REGEX.test(tld)) {
		return false;
	}

	return true;
}

/**
 * Validate the local-part of an email address (lowercase).
 */
export function isValidLocalPart(local: string): boolean {
	if (!local || local.length > 64) return false;
	return LOCAL_PART_REGEX.test(local);
}

/**
 * Normalize and validate a blocklist pattern input.
 *
 * Supported formats:
 * - Single email address: `spam@example.com` -> `{ pattern: "spam@example.com", type: "email" }`
 * - Entire domain: `@example.com` (or `example.com`) -> `{ pattern: "@example.com", type: "domain" }`
 */
export function normalizeBlockPattern(rawInput: string): {
	pattern: string;
	type: BlockedSenderType;
} {
	const input = rawInput.trim().toLowerCase();
	if (!input) {
		throw new BlocklistValidationError(
			"Enter an email address (e.g. spam@example.com) or domain (e.g. @example.com)",
		);
	}

	if (/\s/.test(input) || /[<>]/.test(input) || input.includes("*")) {
		throw new BlocklistValidationError(
			"Invalid format. Use spam@example.com for an email address or @example.com for a domain",
		);
	}

	// Domain pattern starting with "@"
	if (input.startsWith("@")) {
		const domain = input.slice(1);
		if (domain.includes("@") || !isValidDomain(domain)) {
			throw new BlocklistValidationError(
				"Invalid domain format. Expected @example.com",
			);
		}
		return { pattern: `@${domain}`, type: "domain" };
	}

	// Email pattern containing "@"
	if (input.includes("@")) {
		const parts = input.split("@");
		if (parts.length !== 2) {
			throw new BlocklistValidationError(
				"Invalid email address format. Expected user@example.com",
			);
		}
		const [local, domain] = parts;
		if (!isValidLocalPart(local) || !isValidDomain(domain)) {
			throw new BlocklistValidationError(
				"Invalid email address format. Expected user@example.com",
			);
		}
		return { pattern: `${local}@${domain}`, type: "email" };
	}

	// Bare domain convenience input (e.g. "example.com" -> "@example.com")
	if (isValidDomain(input)) {
		return { pattern: `@${input}`, type: "domain" };
	}

	throw new BlocklistValidationError(
		"Invalid format. Enter an email address (spam@example.com) or domain (@example.com)",
	);
}

/**
 * Extract a single normalized (lowercase) email address from an envelope
 * sender or RFC 5322 address string such as `"Name" <User@Example.COM>`.
 */
export function extractEmailAddress(
	raw: string | undefined | null,
): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;

	// Prefer angle-bracketed address `<...>` when present so display names
	// like `"@spoofed.com" <real@other.com>` never confuse matching.
	const angleMatch = trimmed.match(/<([^<>]+)>/);
	const candidate = (angleMatch ? angleMatch[1] : trimmed).trim().toLowerCase();
	if (!candidate || /\s/.test(candidate)) return null;

	const parts = candidate.split("@");
	if (parts.length !== 2) return null;
	const [local, domain] = parts;
	if (!local || !domain || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
		return null;
	}
	return `${local}@${domain}`;
}

/**
 * Split an RFC 5322 address list header (respecting quoted display names)
 * and extract every valid normalized email address.
 */
export function extractAllEmailAddresses(
	raw: string | undefined | null,
): string[] {
	if (!raw) return [];
	const results: string[] = [];
	let current = "";
	let inQuotes = false;
	let escaped = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inQuotes = !inQuotes;
			current += ch;
			continue;
		}
		if (ch === "," && !inQuotes) {
			const addr = extractEmailAddress(current);
			if (addr && !results.includes(addr)) results.push(addr);
			current = "";
			continue;
		}
		current += ch;
	}

	const last = extractEmailAddress(current);
	if (last && !results.includes(last)) results.push(last);
	return results;
}

/**
 * Extract `@domain` from a sender string (e.g. `"User <a@Example.com>"` -> `"@example.com"`).
 */
export function extractDomainPattern(
	rawSender: string | undefined | null,
): string | null {
	const email = extractEmailAddress(rawSender);
	if (!email) return null;
	const atIdx = email.indexOf("@");
	if (atIdx < 0) return null;
	const domain = email.slice(atIdx + 1);
	return isValidDomain(domain) ? `@${domain}` : null;
}

/**
 * Check if a sender address matches a single blocklist rule.
 *
 * - Case-insensitive for both email and domain rules.
 * - Domain rules use strict label boundaries (`senderDomain === domain` or
 *   `senderDomain.endsWith("." + domain)`), preventing false positives such as
 *   `notexample.com`, `example.com.cn`, or `example.com@other.org`.
 */
export function matchesBlockedRule(
	senderInput: string,
	rule: Pick<BlockedSender, "pattern" | "type">,
): boolean {
	const email = extractEmailAddress(senderInput);
	if (!email) return false;

	const atIdx = email.indexOf("@");
	if (atIdx <= 0) return false;
	const senderDomain = email.slice(atIdx + 1);

	const pattern = rule.pattern.trim().toLowerCase();
	if (!pattern) return false;

	if (rule.type === "domain" || pattern.startsWith("@")) {
		const ruleDomain = pattern.startsWith("@") ? pattern.slice(1) : pattern;
		if (!ruleDomain) return false;
		return (
			senderDomain === ruleDomain || senderDomain.endsWith(`.${ruleDomain}`)
		);
	}

	return email === pattern;
}

/**
 * Find the first matching blocklist rule across one or more sender header/envelope values.
 */
export function findMatchingBlockedRule(
	senderCandidates: (string | undefined | null)[],
	rules: BlockedSender[],
): BlockedSender | null {
	if (rules.length === 0) return null;

	const emails: string[] = [];
	for (const candidate of senderCandidates) {
		for (const addr of extractAllEmailAddresses(candidate)) {
			if (!emails.includes(addr)) {
				emails.push(addr);
			}
		}
	}

	if (emails.length === 0) return null;

	for (const email of emails) {
		for (const rule of rules) {
			if (matchesBlockedRule(email, rule)) {
				return rule;
			}
		}
	}

	return null;
}

/**
 * Encode a normalized pattern into a deterministic URL-safe base64url ID.
 */
export function encodeBlockedSenderId(normalizedPattern: string): string {
	const bytes = new TextEncoder().encode(normalizedPattern.toLowerCase());
	let binary = "";
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Decode a base64url ID back into its normalized pattern, or null if invalid.
 */
export function decodeBlockedSenderId(id: string): string | null {
	if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
	try {
		const padded =
			id.replace(/-/g, "+").replace(/_/g, "/") +
			"=".repeat((4 - (id.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}
