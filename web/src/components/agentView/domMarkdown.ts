/**
 * Markdown from the transcript's own rendered elements, for copying a
 * selection: headings, lists, emphasis, links, code (with the language a
 * block carries in `data-lang`), quotes and tables. It reads only the few
 * shapes the transcript draws, through the small part of the DOM a test can
 * stand in for. Elements marked `data-md-skip` (buttons' chrome, diff line
 * numbers) are left out; `data-md-code` marks a block copied as code.
 */
export type MarkdownSourceNode = {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<MarkdownSourceNode>;
  getAttribute?(name: string): string | null;
};

const TEXT = 3;
const ELEMENT = 1;

const BLOCKS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "PRE",
  "BLOCKQUOTE",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "HR",
  "BUTTON",
]);

const children = (node: MarkdownSourceNode) => Array.from(node.childNodes);
const tag = (node: MarkdownSourceNode) => node.nodeName.toUpperCase();
const attr = (node: MarkdownSourceNode, name: string) =>
  node.getAttribute?.(name) ?? null;
const skipped = (node: MarkdownSourceNode) =>
  node.nodeType === ELEMENT &&
  (attr(node, "data-md-skip") !== null ||
    attr(node, "aria-hidden") === "true" ||
    tag(node) === "SCRIPT" ||
    tag(node) === "STYLE");

