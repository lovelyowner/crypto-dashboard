# Fathom

A multi-chain, browser-first crypto address dashboard, rebuilt from the supplied Grok application. Watch public addresses without signing in; create passphrase-encrypted wallets locally. Account authentication runs on a small same-origin server. No Grok services or shared broker credentials are required.

See [development proposals](docs/proposals.md) for prioritized additions and simplifications. The latest development batch fixes nested Vercel account API routing, makes preview build links available inside the account panel, keeps sign-in errors above owner diagnostics, and removes duplicate setup warnings. Earlier updates include UTC-filtered [conversation downloads](docs/account-data.md), OAuth callback 2FA, unified refresh/import controls, and token-owner recovery.

Ongoing updates use the `preview` branch, with production kept on `main`. See the [preview workflow](docs/preview-workflow.md) for the reusable Vercel link, separate preview account configuration, and efficient UI review.

## Open or publish the browser edition

Run `npm run build:site` to create:

- `site/`: a ready-to-upload static website. Upload its contents to an HTTPS static host; no Node server, database, or build step is needed on the host.
- `Fathom.html`: a standalone file with the JavaScript and CSS bundled inside. Download it and open it in a current browser. File URL restrictions and local-storage behavior vary between browsers; HTTPS hosting is the recommended way to use it consistently.

