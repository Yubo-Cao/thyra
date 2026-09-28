import {
  ClipboardAddon,
  type ClipboardSelectionType,
} from "@xterm/addon-clipboard";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { IBufferRange, ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { bridge, type ConnectionClient } from "../../api";
import {
  registerTerminalConnectionDisposer,
  type TerminalConnectionIdentity,
  terminalPushMatches,
} from "../../terminalConnection";
import {
  resolveTerminalFontFamily,
  terminalFontOptions,
} from "../../appearance";
import { t } from "../../i18n";
import { isMobileLayout, LAYOUT_CHANGE_EVENT } from "../../layoutPreferences";
import { detectShortcutPlatform } from "../../shortcutBindings";
import { terminalLinkModifierMatches } from "../../shortcutPreferences";
import { noteTerminalOutput } from "../../startupGate";
import { store } from "../../store";
import {
  copyTextFromUserGesture,
  createTerminalClipboardProvider,
  decodeTerminalClipboard,
  normalizeTerminalSelection,
  type PendingClipboardWrite,
} from "../../terminalClipboard";
import { TerminalEndpointPresentation } from "../../terminalEndpointPresentation";
import { TerminalFrameDecoder } from "../../terminalFrameDecoder";
import { TerminalHistorySelection } from "../../terminalHistorySelection";
import { TerminalInputBatcher } from "../../terminalInputBatcher";
import {
  registerTerminalLinkProvider,
  type TerminalResolvedLink,
  type TerminalTouchLink,
} from "../../terminalLinkProvider";
import {
  sanitizeTerminalHttpUrl,
  terminalFileUriPath,
} from "../../terminalLinks";
import { attachTerminalRenderer, TerminalFit } from "../../terminalRenderer";
import {
  TerminalAttachFrameWatchdog,
  TerminalResizeSync,
  type TerminalSize,
} from "../../terminalResize";
import { TerminalTouchSelection } from "../../terminalTouchSelection";
import {
  terminalScreens,
  terminalZoom,
  zoomedTerminalFontSize,
} from "../../touchGestures";
import type { PaneLayout } from "../../types";
import {
  type TerminalFrameParts,
  terminalFrameText,
} from "../../../../shared/terminalFrame";
import type { PromptEditorControl } from "../promptEditor/PromptEditor";
import type { TerminalFileLinkMenuState } from "../TerminalFileLinkMenu";
import { b64toText, bytesToB64 } from "../../utils";

export function focusTerminalEndpoint(
  client: ConnectionClient,
  terminalId: string | undefined,
) {
  if (
    !terminalId ||
    !client.isCurrent() ||
    !store
      .get()
      .endpointAvailability[terminalId]?.methods.includes("pane.focus")
  )
    return;
  void client
    .call("terminal.focus", { terminal_id: terminalId })
    .catch(() => null);
}

export function detachTerminal(client: ConnectionClient, terminalId: string) {
  void client
    .call("terminal.detach", { terminal_id: terminalId })
    .catch(() => null);
}

const inputBatchers = new Map<string, TerminalInputBatcher>();

export function sendTerminalBytes(
  client: ConnectionClient,
  bytes: Uint8Array,
  terminalId: string,
) {
  // Keyed by connection generation and terminal, not client object: wrapper
  // clients are recreated across renders and must share one ordered queue.
  const key = `${client.connectionId}\0${client.generation}\0${terminalId}`;
  let batcher = inputBatchers.get(key);
  if (!batcher) {
    batcher = new TerminalInputBatcher(
      (batch) =>
        client.call("terminal.input", {
          terminal_id: terminalId,
          data: bytesToB64(batch),
        }),
      () => inputBatchers.delete(key),
    );
    inputBatchers.set(key, batcher);
  }
  batcher.send(bytes);
}

/** True only once `pending` has held continuously for `delayMs`. */
export function useDelayedFlag(pending: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!pending) {
      setElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, pending]);
  return pending && elapsed;
}

/** Font options for the layout and scale, with this browser's pinch zoom. */
export function terminalDensity(uiScale: number, zoom = terminalZoom()) {
  const compact = typeof window !== "undefined" && isMobileLayout();
  const options = terminalFontOptions(compact, uiScale);
  const fontSize = zoomedTerminalFontSize(options.fontSize, zoom);
  return { ...options, fontSize };
}