/** A code span's text between enough backticks to hold it. */
function codeSpan(text: string): string {
  const longest = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Code's text as written: line breaks between its block lines. */
function codeText(node: MarkdownSourceNode): string {
  if (node.nodeType === TEXT) return node.nodeValue ?? "";
  if (node.nodeType !== ELEMENT || skipped(node)) return "";
  if (tag(node) === "BR") return "\n";
  const lines = children(node).map(codeText);
  // Diff lines are divs: one per line.
  return children(node).some(
    (child) => child.nodeType === ELEMENT && tag(child) === "DIV",
  )
    ? lines.filter((line, index) => line || index < lines.length - 1).join("\n")
    : lines.join("");
}

function fenced(code: string, lang: string): string {
  const body = code.replace(/\n$/, "");
  const longest = Math.max(
    2,
    ...Array.from(body.matchAll(/^\s*(`{3,})/gm), (match) => match[1].length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** Inline content: text with its emphasis, links and code spans. */
function inline(node: MarkdownSourceNode): string {
  if (node.nodeType === TEXT)
    return (node.nodeValue ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== ELEMENT || skipped(node)) return "";
  const task = attr(node, "data-md-task");
  if (task !== null) return `[${task}] `;
  const inner = () => children(node).map(inline).join("");
  const wrap = (marker: string) => {
    const text = inner();
    const core = text.trim();
    if (!core) return text;
    const lead = text.slice(0, text.indexOf(core[0]));
    const trail = text.slice(text.lastIndexOf(core[core.length - 1]) + 1);
    return `${lead}${marker}${core}${marker}${trail}`;
  };
  switch (tag(node)) {
    case "STRONG":
    case "B":
      return wrap("**");
    case "EM":
    case "I":
      return wrap("*");
    case "DEL":
    case "S":
      return wrap("~~");
    case "CODE":
      return codeSpan(codeText(node));
    case "BR":
      return "\n";
    case "A": {
      const text = inner();
      const href = attr(node, "href");
      const url = href?.replace(
        /[()\s]/g,
        (char) =>
          `%${char.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`,
      );
      return url ? `[${text}](${url})` : text;
    }
    case "IMG":
      return attr(node, "alt") ?? "";
    case "SVG":
      return "";
    default:
      return inner();
  }
}

/** The Markdown blocks `node`'s children make, in order. */
function blocks(node: MarkdownSourceNode): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    const text = run
      .split("\n")
      .map((line) => line.trim())
      .join("  \n")
      .trim();
    if (text) out.push(text);
    run = "";
  };
  for (const child of children(node)) {
    if (
      child.nodeType === ELEMENT &&
      !skipped(child) &&
      (BLOCKS.has(tag(child)) || attr(child, "data-md-code") !== null)
    ) {
      flush();
      out.push(...block(child));
    } else {
      run += inline(child);
    }
  }
  flush();
  return out;
}

function list(node: MarkdownSourceNode, ordered: boolean): string {
  const start = Number(attr(node, "start") ?? 1) || 1;
  return children(node)
    .filter((child) => child.nodeType === ELEMENT && tag(child) === "LI")
    .map((item, index) => {
      const marker = ordered ? `${start + index}. ` : "- ";
      // A tight item (no paragraphs) keeps its nested list on the next line.
      const loose = children(item).some(
        (child) => child.nodeType === ELEMENT && tag(child) === "P",
      );
      const body = blocks(item).join(loose ? "\n\n" : "\n");
      const indent = " ".repeat(marker.length);
      return (
        marker +
        body
          .split("\n")
          .map((line, at) => (at && line ? indent + line : line))
          .join("\n")
      );
    })
    .join("\n");
}

const cellText = (cell: MarkdownSourceNode) =>
  inline(cell).trim().replace(/\n/g, "<br>").replace(/\|/g, "\\|");

function table(node: MarkdownSourceNode): string {
  const rows: MarkdownSourceNode[] = [];
  const collect = (parent: MarkdownSourceNode) => {
    for (const child of children(parent)) {
      if (child.nodeType !== ELEMENT) continue;
      if (tag(child) === "TR") rows.push(child);
      else if (["THEAD", "TBODY", "TFOOT"].includes(tag(child))) collect(child);
    }
  };
  collect(node);
  const cells = rows.map((row) =>
    children(row).filter(
      (cell) =>
        cell.nodeType === ELEMENT && (tag(cell) === "TH" || tag(cell) === "TD"),
    ),
  );
  if (!cells.length) return "";
  const columns = Math.max(...cells.map((row) => row.length));
  const line = (row: string[]) =>
    `| ${Array.from({ length: columns }, (_, index) => row[index] ?? "").join(" | ")} |`;
  const rule = Array.from({ length: columns }, (_, index) => {
    const style = attr(cells[0][index] ?? cells[0][0], "style") ?? "";
    const align = /text-align:\s*(left|center|right)/.exec(style)?.[1];
    return align === "center"
      ? ":---:"
      : align === "right"
        ? "---:"
        : align === "left"
          ? ":---"
          : "---";
  });
  const [head, ...body] = cells.map((row) => row.map(cellText));
  return [line(head), line(rule), ...body.map(line)].join("\n");
}

function block(node: MarkdownSourceNode): string[] {
  const code = attr(node, "data-md-code");
  if (code !== null) return [fenced(codeText(node), code)];
  const name = tag(node);
  switch (name) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const text = inline(node).replace(/\s+/g, " ").trim();
      return text ? [`${"#".repeat(Number(name[1]))} ${text}`] : [];
    }
    case "PRE": {
      const code = children(node).find(
        (child) => child.nodeType === ELEMENT && tag(child) === "CODE",
      );
      return [fenced(codeText(code ?? node), attr(node, "data-lang") ?? "")];
    }
    case "UL":
    case "OL": {
      const text = list(node, name === "OL");
      return text ? [text] : [];
    }
    case "BLOCKQUOTE": {
      const text = blocks(node).join("\n\n");
      return text
        ? [
            text
              .split("\n")
              .map((line) => (line ? `> ${line}` : ">"))
              .join("\n"),
          ]
        : [];
    }
    case "TABLE": {
      const text = table(node);
      return text ? [text] : [];
    }
    case "HR":
      return ["---"];
    default:
      return blocks(node);
  }
}

/** `root`'s content (a copied fragment, say) as Markdown. */
export function domToMarkdown(root: MarkdownSourceNode): string {
  return (
    root.nodeType === ELEMENT && BLOCKS.has(tag(root))
      ? block(root)
      : blocks(root)
  ).join("\n\n");
}
