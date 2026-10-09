import { keepFocus } from "../ui/keepFocus";
import {
  type EditorSpan,
  measureTerminal,
  type TerminalMetrics,
  useEditorSpan,
} from "./metrics";
import type { TerminalEngine, TerminalTheme } from "../../terminalEngine";
import { CornerDownLeft, X } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AgentKind } from "../../agentKind";
import { t } from "../../i18n";
import { richEditorLoadPolicy } from "../../idlePrefetch";
import { lazyPanel } from "../../lazyWithReload";
import {
  type PromptEditorPlacement,
  promptEditorFrame,
  scanPromptBox,
  agentInputHasText,
  screenShowsSelection,
} from "../../promptBoxDetect";
import { decidePromptEditor } from "../../promptEditorDecision";
import { promptEditorKeyAction } from "../../promptEditorKeys";
import {
  getShortcutSnapshot,
  shortcutLabel,
  shortcutTitle,
} from "../../shortcutPreferences";
import { editorMayTakeFocus } from "../../localEditorPolicy";
import { useStartupSettled } from "../../startupGate";
import {
  clipboardImageFiles,
  insertIntoTerminalComposerDraft,
  composerImageInDraft,
  composerImageToken,
  composerImageUrl,
  readComposerImages,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  submitTerminalComposerDraft,
  uploadTerminalComposerImages,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../../terminalComposer";
import { useTerminalComposerDraft } from "../../useTerminalComposerDraft";
import { LazyBoundary } from "../LazyBoundary";
import { IconButton } from "../ui/IconButton";
import type { PromptImages } from "./livePreview";
import { PromptTextarea } from "./PromptTextarea";
import type {
  PromptEditorFont,
  PromptEditorSurface,
  PromptEditorSurfaceProps,
} from "./surface";
import "./PromptEditor.css";
import { ComposerImages, useComposerImages } from "../ComposerImages";

const promptRichPanel = lazyPanel("prompt-editor-rich", () =>
  import("./PromptCodeMirror").then((module) => module.PromptCodeMirror),
);
const PromptCodeMirror = promptRichPanel.Component;

// Frames can arrive at display rate; the agent's box moves far less often.
const SCAN_INTERVAL_MS = 100;
// Text the agent shows in its own box must stay this long to take over, and
// a send (whose paste passes through the box) holds that off for a while.
const AGENT_TEXT_SETTLE_MS = 250;
const SEND_GRACE_MS = 1500;
// The thumbnail strip of attached images (ComposerImages.css).
const IMAGE_STRIP_HEIGHT = 72;
// The agent's own prompt glyph in the gutter, where it drew it.
const PROMPT_MARKERS: Partial<Record<AgentKind, string>> = {
  claude: "❯",
  codex: "›",
};

/** How TerminalView reaches the editor of its pane. */
export type PromptEditorControl = {
  /** Focuses the editor; false while it is hidden. */
  focus(): boolean;
  hasFocus(): boolean;
  /** Shown over the pane (not hidden for an agent menu). */
  visible(): boolean;
  insertText?(text: string, submit: boolean): Promise<void>;
};

export type PromptEditorProps = {
  draftKey: string;
  agent: AgentKind;
  /** Herdr's agent status for the pane (`blocked` while it asks for input). */
  agentStatus: string | undefined;
  term: TerminalEngine;
  terminalTheme: TerminalTheme;
  /** The pane is the selected one; only it takes focus. */
  active: boolean;
  /** Touch first: a plain textarea and a send button. */
  coarsePointer: boolean;
  /** Focus may move on the user's behalf (see programmaticFocusAllowed). */
  focusAllowed: boolean;
  /** Enter sends; false with an on-screen keyboard, whose Return has no Shift. */
  enterSends: boolean;
  /** The pane shows a text preview instead of the screen: dock at the bottom. */
  dockOnly: boolean;
  /** Where local Markdown images in the draft load from. */
  imageUrl?: (source: string) => string | null;
  controlRef: RefObject<PromptEditorControl | null>;
  onSubmit: (text: string) => Promise<void>;
  onForward: (data: string) => void;
  onPage: (direction: "up" | "down") => void;
  onUploadImage: (file: File) => Promise<string>;
  onError: (message: string) => void;
  onClose: () => void;
  onFocusTerminal: () => void;
  /** What the editor covers in the pane, or null while hidden. */
  onSpanChange: (span: EditorSpan | null) => void;
};

function visibleRows(term: TerminalEngine): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let row = 0; row < term.rows; row++)
    rows.push(
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
    );
  return rows;
}

