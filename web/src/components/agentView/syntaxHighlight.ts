import {
  LanguageDescription,
  type LanguageSupport,
} from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { codeLanguages } from "../promptEditor/codeLanguages";
import type { HighlightSpan } from "./highlightSpans";

// Loaded with the first code the transcript highlights: the parsers it
// shares with the prompt editor's live preview, and its language chunks on
// demand. Colours are classes the theme tokens style (AgentView.css).
const highlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier],
    class: "agent-hl-keyword",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted],
    class: "agent-hl-string",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    class: "agent-hl-number",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    class: "agent-hl-comment",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.macroName,
    ],
    class: "agent-hl-function",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    class: "agent-hl-type",
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.labelName],
    class: "agent-hl-property",
  },
  {
    tag: [tags.definition(tags.variableName), tags.self],
    class: "agent-hl-variable",
  },
  {
    tag: [tags.operator, tags.compareOperator, tags.arithmeticOperator],
    class: "agent-hl-operator",
  },
  {
    tag: [tags.meta, tags.processingInstruction, tags.heading],
    class: "agent-hl-meta",
  },
  { tag: [tags.deleted, tags.invalid], class: "agent-hl-deleted" },
]);

/** Past this, code shows plain: parsing it would hold up the page. */
const MAX_CODE = 60_000;
const CACHE_SIZE = 300;
const cache = new Map<string, HighlightSpan[] | null>();
const supports = new Map<LanguageDescription, LanguageSupport>();

/** A fence's info string or a file name, as one of the known languages. */
function describe(lang: string): LanguageDescription | null {
  const name = lang.trim().split(/\s/, 1)[0] ?? "";
  if (!name) return null;
  return (
    LanguageDescription.matchLanguageName(codeLanguages, name, false) ??
    LanguageDescription.matchFilename(codeLanguages, lang.trim())
  );
}

function run(code: string, support: LanguageSupport): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const tree = support.language.parser.parse(code);
  highlightTree(tree, highlighter, (from, to, classes) => {
    spans.push([from, to, classes]);
  });
  return spans;
}

const key = (code: string, lang: string) => `${lang}\u0000${code}`;

function remember(id: string, spans: HighlightSpan[] | null) {
  if (cache.size >= CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, spans);
  return spans;
}

/**
 * Spans already worked out (or quick to: the language is loaded), so a block
 * mounting again draws coloured at once. `undefined`: not known yet.
 */
export function highlightNow(
  code: string,
  lang: string,
): HighlightSpan[] | null | undefined {
  const id = key(code, lang);
  if (cache.has(id)) return cache.get(id);
  const found = describe(lang);
  if (!found || code.length > MAX_CODE) return remember(id, null);
  const support = supports.get(found) ?? found.support;
  return support ? remember(id, run(code, support)) : undefined;
}

/** Highlight `code` as `lang`, loading the language first if needed. */
export async function highlight(
  code: string,
  lang: string,
): Promise<HighlightSpan[] | null> {
  const now = highlightNow(code, lang);
  if (now !== undefined) return now;
  const found = describe(lang)!;
  try {
    supports.set(found, await found.load());
  } catch {
    // A language chunk that does not load leaves the code plain.
    return remember(key(code, lang), null);
  }
  return highlightNow(code, lang) ?? null;
}
