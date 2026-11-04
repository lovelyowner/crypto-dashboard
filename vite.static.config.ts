import { resolve } from "node:path";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(({ mode }) => ({
  base: mode === "hosted" ? "/" : "./",
  resolve: {
    alias: [
      ...(mode === "hosted"
        ? []
        : [
            {
              find: "@/lib/auth/use-current-user",
              replacement: resolve("src/static/guest-user.ts"),
            },
            {
              find: "@/components/account-panel",
              replacement: resolve("src/static/account-panel.tsx"),
            },
          ]),
      { find: "@", replacement: resolve("src") },
    ],
  },
  plugins: [tailwindcss(), viteReact()],
  build: {
    outDir: "site",
    emptyOutDir: true,
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
    rollupOptions: { output: { codeSplitting: false } },
  },
}));
