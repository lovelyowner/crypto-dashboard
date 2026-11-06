# Account data downloads

In Account & security → Account data, choose a JSON download after signing in within the last ten minutes. Both endpoints require a matching, unexpired fresh session, use only the authenticated account ID, and return uncached attachments. A query-string user ID cannot select another account.

| Download                          | Scope and contents                                                                                                                                  | Limits and completeness                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Download account and profile data | `account-profile`: account details, linked service IDs, private profile draft, and published/unpublished profile snapshot.                          | Up to 50 linked identities and 256 KiB. The overall export explicitly has `complete: false`; it is one part of the account's data.                                                           |
| Download conversations            | `accessible-conversations`: all conversations visible to the account in Received, Sent, and Donations, including every reply in the selected scope. | 500 conversations, 5,000 replies, 2 MiB UTF-8. Success has `complete: true` for this scope and matching counts. If any limit is exceeded, the request returns 413 and nothing is downloaded. |

The existing account/profile endpoint is GET `/api/account/export`. The conversation endpoint is GET `/api/account/messages-export`. Both formats have version 1, with separate scope markers. The browser validates the returned format before downloading. Either download can be cancelled; leaving the account panel or switching accounts prevents a late response from saving a file.

## Conversation scope and consistency

One SQL statement reads the archive from a consistent database snapshot and records its snapshot timestamp as `exportedAt`. It uses the inbox's existing access rule: the account is the sender, or is the recipient of a non-pending message. A recipient cannot export a pending paid message before it becomes visible in their inbox. Export never marks messages or replies read and never changes payment state.

Anonymous incoming messages retain the name “Anonymous.” Anonymous sent notes without account-inbox ownership are excluded; the export never uses private moderation actors to connect them to an account. Message content, display names, profile handles, creation/activity/read dates, direction, kind, payment-status labels, and reply content/dates/creator-role flags are included. Participant IDs, reply author IDs, moderation actor identifiers, payment IDs/proofs, merchant credentials, and moderation reports are excluded.

This release does not paginate large archives. A successful download is never silently truncated; an oversized account needs a future filtered or paginated export backed by a frozen snapshot. Ordinary inbox pagination cannot provide that guarantee while conversations change.

## Other backups and retention

Neither download contains OAuth tokens, password hashes, session cookies, 2FA seeds/recovery codes, merchant keys, wallet keys, or browser-local wallets/watchlists. Use the dedicated workspace controls for watchlists, token watches, profiles, and encrypted wallet backups. These downloads do not restore an account or import conversations.

Account deletion remains deferred until retention/anonymization rules for shared conversations, reports, public handles, and pending/verified payment evidence are defined. No records are deleted by export.

Run `npm run test:conversation-export` against the running development server to verify real conversation downloads, privacy, read-state preservation, and retry/cancellation behavior. Unit tests also exercise the actual SQL reader against local PostgreSQL via PGLite.
