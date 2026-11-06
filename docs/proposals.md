# Development priorities and proposals

Development uses `preview`; production remains on `main`. See the [feature overview](../README.md), [preview workflow](preview-workflow.md), and [account setup](authentication.md).

## Current priorities

1. **Verify live Google/Discord login.** Inspect the current deployment's HTTP response and function logs, then verify registered applications, the stable callback origin, account linking, and recovery. Local OAuth fixtures and configuration flags do not prove live authorization. The requested preview hostname is saved in the Codex environment network draft; access has not been confirmed.
2. **Larger conversation archives.** Add filters or pagination backed by a frozen server snapshot. The current single-download archive rejects oversized data instead of truncating it. Ordinary inbox pagination cannot guarantee a consistent archive while messages change.
3. **Verified ERC20/SPL pricing.** Select a source with exact contract/mint matching, timestamps, and explicit coverage before adding token values to portfolio totals.

## Implemented in this update

| Add or simplify                | Result                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation archive           | A fresh authenticated account can download its accessible conversations and all their replies from one database statement snapshot. The read uses the same ownership and pending-message visibility rules as the inbox and does not mark messages read. |
| Explicit download completeness | The archive has its own `accessible-conversations` scope and a complete marker. Limits are 500 conversations, 5,000 replies, and 2 MiB UTF-8; any overflow rejects the entire download. No partial archive is presented as complete.                    |
| Private fields excluded        | Anonymous names stay anonymous. Participant/author/moderation actor IDs, payment IDs/proofs, provider credentials, and authentication secrets are excluded. Anonymous sent notes without account-inbox ownership are outside this scope.                |
| One connected-account row      | A connected service has one status row with its Disconnect action. The picker offers only unlinked services; confirmation and last-method protection remain.                                                                                            |
| Shorter recovery copy          | Authenticator status covers sign-in methods accurately. Repeated promotional/recovery explanations are reduced while key-backup and recovery-code warnings remain.                                                                                      |

The existing account/profile export remains separate and explicitly incomplete as a whole-account archive. Wallets, watchlists, and token watches retain their own backup controls. See [export scopes and limits](account-data.md).

## Defer until prerequisites are defined

- **Account deletion:** define retention/anonymization of shared conversations, reports, handles, and pending/verified payment evidence before exposing irreversible deletion.
- **Additional login platforms:** add a service only after a verified adapter, registered application, callback/security tests, and independent recovery are ready. Keep unfinished providers out of the login UI.
- **Custodial keys and identity verification:** require a separate key-management and recovery design. Identity verification does not recover browser-local wallet keys.
- **Social feeds:** keep public profile links separate from verified authentication and a full social-network product.

## Simplify next

Keep routine screens focused on usable actions. Put owner diagnostics behind explicit help, avoid duplicate provider/status lists, and retain meaningful errors and backup warnings.

Use white backgrounds, `#ccc` borders/outlines, `#999` text 1/icons, `#666` text 2, and `#333` text 3. Footer destinations stay `https://lovelyowner.com/` until replacements are supplied.
