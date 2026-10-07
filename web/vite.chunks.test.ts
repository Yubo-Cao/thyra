import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetManifestPlugin,
  coreFontFiles,
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
  modules: Record<string, { entry?: boolean; imports: string[] }>,
) {
  return {
    getModuleIds: () => Object.keys(modules)[Symbol.iterator](),
    getModuleInfo: (id: string) =>
      modules[id]
        ? {
            isEntry: Boolean(modules[id].entry),
            importedIds: modules[id].imports,
          }
        : null,
  } as never;
}

test("vendor groups keep lazy-only UI code out of the initial chunk", () => {
  const eagerUi = `${store}/@floating-ui+dom/node_modules/@floating-ui/dom/dist/index.mjs`;
  const lazyUi = `${store}/@heroui+react/node_modules/@heroui/react/dist/index.mjs`;
  const react = `${store}/react/node_modules/react/index.js`;
  const xterm = `${store}/@xterm+xterm/node_modules/@xterm/xterm/lib/xterm.mjs`;
  const webgl = `${store}/@xterm+addon-webgl/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs`;
  const meta = graph({
    "/repo/web/src/main.tsx": { entry: true, imports: [eagerUi, react] },
    "/repo/web/src/components/TerminalView.tsx": { imports: [xterm] },
    [eagerUi]: { imports: [react] },
    [lazyUi]: { imports: [react] },
    [react]: { imports: [] },
    [xterm]: { imports: [] },
    [webgl]: { imports: [] },
  });
  expect(vendorChunk(react, meta)).toBe("vendor-react");
  expect(vendorChunk(eagerUi, meta)).toBe("vendor-ui");
  expect(vendorChunk(lazyUi, meta)).toBeUndefined();
  expect(vendorChunk(xterm, meta)).toBe("vendor-xterm");
  expect(vendorChunk(webgl, meta)).toBeUndefined();
  expect(vendorChunk("/repo/web/src/App.tsx", meta)).toBeUndefined();
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
});
