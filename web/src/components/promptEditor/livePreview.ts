import {
  HighlightStyle,
  Language,
  LanguageDescription,
  LanguageSupport,
  ParseContext,
  StreamLanguage,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { EditorState, Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type MarkdownParser, parseCode } from "@lezer/markdown";

/**
 * Typora-style live preview for the prompt editor: Markdown renders as it is
 * typed (bold, italic, code, headings, lists, links, fenced code with
 * highlighting), and its markers show only on the lines the selection is on.
 * Decorations never touch the document, so the draft stays the exact text
 * typed.
 */

// Fenced code languages, each downloaded the first time a fence names it.
const legacy =
  (load: () => Promise<Parameters<typeof StreamLanguage.define>[0]>) =>
  async () =>
    new LanguageSupport(StreamLanguage.define(await load()));
const codeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx", "mjs", "cjs", "javascript"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true }),
      ),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx", "typescript"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py", "python"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json", "jsonc", "json5"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs", "rust"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["sh", "bash", "zsh", "shell", "console", "fish"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
    ),
  }),
  LanguageDescription.of({
    name: "TOML",
    alias: ["toml"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
    ),
  }),
  LanguageDescription.of({
    name: "Diff",
    alias: ["diff", "patch"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
    ),
  }),
];

// GitHub-flavoured Markdown as lang-markdown parses it, with fenced code
// handed to the languages above. Built on markdownLanguage itself (not
// `markdown()`, which bundles the HTML, CSS and JavaScript languages for
// inline HTML), so lang-markdown's commands still recognise it.
const promptMarkdown = new Language(
  markdownLanguage.data,
  (markdownLanguage.parser as MarkdownParser).configure(
    parseCode({
      codeParser: (info) => {
        const found = LanguageDescription.matchLanguageName(
          codeLanguages,
          info,
          true,
        );
        if (!found) return null;
        return (
          found.support?.language.parser ??
          ParseContext.getSkippingParser(found.load())
        );
      },
    }),
  ),
  [],
  "markdown",
);

// Colours come from the terminal theme (PromptEditor sets the variables).
const color = (name: string) => `var(--prompt-editor-${name})`;
const markdownStyle = HighlightStyle.define([
  // Larger headings keep the terminal's row height (a line-height of 1 fits
  // the bigger glyphs inside the row), so every line stays on the grid.
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.2em", lineHeight: "1" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.1em", lineHeight: "1" },
  {
    tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    fontWeight: "700",
  },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: color("blue"), textDecoration: "underline" },
  { tag: tags.url, color: color("blue") },
  { tag: tags.monospace, color: color("magenta") },
  { tag: tags.quote, color: color("dim") },
  {
    tag: [tags.processingInstruction, tags.contentSeparator],
    color: color("dim"),
  },
  // Fenced code.
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier],
    color: color("magenta"),
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: color("green"),
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: color("yellow"),
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: color("dim"),
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: color("blue"),
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: color("cyan"),
  },
  { tag: [tags.propertyName, tags.attributeName], color: color("cyan") },
  { tag: [tags.inserted], color: color("green") },
  { tag: [tags.deleted, tags.invalid], color: color("red") },
]);

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "prompt-md-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const codeLine = Decoration.line({ class: "prompt-md-code-line" });
const inlineCode = Decoration.mark({ class: "prompt-md-code" });
const faint = Decoration.mark({ class: "prompt-md-faint" });

// Markers that hide off the edited lines, and the node they belong to.
const INLINE_MARKS = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "LinkMark",
  "URL",
  "LinkTitle",
]);

/** Line numbers any selection range touches; none while unfocused. */
function editedLines(state: EditorState, focused: boolean): Set<number> {
  const lines = new Set<number>();
  if (!focused) return lines;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

/** Decorations for the visible ranges; exported for tests. */
export function livePreviewDecorations(
  state: EditorState,
  visible: readonly { from: number; to: number }[],
  focused: boolean,
): DecorationSet {
  const edited = editedLines(state, focused);
  const touches = (from: number, to: number) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let line = first; line <= last; line++)
      if (edited.has(line)) return true;
    return false;
  };
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of visible)
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node;
        if (name === "FencedCode" || name === "CodeBlock") {
          for (let pos = state.doc.lineAt(node.from).from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            ranges.push(codeLine.range(line.from));
            pos = line.to + 1;
          }
          // Fences and the language name stay, faint; the code inside is
          // the highlighter's alone.
          for (
            let child = node.node.firstChild;
            child;
            child = child.nextSibling
          )
            if (child.name === "CodeMark" || child.name === "CodeInfo")
              ranges.push(faint.range(child.from, child.to));
          return false;
        }
        if (name === "InlineCode") {
          ranges.push(inlineCode.range(node.from, node.to));
          return;
        }
        const parent = node.node.parent;
        if (name === "HeaderMark") {
          if (!parent || touches(parent.from, parent.to)) return;
          // `## ` disappears with its space; a setext underline stays.
          const end =
            state.doc.sliceString(node.to, node.to + 1) === " "
              ? node.to + 1
              : node.to;
          if (/^ATXHeading/.test(parent.name))
            ranges.push(hide.range(node.from, end));
          return;
        }
        if (name === "ListMark") {
          if (!parent || touches(node.from, node.to)) return;
          if (/^[-*+]$/.test(state.doc.sliceString(node.from, node.to)))
            ranges.push(bullet.range(node.from, node.to));
          return;
        }
        if (name === "QuoteMark") {
          ranges.push(faint.range(node.from, node.to));
          return;
        }
        if (INLINE_MARKS.has(name)) {
          const owner = parent ?? node.node;
          if (touches(owner.from, owner.to)) return;
          // An autolink's `<url>` keeps its address, losing only the brackets.
          if (name === "URL" && owner.name === "Autolink") return;
          if (node.from < node.to) ranges.push(hide.range(node.from, node.to));
        }
      },
    });
  return Decoration.set(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = livePreviewDecorations(
        view.state,
        view.visibleRanges,
        view.hasFocus,
      );
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = livePreviewDecorations(
          update.state,
          update.view.visibleRanges,
          update.view.hasFocus,
        );
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const livePreviewTheme = EditorView.baseTheme({
  ".prompt-md-code": {
    backgroundColor: `color-mix(in srgb, ${color("fg")} 10%, transparent)`,
  },
  ".prompt-md-code-line": {
    backgroundColor: `color-mix(in srgb, ${color("fg")} 6%, transparent)`,
  },
  ".prompt-md-faint, .prompt-md-bullet": { color: color("dim") },
});

/** Markdown with live preview: the language, highlighting and decorations. */
export function livePreview(): Extension {
  return [
    promptMarkdown,
    syntaxHighlighting(markdownStyle),
    livePreviewPlugin,
    livePreviewTheme,
  ];
}
