# Account and profile export

In Account & security, choose **Download account and profile data** after signing in within the last ten minutes. GET `/api/account/export` requires a matching unexpired fresh session and returns an uncached JSON attachment. It reads only the authenticated user's records, not a client-supplied user ID.

This is a bounded first slice with `scope: "account-profile"` and `complete: false`: account identity details, up to 50 linked service identities, the private profile draft, and the published/unpublished profile snapshot. Profiles are validated and fields are selected explicitly. Linked lists state their limit and completeness. The response cap is 256 KiB.

The export explicitly omits conversations/replies, payment records, moderation/security secrets, and browser-local wallets/watchlists. OAuth tokens, password hashes, session cookies, 2FA seeds/recovery codes, merchant keys, wallet keys, and anonymous actor identifiers are never selected. It is an account record, not a full restore package. Export local watchlists, token watches, profiles, and encrypted wallets through their dedicated backup controls.

Account deletion is deferred until retention/anonymization rules for shared conversations, reports, public handles, and pending/verified payment evidence are defined. No records are deleted by export.
