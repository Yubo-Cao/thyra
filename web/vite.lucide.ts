import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// `lucide-react`'s entry re-exports every icon from its own module. Rollup
// drops the unused ones either way, but the module graph still says that
// whoever imports the entry imports them all, and vite.chunks.ts reads that
// graph to tell which modules the app entry loads. The build imports each
// icon from its module instead, which is what the entry does for it.

const BARREL_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])lucide-react\2;?/g;
const DEFAULT_REEXPORT = /export\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g;

/** Export name to module path, for the entry's `default as Name` re-exports. */
export function lucideIconModules(barrel: string): Map<string, string> {
  const modules = new Map<string, string>();
  for (const [, names, path] of barrel.matchAll(DEFAULT_REEXPORT)) {
    for (const name of names!.split(",")) {
      const exported = name.trim().match(/^default\s+as\s+([\w$]+)$/)?.[1];
      if (exported) modules.set(exported, path!);
    }
  }
  return modules;
}

/**
 * `code` with named `lucide-react` imports of icons replaced by default
 * imports of `resolveIcon(path)`, or null when there is nothing to replace.
 * Names the entry does not re-export from an icon module stay as they were.
 */
export function directLucideImports(
  code: string,
  modules: ReadonlyMap<string, string>,
  resolveIcon: (path: string) => string,
): string | null {
  let replaced = false;
  const result = code.replace(BARREL_IMPORT, (statement, names: string) => {
    const direct: string[] = [];
    const kept: string[] = [];
    for (const specifier of names.split(",")) {
      const match = specifier.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!match) {
        if (specifier.trim()) return statement;
        continue;
      }
      const [, imported, local = imported] = match;
      const path = modules.get(imported!);
      if (path)
        direct.push(
          `import ${local} from ${JSON.stringify(resolveIcon(path))};`,
        );
      else kept.push(specifier.trim());
    }
    if (!direct.length) return statement;
    replaced = true;
    if (kept.length)
      direct.push(`import { ${kept.join(", ")} } from "lucide-react";`);
    return direct.join("");
  });
  return replaced ? result : null;
}

export function lucideDirectImportsPlugin(): Plugin {
  let modules: Map<string, string> | null = null;
  let directory = "";
  const load = () => {
    if (modules) return modules;
    // The package's ES entry, whichever entry this runtime resolves.
    const root = fileURLToPath(import.meta.resolve("lucide-react")).replace(
      /([/\\]node_modules[/\\]lucide-react)[/\\].*$/,
      "$1",
    );
    const { module: entry } = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as { module?: string };
    if (!entry) throw new Error("lucide-react has no ES module entry");
    const barrel = resolve(root, entry);
    directory = dirname(barrel);
    modules = lucideIconModules(readFileSync(barrel, "utf8"));
    if (!modules.size)
      throw new Error("lucide-react's icon re-exports were not found");
    return modules;
  };
  return {
    name: "thyra-lucide-direct-imports",
    apply: "build",
    transform(code, id) {
      if (!code.includes("lucide-react") || id.includes("/node_modules/"))
        return null;
      const result = directLucideImports(code, load(), (path) =>
        resolve(directory, path).replace(/\\/g, "/"),
      );
      return result === null ? null : { code: result, map: null };
    },
  };
}
