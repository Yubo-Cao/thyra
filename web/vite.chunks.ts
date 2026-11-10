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
import { DICTIONARY_MODULE_ID } from "./vite.brotli";

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

// React's CommonJS interop helpers stay with React, which must not import
// from the entry chunk that imports it.
const COMMONJS_HELPERS = "\0commonjsHelpers.js";
// Rollup's own name for the chunk of index.html's entry.
const ENTRY_CHUNK = "index";
// The terminal view renders on the first screen, right after the entry.
const FIRST_SCREEN_MODULE = /\/src\/components\/TerminalView\.tsx$/;

function staticClosure(meta: ManualChunkMeta, root: string): Set<string> {
  const closure = new Set<string>();
  const pending = [root];
  while (pending.length) {
    const id = pending.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    pending.push(...(meta.getModuleInfo(id)?.importedIds ?? []));
  }
  return closure;
}

const firstScreenShared = new WeakMap<object, Set<string>>();

/**
 * Modules the terminal view loads statically that a lazy surface may need
 * before the terminal view has loaded (single icons, small hooks and
 * helpers). Rollup gives each its own chunk of a few hundred bytes: over a
 * dozen requests in front of the first terminal output. They always load
 * together there, so they share one chunk instead.
 *
 * Surfaces that are only ever imported by the terminal view's own modules
 * load after it, and what they share with it stays in its chunk, as Rollup
 * has it.
 */
function firstScreenSharedSet(meta: ManualChunkMeta): Set<string> {
  let shared = firstScreenShared.get(meta.getModuleInfo);
  if (shared) return shared;
  shared = new Set();
  firstScreenShared.set(meta.getModuleInfo, shared);
  const ids = [...meta.getModuleIds()];
  const root = ids.find((id) => FIRST_SCREEN_MODULE.test(id));
  if (!root) return shared;
  const eager = eagerSet(meta);
  const view = staticClosure(meta, root);
  for (const id of eager) view.delete(id);
  // Lazily imported modules and the modules that import them.
  const importers = new Map<string, string[]>();
  for (const id of ids) {
    for (const lazy of meta.getModuleInfo(id)?.dynamicallyImportedIds ?? []) {
      if (lazy === root) continue;
      const list = importers.get(lazy);
      if (list) list.push(id);
      else importers.set(lazy, [id]);
    }
  }
  const closures = new Map<string, Set<string>>();
  // Surfaces that only load once the terminal view has: every importer is a
  // module of the view that nothing else loads. Found by iteration, as that
  // depends on which modules are shared.
  const after = new Set<string>();
  for (;;) {
    shared.clear();
    for (const lazy of importers.keys()) {
      if (after.has(lazy)) continue;
      let closure = closures.get(lazy);
      if (!closure) closures.set(lazy, (closure = staticClosure(meta, lazy)));
      for (const id of closure) if (view.has(id)) shared.add(id);
    }
    let changed = false;
    for (const [lazy, from] of importers) {
      if (after.has(lazy)) continue;
      if (from.every((id) => view.has(id) && !shared!.has(id))) {
        after.add(lazy);
        changed = true;
      }
    }
    if (!changed) break;
  }
  shared.delete(root);
  return shared;
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
  // Keeps the engine's own re-exports with the engine; left alone, Rollup
  // merges this tiny module into a chunk the first screen loads statically.
  if (/\/src\/terminalEngineInternals\.ts$/.test(id)) return "vendor-terminal";
  // The WOFF2 decoder's dictionary, loaded only without native Brotli.
  if (id.endsWith(DICTIONARY_MODULE_ID)) return "brotli-dictionary";
  const name = packageName(id);
  if (name) {
    if (REACT_PACKAGES.has(name)) return "vendor-react";
    if (TERMINAL_PACKAGES.has(name)) return "vendor-terminal";
    if (UI_PACKAGE.test(name)) {
      if (eagerSet(meta).has(id)) return "vendor-ui";
      if (ARIA_PACKAGE.test(name)) return "vendor-aria";
    }
  }
  // A manual chunk takes its modules' static dependencies along unless they
  // have a chunk of their own, so the entry's modules are named too: they
  // form the entry chunk either way, and now stay there. This holds only
  // while the entry's static imports are what it really loads: a re-exporting
  // package entry would pin all its modules here (see vite.lucide.ts).
  if (id === COMMONJS_HELPERS) return "vendor-react";
  if (eagerSet(meta).has(id)) return ENTRY_CHUNK;
  return firstScreenSharedSet(meta).has(id) ? "terminal-shared" : undefined;
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
 *   view's static closure, the terminal engine with its Brotli dictionary,
 *   and the font stylesheets and slice manifest);
 * - `precache`: the versioned app shell the service worker keeps ready (the
 *   entry and terminal closures, the terminal engine, the core font stylesheet
 *   with its regular and bold slices, and the slice manifest).
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
      // Browsers without native Brotli fetch the decoder's dictionary.
      const dictionary = findChunk(bundle, (chunk) =>
        chunk.moduleIds.some((id) => id.endsWith(DICTIONARY_MODULE_ID)),
      );
      boot = [
        ...(terminal ? chunkClosure(bundle, terminal.fileName) : []),
        ...(engine ? chunkClosure(bundle, engine.fileName) : []),
        ...(dictionary ? chunkClosure(bundle, dictionary.fileName) : []),
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
        /^\/assets\/fonts\/[^/]+\/fonts-[^/]+\.(?:css|json)$/.test(path),
      );
      const coreFonts = fonts.filter((path) => path.includes("/fonts-core-"));
      const precache = [
        ...shell,
        ...coreFonts,
        // Box drawing, icons and CJK resolve their slices through this.
        ...fonts.filter((path) => path.endsWith(".json")),
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

/** The inline script that starts fetching `files` unless the page is /admin. */
export function firstScreenPreloadScript(files: readonly string[]): string {
  return (
    `if(!/^\\/admin(?:\\/|$)/.test(location.pathname))` +
    `for(const href of ${JSON.stringify(files)}){` +
    `const link=document.createElement("link");` +
    `if(href.endsWith(".css")){link.rel="preload";link.as="style"}` +
    `else link.rel="modulepreload";` +
    `link.crossOrigin="";link.href=href;document.head.append(link)}`
  );
}

/**
 * The entry requests the terminal view only once it runs, a round trip (and
 * the entry's own download and evaluation) after the page. The app document
 * starts those downloads itself, beside the entry's; the admin page, which
 * has no terminal, skips them. The bridge allows the inline script by hash.
 */
export function firstScreenPreloadPlugin(
  bootModule = "/src/components/TerminalView.tsx",
): Plugin {
  const bootName = bootModule.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  return {
    name: "thyra-first-screen-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        if (!bundle) return;
        const terminal = findChunk(
          bundle,
          (chunk) =>
            chunk.name === bootName ||
            chunk.facadeModuleId?.replace(/\\/g, "/").endsWith(bootModule) ===
              true,
        );
        if (!terminal) return;
        const loaded = new Set(
          Object.values(bundle).flatMap((chunk) =>
            chunk.type === "chunk" && chunk.isEntry
              ? chunkClosure(bundle, chunk.fileName)
              : [],
          ),
        );
        const files = chunkClosure(bundle, terminal.fileName).filter(
          (file) => !loaded.has(file),
        );
        if (!files.length) return;
        return [
          {
            tag: "script",
            children: firstScreenPreloadScript(files),
            injectTo: "head",
          },
        ];
      },
    },
  };
}
