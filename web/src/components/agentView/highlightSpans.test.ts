import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import {
  diffSides,
  type HighlightSpan,
  renderHighlighted,
  spansByLine,
} from "./highlightSpans";
import { highlight, highlightNow } from "./syntaxHighlight";

describe("highlight spans", () => {
  test("split at line breaks, relative to each line", () => {
    const text = "ab\ncdef\n\ng";
    const spans: HighlightSpan[] = [
      [0, 2, "k"],
      [1, 6, "s"],
      [9, 10, "n"],
    ];
    expect(spansByLine(text, spans)).toEqual([
      [
        [0, 2, "k"],
        [1, 2, "s"],
      ],
      [[0, 3, "s"]],
      [],
      [[0, 1, "n"]],
    ]);
  });

  test("render as text runs and spans, never markup", () => {
    const parts = renderHighlighted("<b>x</b> y", [[0, 8, "s"]]) as unknown[];
    expect(parts).toHaveLength(2);
    const span = parts[0] as ReactElement<{
      className: string;
      children: string;
    }>;
    expect(isValidElement(span)).toBe(true);
    expect(span.props.className).toBe("s");
    expect(span.props.children).toBe("<b>x</b>");
    expect(parts[1]).toBe(" y");
    expect(renderHighlighted("plain", null)).toBe("plain");
  });

  test("a diff splits into its old and new files", () => {
    const sides = diffSides([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "B" },
      { kind: "note", text: "No newline at end of file" },
    ]);
    expect(sides.next).toBe("a\nB");
    expect(sides.prev).toBe("a\nb");
    expect(sides.at).toEqual([
      null,
      { side: "next", line: 0 },
      { side: "prev", line: 1 },
      { side: "next", line: 1 },
      null,
    ]);
  });
});

describe("syntax highlighting", () => {
  const classesOf = (code: string, spans: readonly HighlightSpan[] | null) =>
    (spans ?? []).map(([from, to, cls]) => [code.slice(from, to), cls]);

  test("colours a fence's language once it loads", async () => {
    const code = 'const answer = "42"; // note';
    expect(highlightNow(code, "ts")).toBeUndefined();
    const spans = await highlight(code, "ts");
    expect(classesOf(code, spans)).toEqual(
      expect.arrayContaining([
        ["const", "agent-hl-keyword"],
        ['"42"', "agent-hl-string"],
        ["// note", "agent-hl-comment"],
      ]),
    );
    // Known now: a block mounting again draws coloured at once.
    expect(highlightNow(code, "ts")).toBe(spans!);
  });

  test("commands as shell, files by extension", async () => {
    const command = "echo 'hi' # greet";
    expect(classesOf(command, await highlight(command, "bash"))).toEqual(
      expect.arrayContaining([
        ["'hi'", "agent-hl-string"],
        ["# greet", "agent-hl-comment"],
      ]),
    );
    const python = "def f():\n    return 1";
    expect(
      classesOf(python, await highlight(python, "src/my module.py")),
    ).toEqual(expect.arrayContaining([["def", "agent-hl-keyword"]]));
  });

  test("unknown languages stay plain", async () => {
    expect(await highlight("x", "klingon")).toBeNull();
    expect(highlightNow("x", "")).toBeNull();
  });
});