/** Rows `from`..`to` with dim cells (agent placeholder hints) blanked. */
function undimmedRows(
  term: TerminalEngine,
  from: number,
  to: number,
): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let row = from; row <= to; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    let text = "";
    for (let col = 0; line && col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      text += cell.isDim() ? " " : cell.getChars() || " ";
    }
    rows[row] = text;
  }
  return rows;
}

function samePlacement(a: PromptEditorPlacement, b: PromptEditorPlacement) {
  if (a.mode !== b.mode) return false;
  if (a.mode !== "overlay" || b.mode !== "overlay") return true;
  return a.region.top === b.region.top && a.region.bottom === b.region.bottom;
}

function sameMetrics(a: TerminalMetrics | null, b: TerminalMetrics | null) {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof TerminalMetrics)[]).every(
    (key) => Math.abs(a[key] - b[key]) < 0.01,
  );
}

/**
 * Loads the live-preview editor: at idle after startup on a fast 4G link,
 * otherwise once the editor is first used (`used`), and never under Data
 * Saver or on 2G.
 */
function useRichSurface(used: boolean) {
  const settled = useStartupSettled();
  const [ready, setReady] = useState(() => promptRichPanel.isLoaded());
  useEffect(() => {
    if (!settled || ready) return;
    const policy = richEditorLoadPolicy();
    if (policy === "never" || (policy === "on-demand" && !used)) return;
    let cancelled = false;
    const load = () =>
      void promptRichPanel.preload().then(() => {
        if (!cancelled && promptRichPanel.isLoaded()) setReady(true);
      });
    if (policy === "on-demand") {
      load();
      return () => {
        cancelled = true;
      };
    }
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(load, { timeout: 3000 })
      : window.setTimeout(load, 250);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [ready, settled, used]);
  return ready;
}

/** "Ctrl+↵" or "⌘↵" for the composer send shortcut. */
function sendKeys() {
  const keys = shortcutLabel("composer.send").split(" / ")[0];
  return keys.replace(/Enter/g, "↵").replace(/^Cmd\+/, "⌘");
}

/**
 * A local prompt editor laid over a coding agent's own input box. Typing is
 * instant because nothing reaches the pane until the draft is sent: on slow
 * links every keystroke into the agent's box would wait for a round trip and
 * a repaint. The terminal grid is scanned as frames arrive to find the box;
 * the editor covers it in the terminal's font and colours, grows upward with
 * the draft, hides while the agent shows a menu or dialog (so keys reach it),
 * and docks at the bottom for agents without a detector.
 */
export function PromptEditor({
  draftKey,
  agent,
  agentStatus,
  term,
  terminalTheme,
  active,
  coarsePointer,
  enterSends,
  focusAllowed,
  dockOnly,
  imageUrl,
  controlRef,
  onSubmit,
  onForward,
  onPage,
  onUploadImage,
  onError,
  onClose,
  onFocusTerminal,
  onSpanChange,
}: PromptEditorProps) {
  const { text, submissionPending, uploadCount } =
    useTerminalComposerDraft(draftKey);
  const images = useComposerImages(draftKey);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<PromptEditorSurface | null>(null);
  const [placement, setPlacement] = useState<PromptEditorPlacement>({
    mode: "hidden",
  });
  const [metrics, setMetrics] = useState<TerminalMetrics | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const boxSeen = useRef(false);
  const sentAt = useRef(Number.NEGATIVE_INFINITY);
  // The pane asks for a choice: an empty draft passes choice keys to it.
  const selection = useRef(false);

  // Scan the grid for the agent's box as frames land, and follow resizes.
  useEffect(() => {
    let timer: number | null = null;
    let last = 0;
    let agentTextSince: number | null = null;
    const scan = () => {
      timer = null;
      const now = performance.now();
      last = now;
      const rows = visibleRows(term);
      const result = dockOnly
        ? ({ state: "unsupported" } as const)
        : scanPromptBox(agent, rows, term.cols);
      // Text in the agent's own box yields to it once it has stayed a
      // moment, and never right after a send, whose paste briefly shows there.
      let agentText = false;
      if (result.state === "box") {
        boxSeen.current = true;
        const { inputTop, inputBottom } = result.region;
        agentText = agentInputHasText(
          undimmedRows(term, inputTop, inputBottom),
          result.region,
        );
      }
      agentTextSince = agentText ? (agentTextSince ?? now) : null;
      const settleAt =
        agentTextSince === null
          ? now
          : Math.max(
              agentTextSince + AGENT_TEXT_SETTLE_MS,
              sentAt.current + SEND_GRACE_MS,
            );
      if (settleAt > now) schedule(settleAt - now);
      const decision = decidePromptEditor({
        scan: result,
        boxSeen: boxSeen.current,
        agentHasText: agentText && settleAt <= now,
        status: agentStatus,
        menu: screenShowsSelection(rows),
      });
      selection.current = decision.selection;
      const next = decision.placement;
      setPlacement((current) =>
        samePlacement(current, next) ? current : next,
      );
      const measured = measureTerminal(
        term,
        rootRef.current?.parentElement ?? null,
      );
      setMetrics((current) =>
        sameMetrics(current, measured) ? current : measured,
      );
    };
    const schedule = (
      delay = SCAN_INTERVAL_MS - (performance.now() - last),
    ) => {
      if (timer !== null) return;
      timer = window.setTimeout(scan, Math.max(0, delay));
    };
    scan();
    const parsed = term.onWriteParsed(() => schedule());
    const resized = term.onResize(() => schedule());
    const observer = new ResizeObserver(() => schedule());
    observer.observe(term.element);
    const host = rootRef.current?.parentElement;
    if (host) observer.observe(host);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      parsed.dispose();
      resized.dispose();
      observer.disconnect();
    };
  }, [agent, agentStatus, dockOnly, term]);

  const hidden = placement.mode === "hidden";

  // A menu took the agent's box: hand its keys to the terminal, and take
  // them back when the box returns if the terminal still has them.
  const handedToTerminal = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (hidden) {
      if (root?.contains(document.activeElement)) {
        handedToTerminal.current = true;
        onFocusTerminal();
      }
      return;
    }
    if (!handedToTerminal.current) return;
    handedToTerminal.current = false;
    if (
      editorMayTakeFocus(
        document.activeElement,
        document.body,
        term.element,
        focusAllowed,
      )
    )
      surfaceRef.current?.focus();
  }, [focusAllowed, hidden, onFocusTerminal, term]);

  // The active pane's editor takes over from the terminal once it first
  // shows; a touch device without a hardware keyboard waits for a tap.
  const visible = !hidden && !!metrics;
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (!visible || !active || shown.current) return;
    shown.current = true;
    if (
      editorMayTakeFocus(
        document.activeElement,
        document.body,
        term.element,
        focusAllowed,
      )
    )
      surfaceRef.current?.focus();
  }, [active, focusAllowed, term, visible]);

  useLayoutEffect(() => {
    controlRef.current = {
      focus: () => {
        if (hidden || !surfaceRef.current) return false;
        surfaceRef.current.focus();
        // False sends the caller on to the terminal rather than leave the
        // keyboard with nothing.
        const focused = document.activeElement;
        return (
          !!focused &&
          focused !== rootRef.current &&
          !!rootRef.current?.contains(focused)
        );
      },
      hasFocus: () => !!rootRef.current?.contains(document.activeElement),
      visible: () => !hidden,
    };
  });
  useEffect(
    () => () => {
      controlRef.current = null;
    },
    [controlRef],
  );

  // Outside changes to the draft (a send clearing it, a failed send or an
  // upload restoring text) reach the surface; local typing is already there.
  useEffect(() => {
    surfaceRef.current?.setText(
      text,
      readTerminalComposerSelection(draftKey)?.end,
    );
  }, [draftKey, text]);

  // Swap the textarea for the rich editor when it arrives, never
  // mid-composition.
  const [used, setUsed] = useState(false);
  const richReady = useRichSurface(used);
  const [rich, setRich] = useState(richReady);
  const focusRich = useRef(false);
  useEffect(() => {
    if (!richReady || rich || composing) return;
    focusRich.current = !!surfaceRef.current?.hasFocus();
    setRich(true);
  }, [composing, rich, richReady]);

  const send = async () => {
    if (composingRef.current) return;
    try {
      await submitTerminalComposerDraft(
        draftKey,
        readTerminalComposerDraft(draftKey),
        (draft) => {
          sentAt.current = performance.now();
          return onSubmit(draft);
        },
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : t("Failed to send input"),
      );
    }
  };
  const onKey = (event: KeyboardEvent, empty: boolean) => {
    const action = promptEditorKeyAction(event, {
      empty,
      applicationCursor: term.modes.applicationCursorKeysMode,
      bindings: getShortcutSnapshot().preset.bindings,
      enterSends,
      selection: selection.current,
    });
    if (!action) return false;
    if (action.type === "send") void send();
    else if (action.type === "newline") surfaceRef.current?.insertText("\n");
    else if (action.type === "forward") onForward(action.data);
    else onPage(action.direction);
    return true;
  };
  const onPasteFiles = (data: DataTransfer | null) => {
    const images = clipboardImageFiles(data);
    if (images.length === 0) return false;
    void uploadTerminalComposerImages(
      draftKey,
      images,
      onUploadImage,
      // A placeholder, as in Claude Code; the path replaces it on send.
      (key, _path, image) => {
        const selection =
          key === draftKey ? surfaceRef.current?.selection() : null;
        insertIntoTerminalComposerDraft(
          key,
          composerImageToken(image.ref),
          selection?.start,
          selection?.end,
        );
      },
    ).catch((error) =>
      onError(
        error instanceof Error ? error.message : t("Image upload failed"),
      ),
    );
    return true;
  };

  // The rich surface shows pasted images in the text; the strip keeps the
  // ones still uploading (and all of them under the plain textarea).
  const strip = images.filter((image) =>
    rich ? image.path === null : composerImageInDraft(image, text),
  );
  const frame =
    metrics &&
    promptEditorFrame(
      placement,
      metrics.rows,
      Math.max(1, Math.ceil(contentHeight / metrics.rowHeight - 0.01)),
      strip.length ? Math.ceil(IMAGE_STRIP_HEIGHT / metrics.rowHeight) : 0,
    );
  const promptImages: PromptImages = {
    url: (source) => {
      const pasted = readComposerImages(draftKey).find(
        (image) => image.path === source,
      );
      return pasted ? composerImageUrl(pasted) : (imageUrl?.(source) ?? null);
    },
    pasted: (ref) => {
      const pasted = readComposerImages(draftKey).find(
        (image) => image.ref === ref,
      );
      return pasted ? composerImageUrl(pasted) : null;
    },
  };

  const font: PromptEditorFont = {
    family: term.cssFontFamily,
    size: metrics?.fontSize ?? term.options.fontSize,
    lineHeight: metrics?.rowHeight ?? 17,
  };
  const surfaceProps: PromptEditorSurfaceProps = {
    surfaceRef,
    initialText: readTerminalComposerDraft(draftKey),
    initialSelection: readTerminalComposerSelection(draftKey),
    focus: focusRich.current,
    placeholder: t("Write a prompt for the agent"),
    label: t("Prompt editor"),
    font,
    onChange: (next, start, end) => {
      writeTerminalComposerDraft(draftKey, next);
      writeTerminalComposerSelection(draftKey, start, end);
    },
    onKey,
    onPasteFiles,
    onContentHeight: setContentHeight,
    images: promptImages,
    onUse: () => setUsed(true),
    onCompositionChange: (active) => {
      composingRef.current = active;
      setComposing(active);
    },
  };

  const style =
    metrics && frame
      ? ({
          left: metrics.left,
          top: metrics.top + frame.top * metrics.rowHeight,
          width: metrics.width,
          height: frame.rows * metrics.rowHeight,
          "--prompt-editor-row": `${metrics.rowHeight}px`,
          "--prompt-editor-cell": `${metrics.cellWidth}px`,
          "--prompt-editor-pad-top": `${frame.padTop * metrics.rowHeight}px`,
          "--prompt-editor-pad-bottom": `${frame.padBottom * metrics.rowHeight}px`,
          "--prompt-editor-font-size": `${font.size}px`,
          "--prompt-editor-bg": terminalTheme.background,
          "--prompt-editor-fg": terminalTheme.foreground,
          "--prompt-editor-caret": terminalTheme.cursor,
          "--prompt-editor-selection": terminalTheme.selectionBackground,
          ...Object.fromEntries(
            (
              ["red", "green", "yellow", "blue", "magenta", "cyan"] as const
            ).map((name) => [`--prompt-editor-${name}`, terminalTheme[name]]),
          ),
          fontFamily: font.family,
        } as CSSProperties)
      : undefined;
  useEditorSpan(
    visible && metrics && frame ? (style?.top as number) : null,
    frame && metrics ? frame.rows * metrics.rowHeight : 0,
    onSpanChange,
  );
  const busy = uploadCount > 0 || submissionPending;
  const status =
    uploadCount > 0
      ? t("Uploading image…")
      : submissionPending
        ? t("Sending…")
        : enterSends
          ? `↵ ${t("Send")} · ⇧↵ ${t("New line")}`
          : `${sendKeys()} ${t("Send")}`;
  const marker = PROMPT_MARKERS[agent] ?? ">";

  return (
    <div
      ref={rootRef}
      className="prompt-editor"
      role="group"
      aria-label={t("Prompt editor")}
      data-mode={placement.mode}
      data-images={strip.length > 0 || undefined}
      hidden={!visible}
      style={style}
    >
      <span className="prompt-editor-marker" aria-hidden="true">
        {marker}
      </span>
      <div className="prompt-editor-body">
        {rich ? (
          <LazyBoundary>
            <PromptCodeMirror {...surfaceProps} />
          </LazyBoundary>
        ) : (
          <PromptTextarea {...surfaceProps} />
        )}
      </div>
      <ComposerImages images={strip} />
      <div className="prompt-editor-actions">
        <span
          className="prompt-editor-hint"
          aria-live="polite"
          data-busy={busy || undefined}
        >
          {status}
        </span>
        {coarsePointer ? (
          // The on-screen keyboard has no send shortcut: its Return breaks
          // the line, so touch gets a button. The buttons keep focus in the
          // editor (and the keyboard up) on mousedown, not pointerdown:
          // WebKit drops a tap's click when its pointerdown is cancelled.
          <IconButton
            className="prompt-editor-action"
            label={shortcutTitle(
              t("Send draft to the terminal"),
              "composer.send",
            )}
            tooltip={false}
            icon={<CornerDownLeft size={12} />}
            disabled={busy || !text.trim()}
            onMouseDown={keepFocus}
            onClick={() => void send()}
          />
        ) : null}
        <IconButton
          className="prompt-editor-action"
          label={shortcutTitle(t("Hide prompt editor"), "promptEditor.toggle")}
          tooltip={false}
          icon={<X size={12} />}
          onMouseDown={keepFocus}
          onClick={onClose}
        />
      </div>
    </div>
  );
}
