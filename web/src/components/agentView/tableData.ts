import type { Token, Tokens } from "marked";
import { decodeMarkdownText } from "../../agentSession/markdownStream";

/** A Markdown table as plain cell text, header first, and its alignments. */
export type TableData = {
  rows: string[][];
  align: (Tokens.TableCell["align"] | undefined)[];
  /** Each cell's own Markdown, as the reply wrote it. */
  markdown: string[][];
};

/** The text a run of inline tokens reads as: no markers, no markup. */
export function inlineText(tokens: readonly Token[] | undefined): string {
  return (tokens ?? [])
    .map((token): string => {
      switch (token.type) {
        case "text":
        case "escape": {
          const text = token as Tokens.Text;
          return text.tokens
            ? inlineText(text.tokens)
            : decodeMarkdownText(text.text);
        }
        case "strong":
        case "em":
        case "del":
        case "link":
          return inlineText(token.tokens);
        case "codespan":
          return token.text;
        case "image":
          return token.text || token.href;
        case "br":
          return "\n";
        case "html":
          return /^<br\s*\/?>$/i.test(token.text) ? "\n" : token.text;
        default:
          return token.raw ?? "";
      }
    })
    .join("");
}

export function tableData(table: Tokens.Table): TableData {
  const rows = [table.header, ...table.rows];
  return {
    rows: rows.map((row) => row.map((cell) => inlineText(cell.tokens))),
    markdown: rows.map((row) =>
      row.map((cell) => cell.text.trim().replace(/\|/g, "\\|")),
    ),
    align: table.align.map((align) => align ?? undefined),
  };
}

/** Tab-separated, as spreadsheets paste it: quoted where a cell needs it. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          /[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell,
        )
        .join("\t"),
    )
    .join("\n");
}

/** RFC 4180 CSV with CRLF line ends. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          /[",\n\r]/.test(cell) || /^\s|\s$/.test(cell)
            ? `"${cell.replace(/"/g, '""')}"`
            : cell,
        )
        .join(","),
    )
    .join("\r\n")
    .concat("\r\n");
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

/** An HTML table of the cells' text, for pasting as cells. */
export function toHtmlTable(rows: readonly (readonly string[])[]): string {
  const [header = [], ...body] = rows;
  const cells = (row: readonly string[], tag: string) =>
    `<tr>${row
      .map(
        (cell) => `<${tag}>${escapeHtml(cell).replace(/\n/g, "<br>")}</${tag}>`,
      )
      .join("")}</tr>`;
  return `<table><thead>${cells(header, "th")}</thead><tbody>${body
    .map((row) => cells(row, "td"))
    .join("")}</tbody></table>`;
}

const ALIGN_RULE = {
  left: ":---",
  center: ":---:",
  right: "---:",
} as const;

/** A GitHub-flavoured Markdown table. Cells are Markdown already. */
export function toMarkdownTable(
  rows: readonly (readonly string[])[],
  align: readonly (string | null | undefined)[] = [],
): string {
  const [header = [], ...body] = rows;
  const columns = Math.max(header.length, ...body.map((row) => row.length));
  const line = (row: readonly string[]) =>
    `| ${Array.from({ length: columns }, (_, index) =>
      (row[index] ?? "").replace(/\r?\n/g, "<br>"),
    ).join(" | ")} |`;
  const rule = `| ${Array.from(
    { length: columns },
    (_, index) => ALIGN_RULE[align[index] as keyof typeof ALIGN_RULE] ?? "---",
  ).join(" | ")} |`;
  return [line(header), rule, ...body.map(line)].join("\n");
}
