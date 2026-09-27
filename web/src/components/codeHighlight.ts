import type { ThemeRegistration } from "@shikijs/core";

type Token = { content: string; color?: string; fontStyle?: number };

// Theme tokens (styles/tokens.css) by TextMate scope, so highlighting follows
// the app's light and dark themes without re-highlighting.
const SCOPES: ReadonlyArray<
  [scopes: string, token: string, fontStyle?: string]
> = [
  ["punctuation, meta.brace", "punctuation"],
  ["keyword, storage, entity.name.tag", "keyword"],
  ["keyword.operator, markup.underline.link", "operator"],
  [
    "string, punctuation.definition.string, markup.inline.raw, markup.fenced_code, markup.inserted",
    "string",
  ],
  ["constant, support.constant", "number"],
  ["entity.name.function, support.function, entity.name.section", "function"],
  ["markup.heading", "function", "bold"],
  [
    "support.type.property-name, variable.other.property, variable.other.object.property, entity.other.attribute-name, meta.object-literal.key",
    "property",
  ],
  ["variable.parameter, variable.language", "variable"],
  [
    "entity.name.type, entity.name.class, entity.name.namespace, entity.other.inherited-class, support.type, support.class",
    "type",
  ],
  [
    "meta.preprocessor, meta.decorator, entity.name.function.decorator, keyword.other.directive",
    "meta",
  ],
  [
    "comment, punctuation.definition.comment, string.quoted.docstring",
    "comment",
    "italic",
  ],
  ["markup.deleted", "deleted"],
  ["markup.bold", "", "bold"],
  ["markup.italic", "", "italic"],
];

export const SYNTAX_THEME: ThemeRegistration = {
  name: "thyra",
  type: "dark",
  colors: {
    "editor.foreground": "var(--text-code)",
    "editor.background": "var(--viewer-code-bg)",
  },
  tokenColors: SCOPES.map(([scope, token, fontStyle]) => ({
    scope: scope.split(", "),
    settings: {
      foreground:
        token === "deleted"
          ? "var(--danger-text)"
          : token
            ? `var(--syntax-${token})`
            : undefined,
      fontStyle,
    },
  })),
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );

/** One `.line` span per line, separated by newlines, so copy stays exact. */
export function codeLinesHtml(lines: Token[][], foreground?: string) {
  return lines
    .map((tokens) => {
      const html = tokens.map(({ content, color, fontStyle = 0 }) => {
        const style = [
          color && color !== foreground ? `color:${color}` : "",
          fontStyle & 1 ? "font-style:italic" : "",
          fontStyle & 2 ? "font-weight:bold" : "",
          fontStyle & 4 ? "text-decoration:underline" : "",
        ].filter(Boolean);
        const text = escapeHtml(content);
        return style.length
          ? `<span style="${style.join(";")}">${text}</span>`
          : text;
      });
      return `<span class="line">${html.join("")}</span>`;
    })
    .join("\n");
}

export const plainCodeHtml = (text: string) =>
  codeLinesHtml(text.split("\n").map((line) => [{ content: line }]));
