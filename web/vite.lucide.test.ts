import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directLucideImports, lucideIconModules } from "./vite.lucide";

const barrel =
  `import * as index from './icons/index.mjs';\nexport { index as icons };\n` +
  `export { default as Eye, default as EyeIcon, default as LucideEye } from './icons/eye.mjs';\n` +
  `export { default as Loader2, default as LoaderCircle } from './icons/loader-circle.mjs';\n` +
  `export { LucideProvider, useLucideContext } from './context.mjs';\n` +
  `export { default as createLucideIcon } from './createLucideIcon.mjs';\n`;

test("icon imports from lucide-react's entry go to the icons' own modules", () => {
  const modules = lucideIconModules(barrel);
  expect(modules.get("EyeIcon")).toBe("./icons/eye.mjs");
  expect(modules.get("Loader2")).toBe("./icons/loader-circle.mjs");
  expect(modules.has("LucideProvider")).toBe(false);
  const rewrite = (code: string) =>
    directLucideImports(code, modules, (path) => `/lucide/${path.slice(2)}`);
  expect(
    rewrite(
      `import { Eye, Loader2 as Spinner } from "lucide-react";\nconst a = <Eye />;`,
    ),
  ).toBe(
    `import Eye from "/lucide/icons/eye.mjs";import Spinner from "/lucide/icons/loader-circle.mjs";\nconst a = <Eye />;`,
  );
  // What the entry defines itself, or this map does not know, stays.
  expect(
    rewrite(
      `import {\n  Eye,\n  LucideProvider,\n  Unknown,\n} from 'lucide-react'`,
    ),
  ).toBe(
    `import Eye from "/lucide/icons/eye.mjs";import { LucideProvider, Unknown } from "lucide-react";`,
  );
  expect(rewrite(`import { LucideProvider } from "lucide-react";`)).toBeNull();
  expect(rewrite(`import { Eye } from "other";`)).toBeNull();
  // Not yet compiled TypeScript is left for the entry to resolve.
  expect(rewrite(`import { Eye, type LucideIcon } from "lucide-react";`)).toBe(
    null,
  );
});

test("the installed lucide-react re-exports every icon the app imports", () => {
  const root = fileURLToPath(import.meta.resolve("lucide-react")).replace(
    /([/\\]node_modules[/\\]lucide-react)[/\\].*$/,
    "$1",
  );
  const { module: entry } = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as { module: string };
  const modules = lucideIconModules(readFileSync(resolve(root, entry), "utf8"));
  expect(modules.size).toBeGreaterThan(1000);
  for (const name of ["Bot", "Eye", "LoaderCircle", "Maximize2"])
    expect(modules.get(name)).toMatch(/^\.\/icons\/[\w-]+\.mjs$/);
  expect(dirname(resolve(root, entry))).toContain("lucide-react");
});
