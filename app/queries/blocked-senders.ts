// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { BlockedSender, BlockedSenderScope } from "~/types";
import { queryKeys } from "./keys";

export function useGlobalBlockedSenders() {
	return useQuery<BlockedSender[]>({
		queryKey: queryKeys.blockedSenders.global,
		queryFn: () => api.listGlobalBlockedSenders(),
	});
}

export function useMailboxBlockedSenders(mailboxId: string | undefined) {
	return useQuery<BlockedSender[]>({
		queryKey: mailboxId
			? queryKeys.blockedSenders.mailbox(mailboxId)
			: ["blocked-senders", "mailbox", "_disabled"],
		queryFn: () => api.listMailboxBlockedSenders(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useAddBlockedSender() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			pattern,
			scope,
			mailboxId,
			reason,
		}: {
			pattern: string;
			scope: BlockedSenderScope;
			mailboxId?: string;
			reason?: string;
		}) => {
			if (scope === "global") {
				return api.addGlobalBlockedSender(pattern, reason);
			}
			if (!mailboxId) {
				throw new Error("Mailbox ID is required for mailbox blocklist");
			}
			return api.addMailboxBlockedSender(mailboxId, pattern, reason);
		},
		onSuccess: (_data, variables) => {
			if (variables.scope === "global") {
				qc.invalidateQueries({ queryKey: queryKeys.blockedSenders.global });
			} else if (variables.mailboxId) {
				qc.invalidateQueries({
					queryKey: queryKeys.blockedSenders.mailbox(variables.mailboxId),
				});
			}
		},
	});
}

export function useDeleteBlockedSender() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			scope,
			mailboxId,
		}: {
			id: string;
			scope: BlockedSenderScope;
			mailboxId?: string;
		}) => {
			if (scope === "global") {
				return api.deleteGlobalBlockedSender(id);
			}
			if (!mailboxId) {
				throw new Error("Mailbox ID is required for mailbox blocklist");
			}
			return api.deleteMailboxBlockedSender(mailboxId, id);
		},
		onSuccess: (_data, variables) => {
			if (variables.scope === "global") {
				qc.invalidateQueries({ queryKey: queryKeys.blockedSenders.global });
			} else if (variables.mailboxId) {
				qc.invalidateQueries({
					queryKey: queryKeys.blockedSenders.mailbox(variables.mailboxId),
				});
			}
		},
	});
}
