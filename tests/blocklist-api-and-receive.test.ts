import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { app, receiveEmail, type InboundEmailEvent } from "../workers/index";
import type { Env } from "../workers/types";

interface StoredObject {
	body: Uint8Array;
	customMetadata?: Record<string, string>;
	uploaded: Date;
}

/**
 * Minimal persistent R2 bucket mock with call spies to verify both
 * persistence across requests and zero R2 writes when rejecting blocked emails.
 */
function createMockBucket() {
	const store = new Map<string, StoredObject>();
	const putCalls: string[] = [];
	const deleteCalls: string[][] = [];

	const bucket = {
		store,
		putCalls,
		deleteCalls,
		async head(key: string) {
			const item = store.get(key);
			if (!item) return null;
			return {
				key,
				size: item.body.byteLength,
				uploaded: item.uploaded,
				customMetadata: item.customMetadata,
			};
		},
		async get(key: string) {
			const item = store.get(key);
			if (!item) return null;
			return {
				key,
				size: item.body.byteLength,
				uploaded: item.uploaded,
				customMetadata: item.customMetadata,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(item.body);
						controller.close();
					},
				}),
				async text() {
					return new TextDecoder().decode(item.body);
				},
				async json<T = unknown>() {
					return JSON.parse(new TextDecoder().decode(item.body)) as T;
				},
			};
		},
		async put(
			key: string,
			value: string | ArrayBuffer | Uint8Array,
			options?: { customMetadata?: Record<string, string> },
		) {
			putCalls.push(key);
			let bytes: Uint8Array;
			if (typeof value === "string") {
				bytes = new TextEncoder().encode(value);
			} else if (value instanceof Uint8Array) {
				bytes = value;
			} else {
				bytes = new Uint8Array(value);
			}
			store.set(key, {
				body: bytes,
				customMetadata: options?.customMetadata
					? { ...options.customMetadata }
					: undefined,
				uploaded: new Date(),
			});
			return { key };
		},
		async delete(keys: string | string[]) {
			const arr = Array.isArray(keys) ? keys : [keys];
			deleteCalls.push(arr);
			for (const k of arr) {
				store.delete(k);
			}
		},
		async list(options?: { prefix?: string; cursor?: string }) {
			const prefix = options?.prefix ?? "";
			const objects = [...store.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, item]) => ({
					key,
					size: item.body.byteLength,
					uploaded: item.uploaded,
					customMetadata: item.customMetadata,
				}));
			return {
				objects,
				truncated: false,
			};
		},
	};

	return bucket;
}

function createMockTestEnv() {
	const bucket = createMockBucket();
	const createdEmails: Array<{
		mailboxId: string;
		folder: string;
		email: Record<string, unknown>;
		attachments: unknown[];
	}> = [];
	const mailboxGetCalls: string[] = [];
	const agentFetchCalls: Array<{ mailboxId: string; url: string; body: string }> = [];

	const env = {
		BUCKET: bucket as unknown as R2Bucket,
		EMAIL_ADDRESSES: [] as string[],
		DOMAINS: "my.dev",
		POLICY_AUD: "",
		TEAM_DOMAIN: "",
		MAILBOX: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId;
			},
			get(id: DurableObjectId) {
				const mailboxId = String(id);
				mailboxGetCalls.push(mailboxId);
				return {
					async getFolders() {
						return [{ id: "inbox", name: "Inbox", unreadCount: 0 }];
					},
					async findThreadBySubject() {
						return null;
					},
					async createEmail(
						folder: string,
						email: Record<string, unknown>,
						attachments: unknown[],
					) {
						createdEmails.push({ mailboxId, folder, email, attachments });
					},
				} as unknown as DurableObjectStub<any>;
			},
		} as unknown as DurableObjectNamespace<any>,
		EMAIL_AGENT: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId;
			},
			get(id: DurableObjectId) {
				const mailboxId = String(id);
				return {
					async fetch(req: Request) {
						agentFetchCalls.push({
							mailboxId,
							url: req.url,
							body: await req.text(),
						});
						return new Response(JSON.stringify({ status: "draft_generated" }));
					},
				} as unknown as DurableObjectStub<any>;
			},
		} as unknown as DurableObjectNamespace<any>,
		EMAIL: {
			async send() {
				return { messageId: "mock-msg-id" };
			},
		} as unknown as SendEmail,
		AI: {} as Ai,
	} as unknown as Env;

	const pendingPromises: Promise<unknown>[] = [];
	const ctx: ExecutionContext = {
		waitUntil(p: Promise<unknown>) {
			pendingPromises.push(p);
		},
		passThroughOnException() {},
		props: {},
	};

	return {
		env,
		ctx,
		bucket,
		createdEmails,
		mailboxGetCalls,
		agentFetchCalls,
		async flushWaitUntil() {
			await Promise.all(pendingPromises.splice(0));
		},
	};
}

