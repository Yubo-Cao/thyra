import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { DICTIONARY_MODULE_ID } from "./vite.brotli";
import {
  assetManifestPlugin,
  coreFontFiles,
  firstScreenPreloadPlugin,
  firstScreenPreloadScript,
  packageName,
  vendorChunk,
} from "./vite.chunks";

const store = "/repo/node_modules/.bun";

test("package names resolve through Bun's isolated store", () => {
  expect(
    packageName(
      `${store}/react-dom@19.2.0/node_modules/react-dom/cjs/react-dom-client.production.js`,
    ),
  ).toBe("react-dom");
  expect(
    packageName(
      `${store}/@radix-ui+react-popover@1.1.0/node_modules/@radix-ui/react-popover/dist/index.mjs`,
    ),
  ).toBe("@radix-ui/react-popover");
  expect(packageName("/repo/web/src/App.tsx")).toBeNull();
});

function graph(
  modules: Record<
    string,
    { entry?: boolean; imports: string[]; lazy?: string[] }
  >,
) {
  return {
    getModuleIds: () => Object.keys(modules)[Symbol.iterator](),
    getModuleInfo: (id: string) =>
      modules[id]
        ? {
            isEntry: Boolean(modules[id].entry),
            importedIds: modules[id].imports,
            dynamicallyImportedIds: modules[id].lazy ?? [],
          }
        : null,
  } as never;
}

test("vendor groups keep lazy-only UI code out of the initial chunk", () => {
  const eagerUi = `${store}/@floating-ui+dom/node_modules/@floating-ui/dom/dist/index.mjs`;
  const lazyUi = `${store}/@heroui+react/node_modules/@heroui/react/dist/index.mjs`;
  const react = `${store}/react/node_modules/react/index.js`;
  const engine = `${store}/restty@0.3.0/node_modules/restty/dist/chunk-c0rcpsc5.js`;
  const meta = graph({
    "/repo/web/src/main.tsx": { entry: true, imports: [eagerUi, react] },
    "/repo/web/src/components/TerminalView.tsx": { imports: [engine] },
    [eagerUi]: { imports: [react] },
    [lazyUi]: { imports: [react] },
    [react]: { imports: [] },
    [engine]: { imports: [] },
  });
  expect(vendorChunk(react, meta)).toBe("vendor-react");
  expect(vendorChunk(eagerUi, meta)).toBe("vendor-ui");
  expect(vendorChunk(lazyUi, meta)).toBeUndefined();
  expect(vendorChunk(engine, meta)).toBe("vendor-terminal");
  expect(vendorChunk("/repo/web/src/App.tsx", meta)).toBeUndefined();
});

test("small modules the terminal view shares with lazy surfaces take one chunk", () => {
  const src = "/repo/web/src";
  const react = `${store}/react/node_modules/react/index.js`;
  const icon = `${store}/lucide-react/node_modules/lucide-react/dist/esm/icons/eye.mjs`;
  const meta = graph({
    [`${src}/main.tsx`]: {
      entry: true,
      imports: [react, `${src}/store.ts`],
      lazy: [`${src}/components/TerminalView.tsx`, `${src}/Dialog.tsx`],
    },
    [`${src}/store.ts`]: { imports: [] },
    [`${src}/components/TerminalView.tsx`]: {
      imports: [
        react,
        `${src}/store.ts`,
        `${src}/session.ts`,
        `${src}/draft.ts`,
        `${src}/gestures.ts`,
        icon,
      ],
      lazy: [`${src}/History.tsx`],
    },
    // Only the terminal view's own modules import this surface.
    [`${src}/History.tsx`]: { imports: [`${src}/session.ts`, react] },
    [`${src}/session.ts`]: { imports: [`${src}/store.ts`] },
    // The entry can open this one before the terminal view has loaded.
    [`${src}/Dialog.tsx`]: {
      imports: [`${src}/draft.ts`, icon, react],
      lazy: [`${src}/Nested.tsx`],
    },
    [`${src}/draft.ts`]: { imports: [`${src}/store.ts`] },
    [`${src}/Nested.tsx`]: { imports: [`${src}/gestures.ts`] },
    [`${src}/gestures.ts`]: { imports: [] },
    [`${src}/Dialog.css`]: { imports: [] },
    [icon]: { imports: [react] },
    [react]: { imports: [] },
  });
  const chunk = (id: string) => vendorChunk(id, meta);
  expect(chunk(`${src}/draft.ts`)).toBe("terminal-shared");
  expect(chunk(`${src}/gestures.ts`)).toBe("terminal-shared");
  expect(chunk(icon)).toBe("terminal-shared");
  // Rollup keeps these where they are.
  expect(chunk(`${src}/components/TerminalView.tsx`)).toBeUndefined();
  expect(chunk(`${src}/session.ts`)).toBeUndefined();
  expect(chunk(`${src}/History.tsx`)).toBeUndefined();
  expect(chunk(`${src}/Dialog.tsx`)).toBeUndefined();
  // The entry's modules are named, so no manual chunk takes them along.
  expect(chunk(`${src}/main.tsx`)).toBe("index");
  expect(chunk(`${src}/store.ts`)).toBe("index");
  expect(chunk("\0commonjsHelpers.js")).toBe("vendor-react");
  expect(chunk(`\0${DICTIONARY_MODULE_ID}`)).toBe("brotli-dictionary");
});

