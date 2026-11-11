import { createElement, type ReactNode, useEffect, useState } from "react";

/** A highlighted range of code: offsets and the class that colours it. */
export type HighlightSpan = readonly [from: number, to: number, cls: string];

type Highlighter = typeof import("./syntaxHighlight");
let module: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;
const load = () =>
  (loading ??= import("./syntaxHighlight").then((loaded) => (module = loaded)));

/**
 * Highlight spans for `code` in `lang` (a fence's language or a file name),
 * or null while they load, for an unknown language, or when `enabled` is
 * false (a fence still streaming). The highlighter and each language load
 * the first time code needs them, so plain code draws first.
 */
export function useHighlight(
  code: string,
  lang: string | undefined,
  enabled = true,
): readonly HighlightSpan[] | null {
  const wanted = enabled && !!lang && !!code;
  const ready = wanted ? module?.highlightNow(code, lang) : null;
  const [loaded, setLoaded] = useState<{
    code: string;
    lang: string;
    spans: readonly HighlightSpan[] | null;
  } | null>(null);
  useEffect(() => {
    if (!wanted || ready !== undefined) return;
    let current = true;
    void load()
      .then((highlighter) => highlighter.highlight(code, lang))
      .then(
        (spans) => {
          if (current) setLoaded({ code, lang, spans });
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [code, lang, wanted, ready]);
  if (!wanted) return null;
  if (ready !== undefined) return ready;
  return loaded?.code === code && loaded.lang === lang ? loaded.spans : null;
}

/**
 * `code` as text runs, coloured ones in spans. React escapes the text; no
 * markup from the code is ever interpreted.
 */
export function renderHighlighted(
  code: string,
  spans: readonly HighlightSpan[] | null | undefined,
): ReactNode {
  if (!spans?.length) return code;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to, cls] of spans) {
    if (from < at || to <= from) continue;
    if (from > at) parts.push(code.slice(at, from));
    parts.push(
      createElement(
        "span",
        { key: from, className: cls },
        code.slice(from, to),
      ),
    );
    at = to;
  }
  if (at < code.length) parts.push(code.slice(at));
  return parts;
}

/**
 * Spans of a multi-line document split at its line breaks, each line's
 * offsets relative to its own start.
 */
export function spansByLine(
  text: string,
  spans: readonly HighlightSpan[],
): HighlightSpan[][] {
  const starts = [0];
  for (
    let index = text.indexOf("\n");
    index >= 0;
    index = text.indexOf("\n", index + 1)
  )
    starts.push(index + 1);
  const lines: HighlightSpan[][] = starts.map(() => []);
  let line = 0;
  for (const [from, to, cls] of spans) {
    while (line + 1 < starts.length && starts[line + 1] <= from) line++;
    let start = from;
    let current = line;
    while (start < to && current < starts.length) {
      const lineStart = starts[current];
      const lineEnd =
        current + 1 < starts.length ? starts[current + 1] - 1 : text.length;
      const end = Math.min(to, lineEnd);
      if (end > start)
        lines[current].push([start - lineStart, end - lineStart, cls]);
      current++;
      start = current < starts.length ? starts[current] : to;
    }
  }
  return lines;
}

/**
 * A diff's lines as the two files they come from, so each side parses as
 * real code: the new file (context and added lines) and the old one
 * (context and removed lines). `at` gives each diff line's side and line.
 */
export function diffSides(lines: readonly { kind: string; text: string }[]): {
  next: string;
  prev: string;
  at: ({ side: "next" | "prev"; line: number } | null)[];
} {
  const next: string[] = [];
  const prev: string[] = [];
  const at = lines.map((line) => {
    if (line.kind === "add") {
      next.push(line.text);
      return { side: "next" as const, line: next.length - 1 };
    }
    if (line.kind === "remove") {
      prev.push(line.text);
      return { side: "prev" as const, line: prev.length - 1 };
    }
    if (line.kind === "context") {
      prev.push(line.text);
      next.push(line.text);
      return { side: "next" as const, line: next.length - 1 };
    }
    return null;
  });
  return { next: next.join("\n"), prev: prev.join("\n"), at };
}
