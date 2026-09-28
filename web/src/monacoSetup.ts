// Monaco for file editing, reached only from the lazy FileEditor: the shared
// core (monacoBase) plus the rest of the editing features and Monarch
// grammars for common languages.
import {
  applyMonacoTheme,
  type MonarchModule,
  monaco,
  registerMonarchLanguage,
} from "./monacoBase";
import "monaco-esm/features/bracketMatching/register.js";
import "monaco-esm/features/caretOperations/register.js";
import "monaco-esm/features/comment/register.js";
import "monaco-esm/features/folding/register.js";
import "monaco-esm/features/gotoLine/register.js";
import "monaco-esm/features/indentation/register.js";
import "monaco-esm/features/lineSelection/register.js";
import "monaco-esm/features/smartSelect/register.js";
import "monaco-esm/features/wordHighlighter/register.js";
import * as bat from "monaco-esm/languages/definitions/bat/bat.js";
import * as cpp from "monaco-esm/languages/definitions/cpp/cpp.js";
import * as csharp from "monaco-esm/languages/definitions/csharp/csharp.js";
import * as css from "monaco-esm/languages/definitions/css/css.js";
import * as dockerfile from "monaco-esm/languages/definitions/dockerfile/dockerfile.js";
import * as go from "monaco-esm/languages/definitions/go/go.js";
import * as graphql from "monaco-esm/languages/definitions/graphql/graphql.js";
import * as hcl from "monaco-esm/languages/definitions/hcl/hcl.js";
import * as html from "monaco-esm/languages/definitions/html/html.js";
import * as ini from "monaco-esm/languages/definitions/ini/ini.js";
import * as java from "monaco-esm/languages/definitions/java/java.js";
import * as javascript from "monaco-esm/languages/definitions/javascript/javascript.js";
import * as kotlin from "monaco-esm/languages/definitions/kotlin/kotlin.js";
import * as less from "monaco-esm/languages/definitions/less/less.js";
import * as lua from "monaco-esm/languages/definitions/lua/lua.js";
import * as markdown from "monaco-esm/languages/definitions/markdown/markdown.js";
import * as perl from "monaco-esm/languages/definitions/perl/perl.js";
import * as php from "monaco-esm/languages/definitions/php/php.js";
import * as powershell from "monaco-esm/languages/definitions/powershell/powershell.js";
import * as protobuf from "monaco-esm/languages/definitions/protobuf/protobuf.js";
import * as python from "monaco-esm/languages/definitions/python/python.js";
import * as r from "monaco-esm/languages/definitions/r/r.js";
import * as ruby from "monaco-esm/languages/definitions/ruby/ruby.js";
import * as rust from "monaco-esm/languages/definitions/rust/rust.js";
import * as scss from "monaco-esm/languages/definitions/scss/scss.js";
import * as shell from "monaco-esm/languages/definitions/shell/shell.js";
import * as sql from "monaco-esm/languages/definitions/sql/sql.js";
import * as swift from "monaco-esm/languages/definitions/swift/swift.js";
import * as typescript from "monaco-esm/languages/definitions/typescript/typescript.js";
import * as xml from "monaco-esm/languages/definitions/xml/xml.js";
import * as yaml from "monaco-esm/languages/definitions/yaml/yaml.js";
import { syntaxLanguageForPath } from "./syntaxLanguage";

// Keyed by the Shiki ids of syntaxLanguageForPath. JSON has no Monarch
// grammar in Monaco; its JavaScript grammar tokenizes JSON well enough.
const GRAMMARS: Record<string, MonarchModule> = {
  bash: shell,
  bat,
  c: cpp,
  cpp,
  csharp,
  css,
  dockerfile,
  fish: shell,
  go,
  graphql,
  hcl,
  html,
  ini,
  java,
  javascript,
  json: javascript,
  json5: javascript,
  jsonc: javascript,
  jsonl: javascript,
  jsx: javascript,
  kotlin,
  less,
  lua,
  markdown,
  mdx: markdown,
  nginx: ini,
  perl,
  php,
  powershell,
  properties: ini,
  protobuf,
  python,
  r,
  ruby,
  rust,
  sass: scss,
  scss,
  shell,
  sql,
  swift,
  toml: ini,
  tsx: typescript,
  typescript,
  xml,
  yaml,
};

/** Monaco language id for a path; files without a grammar edit as plain text. */
export function monacoLanguageForPath(path: string) {
  const language = syntaxLanguageForPath(path);
  return language in GRAMMARS ? language : "plaintext";
}

for (const [id, grammar] of Object.entries(GRAMMARS))
  registerMonarchLanguage(id, grammar);

export { applyMonacoTheme, monaco };