test("the app document preloads the terminal view, but not on the admin page", () => {
  const files = ["/assets/TerminalView-a.js", "/assets/TerminalView-b.css"];
  const links = (pathname: string) => {
    const added: Record<string, string>[] = [];
    runInNewContext(firstScreenPreloadScript(files), {
      location: { pathname },
      document: {
        createElement: () => ({}),
        head: { append: (link: Record<string, string>) => added.push(link) },
      },
    });
    return added;
  };
  expect(links("/")).toEqual([
    { rel: "modulepreload", crossOrigin: "", href: files[0]! },
    { rel: "preload", as: "style", crossOrigin: "", href: files[1]! },
  ]);
  expect(links("/admin")).toEqual([]);
  expect(links("/admin/users")).toEqual([]);
  expect(links("/administrator")).toHaveLength(2);

  const chunk = (fileName: string, extra: object) => ({
    type: "chunk",
    fileName,
    imports: [],
    viteMetadata: { importedCss: new Set<string>() },
    ...extra,
  });
  const plugin = firstScreenPreloadPlugin() as unknown as {
    transformIndexHtml: {
      handler: (
        html: string,
        context: object,
      ) => { tag: string; children: string }[] | undefined;
    };
  };
  const tags = plugin.transformIndexHtml.handler("", {
    bundle: {
      "assets/index.js": chunk("assets/index.js", {
        isEntry: true,
        imports: ["assets/react.js"],
      }),
      "assets/react.js": chunk("assets/react.js", {}),
      "assets/TerminalView.js": chunk("assets/TerminalView.js", {
        name: "TerminalView",
        imports: ["assets/react.js", "assets/shared.js"],
        viteMetadata: { importedCss: new Set(["assets/TerminalView.css"]) },
      }),
      "assets/shared.js": chunk("assets/shared.js", {}),
    },
  });
  expect(tags).toEqual([
    {
      tag: "script",
      children: firstScreenPreloadScript([
        "/assets/TerminalView.js",
        "/assets/TerminalView.css",
        "/assets/shared.js",
      ]),
      injectTo: "head",
    },
  ]);
  expect(plugin.transformIndexHtml.handler("", {})).toBeUndefined();
});

test("precaching takes the upright regular and bold core font slices", () => {
  const face = (file: string, style: string, weight: number) =>
    `@font-face{font-family:"Thyra Mono";src:url("/assets/fonts/m/${file}.woff2")format("woff2");font-style:${style};font-display:swap;font-weight:${weight};unicode-range:U+20-7E;}`;
  expect(
    coreFontFiles(
      face("a", "normal", 400) +
        face("b", "normal", 700) +
        face("c", "italic", 400) +
        face("d", "normal", 300),
    ),
  ).toEqual(["/assets/fonts/m/a.woff2", "/assets/fonts/m/b.woff2"]);
});

test("the asset manifest drops stale chunks left by another build", () => {
  const root = mkdtempSync(join(tmpdir(), "thyra-assets-"));
  const out = join(root, "out");
  const pub = join(root, "public");
  mkdirSync(join(out, "assets"), { recursive: true });
  mkdirSync(join(pub, "assets"), { recursive: true });
  for (const file of ["new-A.js", "old-B.js", "static.txt"])
    writeFileSync(join(out, "assets", file), "x");
  const fonts = join(out, "assets", "fonts", "m");
  mkdirSync(fonts, { recursive: true });
  for (const file of ["fonts-core-1.css", "fonts-2.css", "fonts-3.json"]) {
    mkdirSync(join(pub, "assets", "fonts", "m"), { recursive: true });
    writeFileSync(join(pub, "assets", "fonts", "m", file), "");
    writeFileSync(join(fonts, file), "");
  }
  writeFileSync(join(pub, "assets", "static.txt"), "x");
  const plugin = assetManifestPlugin() as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  plugin.configResolved({ root, build: { outDir: "out" }, publicDir: pub });
  plugin.generateBundle({}, { "assets/new-A.js": {} });
  plugin.closeBundle();
  expect(existsSync(join(out, "assets", "new-A.js"))).toBe(true);
  expect(existsSync(join(out, "assets", "static.txt"))).toBe(true);
  expect(existsSync(join(out, "assets", "old-B.js"))).toBe(false);
  // The server compresses every font stylesheet and the slice manifest ahead
  // of time; the worker keeps the core stylesheet and the manifest ready.
  const manifest = JSON.parse(
    readFileSync(join(out, "thyra-assets.json"), "utf8"),
  ) as { boot: string[]; precache: string[] };
  expect(manifest.boot).toEqual([
    "/assets/fonts/m/fonts-2.css",
    "/assets/fonts/m/fonts-3.json",
    "/assets/fonts/m/fonts-core-1.css",
  ]);
  expect(manifest.precache).toEqual([
    "/assets/fonts/m/fonts-core-1.css",
    "/assets/fonts/m/fonts-3.json",
  ]);
});
