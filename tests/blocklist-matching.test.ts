import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	type BlockedSender,
	BlocklistValidationError,
	decodeBlockedSenderId,
	encodeBlockedSenderId,
	extractAllEmailAddresses,
	extractDomainPattern,
	extractEmailAddress,
	findMatchingBlockedRule,
	matchesBlockedRule,
	normalizeBlockPattern,
} from "../shared/blocklist";

describe("Blocklist pattern normalization and validation", () => {
	it("normalizes single email addresses case-insensitively", () => {
		assert.deepEqual(normalizeBlockPattern("  Spam@Example.COM  "), {
			pattern: "spam@example.com",
			type: "email",
		});
		assert.deepEqual(normalizeBlockPattern("user.name+promo@sub.domain.co.uk"), {
			pattern: "user.name+promo@sub.domain.co.uk",
			type: "email",
		});
	});

	it("normalizes domain patterns with or without leading @", () => {
		assert.deepEqual(normalizeBlockPattern("@Example.COM"), {
			pattern: "@example.com",
			type: "domain",
		});
		assert.deepEqual(normalizeBlockPattern("  @MAIL.Example.org  "), {
			pattern: "@mail.example.org",
			type: "domain",
		});
		assert.deepEqual(normalizeBlockPattern("Example.COM"), {
			pattern: "@example.com",
			type: "domain",
		});
	});

	it("rejects invalid email and domain patterns", () => {
		const invalidInputs = [
			"",
			"   ",
			"@",
			"@@example.com",
			"*@example.com",
			"@*.example.com",
			"@localhost",
			"@.example.com",
			"@example.com.",
			"@example..com",
			"user@",
			"user@localhost",
			"user@.example.com",
			"user@example..com",
			".user@example.com",
			"user.@example.com",
			"bad space@example.com",
			"<spam@example.com>",
			"user@123.456",
		];

		for (const input of invalidInputs) {
			assert.throws(
				() => normalizeBlockPattern(input),
				BlocklistValidationError,
				`Expected "${input}" to throw BlocklistValidationError`,
			);
		}
	});

	it("round-trips deterministic URL-safe IDs", () => {
		for (const pattern of ["spam@example.com", "@example.com", "a+b@sub.test.io"]) {
			const id = encodeBlockedSenderId(pattern);
			assert.match(id, /^[A-Za-z0-9_-]+$/);
			assert.equal(decodeBlockedSenderId(id), pattern);
		}
		assert.equal(decodeBlockedSenderId("not valid!"), null);
	});
});

describe("Email extraction and boundary-safe matching", () => {
	it("extracts normalized email addresses from RFC 5322 headers", () => {
		assert.equal(
			extractEmailAddress('"Spammer Name" <Spam@Example.COM>'),
			"spam@example.com",
		);
		assert.equal(extractEmailAddress("<bounce@mailer.example.org>"), "bounce@mailer.example.org");
		assert.equal(
			extractEmailAddress('"@spoofed.com" <real@legit.org>'),
			"real@legit.org",
		);
		assert.equal(extractDomainPattern('"User" <User@Sub.Example.COM>'), "@sub.example.com");
	});

	it("extracts multiple addresses from multi-sender From headers", () => {
		const addrs = extractAllEmailAddresses(
			'"Spoofed, Inc." <ok@legit.com>, "Hidden" <SPAM@BAD.COM>',
		);
		assert.deepEqual(addrs, ["ok@legit.com", "spam@bad.com"]);
	});

	it("matches email rules case-insensitively without substring false positives", () => {
		const rule = { pattern: "spam@example.com", type: "email" as const };

		assert.equal(matchesBlockedRule("spam@example.com", rule), true);
		assert.equal(matchesBlockedRule("SPAM@EXAMPLE.COM", rule), true);
		assert.equal(matchesBlockedRule('"Spammer" <Spam@Example.com>', rule), true);

		// Must NOT match different local parts or domains
		assert.equal(matchesBlockedRule("notspam@example.com", rule), false);
		assert.equal(matchesBlockedRule("spam2@example.com", rule), false);
		assert.equal(matchesBlockedRule("other@example.com", rule), false);
		assert.equal(matchesBlockedRule("spam@sub.example.com", rule), false);
		assert.equal(matchesBlockedRule("spam@notexample.com", rule), false);
	});

	it("matches domain rules using strict full domain boundaries", () => {
		const domainRule = { pattern: "@example.com", type: "domain" as const };

		// Exact domain & subdomains match (case-insensitive)
		assert.equal(matchesBlockedRule("spam@example.com", domainRule), true);
		assert.equal(matchesBlockedRule("USER@EXAMPLE.COM", domainRule), true);
		assert.equal(matchesBlockedRule("bounce@mail.example.com", domainRule), true);
		assert.equal(matchesBlockedRule("news@a.b.example.com", domainRule), true);

		// Lookalike domains without full label boundaries MUST NOT match
		assert.equal(matchesBlockedRule("user@notexample.com", domainRule), false);
		assert.equal(matchesBlockedRule("user@my-example.com", domainRule), false);
		assert.equal(matchesBlockedRule("user@example.com.cn", domainRule), false);
		assert.equal(matchesBlockedRule("user@example.com.evil.org", domainRule), false);
		assert.equal(matchesBlockedRule("user@example.co", domainRule), false);
		assert.equal(matchesBlockedRule("example.com@gmail.com", domainRule), false);
		assert.equal(
			matchesBlockedRule('"@example.com" <good@gmail.com>', domainRule),
			false,
		);

		// Subdomain rule must not block parent domain or sibling subdomain
		const subRule = { pattern: "@mail.example.com", type: "domain" as const };
		assert.equal(matchesBlockedRule("a@mail.example.com", subRule), true);
		assert.equal(matchesBlockedRule("a@ bounce.mail.example.com", subRule), false);
		assert.equal(matchesBlockedRule("a@sub.mail.example.com", subRule), true);
		assert.equal(matchesBlockedRule("a@example.com", subRule), false);
		assert.equal(matchesBlockedRule("a@othermail.example.com", subRule), false);
	});

	it("finds matching rule across envelope and MIME header candidates", () => {
		const rules: BlockedSender[] = [
			{
				id: encodeBlockedSenderId("@blocked-domain.com"),
				pattern: "@blocked-domain.com",
				type: "domain",
				scope: "global",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		];

		const matched = findMatchingBlockedRule(
			["bounce@amazonses.com", '"Marketing" <promo@news.blocked-domain.com>'],
			rules,
		);
		assert.equal(matched?.pattern, "@blocked-domain.com");

		const notMatched = findMatchingBlockedRule(
			["bounce@amazonses.com", '"Legit" <hello@notblocked-domain.com>'],
			rules,
		);
		assert.equal(notMatched, null);
	});
});
