import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin, Rollup } from "vite";

type ManualChunkMeta = Rollup.ManualChunkMeta;
type OutputBundle = Rollup.OutputBundle;

/** npm package that owns a module id, including Bun's isolated store layout. */
export function packageName(id: string): string | null {
  return (
    id
      .match(/.*[/\\]node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/)?.[1]
      ?.replace(/\\/g, "/") ?? null
  );
}

// Long-lived vendor code gets its own chunks, so an app-only update does not
// re-download it on a slow link. Groups are ordered by how rarely they change.
const REACT_PACKAGES = new Set(["react", "react-dom", "scheduler"]);
// The GPU terminal engine (WASM core, renderer, text shaper) loads lazily
// after the terminal view.
const TERMINAL_PACKAGES = new Set(["restty", "text-shaper"]);
const UI_PACKAGE =
  /^(?:@floating-ui\/.+|tslib|@heroui\/.+|react-aria|react-aria-components|react-stately|@react-aria\/.+|@react-stately\/.+|@react-types\/.+|@internationalized\/.+|@swc\/helpers|tailwind-variants|tailwind-merge|clsx|client-only)$/;

// React Aria is large and shared by every lazily loaded overlay; outside the
// entry it gets one lazy chunk of its own so overlay code changes do not
// re-download it.
const ARIA_PACKAGE =
  /^(?:react-aria|react-aria-components|react-stately|@react-aria\/.+|@react-stately\/.+|@react-types\/.+|@internationalized\/.+)$/;

const eagerModules = new WeakMap<object, Set<string>>();

/** Modules reachable from an entry through static imports only. */
function eagerSet(meta: ManualChunkMeta): Set<string> {
  let eager = eagerModules.get(meta.getModuleInfo);
  if (eager) return eager;
  eager = new Set();
  const pending: string[] = [];
  for (const id of meta.getModuleIds()) {
    if (meta.getModuleInfo(id)?.isEntry) pending.push(id);
  }
  while (pending.length) {
    const id = pending.pop()!;
    if (eager.has(id)) continue;
    eager.add(id);
    pending.push(...(meta.getModuleInfo(id)?.importedIds ?? []));
  }
  eagerModules.set(meta.getModuleInfo, eager);
  return eager;
}

/**
 * Vendor chunk for a module, or undefined to let Rollup decide. UI libraries
 * are grouped into `vendor-ui` only where the entry already loads them, so a
 * component used only by a lazy dialog never joins the initial download.
 */
export function vendorChunk(
  id: string,
  meta: ManualChunkMeta,
): string | undefined {
  const name = packageName(id);
  if (!name) return undefined;
  if (REACT_PACKAGES.has(name)) return "vendor-react";
  if (TERMINAL_PACKAGES.has(name)) return "vendor-terminal";
  if (!UI_PACKAGE.test(name)) return undefined;
  if (eagerSet(meta).has(id)) return "vendor-ui";
  return ARIA_PACKAGE.test(name) ? "vendor-aria" : undefined;
}

/** Static JS and CSS closure of a chunk, as root-relative URLs. */
export function chunkClosure(bundle: OutputBundle, fileName: string): string[] {
  const files = new Set<string>();
  const visit = (name: string) => {
    const chunk = bundle[name];
    if (!chunk || chunk.type !== "chunk" || files.has(`/${name}`)) return;
    files.add(`/${name}`);
    for (const css of chunk.viteMetadata?.importedCss ?? []) {
      files.add(`/${css}`);
    }
    for (const dependency of chunk.imports) visit(dependency);
  };
  visit(fileName);
  return [...files];
}

function listFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else files.push(`/${relative(root, path).split(sep).join("/")}`);
  }
  return files;
}

/**
 * Upright regular and bold font files a core terminal font stylesheet
 * declares: the ASCII, Latin-1 and Powerline glyphs of nearly every terminal
 * screen (prompts and TUIs use bold). Italic slices are cached on first use.
 */
