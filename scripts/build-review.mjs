import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "review-site");
await build({
  configFile: false,
  root: resolve(root, "review"),
  base: "./",
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { "@": resolve(root, "src") } },
  build: {
    outDir: output,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: { output: { codeSplitting: false } },
  },
});
let html = await readFile(resolve(output, "index.html"), "utf8");
const assets = await readdir(resolve(output, "assets"));
const scripts = assets.filter((name) => name.endsWith(".js"));
if (scripts.length !== 1) throw new Error("Inbox preview must have one JavaScript bundle.");
const script = await readFile(resolve(output, "assets", scripts[0]), "utf8");
const styles = await Promise.all(
  assets
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFile(resolve(output, "assets", name), "utf8")),
);
html = html.replace(
  /<script\b[^>]*src="[^"]+"[^>]*><\/script>/g,
  () => `<script type="module">${script.replace(/<\/script/gi, "<\\/script")}</script>`,
);
html = html.replace(
  /<link\b[^>]*rel="stylesheet"[^>]*>/g,
  () => `<style>${styles.join("\n").replace(/<\/style/gi, "<\\/style")}</style>`,
);
await writeFile(resolve(root, "Fathom-inbox-preview.html"), html);
console.log("Built Fathom-inbox-preview.html: offline inbox with sample data; no deployment.");
