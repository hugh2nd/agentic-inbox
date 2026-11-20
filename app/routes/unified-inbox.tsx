// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import {
	Badge,
	Button,
	Input,
	Loader,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowSquareOutIcon,
	ArrowsClockwiseIcon,
	CaretLeftIcon,
	ProhibitIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { extractEmailAddress, findMatchingBlockedRule } from "shared/blocklist";
import { formatListDate } from "shared/dates";
import { Folders } from "shared/folders";
import EmailPanel from "~/components/EmailPanel";
import BlockSenderDialog from "~/components/email-panel/BlockSenderDialog";
import { getFullEmailText } from "~/lib/utils";
import {
	useGlobalBlockedSenders,
	useMailboxBlockedSenders,
} from "~/queries/blocked-senders";
import { useDeleteEmail, useUpdateEmail } from "~/queries/emails";
import api from "~/services/api";
import type { Email } from "~/types";

type UnifiedEmail = Email & { mailboxId: string; mailboxEmail: string };

interface SelectedUnifiedEmail {
	id: string;
	mailboxId: string;
	mailboxEmail: string;
}

interface BlockTarget {
	sender: string;
	mailboxId: string;
	mailboxEmail: string;
}

export default function UnifiedInbox() {
	const toastManager = useKumoToastManager();
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [unread, setUnread] = useState(false);
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const [selectedEmail, setSelectedEmail] =
		useState<SelectedUnifiedEmail | null>(null);
	const [blockTarget, setBlockTarget] = useState<BlockTarget | null>(null);
	const [deletingKey, setDeletingKey] = useState<string | null>(null);

	const cursor = cursors[cursors.length - 1];
	const { data, isFetching, isError, refetch } = useQuery({
		queryKey: ["unified-inbox", query, unread, cursor],
		queryFn: ({ signal }) =>
			api.unifiedInbox(
				{
					...(query && { query }),
					...(unread && { unread: "true" }),
					...(cursor && { cursor }),
				},
				signal,
			),
		refetchInterval: 30_000,
	});

	const updateEmail = useUpdateEmail();
	const deleteEmail = useDeleteEmail();
	const { data: globalBlocked = [] } = useGlobalBlockedSenders();
	const { data: targetMailboxBlocked = [] } = useMailboxBlockedSenders(
		blockTarget?.mailboxId,
	);

	const handleSelectEmail = (email: UnifiedEmail) => {
		setSelectedEmail({
			id: email.id,
			mailboxId: email.mailboxId,
			mailboxEmail: email.mailboxEmail,
		});
		if (!email.read) {
			updateEmail.mutate({
				mailboxId: email.mailboxId,
				id: email.id,
				data: { read: true },
			});
		}
	};

	const handleDeleteFromList = async (email: UnifiedEmail) => {
		if (!window.confirm("Are you sure you want to delete this email?")) return;
		const key = `${email.mailboxId}:${email.id}`;
		setDeletingKey(key);
		try {
			await deleteEmail.mutateAsync({
				mailboxId: email.mailboxId,
				id: email.id,
			});
			if (
				selectedEmail &&
				selectedEmail.id === email.id &&
				selectedEmail.mailboxId === email.mailboxId
			) {
				setSelectedEmail(null);
			}
			toastManager.add({ title: "Email deleted" });
		} catch {
			toastManager.add({
				title: "Failed to delete email",
				variant: "error",
			});
		} finally {
			setDeletingKey(null);
		}
	};

	const canBlockRowSender = (email: UnifiedEmail) => {
		const senderAddr = extractEmailAddress(email.sender);
		return Boolean(
			senderAddr && senderAddr !== email.mailboxEmail.toLowerCase(),
		);
	};

	const isPanelOpen = selectedEmail !== null;

	return (
		<div className="flex flex-col h-screen bg-kumo-base overflow-hidden">
			{/* Top header bar */}
			<header className="shrink-0 border-b border-kumo-line bg-kumo-base px-4 py-3 md:px-6">
				<div className="flex flex-wrap items-center gap-3">
					<Link
						to="/"
						className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default no-underline shrink-0"
					>
						<CaretLeftIcon size={14} />
						<span>Mailboxes</span>
					</Link>
					<div className="h-4 w-px bg-kumo-line hidden sm:block" />
					<h1 className="text-base font-semibold text-kumo-default shrink-0">
						All Inboxes
					</h1>

					<form
						className="flex flex-1 flex-wrap items-center gap-2 ml-auto max-w-2xl"
						onSubmit={(e) => {
							e.preventDefault();
							setQuery(search.trim());
							setCursors([null]);
							setSelectedEmail(null);
						}}
					>
						<div className="min-w-44 flex-1">
							<Input
								size="sm"
								aria-label="Search all inboxes"
								placeholder="Search all inboxes..."
								value={search}
								onChange={(e) => setSearch(e.target.value)}
							/>
						</div>
						<Button type="submit" size="sm" variant="secondary">
							Search
						</Button>
						<label className="flex items-center gap-1.5 text-xs text-kumo-default select-none cursor-pointer px-1">
							<input
								type="checkbox"
								checked={unread}
								onChange={(e) => {
									setUnread(e.target.checked);
									setCursors([null]);
									setSelectedEmail(null);
								}}
							/>
							<span>Unread only</span>
						</label>
						<Tooltip content="Refresh" side="bottom" asChild>
							<Button
								type="button"
								variant="ghost"
								shape="square"
								size="sm"
								icon={
									<ArrowsClockwiseIcon
										size={16}
										className={isFetching ? "animate-spin" : ""}
									/>
								}
								onClick={() => refetch()}
								aria-label="Refresh"
							/>
						</Tooltip>
					</form>
				</div>
			</header>

			{/* Split view: List + Full Email Panel */}
			<div className="flex-1 flex min-h-0 overflow-hidden">
				{/* Left Pane: Unified Email List */}
				<div
					className={`flex flex-col min-w-0 shrink-0 bg-kumo-base ${
						isPanelOpen
							? "hidden md:flex md:w-[400px] md:border-r md:border-kumo-line"
							: "w-full"
					}`}
				>
					<div className="flex-1 overflow-y-auto">
						{isFetching && !data ? (
							<div className="p-10 text-center">
								<Loader />
							</div>
						) : isError ? (
							<div className="p-10 text-center space-y-3">
								<p className="text-sm text-kumo-subtle">
									Could not load inboxes.
								</p>
								<Button size="sm" onClick={() => refetch()}>
									Retry
								</Button>
							</div>
						) : !data?.emails.length ? (
							<div className="p-10 text-center text-sm text-kumo-subtle">
								No emails found.
							</div>
						) : (
							data.emails.map((email) => {
								const rowKey = `${email.mailboxId}:${email.id}`;
								const isSelected =
									selectedEmail?.id === email.id &&
									selectedEmail?.mailboxId === email.mailboxId;
								const isGloballyBlocked = Boolean(
									findMatchingBlockedRule([email.sender], globalBlocked),
								);
								const isDeleting = deletingKey === rowKey;
								const showBlockBtn = canBlockRowSender(email);

								return (
									<div
										key={rowKey}
										role="button"
										tabIndex={0}
										onClick={() => handleSelectEmail(email)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleSelectEmail(email);
											}
										}}
										className={`group flex items-start gap-2 border-b border-kumo-line px-4 py-3.5 text-left transition-colors cursor-pointer ${
											isSelected
												? "bg-kumo-tint"
												: "hover:bg-kumo-tint/60"
										}`}
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												{!email.read && (
													<span
														className="h-2 w-2 rounded-full bg-kumo-brand shrink-0"
														aria-label="Unread"
													/>
												)}
												<span
													className={`truncate text-sm text-kumo-default ${
														!email.read ? "font-bold" : "font-medium"
													}`}
												>
													{email.sender}
												</span>
												{isGloballyBlocked && (
													<Badge variant="destructive">Blocked</Badge>
												)}
												<span className="ml-auto shrink-0 text-xs text-kumo-subtle">
													{formatListDate(email.date)}
												</span>
											</div>

											<div className="flex items-center justify-between gap-2 mt-1">
												<span className="text-xs text-kumo-subtle truncate">
													{email.mailboxEmail}
												</span>
											</div>

											<div
												className={`text-sm mt-1 text-kumo-default break-words ${
													!email.read ? "font-semibold" : ""
												}`}
											>
												{email.subject || "(No subject)"}
											</div>
											<div className="text-xs text-kumo-subtle mt-1 whitespace-pre-wrap break-words leading-relaxed">
												{getFullEmailText(email.body ?? email.snippet)}
											</div>
										</div>

										{/* Row quick actions: Block Sender & Delete */}
										<div
											className="flex items-center gap-0.5 shrink-0 opacity-80 group-hover:opacity-100"
											onClick={(e) => e.stopPropagation()}
											onKeyDown={(e) => e.stopPropagation()}
										>
											{showBlockBtn && (
												<Tooltip content="Block Sender" side="bottom" asChild>
													<Button
														type="button"
														variant="ghost"
														shape="square"
														size="sm"
														icon={<ProhibitIcon size={16} />}
														aria-label={`Block sender ${email.sender}`}
														onClick={() =>
															setBlockTarget({
																sender: email.sender,
																mailboxId: email.mailboxId,
																mailboxEmail: email.mailboxEmail,
															})
														}
													/>
												</Tooltip>
											)}
											<Tooltip content="Delete" side="bottom" asChild>
												<Button
													type="button"
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={16} />}
													loading={isDeleting}
													disabled={isDeleting}
													aria-label={`Delete email ${email.subject || "(No subject)"}`}
													onClick={() => handleDeleteFromList(email)}
												/>
											</Tooltip>
										</div>
									</div>
								);
							})
						)}
					</div>

					{/* Pagination bar */}
					<div className="shrink-0 flex items-center justify-center gap-4 border-t border-kumo-line bg-kumo-base px-4 py-2.5">
						<Button
							size="sm"
							variant="secondary"
							disabled={cursors.length === 1 || isFetching}
							onClick={() => {
								setCursors((c) => c.slice(0, -1));
								setSelectedEmail(null);
							}}
						>
							Previous
						</Button>
						<span className="text-xs text-kumo-subtle">
							Page {cursors.length}
						</span>
						<Button
							size="sm"
							variant="secondary"
							disabled={!data?.nextCursor || isFetching}
							onClick={() => {
								if (data?.nextCursor) {
									setCursors((c) => [...c, data.nextCursor]);
									setSelectedEmail(null);
								}
							}}
						>
							Next
						</Button>
					</div>
				</div>

				{/* Right Pane: Full Email Detail View */}
				{isPanelOpen && selectedEmail && (
					<div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-kumo-base">
						<div className="flex items-center justify-between gap-2 px-4 py-1.5 border-b border-kumo-line bg-kumo-recessed text-xs text-kumo-subtle shrink-0">
							<span className="truncate">
								Mailbox:{" "}
								<strong className="text-kumo-default font-medium">
									{selectedEmail.mailboxEmail}
								</strong>
							</span>
							<Link
								to={`/mailbox/${encodeURIComponent(selectedEmail.mailboxId)}/emails/inbox`}
								state={{ emailId: selectedEmail.id }}
								className="inline-flex items-center gap-1 text-kumo-subtle hover:text-kumo-default no-underline shrink-0"
							>
								<span>Open in mailbox</span>
								<ArrowSquareOutIcon size={13} />
							</Link>
						</div>
						<div className="flex-1 min-h-0 overflow-hidden">
							<EmailPanel
								key={`${selectedEmail.mailboxId}:${selectedEmail.id}`}
								emailId={selectedEmail.id}
								mailboxId={selectedEmail.mailboxId}
								folder={Folders.INBOX}
								onClose={() => setSelectedEmail(null)}
								hideComposeActions
							/>
						</div>
					</div>
				)}
			</div>

			{/* Quick Block Sender Dialog from list rows */}
			<BlockSenderDialog
				sender={blockTarget?.sender ?? null}
				mailboxId={blockTarget?.mailboxId}
				mailboxEmail={blockTarget?.mailboxEmail}
				globalBlocked={globalBlocked}
				mailboxBlocked={targetMailboxBlocked}
				onClose={() => setBlockTarget(null)}
			/>
		</div>
	);
}
