// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Input,
	Loader,
	Select,
	Text,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	EnvelopeSimpleIcon,
	GlobeIcon,
	MagnifyingGlassIcon,
	PlusIcon,
	ProhibitIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useMemo, useState } from "react";
import { useParams } from "react-router";
import {
	type BlockedSender,
	type BlockedSenderScope,
	BlocklistValidationError,
	normalizeBlockPattern,
} from "shared/blocklist";
import { formatListDate } from "shared/dates";
import SettingsTabs from "~/components/SettingsTabs";
import {
	useAddBlockedSender,
	useDeleteBlockedSender,
	useGlobalBlockedSenders,
	useMailboxBlockedSenders,
} from "~/queries/blocked-senders";
import { useMailbox } from "~/queries/mailboxes";

function BlockedSenderListSection({
	title,
	subtitle,
	icon,
	entries,
	emptyText,
	deletingId,
	onDelete,
}: {
	title: string;
	subtitle: string;
	icon: React.ReactNode;
	entries: BlockedSender[];
	emptyText: string;
	deletingId: string | null;
	onDelete: (entry: BlockedSender) => void;
}) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base overflow-hidden">
			<div className="flex items-center justify-between px-5 py-4 border-b border-kumo-line">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						{icon}
						<span className="text-sm font-medium text-kumo-default">
							{title}
						</span>
						<Badge variant="secondary">{entries.length}</Badge>
					</div>
					<p className="text-xs text-kumo-subtle mt-1">{subtitle}</p>
				</div>
			</div>

			{entries.length === 0 ? (
				<div className="px-5 py-8 text-center text-xs text-kumo-subtle">
					{emptyText}
				</div>
			) : (
				<div className="divide-y divide-kumo-line">
					{entries.map((entry) => {
						const itemKey = `${entry.scope}:${entry.id}`;
						const isDeleting = deletingId === itemKey;
						return (
							<div
								key={itemKey}
								className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-kumo-tint/40 transition-colors"
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2 flex-wrap">
										<span className="text-sm font-mono font-medium text-kumo-default break-all">
											{entry.pattern}
										</span>
										<Badge
											variant={
												entry.type === "domain" ? "outline" : "secondary"
											}
										>
											{entry.type === "domain" ? "Domain" : "Email"}
										</Badge>
										{entry.scope === "global" && (
											<Badge variant="primary">Global</Badge>
										)}
									</div>
									<div className="flex items-center gap-2 text-xs text-kumo-subtle mt-0.5 flex-wrap">
										<span>Added {formatListDate(entry.createdAt)}</span>
										{entry.reason && (
											<>
												<span>·</span>
												<span className="truncate">{entry.reason}</span>
											</>
										)}
									</div>
								</div>
								<Tooltip content="Remove from blocklist" side="left" asChild>
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										loading={isDeleting}
										disabled={isDeleting}
										aria-label={`Unblock ${entry.pattern}`}
										onClick={() => onDelete(entry)}
									/>
								</Tooltip>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

export default function SettingsBlockedSendersRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox, isLoading: isMailboxLoading } = useMailbox(mailboxId);
	const { data: mailboxBlocked = [], isLoading: isMailboxListLoading } =
		useMailboxBlockedSenders(mailboxId);
	const { data: globalBlocked = [], isLoading: isGlobalListLoading } =
		useGlobalBlockedSenders();

	const addBlockedSender = useAddBlockedSender();
	const deleteBlockedSender = useDeleteBlockedSender();

	const [patternInput, setPatternInput] = useState("");
	const [scope, setScope] = useState<BlockedSenderScope>("mailbox");
	const [reason, setReason] = useState("");
	const [formError, setFormError] = useState<string | null>(null);
	const [filterQuery, setFilterQuery] = useState("");
	const [deletingId, setDeletingId] = useState<string | null>(null);

	const filteredMailboxEntries = useMemo(() => {
		const q = filterQuery.trim().toLowerCase();
		if (!q) return mailboxBlocked;
		return mailboxBlocked.filter(
			(e) =>
				e.pattern.includes(q) ||
				(e.reason && e.reason.toLowerCase().includes(q)),
		);
	}, [mailboxBlocked, filterQuery]);

	const filteredGlobalEntries = useMemo(() => {
		const q = filterQuery.trim().toLowerCase();
		if (!q) return globalBlocked;
		return globalBlocked.filter(
			(e) =>
				e.pattern.includes(q) ||
				(e.reason && e.reason.toLowerCase().includes(q)),
		);
	}, [globalBlocked, filterQuery]);

	const handleAdd = async (e: FormEvent) => {
		e.preventDefault();
		setFormError(null);

		let normalized: { pattern: string };
		try {
			normalized = normalizeBlockPattern(patternInput);
		} catch (err) {
			setFormError(
				err instanceof BlocklistValidationError
					? err.message
					: "Invalid sender email or domain",
			);
			return;
		}

		try {
			await addBlockedSender.mutateAsync({
				pattern: normalized.pattern,
				scope,
				mailboxId: scope === "mailbox" ? mailboxId : undefined,
				reason: reason.trim() || undefined,
			});
			toastManager.add({
				title:
					scope === "global"
						? `Added ${normalized.pattern} to global blocklist`
						: `Added ${normalized.pattern} to mailbox blocklist`,
			});
			setPatternInput("");
			setReason("");
		} catch (err) {
			setFormError(
				(err instanceof Error ? err.message : null) ||
					"Failed to add blocked sender",
			);
		}
	};

	const handleDelete = async (entry: BlockedSender) => {
		const itemKey = `${entry.scope}:${entry.id}`;
		setDeletingId(itemKey);
		try {
			await deleteBlockedSender.mutateAsync({
				id: entry.id,
				scope: entry.scope,
				mailboxId: entry.scope === "mailbox" ? mailboxId : undefined,
			});
			toastManager.add({
				title: `Unblocked ${entry.pattern}`,
			});
		} catch (err) {
			toastManager.add({
				title:
					(err instanceof Error ? err.message : null) ||
					"Failed to remove blocked sender",
				variant: "error",
			});
		} finally {
			setDeletingId(null);
		}
	};

	if (isMailboxLoading || !mailbox || !mailboxId) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const totalCount = mailboxBlocked.length + globalBlocked.length;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<SettingsTabs mailboxId={mailboxId} />

			<div className="space-y-6 pb-8">
				{/* Add Blocked Sender */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-1">
						<ProhibitIcon
							size={16}
							weight="duotone"
							className="text-kumo-subtle"
						/>
						<span className="text-sm font-medium text-kumo-default">
							Block a Sender or Domain
						</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-4">
						Enter an email address (e.g.{" "}
						<code className="font-mono text-kumo-default">
							spam@example.com
						</code>
						) or an entire domain (e.g.{" "}
						<code className="font-mono text-kumo-default">@example.com</code>).
						Matching emails are permanently rejected via SMTP before storage or
						AI auto-drafting.
					</p>

					<form onSubmit={handleAdd} className="space-y-3">
						{formError && (
							<Text variant="error" size="sm">
								{formError}
							</Text>
						)}

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<div className="sm:col-span-2">
								<Input
									label="Email or Domain"
									placeholder="spam@example.com or @example.com"
									value={patternInput}
									onChange={(e) => {
										setPatternInput(e.target.value);
										if (formError) setFormError(null);
									}}
									required
								/>
							</div>
							<div>
								<span className="text-sm font-medium text-kumo-default mb-1.5 block">
									Scope
								</span>
								<Select
									aria-label="Blocklist scope"
									value={scope}
									onValueChange={(v) => {
										if (v === "mailbox" || v === "global") setScope(v);
									}}
								>
									<Select.Option value="mailbox">This Mailbox</Select.Option>
									<Select.Option value="global">
										Global (All Mailboxes)
									</Select.Option>
								</Select>
							</div>
						</div>

						<div className="flex flex-col sm:flex-row sm:items-end gap-3">
							<div className="flex-1">
								<Input
									label="Reason / Note (optional)"
									placeholder="Optional note"
									value={reason}
									onChange={(e) => setReason(e.target.value)}
								/>
							</div>
							<Button
								type="submit"
								variant="primary"
								icon={<PlusIcon size={16} />}
								loading={addBlockedSender.isPending}
								disabled={!patternInput.trim()}
							>
								Add to Blocklist
							</Button>
						</div>
					</form>
				</div>

				{/* Filter bar when entries exist */}
				{totalCount > 0 && (
					<div className="relative">
						<Input
							aria-label="Filter blocked senders"
							placeholder="Filter blocked addresses or domains..."
							value={filterQuery}
							onChange={(e) => setFilterQuery(e.target.value)}
						/>
						{!filterQuery && (
							<MagnifyingGlassIcon
								size={16}
								className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-kumo-subtle"
							/>
						)}
					</div>
				)}

				{isMailboxListLoading || isGlobalListLoading ? (
					<div className="flex justify-center py-12">
						<Loader />
					</div>
				) : (
					<>
						<BlockedSenderListSection
							title={`Mailbox Blocklist (${mailbox.email})`}
							subtitle="Only rejects incoming emails addressed to this mailbox."
							icon={
								<EnvelopeSimpleIcon
									size={16}
									className="text-kumo-subtle shrink-0"
								/>
							}
							entries={filteredMailboxEntries}
							emptyText={
								filterQuery
									? "No mailbox rules match your filter."
									: "No blocked senders configured for this mailbox."
							}
							deletingId={deletingId}
							onDelete={handleDelete}
						/>

						<BlockedSenderListSection
							title="Global Blocklist (All Mailboxes)"
							subtitle="Rejects incoming emails across every mailbox in Agentic Inbox."
							icon={
								<GlobeIcon size={16} className="text-kumo-subtle shrink-0" />
							}
							entries={filteredGlobalEntries}
							emptyText={
								filterQuery
									? "No global rules match your filter."
									: "No global blocked senders configured."
							}
							deletingId={deletingId}
							onDelete={handleDelete}
						/>
					</>
				)}
			</div>
		</div>
	);
}
