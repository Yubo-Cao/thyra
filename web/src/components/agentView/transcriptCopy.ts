import { domToMarkdown, type MarkdownSourceNode } from "./domMarkdown";

/** The transcript's content root; selections inside it copy as Markdown. */
const ROOT = ".agent-transcript-content";

/**
 * The selection as Markdown and HTML, or null where the browser's own copy
 * is the right one: nothing selected, outside the transcript, inside one
 * run of text, or inside code (which copies as the code itself).
 */
export function selectionClipboard(
  selection: Selection | null,
): { text: string; html: string } | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  if (common.nodeType !== Node.ELEMENT_NODE) return null;
  const element = common as Element;
  const root = element.closest(ROOT);
  if (!root) return null;
  if (element.closest("pre, [data-md-code], code")) return null;
  // The copied part, inside shallow copies of the elements around it, so a
  // run of list items stays a list and cells stay in their table.
  let content: Node = range.cloneContents();
  for (
    let ancestor: Element | null = element;
    ancestor && ancestor !== root && root.contains(ancestor);
    ancestor = ancestor.parentElement
  ) {
    const shell = ancestor.cloneNode(false) as Element;
    shell.append(content);
    content = shell;
  }
  const holder = document.createElement("div");
  holder.append(content);
  const text = domToMarkdown(holder as unknown as MarkdownSourceNode);
  if (!text.trim()) return null;
  // The HTML of the transcript's own elements, minus their controls.
  for (const chrome of holder.querySelectorAll("[data-md-skip]"))
    chrome.remove();
  return { text, html: holder.innerHTML };
}

let installed = false;

/** Copying a transcript selection puts Markdown on the clipboard as text. */
export function installTranscriptCopy() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("copy", (event) => {
    if (event.defaultPrevented || !event.clipboardData) return;
    const content = selectionClipboard(document.getSelection());
    if (!content) return;
    event.clipboardData.setData("text/plain", content.text);
    event.clipboardData.setData("text/html", content.html);
    event.preventDefault();
  });
}
