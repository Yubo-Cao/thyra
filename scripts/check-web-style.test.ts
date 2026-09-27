import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// The web UI is square and borderless: surfaces separate by tone and single
// dividers, never by rounded corners or boxed outlines.
const webSource = new URL("../web/src/", import.meta.url).pathname;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(css|tsx?)$/.test(entry.name) && !entry.name.includes(".test.")
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

// Tailwind utilities that would reintroduce radius, shadows, outlines, or
// ring outlines. Variants (hover:, md:...) and the `!` modifier are covered;
// `rounded-none`, `shadow-none`, `border-0`, `ring-0`, and color utilities
// such as `border-transparent` or `ring-accent` stay allowed.
const TAILWIND_BREAKS_DESIGN = new RegExp(
  String.raw`(?:^|[\s"'\`{])(?:[\w-]+:)*!?(` +
    [
      String.raw`rounded(?:-[a-z]{1,2})?(?:-(?!none\b)[\w.[\]/()-]+)?`,
      String.raw`shadow(?:-(?!none\b)[\w.[\]/()-]+)?`,
      String.raw`border(?:-[xytrblse])?(?:-(?:\d+|\[[^\]]+\]))?`,
      String.raw`ring(?:-(?:\d+|\[[^\]]+\]))?`,
      String.raw`ring-inset`,
      String.raw`outline(?:-(?:\d+|\[[^\]]+\]))?`,
    ].join("|") +
    String.raw`)(?=$|[\s"'\`}])`,
  "g",
);
const ALLOWED_TAILWIND = new Set([
  "rounded-none",
  "shadow-none",
  "border-0",
  "border-x-0",
  "border-y-0",
  "border-t-0",
  "border-r-0",
  "border-b-0",
  "border-l-0",
  "border-s-0",
  "border-e-0",
  "ring-0",
  "outline-0",
]);

/** Tailwind classes in a className-like string that break the design. */
export function tailwindViolations(line: string): string[] {
  // Only inspect className/class attributes and cn()/cx() arguments, where
  // utility classes live; plain prose like "border" in text stays legal.
  if (!/\b(?:className|class|cn|cx|clsx|tv)\b/.test(line)) return [];
  return [...line.matchAll(TAILWIND_BREAKS_DESIGN)]
    .map((match) => match[1])
    .filter((name) => !ALLOWED_TAILWIND.has(name));
}

function violations(path: string, text: string) {
  const found: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const at = `${relative(webSource, path)}:${index + 1}`;
    if (path.endsWith(".css")) {
      if (/border-radius\s*:(?!\s*0\s*;)/.test(line))
        found.push(`${at} rounds corners: ${line.trim()}`);
      // Thicker rings on status dots and spinners are glyphs, not outlines.
      if (/^\s*border\s*:\s*1px\s+solid/.test(line))
        found.push(`${at} draws an outline: ${line.trim()}`);
      return;
    }
    if (/borderRadius\s*:(?![\s"']*0\b)/.test(line)) {
      found.push(`${at} rounds corners inline: ${line.trim()}`);
    }
    if (path.endsWith(".tsx")) {
      for (const name of tailwindViolations(line))
        found.push(`${at} uses Tailwind "${name}": ${line.trim()}`);
    }
  });
  return found;
}

test("web styles stay square and borderless", async () => {
  const found: string[] = [];
  for (const path of await sourceFiles(webSource))
    found.push(...violations(path, await readFile(path, "utf8")));
  expect(found).toEqual([]);
});

describe("Tailwind class check", () => {
  test("rejects radius, shadow, border, ring, and outline widths", () => {
    expect(
      tailwindViolations(
        `<div className="rounded-lg p-2 shadow-md border ring-2 md:border-2 hover:rounded outline-1" />`,
      ),
    ).toEqual([
      "rounded-lg",
      "shadow-md",
      "border",
      "ring-2",
      "border-2",
      "rounded",
      "outline-1",
    ]);
    expect(
      tailwindViolations(`cn("rounded-t-xl", "border-b", "!shadow")`),
    ).toEqual(["rounded-t-xl", "border-b", "shadow"]);
  });

  test("allows the square/borderless escapes, colors, and prose", () => {
    expect(
      tailwindViolations(
        `<div className="rounded-none shadow-none border-0 ring-0 border-transparent ring-accent text-sm" />`,
      ),
    ).toEqual([]);
    expect(tailwindViolations(`const label = t("Add a border");`)).toEqual([]);
    expect(tailwindViolations(`className="ui-bar-border"`)).toEqual([]);
  });
});