export function coreFontFiles(css: string): string[] {
  const files: string[] = [];
  for (const [block] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    if (!/font-style:\s*normal/.test(block)) continue;
    if (!/font-weight:\s*(?:400|700)\b/.test(block)) continue;
    const url = block.match(/url\(\s*"?(\/assets\/[^")\s]+)"?\s*\)/)?.[1];
    if (url) files.push(url);
  }
  return files;
}

function findChunk(
  bundle: OutputBundle,
  matches: (chunk: Rollup.OutputChunk) => boolean,
): Rollup.OutputChunk | undefined {
  for (const chunk of Object.values(bundle)) {
    if (chunk.type === "chunk" && matches(chunk)) return chunk;
  }
  return undefined;
}

/**
 * Write `thyra-assets.json`:
 * - `assets`: every fingerprinted file under /assets (the service worker
 *   drops cached files that no recent build lists);
 * - `boot`: what the server compresses before the first request (the terminal
 *   view's static closure, the terminal engine and the font stylesheets);
 * - `precache`: the versioned app shell the service worker keeps ready (the
 *   entry and terminal closures, the terminal engine, the core font stylesheet
 *   and its regular and bold slices).
 */
export function assetManifestPlugin(
  bootModule = "/src/components/TerminalView.tsx",
): Plugin {
  let outDir = "";
  let publicDir: string | false = false;
  let emitted = new Set<string>();
  let boot: string[] = [];
  let shell: string[] = [];
  const bootName = bootModule.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  return {
    name: "thyra-asset-manifest",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      emitted = new Set(Object.keys(bundle));
      // The terminal view may share its chunk with other modules, so it is
      // found by chunk name as well as by facade module.
      const terminal = findChunk(
        bundle,
        (chunk) =>
          chunk.name === bootName ||
          chunk.facadeModuleId?.replace(/\\/g, "/").endsWith(bootModule) ===
            true,
      );
      const engine = findChunk(bundle, (chunk) =>
        chunk.moduleIds.some((id) => /[/\\]restty[/\\]/.test(id)),
      );
      // The engine's WASM core is an asset the engine fetches itself.
      const core = Object.values(bundle).find(
        (file) => file.type === "asset" && file.fileName.endsWith(".wasm"),
      );
      boot = [
        ...(terminal ? chunkClosure(bundle, terminal.fileName) : []),
        ...(engine ? chunkClosure(bundle, engine.fileName) : []),
        ...(core ? [`/${core.fileName}`] : []),
      ];
      shell = [
        ...Object.values(bundle).flatMap((chunk) =>
          chunk.type === "chunk" && chunk.isEntry
            ? chunkClosure(bundle, chunk.fileName)
            : [],
        ),
        ...boot,
      ];
    },
    closeBundle() {
      // Another build into the same directory can leave its fingerprinted
      // chunks behind; they would be listed here and embedded in the binary.
      for (const path of listFiles(outDir, join(outDir, "assets"))) {
        const name = path.slice(1);
        if (emitted.has(name)) continue;
        if (publicDir && existsSync(join(publicDir, name))) continue;
        rmSync(join(outDir, name), { force: true });
      }
      const assets = listFiles(outDir, join(outDir, "assets")).sort();
      const listed = new Set(assets);
      const fonts = assets.filter((path) =>
        /^\/assets\/fonts\/[^/]+\/fonts-[^/]+\.css$/.test(path),
      );
      const coreFonts = fonts.filter((path) => path.includes("/fonts-core-"));
      const precache = [
        ...shell,
        ...coreFonts,
        ...coreFonts.flatMap((path) =>
          coreFontFiles(readFileSync(join(outDir, path), "utf8")),
        ),
      ].filter((path) => listed.has(path));
      const version = createHash("sha256")
        .update(assets.join("\n"))
        .digest("hex")
        .slice(0, 16);
      writeFileSync(
        join(outDir, "thyra-assets.json"),
        JSON.stringify({
          version,
          boot: [...new Set([...boot, ...fonts])],
          precache: [...new Set(precache)],
          assets,
        }),
      );
    },
  };
}
