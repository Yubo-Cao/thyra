// Shiki entry for Thyra; Vite also aliases `shiki` here for Pierre's diffs.
import {
  codeToHtml,
  createCssVariablesTheme,
  createHighlighterCore,
  getTokenStyleObject,
  stringifyTokenStyle,
} from "@shikijs/core";
import {
  createJavaScriptRegexEngine as createEngine,
  defaultJavaScriptRegexConstructor,
  type JavaScriptRegexEngineOptions,
} from "shiki/engine/javascript";
export { bundledLanguages } from "./syntaxLanguage";
export { createOnigurumaEngine } from "shiki/engine/oniguruma";

/**
 * Spell start anchors as `(?<![^])`, which means the same for the single
 * lines TextMate scans. JavaScriptCore (Safari) never matches patterns such as
 * `(^\s+)?//`, so TypeScript line comments would otherwise lose highlighting.
 */
export function withoutStartAnchors(source: string, unicodeSets: boolean) {
  let result = "";
  let classDepth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") {
      result += char + (source[++index] ?? "");
      continue;
    }
    if (char === "[" && (unicodeSets || !classDepth)) classDepth++;
    else if (char === "]" && classDepth) classDepth--;
    else if (char === "^" && !classDepth) {
      result += "(?<![^])";
      continue;
    }
    result += char;
  }
  return result;
}

function regexConstructor(pattern: string) {
  const regex = defaultJavaScriptRegexConstructor(pattern);
  const source = withoutStartAnchors(regex.source, regex.flags.includes("v"));
  if (source === regex.source) return regex;
  // Rebuild emulated regexes (oniguruma-to-es subclasses) with their options.
  const Regex = regex.constructor as new (
    source: string,
    flags: string,
    options?: unknown,
  ) => RegExp;
  return new Regex(
    source,
    regex.flags,
    (regex as { rawOptions?: unknown }).rawOptions,
  );
}

export const createJavaScriptRegexEngine = (
  options: JavaScriptRegexEngineOptions = {},
) => createEngine({ regexConstructor, ...options });

export const createHighlighter = createHighlighterCore;
export {
  codeToHtml,
  createCssVariablesTheme,
  getTokenStyleObject,
  stringifyTokenStyle,
};
