import { lazyPanel } from "../lazyWithReload";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { shortcutMatches } from "../shortcutPreferences";
import type { ITheme, Terminal } from "@xterm/xterm";
import { Keyboard } from "lucide-react";
import { usePaneControl } from "../usePaneControl";
import { paneDisplayName } from "../paneIdentity";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { keyboardOverlayOpen } from "./ui/overlayState";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TerminalPaneHeader } from "./terminal/TerminalPaneHeader";
import {
  INPUT_ONLY_FRAME_INTERVAL_MS,
  loadTerminalPreviewMode,
  saveTerminalPreviewMode,
  TerminalTextPreview,
  type TerminalPreviewMode,
} from "./terminal/TerminalPreview";
import "@xterm/xterm/css/xterm.css";
import { bridge } from "../api";
import {
  defaultMobileTerminalShortcutRows,
  defaultMobileTerminalSideShortcuts,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import { paneCanClose } from "../paneJump";
import { HerdrSetupCard } from "./HerdrSetupCard";
import { store, terminalNavigationLoading, useStoreSelector } from "../store";
import {
  clearTerminalComposerDrafts,
  insertIntoTerminalComposerDraft,
  readTerminalComposerDraft,
  submitTerminalComposerDraft,
  terminalComposerCloseWarning,
  terminalComposerDraftKey,
  terminalComposerDraftPaneIds,
  terminalComposerSend,
} from "../terminalComposer";
import { agentKind } from "../agentKind";
import { useLayoutPreferences } from "../layoutPreferences";
import { useKeyboardKind } from "../hardwareKeyboard";
import type { EditorSpan } from "./promptEditor/metrics";
import {
  coarsePrimaryPointer,
  localEditorsAvailable,
  programmaticFocusAllowed,
} from "../localEditorPolicy";
import {
  setPromptEditorPaneOpen,
  usePromptEditorOpen,
} from "../promptEditorPreferences";
import { useStartupSettled } from "../startupGate";
import {
  type TerminalConnectionIdentity,
  terminalConnectionKey,
} from "../terminalConnection";
import { uploadTerminalImage } from "../terminalImageUpload";
import { TerminalImagePreviews } from "./terminal/TerminalImagePreviews";
import type { TerminalFileLinkMenuState } from "./TerminalFileLinkMenu";
import {
  createWorkspaceDialog,
  promptEditorPanel,
  shellEditorPanel,
  terminalComposerPanel,
  terminalConfirmDialog,
  terminalFileLinkMenuPanel,
  terminalMessageDialog,
} from "./lazyPanels";
import { LazyBoundary, LazyPendingStatus, Latched } from "./LazyBoundary";
import { directoryPreviewName } from "../filesystemPaths";
import type { TerminalTouchSelection } from "../terminalTouchSelection";
import { paneHasAgentHistory } from "./agentSession";
import {
  TerminalVoiceButton,
  TerminalVoicePanel,
  useTerminalVoiceTyping,
} from "./TerminalVoiceTyping";
import {
  TerminalShortcutGrid,
  TerminalSideShortcuts,
  terminalShortcutActions,
  useTerminalModifiers,
} from "./terminal/TerminalShortcuts";
import { TerminalTouchSelectionBar } from "./terminal/TerminalTouchSelectionBar";
import { usePaneSwipe } from "./terminal/paneSwipe";
import { setTerminalZoom } from "../touchGestures";
import {
  focusTerminalEndpoint,
  sendTerminalBytes,
  setTerminalStdinDisabled,
  type TerminalTouchLinkState,
  type TerminalViewSetters,
  type TerminalWorkspaceFileRequest,
  useDelayedFlag,
  useTerminalInput,
  useTerminalRefs,
} from "./terminal/terminalSession";
import { bytesToB64, isEditableElement } from "../utils";
import {
  useTerminalAppearance,
  useTerminalAttach,
  useTerminalBindings,
  useTerminalSession,
} from "./terminal/useTerminalSession";
import "./TerminalView.css";
import { useShallow } from "zustand/react/shallow";

export type { TerminalWorkspaceFileRequest };

// Surfaces a terminal opens on demand load with their first use, keeping
// the terminal chunk down to what first output and input need.
const TerminalComposer = terminalComposerPanel.Component;
const PromptEditor = promptEditorPanel.Component;
const ShellEditor = shellEditorPanel.Component;
const TerminalFileLinkMenu = terminalFileLinkMenuPanel.Component;
// Only read-only viewers open it, so the app shell never prefetches it.
const TerminalHistory = lazyPanel("terminal-history", () =>
  import("./terminal/TerminalHistory").then((module) => module.TerminalHistory),
).Component;
const CreateWorkspaceDialog = createWorkspaceDialog.Component;
const ConfirmDialog = terminalConfirmDialog.Component;
const Dialog = terminalMessageDialog.Component;

// Between a typed single-line draft and its Enter; see submitTerminalComposer.
const TYPED_ENTER_DELAY_MS = 200;
// Height of the floating touch controls at the pane's bottom, with margins.
const FLOATING_ACTIONS_CLEARANCE = 60;

// A switch that resolves within this window shows no spinner at all, which
// reads as an instant switch instead of a flash of loading chrome. Set well
// above the round trip a local attach actually takes: a spinner that appears
// and leaves again is more distracting than a terminal that stays briefly
// blank, and a switch is still perceived as immediate far past this point.
const TERMINAL_LOADING_SPINNER_DELAY_MS = 500;

function TerminalStatus({ children }: { children: ReactNode }) {
  return (
    <div className="terminal-loading" role="status" aria-live="polite">
      <span className="terminal-loading-dot" />
      <span>{children}</span>
    </div>
  );
}

/** A prop-controlled open flag that falls back to local state. */
function useOpenState(
  controlled: boolean | undefined,
  onChange: ((open: boolean) => void) | undefined,
) {
  const [local, setLocal] = useState(false);
  const setOpen = useCallback(
    (open: boolean) => {
      if (controlled === undefined) setLocal(open);
      onChange?.(open);
    },
    [controlled, onChange],
  );
  return [controlled ?? local, setOpen] as const;
}

export function TerminalView({
  paneId,
  terminalTheme,
  uiScale,
  fontFamily = "",
  showMobileKeys = true,
  mobileShortcuts = defaultMobileTerminalShortcutRows(),
  mobileSideShortcuts = defaultMobileTerminalSideShortcuts(),
  composerOpen: controlledComposerOpen,
  onComposerOpenChange,
  agentHistoryOpen: controlledAgentHistoryOpen,
  onAgentHistoryOpenChange,
  onOpenWorkspaceFile,
}: {
  paneId?: string;
  terminalTheme: ITheme;
  uiScale: number;
  fontFamily?: string;
  showMobileKeys?: boolean;
  mobileShortcuts?: MobileTerminalShortcutRows;
  mobileSideShortcuts?: MobileTerminalSideShortcuts;
  composerOpen?: boolean;
  onComposerOpenChange?: (open: boolean) => void;
  agentHistoryOpen?: boolean;
  onAgentHistoryOpenChange?: (open: boolean) => void;
  onOpenWorkspaceFile?: (request: TerminalWorkspaceFileRequest) => void;
}) {
  const s = useStoreSelector(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      defaultConnectionId: state.defaultConnectionId,
      connectionGeneration: state.connectionGeneration,
      connectionPaused: state.connectionPaused,
      connections: state.connections,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      terminalAttachEpoch: state.terminalAttachEpoch,
      endpointAvailability: state.endpointAvailability,
      tabs: state.tabs,
      navigationLoading: terminalNavigationLoading(state),
      error: state.error,
    })),
  );
  const terminalIdentity = useMemo<TerminalConnectionIdentity>(
    () => ({
      connectionId: s.activeConnectionId,
      generation: s.connectionGeneration,
    }),
    [s.activeConnectionId, s.connectionGeneration],
  );
  const serverRuntimeGeneration =
    s.connections.find(
      (connection) => connection.id === terminalIdentity.connectionId,
    )?.generation ?? null;
  const baseConnectionClient = useMemo(
    () =>
      bridge.connection(terminalIdentity.connectionId, serverRuntimeGeneration),
    [serverRuntimeGeneration, terminalIdentity],
  );
  const connectionScopeKey = terminalConnectionKey(terminalIdentity);
  const control = usePaneControl(
    baseConnectionClient,
    paneId ??
      (s.selectedPaneId &&
      s.layout?.panes.some((item) => item.pane_id === s.selectedPaneId)
        ? s.selectedPaneId
        : s.layout?.focused_pane_id),
  );
  const connectionClient = control.client;
  const assertInputAllowed = control.assertInputAllowed;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [fileLinkMenu, setFileLinkMenu] =
    useState<TerminalFileLinkMenuState | null>(null);
  const [touchLink, setTouchLink] = useState<TerminalTouchLinkState | null>(
    null,
  );
  const [workspaceDirectory, setWorkspaceDirectory] = useState<string | null>(
    null,
  );
  const [terminalLoading, setTerminalLoading] = useState(
    s.status === "connected" && !s.connectionPaused,
  );
  const [terminalAttachError, setTerminalAttachError] = useState("");
  const [pasteLoading, setPasteLoading] = useState(false);
  const [zoomBadge, setZoomBadge] = useState<number | null>(null);
  const terminalLoadingSpinner = useDelayedFlag(
    terminalLoading,
    TERMINAL_LOADING_SPINNER_DELAY_MS,
  );
  const navigationLoadingSpinner = useDelayedFlag(
    s.navigationLoading,
    TERMINAL_LOADING_SPINNER_DELAY_MS,
  );
  const [attachRetry, setAttachRetry] = useState(0);
  const [touchHandles, setTouchHandles] = useState<
    TerminalTouchSelection["handles"]
  >([]);
  const [mobileKeysOpen, setMobileKeysOpen] = useState(false);
  const [closePaneRequested, setClosePaneRequested] = useState(false);
  // A read-only viewer's history scroll opens a local copy of the scrollback
  // (lines above the bottom to start at) instead of moving Herdr's view.
  const [historyLines, setHistoryLines] = useState<number | null>(null);
  useEffect(() => {
    const localScroll = control.localScroll;
    localScroll.current = (params) => {
      if (params.direction !== "up") return;
      const lines = typeof params.lines === "number" ? params.lines : 3;
      setHistoryLines((open) => open ?? lines);
    };
    return () => {
      localScroll.current = null;
    };
  }, [control.localScroll]);
  // Mirrors refs.term as state so the attach effect re-runs when the xterm
  // instance is recreated: the session's disposal resets the attach state,
  // and without an instance change in the deps the attach effect would not
  // fire again, leaving the recreated terminal detached and blank.
  const [termInstance, setTermInstance] = useState<Terminal | null>(null);
  const ui = useMemo<TerminalViewSetters>(
    () => ({
      setTermInstance,
      setFileLinkMenu,
      setTouchLink,
      setTouchHandles,
      setTerminalLoading,
      setTerminalAttachError,
      retryAttach: () => setAttachRetry((value) => value + 1),
      setPasteLoading,
      setUploadError,
      setZoomBadge,
    }),
    [],
  );
  usePaneSwipe(container);
  const selectedPaneInLayout =
    s.selectedPaneId &&
    s.layout?.panes.some((p) => p.pane_id === s.selectedPaneId)
      ? s.selectedPaneId
      : null;
  const pane = paneId
    ? (s.panes.find((p) => p.pane_id === paneId) ?? null)
    : (s.panes.find((p) => p.pane_id === selectedPaneInLayout) ??
      s.panes.find((p) => p.pane_id === s.layout?.focused_pane_id) ??
      null);
  const activePaneId =
    selectedPaneInLayout ?? s.layout?.focused_pane_id ?? null;
  const isActivePane = !!pane && (!paneId || pane.pane_id === activePaneId);
  const canShowAgentHistory = isActivePane && paneHasAgentHistory(pane);
  const canClosePane = !!pane && paneCanClose(s.panes, pane.pane_id);
  const paneTab = pane
    ? s.tabs.find((tab) => tab.tab_id === pane.tab_id)
    : undefined;
  const paneName = pane
    ? paneDisplayName(pane, {
        tabLabel: paneTab?.label,
        tabPaneCount: paneTab?.pane_count,
      })
    : t("Terminal");
  const paneZoomed =
    s.layout?.zoomed === true && s.layout.focused_pane_id === pane?.pane_id;
  const [composerOpen, setComposerOpen] = useOpenState(
    controlledComposerOpen,
    onComposerOpenChange,
  );
  const refs = useTerminalRefs({
    composerOpen,
    viewOnly: control.access.viewOnly,
    terminalTheme,
    uiScale,
    fontFamily,
  });
  const { desiredTerminal } = refs;
  refs.fontFamily.current = fontFamily;
  refs.composerOpen.current = composerOpen;
  // Voice typing goes straight into the pane; the composer keeps its own mic.
  const voiceTyping = useTerminalVoiceTyping({
    onInsert: async (text, submit) => {
      // Dictation lands in the prompt editor's draft while it covers the
      // agent's box, so it is seen (and edited) before it is sent.
      const editorKey = refs.paneId.current
        ? terminalComposerDraftKey(
            s.activeConnectionId,
            s.connectionGeneration,
            refs.paneId.current,
          )
        : null;
      if (editorKey && refs.promptEditor.current?.visible()) {
        if (refs.promptEditor.current.insertText) {
          await refs.promptEditor.current.insertText(text, submit);
          return;
        }
        insertIntoTerminalComposerDraft(editorKey, text);
        if (submit)
          await submitTerminalComposerDraft(
            editorKey,
            readTerminalComposerDraft(editorKey),
            (draft) => submitTerminalComposer(draft, true),
          );
        return;
      }
      try {
        assertInputAllowed();
        await submitTerminalComposer(text, submit);
      } catch (error) {
        const paneId = refs.paneId.current;
        if (!paneId) throw error;
        insertIntoTerminalComposerDraft(
          terminalComposerDraftKey(
            s.activeConnectionId,
            s.connectionGeneration,
            paneId,
          ),
          text,
        );
        throw new Error(
          t("{error}. The dictation was kept in the composer draft.", {
            error: error instanceof Error ? error.message : String(error),
          }),
          { cause: error },
        );
      }
    },
    onError: (message) =>
      store.notify({
        kind: "error",
        message: t("Voice typing"),
        detail: message,
      }),
    keyboard: isActivePane && !control.access.viewOnly,
  });
  const { inputActive, closeTerminalInput, openTerminalInput } =
    useTerminalInput(refs);
  const modifiers = useTerminalModifiers();
  const sessionBindings = useTerminalBindings({
    container,
    client: connectionClient,
    identity: terminalIdentity,
    refs,
    ui,
    applyModifiers: modifiers.applyModifiers,
    assertInputAllowed,
    closeTerminalInput,
    openTerminalInput,
  });
  const { focusTerminalSoon } = sessionBindings;
  useLayoutEffect(() => {
    refs.linkRevision.current++;
    refs.term.current?.refresh(0, refs.term.current.rows - 1);
    setFileLinkMenu(null);
    setWorkspaceDirectory(null);
    if (desiredTerminal.current !== (pane?.terminal_id ?? null))
      refs.presentation.current?.reset(true);
    refs.touchSelection.current?.reset();
    closeTerminalInput();
  }, [
    desiredTerminal,
    refs,
    closeTerminalInput,
    composerOpen,
    connectionClient,
    pane?.pane_id,
    pane?.terminal_id,
    pane?.workspace_id,
    pane?.tab_id,
    s.layout?.tab_id,
    uiScale,
    s.status,
    s.connectionPaused,
    s.terminalAttachEpoch,
    attachRetry,
    termInstance,
  ]);
  useLayoutEffect(() => {
    // Selecting a split is not new link content: preserve its mouse-down link.
    // Still end mobile input/selection and dismiss actions on focus changes.
    setFileLinkMenu(null);
    setWorkspaceDirectory(null);
    refs.touchSelection.current?.reset();
    closeTerminalInput();
  }, [closeTerminalInput, isActivePane, refs]);
  useLayoutEffect(() => {
    refs.viewOnly.current = control.access.viewOnly;
    if (!termInstance) return;
    if (control.access.viewOnly) {
      setTerminalStdinDisabled(termInstance, true);
      termInstance.blur();
    } else {
      closeTerminalInput(false);
    }
  }, [closeTerminalInput, control.access.viewOnly, refs, termInstance]);
  // A device that may not size the pane mirrors the displaying device's size,
  // scaled to fit. Gaining the right to size it (taking control, pinning the
  // display here) sizes the pane for this viewport at once.
  const { canResize, inputOnly } = control.access;
  const couldResize = useRef(canResize);
  useLayoutEffect(() => {
    refs.followShared.current = !canResize;
    const gained = canResize && !couldResize.current;
    couldResize.current = canResize;
    if (!termInstance) return;
    const size = sessionBindings.fitVisibleTerminal();
    if (!gained || !size || !pane?.terminal_id) return;
    void connectionClient
      .call("terminal.resize", {
        terminal_id: pane.terminal_id,
        cols: size.cols,
        rows: size.rows,
      })
      .catch(() => {});
  }, [
    canResize,
    connectionClient,
    termInstance,
    pane?.terminal_id,
    refs,
    sessionBindings,
  ]);
  // Input-only devices preview at a reduced frame rate, or take no frames
  // while showing the text preview. Other devices' streams are unaffected.
  const [previewMode, setPreviewMode] = useState<TerminalPreviewMode>(
    loadTerminalPreviewMode,
  );
  const [inputEpoch, setInputEpoch] = useState(0);
  const frameInterval = inputOnly ? INPUT_ONLY_FRAME_INTERVAL_MS : 0;
  const framesPaused = inputOnly && previewMode === "text";
  useEffect(() => {
    const changed =
      refs.frameInterval.current !== frameInterval ||
      refs.framesPaused.current !== framesPaused;
    refs.frameInterval.current = frameInterval;
    refs.framesPaused.current = framesPaused;
    const terminalId = refs.attachedTerminal.current;
    if (!changed || !terminalId) return;
    void connectionClient
      .call("terminal.stream", {
        terminal_id: terminalId,
        min_frame_interval_ms: frameInterval,
        paused: framesPaused,
      })
      .catch(() => {});
  }, [connectionClient, frameInterval, framesPaused, refs]);
  const wasInputOnly = useRef(inputOnly);
  useEffect(() => {
    // Typing here while another device displays the pane: the composer (with
    // voice and modifier keys) is the input surface.
    if (inputOnly && !wasInputOnly.current && isActivePane)
      setComposerOpen(true);
    wasInputOnly.current = inputOnly;
  }, [inputOnly, isActivePane, setComposerOpen]);
  const changePreviewMode = useCallback((mode: TerminalPreviewMode) => {
    saveTerminalPreviewMode(mode);
    setPreviewMode(mode);
  }, []);
  // The local editors: the desktop layout on any pointer, for writers. The
  // prompt editor covers agent panes, the shell command line the others.
  const { mobile } = useLayoutPreferences();
  const [coarsePointer] = useState(coarsePrimaryPointer);
  const localEditors = localEditorsAvailable(mobile);
  const promptAgent = agentKind(pane?.agent);
  const promptEditorKey = pane
    ? terminalComposerDraftKey(
        s.activeConnectionId,
        s.connectionGeneration,
        pane.pane_id,
      )
    : "";
  const promptEditorAvailable =
    !!pane &&
    promptAgent !== "unknown" &&
    localEditors &&
    !control.access.viewOnly;
  const promptEditorOpen = usePromptEditorOpen(
    promptEditorKey,
    promptEditorAvailable,
  );
  const startupSettled = useStartupSettled();
  const showPromptEditor =
    promptEditorOpen && startupSettled && !!termInstance && !composerOpen;
  // Touch devices move focus for the user only with a hardware keyboard.
  const keyboardKind = useKeyboardKind();
  const focusAllowed = programmaticFocusAllowed(coarsePointer, keyboardKind);
  // The floating touch controls stand above a local editor that reaches the
  // bottom of the pane, where they would cover its text and buttons.
  const [editorSpan, setEditorSpan] = useState<EditorSpan | null>(null);
  const mainHeight =
    editorSpan && container?.parentElement
      ? container.parentElement.getBoundingClientRect().height
      : 0;
  const floatingActionsBottom =
    editorSpan && editorSpan.bottom > mainHeight - FLOATING_ACTIONS_CLEARANCE
      ? mainHeight - editorSpan.top + 8
      : null;
  // An editor hands its keys back to the terminal. On a touch device only
  // from a focused editor, and a hardware keyboard's keys also open the
  // terminal's input; with the on-screen keyboard the editor just lets go,
  // and the next tap decides where typing goes.
  const focusTerminal = useCallback(() => {
    const term = refs.term.current;
    if (!term) return;
    if (coarsePointer) {
      if (!refs.promptEditor.current?.hasFocus()) return;
      if (!focusAllowed) {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement) focused.blur();
        return;
      }
      openTerminalInput(
        term,
        refs.composerOpen.current ||
          refs.touchSelection.current?.active === true,
      );
    }
    term.focus();
  }, [coarsePointer, focusAllowed, openTerminalInput, refs]);
  const setPromptEditorOpen = useCallback(
    (open: boolean) => {
      if (!open && refs.promptEditor.current?.hasFocus()) focusTerminal();
      setPromptEditorPaneOpen(promptEditorKey, open);
    },
    [focusTerminal, promptEditorKey, refs],
  );
  useEffect(() => {
    if (!isActivePane || !promptEditorAvailable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const toggle = shortcutMatches(e, "promptEditor.toggle");
      if (!toggle && !shortcutMatches(e, "promptEditor.focus")) return;
      // Dialogs and menus own the keyboard while open.
      if (keyboardOverlayOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const editor = refs.promptEditor.current;
      if (toggle) setPromptEditorOpen(!promptEditorOpen);
      else if (editor?.hasFocus()) focusTerminal();
      else if (!promptEditorOpen) setPromptEditorOpen(true);
      else editor?.focus();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [
    focusTerminal,
    isActivePane,
    promptEditorAvailable,
    promptEditorOpen,
    refs,
    setPromptEditorOpen,
  ]);
  const [agentHistoryOpen, setAgentHistoryOpen] = useOpenState(
    controlledAgentHistoryOpen,
    onAgentHistoryOpenChange,
  );
  useLayoutEffect(() => {
    refs.onOpenWorkspaceFile.current = onOpenWorkspaceFile;
    refs.isActivePane.current = isActivePane;
    refs.workspaceId.current = pane?.workspace_id;
    refs.paneTerminalId.current = pane?.terminal_id;
    refs.paneId.current = pane?.pane_id;
    refs.paneTabId.current = pane?.tab_id;
    refs.paneLayout.current = s.layout;
  }, [
    refs,
    onOpenWorkspaceFile,
    isActivePane,
    pane?.workspace_id,
    pane?.terminal_id,
    pane?.pane_id,
    pane?.tab_id,
    s.layout,
  ]);
  const focusEndpoint = useCallback(() => {
    focusTerminalEndpoint(connectionClient, refs.paneTerminalId.current);
  }, [connectionClient, refs]);
  useEffect(() => {
    if (isActivePane) focusEndpoint();
  }, [focusEndpoint, isActivePane, pane?.terminal_id]);
  useEffect(() => {
    if (!container) return;
    // Clicking the already-selected pane must also reclaim its cursor after
    // another client has changed the shared same-tab focus.
    container.addEventListener("pointerdown", focusEndpoint);
    return () => container.removeEventListener("pointerdown", focusEndpoint);
  }, [container, focusEndpoint]);
  useEffect(() => {
    if (isActivePane) focusTerminalSoon();
  }, [focusTerminalSoon, isActivePane]);
  useEffect(() => {
    if (!canShowAgentHistory && agentHistoryOpen) setAgentHistoryOpen(false);
  }, [agentHistoryOpen, canShowAgentHistory, setAgentHistoryOpen]);
  useEffect(() => {
    if (!isActivePane || !canShowAgentHistory) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || keyboardOverlayOpen()) return;
      const isHistoryShortcut = shortcutMatches(e, "terminal.history");
      if (!isHistoryShortcut) return;
      if (
        isEditableElement(e.target) &&
        !(e.target as HTMLElement).closest(".xterm, .prompt-editor")
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setAgentHistoryOpen(!agentHistoryOpen);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [
    agentHistoryOpen,
    canShowAgentHistory,
    isActivePane,
    setAgentHistoryOpen,
  ]);

  const baseShortcuts = terminalShortcutActions(
    sessionBindings,
    modifiers,
    pane?.terminal_id,
    control.access.viewOnly,
  );
  // The text preview refreshes soon after a key is sent.
  const shortcuts = framesPaused
    ? {
        ...baseShortcuts,
        run: (shortcut: Parameters<typeof baseShortcuts.run>[0]) => {
          baseShortcuts.run(shortcut);
          setInputEpoch((value) => value + 1);
        },
      }
    : baseShortcuts;
  const openPathInInspector = useCallback(
    (path: string) => {
      if (!connectionClient.isCurrent()) return;
      const workspaceId = refs.workspaceId.current;
      if (!workspaceId) {
        store.notify({
          kind: "error",
          message: t("Cannot browse file"),
          detail: t("No active workspace is available."),
        });
        return;
      }
      refs.onOpenWorkspaceFile.current?.({
        connectionId: terminalIdentity.connectionId,
        connectionGeneration: terminalIdentity.generation,
        workspaceId,
        paneId: refs.paneId.current ?? undefined,
        path,
      });
    },
    [connectionClient, refs, terminalIdentity],
  );

  useTerminalSession(sessionBindings);
  useTerminalAttach(sessionBindings, termInstance, pane?.terminal_id ?? null, {
    status: s.status,
    attachEpoch: s.terminalAttachEpoch,
    attachRetry,
  });
  useTerminalAppearance(sessionBindings, termInstance, {
    terminalTheme,
    uiScale,
    fontFamily,
  });

  const submitTerminalComposer = async (text: string, submit: boolean) => {
    const targetPaneId = refs.paneId.current;
    if (!targetPaneId) throw new Error(t("No active pane"));
    const send = terminalComposerSend(targetPaneId, text, submit);
    if (send.kind === "paste") {
      await connectionClient.call(send.request.method, send.request.params);
    } else {
      const terminalId =
        refs.desiredTerminal.current ?? refs.paneTerminalId.current;
      if (!terminalId) throw new Error(t("No active pane"));
      const type = (data: string) =>
        connectionClient.call("terminal.input", {
          terminal_id: terminalId,
          data: bytesToB64(new TextEncoder().encode(data)),
        });
      if (send.text) await type(send.text);
      if (send.enter) {
        // Codex reads an Enter that arrives with a burst of characters as a
        // line break in a paste; a pause makes it the submit key.
        if (send.text)
          await new Promise((resolve) =>
            window.setTimeout(resolve, TYPED_ENTER_DELAY_MS),
          );
        await type("\r");
      }
    }
    if (framesPaused) setInputEpoch((value) => value + 1);
  };
  const voiceTypingDisabledReason = control.access.viewOnly
    ? t("This pane is view only")
    : s.status !== "connected" || s.connectionPaused || terminalAttachError
      ? t("The terminal is not connected")
      : null;

  const uploadErrorDialog = (
    <Latched open={!!uploadError}>
      <Dialog
        open={!!uploadError}
        onOpenChange={(open) => {
          if (!open) setUploadError("");
        }}
        title={t("Upload Failed")}
        size="sm"
        role="alertdialog"
        footer={
          <Button
            variant="primary"
            size="md"
            autoFocus
            onClick={() => setUploadError("")}
          >
            {t("OK")}
          </Button>
        }
      >
        {uploadError}
      </Dialog>
    </Latched>
  );

  if (!pane) {
    return (
      <>
        <div className="terminal-empty">
          <HerdrSetupCard
            key={connectionScopeKey}
            enabled={
              !s.connectionPaused &&
              s.activeConnectionId === s.defaultConnectionId
            }
          >
            {s.error ? (
              <div className="terminal-empty-stack" role="alert">
                <span>{s.error}</span>
                <Button
                  variant="secondary"
                  onClick={() => void store.refresh()}
                >
                  {t("Retry")}
                </Button>
              </div>
            ) : s.navigationLoading ? (
              // Stay blank for the grace window rather than falling through to
              // the prompt below, which would read as "nothing is happening".
              navigationLoadingSpinner ? (
                <TerminalStatus>{t("Loading terminal")}</TerminalStatus>
              ) : null
            ) : (
              <span className="muted">
                {t("Select a workspace or agent to open its terminal.")}
              </span>
            )}
          </HerdrSetupCard>
        </div>
        {uploadErrorDialog}
      </>
    );
  }

  const composerDraftKey = terminalComposerDraftKey(
    s.activeConnectionId,
    s.connectionGeneration,
    pane.pane_id,
  );
  const composerDraftWarning = terminalComposerCloseWarning(
    terminalComposerDraftPaneIds(s.activeConnectionId, s.connectionGeneration, [
      pane.pane_id,
    ]).length,
  );
  const selecting = touchHandles.length > 0;

  return (
    <>
      {fileLinkMenu
        ? createPortal(
            <LazyBoundary fallback={<LazyPendingStatus />}>
              <TerminalFileLinkMenu
                state={fileLinkMenu}
                client={connectionClient}
                onClose={() => setFileLinkMenu(null)}
                onPreview={openPathInInspector}
                onWorkspace={setWorkspaceDirectory}
              />
            </LazyBoundary>,
            document.body,
          )
        : null}
      <Latched open={workspaceDirectory !== null}>
        <CreateWorkspaceDialog
          open={workspaceDirectory !== null}
          initialCwd={workspaceDirectory ?? ""}
          initialName={directoryPreviewName(workspaceDirectory ?? "")}
          onClose={() => setWorkspaceDirectory(null)}
        />
      </Latched>
      {selecting ? (
        <TerminalTouchSelectionBar
          handles={touchHandles}
          touchLink={touchLink}
          refs={refs}
          onTouchLinkChange={setTouchLink}
          onFileLinkMenu={setFileLinkMenu}
          onCopyError={setUploadError}
        />
      ) : null}
      <div className="terminal-shell">
        <TerminalPaneHeader
          pane={pane}
          paneName={paneName}
          isActivePane={isActivePane}
          control={control}
          voiceTyping={voiceTyping}
          voiceTypingDisabledReason={voiceTypingDisabledReason}
          paneZoomed={paneZoomed}
          canClosePane={canClosePane}
          endpointAvailable={!!s.endpointAvailability[pane.terminal_id]}
          onClosePane={() => setClosePaneRequested(true)}
          previewMode={previewMode}
          onPreviewModeChange={changePreviewMode}
          promptEditor={
            promptEditorAvailable
              ? {
                  open: promptEditorOpen,
                  toggle: () => setPromptEditorOpen(!promptEditorOpen),
                }
              : undefined
          }
        />
        <div className="terminal-main">
          {/* The follow scale edits classList, so React owns only this attribute. */}
          <div
            ref={setContainer}
            className="terminal-view"
            data-preview={framesPaused ? "text" : undefined}
          />
          {pane &&
          promptAgent === "unknown" &&
          localEditors &&
          !control.access.viewOnly &&
          startupSettled &&
          termInstance &&
          !composerOpen &&
          !framesPaused ? (
            <LazyBoundary>
              <ShellEditor
                key={promptEditorKey}
                client={connectionClient}
                paneId={pane.pane_id}
                draftKey={promptEditorKey}
                term={termInstance}
                terminalTheme={terminalTheme}
                active={isActivePane}
                focusAllowed={focusAllowed}
                controlRef={refs.promptEditor}
                onFocusTerminal={focusTerminal}
                onSpanChange={setEditorSpan}
                onForward={(data) => {
                  const terminalId =
                    refs.desiredTerminal.current ?? pane.terminal_id;
                  if (terminalId)
                    sendTerminalBytes(
                      connectionClient,
                      new TextEncoder().encode(data),
                      terminalId,
                    );
                }}
              />
            </LazyBoundary>
          ) : null}
          {termInstance && pane?.workspace_id && !framesPaused ? (
            <TerminalImagePreviews
              key={promptEditorKey}
              term={termInstance}
              client={connectionClient}
              workspaceId={pane.workspace_id}
              cwd={pane.cwd}
              onOpen={(path) =>
                onOpenWorkspaceFile?.({
                  connectionId: terminalIdentity.connectionId,
                  connectionGeneration: terminalIdentity.generation,
                  workspaceId: pane.workspace_id,
                  paneId: pane.pane_id,
                  path,
                })
              }
            />
          ) : null}
          {showPromptEditor && termInstance ? (
            <LazyBoundary>
              <PromptEditor
                key={promptEditorKey}
                draftKey={promptEditorKey}
                agent={promptAgent}
                term={termInstance}
                terminalTheme={terminalTheme}
                active={isActivePane}
                coarsePointer={coarsePointer}
                focusAllowed={focusAllowed}
                enterSends={!coarsePointer || keyboardKind === "hardware"}
                dockOnly={framesPaused}
                controlRef={refs.promptEditor}
                onSubmit={(text) => submitTerminalComposer(text, true)}
                onForward={(data) => {
                  const terminalId =
                    refs.desiredTerminal.current ?? pane.terminal_id;
                  if (control.access.viewOnly || !terminalId) return;
                  sendTerminalBytes(
                    connectionClient,
                    new TextEncoder().encode(data),
                    terminalId,
                  );
                  if (framesPaused) setInputEpoch((value) => value + 1);
                }}
                onPage={(direction) => sessionBindings.scrollPage(direction)}
                onUploadImage={async (file) => {
                  assertInputAllowed();
                  return uploadTerminalImage(connectionClient, file);
                }}
                onError={(message) =>
                  store.notify({
                    kind: "error",
                    message: t("Prompt editor"),
                    detail: message,
                  })
                }
                onClose={() => setPromptEditorOpen(false)}
                onFocusTerminal={focusTerminal}
                onSpanChange={setEditorSpan}
              />
            </LazyBoundary>
          ) : null}
          {zoomBadge !== null ? (
            <Button
              className="terminal-zoom-badge"
              variant="secondary"
              aria-label={t("Reset terminal zoom, currently {zoom}%", {
                zoom: zoomBadge,
              })}
              onClick={() => {
                setZoomBadge(null);
                setTerminalZoom(1);
              }}
            >
              {zoomBadge}%
            </Button>
          ) : null}
          {historyLines !== null && refs.term.current ? (
            <LazyBoundary fallback={<LazyPendingStatus />}>
              <TerminalHistory
                client={connectionClient}
                paneId={pane.pane_id}
                live={refs.term.current}
                follow={refs.followShared.current}
                lines={historyLines}
                onClose={() => {
                  setHistoryLines(null);
                  focusTerminalSoon();
                }}
              />
            </LazyBoundary>
          ) : null}
          {framesPaused ? (
            <TerminalTextPreview
              client={connectionClient}
              paneId={pane.pane_id}
              inputEpoch={inputEpoch}
            />
          ) : null}
          {!selecting &&
          !control.access.readOnly &&
          ((!composerOpen && isActivePane) || voiceTyping.active) ? (
            <div
              className="terminal-mobile-input-actions"
              aria-label={t("Terminal input")}
              style={
                floatingActionsBottom === null
                  ? undefined
                  : { bottom: floatingActionsBottom }
              }
            >
              <TerminalVoiceButton
                voice={voiceTyping}
                iconSize={20}
                disabledReason={voiceTypingDisabledReason}
              />
              {!composerOpen && isActivePane ? (
                <IconButton
                  variant="secondary"
                  label={t("Open device keyboard")}
                  icon={<Keyboard size={20} />}
                  aria-pressed={inputActive}
                  disabled={
                    s.status !== "connected" ||
                    s.connectionPaused ||
                    !!terminalAttachError ||
                    control.access.viewOnly
                  }
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const term = refs.term.current;
                    if (
                      !term ||
                      !connectionClient.isCurrent() ||
                      desiredTerminal.current !== pane.terminal_id
                    )
                      return;
                    openTerminalInput(term, false);
                    term.focus();
                  }}
                />
              ) : null}
            </div>
          ) : null}
          <TerminalVoicePanel voice={voiceTyping} />
          {!selecting &&
          showMobileKeys &&
          !control.access.readOnly &&
          mobileSideShortcuts.some((shortcut) => shortcut !== null) ? (
            <TerminalSideShortcuts
              slots={mobileSideShortcuts}
              shortcuts={shortcuts}
            />
          ) : null}
        </div>
        {!selecting &&
        showMobileKeys &&
        !control.access.readOnly &&
        mobileShortcuts.some((row) =>
          row.some((shortcut) => shortcut !== null),
        ) ? (
          <TerminalShortcutGrid
            rows={mobileShortcuts}
            open={mobileKeysOpen}
            onToggle={() => setMobileKeysOpen((value) => !value)}
            shortcuts={shortcuts}
          />
        ) : null}
        {composerOpen ? (
          <LazyBoundary fallback={<LazyPendingStatus />}>
            <TerminalComposer
              draftKey={composerDraftKey}
              shortcutRows={mobileShortcuts}
              onRunShortcut={shortcuts.run}
              shortcutDisabledReason={shortcuts.disabledReason}
              onClose={() => setComposerOpen(false)}
              onSubmit={submitTerminalComposer}
              onUploadImage={async (file) => {
                assertInputAllowed();
                return uploadTerminalImage(connectionClient, file);
              }}
              onError={(message) =>
                store.notify({
                  kind: "error",
                  message: t("Terminal composer failed"),
                  detail: message,
                })
              }
            />
          </LazyBoundary>
        ) : null}
        {s.connectionPaused ? (
          <TerminalStatus>{t("Connection paused")}</TerminalStatus>
        ) : terminalAttachError ? (
          <div
            className="terminal-loading is-error"
            role="alert"
            aria-live="assertive"
          >
            <span>{terminalAttachError}</span>
          </div>
        ) : terminalLoadingSpinner || pasteLoading ? (
          <TerminalStatus>
            {pasteLoading ? t("Pasting...") : t("Loading terminal")}
          </TerminalStatus>
        ) : null}
      </div>
      <Latched open={closePaneRequested}>
        <ConfirmDialog
          open={closePaneRequested}
          onOpenChange={setClosePaneRequested}
          title={t("Close Pane")}
          message={`${t("Close this terminal pane?")}${composerDraftWarning}`}
          confirmLabel={t("Close")}
          tone="danger"
          onConfirm={() => {
            clearTerminalComposerDrafts(
              s.activeConnectionId,
              s.connectionGeneration,
              [pane.pane_id],
            );
            store.closePane(pane.pane_id);
          }}
        />
      </Latched>
      {uploadErrorDialog}
    </>
  );
}
