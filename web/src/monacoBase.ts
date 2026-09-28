// The Monaco core both lazy editors share: the editor API, the editing
// features the prompt editor needs (multi-cursor, find, clipboard, word and
// line operations), the Markdown grammar, the base editor worker, and the app
// theme. The file editor adds its other features and grammars in
// monacoSetup.ts, so opening the prompt editor never downloads them. Language
// service workers are excluded and nothing is fetched from a CDN.
import * as monaco from "monaco-esm/editor/editor.api.js";
import "monaco-esm/features/codicon/register.js";
import "monaco-esm/features/clipboard/register.js";
import "monaco-esm/features/contextmenu/register.js";
import "monaco-esm/features/cursorUndo/register.js";
import "monaco-esm/features/find/register.js";
import "monaco-esm/features/linesOperations/register.js";
import "monaco-esm/features/multicursor/register.js";
import "monaco-esm/features/placeholderText/register.js";
import "monaco-esm/features/wordOperations/register.js";
import * as markdown from "monaco-esm/languages/definitions/markdown/markdown.js";
import EditorWorker from "monaco-esm/editor/editor.worker.js?worker";

export type MonarchModule = {
  conf: monaco.languages.LanguageConfiguration;
  language: monaco.languages.IMonarchLanguage;
};

(
  self as unknown as { MonacoEnvironment: monaco.Environment }
).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const registered = new Set<string>();

/** Registers a Monarch grammar under `id` once. */
export function registerMonarchLanguage(id: string, grammar: MonarchModule) {
  if (registered.has(id)) return;
  registered.add(id);
  monaco.languages.register({ id });
  monaco.languages.setMonarchTokensProvider(id, grammar.language);
  monaco.languages.setLanguageConfiguration(id, grammar.conf);
}

registerMonarchLanguage("markdown", markdown);

function cssColor(expression: string, fallback: string) {
  // Resolve var()/color-mix() through the cascade into a hex color.
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = expression;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const channels = rgb.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length < 3) return fallback;
  const hex = channels
    .slice(0, 3)
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

/** Define (or refresh) the app theme from the live CSS tokens. */
export function applyMonacoTheme(theme: "dark" | "light") {
  const dark = theme === "dark";
  const name = dark ? "thyra-dark" : "thyra-light";
  const background = cssColor(
    "var(--viewer-content-bg, var(--terminal-bg))",
    dark ? "#0e1014" : "#ffffff",
  );
  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    // Monarch token classes in the preview's syntax colors (CodePreview).
    rules: Object.entries({
      comment: "comment",
      keyword: "keyword",
      string: "string",
      number: "number",
      "type type.identifier tag": "type",
      "attribute.name key": "property",
      "variable predefined": "variable",
      "delimiter operator": "punctuation",
      "annotation metatag": "meta",
    }).flatMap(([tokens, color]) =>
      tokens.split(" ").map((token) => ({
        token,
        foreground: cssColor(`var(--syntax-${color})`, "#808080"),
        fontStyle: token === "comment" ? "italic" : undefined,
      })),
    ),
    colors: {
      "editor.background": background,
      "editorGutter.background": background,
      "minimap.background": background,
      "editor.foreground": cssColor(
        "var(--text)",
        dark ? "#d4d8df" : "#24292f",
      ),
      "editorLineNumber.foreground": cssColor("var(--muted)", "#858c97"),
      "editorLineNumber.activeForeground": cssColor(
        "var(--text-strong)",
        dark ? "#f4f6f8" : "#101418",
      ),
      "editorCursor.foreground": cssColor("var(--accent)", "#6ea0ff"),
      "editorWidget.background": cssColor("var(--panel)", background),
      "editorWidget.border": cssColor("var(--border)", "#23272e"),
    },
  });
  monaco.editor.setTheme(name);
}

export { monaco };
