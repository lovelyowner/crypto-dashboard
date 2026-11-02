import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const directory = "site";
let html = await readFile(join(directory, "index.html"), "utf8");
const assets = await readdir(join(directory, "assets"));
const scripts = assets.filter((name) => name.endsWith(".js"));
if (scripts.length !== 1)
  throw new Error("Standalone build must have exactly one JavaScript bundle.");
html = html.replace(
  /<script\b[^>]*src="[^"]+"[^>]*><\/script>/g,
  () => '<script type="module">\n' + "__FATHOM_SCRIPT__" + "\n</script>",
);
const css = await Promise.all(
  assets
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFile(join(directory, "assets", name), "utf8")),
);
html = html.replace(
  /<link\b[^>]*rel="stylesheet"[^>]*>/g,
  () => "<style>" + css.join("\n").replaceAll("</style", "<\\/style") + "</style>",
);
const icon = await readFile(join(directory, "favicon.svg"), "utf8");
html = html.replace(
  /href="\.\/favicon\.svg"/,
  'href="data:image/svg+xml,' + encodeURIComponent(icon) + '"',
);
const script = await readFile(join(directory, "assets", scripts[0]), "utf8");
html = html.replace("__FATHOM_SCRIPT__", () => script.replaceAll("</script", "<\\/script"));
await writeFile("Fathom.html", html);
await writeFile(
  join(directory, "_headers"),
  `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`,
);
await writeFile(join(directory, "_redirects"), `/* /index.html 200\n`);
console.log("Built site/ for HTTPS hosting and Fathom.html for direct browser opening.");
