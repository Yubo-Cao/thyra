import { describe, expect, test } from "bun:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { livePreview, livePreviewDecorations } from "./livePreview";

/** The text the decorations hide (replace without a widget) or swap. */
function rendered(doc: string, cursor: number | null) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(cursor ?? 0),
    extensions: livePreview(),
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const decorations = livePreviewDecorations(
    state,
    [{ from: 0, to: doc.length }],
    cursor !== null,
  );
  const hidden: string[] = [];
  const classes: string[] = [];
  decorations.between(0, doc.length, (from, to, value) => {
    const spec = value.spec as {
      widget?: unknown;
      class?: string;
    };
    if (from < to && !spec.class)
      hidden.push((spec.widget ? "•" : "") + doc.slice(from, to));
    if (spec.class) classes.push(spec.class);
  });
  return { hidden, classes };
}

describe("live preview", () => {
  test("inline markers hide off the edited line", () => {
    const doc = "**bold** _it_ `code` [link](https://x.dev)";
    expect(rendered(doc, null).hidden).toEqual([
      "**",
      "**",
      "_",
      "_",
      "`",
      "`",
      "[",
      "]",
      "(",
      "https://x.dev",
      ")",
    ]);
    expect(rendered(doc, 3).hidden).toEqual([]);
  });

  test("a heading hides its hashes; a list swaps its dash for a bullet", () => {
    const doc = "# Title\n- item\n1. first\nplain";
    expect(rendered(doc, doc.length).hidden).toEqual(["# ", "•-"]);
    // On the heading line its marker shows; the list keeps its bullet.
    expect(rendered(doc, 2).hidden).toEqual(["•-"]);
  });

  test("fenced code keeps its fences and marks its lines", () => {
    const doc = "```ts\nconst a = 1;\n```\n";
    const { hidden, classes } = rendered(doc, null);
    expect(hidden).toEqual([]);
    expect(
      classes.filter((name) => name === "prompt-md-code-line"),
    ).toHaveLength(3);
  });

  test("decorations never change the text", () => {
    const doc = "**a** `b`\n\n- c";
    const state = EditorState.create({ doc, extensions: livePreview() });
    livePreviewDecorations(state, [{ from: 0, to: doc.length }], false);
    expect(state.doc.toString()).toBe(doc);
  });
});
