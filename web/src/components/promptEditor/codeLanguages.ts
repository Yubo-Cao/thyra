import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";

/**
 * Languages for fenced code (the prompt editor's live preview, the agent
 * transcript's code blocks and diffs), each downloaded the first time code
 * names it: by a fence's info string, or by a file's extension.
 */
const legacy =
  (load: () => Promise<Parameters<typeof StreamLanguage.define>[0]>) =>
  async () =>
    new LanguageSupport(StreamLanguage.define(await load()));

export const codeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx", "mjs", "cjs", "javascript"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true }),
      ),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx", "typescript"],
    extensions: ["ts", "tsx", "mts", "cts"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py", "python"],
    extensions: ["py", "pyi"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json", "jsonc", "json5"],
    extensions: ["json", "jsonc", "json5"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs", "rust"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    extensions: ["go"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yaml", "yml"],
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["sh", "bash", "zsh", "shell", "console", "fish"],
    extensions: ["sh", "bash", "zsh", "fish"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
    ),
  }),
  LanguageDescription.of({
    name: "TOML",
    alias: ["toml"],
    extensions: ["toml"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
    ),
  }),
  LanguageDescription.of({
    name: "Diff",
    alias: ["diff", "patch"],
    extensions: ["diff", "patch"],
    load: legacy(() =>
      import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
    ),
  }),
];
