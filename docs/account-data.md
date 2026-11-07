# Account data downloads

In Account & security → Account data, choose a JSON download after signing in within the last ten minutes. Both endpoints require a matching, unexpired fresh session, use only the authenticated account ID, and return uncached attachments. A query-string user ID cannot select another account.

| Download                          | Scope and contents                                                                                                                                  | Limits and completeness                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Download account and profile data | `account-profile`: account details, linked service IDs, private profile draft, and published/unpublished profile snapshot.                          | Up to 50 linked identities and 256 KiB. The overall export explicitly has `complete: false`; it is one part of the account's data.                                                           |
| Download conversations            | `accessible-conversations`: all conversations visible to the account in Received, Sent, and Donations, including every reply in the selected scope. | 500 conversations, 5,000 replies, 2 MiB UTF-8. Success has `complete: true` for this scope and matching counts. If any limit is exceeded, the request returns 413 and nothing is downloaded. |

The existing account/profile endpoint is GET `/api/account/export`. The conversation endpoint is GET `/api/account/messages-export`. Account/profile and unfiltered conversation downloads retain their version 1 formats. Date-filtered conversation downloads use version 2 and the separate `filtered-accessible-conversations` scope. The browser validates the format and checks that the returned scope and dates match the requested download before saving it. Either download can be cancelled; leaving the account panel or switching accounts prevents a late response from saving a file.

## Date filters

Open **Filter conversations**, choose **Created from (UTC)** and/or **Created through (UTC)**, then select **Download conversations**. Either date may be left empty. **Clear dates** returns to the unfiltered download. The selected dates remain visible when the filter panel is collapsed, and filtered filenames include the bounds.

Both dates include their entire UTC calendar day. Filters select a conversation by its creation date; every accessible reply in that conversation is included, even if the reply was written outside the chosen dates. They do not filter the last activity or the dates of individual replies.

The API accepts `from=YYYY-MM-DD` and `through=YYYY-MM-DD`. Empty supplied values, duplicate recognized parameters, invalid Gregorian dates, and a start after the end return 400 before reading messages. Other query parameters cannot select a different account or change the date selection. A successful filtered archive contains `selection: { createdFrom, createdThrough, timeZone: "UTC" }`, with absent bounds represented by `null`. Its `complete: true` marker covers only that selection, not the entire inbox.

## Conversation scope and consistency

One SQL statement reads the archive from a consistent database snapshot and records its snapshot timestamp as `exportedAt`. It uses the inbox's existing access rule: the account is the sender, or is the recipient of a non-pending message. A recipient cannot export a pending paid message before it becomes visible in their inbox. Export never marks messages or replies read and never changes payment state.

Anonymous incoming messages retain the name “Anonymous.” Anonymous sent notes without account-inbox ownership are excluded; the export never uses private moderation actors to connect them to an account. Message content, display names, profile handles, creation/activity/read dates, direction, kind, payment-status labels, and reply content/dates/creator-role flags are included. Participant IDs, reply author IDs, moderation actor identifiers, payment IDs/proofs, merchant credentials, and moderation reports are excluded.

The same limits apply to each selected range. If a download is too large, the filter panel opens so a smaller range can be chosen. A day with too many conversations, or one conversation with too many replies, can still exceed the limits; no partial file is created.

This release does not paginate large archives. Each download has its own database snapshot. Separate date-range downloads are not a shared frozen archive, and their replies or payment visibility can change between requests. A future paginated archive needs a frozen server snapshot; ordinary inbox pagination cannot provide that guarantee while conversations change.

## Other backups and retention

Neither download contains OAuth tokens, password hashes, session cookies, 2FA seeds/recovery codes, merchant keys, wallet keys, or browser-local wallets/watchlists. Use the dedicated workspace controls for watchlists, token watches, profiles, and encrypted wallet backups. These downloads do not restore an account or import conversations.

Account deletion remains deferred until retention/anonymization rules for shared conversations, reports, public handles, and pending/verified payment evidence are defined. No records are deleted by export.

Run `npm run test:conversation-export` against the running development server to verify real conversation downloads, privacy, read-state preservation, and retry/cancellation behavior. Unit tests also exercise the actual SQL reader against local PostgreSQL via PGLite.
