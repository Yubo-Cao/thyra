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
  test("mouse reports reach the pty", () => {
    // restty's MouseController sends wheel, click and drag reports through
    // the reply sink, so gating it drops every mouse event a mouse-reporting
    // app (htop, vim) should get.
    const source = runtimeSource();
    const sink = source.match(/sendReply: \(data\) => \{([^}]*)\}/);
    expect(sink?.[1].trim()).toBe("ptyTransport.sendInput(data);");
  });
});