export function isApplePlatform() {
  return detectShortcutPlatform() === "mac";
}

export function shouldAvoidVirtualKeyboard() {
  return isMobileLayout() || window.matchMedia("(any-pointer: coarse)").matches;
}

export function isSafariBrowser() {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

export function cancelEvent(e: Event) {
  e.preventDefault();
  e.stopPropagation();
}

/** Cancels the event and keeps every later listener from seeing it. */
export function swallowEvent(e: Event) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Gate keyboard input; a read-only textarea keeps the device keyboard shut. */
export function setTerminalStdinDisabled(term: Terminal, disabled: boolean) {
  term.options.disableStdin = disabled;
  if (term.textarea) term.textarea.readOnly = disabled;
}

/** Release xterm's document drag listeners with a synthetic mouseup. */
export function dispatchMouseRelease(doc: Document, at?: MouseEvent) {
  doc.dispatchEvent(
    new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 0,
      ...(at && {
        clientX: at.clientX,
        clientY: at.clientY,
        screenX: at.screenX,
        screenY: at.screenY,
      }),
    }),
  );
}

// Copy a finished selection, as Herdr's own client does, from the gesture that
// ended it: Safari only allows clipboard writes there.
export function copyFinishedSelection(text: string) {
  const copied = normalizeTerminalSelection(text);
  if (!copied) return;
  void copyTextFromUserGesture(copied).then(
    () =>
      store.notify({
        kind: "info",
        message: t("Copied {count} characters", {
          count: copied.length.toLocaleString(),
        }),
        autoDismissMs: 1500,
      }),
    () => {},
  );
}

const box = <T>(current: T): RefObject<T> => ({ current });
const SYSTEM_CLIPBOARD = "c" as ClipboardSelectionType;
const TERMINAL_EVICTION_WINDOW_MS = 60_000;
const TERMINAL_EVICTION_MAX_RETRIES = 3;

export type TerminalWorkspaceFileRequest = {
  connectionId: string;
  connectionGeneration: number;
  workspaceId: string;
  paneId?: string;
  path: string;
};

function createTerminalRefs(initial: {
  composerOpen: boolean;
  viewOnly: boolean;
  terminalTheme: ITheme;
  uiScale: number;
  fontFamily: string;
}) {
  return {
    term: box<Terminal | null>(null),
    fit: box<TerminalFit | null>(null),
    presentation: box<TerminalEndpointPresentation | null>(null),
    resizeSync: box<TerminalResizeSync | null>(null),
    touchSelection: box<TerminalTouchSelection | null>(null),
    linkRevision: box(0),
    linkReady: box(false),
    touchLinkIntent: box(0),
    inputActive: box(false),
    inputSession: box(0),
    composerOpen: box(initial.composerOpen),
    // The desktop prompt editor over this pane, while it is mounted.
    promptEditor: box<PromptEditorControl | null>(null),
    viewOnly: box(initial.viewOnly),
    // The view syncs the pane refs in a layout effect before any reader runs.
    isActivePane: box(false),
    workspaceId: box<string | undefined>(undefined),
    paneId: box<string | undefined>(undefined),
    paneTerminalId: box<string | undefined>(undefined),
    paneTabId: box<string | undefined>(undefined),
    paneLayout: box<PaneLayout | null>(null),
    onOpenWorkspaceFile: box<
      ((request: TerminalWorkspaceFileRequest) => void) | undefined
    >(undefined),
    // Theme, scale and font update xterm in place without recreating it.
    terminalTheme: box(initial.terminalTheme),
    uiScale: box(initial.uiScale),
    fontFamily: box(initial.fontFamily),
    // Attach bookkeeping. Frames for any terminal but the desired one drop.
    desiredTerminal: box<string | null>(null),
    attachedTerminal: box<string | null>(null),
    attachingTerminal: box<string | null>(null),
    renderedTerminal: box<string | null>(null),
    attachEvictions: box<number[]>([]),
    attachWatchdog: new TerminalAttachFrameWatchdog(),
    attachTimeouts: box(0),
    // Another device sizes this pane: mirror its size, scaled to fit, and
    // pan a pinch-zoomed view by this offset.
    followShared: box(false),
    followPan: box({ x: 0, y: 0 }),
    // This viewer's frame stream: minimum interval, and paused for a text
    // preview. Sent with each attach and on change.
    frameInterval: box(0),
    framesPaused: box(false),
  };
}

