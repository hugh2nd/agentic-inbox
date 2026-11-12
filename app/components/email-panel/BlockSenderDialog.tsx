// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Dialog,
	Input,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { GlobeIcon, ProhibitIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
	type BlockedSender,
	type BlockedSenderScope,
	type BlockedSenderType,
	extractDomainPattern,
	extractEmailAddress,
} from "shared/blocklist";
import { useAddBlockedSender } from "~/queries/blocked-senders";

interface BlockSenderDialogProps {
	sender: string | null;
	mailboxId?: string;
	mailboxEmail?: string;
	globalBlocked: BlockedSender[];
	mailboxBlocked: BlockedSender[];
	onClose: () => void;
}

export default function BlockSenderDialog({
	sender,
	mailboxId,
	mailboxEmail,
	globalBlocked,
	mailboxBlocked,
	onClose,
}: BlockSenderDialogProps) {
	const toastManager = useKumoToastManager();
	const addBlockedSender = useAddBlockedSender();

	const senderEmail = useMemo(() => extractEmailAddress(sender), [sender]);
	const domainPattern = useMemo(() => extractDomainPattern(sender), [sender]);

	const [targetType, setTargetType] = useState<BlockedSenderType>("email");
	const [scope, setScope] = useState<BlockedSenderScope>(
		mailboxId ? "mailbox" : "global",
	);
	const [reason, setReason] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (sender) {
			setTargetType("email");
			setScope(mailboxId ? "mailbox" : "global");
			setReason("");
			setError(null);
		}
	}, [sender, mailboxId]);

	const selectedPattern =
		targetType === "domain" ? domainPattern : senderEmail;

	const alreadyBlockedRule = useMemo(() => {
		if (!selectedPattern) return null;
		const list = scope === "global" ? globalBlocked : mailboxBlocked;
		return list.find((r) => r.pattern === selectedPattern) || null;
	}, [selectedPattern, scope, globalBlocked, mailboxBlocked]);

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		if (!selectedPattern) {
			setError("Could not extract a valid sender address.");
			return;
		}
		setError(null);
		try {
			await addBlockedSender.mutateAsync({
				pattern: selectedPattern,
				scope,
				mailboxId: scope === "mailbox" ? mailboxId : undefined,
				reason: reason.trim() || undefined,
			});
			toastManager.add({
				title:
					scope === "global"
						? `Blocked ${selectedPattern} across all mailboxes`
						: `Blocked ${selectedPattern} for ${mailboxEmail || mailboxId}`,
			});
			onClose();
		} catch (err) {
			setError(
				(err instanceof Error ? err.message : null) ||
					"Failed to block sender",
			);
		}
	};

	return (
		<Dialog.Root
			open={sender !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="flex items-center gap-2 text-base font-semibold mb-2">
					<ProhibitIcon size={18} className="text-kumo-danger" />
					<span>Block Sender</span>
				</Dialog.Title>
				<Dialog.Description className="text-xs text-kumo-subtle mb-4">
					Future emails matching this rule will be rejected via SMTP before
					reaching storage or triggering AI drafts.
				</Dialog.Description>

				<form onSubmit={handleSubmit} className="space-y-4">
					{error && (
						<Text variant="error" size="sm">
							{error}
						</Text>
					)}

					{/* What to block */}
					<div>
						<span className="text-xs font-medium text-kumo-default mb-2 block">
							What to block
						</span>
						<div className="space-y-2">
							{senderEmail && (
								<label
									className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
										targetType === "email"
											? "border-kumo-brand bg-kumo-tint/50"
											: "border-kumo-line hover:bg-kumo-tint/30"
									}`}
								>
									<input
										type="radio"
										name="block-target"
										checked={targetType === "email"}
										onChange={() => setTargetType("email")}
										className="mt-0.5"
									/>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="text-sm font-mono font-medium text-kumo-default break-all">
												{senderEmail}
											</span>
											<Badge variant="secondary">Email</Badge>
										</div>
										<div className="text-xs text-kumo-subtle mt-0.5">
											Block only this email address
										</div>
									</div>
								</label>
							)}

							{domainPattern && (
								<label
									className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
										targetType === "domain"
											? "border-kumo-brand bg-kumo-tint/50"
											: "border-kumo-line hover:bg-kumo-tint/30"
									}`}
								>
									<input
										type="radio"
										name="block-target"
										checked={targetType === "domain"}
										onChange={() => setTargetType("domain")}
										className="mt-0.5"
									/>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="text-sm font-mono font-medium text-kumo-default break-all">
												{domainPattern}
											</span>
											<Badge variant="outline">Domain</Badge>
										</div>
										<div className="text-xs text-kumo-subtle mt-0.5">
											Block all senders from this domain
										</div>
									</div>
								</label>
							)}
						</div>
					</div>

					{/* Scope */}
					<div>
						<span className="text-xs font-medium text-kumo-default mb-2 block">
							Apply to
						</span>
						<div className="space-y-2">
							{mailboxId && (
								<label
									className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
										scope === "mailbox"
											? "border-kumo-brand bg-kumo-tint/50"
											: "border-kumo-line hover:bg-kumo-tint/30"
									}`}
								>
									<input
										type="radio"
										name="block-scope"
										checked={scope === "mailbox"}
										onChange={() => setScope("mailbox")}
										className="mt-0.5"
									/>
									<div className="min-w-0 flex-1">
										<div className="text-sm font-medium text-kumo-default truncate">
											This mailbox only
										</div>
										<div className="text-xs text-kumo-subtle truncate">
											{mailboxEmail || mailboxId}
										</div>
									</div>
								</label>
							)}

							<label
								className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
									scope === "global"
										? "border-kumo-brand bg-kumo-tint/50"
										: "border-kumo-line hover:bg-kumo-tint/30"
								}`}
							>
								<input
									type="radio"
									name="block-scope"
									checked={scope === "global"}
									onChange={() => setScope("global")}
									className="mt-0.5"
								/>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5 text-sm font-medium text-kumo-default">
										<GlobeIcon size={14} className="text-kumo-subtle" />
										<span>All mailboxes (Global)</span>
									</div>
									<div className="text-xs text-kumo-subtle">
										Reject across every mailbox in Agentic Inbox
									</div>
								</div>
							</label>
						</div>
					</div>

					{/* Optional note */}
					<Input
						label="Reason / Note (optional)"
						placeholder="e.g. Unwanted marketing spam"
						size="sm"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
					/>

					{alreadyBlockedRule && (
						<div className="rounded-md bg-kumo-tint px-3 py-2 text-xs text-kumo-subtle">
							<strong className="text-kumo-default">{selectedPattern}</strong>{" "}
							is already in the{" "}
							{scope === "global" ? "global" : "mailbox"} blocklist.
						</div>
					)}

					<div className="flex justify-end gap-2 pt-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							type="submit"
							variant="destructive"
							size="sm"
							loading={addBlockedSender.isPending}
							disabled={!selectedPattern || !!alreadyBlockedRule}
						>
							{alreadyBlockedRule ? "Already Blocked" : "Block Sender"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
