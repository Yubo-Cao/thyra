// The slice manifest of the bundled terminal font: which woff2 chunk covers
// which code points, per weight and style. scripts/build-terminal-font.ts
// writes it beside the stylesheets; the GPU terminal reads it instead of
// parsing the (twelve times larger) @font-face stylesheet.

export type FontRange = [low: number, high: number];

export type FontFaceRule = {
  url: string;
  weight: number;
  italic: boolean;
  ranges: FontRange[];
};

/** One embedded slice: url, weight, italic, encoded ranges. */
export type EncodedFontFace = readonly [
  url: string,
  weight: number,
  italic: 0 | 1,
  ranges: string,
];

export type TerminalFontManifest = {
  /** URL directory of the face folders. */
  root: string;
  /** Folder, weight and italic flag of each face. */
  faces: [folder: string, weight: number, italic: 0 | 1][];
  /** Encoded range lists; faces sliced alike share them. */
  ranges: string[];
  /** Slices: `root/folder/name.woff2` covers `ranges[index]`. */
  chunks: [face: number, name: string, ranges: number][];
};

/** Parses @font-face rules: url, weight, style and unicode-range. */
export function parseFontFaceRules(css: string): FontFaceRule[] {
  const rules: FontFaceRule[] = [];
  for (const rule of css.split("}")) {
    const url = rule.match(/url\("([^"]+)"\)/)?.[1];
    const ranges = rule.match(/unicode-range:([^;}]*)/)?.[1];
    if (!url || !ranges) continue;
    rules.push({
      url,
      weight: Number(rule.match(/font-weight:(\d+)/)?.[1] ?? 400),
      italic: /font-style:italic/.test(rule),
      ranges: ranges.split(",").map((range) => {
        const [start, end = start] = range.trim().slice(2).split("-");
        return [parseInt(start!, 16), parseInt(end!, 16)];
      }),
    });
  }
  return rules;
}

/**
 * Sorted ranges as base-36 `gap[-length]` items: the gap from the previous
 * range's end (from zero for the first), and the length when above one code
 * point.
 */
export function encodeFontRanges(ranges: readonly FontRange[]): string {
  let previous = 0;
  return [...ranges]
    .sort((a, b) => a[0] - b[0])
    .map(([low, high]) => {
      const item =
        (low - previous).toString(36) +
        (high > low ? `-${(high - low).toString(36)}` : "");
      previous = high;
      return item;
    })
    .join(",");
}

export function decodeFontRanges(encoded: string): FontRange[] {
  const ranges: FontRange[] = [];
  if (!encoded) return ranges;
  let previous = 0;
  for (const item of encoded.split(",")) {
    const dash = item.indexOf("-");
    const low = previous + parseInt(dash < 0 ? item : item.slice(0, dash), 36);
    const high = dash < 0 ? low : low + parseInt(item.slice(dash + 1), 36);
    ranges.push([low, high]);
    previous = high;
  }
  return ranges;
}

export function encodeFontFace(rule: FontFaceRule): EncodedFontFace {
  return [
    rule.url,
    rule.weight,
    rule.italic ? 1 : 0,
    encodeFontRanges(rule.ranges),
  ];
}

/** The manifest of rules whose files are `root/<folder>/<name>.woff2`. */
export function buildTerminalFontManifest(
  root: string,
  rules: readonly FontFaceRule[],
): TerminalFontManifest {
  const manifest: TerminalFontManifest = {
    root,
    faces: [],
    ranges: [],
    chunks: [],
  };
  const faceIndex = new Map<string, number>();
  const rangeIndex = new Map<string, number>();
  for (const rule of rules) {
    const file = rule.url.startsWith(`${root}/`)
      ? rule.url.slice(root.length + 1).match(/^([^/]+)\/([^/]+)\.woff2$/)
      : null;
    if (!file) throw new Error(`Unexpected font chunk URL: ${rule.url}`);
    const [, folder, name] = file as unknown as [string, string, string];
    const italic = rule.italic ? 1 : 0;
    const faceKey = `${folder}/${rule.weight}/${italic}`;
    let face = faceIndex.get(faceKey);
    if (face === undefined) {
      face = manifest.faces.push([folder, rule.weight, italic]) - 1;
      faceIndex.set(faceKey, face);
    }
    const encoded = encodeFontRanges(rule.ranges);
    let ranges = rangeIndex.get(encoded);
    if (ranges === undefined) {
      ranges = manifest.ranges.push(encoded) - 1;
      rangeIndex.set(encoded, ranges);
    }
    manifest.chunks.push([face, name, ranges]);
  }
  return manifest;
}

/** The rules a manifest describes; slices of one range list share its array. */
export function terminalFontManifestRules(
  manifest: TerminalFontManifest,
): FontFaceRule[] {
  const ranges = manifest.ranges.map(decodeFontRanges);
  const rules: FontFaceRule[] = [];
  for (const [face, name, range] of manifest.chunks) {
    const [folder, weight, italic] = manifest.faces[face] ?? [];
    const covered = ranges[range];
    if (folder === undefined || weight === undefined || !covered) continue;
    rules.push({
      url: `${manifest.root}/${folder}/${name}.woff2`,
      weight,
      italic: italic === 1,
      ranges: covered,
    });
  }
  return rules;
}

/** Whether a fetched value has the manifest's shape. */
export function isTerminalFontManifest(
  value: unknown,
): value is TerminalFontManifest {
  if (value === null || typeof value !== "object") return false;
  const manifest = value as Partial<TerminalFontManifest>;
  return (
    typeof manifest.root === "string" &&
    Array.isArray(manifest.faces) &&
    Array.isArray(manifest.ranges) &&
    manifest.ranges.every((ranges) => typeof ranges === "string") &&
    Array.isArray(manifest.chunks) &&
    manifest.chunks.every(
      (chunk) =>
        Array.isArray(chunk) &&
        typeof chunk[0] === "number" &&
        typeof chunk[1] === "string" &&
        typeof chunk[2] === "number",
    )
  );
}
