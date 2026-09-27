import type { LanguageRegistration } from "@shikijs/core";

// Shiki language ids by file extension, shared by the preview, the diff viewer,
// and the editor (monacoSetup registers its grammars under the same ids).
const EXTENSIONS: Readonly<Record<string, string>> = {
  awk: "awk",
  bash: "bash sh zsh ksh",
  bat: "bat cmd",
  c: "c",
  clojure: "clj cljc cljs clojure edn",
  cpp: "cc cpp cxx h hh hpp hxx c++ h++",
  crystal: "cr crystal",
  csharp: "cs csharp c#",
  csp: "csp",
  css: "css",
  dart: "dart",
  diff: "diff patch",
  dockerfile: "dockerfile docker",
  elixir: "ex exs elixir",
  elm: "elm",
  erlang: "erl hrl erlang",
  fish: "fish",
  fsharp: "fs fsi fsx fsharp f#",
  go: "go golang",
  graphql: "graphql gql",
  groovy: "groovy gradle gvy",
  handlebars: "hbs handlebars htmlbars",
  haskell: "hs lhs purs haskell",
  hcl: "hcl tf",
  html: "htm html",
  ini: "ini cfg",
  java: "java jsp",
  javascript: "js cjs mjs gs javascript",
  json: "json",
  json5: "json5",
  jsonc: "jsonc",
  jsonl: "jsonl",
  jsx: "jsx",
  kotlin: "kt kts kotlin",
  less: "less",
  lisp: "lisp cl lsp",
  lua: "lua pluto",
  makefile: "mk mak make makefile",
  markdown: "md markdown mdown mkd mkdn mkdown",
  mdx: "mdx",
  nginx: "conf nginx nginxconf",
  "objective-c": "m objc objectivec obj-c",
  "objective-cpp": "mm obj-c++ objective-c++",
  perl: "pl pm t perl",
  php: "php phtml",
  powershell: "ps1 psd1 psm1 ps pwsh powershell",
  properties: "properties",
  protobuf: "proto protobuf",
  python: "py pyi pyw gyp ipython python",
  r: "r",
  ruby: "rb rbw rake gemspec podspec ru arb builder jbuilder rabl thor irb ruby",
  rust: "rs rust",
  sass: "sass",
  scala: "scala sc",
  scss: "scss",
  shell: "console shellsession shell",
  sql: "sql cql pgsql postgres postgresql",
  swift: "swift",
  toml: "toml",
  tsx: "tsx",
  typescript: "ts cts mts typescript",
  vue: "vue",
  xml: "xml svg plist xhtml xsd xsl xjb rss atom wsf",
  yaml: "yaml yml",
};

const LANGUAGE_BY_EXTENSION = new Map(
  Object.entries(EXTENSIONS).flatMap(([language, extensions]) =>
    extensions.split(" ").map((extension) => [extension, language] as const),
  ),
);

const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = {
  containerfile: "dockerfile",
  dockerfile: "dockerfile",
  gnumakefile: "makefile",
  makefile: "makefile",
  gemfile: "ruby",
  podfile: "ruby",
  rakefile: "ruby",
  ".bashrc": "bash",
  ".env": "bash",
  ".profile": "bash",
  ".zshrc": "bash",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
};

/** Shiki language id for a path, or "text" when none applies. */
export function syntaxLanguageForPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const byName = LANGUAGE_BY_NAME[name];
  if (byName) return byName;
  if (name.startsWith(".env.")) return "bash";
  if (/^(?:docker|container)file\./.test(name)) return "dockerfile";
  const dot = name.lastIndexOf(".");
  return (dot > 0 && LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1))) || "text";
}

// Pierre normally imports Shiki's complete language registry, which makes Vite
// emit hundreds of grammar assets. Include the languages supported by Files
// Preview, plus their more specific Shiki variants; keep loading them lazily.
// Import canonical modules: tiny alias wrappers can merge into shared UI chunks
// and pull grammar groups into unrelated feature loads.
export const bundledLanguages = {
  awk: () => import("@shikijs/langs/awk"),
  bash: () => import("@shikijs/langs/shellscript"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  clojure: () => import("@shikijs/langs/clojure"),
  crystal: () => import("@shikijs/langs/crystal"),
  csharp: () => import("@shikijs/langs/csharp"),
  // Shiki has no bundled CSP grammar. Match Preview's directives and strings.
  csp: async (): Promise<{ default: LanguageRegistration[] }> => ({
    default: [
      {
        name: "csp",
        scopeName: "source.csp",
        repository: {},
        patterns: [
          { name: "entity.other.attribute-name.csp", match: "^Content[^:]*" },
          { name: "string.quoted.single.csp", begin: "'", end: "'" },
          {
            name: "keyword.control.csp",
            match:
              "\\b(?:base-uri|child-src|connect-src|default-src|font-src|form-action|frame-ancestors|frame-src|img-src|manifest-src|media-src|object-src|plugin-types|report-uri|sandbox|script-src|style-src|trusted-types|unsafe-hashes|worker-src)\\b",
          },
        ],
      },
    ],
  }),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/docker"),
  elixir: () => import("@shikijs/langs/elixir"),
  elm: () => import("@shikijs/langs/elm"),
  erlang: () => import("@shikijs/langs/erlang"),
  fish: () => import("@shikijs/langs/fish"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  go: () => import("@shikijs/langs/go"),
  groovy: () => import("@shikijs/langs/groovy"),
  handlebars: () => import("@shikijs/langs/handlebars"),
  haskell: () => import("@shikijs/langs/haskell"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json5: () => import("@shikijs/langs/json5"),
  jsonl: () => import("@shikijs/langs/jsonl"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  less: () => import("@shikijs/langs/less"),
  lisp: () => import("@shikijs/langs/common-lisp"),
  lua: () => import("@shikijs/langs/lua"),
  makefile: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  nginx: () => import("@shikijs/langs/nginx"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  "objective-cpp": () => import("@shikijs/langs/objective-cpp"),
  perl: () => import("@shikijs/langs/perl"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  properties: () => import("@shikijs/langs/ini"),
  protobuf: () => import("@shikijs/langs/proto"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  sass: () => import("@shikijs/langs/sass"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  shell: () => import("@shikijs/langs/shellscript"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sh: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  yml: () => import("@shikijs/langs/yaml"),
  zsh: () => import("@shikijs/langs/shellscript"),
} as const;
