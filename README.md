# Fathom

A multi-chain, browser-first crypto address dashboard, rebuilt from the supplied Grok application. Watch public addresses without signing in; create passphrase-encrypted wallets locally. Account authentication runs on a small same-origin server. No Grok services or shared broker credentials are required.

## Open or publish the browser edition

Run `npm run build:site` to create:

- `site/`: a ready-to-upload static website. Upload its contents to an HTTPS static host; no Node server, database, or build step is needed on the host.
- `Fathom.html`: a standalone file with the JavaScript and CSS bundled inside. Download it and open it in a current browser. File URL restrictions and local-storage behavior vary between browsers; HTTPS hosting is the recommended way to use it consistently.

For a public browser link without command-line deployment, unzip `fathom-website.zip`, open [Netlify Drop](https://app.netlify.com/drop), and upload the extracted website folder containing `index.html`. Netlify supplies the HTTPS URL. A hosting account may be required. No hosting deployment was performed from this workspace.

The browser edition supports public-address tracking, local encrypted wallets, and watchlist/backup imports and exports. Email/social login and account 2FA are not enabled because there is no account server. Wallet backup protection works independently. Public data still needs Internet access and is subject to provider CORS and rate limits.

Saved data is specific to a browser and site address. Export your watchlist and encrypted wallet backup before switching from a local file to a hosted URL; export files do not transfer automatically. Keep recovery words offline.

The normal `npm run build` / `npm start` workflow below remains available for the full application, including account features once its backend is configured.

## Deploy this repository to Vercel

Import `lovelyowner/crypto-dashboard` in Vercel and select the `main` branch with the repository root as the Root Directory. The checked-in `vercel.json` selects **Other** (no framework preset), installs with `npm ci`, builds with `npm run build:site`, and publishes `site/`. Node.js 24 is declared in `package.json`. No environment variables are needed for this browser-only deployment. Do not override the build command with `npm run build`; that command builds the separate Node-server edition.

After connecting the repository, pushes to `main` can trigger Vercel production deployments. Vercel provides the actual deployment URL; a configuration file or Git push alone does not establish a live deployment.

The Vercel browser edition supports watchlists, public address activity, encrypted local wallets, and backup import/export. Email/social login and account 2FA require deploying/configuring the separate account backend, persistent PostgreSQL, mail delivery, and provider credentials. The browser edition clearly labels these as unavailable. Keep an offline wallet backup before changing the site domain, because local browser data does not move between domains.

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
npm run test:auth  # running development server required; creates a disposable test account
npm run test:e2e   # running server + Playwright Chromium required
npm run build
```

Install the browser for UI tests with `npx playwright install chromium`. Browser tests use fixture responses for public chain APIs. Screenshots under `screenshots/new-*` use fixture balances, not real portfolio values.

## What works

- 22 network choices with per-network capabilities, checksum-aware validation, address labels, search, network/direction filters, automatic refresh, explorer links, native balances, recent activity, and explicit unavailable/partial states.
- Public watchlist JSON import/export and recent transaction CSV export. Imports validate the complete file before adding entries; exports contain no wallet secrets.
- Native balance/activity adapters for Bitcoin, Ethereum and EVM networks, Solana, Cosmos Hub, Osmosis, Celestia, NEAR, and XRP. Polkadot and Kusama expose finalized native free balances; history requires an indexer. Some EVM networks provide balance only.
- Browser-generated 24-word BIP39 wallets, offline backup acknowledgment and word challenge, BTC/ETH/SOL/Cosmos/XRP/NEAR public addresses, passphrase-only AES-GCM encryption using PBKDF2-SHA256 (600,000 iterations), encrypted backup import/export, and password-gated recovery reveal. Generating NEAR/XRP addresses does not fund or activate their accounts.
- Email/password and Unicode username login, authenticator enrollment with verification, single-use recovery codes, server-enforced session limits, account linking, and direct Google/Discord/Twitter adapters when configured.
- Responsive desktop/mobile layout and keyboard-accessible dialogs.

## Limits that matter

Tracking queries public third-party APIs directly from the browser. This shares queried addresses and the client's IP with those providers. CORS restrictions, outages, and rate limits can make data unavailable. Native balances are not full portfolio valuations: token/NFT holdings, staking, internal calls, and complete historical indexing are outside this version. Transactions involving two watched addresses appear once per address. USD totals include only successfully priced addresses and are labeled accordingly.

Monero deliberately does not claim public address-only balances or history: these are private. No private view keys are requested. Polkadot/Kusama transaction history and service indexing are not implemented. Public address format validation does not prove ownership.

Wallets are experimental and not independently audited. Start with test amounts. Recovery words and passphrases never go to the account server. The encrypted browser copy can be lost by clearing site data; keep an offline phrase and a separate encrypted backup. Accounts cannot recover lost wallet keys. All local watchlists and encrypted wallets belong to this browser workspace, not to an account, and are not cloud-synced. Signing in on another device does not restore them.

Google, Discord, and Twitter need registered applications and server credentials. Fluxer, Stoat, and Bluesky are shown as not integrated. Yoti verification and custodial/service-held keys are not implemented. Identity verification alone is not key custody. OAuth sign-in uses the provider's MFA; the local TOTP challenge protects email/username sign-in. TOTP remains a standard six-digit, 30-second code rather than offering misleading security sliders.

## Deploy

The production build is a Node server, not a static-only Firebase Hosting bundle.

1. Provision PostgreSQL and configure `DATABASE_URL`, a stable random `BETTER_AUTH_SECRET` of at least 32 characters, and an exact HTTPS `BETTER_AUTH_URL`.
2. Configure email delivery and desired OAuth providers as described in [authentication](docs/authentication.md). No secrets belong in `VITE_*` variables or source code.
3. Apply schema with `npm run db:migrate`, build with `npm run build`, then run `npm start` behind HTTPS.
4. Before public multi-instance deployment, add shared rate limiting, database backups/monitoring, and validate the actual provider callbacks, verification, recovery-email delivery, and browser CORS. These external flows were not exercised here.

Production authentication returns 503 until required settings exist; public watch-only and local wallet features still render. Merely building does not publish a site or configure an OAuth provider.

## Why TypeScript rather than Rust/Firebase here?

TypeScript preserves the existing React/TanStack app and its mature Better Auth integration. The wallet operations use browser cryptography and established noble/scure primitives; Rust/WASM is not required for these operations and would not make UI code or RPC calls inherently safer. Rust is a reasonable choice for a future indexer, signing service, or custodial service when that scope is designed separately.

Firebase is a useful managed alternative, not an automatic security upgrade. Migrating would require a real Firebase project, Identity Platform decisions for MFA/custom providers, Firestore rules, deployment configuration, and recovery testing. This version avoids pretending those services exist. Firebase Hosting can serve a frontend in a redesigned architecture, while the current same-origin account endpoints need a compatible backend. Never store plaintext recovery phrases in Firestore.

See [network access](docs/network-access.md) and [authentication setup](docs/authentication.md).
