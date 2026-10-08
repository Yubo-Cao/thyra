import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/**
 * Material Icon Theme (MIT, https://github.com/material-extensions/vscode-material-icon-theme)
 * as a lazy module: `virtual:file-icons` exports a compact name -> icon
 * mapping, and every icon is a separate SVG under
 * `/assets/file-icons/<set hash>/`, fetched only when a row shows it and then
 * cached immutably (the hash covers every icon, so an upgrade renames them).
 */

const VIRTUAL_ID = "virtual:file-icons";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

type Manifest = {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  light: { fileExtensions?: Record<string, string> };
};

/** Folder names map their `.x`, `_x`, `-x` and `__x__` spellings to one icon. */
export function folderBaseName(name: string) {
  return name.replace(/^__(.+)__$/, "$1").replace(/^[._-](?=.)/, "");
}

/** Group keys by icon: `{ icon: "key key" }`, the smallest JSON for the table. */
function groupByIcon(map: Record<string, string>, strip = "") {
  const grouped: Record<string, string[]> = {};
  for (const [key, icon] of Object.entries(map)) {
    const name =
      strip && icon.startsWith(strip) ? icon.slice(strip.length) : icon;
    (grouped[name] ??= []).push(key);
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([icon, keys]) => [icon, keys.join(" ")]),
  );
}

/** `a.config.js a.config.ts` -> `a.config.{js,ts}`; the client expands it. */
export function braceNames(keys: string) {
  const out: string[] = [];
  const stems = new Map<string, string[]>();
  for (const key of keys.split(" ")) {
    const dot = key.lastIndexOf(".");
    if (dot <= 0 || /[{},]/.test(key)) {
      out.push(key);
      continue;
    }
    const stem = key.slice(0, dot);
    const list = stems.get(stem) ?? [];
    list.push(key.slice(dot + 1));
    stems.set(stem, list);
  }
  for (const [stem, extensions] of stems) {
    out.push(
      extensions.length > 1
        ? `${stem}.{${extensions.join(",")}}`
        : `${stem}.${extensions[0]}`,
    );
  }
  return out.join(" ");
}

export function fileIconTable(manifest: Manifest) {
  const folders: Record<string, string> = {};
  for (const [name, icon] of Object.entries(manifest.folderNames)) {
    folders[folderBaseName(name)] ??= icon;
  }
  // Space-separated keys: drop the few names that contain a space.
  const clean = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).filter(([key]) => !/\s/.test(key)));
  const icons = new Set(Object.keys(manifest.iconDefinitions));
  return {
    extensions: groupByIcon(clean(manifest.fileExtensions)),
    names: Object.fromEntries(
      Object.entries(groupByIcon(clean(manifest.fileNames))).map(
        ([icon, keys]) => [icon, braceNames(keys)],
      ),
    ),
    folders: groupByIcon(clean(folders), "folder-"),
    // Icons with a `_light` variant for light themes.
    light: [...icons]
      .filter((icon) => icons.has(`${icon}_light`))
      .sort()
      .join(" "),
  };
}

export function fileIconsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("material-icon-theme/package.json"));
  const manifest = JSON.parse(
    readFileSync(join(root, "dist/material-icons.json"), "utf8"),
  ) as Manifest;
  const iconFile = (name: string) =>
    join(root, "dist", manifest.iconDefinitions[name]!.iconPath);
  const names = Object.keys(manifest.iconDefinitions).sort();
  let base = "";
  let isBuild = false;
  return {
    name: "thyra-file-icons",
    configResolved(config) {
      isBuild = config.command === "build";
      base = isBuild ? "" : "/@file-icons/";
    },
    configureServer(server) {
      server.middlewares.use("/@file-icons/", (request, response, next) => {
        const name = decodeURIComponent(request.url ?? "")
          .replace(/^\//, "")
          .replace(/\.svg$/, "");
        if (
          !Object.prototype.hasOwnProperty.call(manifest.iconDefinitions, name)
        )
          return next();
        response.setHeader("content-type", "image/svg+xml");
        response.end(readFileSync(iconFile(name)));
      });
    },
    buildStart() {
      if (!isBuild) return;
      // A few definitions point at shared `.clone.svg` files.
      const sources = names.map((name) => ({
        name,
        source: readFileSync(iconFile(name)),
      }));
      const hash = createHash("sha256");
      for (const { name, source } of sources) hash.update(name).update(source);
      const directory = `assets/file-icons/${hash.digest("hex").slice(0, 10)}`;
      base = `/${directory}/`;
      for (const { name, source } of sources) {
        this.emitFile({
          type: "asset",
          fileName: `${directory}/${name}.svg`,
          source,
        });
      }
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const table = fileIconTable(manifest);
      return `export const base = ${JSON.stringify(base)};
export const table = ${JSON.stringify(table)};`;
    },
  };
}
