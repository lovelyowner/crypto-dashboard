/** Exercise the Vercel browser build and its actual plain-Node API entry.
 * Run after npm run build:vercel: npm run test:hosted
 * Production secrets are removed from the child process; no database is touched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { chromium } from "playwright";
import { compileApiRuntime } from "../scripts/api-runtime.mjs";

const filename = fileURLToPath(import.meta.url);
const project = resolve(dirname(filename), "..");
const serving = process.argv.includes("--serve");
const apiRuntime = serving
  ? {
      directory: process.argv[3],
      entryURL: pathToFileURL(resolve(process.argv[3], "api/[...path].js")),
    }
  : await compileApiRuntime();
const { ROOT_PROFILE_ROUTE_SOURCE, publicHandleFromPath } = await import(
  pathToFileURL(resolve(apiRuntime.directory, "src/lib/profile-url.js")).href
);

async function serveHostedBuild() {
  const { default: handleApi } = await import(apiRuntime.entryURL);
  const directory = resolve(project, "site");
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response);
        return;
      }
      // Mirrors the repository's explicit SPA entry and login rewrites. Do not
      // turn missing JS/assets or API failures into successful index responses.
      const pathname =
        ["/", "/login", "/login/"].includes(url.pathname) ||
        publicHandleFromPath(url.pathname) !== null
          ? "/index.html"
          : decodeURIComponent(url.pathname);
      const path = resolve(directory, `.${pathname}`);
      if (!path.startsWith(`${directory}${sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, {
        "content-type": contentTypes[extname(path)] || "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
  process.on("SIGTERM", () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}

async function startHostedServer() {
  const env = { ...process.env, NODE_ENV: "production", VERCEL: "1" };
  for (const name of [
    "PREVIEW_DATABASE_URL",
    "PREVIEW_BETTER_AUTH_URL",
    "PREVIEW_BETTER_AUTH_SECRET",
    "DATABASE_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "PGLITE_DATA_DIR",
    "RESEND_API_KEY",
    "AUTH_EMAIL_FROM",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "TWITTER_CLIENT_ID",
    "TWITTER_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
  ])
    delete env[name];
  const child = spawn(process.execPath, [filename, "--serve", apiRuntime.directory], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4000);
  });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Hosted test server did not become ready.")),
      15_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Hosted test server stopped before readiness (${code}). ${diagnostics}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((entry) => entry.startsWith('{"port":'));
      if (!line) return;
      clearTimeout(timer);
      resolveReady(`http://127.0.0.1:${JSON.parse(line).port}`);
    });
  });
  try {
    return { child, baseURL: await ready };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

async function runChecks() {
  // Check the deployed route contract as well as the local equivalent server.
  const config = JSON.parse(await readFile(resolve(project, "vercel.json"), "utf8"));
  assert.equal(config.buildCommand, "npm run build:vercel");
  assert.equal(config.outputDirectory, "site");
  assert.ok(
    config.rewrites?.some((rule) => rule.source === "/login" && rule.destination === "/index.html"),
    "Vercel must serve the SPA on account callback/recovery route /login",
  );
  assert.ok(
    config.rewrites?.some(
      (rule) => rule.source === "/u/:handle" && rule.destination === "/index.html",
    ),
    "Vercel must serve the public creator page entry on /u/:handle",
  );
  assert.ok(
    config.rewrites?.some(
      (rule) => rule.source === ROOT_PROFILE_ROUTE_SOURCE && rule.destination === "/index.html",
    ),
    "Vercel must serve canonical creator IDs without shadowing app or asset paths",
  );
  const { child, baseURL } = await startHostedServer();
  let browser;
  let checks = 0;
  const check = async (name, run) => {
    await run();
    checks++;
    console.log(`PASS ${name}`);
  };
  try {
    await check(
      "hosted plain-Node API reports missing setup without using a local database",
      async () => {
        const response = await fetch(`${baseURL}/api/auth/config`);
        assert.equal(response.status, 200);
        const metadata = await fetch(`${baseURL}/api/deployment`);
        assert.equal(metadata.status, 200);
        assert.deepEqual(await metadata.json(), { preview: false });
        assert.match(metadata.headers.get("cache-control"), /no-store/);
        assert.equal((await fetch(`${baseURL}/api/account/export`)).status, 503);
        assert.match(response.headers.get("cache-control"), /no-store/);
        assert.deepEqual(await response.json(), {
          configured: false,
          emailRecovery: false,
          passkeys: false,
          passkeyOrigin: "http://localhost:8080",
          providers: {
            google: false,
            discord: false,
            twitter: false,
            github: false,
            twitch: false,
          },
          production: true,
          setup: { environment: "preview", database: false, secret: false, origin: false },
        });
      },
    );
    await check(
      "unconfigured hosted accounts and private drafts fail closed with uncached 503",
      async () => {
        for (const pathname of [
          "/api/auth/get-session",
          "/api/profile",
          "/api/profile/publication",
          "/api/public-profiles/hosted-creator",
        ]) {
          const response = await fetch(`${baseURL}${pathname}`);
          assert.equal(response.status, 503, pathname);
          assert.match(response.headers.get("cache-control"), /no-store/);
          assert.equal(typeof (await response.json()).message, "string");
        }
      },
    );
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const providerRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        ["/api/auth/sign-in/social", "/api/auth/link-social"].includes(
          new URL(request.url()).pathname,
        )
      )
        providerRequests.push(request.url());
    });
    await context.route("**/*", (route) => {
      return new URL(route.request().url()).origin === baseURL
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await check(
      "hosted browser bundle renders the dashboard and local profile editor",
      async () => {
        await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
        await page.getByRole("button", { name: "Profile", exact: true }).click();
        await page.getByLabel("Display name", { exact: true }).fill("Hosted creator 🪐");
        await page.getByRole("button", { name: "Save local draft", exact: true }).click();
        assert.equal(
          await page.evaluate(
            () => JSON.parse(localStorage.getItem("fathom.creator-profile.v1")).displayName,
          ),
          "Hosted creator 🪐",
        );
        assert.equal(
          await page.getByRole("button", { name: "Save to account", exact: true }).isDisabled(),
          true,
        );
      },
    );
    await page.getByRole("button", { name: "Open account", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await check("hosted account panel clearly requires setup and disables sign-in", async () => {
      await dialog
        .getByRole("alert")
        .filter({ hasText: /^Account sign-in needs website setup\.$/ })
        .waitFor();
      assert.equal(
        await dialog.getByRole("button", { name: "Sign in", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await dialog
          .getByRole("heading")
          .evaluateAll((headings) =>
            headings.every((heading) => heading.classList.contains("sr-only")),
          ),
        true,
      );
      assert.equal(await dialog.getByRole("combobox").count(), 0);
      assert.equal(
        await dialog
          .locator(".account-heading:visible, .account-intro:visible, .account-divider:visible")
          .count(),
        0,
      );
      assert.equal(
        await dialog
          .getByRole("checkbox", { name: "Remember me in this browser", exact: true })
          .count(),
        1,
      );
    });
    await check(
      "hosted social actions call the real API and explain missing account setup without fake redirects",
      async () => {
        await dialog.locator(".account-provider-options[data-availability='ready']").waitFor();
        assert.equal(
          await dialog.locator(".account-provider[data-provider-action='oauth']").count(),
          5,
        );
        assert.equal(await dialog.locator(".account-provider:disabled").count(), 0);
        assert.equal(await dialog.locator(".account-setup-details").count(), 0);
        assert.equal(
          await dialog.evaluate((root) => {
            const form = root.querySelector(".account-form"),
              links = root.querySelector(".account-form-links"),
              choices = root.querySelector(".account-provider-options");
            return Boolean(
              form &&
              links &&
              choices &&
              form.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING &&
              links.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }),
          true,
          "Hosted social choices follow the credential form and account switches",
        );
        assert.equal(await dialog.locator(".account-provider-info").count(), 0);
        assert.equal(await dialog.getByText("More services", { exact: true }).count(), 0);
        for (const label of ["Bluesky", "Fluxer", "Stoat", "hey.xyz", "Mastodon"])
          assert.equal(await dialog.getByText(label, { exact: true }).count(), 0);
        await dialog.getByLabel("Email address", { exact: true }).fill("preserved@example.com");
        await dialog.getByLabel("Password", { exact: true }).fill("preserved password");
        for (const [provider, label] of [
          ["google", "Google"],
          ["discord", "Discord"],
          ["twitter", "Twitter / X"],
          ["github", "GitHub"],
          ["twitch", "Twitch"],
        ]) {
          const response = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/auth/sign-in/social" &&
              response.request().postDataJSON()?.provider === provider,
          );
          await dialog.getByRole("button", { name: `Continue with ${label}`, exact: true }).click();
          assert.equal((await response).status(), 503);
          await dialog.locator(".account-error[role='alert']").waitFor();
          assert.match(
            await dialog.locator(".account-error[role='alert']").innerText(),
            /account.*setup|website.*setup|not.*configured|authentication.*requires/i,
          );
          assert.equal(page.url(), `${baseURL}/`);
          assert.equal(await dialog.locator(".account-setup-details").count(), 0);
        }
        assert.equal(providerRequests.length, 5);
        const help = dialog.getByRole("button", { name: "Website sign-in setup", exact: true });
        await help.click();
        const details = dialog.locator(".account-setup-details");
        assert.equal(await help.getAttribute("aria-expanded"), "true");
        assert.equal(await details.getAttribute("open"), "");
        assert.equal(await details.locator(".account-service-statuses li").count(), 3);
        assert.equal(providerRequests.length, 5, "Owner diagnostics do not invoke authentication");
        assert.equal(
          await dialog.getByLabel("Email address", { exact: true }).inputValue(),
          "preserved@example.com",
        );
        assert.equal(
          await dialog.getByLabel("Password", { exact: true }).inputValue(),
          "preserved password",
        );
        assert.equal(
          await dialog.getByRole("button", { name: "Sign in with a passkey", exact: true }).count(),
          0,
        );
      },
    );
    await check("direct hosted login route opens the account panel", async () => {
      for (const path of ["/login", "/login/"]) {
        await page.goto(`${baseURL}${path}`, { waitUntil: "networkidle" });
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Continue with Google", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("dialog")
            .getByRole("heading")
            .evaluateAll((headings) =>
              headings.every((heading) => heading.classList.contains("sr-only")),
            ),
          true,
        );
        assert.equal(await page.getByRole("dialog").getByRole("combobox").count(), 0);
      }
    });
    await check("direct hosted password-reset return opens recovery form", async () => {
      await page.goto(`${baseURL}/login?reset=1&token=hosted-test-token`, {
        waitUntil: "networkidle",
      });
      const reset = page.getByRole("dialog");
      await reset.getByRole("heading", { name: "Recover access", exact: true }).waitFor();
      await reset.getByLabel("New password", { exact: false }).waitFor();
      assert.equal(
        await reset.getByRole("button", { name: "Set new password", exact: true }).isDisabled(),
        true,
      );
    });
    await check(
      "hosted public routes distinguish unavailable publishing without loading accounts or drafts",
      async () => {
        const publicPage = await context.newPage();
        const requests = [];
        publicPage.on("pageerror", (error) => errors.push(error.message));
        publicPage.on("request", (request) => {
          const path = new URL(request.url()).pathname;
          if (path.startsWith("/api/")) requests.push(path);
        });
        const localDraft = await page.evaluate(() =>
          localStorage.getItem("fathom.creator-profile.v1"),
        );
        for (const pathname of ["/hosted-creator", "/hosted-creator/", "/u/hosted-creator"]) {
          const [profileResponse] = await Promise.all([
            publicPage.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === "/api/public-profiles/hosted-creator",
            ),
            publicPage.goto(`${baseURL}${pathname}`, {
              waitUntil: "domcontentloaded",
            }),
          ]);
          assert.equal(profileResponse.status(), 503);
          await publicPage
            .getByRole("heading", { name: "Could not load this profile", exact: true })
            .waitFor();
          assert.equal(await publicPage.locator(".sidebar").count(), 0);
          assert.equal(
            await publicPage.getByRole("button", { name: "Try again", exact: true }).count(),
            1,
          );
          assert.equal(
            await publicPage.evaluate(() => localStorage.getItem("fathom.creator-profile.v1")),
            localDraft,
          );
        }
        assert.ok(requests.length > 0);
        assert.ok(
          requests.every((path) =>
            [
              "/api/public-profiles/hosted-creator",
              "/api/creators/hosted-creator/contact",
            ].includes(path),
          ),
        );
        await publicPage.close();
      },
    );
    await check("hosted setup-required state has no browser runtime errors", async () =>
      assert.deepEqual(errors, []),
    );
    console.log(
      `Hosted browser: ${checks} checks passed (production credentials intentionally absent).`,
    );
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      const forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.kill("SIGTERM");
      await stopped;
      clearTimeout(forceStop);
    }
  }
}

if (serving) await serveHostedBuild();
else {
  try {
    await runChecks();
  } finally {
    await apiRuntime.cleanup();
  }
}