function buildMimeEmail(opts: {
	from: string;
	to: string;
	subject: string;
	body: string;
	withAttachment?: boolean;
}): {
	raw: ReadableStream<Uint8Array>;
	rawSize: number;
	headers: Headers;
} {
	let mime: string;
	if (opts.withAttachment) {
		const boundary = "----boundary_test_12345";
		mime = [
			`From: ${opts.from}`,
			`To: ${opts.to}`,
			`Subject: ${opts.subject}`,
			"MIME-Version: 1.0",
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			opts.body,
			`--${boundary}`,
			'Content-Type: text/plain; name="note.txt"',
			'Content-Disposition: attachment; filename="note.txt"',
			"",
			"attachment payload",
			`--${boundary}--`,
			"",
		].join("\r\n");
	} else {
		mime = [
			`From: ${opts.from}`,
			`To: ${opts.to}`,
			`Subject: ${opts.subject}`,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			opts.body,
			"",
		].join("\r\n");
	}

	const bytes = new TextEncoder().encode(mime);
	const headers = new Headers({
		from: opts.from,
		to: opts.to,
		subject: opts.subject,
	});
	const raw = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	return { raw, rawSize: bytes.byteLength, headers };
}

describe("Blocked Senders API CRUD & Persistence", () => {
	it("supports adding, viewing, and deleting global and per-mailbox blocklists persistently in R2", async () => {
		const t = createMockTestEnv();

		// Create two mailboxes: alice@my.dev and bob@my.dev
		for (const email of ["alice@my.dev", "bob@my.dev"]) {
			const res = await app.request(
				"/api/v1/mailboxes",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, name: email.split("@")[0] }),
				},
				t.env,
				t.ctx,
			);
			assert.equal(res.status, 201);
		}

		// 1. Add global email & domain rules (including non-ASCII reason)
		const addGlobalEmailRes = await app.request(
			"/api/v1/blocked-senders",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pattern: "  Spam@Example.COM ",
					reason: "垃圾邮件发送者",
				}),
			},
			t.env,
			t.ctx,
		);
		assert.equal(addGlobalEmailRes.status, 201);
		const globalEmailEntry = (await addGlobalEmailRes.json()) as any;
		assert.equal(globalEmailEntry.pattern, "spam@example.com");
		assert.equal(globalEmailEntry.type, "email");
		assert.equal(globalEmailEntry.scope, "global");
		assert.equal(globalEmailEntry.reason, "垃圾邮件发送者");

		// Duplicate returns 409
		const dupRes = await app.request(
			"/api/v1/blocked-senders",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pattern: "spam@example.com" }),
			},
			t.env,
			t.ctx,
		);
		assert.equal(dupRes.status, 409);

		// Invalid pattern returns 400
		const invalidRes = await app.request(
			"/api/v1/blocked-senders",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pattern: "@not_a_valid_domain" }),
			},
			t.env,
			t.ctx,
		);
		assert.equal(invalidRes.status, 400);

		// Add global domain rule
		const addGlobalDomainRes = await app.request(
			"/api/v1/blocked-senders",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pattern: "@BadDomain.ORG" }),
			},
			t.env,
			t.ctx,
		);
		assert.equal(addGlobalDomainRes.status, 201);

		// Verify R2 persistence directly
		const r2GlobalKeys = [...t.bucket.store.keys()].filter((k) =>
			k.startsWith("blocked-senders/global/"),
		);
		assert.equal(r2GlobalKeys.length, 2);

		// List global rules
		const listGlobalRes = await app.request(
			"/api/v1/blocked-senders",
			{ method: "GET" },
			t.env,
			t.ctx,
		);
		assert.equal(listGlobalRes.status, 200);
		const globalList = (await listGlobalRes.json()) as any[];
		assert.equal(globalList.length, 2);
		assert.deepEqual(
			globalList.map((e) => e.pattern).sort(),
			["@baddomain.org", "spam@example.com"],
		);

		// 2. Add mailbox-specific rule for alice@my.dev
		const addAliceRes = await app.request(
			`/api/v1/mailboxes/${encodeURIComponent("alice@my.dev")}/blocked-senders`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pattern: "@annoying.io" }),
			},
			t.env,
			t.ctx,
		);
		assert.equal(addAliceRes.status, 201);
		const aliceEntry = (await addAliceRes.json()) as any;
		assert.equal(aliceEntry.scope, "mailbox");
		assert.equal(aliceEntry.mailboxId, "alice@my.dev");

		// Bob's mailbox blocklist remains empty & isolated
		const listBobRes = await app.request(
			`/api/v1/mailboxes/${encodeURIComponent("bob@my.dev")}/blocked-senders`,
			{ method: "GET" },
			t.env,
			t.ctx,
		);
		assert.equal(listBobRes.status, 200);
		assert.deepEqual(await listBobRes.json(), []);

		// Non-existent mailbox returns 404
		const missingMbRes = await app.request(
			`/api/v1/mailboxes/${encodeURIComponent("nobody@my.dev")}/blocked-senders`,
			{ method: "GET" },
			t.env,
			t.ctx,
		);
		assert.equal(missingMbRes.status, 404);

		// 3. Delete global rule and verify removal
		const delGlobalRes = await app.request(
			`/api/v1/blocked-senders/${encodeURIComponent(globalEmailEntry.id)}`,
			{ method: "DELETE" },
			t.env,
			t.ctx,
		);
		assert.equal(delGlobalRes.status, 204);

		const delGlobalAgain = await app.request(
			`/api/v1/blocked-senders/${encodeURIComponent(globalEmailEntry.id)}`,
			{ method: "DELETE" },
			t.env,
			t.ctx,
		);
		assert.equal(delGlobalAgain.status, 404);

		// 4. Deleting alice's mailbox cleans up her per-mailbox blocklist objects in R2
		const delMailboxRes = await app.request(
			`/api/v1/mailboxes/${encodeURIComponent("alice@my.dev")}`,
			{ method: "DELETE" },
			t.env,
			t.ctx,
		);
		assert.equal(delMailboxRes.status, 204);
		const remainingMailboxKeys = [...t.bucket.store.keys()].filter((k) =>
			k.startsWith("blocked-senders/mailboxes/"),
		);
		assert.equal(remainingMailboxKeys.length, 0);
	});
});