/**
 * While following another device's size, keep xterm at the frame size and
 * scale it down (never up) to fit the container; otherwise undo the scale.
 * Pinch zoom magnifies that fitted view (`live` previews a pinch in progress)
 * and `pan`, clamped in place, shows the part that no longer fits. Returns the
 * applied scale.
 */
export function applyTerminalFollowScale(
  term: Terminal,
  container: HTMLElement,
  follow: boolean,
  pan = { x: 0, y: 0 },
  live = 1,
): number {
  const style = container.style;
  if (!follow) {
    if (!container.classList.contains("is-following")) return 1;
    container.classList.remove("is-following");
    for (const name of ["scale", "x", "y", "width", "height"])
      style.removeProperty(`--terminal-follow-${name}`);
    return 1;
  }
  const element = term.element;
  const screen = element?.querySelector<HTMLElement>(".xterm-screen");
  let scale = live;
  let width = 0;
  let height = 0;
  if (element && screen && screen.offsetWidth > 0 && screen.offsetHeight > 0) {
    const computed = getComputedStyle(element);
    const px = (value: string) => Number.parseFloat(value) || 0;
    width =
      screen.offsetWidth + px(computed.paddingLeft) + px(computed.paddingRight);
    height =
      screen.offsetHeight +
      px(computed.paddingTop) +
      px(computed.paddingBottom);
    // The font already carries the zoom: fit as if the container did too.
    const zoom = terminalZoom();
    scale *= Math.min(
      1,
      (zoom * container.clientWidth) / width,
      (zoom * container.clientHeight) / height,
    );
  }
  scale = Math.max(0.1, Math.round(scale * 1000) / 1000);
  // A view smaller than its container stays at the origin; a larger one
  // keeps covering it.
  const clampPan = (offset: number, room: number) =>
    Math.round(Math.min(0, Math.max(room, offset)));
  pan.x = clampPan(pan.x, container.clientWidth - width * scale);
  pan.y = clampPan(pan.y, container.clientHeight - height * scale);
  container.classList.add("is-following");
  style.setProperty("--terminal-follow-scale", String(scale));
  style.setProperty("--terminal-follow-x", `${pan.x}px`);
  style.setProperty("--terminal-follow-y", `${pan.y}px`);
  style.setProperty("--terminal-follow-width", `${width}px`);
  style.setProperty("--terminal-follow-height", `${height}px`);
  return scale;
}

/** Mutable state a terminal view and its xterm session share across renders. */
export type TerminalRefs = ReturnType<typeof createTerminalRefs>;

export function useTerminalRefs(
  initial: Parameters<typeof createTerminalRefs>[0],
): TerminalRefs {
  const refs = useRef<TerminalRefs>(null);
  refs.current ??= createTerminalRefs(initial);
  return refs.current;
}

/** Coarse pointers keep terminal input (and the keyboard) off until opened. */
export function useTerminalInput(refs: TerminalRefs) {
  const [inputActive, setInputActive] = useState(false);
  const closeTerminalInput = useCallback(
    (blurInput = true) => {
      refs.inputActive.current = false;
      refs.inputSession.current++;
      setInputActive(false);
      const term = refs.term.current;
      if (!term) return;
      setTerminalStdinDisabled(
        term,
        shouldAvoidVirtualKeyboard() ||
          refs.composerOpen.current ||
          refs.viewOnly.current ||
          refs.touchSelection.current?.active === true,
      );
      if (blurInput) term.blur();
    },
    [refs],
  );
  const openTerminalInput = useCallback(
    (term: Terminal, disableStdin: boolean) => {
      refs.inputActive.current = true;
      setInputActive(true);
      setTerminalStdinDisabled(term, disableStdin);
    },
    [refs],
  );
  return { inputActive, closeTerminalInput, openTerminalInput };
}

export type TerminalTouchLinkState = TerminalTouchLink & {
  current: () => boolean;
};

