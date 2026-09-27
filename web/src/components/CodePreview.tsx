import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { t } from "../i18n";
import { shortcutMatches } from "../shortcutPreferences";
import { bundledLanguages } from "../syntaxLanguage";
import { plainCodeHtml } from "./codeHighlight";
import type {
  HighlightRequest,
  HighlightResponse,
} from "./codeHighlight.worker";
import {
  isEditablePreviewTarget,
  isPreviewKeyboardTarget,
  selectAllInPreviewElement,
} from "./previewSelection";
import { CloseButton } from "./ui/CloseButton";
import { IconButton } from "./ui/IconButton";
import { SearchField } from "./ui/SearchField";
import "./CodePreview.css";

export type CodePreviewHandle = { openSearch(): void; selectAll(): void };

// Painting more search matches than this slows typing; the count stays exact.
const MAX_PAINTED_MATCHES = 5_000;

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, (html: string | null) => void>();
const sentLanguages = new Set<string>();

function highlightWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./codeHighlight.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }: MessageEvent<HighlightResponse>) => {
    pending.get(data.id)?.(data.html);
    pending.delete(data.id);
  };
  worker.onerror = () => {
    // Previews stay plain; the next one starts a fresh worker.
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
    sentLanguages.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Highlight `text` in a worker. Grammars are lazy chunks shared with the diff
 * viewer and are sent to the worker once. Resolves null for plain text.
 */
async function highlightCode(text: string, language: string) {
  const load = bundledLanguages[language as keyof typeof bundledLanguages];
  if (!load || !text) return null;
  const grammar = sentLanguages.has(language)
    ? undefined
    : (await load()).default;
  const target = highlightWorker();
  sentLanguages.add(language);
  const request: HighlightRequest = {
    id: ++nextRequestId,
    text,
    language,
    grammar,
  };
  return new Promise<string | null>((resolve) => {
    pending.set(request.id, resolve);
    target.postMessage(request);
  });
}

/** DOM ranges for text offsets, skipping the line-number pseudo-elements. */
function textRanges(root: HTMLElement, offsets: number[], length: number) {
  const nodes: Text[] = [];
  const starts: number[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (
    let total = 0, node = walker.nextNode();
    node;
    node = walker.nextNode()
  ) {
    nodes.push(node as Text);
    starts.push(total);
    total += node.nodeValue?.length ?? 0;
  }
  const locate = (offset: number) => {
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return [nodes[low], offset - starts[low]] as const;
  };
  return offsets.map((offset) => {
    const range = document.createRange();
    range.setStart(...locate(offset));
    range.setEnd(...locate(offset + length));
    return range;
  });
}

/**
 * Read-only code view: Shiki highlighting from a worker over an immediate
 * plain rendering, line numbers, find, and native select-all/copy. With a
 * `handle`, the parent owns the find and select-all shortcuts.
 */
export function CodePreview({
  text,
  language,
  handle,
}: {
  text: string;
  language: string;
  handle?: Ref<CodePreviewHandle>;
}) {
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const codeRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [revision, setRevision] = useState(0);
  const source = useMemo(() => text.replace(/\r\n?/g, "\n"), [text]);
  const gutter = String(source.split("\n").length).length;

  useEffect(() => {
    const code = codeRef.current;
    if (!code) return;
    let cancelled = false;
    code.innerHTML = plainCodeHtml(source);
    setRevision((value) => value + 1);
    void highlightCode(source, language).then((html) => {
      if (cancelled || html === null) return;
      code.innerHTML = html;
      setRevision((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [language, source]);

  const matches = useMemo(() => {
    if (!searchOpen || !query) return [];
    const pattern = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "giu",
    );
    return Array.from(source.matchAll(pattern), (match) => match.index);
  }, [query, searchOpen, source]);

  useEffect(() => setCurrent(0), [matches]);

  useEffect(() => {
    const code = codeRef.current;
    const scroller = scrollRef.current;
    const highlights = globalThis.CSS?.highlights;
    if (!code || !scroller || !matches.length) return;
    const index = Math.min(current, matches.length - 1);
    const painted = matches.slice(0, MAX_PAINTED_MATCHES);
    const [active, ...all] = textRanges(
      code,
      [matches[index], ...painted],
      query.length,
    );
    highlights?.set("code-preview-match", new Highlight(...all));
    highlights?.set("code-preview-current", new Highlight(active));
    const box = scroller.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    scroller.scrollTop += rect.top - box.top - scroller.clientHeight / 2;
    if (rect.left < box.left + gutter * 8 + 40 || rect.right > box.right)
      scroller.scrollLeft += rect.left - box.left - scroller.clientWidth / 2;
    return () => {
      highlights?.delete("code-preview-match");
      highlights?.delete("code-preview-current");
    };
  }, [current, gutter, matches, query.length, revision]);

  const step = (delta: number) => {
    if (matches.length)
      setCurrent((value) => (value + delta + matches.length) % matches.length);
  };

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.select());
  }, []);
  const closeSearch = () => {
    setSearchOpen(false);
    scrollRef.current?.focus();
  };
  const selectAll = useCallback(() => {
    scrollRef.current?.focus();
    selectAllInPreviewElement(codeRef.current);
  }, []);
  useImperativeHandle(handle, () => ({ openSearch, selectAll }), [
    openSearch,
    selectAll,
  ]);

  useEffect(() => {
    if (handle) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".shortcut-modal"))
        return;
      const find = shortcutMatches(e, "preview.search");
      if (!find && !shortcutMatches(e, "preview.selectAll")) return;
      const scroller = scrollRef.current;
      if (!scroller || scroller.offsetParent === null) return;
      if (isEditablePreviewTarget(e.target)) return;
      if (
        find
          ? !scroller.contains(e.target as Node)
          : !isPreviewKeyboardTarget(scroller, e.target)
      )
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (find) openSearch();
      else selectAll();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handle, openSearch, selectAll]);

  return (
    <div className="code-preview">
      {searchOpen ? (
        <div className="ui-bar code-preview-search">
          <SearchField
            ref={searchRef}
            fullWidth
            value={query}
            onValueChange={setQuery}
            placeholder={t("Find")}
            aria-label={t("Find")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape" && !query) {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              } else if (shortcutMatches(e.nativeEvent, "preview.search")) {
                e.preventDefault();
                e.currentTarget.select();
              }
            }}
          />
          <span className="code-preview-search-count" role="status">
            {query
              ? matches.length
                ? `${Math.min(current, matches.length - 1) + 1}/${matches.length}`
                : t("No results")
              : ""}
          </span>
          <IconButton
            label={t("Previous match")}
            disabled={!matches.length}
            onClick={() => step(-1)}
            icon={<ChevronUp size={14} />}
          />
          <IconButton
            label={t("Next match")}
            disabled={!matches.length}
            onClick={() => step(1)}
            icon={<ChevronDown size={14} />}
          />
          <CloseButton label={t("Close search")} onClick={closeSearch} />
        </div>
      ) : null}
      <pre ref={scrollRef} className="code-preview-scroll" tabIndex={0}>
        <code
          ref={codeRef}
          className="code-preview-code"
          style={{ ["--code-gutter" as string]: `${gutter}ch` }}
        />
      </pre>
    </div>
  );
}
