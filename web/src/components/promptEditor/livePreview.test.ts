import { describe, expect, test } from "bun:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { linkAt, livePreview, livePreviewDecorations } from "./livePreview";

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

  test("an image renders off its line and resolves its source", () => {
    const doc = "see ![shot](./a.png) and ![](/tmp/b.png)\nnext";
    const images = (cursor: number | null) => {
      const state = EditorState.create({
        doc,
        selection: EditorSelection.single(cursor ?? 0),
        extensions: livePreview({
          url: (source) =>
            source.startsWith("/") ? `/file?path=${source}` : null,
          pasted: () => null,
        }),
      });
      ensureSyntaxTree(state, doc.length, 5000);
      const found: { text: string; src: string; alt: string }[] = [];
      livePreviewDecorations(
        state,
        [{ from: 0, to: doc.length }],
        cursor !== null,
      ).between(0, doc.length, (from, to, value) => {
        const widget = value.spec.widget as
          | { src?: string; alt?: string }
          | undefined;
        if (widget?.src)
          found.push({
            text: doc.slice(from, to),
            src: widget.src,
            alt: widget.alt ?? "",
          });
      });
      return found;
    };
    // A source the resolver refuses keeps its Markdown.
    expect(images(doc.length)).toEqual([
      { text: "![](/tmp/b.png)", src: "/file?path=/tmp/b.png", alt: "" },
    ]);
    expect(images(2)).toEqual([]);
  });

  test("finds the web address of the link under the pointer", () => {
    const doc = "a [site](https://x.dev) <https://y.dev> [f](./f.md)";
    const state = EditorState.create({ doc, extensions: livePreview() });
    ensureSyntaxTree(state, doc.length, 5000);
    expect(linkAt(state, doc.indexOf("site"))).toBe("https://x.dev");
    expect(linkAt(state, doc.indexOf("y.dev"))).toBe("https://y.dev");
    expect(linkAt(state, doc.indexOf("[f]") + 1)).toBeNull();
    expect(linkAt(state, 0)).toBeNull();
  });

  test("pasted placeholders and bare image paths render off their line", () => {
    const doc =
      "a [Image #1] b [image 2 PNG 10x10] c [Image #7]\nsee /tmp/x.png, `/tmp/y.png` and ./z.png.\nend";
    const state = (cursor: number | null) => {
      const created = EditorState.create({
        doc,
        selection: EditorSelection.single(cursor ?? 0),
        extensions: livePreview({
          url: (source) => `url:${source}`,
          pasted: (ref) => (ref < 5 ? `blob:${ref}` : null),
        }),
      });
      ensureSyntaxTree(created, doc.length, 5000);
      const found: string[] = [];
      livePreviewDecorations(
        created,
        [{ from: 0, to: doc.length }],
        cursor !== null,
      ).between(0, doc.length, (from, to, value) => {
        const widget = value.spec.widget as { src?: string } | undefined;
        if (widget?.src) found.push(`${doc.slice(from, to)}=${widget.src}`);
      });
      return found.sort();
    };
    // Unknown placeholders and paths in code stay as written.
    expect(state(doc.length)).toEqual([
      "./z.png=url:./z.png",
      "/tmp/x.png=url:/tmp/x.png",
      "[Image #1]=blob:1",
      "[image 2 PNG 10x10]=blob:2",
    ]);
    // The line being edited shows its text.
    expect(state(1)).toEqual([
      "./z.png=url:./z.png",
      "/tmp/x.png=url:/tmp/x.png",
    ]);
  });
});
