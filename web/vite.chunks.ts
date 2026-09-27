import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
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
// The terminal needs xterm with these addons; the WebGL addon stays a separate
// lazy chunk because it is optional.
const XTERM_PACKAGES = new Set([
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-unicode-graphemes",
  "@xterm/addon-clipboard",
]);
const UI_PACKAGE =
  /^(?:@radix-ui\/.+|@floating-ui\/.+|cmdk|react-remove-scroll(?:-bar)?|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden|detect-node-es|get-nonce|tslib|@heroui\/.+|react-aria|react-aria-components|react-stately|@react-aria\/.+|@react-stately\/.+|@react-types\/.+|@internationalized\/.+|@swc\/helpers|tailwind-variants|tailwind-merge|clsx|client-only)$/;

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
  if (XTERM_PACKAGES.has(name)) return "vendor-xterm";
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
 * Write `thyra-assets.json`: every fingerprinted file under /assets (the
 * service worker drops cached files that are not listed) and the boot list
 * the server compresses ahead of the first request (the terminal view's
 * static closure and the terminal font stylesheet).
 */
export function assetManifestPlugin(
  bootModule = "/src/components/TerminalView.tsx",
): Plugin {
  let outDir = "";
  let boot: string[] = [];
  return {
    name: "thyra-asset-manifest",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      const terminal = Object.values(bundle).find(
        (chunk) =>
          chunk.type === "chunk" &&
          chunk.facadeModuleId?.replace(/\\/g, "/").endsWith(bootModule),
      );
      boot = terminal ? chunkClosure(bundle, terminal.fileName) : [];
    },
    closeBundle() {
      const assets = listFiles(outDir, join(outDir, "assets")).sort();
      const fonts = assets.filter((path) =>
        /^\/assets\/fonts\/[^/]+\/fonts-[^/]+\.css$/.test(path),
      );
      const version = createHash("sha256")
        .update(assets.join("\n"))
        .digest("hex")
        .slice(0, 16);
      writeFileSync(
        join(outDir, "thyra-assets.json"),
        JSON.stringify({ version, boot: [...boot, ...fonts], assets }),
      );
    },
  };
}
