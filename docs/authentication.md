# Accounts and recovery

Watching public addresses and creating local wallets work without an account. Accounts use Better Auth at the same origin as the application, with HttpOnly session cookies and the existing PostgreSQL/PGLite database. The imported app's Grok broker and preview credentials have been removed.

## Available now

- Email/password registration and sign-in.
- Explicit username sign-in mode, including meaningful Unicode, punctuation, emoji, internal spaces, and `@`.
- Usernames are case-sensitive and normalized to NFC before uniqueness checks. They contain 1–64 Unicode code points and cannot contain surrounding whitespace or control/invisible formatting characters. Passwords accept arbitrary character categories, 12–256 UTF-16 code units. Better Auth's built-in scrypt password hashing applies Unicode NFKC normalization.
- Authenticator enrollment using a manual secret or `otpauth:` link. Activation requires a valid six-digit RFC6238 code. Standard codes rotate every 30 seconds. Ten encrypted, single-use backup codes containing 16 random alphanumeric characters support authenticator recovery. Generating new backup codes invalidates the previous set.
- TOTP protects email and username sign-in. OAuth providers use their own MFA/security policies; the local authenticator does not add another challenge to OAuth callbacks.
- Choose an absolute session lifetime of one hour, one day (default), or seven days. The database records the deadline and activity never extends it. A checked “Remember me” option makes a persistent email/username login cookie; unchecked uses a browser-session cookie. Browser session restore can retain session cookies, but cannot extend the server deadline. The chosen duration also applies to social sign-in and persists across authenticator/backup-code verification. Standard TOTP settings remain fixed for authenticator compatibility.
- Direct Google, Discord, and Twitter/X OAuth when configured. Explicit account linking requires proof through the provider; implicit merging of same-email accounts is disabled. Linking requires the same verified email on both accounts. The server prevents removal of the last sign-in method.
- Social accounts with a verified email may add an independent password after fresh authentication. Account recovery is independent of wallet key recovery.

## Development

`npm run dev` starts the app on port 8080. PGLite stores local account data under `.data/fathom` (or `PGLITE_DATA_DIR`). A private signing/encryption secret is generated at `.local/auth-secret` with owner-only file permissions, retained across local restarts. Do not commit, share, or overwrite `.local`; existing encrypted authenticator data depends on its signing secret. Local passwords work without an email provider, but email verification and emailed password-reset links are unavailable until delivery is configured.

Test against a running development server:

```sh
node scripts/auth-integration.mjs http://127.0.0.1:8080
```

The test creates a disposable account and exercises real HTTP endpoints, cookies, Unicode username/password sign-in, verified TOTP, and recovery-code replay protection. It does not contact social providers or print secrets.

`npm test` also exercises session policies against Better Auth's real HTTP handler using an isolated memory database. It checks actual expiration, remembered and browser-session cookies, invalid choices, two-factor continuation, forged continuation cookies, and backup-code recovery. Login requests use the bounded `x-fathom-session-duration` header (`1h`, `1d`, or `7d`). A signed HttpOnly cookie lasts up to ten minutes while OAuth or 2FA completes, then is removed. Missing or invalid continuation policy cookies fall back to the shortest lifetime. Cookie lifetime and database lifetime agree; server expiry is authoritative.

## Production configuration

Set these on the server:

- `DATABASE_URL`: persistent PostgreSQL connection.
- `BETTER_AUTH_SECRET`: stable random secret of at least 32 characters. Use the same secret across all instances; store it in a secret manager.
- `BETTER_AUTH_URL`: exact public HTTPS origin, such as `https://dashboard.example.com`.

Production authentication fails closed with HTTP 503 if these are missing. Building the client application does not require production credentials. Run `node scripts/migrate.mjs` with `DATABASE_URL` configured before serving production requests. It applies all `migrations/*.sql` in order and records successful migrations transactionally. Development PGLite applies the same files on startup.

Optional OAuth credentials:

| Provider  | Server variables                             | Redirect/callback            |
| --------- | -------------------------------------------- | ---------------------------- |
| Google    | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`   | `/api/auth/callback/google`  |
| Discord   | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | `/api/auth/callback/discord` |
| Twitter/X | `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | `/api/auth/callback/twitter` |

Register the complete HTTPS callback URL in each provider's developer console. Provider client secrets are server-only. The UI obtains only configured/not-configured flags from `/api/auth/config`.

For verification and password reset email, set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` using a verified sending domain. Requests go to `https://api.resend.com/emails`. The secret must be available to this server's process; a proxy placeholder alone may not suit every deployment. Reset email requests use generic existence-neutral responses and revoke other sessions after a successful password reset.

Rate limits use the shared PostgreSQL `rateLimit` table, including atomic increments and unique endpoint/IP counters, so a new serverless instance cannot reset the limit. Login allows ten attempts per minute per IP and endpoint; signup allows five, and password-reset/verification emails allow three. Account-level authenticator lockout also persists in the database. Deploy migration `0004_auth_rate_limit.sql` before enabling authentication. IP headers must come from the hosting platform's trusted proxy; direct self-hosting must overwrite untrusted forwarded headers. Database backups, configured email delivery, HTTPS, and provider-specific end-to-end verification remain deployment requirements.

## Integrations requiring further work

Fluxer and Stoat OAuth endpoints vary by instance and have not been implemented. Bluesky uses AT Protocol OAuth and needs its own secure adapter rather than a guessed generic OAuth URL. These buttons explicitly show “Not integrated”. Google, Discord, and Twitter show “Setup required” until their server credentials exist.

Yoti identity verification and service-held wallet keys are not enabled. Identity verification does not itself store or recover crypto keys. A custodial product requires a separately designed and reviewed key-management service. The application never sends locally generated wallet recovery phrases to its account service.
