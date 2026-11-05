# Development status and next proposals

## Implemented for development

| Requested change                  | Result                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block/report controls             | Conversation block/unblock, prospective message/reply/payment-quote guards, report snapshots, and a reviewer-only queue. Existing pending payments remain verifiable. Truly anonymous identities cannot be account-blocked.                                                              |
| ERC20/SPL balances                | Exact Ethereum mainnet ERC20 and parsed Solana SPL/Token-2022 public token quantities for explicit owner/contract watches. Native USD totals remain separate.                                                                                                                            |
| Public token-watch backups        | Strictly validated JSON import/export of public token configuration. Imports merge and deduplicate, matching existing owners by network/address even when local IDs differ. Unmatched owners are skipped until added manually; wallet keys, private accounts, and balances are excluded. |
| Passkeys                          | Real WebAuthn registration, sign-in, rename, and removal, bound to the configured origin, with fresh management sessions and existing TOTP/recovery/session policies preserved.                                                                                                          |
| Decorative balance graph          | Removed the fixed rising SVG and its styles. No balance history is implied.                                                                                                                                                                                                              |
| Inactive login buttons            | Only configured, implemented providers remain actionable; unavailable providers use compact status text.                                                                                                                                                                                 |
| Repeated promotional copy         | Simplified address/activity empty states and wallet instructions; removed duplicate sidebar and network promotional cards.                                                                                                                                                               |
| Sidebar cleanup and action layout | Removed the Fathom brand block, curved active-navigation marker, and Workspace tools heading/divider. Kept accessible navigation and compact contextual wallet/address actions.                                                                                                          |
| Social sign-in choices            | Google, Discord, Twitter/X, GitHub, and Twitch adapters, with configured buttons for sign-in and linking. A collapsed service list shows only supported services; planned integrations stay in development proposals. Registered provider credentials are required for live use.         |
| Sign-in availability recovery     | One loading indicator, an eight-second request/body deadline, validated public configuration, and an explicit retry after errors. Failed or incomplete responses never enable sign-in controls.                                                                                          |

## Applied in this batch

| Improvement               | Result                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Social callback security  | Local TOTP/recovery now also protects OAuth callbacks. Safe error messages, a challenge return route, and canonical sign-in guidance preserve origin and session policies.                                                    |
| Setup checklist           | Public presence checks identify missing account settings; a copyable checklist contains variable names and status only, never credential values.                                                                              |
| Preview review link       | A preview-only status menu shows the build/branch and links to the actual Vercel-provided branch domain. Production has no menu.                                                                                              |
| One refresh action        | Refresh all covers native balances and configured ERC20/SPL reads, with pause/offline/visibility gates and separate result timestamps.                                                                                        |
| Public address imports    | One Import addresses entry offers TXT network detection and a reviewed JSON merge; labels/pins survive and encrypted-wallet recovery stays separate.                                                                          |
| Token owner recovery      | Review and explicitly confirm reattachment only to the same network/public address; failed storage writes preserve the old configuration.                                                                                     |
| Inbox keyboard navigation | Arrow/Home/End navigation, native Enter/Space opening, initial conversation-heading focus, and focus restoration after Messages. Live refresh does not steal composer focus.                                                  |
| Account/profile export    | Fresh-session, owner-scoped JSON exports of account details, linked service IDs, and private/published profiles. The bounded first slice explicitly omits messages, payments, authentication secrets, and browser-local data. |

The development changes also include the exact white/gray palette, simpler headers, inbox search/unread filters, conversation drafts, copying, and an offline sample inbox preview. Search covers loaded messages and latest replies. Development uses the `preview` branch; production stays on `main`. Check Vercel for deployment readiness as described in the [preview workflow](preview-workflow.md).

## Add next

1. **Enable and verify real Google/Discord login:** configure the isolated Preview account settings, register provider applications on the stable sign-in origin, and test callback, recovery, and account-linking flows there. Configuration flags do not prove provider connectivity.
2. **Complete message export:** owner-scoped pagination, consistent snapshots, and explicit completeness before expanding the account/profile export into a full archive.
3. **Account deletion with defined retention:** decide how shared conversations, reports, published handles, and pending/verified payment proofs are retained or anonymized before exposing deletion. Do not cascade-delete financial evidence by accident.
4. **Verified token pricing:** explicitly select a source, validate contract/mint matches and freshness, and label coverage before combining token values with portfolio totals.
5. **Verified decentralized sign-in:** implement and test Mastodon or Bluesky account-control proofs first. Lens/hey.xyz, Fluxer, and Stoat need their own verified integrations; profile links alone are not authentication.

## Simplify next

- Consolidate repeated recovery explanations into one short contextual help section while keeping backup warnings and errors visible.
- Keep provider setup diagnostics collapsed; once deployment setup is complete, prioritize the enabled sign-in methods and independent recovery options.

## Delivery and limits

Development is committed to `preview`; production stays on `main`. See [preview workflow](preview-workflow.md), [account setup](authentication.md), and [account export scope](account-data.md). Current preview metadata comes from platform variables, never a guessed URL. Registered credentials and a database must be configured in Vercel; no live provider access is implied by local fixtures.

Keep white backgrounds (`#fff`), borders/outlines (`#ccc`), text 1/icons (`#999`), text 2 (`#666`), and text 3 (`#333`). All eight footer links stay at `https://lovelyowner.com/` until new destinations are provided.
