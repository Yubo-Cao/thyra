import { readFile, readdir, stat } from "node:fs/promises";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const publicRoot = fileURLToPath(new URL("../server/public/", import.meta.url));
// Lazy Monaco and voice-capture chunks (worklet, VAD, transport) add files,
// as do per-surface lazy chunks and the small shared chunks Rollup splits
// between them (single lucide icons, ui primitives), plus the stable vendor
// chunks and thyra-assets.json. Grouping the tiny shared chunks would pin
// them (or their dependencies) into the entry; over HTTP/2 they load in
// parallel for a few hundred bytes of headers each.
// The lazy PDF viewer adds its worker, CMaps, standard fonts, and image codecs.
const maxFileCount = 330;
// The lazy Monaco file editor (core, grammars, worker, codicons) adds ~3.5 MiB.
const maxTotalBytes = 20 * 1024 * 1024;
// The entry holds the app shell and switchers (workspace tree, agent list,
// tab bar); React DOM is about 40% of it. Menus, dialogs, pickers and panels
// load on demand (see components/lazyPanels.ts and LazyBoundary.tsx).
const maxInitialJsBytes = 530 * 1024;
const maxInitialJsGzipBytes = 168 * 1024;
// Inline HeroUI component styles and Tailwind utilities (styles/heroui.css);
// overlay styles and feature styles load with their lazy components.
const maxInitialCssBytes = 126 * 1024;
// The first screen also renders the active terminal, whose chunk (xterm.js
// and its eager addons) loads right after the entry. The WebGL renderer
// loads after first output and is not counted.
const firstScreenFeature = "TerminalView";
const maxFirstScreenJsGzipBytes = 315 * 1024;
const maxFirstScreenCssBytes = 143 * 1024;
// The bundled terminal font is sliced into many small unicode-range chunks that
// load on demand (scripts/build-terminal-font.ts); budget it on its own.
const fontDirectory = "assets/fonts";
const maxFontFileCount = 900;
const maxFontBytes = 36 * 1024 * 1024;

/** Follow eager imports only, from app entries or explicitly selected features. */
export function initialAssetFiles(
  manifest,
  entries = Object.keys(manifest).filter((key) => manifest[key].isEntry),
) {
  if (!entries.length) throw new Error("Vite manifest has no entry points");
  const visited = new Set();
  const files = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing Vite manifest chunk: ${key}`);
    visited.add(key);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  for (const entry of entries) visit(entry);
  return [...files];
}

/** Entry points plus the terminal chunk that the first screen always loads. */
export function firstScreenEntries(manifest) {
  const entries = Object.keys(manifest).filter(
    (key) => manifest[key].isEntry || manifest[key].name === firstScreenFeature,
  );
  if (!entries.some((key) => manifest[key].name === firstScreenFeature))
    throw new Error(`Missing Vite feature chunk: ${firstScreenFeature}`);
  return entries;
}

export function assertLazyGrammarAssets(manifest) {
  const grammarFiles = new Set(
    Object.entries(manifest)
      .filter(
        ([key, chunk]) =>
          chunk.name?.startsWith("syntax-") ||
          (key.includes("@shikijs") && key.includes("langs")),
      )
      .map(([, chunk]) => chunk.file),
  );
  for (const name of ["ConfigurationDialog", "WorkspaceInspectorHost"]) {
    const entries = Object.keys(manifest).filter(
      (key) => manifest[key].name === name,
    );
    if (!entries.length) throw new Error(`Missing Vite feature chunk: ${name}`);
    for (const file of initialAssetFiles(manifest, entries)) {
      if (grammarFiles.has(file)) {
        throw new Error(`${name} eagerly loads syntax grammar asset: ${file}`);
      }
    }
  }
}

async function collectAssetStats(root, skip = null) {
  const directories = [root];
  let fileCount = 0;
  let totalBytes = 0;

  while (directories.length) {
    const directory = directories.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (skip && path === `${root}/${skip}`) continue;
        directories.push(path);
        continue;
      }
      const metadata = await stat(path);
      fileCount += 1;
      totalBytes += metadata.size;
    }
  }

  return { fileCount, totalBytes };
}

async function checkAssets() {
  const root = publicRoot.replace(/\/$/, "");
  const { fileCount, totalBytes } = await collectAssetStats(
    root,
    fontDirectory,
  );
  const fonts = await collectAssetStats(`${root}/${fontDirectory}`).catch(
    () => ({ fileCount: 0, totalBytes: 0 }),
  );
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(`${publicRoot}/.vite/manifest.json`, "utf8"),
    );
  } catch (cause) {
    throw new Error(
      "Cannot read the Vite manifest; run the frontend build first",
      { cause },
    );
  }
  assertLazyGrammarAssets(manifest);
  const measure = async (files) => {
    let jsBytes = 0;
    let jsGzipBytes = 0;
    let cssBytes = 0;
    let brotliBytes = 0;
    for (const file of files) {
      const content = await readFile(`${publicRoot}/${file}`);
      // What a phone downloads: the server sends quality-11 Brotli.
      brotliBytes += brotliCompressSync(content, {
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
          [zlib.BROTLI_PARAM_SIZE_HINT]: content.length,
        },
      }).length;
      if (file.endsWith(".js")) {
        jsBytes += content.length;
        jsGzipBytes += gzipSync(content).length;
      } else if (file.endsWith(".css")) {
        cssBytes += content.length;
      }
    }
    return { jsBytes, jsGzipBytes, cssBytes, brotliBytes };
  };
  const initial = await measure(initialAssetFiles(manifest));
  const { jsBytes, jsGzipBytes, cssBytes } = initial;
  const firstScreen = await measure(
    initialAssetFiles(manifest, firstScreenEntries(manifest)),
  );
  // Informational: transfer sizes of the JS+CSS the first screen waits for.
  process.stdout.write(
    `web asset brotli transfer: initial ${(initial.brotliBytes / 1024).toFixed(1)} KiB, first screen ${(firstScreen.brotliBytes / 1024).toFixed(1)} KiB\n`,
  );
  const checks = [
    ["files", fileCount, maxFileCount, 1, "files"],
    ["total", totalBytes, maxTotalBytes, 1024 * 1024, "MiB"],
    ["initial JS", jsBytes, maxInitialJsBytes, 1024, "KiB"],
    ["initial JS gzip", jsGzipBytes, maxInitialJsGzipBytes, 1024, "KiB"],
    ["initial CSS", cssBytes, maxInitialCssBytes, 1024, "KiB"],
    [
      "first screen JS gzip",
      firstScreen.jsGzipBytes,
      maxFirstScreenJsGzipBytes,
      1024,
      "KiB",
    ],
    [
      "first screen CSS",
      firstScreen.cssBytes,
      maxFirstScreenCssBytes,
      1024,
      "KiB",
    ],
    ["font files", fonts.fileCount, maxFontFileCount, 1, "files"],
    ["font total", fonts.totalBytes, maxFontBytes, 1024 * 1024, "MiB"],
  ];
  for (const [name, actual, max, unit, suffix] of checks) {
    const exceeded = actual > max;
    const message = `web asset ${name}: ${(actual / unit).toFixed(1)}/${max / unit} ${suffix}${exceeded ? " (budget exceeded)" : ""}\n`;
    (exceeded ? process.stderr : process.stdout).write(message);
    if (exceeded) process.exitCode = 1;
  }
}

if (import.meta.main) await checkAssets();
