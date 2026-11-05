# Development status and next proposals

## Implemented for development

| Requested change | Result |
| --- | --- |
| Block/report controls | Conversation block/unblock, prospective message/reply/payment-quote guards, report snapshots, and a reviewer-only queue. Existing pending payments remain verifiable. Truly anonymous identities cannot be account-blocked. |
| ERC20/SPL balances | Exact Ethereum mainnet ERC20 and parsed Solana SPL/Token-2022 public token quantities for explicit owner/contract watches. Native USD totals remain separate. |
| Public token-watch backups | Strictly validated JSON import/export of public token configuration. Imports merge and deduplicate, matching existing owners by network/address even when local IDs differ. Unmatched owners are skipped until added manually; wallet keys, private accounts, and balances are excluded. |
| Passkeys | Real WebAuthn registration, sign-in, rename, and removal, bound to the configured origin, with fresh management sessions and existing TOTP/recovery/session policies preserved. |
| Decorative balance graph | Removed the fixed rising SVG and its styles. No balance history is implied. |
| Inactive login buttons | Only configured, implemented providers remain actionable; unavailable providers use compact status text. |
| Repeated promotional copy | Simplified address/activity empty states and wallet instructions; removed duplicate sidebar and network promotional cards. |
| Sidebar cleanup and action layout | Removed the Fathom brand block, curved active-navigation marker, and Workspace tools heading/divider. Kept accessible navigation and compact contextual wallet/address actions. |
| Social sign-in choices | Google, Discord, Twitter/X, GitHub, and Twitch adapters, with configured buttons for sign-in and linking. A collapsed service list explains setup and the five requested integrations that are not implemented. Registered provider credentials are required for live use. |

The development changes also include the exact white/gray palette, simpler headers, inbox search/unread filters, conversation drafts, copying, and an offline sample inbox preview. Search covers loaded messages and latest replies. Development uses the `preview` branch; production stays on `main`. Check Vercel for deployment readiness as described in the [preview workflow](preview-workflow.md).

## Add next

1. **Inbox keyboard focus management:** arrow keys between conversations, Enter to open, and focus restoration after Messages.
2. **Account/message export and deletion:** owner-scoped exports, defined retention, and clear handling of shared conversations and payment records.
3. **Verified token pricing:** an explicitly selected pricing source, timestamps, and honest unavailable states before combining token values with portfolio totals.
4. **Review and reattach orphan token watches:** show affected watches together and offer an explicit reattachment after the same public owner is added again; reject network/address mismatches.
5. **Verified decentralized sign-in:** start with Mastodon account linking or Bluesky DID-based authentication, then design Lens/hey.xyz and verify Fluxer/Stoat identity protocols. Keep profile links distinct from proven account control, and keep a passkey or email/password recovery route.

## Simplify next

- Replace the separate native/token refresh buttons with a clearly scoped **Refresh all** action, while retaining per-source timestamps and failures.
- Shorten always-visible token setup guidance once watches exist; keep import details collapsed and payment, recovery, and unavailable-data notices explicit.
- Consolidate watchlist TXT/JSON import into one **Import addresses** entry with a format choice; keep encrypted-wallet recovery separate.

## Deployment proposal

Register the five supported OAuth applications on the stable preview origin and test sign-in, sign-up, linking, unlinking, and recovery there. Provider credentials stay server-side. A provider shown as **Integration needed** is a development proposal, not a working login method.

Expose the preview build ID and Vercel-provided branch domain in a small preview-only status menu, so reviewers can open the newest UI without hunting through deployment URLs. Keep it out of the production interface.

Keep white backgrounds (`#fff`), borders/outlines (`#ccc`), text 1/icons (`#999`), text 2 (`#666`), and text 3 (`#333`). All eight footer links stay at `https://lovelyowner.com/` until new destinations are provided.