/** React state setters a session reports into (all stable). */
export type TerminalViewSetters = {
  setTermInstance: (term: Terminal | null) => void;
  setFileLinkMenu: (menu: TerminalFileLinkMenuState | null) => void;
  setTouchLink: (link: TerminalTouchLinkState | null) => void;
  setTouchHandles: (handles: TerminalTouchSelection["handles"]) => void;
  setTerminalLoading: (loading: boolean) => void;
  setTerminalAttachError: (error: string) => void;
  retryAttach: () => void;
  setPasteLoading: (loading: boolean) => void;
  setUploadError: (message: string) => void;
  /** Shows the pinch zoom percentage (and its reset control), or hides it. */
  setZoomBadge: (percent: number | null) => void;
};

/** What the hosting view hands its terminal session. */
export type TerminalSessionBindings = TerminalViewInputs & {
  /** Fits xterm to its container; null while the container is hidden. */
  fitVisibleTerminal: () => TerminalSize | null;
  focusTerminalSoon: () => void;
  relayViewportFor: (size: TerminalSize) => TerminalSize | null;
  resolveFilePaths: (paths: string[]) => Promise<Map<string, string>>;
  scrollPage: (direction: "up" | "down", amount?: "full" | "half") => void;
};
export type TerminalViewInputs = {
  client: ConnectionClient;
  identity: TerminalConnectionIdentity;
  refs: TerminalRefs;
  ui: TerminalViewSetters;
  /** Applies (and consumes) latched mobile modifiers to outgoing input. */
  applyModifiers: (data: string) => string;
  assertInputAllowed: () => void;
  closeTerminalInput: (blurInput?: boolean) => void;
  openTerminalInput: (term: Terminal, disableStdin: boolean) => void;
  container: HTMLDivElement | null;
};

/** One xterm instance and the state its input, stream and gesture handlers share. */
export type TerminalSession = ReturnType<typeof openTerminalSession>;

