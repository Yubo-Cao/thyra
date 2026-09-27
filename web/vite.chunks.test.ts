import { expect, test } from "bun:test";
import { packageName, vendorChunk } from "./vite.chunks";

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
  const eagerUi = `${store}/@radix-ui+react-dialog/node_modules/@radix-ui/react-dialog/dist/index.mjs`;
  const lazyUi = `${store}/@radix-ui+react-avatar/node_modules/@radix-ui/react-avatar/dist/index.mjs`;
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