For a public browser link without command-line deployment, unzip `fathom-website.zip`, open [Netlify Drop](https://app.netlify.com/drop), and upload the extracted website folder containing `index.html`. Netlify supplies the HTTPS URL. A hosting account may be required. No hosting deployment was performed from this workspace.

The browser edition supports public-address tracking, local encrypted wallets, and watchlist/backup imports and exports. This standalone/static edition has no account server, so email/social login and account 2FA are unavailable. The Vercel hosted build below includes the account API. Wallet backup protection works independently. Public data still needs Internet access and is subject to provider CORS and rate limits.

Saved data is specific to a browser and site address. Export your watchlist and encrypted wallet backup before switching from a local file to a hosted URL; export files do not transfer automatically. Keep recovery words offline.

The normal `npm run build` / `npm start` workflow below remains available for the full application, including account features once its backend is configured.

For an interactive inbox review without publishing, run `npm run build:review` and open `Fathom-inbox-preview.html` in a browser. It uses the real inbox interface with fictional messages held in memory. Try creator/sender views, unread replies, separate conversation drafts, Discard draft, and Copy conversation. No real accounts, payments, or messages are sent, and the file makes no network requests. Reloading resets the sample. Verify it with `npm run test:review` after building (Playwright Chromium required).

## Deploy this repository to Vercel

Import `lovelyowner/crypto-dashboard` in Vercel and select `main` with the repository root as Root Directory. The checked-in `vercel.json` selects **Other**, installs with `npm ci`, builds with `npm run build:vercel`, and publishes `site/`. Node.js 24 is declared in `package.json`. The hosted build includes same-origin Node functions under `/api/*` for accounts, private profile drafts, and published creator pages. Public watchlists, local wallets, creator links, wishlists, donation links, and public profile snapshots work without account credentials.

For accounts, add these server-only variables in **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Variable             | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`       | Persistent PostgreSQL connection, with the provider's required TLS settings |
| `BETTER_AUTH_SECRET` | Stable random signing/encryption secret of at least 32 characters           |
| `BETTER_AUTH_URL`    | Exact public HTTPS origin of this deployment                                |

Keep secrets out of chat and Git, and never prefix them with `VITE_`. Production account endpoints return HTTP 503 and the UI shows setup required until configuration is present. Every hosted build applies pending `migrations/*.sql` to the configured database; a migration failure stops deployment. Preview deployments need a separate database and matching origin if accounts should work there. Wallet phrases and encrypted wallet backups remain in the browser and never enter account storage.

Set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` for email verification and password reset. Google, Discord, Twitter/X, GitHub, and Twitch each require their own registered OAuth client and callback on the public origin; see [Accounts and recovery](docs/authentication.md). Sign-in and sign-up show the five supported service choices below the password form and account links, with account linking available after sign-in. The main **Continue with** / **Connect** buttons always start the actual same-origin OAuth request after session discovery. The server validates account/provider setup and returns either an authorization redirect or a clear setup error. Public configuration loading has an eight-second deadline and an explicit retry; a failure there does not convert login buttons into diagnostics. Owner diagnostics are a separate **Website sign-in setup** action. When a provider request fails, its HTTP status, response MIME type, and safe Vercel request ID are available there and in the copied checklist. Blocked requests also offer a direct full-tab sign-in link. Only the five implemented login services are shown. Bluesky, Fluxer, Stoat, hey.xyz, and Mastodon login placeholders have been removed. Authorization waits are bounded to 12 seconds, malformed responses produce visible errors, and a manual continuation link remains available if navigation is blocked. See the [integration requirements](docs/authentication.md#integrations-requiring-further-work). Profile links work independently of login.

Pushes to `main` trigger deployments when Vercel's Git integration is enabled. The Git push is immediate; deployment takes as long as the queued install, build, and database migration. Check **Vercel → Deployments** for the actual URL and ready/failed status. This workspace does not have access to the Vercel deployment API, so a successful push is not evidence that a deployment is live. Keep an offline wallet backup before changing the site domain, because local browser data does not move between domains.

## Run

Use Node.js 24 and npm 11.

```sh
npm ci
npm run dev
```

The development server uses port 8080. Local accounts persist in `.data/fathom`, with a generated development encryption/signing secret in `.local/auth-secret`. Both paths are ignored by Git. Keep the secret and database private and backed up together; do not share development databases with deployed instances.

```sh
npm run typecheck
npm run lint
npm test
npm run test:auth     # running development server required; creates disposable test accounts
npm run test:profile  # checks private account draft ownership over real HTTP
npm run test:publication # verifies explicit publishing and handle ownership
npm run test:sessions # verifies actual session revocation and account isolation
npm run test:contact # verifies inbox privacy and message payment gates
npm run test:creator-setup # verifies publication refresh, unsaved fees, and checkout controls
npm run test:inbox-activity # verifies private reply activity, unread state, and refresh behavior
npm run test:e2e      # running server + Playwright Chromium; includes disposable account UI checks
npm run build:vercel
npm run test:hosted   # isolated production smoke; uses the built site and actual API entry
npm run build
```

Install the browser for UI tests with `npx playwright install chromium`. Browser tests use fixture responses for public chain APIs. Screenshots under `screenshots/new-*` use fixture balances, not real portfolio values.

## What works

- 22 network choices with per-network capabilities, checksum-aware validation, address labels, search, network/direction filters, automatic refresh, explorer links, native balances, recent activity, and explicit unavailable/partial states.
- Atomic bulk address entry (one public address and optional comma-separated label per line), duplicate skipping, editable labels, pinning, and recent/label/known-USD sorting. Watchlist JSON exports preserve pins and contain no wallet secrets.
- Select individual or visible watchlist entries, export only the selection, and remove several addresses together. Undo restores the last removal while the tab remains open, including labels, pins and surviving wallet associations. Removal never deletes wallet keys; Undo cannot recreate a deleted wallet. Selection counts include entries hidden by the current filters.
- Remembers the current tab, address sorting, network/direction filters, transaction status, and date window. Search text and selected addresses are not saved. Reset view restores the initial view. These view choices stay local to the browser.
- A sync-health panel separates available native balances, limited recent history, unavailable providers, private networks, and missing results. It uses original per-address check timestamps and marks successful results at least five minutes old as stale. A fresh cached workspace response does not make an old balance check look new.
- Transaction explorer with counterparty/full-hash/label search, watched-address, network, direction, status, and time filters. CSV exports include only filtered rows and retain exact amount strings. Unknown timestamps are excluded from bounded date windows.
- Workspace settings for on-screen balance hiding, refresh intervals, and sync pause, with offline notices and local cross-tab preference updates. Hiding amounts masks DOM text, not the public addresses or provider requests. Explicit CSV exports still contain real amounts. Pausing stops new refresh operations; requests belonging to an already running refresh may finish.
- Native balance/activity adapters for Bitcoin, Ethereum and EVM networks, Solana, Cosmos Hub, Osmosis, Celestia, NEAR, and XRP. Polkadot and Kusama expose finalized native free balances; history requires an indexer. Some EVM networks provide balance only.
- Browser-generated 24-word BIP39 wallets, offline backup acknowledgment and word challenge, BTC/ETH/SOL/Cosmos/XRP/NEAR public addresses, passphrase-only AES-GCM encryption using PBKDF2-SHA256 (600,000 iterations), encrypted backup import/export, and password-gated recovery reveal. Generating NEAR/XRP addresses does not fund or activate their accounts.
- One Email or username password-login field, passkey login, authenticator enrollment with verification, single-use recovery codes, server-enforced session limits, account linking, and direct Google/Discord/Twitter adapters when configured.
- Fresh-session account/profile and conversation JSON downloads with owner-scoped reads, explicit limits, anonymous-message privacy, and no changes to inbox read state. See [export scopes](docs/account-data.md).
- Exact read-only [ERC20/SPL token balances](docs/token-balances.md) for explicitly selected public owners and contracts/mints, separate from native USD totals. Public token-watch JSON backups preview validated merges, skip duplicates and unmatched owners, and contain no wallet keys or account data.
- Inbox block/report controls, prospective contact/payment-quote guards, private report snapshots, and a server-authorized moderation review queue. See [Messages and payments](docs/messages-and-payments.md).
- Responsive desktop/mobile layout and keyboard-accessible dialogs.

## Creator profiles, wishlists, and donations

Open **Profile** in the sidebar. Create a Unicode display name and bio, up to 20 ordered links, and up to 20 wishlist items with exact optional prices and currency codes. Optional personal links open AllMyLinks, Throne, NOWPayments, or Bluesky. These service links are not account verification or provider integrations.

Support options include a hosted bank/payment checkout link and up to 10 validated public crypto addresses with network labels, copy buttons, and explorer links. Verified message payments support direct Ethereum transfers and creator-owned NOWPayments invoices as described in [Messages and payments](docs/messages-and-payments.md). The app does not collect bank account numbers, guarantee wishlist fulfillment, or custody donated funds. Merchants and payment providers handle their own checkout and regional eligibility.

The Donations editor can copy selected public receiving addresses from saved local wallets and watchlists; this never transfers wallet secrets. **Save local draft** explicitly saves to this browser. **Export profile** creates a public-data-only backup; import validates every field before replacing the editor. Switching dashboard tabs preserves unsaved edits. **Save to account** / **Load from account** explicitly write/read a private draft under the signed-in account; they never publish it.

**Share public profile** creates a snapshot URL containing the public profile in the `#profile=` fragment. Anyone with that URL can read its contents, including donation addresses. Opening a snapshot presents a read-only profile and does not change the visitor's local draft; **Use as local draft** is an explicit action. Editing a draft does not change previously shared links. A snapshot is independent of the hosted page described below. Large profiles can create long URLs; export JSON when a messaging service rejects the link. Only public HTTPS links are accepted; listed profiles and crypto addresses are self-reported, with no ownership badge.

For a stable address, sign in and open **Public page** in the profile editor. Choose a 3–32 character public handle using letters, digits, underscores, or hyphens, starting and ending with a letter or digit. Public handles are lowercase and separate from Unicode sign-in names. A handle belongs to one account and cannot be renamed in this release; unpublishing keeps it reserved. Existing `/u/your-handle` links remain supported; application route names are reserved.

**Publish public page** explicitly sends the current valid editor snapshot to `/your-handle`. Updating or privately saving a draft leaves the published page unchanged until **Publish update** is chosen. **Unpublish page** makes new anonymous profile API requests return 404 and shows visitors an unavailable page, while retaining your handle and private snapshot for republishing. Saved copies and older `#profile=` links remain readable. Visitors see only the public profile fields; no account email, linked provider data, sessions, watchlist, or keys are returned. Visitor pages do not load the watchlist, query blockchain providers, or alter the visitor's browser drafts.

Stable pages require the hosted account/database configuration and migration `0006_public_profiles.sql`, which the Vercel build applies automatically when `DATABASE_URL` is set. Standalone files and guest mode retain local editing and snapshot sharing. A social feed and Bluesky sign-in are not implemented. Account-based DMs, anonymous or named donation messages, and verified paid-message options are described in [Messages and payments](docs/messages-and-payments.md).

## TXT address import and dates

Choose **Import TXT addresses** in the sidebar, or **Add address → Upload TXT**. The importer reads the UTF-8 file locally (up to 200 KB and 100 address entries), shows detected networks, validates every row, and adds the complete batch after your confirmation. Duplicate addresses on the same network are skipped. Blank lines and `#` comment lines are ignored.

Each line can contain a public address alone, `address, Optional label`, or an explicit network hint such as `ethereum:address, Label`, `base:address`, or `ETH (ERC20),address, Label`. Bitcoin, supported Cosmos prefixes, XRP, Solana, named NEAR `.near` accounts, Monero, and network-specific SS58 formats can be matched automatically. A matching format does not prove ownership or that an account has activity.

An EVM `0x` address does not reveal which chain it belongs to. Select the intended network once for unassigned EVM rows, or select per row. Explicit hints in the file retain their network. Generic SS58 needs a Polkadot/Kusama choice. Bare 64-digit hexadecimal values are never auto-imported as NEAR because they can look like private keys; only confirm a NEAR public implicit-account identifier. Other NEAR account names need an explicit `near:` hint. Never upload private keys or recovery phrases.

Network labels now include the ticker and token standard, for example **Ethereum · ETH (ERC20)**, **BNB Smart Chain · BNB (BEP20)**, and **Solana · SOL (SPL)**. These labels identify the network standard; they do not imply complete token indexing. ETH remains the native coin, distinct from ERC20 tokens.

Transaction dates in the table and recent-activity feed use **dd.mm.yy in UTC**, such as `01.01.26`. CSV exports include that readable date plus the full UTC timestamp, and table tooltips retain full timing information. Sync-status timestamps still use relative wording.

## Limits that matter

Tracking queries public third-party APIs directly from the browser. This shares queried addresses and the client's IP with those providers. CORS restrictions, outages, and rate limits can make data unavailable. Native balances are not full portfolio valuations. Explicit ERC20/SPL watches show token quantities separately; automatic token indexing, token USD prices, NFTs, staking, internal calls, and complete historical indexing remain outside this version. Transactions involving two watched addresses appear once per address. USD totals include only successfully priced native addresses and are labeled accordingly.

Monero deliberately does not claim public address-only balances or history: these are private. No private view keys are requested. Polkadot/Kusama transaction history and service indexing are not implemented. Public address format validation does not prove ownership.

Wallets are experimental and not independently audited. Start with test amounts. Recovery words and passphrases never go to the account server. The encrypted browser copy can be lost by clearing site data; keep an offline phrase and a separate encrypted backup. Accounts cannot recover lost wallet keys. All local watchlists and encrypted wallets belong to this browser workspace, not to an account, and are not cloud-synced. Signing in on another device does not restore them.

Google, Discord, Twitter/X, GitHub, and Twitch need registered applications and server credentials. Their authorization buttons appear below the sign-in/sign-up form, with separate owner setup help and compact error feedback below the buttons. The form uses the default session policy automatically, without a duration selector. Fluxer, Stoat, Bluesky, hey.xyz, and Mastodon authentication remain planned integrations. Yoti verification and custodial/service-held keys are not implemented. Identity verification alone is not key custody. The local TOTP challenge protects email, username, passkey, and social sign-in when enabled. TOTP remains a standard six-digit, 30-second code rather than offering misleading security sliders.

## Deploy

The production build is a Node server, not a static-only Firebase Hosting bundle.

1. Provision PostgreSQL and configure `DATABASE_URL`, a stable random `BETTER_AUTH_SECRET` of at least 32 characters, and an exact HTTPS `BETTER_AUTH_URL`.
2. Configure email delivery and desired OAuth providers as described in [authentication](docs/authentication.md). No secrets belong in `VITE_*` variables or source code.
3. Apply schema with `npm run db:migrate`, build with `npm run build`, then run `npm start` behind HTTPS.
4. Use trusted proxy IP headers for the shared database rate limiter, configure database backups/monitoring, and validate provider callbacks, verification, recovery-email delivery, and browser CORS on the deployment.

Production authentication returns 503 until required settings exist; public watch-only and local wallet features still render. Merely building does not publish a site or configure an OAuth provider.

## Why TypeScript rather than Rust/Firebase here?

TypeScript preserves the existing React/TanStack app and its mature Better Auth integration. The wallet operations use browser cryptography and established noble/scure primitives; Rust/WASM is not required for these operations and would not make UI code or RPC calls inherently safer. Rust is a reasonable choice for a future indexer, signing service, or custodial service when that scope is designed separately.

Firebase is a useful managed alternative, not an automatic security upgrade. Migrating would require a real Firebase project, Identity Platform decisions for MFA/custom providers, Firestore rules, deployment configuration, and recovery testing. This version avoids pretending those services exist. Firebase Hosting can serve a frontend in a redesigned architecture, while the current same-origin account endpoints need a compatible backend. Never store plaintext recovery phrases in Firestore.

See [network access](docs/network-access.md) and [authentication setup](docs/authentication.md).