/** Creates the xterm with its addons and streams the pane's frames into it. */
export function openTerminalSession(bindings: TerminalSessionBindings) {
  // The session and its installers destructure in one shared order.
  const { client, refs, ui } = bindings;
  const container = bindings.container as HTMLDivElement;
  const term = new Terminal({
    cursorBlink: true,
    disableStdin:
      refs.composerOpen.current ||
      refs.viewOnly.current ||
      shouldAvoidVirtualKeyboard(),
    fontFamily: resolveTerminalFontFamily(refs.fontFamily.current),
    ...terminalDensity(refs.uiScale.current),
    theme: refs.terminalTheme.current,
    allowProposedApi: true,
    // Nerd Font icons wider than a cell shrink to fit instead of spilling.
    rescaleOverlappingGlyphs: true,
    linkHandler: {
      // Opt in only to route local file URIs below; all other schemes stay inert.
      allowNonHttpProtocols: true,
      hover(_event, text, range) {
        oscHover = { text, state: linkState(), range, ready: false };
        // Native hover can reuse an inactive line cache. A new range object
        // after a full refresh proves xterm actually reread the OSC8 target.
        if (!oscRefreshRange) {
          oscRefreshRange = range;
          queueMicrotask(() => {
            if (!session.disposed) term.refresh(0, term.rows - 1);
          });
        }
      },
      leave() {
        oscHover = null;
      },
      activate(event, text) {
        event.preventDefault();
        if (
          !terminalLinkModifierMatches(event) ||
          !oscHover?.ready ||
          !oscHover.state ||
          oscHover.text !== text ||
          oscHover.state !== linkState()
        )
          return;
        const path = terminalFileUriPath(text);
        if (path) {
          term.clearSelection();
          showFileLinkMenu(path, event);
          return;
        }
        const url = sanitizeTerminalHttpUrl(text);
        if (url) {
          term.clearSelection();
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    },
    scrollbar: { showScrollbar: false },
    scrollback: 2000,
  });
  const { desiredTerminal } = refs;
  const { closeTerminalInput, fitVisibleTerminal } = bindings;
  const { attachedTerminal, attachWatchdog, attachingTerminal } = refs;
  const { attachTimeouts, attachEvictions } = refs;
  const abort = new AbortController();
  let leaseDisposed = false;
  let oscHover: {
    text: string;
    state: string | null;
    range: IBufferRange;
    ready: boolean;
  } | null = null;
  let oscRefreshRange: IBufferRange | null = null;
  const linkState = () => {
    const presentation = refs.presentation.current;
    if (
      session.disposed ||
      !client.isCurrent() ||
      !refs.linkReady.current ||
      !desiredTerminal.current ||
      presentation?.linkWritePending ||
      (!session.latestLinkFrame &&
        session.latestEndpointText !== undefined &&
        presentation?.displayedFrame?.text !== session.latestEndpointText) ||
      (session.latestLinkFrame &&
        presentation?.displayedFrame?.linkFrame !== session.latestLinkFrame)
    )
      return null;
    return `${refs.linkRevision.current}:${desiredTerminal.current}:${term.cols}:${term.rows}:${term.buffer.active.viewportY}`;
  };
  const showFileLinkMenu = (path: string, event: MouseEvent) => {
    const workspaceId = refs.workspaceId.current;
    if (workspaceId && linkState())
      ui.setFileLinkMenu({
        path,
        workspaceId,
        x: event.clientX,
        y: event.clientY,
      });
  };
  const linkRender = term.onRender(({ start, end }) => {
    // Public onRender fires before xterm's active-link invalidation listener.
    queueMicrotask(() => {
      if (!oscHover) oscRefreshRange = null;
      if (
        !session.disposed &&
        start === 0 &&
        end === term.rows - 1 &&
        oscHover &&
        oscRefreshRange &&
        oscHover.range !== oscRefreshRange &&
        oscHover.state === linkState()
      ) {
        oscHover.ready = true;
        oscRefreshRange = null;
      }
    });
  });
  // Full refreshes only clear hover decorations of links that went stale.
  // Without a hover pointer there are none, and repainting every row on each
  // keystroke and frame is what makes typing stutter on phones.
  const pointerHovers = window.matchMedia("(any-hover: hover)").matches;
  const retireTouchLink = () => {
    refs.touchLinkIntent.current++;
    ui.setTouchLink(null);
  };
  const invalidateLinks = () => {
    retireTouchLink();
    refs.linkRevision.current++;
    if (pointerHovers) term.refresh(0, term.rows - 1);
  };
  const fit = new TerminalFit();
  const clipboardProvider = createTerminalClipboardProvider({
    onWriteStart() {
      if (session.disposed || !client.isCurrent()) return;
      if (store.get().notice?.actionClipboardText !== undefined) {
        store.clearNotice();
      }
    },
    onWriteError(error, text) {
      if (session.disposed || !client.isCurrent()) return;
      store.notify({
        kind: "error",
        message: t("Browser blocked terminal copy"),
        detail: text
          ? t("{error}. Use Copy to approve this clipboard write.", {
              error: error.message,
            })
          : error.message,
        ...(text ? { actionLabel: t("Copy"), actionClipboardText: text } : {}),
        autoDismissMs: 60_000,
      });
    },
  });
  term.loadAddon(new ClipboardAddon(undefined, clipboardProvider));
  term.loadAddon(new UnicodeGraphemesAddon());
  term.loadAddon(fit);
  term.open(container);
  // Startup warmups elsewhere wait for the first rendered output.
  const firstOutput = term.onWriteParsed(() => {
    firstOutput.dispose();
    noteTerminalOutput();
  });
  const detachRenderer = attachTerminalRenderer(term, () => {
    const size = fitVisibleTerminal();
    if (size) refs.resizeSync.current?.schedule(size);
  });
  const applePlatform = isApplePlatform();
  if (applePlatform) term.element?.classList.add("xterm-apple-row-spacing-fix");
  try {
    fit.fit();
  } catch {
    // ResizeObserver will retry after the terminal becomes measurable.
  }
  if (term.textarea)
    term.textarea.readOnly = term.options.disableStdin === true;
  refs.term.current = term;
  ui.setTermInstance(term);
  refs.fit.current = fit;
  const linkProvider = registerTerminalLinkProvider(
    term,
    showFileLinkMenu,
    bindings.resolveFilePaths,
    () => refs.presentation.current?.displayedFrame != null,
    {
      state: linkState,
      resolve: async (row, col, touch) => {
        const terminalId = desiredTerminal.current;
        if (
          !session.latestLinkFrame ||
          !terminalId ||
          !linkState() ||
          (!touch &&
            !store
              .get()
              .endpointAvailability[terminalId]?.methods.includes(
                "pane.link.resolve",
              ))
        )
          return null;
        return client.call("terminal.link.resolve", {
          terminal_id: terminalId,
          frame: session.latestLinkFrame,
          row,
          col,
        }) as Promise<TerminalResolvedLink>;
      },
    },
  );
  const acceptsEndpointInput = (): boolean =>
    !session.disposed &&
    client.isCurrent() &&
    !refs.composerOpen.current &&
    !refs.touchSelection.current?.active &&
    desiredTerminal.current === refs.paneTerminalId.current &&
    store.get().status === "connected" &&
    !store.get().connectionPaused;

  const presentation: TerminalEndpointPresentation =
    new TerminalEndpointPresentation(
      () => term.hasSelection() || history.active,
      (text, parsed, linksChanged) =>
        term.write(text, () => {
          parsed();
          if (!session.disposed && linksChanged && pointerHovers)
            term.refresh(0, term.rows - 1);
        }),
      () => ({ cols: term.cols, rows: term.rows }),
      {
        accepts: (frame) => history.accepts(frame),
        presented: (frame) => history.presented(frame),
        reset: () => history.reset(),
      },
    );
  const history: TerminalHistorySelection = new TerminalHistorySelection(term, {
    frame: () => presentation.displayedFrame,
    scroll: (direction, lines) =>
      client.call("terminal.scroll", {
        terminal_id: desiredTerminal.current,
        direction,
        lines,
        source: "history",
      }),
    changed: (message) =>
      store.notify({ kind: "info", message, autoDismissMs: 8000 }),
  });
  refs.presentation.current = presentation;
  const touch = new TerminalTouchSelection(term, {
    begin: (activate) => {
      if (!acceptsEndpointInput() || !refs.isActivePane.current) return;
      closeTerminalInput();
      history.reset();
      if (presentation.beginSelection(activate)) activate();
    },
    selected: ({ row, col }) => {
      const intent = refs.touchLinkIntent.current;
      const state = linkState();
      const current = () =>
        !!state &&
        state === linkState() &&
        touch.active &&
        intent === refs.touchLinkIntent.current;
      void linkProvider.resolveTouch(row, col, current).then((target) => {
        if (target && current()) ui.setTouchLink({ ...target, current });
      });
    },
    changed: () => {
      retireTouchLink();
      ui.setTouchHandles(touch.handles);
      if (touch.active) setTerminalStdinDisabled(term, true);
    },
    release: () => presentation.cancelSelection(),
  });
  refs.touchSelection.current = touch;

  terminalScreens.open.set(term, refs.renderedTerminal);
  const session = {
    ...bindings,
    term,
    container,
    // Aborted on dispose; removes every DOM listener the session added.
    signal: abort.signal,
    applePlatform,
    presentation,
    history,
    touch,
    disposed: false,
    latestLinkFrame: undefined as string | undefined,
    latestEndpointText: undefined as string | undefined,
    // A clipboard write reserved inside a gesture for a later OSC 52 copy.
    reservedClipboard: null as PendingClipboardWrite | null,
    // Replaying a delayed local selection must never synthesize pane input.
    replayingSelection: false,
    replayingWheel: false,
    invalidateLinks,
    retireTouchLink,
    acceptsEndpointInput,
    acceptsInput: (): boolean =>
      acceptsEndpointInput() &&
      refs.isActivePane.current &&
      (!shouldAvoidVirtualKeyboard() || refs.inputActive.current),
    // Stops input and listeners, runs `disposeHandlers`, then frees xterm.
    dispose(disposeHandlers: () => void): void {
      touch.cancelPending();
      refs.touchSelection.current = null;
      session.disposed = true;
      abort.abort();
      off();
      offClipboard();
      offClosed();
      unregisterConnectionDisposer();
      ro.disconnect();
      resizeSync.dispose();
      refs.resizeSync.current = null;
      attachWatchdog.cancel();
      disposeHandlers();
      presentation.dispose();
      refs.presentation.current = null;
      linkRender.dispose();
      linkProvider.dispose();
      const terminalId = attachedTerminal.current ?? desiredTerminal.current;
      if (terminalId && !leaseDisposed && client.isCurrent())
        detachTerminal(client, terminalId);
      session.reservedClipboard?.cancel();
      const rendered = refs.renderedTerminal.current;
      if (rendered) terminalScreens.keep?.(rendered, term);
      terminalScreens.open.delete(term);
      detachRenderer();
      term.dispose();
      refs.term.current = null;
      ui.setTermInstance(null);
      refs.fit.current = null;
      attachedTerminal.current = null;
      attachingTerminal.current = null;
      desiredTerminal.current = null;
      refs.renderedTerminal.current = null;
    },
  };

  // A mount owns exactly one connection generation. Drop pushes from an
  // inactive connection or a prior terminal attach before touching xterm.
  const current = (push: Parameters<typeof terminalPushMatches>[3]) =>
    terminalPushMatches(
      bindings.identity,
      client,
      desiredTerminal.current,
      push,
    );
  const frameDecoders = new Map<string, TerminalFrameDecoder>();
  const off = bridge.onTerminal((frame) => {
    if (!current(frame)) return;
    let text: string | null;
    let parts: TerminalFrameParts | undefined;
    if (frame.frame_seq !== undefined) {
      let decoder = frameDecoders.get(frame.terminal_id);
      if (!decoder) {
        decoder = new TerminalFrameDecoder();
        frameDecoders.set(frame.terminal_id, decoder);
      }
      const decoded = decoder.decode(frame);
      if (decoded.kind === "none") return;
      // Acknowledge on receipt: the bridge sends the next frame only once
      // the window has room, so a slow link skips stale repaints.
      void client
        .call(
          "terminal.frame_ack",
          decoded.kind === "resync"
            ? { terminal_id: frame.terminal_id, resync: true }
            : { terminal_id: frame.terminal_id, seq: decoded.seq },
        )
        .catch(() => {});
      if (decoded.kind === "resync") return;
      parts = decoded.parts;
      text = terminalFrameText(parts);
    } else {
      text = frame.bytes === undefined ? null : b64toText(frame.bytes);
    }
    if (text === null) return;
    if (!frame.link_frame || frame.link_frame !== session.latestLinkFrame)
      invalidateLinks();
    refs.linkReady.current = true;
    session.latestEndpointText =
      typeof frame.mouse_reporting === "boolean" ? text : undefined;
    session.latestLinkFrame = frame.link_frame;
    // An explicitly chosen path is a stable action target, even as a TUI repaints.
    attachWatchdog.markFrame();
    attachTimeouts.current = 0;
    ui.setTerminalLoading(false);
    ui.setTerminalAttachError("");
    // Mirror the displaying device's size; the bridge sends the whole surface.
    if (
      refs.followShared.current &&
      frame.width > 0 &&
      frame.height > 0 &&
      (frame.width !== term.cols || frame.height !== term.rows)
    ) {
      term.resize(frame.width, frame.height);
      applyTerminalFollowScale(term, container, true, refs.followPan.current);
    }
    if (typeof frame.mouse_reporting === "boolean") {
      term.options.macOptionClickForcesSelection = true;
      presentation.update(
        text,
        frame.mouse_reporting,
        {
          cols: frame.width,
          rows: frame.height,
        },
        frame.history,
        frame.link_frame,
        parts,
      );
    } else {
      presentation.updateIncremental(text, () => {
        touch.reset();
        history.reset();
        term.clearSelection();
        presentation.cancelSelection();
        store.notify({
          kind: "info",
          message: t(
            "Selection display resumed: pending output reached the 1 MiB limit.",
          ),
        });
      });
    }
    bindings.focusTerminalSoon();
  });
  const offClipboard = bridge.onTerminalClipboard((clipboard) => {
    if (!current(clipboard)) return;
    const text = decodeTerminalClipboard(clipboard.data);
    if (text !== null && client.isCurrent()) {
      const reserved = session.reservedClipboard;
      session.reservedClipboard = null;
      if (!reserved) {
        clipboardProvider.writeText(SYSTEM_CLIPBOARD, text);
        return;
      }
      // The write reserved at the end of the drag keeps WebKit's gesture.
      reserved
        .resolve(text)
        .catch(() => clipboardProvider.writeText(SYSTEM_CLIPBOARD, text));
    }
  });
  const offClosed = bridge.onTerminalClosed((closed) => {
    if (!current(closed)) return;
    invalidateLinks();
    refs.linkReady.current = false;
    ui.setFileLinkMenu(null);
    store.setTerminalEndpoint(client, closed.terminal_id, null);
    // Herdr closes the direct attach when another client takes the
    // terminal over (or its stream dies). Re-attach, but bound takeover
    // wars between two clients so they cannot evict each other forever.
    touch.reset();
    presentation.reset();
    attachWatchdog.cancel();
    attachedTerminal.current = null;
    attachingTerminal.current = null;
    if (closed.reason === "terminal_configuration_changed") {
      ui.retryAttach();
      return;
    }
    // Herdr renumbered the pane's terminal (live handoff) or dropped it:
    // follow the pane rather than re-attach an id Herdr no longer knows.
    if (
      closed.reason === "terminal_replaced" ||
      closed.reason === "terminal_gone"
    ) {
      const replacement = closed.replacement_terminal_id ?? null;
      store.remapTerminal(client, closed.terminal_id, replacement);
      if (!replacement) {
        ui.setTerminalLoading(false);
        ui.setTerminalAttachError(t("This terminal is no longer in Herdr."));
      }
      return;
    }
    const now = Date.now();
    attachEvictions.current = attachEvictions.current.filter(
      (at) => now - at < TERMINAL_EVICTION_WINDOW_MS,
    );
    attachEvictions.current.push(now);
    if (attachEvictions.current.length > TERMINAL_EVICTION_MAX_RETRIES) {
      attachWatchdog.cancel();
      ui.setTerminalLoading(false);
      ui.setTerminalAttachError(
        typeof closed.reason === "string" &&
          closed.reason.includes("taken over")
          ? t("Terminal stream was taken over by another Thyra client")
          : t("Terminal stream closed by the server"),
      );
      return;
    }
    ui.retryAttach();
  });
  const unregisterConnectionDisposer = registerTerminalConnectionDisposer(
    bindings.identity,
    (sendRemoteDetach) => {
      leaseDisposed = true;
      invalidateLinks();
      refs.linkReady.current = false;
      ui.setFileLinkMenu(null);
      const terminalId = attachedTerminal.current ?? desiredTerminal.current;
      if (sendRemoteDetach && terminalId && client.isCurrent())
        detachTerminal(client, terminalId);
    },
  );

  const resizeSync = new TerminalResizeSync((size) => {
    const terminalId = attachedTerminal.current;
    if (!terminalId) return false;
    const relaySize = bindings.relayViewportFor(size);
    client
      .call("terminal.resize", {
        terminal_id: terminalId,
        cols: size.cols,
        rows: size.rows,
        relay_active: relaySize !== null,
        ...(relaySize
          ? { relay_cols: relaySize.cols, relay_rows: relaySize.rows }
          : {}),
      })
      .catch(() => {
        if (client.isCurrent() && attachedTerminal.current === terminalId) {
          resizeSync.markFailed(size);
        }
      });
    return true;
  });
  refs.resizeSync.current = resizeSync;

  const applyDensity = () => {
    touch.reset();
    closeTerminalInput();
    term.options = terminalDensity(refs.uiScale.current);
    const size = fitVisibleTerminal();
    if (size) resizeSync.sendNow(size);
  };
  window.addEventListener(LAYOUT_CHANGE_EVENT, applyDensity, {
    signal: abort.signal,
  });

  let selectionBounds = container.getBoundingClientRect();
  const ro = new ResizeObserver(() => {
    const bounds = container.getBoundingClientRect();
    if (
      bounds.width !== selectionBounds.width ||
      bounds.height !== selectionBounds.height
    ) {
      touch.reset();
    }
    selectionBounds = bounds;
    const size = fitVisibleTerminal();
    if (!size) return;
    resizeSync.schedule(size);
  });
  ro.observe(container);

  return session;
}
