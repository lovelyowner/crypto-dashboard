# Accounts and recovery

Watching public addresses and creating local wallets work without an account. Accounts use Better Auth at the same origin as the application, with HttpOnly session cookies and the existing PostgreSQL/PGLite database. The imported app's Grok broker and preview credentials have been removed.

## Available now

- Email/password registration and sign-in.
- Explicit username sign-in mode, including meaningful Unicode, punctuation, emoji, internal spaces, and `@`.
- Usernames are case-sensitive and normalized to NFC before uniqueness checks. They contain 1–64 Unicode code points and cannot contain surrounding whitespace or control/invisible formatting characters. Passwords accept arbitrary character categories, 12–256 UTF-16 code units. Better Auth's built-in scrypt password hashing applies Unicode NFKC normalization.
- Authenticator enrollment using a manual secret or `otpauth:` link. Activation requires a valid six-digit RFC6238 code. Standard codes rotate every 30 seconds. Ten encrypted, single-use backup codes containing 16 random alphanumeric characters support authenticator recovery. Generating new backup codes invalidates the previous set.
- TOTP protects email, username, and passkey sign-in. OAuth providers use their own MFA/security policies; the local authenticator does not add another challenge to OAuth callbacks.
- Passkey sign-in and management use the official Better Auth WebAuthn adapter. Add, rename, list, and remove passkeys under Account → Security. Enrollment and changes require a session created within the last ten minutes. The authenticator must verify the user; an existing authenticator-app or backup-code challenge still follows passkey sign-in when enabled.
- Choose an absolute session lifetime of one hour, one day (default), or seven days. The database records the deadline and activity never extends it. A checked “Remember me” option makes a persistent email/username login cookie; unchecked uses a browser-session cookie. Browser session restore can retain session cookies, but cannot extend the server deadline. The chosen duration also applies to social sign-in and persists across authenticator/backup-code verification. Standard TOTP settings remain fixed for authenticator compatibility.
- Direct Google, Discord, Twitter/X, GitHub, and Twitch OAuth when configured. Explicit account linking requires proof through the provider; implicit merging of same-email accounts is disabled. Linking requires the same verified email on both accounts. The server prevents removal of the last sign-in method.
- Social accounts with a verified email may add an independent password after fresh authentication. Account recovery is independent of wallet key recovery.

## Development

Passkeys are bound to the exact `BETTER_AUTH_URL` origin and its hostname as relying-party ID. Use HTTPS in production and `http://localhost:8080` for local passkey testing. A different hostname, origin, or app domain needs separately enrolled credentials; use another existing sign-in method to access the account. Browser/device support is required. Passkeys recover account access, never wallet recovery phrases.

The WebAuthn security checks in `npm test` use Chromium with a virtual authenticator and actual local HTTP ceremonies. Install Playwright Chromium or set `CHROMIUM_PATH` to an installed Chromium binary. `npm run test:passkeys` checks the full app UI against a running server at its configured origin. These tests do not enroll credentials on a real personal device.

`npm run dev` starts the app on port 8080. PGLite stores local account data under `.data/fathom` (or `PGLITE_DATA_DIR`). A private signing/encryption secret is generated at `.local/auth-secret` with owner-only file permissions, retained across local restarts. Do not commit, share, or overwrite `.local`; existing encrypted authenticator data depends on its signing secret. Local passwords work without an email provider, but email verification and emailed password-reset links are unavailable until delivery is configured.

Test against a running development server:

```sh
node scripts/auth-integration.mjs http://127.0.0.1:8080
```

The test creates a disposable account and exercises real HTTP endpoints, cookies, Unicode username/password sign-in, verified TOTP, and recovery-code replay protection. It does not contact social providers or print secrets.

