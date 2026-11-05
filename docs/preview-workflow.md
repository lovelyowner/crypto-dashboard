# Development previews

Ongoing development uses Git branch **preview**. Production stays on **main**. Each completed batch is checked, committed, and pushed once to `origin preview`; the connected Vercel Git integration can then create a Preview deployment automatically.

In Vercel, open this project's **Deployments**, filter by the `preview` branch, and open its latest **Ready** deployment. Copy the branch alias from that deployment's domains to keep a reusable preview link. An individual deployment URL stays tied to one build; the branch alias follows subsequent successful deployments. The exact alias depends on the linked project/team and must be read from Vercel rather than guessed.

A push is not proof of deployment success. Check Vercel's Ready/Failed status and build logs when no deployment link is available. Build time depends on the queue, dependencies, and migrations; no fixed delay is guaranteed.

## Account features in previews

Public-address tracking and browser-local wallets work without account-server credentials. Previews fail closed for account storage unless all three preview variables are configured:

| Preview variable | Value |
| --- | --- |
| `PREVIEW_DATABASE_URL` | A separate preview PostgreSQL database; never the production database. |
| `PREVIEW_BETTER_AUTH_SECRET` | A separate stable random secret, at least 32 characters. |
| `PREVIEW_BETTER_AUTH_URL` | The exact HTTPS origin of the reusable branch preview link. |

Set these for Vercel's **Preview** environment (optionally only the `preview` branch), then redeploy. The migration build and runtime select these together and ignore generic production database/auth settings on Vercel previews. Incomplete configuration leaves accounts unavailable and skips database migrations. Keep test payment, email, and OAuth-provider credentials scoped to Preview as needed; the account origin must also be registered with enabled providers. Passkeys are bound to their configured domain and do not move between preview and production.

Production and local development retain their existing `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL` configuration. Never put credentials in Git or chat.

## Review efficiently

Use the same branch preview link on desktop and mobile after completed batches. Routine updates need only that link and a short changelog. Downloadable HTML/ZIP files and screenshots remain available when requested; they are not rebuilt for every edit. Real accounts, publishing, messaging, and passkeys require the configured server application.
