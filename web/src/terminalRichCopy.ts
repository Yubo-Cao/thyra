import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/xterm";
import {
  normalizeTerminalSelection,
  type ClipboardContent,
} from "./terminalClipboard";
import { findTerminalFileLinkCandidates } from "./terminalFileLinks";
import { findTerminalHttpLinks } from "./terminalLinks";

const serializers = new WeakMap<Terminal, SerializeAddon>();

export function installTerminalSerializer(term: Terminal) {
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  serializers.set(term, addon);
}

function absolutePath(path: string, root?: string) {
  return path.startsWith("/")
    ? path
    : root
      ? `${root.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`
      : null;
}

function fileUrl(path: string) {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Linkify text nodes, never interpolate terminal text into HTML. */
export function enrichTerminalClipboard(
  html: string,
  text: string,
  root?: string,
): ClipboardContent {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest("a")) continue;
    const value = node.data;
    const urls = findTerminalHttpLinks(value);
    const links = [
      ...urls.map((link) => ({ ...link, href: link.url })),
      ...findTerminalFileLinkCandidates(value, urls).flatMap((link) => {
        const path = absolutePath(link.path, root);
        return path ? [{ ...link, href: fileUrl(path) }] : [];
      }),
    ].sort((a, b) => a.start - b.start);
    if (!links.length) continue;
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const link of links) {
      fragment.append(value.slice(offset, link.start));
      const anchor = doc.createElement("a");
      anchor.href = link.href;
      anchor.textContent = value.slice(link.start, link.end);
      fragment.append(anchor);
      offset = link.end;
    }
    fragment.append(value.slice(offset));
    node.replaceWith(fragment);
  }
  for (const anchor of doc.body.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href")!;
    const candidate = findTerminalFileLinkCandidates(href)[0];
    if (candidate?.start === 0 && candidate.end === href.length) {
      const path = absolutePath(candidate.path, root);
      if (path) anchor.setAttribute("href", fileUrl(path));
    }
  }
  // A path-only selection should paste into the file explorer as a host path,
  // not a Markdown wrapper, browser-relative URL, or percent-escaped URI.
  const trimmed = text.trim();
  const candidate = findTerminalFileLinkCandidates(trimmed)[0];
  if (candidate?.start === 0 && candidate.end === trimmed.length) {
    text = absolutePath(candidate.path, root) ?? text;
  }
  return { text, html: doc.body.innerHTML };
}

export function terminalSelectionContent(
  text: string,
  term?: Terminal | null,
  root?: string,
): ClipboardContent {
  const plain = normalizeTerminalSelection(text);
  const serializer = term ? serializers.get(term) : undefined;
  // History can contain rows no longer in xterm. Never export a different range.
  if (
    serializer &&
    term?.hasSelection() &&
    normalizeTerminalSelection(term.getSelection()) === plain
  ) {
    return enrichTerminalClipboard(
      serializer.serializeAsHTML({ onlySelection: true }),
      plain,
      root,
    );
  }
  const pre = document.createElement("pre");
  pre.textContent = plain;
  return enrichTerminalClipboard(pre.outerHTML, plain, root);
}

/** Agent-owned selections arrive as Markdown through OSC 52. */
export async function terminalMarkdownContent(
  text: string,
  root?: string,
): Promise<ClipboardContent> {
  const { renderMarkdown } = await import("./components/markdown");
  const html = renderMarkdown(text, { breaks: true });
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const br of doc.body.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of doc.body.querySelectorAll(
    "p, pre, li, h1, h2, h3, h4, h5, h6, tr",
  ))
    block.append("\n");
  return enrichTerminalClipboard(
    html,
    (doc.body.textContent ?? text).trim(),
    root,
  );
}
