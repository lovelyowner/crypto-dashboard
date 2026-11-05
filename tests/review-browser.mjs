import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";

const html = await readFile(resolve("Fathom-inbox-preview.html"), "utf8");
assert.ok(!/<script\b[^>]*src=/i.test(html));
assert.ok(!/<link\b[^>]*rel="stylesheet"/i.test(html));
// Managed Chromium blocks file: navigation; serve the same self-contained HTML locally.
const server = createServer((request, response) => {
  response.writeHead(request.url === "/" ? 200 : 404, { "Content-Type": "text/html" });
  response.end(request.url === "/" ? html : "");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const errors = [];
const externalRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin)
    externalRequests.push(request.url());
  if (new URL(request.url()).pathname.startsWith("/api/")) externalRequests.push(request.url());
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        window.previewClipboard = text;
      },
    },
  });
});
const inbox = page.getByRole("region", { name: "Private creator inbox" });
const collaboration = inbox
  .locator(".creator-inbox-row")
  .filter({ hasText: "Sample collaboration question:" });
const feedback = inbox
  .locator(".creator-inbox-row")
  .filter({ hasText: "Sample creator reply: yes" });
const reply = inbox.getByLabel("Private reply", { exact: true });
const back = inbox.getByRole("button", { name: "Messages", exact: true });
try {
  await page.goto(origin);
  await page.getByRole("heading", { name: "Inbox preview · Sample data" }).waitFor();
  await collaboration.waitFor();
  await context.setOffline(true);
  assert.equal(await inbox.locator(".creator-inbox-row").count(), 2);
  const search = inbox.getByRole("searchbox", { name: "Search loaded conversations", exact: true });
  await search.fill("SAMPLE CREATOR REPLY");
  assert.equal(await inbox.locator(".creator-inbox-row").count(), 1);
  await inbox.getByRole("checkbox", { name: "Unread only", exact: true }).check();
  await inbox
    .getByRole("heading", { name: "No matching loaded conversations", exact: true })
    .waitFor();
  await inbox.getByRole("button", { name: "Reset filters", exact: true }).click();
  assert.equal(await inbox.locator(".creator-inbox-row").count(), 2);
  await collaboration.click();
  await reply.fill("Unsent preview draft 🌙");
  await search.fill("no matching sample");
  assert.equal(await inbox.locator(".creator-inbox-row").count(), 0);
  assert.equal(await reply.inputValue(), "Unsent preview draft 🌙");
  await inbox.getByRole("button", { name: "Reset filters", exact: true }).click();
  await inbox.getByRole("button", { name: "Copy conversation", exact: true }).click();
  const copied = await page.evaluate(() => window.previewClipboard);
  assert.ok(copied.includes("Sample collaboration question:"));
  assert.ok(!copied.includes("Unsent preview draft"));
  assert.ok(!copied.includes("Sample feedback:"));
  const safety = inbox.locator("details.conversation-moderation");
  await safety.locator("summary").click();
  await safety.getByRole("button", { name: "Block account", exact: true }).click();
  await safety.getByRole("button", { name: "Confirm block", exact: true }).click();
  assert.equal(await reply.inputValue(), "Unsent preview draft 🌙");
  assert.equal(
    await inbox.getByRole("button", { name: "Send reply", exact: true }).isDisabled(),
    true,
  );
  await safety.getByRole("button", { name: "Unblock account", exact: true }).click();
  await safety.getByRole("button", { name: "Confirm unblock", exact: true }).click();
  await safety.getByRole("button", { name: "Report conversation", exact: true }).click();
  await safety.getByLabel("Details (optional)", { exact: true }).fill("Sample-only report.");
  await safety.getByRole("button", { name: "Save report", exact: true }).click();
  await safety.getByRole("status").filter({ hasText: "Report saved." }).waitFor();
  await back.click();
  await feedback.click();
  assert.equal(await reply.inputValue(), "");
  await reply.fill("Another preview draft");
  await back.click();
  await collaboration.click();
  assert.equal(await reply.inputValue(), "Unsent preview draft 🌙");
  await inbox.getByRole("button", { name: "Discard draft", exact: true }).click();
  assert.equal(await reply.inputValue(), "");
  await reply.fill("A reply sent only inside this sample");
  await inbox.getByRole("button", { name: "Send reply", exact: true }).click();
  await inbox
    .locator(".creator-inbox-transcript")
    .getByText("A reply sent only inside this sample", { exact: true })
    .waitFor();
  assert.equal(await reply.inputValue(), "");
  await back.click();
  await page.getByRole("button", { name: "Add sample reply", exact: true }).click();
  await inbox.locator(".creator-inbox-row").filter({ hasText: "Sample incoming reply" }).waitFor();
  assert.equal(
    await inbox.locator(".creator-inbox-row").first().getByText("Unread", { exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "Sender view", exact: true }).click();
  await inbox.getByRole("tab", { name: "Sent", exact: true }).click();
  await inbox.locator(".creator-inbox-row").first().waitFor();
  assert.equal(await inbox.locator(".creator-inbox-row").count(), 2);
  await page.getByRole("button", { name: "Creator view", exact: true }).click();
  await inbox.getByRole("tab", { name: "Donation notes", exact: true }).click();
  await inbox.locator(".creator-inbox-row").getByText("Anonymous", { exact: true }).waitFor();
  await inbox.locator(".creator-inbox-row").click();
  await inbox
    .getByText("Anonymous notes do not identify an account and cannot receive replies.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await reply.count(), 0);
  await page.getByRole("button", { name: "Preview error state", exact: true }).click();
  await page.getByRole("heading", { name: "Something went wrong", exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: "dark" });
  const errorPalette = await page
    .locator(".app-error")
    .evaluate((element) => [
      getComputedStyle(element).backgroundColor,
      getComputedStyle(element.querySelector("h1")).color,
      getComputedStyle(element.querySelector("p")).color,
      getComputedStyle(element.querySelector("svg")).color,
    ]);
  assert.deepEqual(errorPalette, [
    "rgb(255, 255, 255)",
    "rgb(51, 51, 51)",
    "rgb(102, 102, 102)",
    "rgb(153, 153, 153)",
  ]);
  await page.getByRole("button", { name: "Return to inbox preview", exact: true }).click();
  await inbox.getByRole("checkbox", { name: "Unread only", exact: true }).check();
  const checkboxPalette = await inbox
    .getByRole("checkbox", { name: "Unread only", exact: true })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.borderTopColor, style.appearance, style.backgroundImage];
    });
  assert.deepEqual(checkboxPalette.slice(0, 3), [
    "rgb(255, 255, 255)",
    "rgb(204, 204, 204)",
    "none",
  ]);
  assert.ok(checkboxPalette[3].includes("%23999"));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS offline inbox preview: block/report, inbox flows, exact grayscale controls and error state in dark mode, mobile fit, and no external requests.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
