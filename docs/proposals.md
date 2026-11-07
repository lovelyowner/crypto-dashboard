# Development priorities and proposals

Development uses `preview`; production remains on `main`. See the [feature overview](../README.md), [preview workflow](preview-workflow.md), and [account setup](authentication.md).

## Current priorities

1. **Verify live Google/Discord login.** Inspect the current deployment's HTTP response and function logs, then verify registered applications, the stable callback origin, account linking, and recovery. Local OAuth fixtures and configuration flags do not prove live authorization. The requested preview hostname is saved in the Codex environment network draft; access has not been confirmed.
2. **Full archives beyond one download.** Date filters now let many larger inboxes download smaller selections. Accounts that exceed the limits within one day or conversation still need pagination backed by a frozen server snapshot. Separate date-range requests have independent snapshots.
3. **Verified ERC20/SPL pricing.** Select a source with exact contract/mint matching, timestamps, and explicit coverage before adding token values to portfolio totals.

## Implemented in this update

| Add or simplify                      | Result                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date-filtered conversation downloads | Optional inclusive UTC creation dates select conversations before applying limits. Every reply is retained. Clear dates returns to the original full-scope version 1 download.                  |
| Explicit filtered scope              | Version 2 archives record their selected dates and use `filtered-accessible-conversations`. The browser rejects a response with different dates or the wrong scope.                             |
| Honest limits                        | Each range still has limits of 500 conversations, 5,000 replies, and 2 MiB UTF-8. Oversized selections are rejected without partial files; users can choose a smaller range.                    |
| Less routine copy                    | Date and limit explanations live in the filter panel, with the active selection visible beside the download controls.                                                                           |
| One setup-help control               | The sign-in setup button controls one help panel. Removing its duplicate collapsible summary keeps Retry reachable and the expanded state accurate. Errors and recovery actions remain visible. |

The existing account/profile export remains separate and explicitly incomplete as a whole-account archive. Wallets, watchlists, and token watches retain their own backup controls. See [export scopes and limits](account-data.md).

## Defer until prerequisites are defined

- **Account deletion:** define retention/anonymization of shared conversations, reports, handles, and pending/verified payment evidence before exposing irreversible deletion.
- **Additional login platforms:** add a service only after a verified adapter, registered application, callback/security tests, and independent recovery are ready. Keep unfinished providers out of the login UI.
- **Custodial keys and identity verification:** require a separate key-management and recovery design. Identity verification does not recover browser-local wallet keys.
- **Social feeds:** keep public profile links separate from verified authentication and a full social-network product.

## Simplify next

Keep routine screens focused on usable actions. Put owner diagnostics behind explicit help, avoid duplicate provider/status lists, and retain meaningful errors and backup warnings.

Use white backgrounds, `#ccc` borders/outlines, `#999` text 1/icons, `#666` text 2, and `#333` text 3. Footer destinations stay `https://lovelyowner.com/` until replacements are supplied.
