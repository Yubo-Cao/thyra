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

  test("slices of the primary face keep its scale", () => {
    // Thyra Mono ships as unicode-range slices; only some carry the ic-width
    // probe (水), which shrank their CJK by ~9% and resampled it.
    expect(source).toMatch(
      /function resolveFallbackScaleAdjustment\(primaryFont, fallbackFont\) \{[^]*?if \(isSameFaceMetrics\(primary, fallback\)\)\s*return 1;/,
    );
  });
});