describe("Inbound Email Routing blocklist rejection & normal email delivery", () => {
	it("rejects global blocked email and domain via setReject without touching DO, R2, or AI", async () => {
		const t = createMockTestEnv();

		// Setup mailbox
		await app.request(
			"/api/v1/mailboxes",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "inbox@my.dev", name: "Inbox" }),
			},
			t.env,
			t.ctx,
		);

		// Block single address & domain globally
		await app.request(
			"/api/v1/blocked-senders",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pattern: "spam@evil.com" }),
			},
			t.env,
			t.ctx,
		);
		await app.request(
			"/api/v1/blocked-senders",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pattern: "@bulk-spam.org" }),
			},
			t.env,
			t.ctx,
		);

		// Reset call spies before inbound delivery
		t.bucket.putCalls.length = 0;
		t.mailboxGetCalls.length = 0;
		t.createdEmails.length = 0;
		t.agentFetchCalls.length = 0;

		// Case 1: Blocked exact email (case-insensitive, with attachment!)
		let rejectReason1: string | null = null;
		const msg1 = buildMimeEmail({
			from: '"Spammer" <SPAM@EVIL.COM>',
			to: "inbox@my.dev",
			subject: "Win a prize",
			body: "Spam body",
			withAttachment: true,
		});
		const event1: InboundEmailEvent = {
			from: "SPAM@EVIL.COM",
			to: "inbox@my.dev",
			headers: msg1.headers,
			raw: msg1.raw,
			rawSize: msg1.rawSize,
			setReject(reason: string) {
				rejectReason1 = reason;
			},
		};
		await receiveEmail(event1, t.env, t.ctx);
		await t.flushWaitUntil();

		assert.ok(rejectReason1, "Expected setReject to be called for blocked email");
		assert.equal(t.mailboxGetCalls.length, 0, "Should not access MailboxDO");
		assert.equal(t.createdEmails.length, 0, "Should not write email to DO");
		assert.equal(t.bucket.putCalls.length, 0, "Should not write attachment to R2");
		assert.equal(t.agentFetchCalls.length, 0, "Should not trigger AI draft");

		// Case 2: Blocked domain via subdomain + third-party ESP envelope sender (MIME From match)
		let rejectReason2: string | null = null;
		const msg2 = buildMimeEmail({
			from: '"Newsletter" <promo@mailer.Bulk-Spam.ORG>',
			to: "inbox@my.dev",
			subject: "Unsubscribe",
			body: "Marketing body",
			withAttachment: true,
		});
		const event2: InboundEmailEvent = {
			from: "bounces+999@esp-delivery.net",
			to: "inbox@my.dev",
			// Simulate outer headers missing or generic so MIME parse path is also exercised
			raw: msg2.raw,
			rawSize: msg2.rawSize,
			setReject(reason: string) {
				rejectReason2 = reason;
			},
		};
		await receiveEmail(event2, t.env, t.ctx);
		await t.flushWaitUntil();

		assert.ok(rejectReason2, "Expected setReject to be called for blocked domain");
		assert.equal(t.mailboxGetCalls.length, 0);
		assert.equal(t.createdEmails.length, 0);
		assert.equal(t.bucket.putCalls.length, 0);
		assert.equal(t.agentFetchCalls.length, 0);
	});

	it("enforces per-mailbox blocklists independently without affecting other mailboxes or normal emails", async () => {
		const t = createMockTestEnv();

		for (const email of ["alice@my.dev", "bob@my.dev"]) {
			await app.request(
				"/api/v1/mailboxes",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, name: email.split("@")[0] }),
				},
				t.env,
				t.ctx,
			);
		}

		// Alice blocks @example.com; Bob does NOT
		await app.request(
			`/api/v1/mailboxes/${encodeURIComponent("alice@my.dev")}/blocked-senders`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pattern: "@example.com" }),
			},
			t.env,
			t.ctx,
		);

		t.bucket.putCalls.length = 0;
		t.mailboxGetCalls.length = 0;
		t.createdEmails.length = 0;
		t.agentFetchCalls.length = 0;

		// 1. Email from sales@example.com to alice@my.dev -> REJECTED
		let aliceRejected: string | null = null;
		const toAlice = buildMimeEmail({
			from: "sales@example.com",
			to: "alice@my.dev",
			subject: "Offer",
			body: "Blocked for Alice",
			withAttachment: true,
		});
		await receiveEmail(
			{
				from: "sales@example.com",
				to: "alice@my.dev",
				headers: toAlice.headers,
				raw: toAlice.raw,
				rawSize: toAlice.rawSize,
				setReject(r) {
					aliceRejected = r;
				},
			},
			t.env,
			t.ctx,
		);
		await t.flushWaitUntil();

		assert.ok(aliceRejected, "Expected Alice's mailbox rule to reject @example.com");
		assert.equal(t.createdEmails.length, 0);
		assert.equal(t.bucket.putCalls.length, 0);
		assert.equal(t.agentFetchCalls.length, 0);

		// 2. Email from sales@example.com to bob@my.dev -> DELIVERED NORMALLY
		let bobRejected: string | null = null;
		const toBob = buildMimeEmail({
			from: "sales@example.com",
			to: "bob@my.dev",
			subject: "Offer for Bob",
			body: "Allowed for Bob",
			withAttachment: true,
		});
		await receiveEmail(
			{
				from: "sales@example.com",
				to: "bob@my.dev",
				headers: toBob.headers,
				raw: toBob.raw,
				rawSize: toBob.rawSize,
				setReject(r) {
					bobRejected = r;
				},
			},
			t.env,
			t.ctx,
		);
		await t.flushWaitUntil();

		assert.equal(bobRejected, null, "Bob did not block @example.com");
		assert.equal(t.createdEmails.length, 1);
		assert.equal(t.createdEmails[0].mailboxId, "bob@my.dev");
		assert.equal(t.createdEmails[0].folder, "inbox");
		assert.equal(t.createdEmails[0].email.sender, "sales@example.com");
		assert.equal(t.bucket.putCalls.length, 1, "Attachment should be stored in R2");
		assert.equal(t.agentFetchCalls.length, 1, "AI auto-draft should be triggered");

		// 3. Lookalike domain `friend@notexample.com` and `friend@example.com.cn` to alice@my.dev -> DELIVERED NORMALLY
		for (const safeSender of [
			"friend@notexample.com",
			"friend@example.com.cn",
			"example.com@good.org",
		]) {
			let safeRejected: string | null = null;
			const safeMsg = buildMimeEmail({
				from: safeSender,
				to: "alice@my.dev",
				subject: "Hello Alice",
				body: "Legitimate message",
			});
			await receiveEmail(
				{
					from: safeSender,
					to: "alice@my.dev",
					headers: safeMsg.headers,
					raw: safeMsg.raw,
					rawSize: safeMsg.rawSize,
					setReject(r) {
						safeRejected = r;
					},
				},
				t.env,
				t.ctx,
			);
			await t.flushWaitUntil();
			assert.equal(
				safeRejected,
				null,
				`Legitimate sender ${safeSender} must not be falsely blocked`,
			);
		}

		assert.equal(t.createdEmails.length, 4);
		assert.equal(t.agentFetchCalls.length, 4);
	});
});
