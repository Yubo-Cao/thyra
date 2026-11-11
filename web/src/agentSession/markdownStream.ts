import { marked, type Token } from "marked";

// Agent replies arrive a few characters at a time. Two things keep a reply
// steady while it grows: only its last top-level block is parsed again, and
// Markdown that is still half received is closed (or held back) so it does
// not flash as literal markers first.

export type MarkdownBlock = {
  /** Where the block starts in the source text. */
  start: number;
  token: Token;
};

export type MarkdownStream = {
  text: string;
  blocks: readonly MarkdownBlock[];
  /** Block offsets match the source, so the next parse may start at the last. */
  exact: boolean;
};

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** The marker of the code fence `lines` end inside, if they do. */
function openFence(lines: readonly string[]): string | null {
  let open: string | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const [, marker, rest] = match;
    if (!open) {
      // A backtick fence's info string has no backticks: that is inline code.
      if (marker[0] !== "`" || !rest.includes("`")) open = marker;
    } else if (
      marker[0] === open[0] &&
      marker.length >= open.length &&
      !rest.trim()
    ) {
      open = null;
    }
  }
  return open;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|");

/** Whether `rule` completes a table under `header`: one dash run per column. */
function tableRule(header: string, rule: string): boolean {
  const columns = cells(rule);
  return (
    columns.length === cells(header).length &&
    columns.every((column) => /^\s*:?-+:?\s*$/.test(column))
  );
}

/** Closes inline code, bold, strikethrough and links left open at the end. */
function closeInline(paragraph: string): string {
  let code: string | null = null;
  let opened = 0;
  let plain = "";
  let index = 0;
  for (const match of paragraph.matchAll(/`+/g)) {
    if (code === null) {
      plain += paragraph.slice(index, match.index);
      code = match[0];
      opened = match.index;
    } else if (match[0] === code) {
      code = null;
    } else {
      continue;
    }
    index = match.index + match[0].length;
  }
  if (code !== null) {
    // Nothing follows the opening backticks yet: hold them back.
    return opened + code.length === paragraph.length
      ? paragraph.slice(0, opened)
      : paragraph + code;
  }
  plain += paragraph.slice(index);
  // A link shows its text until its address is complete; an image waits.
  let repaired = paragraph
    .replace(/(!?)\[([^\]\n]*)\]\([^)\n]*$/, (_match, image, label) =>
      image ? "" : label,
    )
    .replace(/!?\[([^\]\n]*)$/, "$1");
  for (const marker of ["**", "~~"]) {
    if ((plain.split(marker).length - 1) % 2 === 0) continue;
    repaired = repaired.endsWith(marker)
      ? repaired.slice(0, -marker.length)
      : repaired.replace(/\s+$/, "") + marker;
  }
  // An emphasis marker that has only just arrived.
  return repaired.replace(/(^|[\s(])[*_]$/, "$1");
}

/**
 * A half-received reply as it should be drawn now: unfinished fences, code
 * spans, bold text and links render as they will once complete, and a marker
 * that is still arriving (a fence, a heading, a rule) is held back.
 */
export function repairStreamingMarkdown(text: string): string {
  const lines = text.split("\n");
  const last = lines.pop() ?? "";
  const fence = openFence(lines);
  if (fence) {
    // Inside a code block only a partial closing fence is not code.
    const marker = last.trim();
    return marker &&
      marker.length < fence.length &&
      marker === fence[0].repeat(marker.length)
      ? lines.join("\n")
      : text;
  }
  const previous = lines[lines.length - 1] ?? "";
  // A table's header (and the rule under it, while that is typed) would show
  // as a line of pipes until the rule completes.
  const ended = last === "" ? lines : [...lines, last];
  let pipes = 0;
  while (ended[ended.length - 1 - pipes]?.trimStart().startsWith("|")) pipes++;
  if (
    pipes === 1 ||
    (pipes === 2 &&
      !tableRule(ended[ended.length - 2], ended[ended.length - 1]))
  )
    return ended.slice(0, ended.length - pipes).join("\n");
  if (
    /^\s*(`{1,2}|~{1,2}|#{1,6})$/.test(last) ||
    // Under a line of text this would flash as a heading underline.
    (/^\s*(-+|=+)\s*$/.test(last) && previous.trim() !== "")
  )
    return lines.join("\n");
  // Inline repairs stay within the last paragraph, after any closed fence.
  let from = lines.length;
  while (
    from > 0 &&
    lines[from - 1].trim() !== "" &&
    !FENCE.test(lines[from - 1])
  )
    from--;
  const paragraph = [...lines.slice(from), last].join("\n");
  return text.slice(0, text.length - paragraph.length) + closeInline(paragraph);
}

const LEX_OPTIONS = { gfm: true, breaks: true } as const;

/**
 * Top-level blocks of `text`. A block that is unchanged since `previous`
 * stays the same object, so its view does not render again; when `text` only
 * grew, parsing resumes at the block before the last (new text can also join
 * that one: a list item after a list, a line after a quote).
 */
export function lexMarkdownStream(
  text: string,
  streaming: boolean,
  previous?: MarkdownStream,
): MarkdownStream {
  const known = previous?.blocks ?? [];
  const blocks: MarkdownBlock[] = [];
  let offset = 0;
  const resume = known.length - 2;
  if (previous?.exact && resume > 0 && text.startsWith(previous.text)) {
    blocks.push(...known.slice(0, resume));
    offset = known[resume].start;
  }
  const source = text.slice(offset);
  let exact = !text.includes("\r");
  let at = offset;
  const tokens = marked.lexer(
    streaming ? repairStreamingMarkdown(source) : source,
    LEX_OPTIONS,
  );
  for (const [index, token] of tokens.entries()) {
    // Only the final token may differ from the source (it was repaired).
    if (index < tokens.length - 1 && !text.startsWith(token.raw, at))
      exact = false;
    if (token.type !== "space" && token.type !== "def") {
      const same = known[blocks.length];
      blocks.push(
        same?.start === at && same.token.raw === token.raw
          ? same
          : { start: at, token },
      );
    }
    at += token.raw.length;
  }
  return { text, blocks, exact };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Text of a Markdown text token: the lexer leaves HTML entities encoded. */
export function decodeMarkdownText(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi,
    (entity, name: string) => {
      if (name[0] !== "#") return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
      const code =
        name[1].toLowerCase() === "x"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
}