`npm test` also exercises session policies against Better Auth's real HTTP handler using an isolated memory database. It checks actual expiration, remembered and browser-session cookies, invalid choices, two-factor continuation, forged continuation cookies, and backup-code recovery. Login requests use the bounded `x-fathom-session-duration` header (`1h`, `1d`, or `7d`). A signed HttpOnly cookie lasts up to ten minutes while OAuth or 2FA completes, then is removed. Missing or invalid continuation policy cookies fall back to the shortest lifetime. Cookie lifetime and database lifetime agree; server expiry is authoritative.

## Signed-in sessions and independent access

**Account & security → Signed-in sessions** lists actual active sessions with browser-reported device details, sign-in and expiry dates in `dd.mm.yy HH:mm UTC`, and a current-session marker. Device descriptions are self-reported. Session tokens are never shown or exported by the UI. Sign out one other session or all other sessions while keeping this browser signed in; the server checks session ownership. Revocation removes account access, while local watchlists and encrypted wallet backups remain on the other device.

The session-management API requires a recent login. If the panel asks for fresh authentication, sign out and sign back in before retrying. An independent-access summary uses the account's actual linked sign-in methods, verified-email state, email-delivery availability, and authenticator status. It cannot check whether recovery codes were saved. Social-only accounts should add an independent password and save authenticator recovery codes before they lose access to a provider.

```sh
npm run test:sessions
CHROMIUM_PATH=/path/to/chromium node tests/session-browser.mjs
```

## Production configuration

Set these on the server:

- `DATABASE_URL`: persistent PostgreSQL connection.
- `BETTER_AUTH_SECRET`: stable random secret of at least 32 characters. Use the same secret across all instances; store it in a secret manager.
- `BETTER_AUTH_URL`: exact public HTTPS origin, such as `https://dashboard.example.com`.

Production authentication fails closed with HTTP 503 if these are missing. Building the client application does not require production credentials. Run `node scripts/migrate.mjs` with `DATABASE_URL` configured before serving production requests. It applies all `migrations/*.sql` in order and records successful migrations transactionally. Development PGLite applies the same files on startup.

Vercel preview deployments use separate credentials. Whenever `VERCEL=1` and `VERCEL_ENV` is not exactly `production` (including an unset value), the server and build-time migrator ignore generic `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`. Account services remain unavailable and migrations are skipped unless all three preview variables are valid:

- `PREVIEW_DATABASE_URL`: an isolated preview PostgreSQL database, never the production database.
- `PREVIEW_BETTER_AUTH_SECRET`: a separate stable random secret of at least 32 characters.
- `PREVIEW_BETTER_AUTH_URL`: the exact HTTPS preview origin, with no path, query, or credentials.

Scope these variables to the Vercel Preview environment. Use a stable preview URL and enroll preview passkeys there; production passkeys remain bound to the production origin. An incomplete preview configuration cannot access or migrate a database. Local development and Vercel Production retain the standard variables above. Avoid copying production credential values into preview-specific variables.

Optional OAuth credentials:

| Provider  | Server variables                             | Redirect/callback            |
| --------- | -------------------------------------------- | ---------------------------- |
| Google    | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`   | `/api/auth/callback/google`  |
| Discord   | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | `/api/auth/callback/discord` |
| Twitter/X | `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | `/api/auth/callback/twitter` |
| GitHub    | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`   | `/api/auth/callback/github`  |
| Twitch    | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`   | `/api/auth/callback/twitch`  |

Register the complete HTTPS callback URL in each provider's developer console. Provider client secrets are server-only. The UI obtains only configured/not-configured flags from `/api/auth/config`.

GitHub uses the installed Better Auth adapter with `read:user` and `user:email`, browser-bound OAuth state, and S256 PKCE. Twitch uses the installed adapter with `openid` and `user:read:email`, email-related ID-token claims, browser-bound state, and a server-side confidential authorization-code exchange. This Twitch adapter does not use PKCE and does not accept a client-supplied ID token as a sign-in credential. Both adapters preserve the provider's email-verification result. Missing provider email cannot create an account; addresses are never invented to bypass that requirement.

