/** Exercise Vercel's framework-free routing detector, without HTTP or credentials.
 * Route phases follow packages/cli/src/util/dev/server.ts in vercel/vercel.
 * This catches deployment routing failures that direct API-handler tests cannot.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { detectBuilders } from "@vercel/fs-detectors";
import { appendRoutesToPhase, getTransformedRoutes } from "@vercel/routing-utils";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("vercel.json", root), "utf8"));
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const apiFiles = (await readdir(new URL("api/", root), { recursive: true }))
  .filter((name) => /\.[cm]?[jt]s$/.test(name))
  .map((name) => `api/${name.replaceAll("\\", "/")}`);
assert.equal(config.framework, null, "This test covers framework-free Vercel functions");

async function routing(files, projectConfig) {
  const detected = await detectBuilders([...files, "package.json"], pkg, {
    functions: projectConfig.functions,
    projectSettings: {
      framework: projectConfig.framework,
      outputDirectory: projectConfig.outputDirectory,
    },
    featHandleMiss: true,
  });
  assert.equal(detected.errors, null);
  const transformed = getTransformedRoutes(projectConfig);
  assert.equal(transformed.error, null);
  // The official CLI appends detected dynamic routes and its API 404 fallback
  // to the filesystem phase after the project's explicit rewrites.
  const routes = [
    ...(detected.redirectRoutes ?? []),
    ...appendRoutesToPhase({
      routes: transformed.routes,
      newRoutes: detected.rewriteRoutes,
      phase: "filesystem",
    }),
    ...(detected.defaultRoutes ?? []),
  ];
  return { detected, routes };
}

// Inspect the official generated rules in order. Direct dispatcher tests alone
// cannot establish that Vercel sends a nested request to the function.
function terminalRule(routes, path, method = "GET") {
  const pathname = new URL(path, "https://routing.example").pathname;
  return routes.find(
    (route) =>
      route.src &&
      !route.continue &&
      (route.dest || route.status) &&
      (!route.methods || route.methods.includes(method)) &&
      new RegExp(route.src).test(pathname),
  );
}

const requests = [
  ["GET", "/api/auth/config"],
  ["POST", "/api/auth/sign-in/social"],
  ["POST", "/api/auth/sign-up/email"],
  ["POST", "/api/auth/two-factor/verify-totp"],
  ["GET", "/api/auth/callback/google?code=fixture&state=fixture"],
  ["POST", "/api/auth/passkey/generate-register-options"],
  ["GET", "/api/profile"],
  ["PUT", "/api/profile"],
  ["GET", "/api/public-profiles/creator"],
  ["POST", "/api/inbox/item/replies"],
  ["GET", "/api/inbox/item"],
  ["POST", "/api/payments/nowpayments/webhook/credential"],
  ["GET", "/api/account/export"],
  ["GET", "/api/account/messages-export"],
  ["GET", "/api/deployment"],
];

const current = await routing(apiFiles, config);
const functions = current.detected.builders.filter((builder) => builder.src?.startsWith("api/"));
assert.deepEqual(
  functions.map((builder) => builder.src),
  ["api/index.ts"],
);
assert.equal(functions[0].use, "@vercel/node");
assert.equal(functions[0].config.zeroConfig, true);
// @vercel/node's zero-config output key removes the source extension:
// packages/node/src/utils.ts, entrypointToOutputPath().
const functionKey = "/api/index";
assert.equal(`/${functions[0].src.slice(0, -3)}`, functionKey);
for (const [method, path] of requests) {
  const rule = terminalRule(current.routes, path, method);
  assert.ok(rule?.dest, `${method} ${path} must reach a function before an API 404`);
  assert.equal(rule.dest.split("?")[0], functionKey, `${method} ${path}`);
}

const pagePaths = [
  "/",
  "/login",
  "/login/reset",
  "/u/creator",
  "/creator-name",
  "/assets/app.js",
  "/favicon.svg",
  "/api-other",
  "/apix/nested",
  "/assets/api/example.js",
];
for (const path of pagePaths)
  assert.notEqual(terminalRule(current.routes, path)?.dest?.split("?")[0], functionKey, path);
for (const path of ["/login", "/u/creator", "/creator-name"])
  assert.equal(terminalRule(current.routes, path)?.dest?.split("?")[0], "/index.html", path);

// Prove this check rejects the former deployment: bracketed function filenames
// match one segment in the official detector, unlike Next.js catch-all routes.
const legacyConfig = {
  ...config,
  rewrites: config.rewrites.filter((rewrite) => !rewrite.source.startsWith("/api")),
};
const legacy = await routing(["api/[...path].ts"], legacyConfig);
assert.equal(terminalRule(legacy.routes, "/api/profile")?.dest?.split("?")[0], "/api/[...path]");
for (const [method, path] of requests.filter(
  ([, path]) => path.split("?")[0].split("/").length > 3,
))
  assert.equal(terminalRule(legacy.routes, path, method)?.status, 404, `Legacy ${method} ${path}`);

console.log(
  `Vercel routing: ${requests.length} API requests and ${pagePaths.length} page/asset paths passed; legacy nested API 404 reproduced.`,
);
