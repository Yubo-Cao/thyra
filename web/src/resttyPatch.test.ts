import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The installed (patched) runtime chunk that restty/internal/runtime loads. */
const runtimeSource = () => {
  const entry = Bun.resolveSync("restty/internal/runtime", import.meta.dir);
  const index = readFileSync(entry, "utf8");
  const chunks = [...index.matchAll(/from "\.\.\/(chunk-[\w]+\.js)"/g)].map(
    (match) => readFileSync(join(dirname(entry), "..", match[1]), "utf8"),
  );
  return chunks.join("\n");
};

describe("restty patch", () => {
  const source = runtimeSource();

  test("mouse reports reach the pty while query replies stay off", () => {
    // restty's MouseController sends wheel, click and drag reports through a
    // reply sink; sharing the gated query-reply sink dropped every mouse
    // event a mouse-reporting app (htop, vim) should get.
    expect(source).toContain("sendReply: options.sendMouseReport || replySink");
    const mouse = source.match(/sendMouseReport: \(data\) => \{([^}]*)\}/);
    expect(mouse?.[1].trim()).toBe("ptyTransport.sendInput(data);");
    const replies = source.match(/sendReply: \(data\) => \{([^}]*)\}/);
    expect(replies?.[1]).toContain("if (forwardTerminalReplies)");
  });

  test("the native scroller can be turned off", () => {
    // It puts the canvas on a sticky, will-change layer shifted by
    // fractional pixels, which blurs text; Thyra owns scrolling.
    expect(source).toContain(
      "nativeScrollbar: terminal.nativeScrollbar ?? true",
    );
    expect(source).toContain(
      "const nativeScrollHost = options.nativeScrollbar !== false &&",
    );
  });

  test("coding ligatures substitute one cell-wide glyph per cell", () => {
    // Maple Mono joins runs of `-`, `->`, `==` with calt alternates that keep
    // one advance per character; restty capped runs at 8 cells and placed
    // their glyphs by font advance, so long runs broke and drifted.
    expect(source).not.toContain("MAX_LIGATURE_RUN_CHARS");
    expect(
      source.match(/gridAlignedLigature\(renderableLigatureRun/g),
    ).toHaveLength(2);
    expect(
      source.match(/searchPending: rowSearchCursor < rowSearchEndIndex/g),
    ).toHaveLength(2);
    const body = source.match(
      /function resolveRenderableLigatureRun\(options\) \{[^]*?\n\}\n/,
    )?.[0];
    const resolve = new Function(
      `${body}; return resolveRenderableLigatureRun;`,
    )();
    // Font 0 covers `-` and `>`, font 1 covers `\`; `-` alone is glyph 1.
    const glyphs: Record<string, number[]> = {
      "-": [1],
      ">": [2],
      "\\": [3],
      "--": [5, 6],
      "->": [7, 8],
      "-->": [5, 7, 8],
      "-x": [1, 0],
    };
    const run = (text: string, wide = false) => {
      const chars = [...text];
      return resolve({
        ligatureRun: {
          text,
          span: chars.length,
          indices: chars.map((_, i) => i),
        },
        stylePreference: "regular",
        fonts: [{}, {}],
        pickFontIndexForText: (t: string) => (t === "\\" ? 1 : 0),
        shapeClusterWithFont: (_: unknown, t: string) => {
          const ids = glyphs[t] ?? [...t].map(() => 1);
          const advance = wide && t.length > 1 ? 700 : 600;
          return {
            glyphs: ids.map((glyphId) => ({
              glyphId,
              xAdvance: advance,
              xOffset: 0,
            })),
            advance: advance * ids.length,
          };
        },
        readCellCluster: (i: number) => ({ text: chars[i], span: 1 }),
      });
    };
    expect(
      run("-->")?.shaped.glyphs.map((g: { glyphId: number }) => g.glyphId),
    ).toEqual([5, 7, 8]);
    expect(run("-->")?.fontIndex).toBe(0);
    // A cell that picks another font slice ends the run.
    expect(run("--\\")?.text).toBe("--");
    expect(run("\\--")).toBeNull();
    // Missing alternates, unchanged glyphs or other advances: cell by cell.
    expect(run("-x")).toBeNull();
    expect(run("---")).toBeNull();
    expect(run("->", true)).toBeNull();
  });

  test("slices of the primary face keep its scale", () => {
    // Thyra Mono ships as unicode-range slices; only some carry the ic-width
    // probe (水), which shrank their CJK by ~9% and resampled it.
    expect(source).toMatch(
      /function resolveFallbackScaleAdjustment\(primaryFont, fallbackFont\) \{[^]*?if \(isSameFaceMetrics\(primary, fallback\)\)\s*return 1;/,
    );
  });
});
