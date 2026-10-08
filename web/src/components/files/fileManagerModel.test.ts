import { expect, test } from "bun:test";
import type { FileExplorerEntry } from "../../types";
import { buildIconLookup, iconName, iconUrl } from "./fileIcons";
import {
  ancestorsBetween,
  hostPathOf,
  isWithin,
  moveIndex,
  parentPath,
  rangeBetween,
  relativePathOf,
  sortEntries,
  typeaheadMatch,
  visibleRows,
} from "./fileManagerModel";

const file = (
  path: string,
  extra: Partial<FileExplorerEntry> = {},
): FileExplorerEntry => ({
  name: path.split("/").pop()!,
  path,
  type: "file",
  size: 0,
  mtime_ms: 0,
  hidden: false,
  ...extra,
});
const dir = (path: string) => file(path, { type: "directory" });

test("paths work for both scopes", () => {
  expect(parentPath("src/a/b.ts", "workspace")).toBe("src/a");
  expect(parentPath("b.ts", "workspace")).toBe("");
  expect(parentPath("/home/me", "filesystem")).toBe("/home");
  expect(parentPath("/", "filesystem")).toBe("/");
  expect(isWithin("src/a", "")).toBe(true);
  expect(isWithin("/etc", "")).toBe(false);
  expect(isWithin("/home/me2", "/home/me")).toBe(false);
  expect(isWithin("/home/me/x", "/")).toBe(true);
  expect(ancestorsBetween("", "src/a/b.ts", "workspace")).toEqual([
    "src",
    "src/a",
  ]);
  expect(ancestorsBetween("/r", "/r/x/y.txt", "filesystem")).toEqual(["/r/x"]);
});

test("copy paths do not prefix an absolute filesystem entry with the workspace", () => {
  expect(hostPathOf("/workspace", "/references/r.md")).toBe("/references/r.md");
  expect(hostPathOf("/workspace/", "docs/r.md")).toBe("/workspace/docs/r.md");
  expect(hostPathOf("/workspace", "")).toBe("/workspace");
  expect(relativePathOf("/workspace", "/workspace/docs/r.md")).toBe(
    "docs/r.md",
  );
  expect(relativePathOf("/workspace", "/elsewhere/r.md")).toBe(
    "/elsewhere/r.md",
  );
  expect(relativePathOf("/workspace", "docs/r.md")).toBe("docs/r.md");
});

test("folders sort first, then by the chosen key", () => {
  const entries = [
    file("b.txt", { size: 5, mtime_ms: 3 }),
    file("a10.md", { size: 50, mtime_ms: 1 }),
    file("a9.md", { size: 1, mtime_ms: 2 }),
    dir("zeta"),
  ];
  const names = (
    key: "name" | "type" | "size" | "modified",
    descending = false,
  ) => sortEntries(entries, { key, descending }).map((entry) => entry.name);
  expect(names("name")).toEqual(["zeta", "a9.md", "a10.md", "b.txt"]);
  expect(names("size", true)).toEqual(["zeta", "a10.md", "b.txt", "a9.md"]);
  expect(names("modified")).toEqual(["zeta", "a10.md", "a9.md", "b.txt"]);
  expect(names("type")).toEqual(["zeta", "a9.md", "a10.md", "b.txt"]);
});

test("the list flattens expanded folders; filters search what is loaded", () => {
  const children = {
    "": [dir("src"), file("readme.md")],
    src: [file("src/main.ts"), dir("src/lib")],
    "src/lib": [file("src/lib/util.ts")],
  };
  const rows = (
    expanded: string[],
    filter = "",
    view: "list" | "grid" = "list",
  ) =>
    visibleRows({
      root: "",
      children,
      expanded: new Set(expanded),
      sort: { key: "name", descending: false },
      filter,
      view,
    }).map((row) => `${row.depth}:${row.entry.path}`);
  expect(rows([])).toEqual(["0:src", "0:readme.md"]);
  expect(rows(["src"])).toEqual([
    "0:src",
    "1:src/lib",
    "1:src/main.ts",
    "0:readme.md",
  ]);
  expect(rows(["src"], "", "grid")).toEqual(["0:src", "0:readme.md"]);
  expect(rows([], "*.ts")).toEqual(["0:src/main.ts", "0:src/lib/util.ts"]);
  expect(rows([], "*.ts", "grid")).toEqual([]);
});

test("ranges, movement and typeahead follow row order", () => {
  const rows = ["a", "b", "c", "d"].map((path) => ({
    entry: file(path),
    depth: 0,
  }));
  expect(rangeBetween(rows, "c", "a")).toEqual(["a", "b", "c"]);
  expect(rangeBetween(rows, null, "b")).toEqual(["b"]);
  expect(moveIndex(1, "ArrowDown", 4)).toBe(2);
  expect(moveIndex(3, "ArrowDown", 4)).toBe(3);
  expect(moveIndex(0, "ArrowRight", 4)).toBe(0);
  expect(moveIndex(0, "ArrowRight", 4, { columns: 2 })).toBe(1);
  expect(moveIndex(0, "ArrowDown", 4, { columns: 2 })).toBe(2);
  expect(moveIndex(-1, "End", 4)).toBe(3);
  expect(typeaheadMatch(rows, "c", 0)).toBe(2);
  expect(typeaheadMatch(rows, "z", 0)).toBe(-1);
});

test("material icon lookup follows names, extensions and folders", () => {
  const lookup = buildIconLookup("/icons/", {
    extensions: { typescript: "ts", "test-ts": "test.ts spec.ts" },
    names: {
      nodejs: "package.json",
      docker: "dockerfile",
      "github-actions-workflow": ".github/workflows/ci.{yml,yaml}",
    },
    folders: { src: "src source", test: "test tests", github: "github" },
    light: "nodejs",
  });
  const icon = (
    name: string,
    directory = false,
    open = false,
    parent?: string,
  ) => iconName(lookup, { name, directory, open, parent });
  expect(icon("package.json")).toBe("nodejs");
  expect(icon("Dockerfile")).toBe("docker");
  expect(icon("a.test.ts")).toBe("test-ts");
  expect(icon("index.ts")).toBe("typescript");
  expect(icon("notes.unknown")).toBe("file");
  expect(icon("src", true)).toBe("folder-src");
  expect(icon("__tests__", true, true)).toBe("folder-test-open");
  expect(icon(".github", true)).toBe("folder-github");
  expect(icon("other", true, true)).toBe("folder-open");
  expect(iconName(lookup, { name: "x", directory: true, root: true })).toBe(
    "folder-root",
  );
  expect(iconUrl(lookup, "nodejs", true)).toBe("/icons/nodejs_light.svg");
  expect(iconUrl(lookup, "nodejs", false)).toBe("/icons/nodejs.svg");
  expect(iconUrl(lookup, "typescript", true)).toBe("/icons/typescript.svg");
});