Set provider credentials separately for Vercel Production and Preview, using separate provider applications when callback registration requires it. In particular, a GitHub OAuth application has a registered callback origin; a preview must register its own exact callback URL. Keep the preview database, authentication secret, and origin isolation described above. Accounts are linked only through an explicit provider ownership flow and the existing verified-local-email check; implicit email matching and linking different email addresses remain disabled. Authenticator protection for password/passkey sign-in, provider MFA, passkeys, and backup email/password recovery retain their existing behavior.

Automated OAuth tests use local HTTP-response fixtures for the official adapters. They verify initiation, callbacks, browser state, and account-linking rules; successful login with a real GitHub or Twitch application still requires registered credentials and provider-side verification.

For verification and password reset email, set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` using a verified sending domain. Requests go to `https://api.resend.com/emails`. The secret must be available to this server's process; a proxy placeholder alone may not suit every deployment. Reset email requests use generic existence-neutral responses and revoke other sessions after a successful password reset.

Rate limits use the shared PostgreSQL `rateLimit` table, including atomic increments and unique endpoint/IP counters, so a new serverless instance cannot reset the limit. Login allows ten attempts per minute per IP and endpoint; signup allows five, and password-reset/verification emails allow three. Account-level authenticator lockout also persists in the database. Deploy migration `0004_auth_rate_limit.sql` before enabling authentication. IP headers must come from the hosting platform's trusted proxy; direct self-hosting must overwrite untrusted forwarded headers. Database backups, configured email delivery, HTTPS, and provider-specific end-to-end verification remain deployment requirements.

## Troubleshooting account availability

Open `/api/auth/config` on the same deployment as the login page. It should return HTTP 200 with JSON containing `configured`, `emailRecovery`, `passkeys`, `passkeyOrigin`, `production`, and provider flags for `google`, `discord`, `twitter`, `github`, and `twitch`. This public endpoint returns availability flags and the public passkey origin; it never returns credentials or session tokens. It does not connect to the database or contact OAuth providers.

- **`configured: false`:** account setup is incomplete. On Vercel Preview, set the complete `PREVIEW_DATABASE_URL`, `PREVIEW_BETTER_AUTH_SECRET`, and `PREVIEW_BETTER_AUTH_URL` trio in Preview settings. The secret needs at least 32 characters; the URL must be the exact public HTTPS origin. Generic production credentials are intentionally ignored there. Configuration discovery still returns 200; account operations return 503 until setup is complete.
- **`configured: true`, provider flag `false`:** add that provider's complete client ID/secret pair from the table above. The five implemented adapters each require their own registered application. Register the exact deployment origin plus its `/api/auth/callback/<provider>` path, including the correct preview hostname. A `true` flag confirms configuration is present; test the real provider flow to verify credentials, consent, and callback registration.
- **HTML, a redirect, or HTTP 404:** inspect the deployed `/api/[...path]` function and API routing, deployment protection, and the requested hostname. The browser-only downloadable build has no account server. A static page response cannot supply account configuration.
- **HTTP 500/503 or a pending request:** inspect the Vercel function logs and browser Network panel for startup errors, platform responses, or failed requests. Missing preview/provider settings alone should produce the 200 JSON configuration response above. Retry availability after resolving the request failure.

After changing Preview variables or callback registration, redeploy the preview and check its configuration endpoint again. Keep production variables and production provider registrations unchanged. Configure secrets only in server-side deployment settings.

## Integrations requiring further work

Bluesky, Fluxer, Stoat, Hey/Lens, and Mastodon integrations are tracked in the [development proposals](proposals.md#add-next). The login interface lists only the five implemented adapters. Provider profile links remain separate from account authentication.

Yoti identity verification and service-held wallet keys are not enabled. Identity verification does not itself store or recover crypto keys. A custodial product requires a separately designed and reviewed key-management service. The application never sends locally generated wallet recovery phrases to its account service.
