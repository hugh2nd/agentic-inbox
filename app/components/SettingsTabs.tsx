// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import { GearSixIcon, ProhibitIcon } from "@phosphor-icons/react";
import { NavLink } from "react-router";
import {
	useGlobalBlockedSenders,
	useMailboxBlockedSenders,
} from "~/queries/blocked-senders";

export default function SettingsTabs({
	mailboxId,
}: {
	mailboxId: string;
}) {
	const { data: mailboxBlocked = [] } = useMailboxBlockedSenders(mailboxId);
	const { data: globalBlocked = [] } = useGlobalBlockedSenders();
	const totalBlocked = mailboxBlocked.length + globalBlocked.length;

	const encodedId = encodeURIComponent(mailboxId);

	return (
		<div className="mb-6">
			<h1 className="text-lg font-semibold text-kumo-default mb-4">Settings</h1>
			<div className="flex items-center gap-1 border-b border-kumo-line">
				<NavLink
					to={`/mailbox/${encodedId}/settings`}
					end
					className={({ isActive }) =>
						`flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors no-underline ${
							isActive
								? "border-kumo-brand text-kumo-default"
								: "border-transparent text-kumo-subtle hover:text-kumo-default"
						}`
					}
				>
					<GearSixIcon size={16} />
					<span>General</span>
				</NavLink>
				<NavLink
					to={`/mailbox/${encodedId}/settings/blocked-senders`}
					className={({ isActive }) =>
						`flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors no-underline ${
							isActive
								? "border-kumo-brand text-kumo-default"
								: "border-transparent text-kumo-subtle hover:text-kumo-default"
						}`
					}
				>
					<ProhibitIcon size={16} />
					<span>Blocked Senders</span>
					{totalBlocked > 0 && (
						<Badge variant="secondary">{totalBlocked}</Badge>
					)}
				</NavLink>
			</div>
		</div>
	);
}
