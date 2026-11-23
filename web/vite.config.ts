import { defineConfig } from "vite";
// @ts-expect-error postcss-pxtorem ships no types.
import pxtorem from "postcss-pxtorem";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { agentIconsPlugin } from "./vite.agentIcons";
import { brotliDictionaryPlugin } from "./vite.brotli";
import {
  assetManifestPlugin,
  firstScreenPreloadPlugin,
  vendorChunk,
} from "./vite.chunks";
import { lucideDirectImportsPlugin } from "./vite.lucide";
import { resttyWasmPlugin } from "./vite.restty";

// In dev, the web app talks to the bridge through Vite's proxy so the
// frontend can use a relative /ws URL (same origin, no hardcoded port).
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    agentIconsPlugin(),
    lucideDirectImportsPlugin(),
    resttyWasmPlugin(),
    brotliDictionaryPlugin(),
    assetManifestPlugin(),
    firstScreenPreloadPlugin(),
  ],
  css: {
    postcss: {
      // UI scale: every CSS px length (HeroUI's too) compiles to rem, so the
      // root font size set from --ui-scale in base.css scales the whole UI
      // while client px stay CSS px. Hairlines and media queries stay px, as
      // do the terminal grid and its selection handles, which script sizes
      // in px (the terminal font carries the scale instead).
      plugins: [
        pxtorem({
          propList: ["*"],
          minPixelValue: 2,
          selectorBlackList: [
            /^html$/,
            /\.terminal-engine/,
            /\.terminal-selection-handle/,
          ],
        }),
      ],
    },
  },
  worker: {
    format: "es",
  },
  build: {
    // HeroUI v3 and Tailwind CSS v4 need cascade layers, @property and
    // color-mix(), which set the browser floor.
    target: ["es2022", "edge111", "firefox128", "chrome111", "safari16.4"],
    // The asset check follows static imports from the entry, excluding lazy features.
    manifest: true,
    // Build straight into the server's static dir so the backend can serve it.
    outDir: "../server/public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Group small grammars into lazy chunks to keep expanded highlighting
        // within the embedded server's asset-count budget, and split stable
        // vendor code from app code (see vite.chunks.ts).
        manualChunks(id, meta) {
          const language = id.match(
            /@shikijs\/langs\/dist\/([^/]+)\.mjs$/,
          )?.[1];
          if (!language) return vendorChunk(id, meta);
          if (
            [
              "awk",
              "diff",
              "docker",
              "ini",
              "json5",
              "jsonl",
              "make",
              "nginx",
              "proto",
              "toml",
              "xml",
              "yaml",
            ].includes(language)
          ) {
            return "syntax-config";
          }
          if (
            [
              "clojure",
              "crystal",
              "elixir",
              "elm",
              "erlang",
              "fsharp",
              "groovy",
              "haskell",
              "kotlin",
              "common-lisp",
              "lua",
              "r",
              "scala",
            ].includes(language)
          ) {
            return "syntax-extra";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "http://127.0.0.1:8788", ws: true },
      "/api": { target: "http://127.0.0.1:8788" },
      // Let an unauthenticated dev client reach the bridge login page instead
      // of repeatedly loading the Vite SPA at /login and redirecting again.
      "/login": { target: "http://127.0.0.1:8788" },
    },
  },
});
