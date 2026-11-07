# Development priorities and proposals

Development uses `preview`; production remains on `main`. See the [feature overview](../README.md), [preview workflow](preview-workflow.md), and [account setup](authentication.md).

## Current priorities

1. **Verify the current preview and live Google/Discord login.** The confirmed nested API routing defect is fixed in this batch. Use its latest Ready deployment for branch `preview`, rather than a fixed earlier deployment URL. Then verify registered applications, the stable callback origin, account linking, and recovery. Local OAuth fixtures and configuration flags do not prove live authorization. The current environment proxy still blocks both supplied preview hostnames; their allowlist entries are saved in the unapplied network draft.
2. **Full archives beyond one download.** Date filters now let many larger inboxes download smaller selections. Accounts that exceed the limits within one day or conversation still need pagination backed by a frozen server snapshot. Separate date-range requests have independent snapshots.
3. **Verified ERC20/SPL pricing.** Select a source with exact contract/mint matching, timestamps, and explicit coverage before adding token values to portfolio totals.
4. **Fluxer sign-in.** Fluxer supports third-party OAuth. Add an adapter and registered application, verify account identity/email handling, and test callbacks, independent recovery, 2FA, and linking before exposing a login button. Its absence here is an integration gap, not a claim that Fluxer cannot support one-click authorization.

## Implemented in this update

| Add or simplify                 | Result                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nested account API routing      | A named Vercel function and explicit API prefix rewrite replace the bracketed filename, which matched only one segment. Hosted tests now require that rewrite rather than bypassing routing. |
| Account-panel build menu        | Preview branch/commit information and the platform-provided latest-preview link are available in the sign-in screen as well as the dashboard footer.                                         |
| Errors before owner diagnostics | Actionable sign-in errors and retry controls stay above an opened setup checklist instead of being pushed below it.                                                                          |
| One relevant setup warning      | A detailed sign-in error replaces the generic setup warning while it is shown. Setup status still appears before an attempt.                                                                 |
| Fixed-link explanation          | Preview help explains that deployment URLs stay on their original build, while a branch alias follows successful updates.                                                                    |

The existing account/profile export remains separate and explicitly incomplete as a whole-account archive. Wallets, watchlists, and token watches retain their own backup controls. See [export scopes and limits](account-data.md).

## Defer until prerequisites are defined

- **Account deletion:** define retention/anonymization of shared conversations, reports, handles, and pending/verified payment evidence before exposing irreversible deletion.
- **Additional login platforms:** add a service only after a verified adapter, registered application, callback/security tests, and independent recovery are ready. Keep unfinished providers out of the login UI.
- **Custodial keys and identity verification:** require a separate key-management and recovery design. Identity verification does not recover browser-local wallet keys.
- **Social feeds:** keep public profile links separate from verified authentication and a full social-network product.

## Simplify next

Keep routine screens focused on usable actions. Remove duplicate generic warnings and unfinished login placeholders; keep owner diagnostics behind explicit help, actionable errors, and meaningful backup warnings. Consolidate repeated setup explanations in the owner checklist rather than adding them above login buttons.

Use white backgrounds, `#ccc` borders/outlines, `#999` text 1/icons, `#666` text 2, and `#333` text 3. Footer destinations stay `https://lovelyowner.com/` until replacements are supplied.
