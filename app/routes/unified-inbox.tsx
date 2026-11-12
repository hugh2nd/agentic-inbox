// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.
import { Button, Input, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { formatListDate } from "shared/dates";
import { getSnippetText } from "~/lib/utils";
import api from "~/services/api";

export default function UnifiedInbox() {
	const navigate = useNavigate();
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [unread, setUnread] = useState(false);
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const cursor = cursors[cursors.length - 1];
	const { data, isFetching, isError, refetch } = useQuery({
		queryKey: ["unified-inbox", query, unread, cursor],
		queryFn: ({ signal }) => api.unifiedInbox({ ...(query && { query }), ...(unread && { unread: "true" }), ...(cursor && { cursor }) }, signal),
		refetchInterval: 30_000,
	});
	return <div className="min-h-screen bg-kumo-recessed px-4 py-8">
		<div className="mx-auto max-w-4xl">
			<Link to="/" className="text-sm text-kumo-subtle">← Mailboxes</Link>
			<h1 className="my-4 text-2xl font-bold text-kumo-default">All Inboxes</h1>
			<form className="flex flex-wrap items-end gap-3 mb-4" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); setCursors([null]); }}>
				<div className="min-w-48 flex-1"><Input aria-label="Search all inboxes" placeholder="Search all inboxes" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
				<Button type="submit">Search</Button>
				<label className="flex items-center gap-2 text-sm text-kumo-default pb-2"><input type="checkbox" checked={unread} onChange={(e) => { setUnread(e.target.checked); setCursors([null]); }} /> Unread only</label>
			</form>
			<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
				{isFetching && !data ? <div className="p-8 text-center"><Loader /></div> : isError ? <div className="p-8 text-center">Could not load inboxes. <Button onClick={() => refetch()}>Retry</Button></div> : !data?.emails.length ? <div className="p-8 text-center text-kumo-subtle">No emails found.</div> : data.emails.map((email) => <button key={`${email.mailboxId}:${email.id}`} type="button" onClick={() => navigate(`/mailbox/${encodeURIComponent(email.mailboxId)}/emails/inbox`, { state: { emailId: email.id } })} className="block w-full border-b border-kumo-line px-5 py-4 text-left hover:bg-kumo-tint">
					<div className="flex gap-3 items-center"><span className={`truncate text-sm ${!email.read ? "font-bold" : "font-medium"}`}>{email.sender}</span><span className="ml-auto shrink-0 text-sm text-kumo-subtle">{formatListDate(email.date)}</span></div>
					<div className="text-xs text-kumo-subtle mt-1">{email.mailboxEmail}</div>
					<div className={`truncate text-sm mt-1 ${!email.read ? "font-semibold" : ""}`}>{email.subject || "(No subject)"} <span className="font-normal text-kumo-subtle">{getSnippetText(email.snippet)}</span></div>
				</button>)}
			</div>
			<div className="flex items-center justify-center gap-4 mt-4"><Button disabled={cursors.length === 1 || isFetching} onClick={() => setCursors((c) => c.slice(0, -1))}>Previous</Button><span className="text-sm text-kumo-subtle">Page {cursors.length}</span><Button disabled={!data?.nextCursor || isFetching} onClick={() => data?.nextCursor && setCursors((c) => [...c, data.nextCursor])}>Next</Button></div>
		</div>
	</div>;
}
