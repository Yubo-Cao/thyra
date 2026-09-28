import type { ITheme, Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { resolveTerminalFontFamily } from "../../appearance";
import { t } from "../../i18n";
import { keyboardKindNow } from "../../hardwareKeyboard";
import { activePaneIdForSnapshot } from "../../paneJump";
import { noteTerminalAttached } from "../../startupGate";
import { store } from "../../store";
import { terminalConnectionKey } from "../../terminalConnection";
import {
  type ResolvedTerminalFile,
  TerminalFileResolutionCache,
} from "../../terminalFileLinks";
import { terminalFocusBlockedByOverlay } from "../../terminalFocus";
import {
  readTerminalRecoveryReloadAt,
  shouldArmTerminalRecoveryResume,
  shouldReloadTerminalAfterResume,
  writeTerminalRecoveryReloadAt,
} from "../../terminalRecovery";
import {
  rememberTerminalRelayViewport,
  terminalAttachWatchdogMs,
  terminalEndpointViewportSize,
  terminalRelayViewportSize,
} from "../../terminalResize";
import { terminalPageScroll } from "../../terminalScroll";
import { applyTerminalTheme } from "../../terminalThemes";
import { terminalScreens } from "../../touchGestures";
import { installTerminalKeyboard } from "./terminalKeyboard";
import {
  installTerminalGestures,
  terminalTouchScroll,
} from "./terminalGestures";
import { installTerminalPinch } from "./terminalPinch";
import {
  applyTerminalFollowScale,
  detachTerminal,
  focusTerminalEndpoint,
  openTerminalSession,
  shouldAvoidVirtualKeyboard,
  terminalDensity,
  type TerminalSessionBindings,
  type TerminalViewInputs,
} from "./terminalSession";
import { isEditableElement } from "../../utils";

/** The view callbacks a session runs: fit, focus, scroll, file paths. */
export function useTerminalBindings(
  view: TerminalViewInputs,
): TerminalSessionBindings {
  const { container, client, identity, refs, ui, applyModifiers } = view;
  const { assertInputAllowed, closeTerminalInput, openTerminalInput } = view;
  const focusTerminalSoon = useCallback(() => {
    // Touch devices keep the terminal's input shut until a tap there; with a
    // hardware keyboard only a local editor may take focus for the user.
    const blocked = () =>
      shouldAvoidVirtualKeyboard() && keyboardKindNow() !== "hardware";
    if (
      !refs.isActivePane.current ||
      refs.composerOpen.current ||
      refs.touchSelection.current?.active === true ||
      blocked()
    )
      return;
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (
          !client.isCurrent() ||
          !refs.isActivePane.current ||
          refs.composerOpen.current ||
          refs.touchSelection.current?.active === true ||
          blocked()
        )
          return;
        const term = refs.term.current;
        const active = document.activeElement;
        const activeElement = active instanceof HTMLElement ? active : null;
        // A terminal or a prompt editor (of any pane) is input this pane may
        // take over; other editable fields keep their focus.
        const activeIsTerminalInput = !!activeElement?.closest(
          ".xterm, .prompt-editor, .shell-editor",
        );
        if (!term || (isEditableElement(active) && !activeIsTerminalInput))
          return;
        // Streaming frames must not steal focus from an open popover, dialog,
        // or menu: moving focus out of an overlay dismisses it.
        if (terminalFocusBlockedByOverlay(activeElement, document)) return;
        // Keep whichever of this pane's inputs has focus; otherwise its
        // prompt editor, when shown, is where typing goes.
        const editor = refs.promptEditor.current;
        if (editor?.hasFocus() || term.element?.contains(activeElement)) return;
        if (editor?.focus() || shouldAvoidVirtualKeyboard()) return;
        term.focus();
      }, 0);
    });
  }, [client, refs]);
  // Fits the xterm to its container, unless the container is hidden or
  // unmounted (e.g. the diff/files view covers it with display:none). Fitting
  // a hidden container would collapse the terminal to a 2x1 minimum and leak a
  // bogus resize to the server, so callers must treat null as "keep the last
  // known size everywhere".
  const fitVisibleTerminal = useCallback(() => {
    const term = refs.term.current;
    const fit = refs.fit.current;
    if (!term || !fit) return null;
    if (!container || !container.isConnected) return null;
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      return null;
    }
    // Another device sizes the pane: keep xterm at its size and scale it
    // to fit. There is no size of ours to send.
    if (refs.followShared.current) {
      applyTerminalFollowScale(term, container, true, refs.followPan.current);
      return null;
    }
    applyTerminalFollowScale(term, container, false);
    try {
      fit.fit();
    } catch {
      // A hidden or detaching terminal can reject a transient fit.
    }
    return { cols: term.cols, rows: term.rows };
  }, [container, refs]);
  const relayViewportFor = useCallback(
    (size: { cols: number; rows: number }) => {
      if (!refs.isActivePane.current) return null;
      const relaySize = terminalRelayViewportSize(
        size,
        refs.paneLayout.current,
        refs.paneId.current,
      );
      const tabId = refs.paneTabId.current;
      if (tabId) {
        rememberTerminalRelayViewport(
          identity.connectionId,
          identity.generation,
          tabId,
          relaySize,
        );
      }
      return relaySize;
    },
    [refs, identity],
  );
  const scrollPage = useCallback(
    (direction: "up" | "down", amount: "full" | "half" = "full") => {
      const term = refs.term.current;
      if (!term) return;
      if (shouldAvoidVirtualKeyboard()) term.textarea?.blur();
      const targetTerminalId =
        refs.desiredTerminal.current ?? refs.paneTerminalId.current;
      if (
        !targetTerminalId ||
        (amount === "half" && store.terminalScrollReason(targetTerminalId))
      )
        return;
      refs.linkRevision.current++;
      term.refresh(0, term.rows - 1);
      ui.setFileLinkMenu(null);
      client
        .call("terminal.scroll", {
          terminal_id: targetTerminalId,
          ...terminalPageScroll(direction, term.rows, amount),
        })
        .catch(() => {});
    },
    [client, refs, ui],
  );
  const fileResolution = useMemo(
    () =>
      new TerminalFileResolutionCache(
        async (_scopeId, workspaceId, candidates) => {
          const result = (await client.call("file.resolve", {
            workspace_id: workspaceId,
            paths: candidates,
          })) as { files?: unknown };
          if (!client.isCurrent() || !Array.isArray(result?.files)) {
            return [];
          }
          return result.files.flatMap((value): ResolvedTerminalFile[] => {
            if (!value || typeof value !== "object") return [];
            const file = value as Record<string, unknown>;
            return typeof file.candidate === "string" &&
              typeof file.path === "string"
              ? [{ candidate: file.candidate, path: file.path }]
              : [];
          });
        },
        { isScopeCurrent: () => client.isCurrent() },
      ),
    [client],
  );
  const scopeKey = terminalConnectionKey(identity);
  const resolveFilePaths = useCallback(
    async (paths: string[]) => {
      const workspaceId = refs.workspaceId.current;
      if (!workspaceId) return new Map<string, string>();
      const resolved = await fileResolution.resolve(
        scopeKey,
        workspaceId,
        paths,
      );
      return client.isCurrent() && refs.workspaceId.current === workspaceId
        ? resolved
        : new Map<string, string>();
    },
    [client, scopeKey, refs, fileResolution],
  );
  return useMemo(
    () => ({
      container,
      client,
      identity,
      refs,
      ui,
      applyModifiers,
      assertInputAllowed,
      closeTerminalInput,
      openTerminalInput,
      fitVisibleTerminal,
      focusTerminalSoon,
      relayViewportFor,
      resolveFilePaths,
      scrollPage,
    }),
    [
      applyModifiers,
      assertInputAllowed,
      closeTerminalInput,
      client,
      container,
      fitVisibleTerminal,
      focusTerminalSoon,
      openTerminalInput,
      refs,
      relayViewportFor,
      resolveFilePaths,
      scrollPage,
      identity,
      ui,
    ],
  );
}

/** Owns the xterm instance, recreated whenever the bindings change. */
export function useTerminalSession(bindings: TerminalSessionBindings) {
  useEffect(() => {
    if (!bindings.container) return;
    const session = openTerminalSession(bindings);
    const disposeKeyboard = installTerminalKeyboard(session);
    // One finger and two scroll alike, through one driver.
    const touchScroll = terminalTouchScroll(session);
    // Before the gestures, whose touchend stops later listeners.
    const disposePinch = installTerminalPinch(session, touchScroll);
    const disposeGestures = installTerminalGestures(session, touchScroll);
    return () =>
      session.dispose(() => {
        disposePinch();
        disposeGestures();
        disposeKeyboard();
      });
  }, [bindings]);
}

/** Attaches the pane's terminal, again after reconnects and resumes. */
export function useTerminalAttach(
  bindings: TerminalSessionBindings,
  term: Terminal | null,
  paneTerminalId: string | null,
  {
    status,
    attachEpoch,
    attachRetry,
  }: { status: string; attachEpoch: number; attachRetry: number },
) {
  const { client, refs, ui, fitVisibleTerminal, focusTerminalSoon } = bindings;
  const { relayViewportFor } = bindings;
  const terminalAttachEpoch = useRef(attachEpoch);
  const attachTimeoutTerminal = useRef<string | null>(null);
  // Timestamp of the last foreground resume; gates the last-resort reload.
  const resumedAt = useRef<number | null>(null);
  // When the page last became hidden; measures the suspension length.
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    if (!client.isCurrent()) return;
    const { desiredTerminal, attachedTerminal, attachingTerminal } = refs;
    const { attachWatchdog, attachTimeouts, renderedTerminal } = refs;
    if (desiredTerminal.current !== paneTerminalId || status !== "connected") {
      refs.presentation.current?.reset(
        desiredTerminal.current !== paneTerminalId,
      );
    }
    if (terminalAttachEpoch.current !== attachEpoch) {
      refs.presentation.current?.reset();
      terminalAttachEpoch.current = attachEpoch;
      attachedTerminal.current = null;
      attachingTerminal.current = null;
      attachTimeouts.current = 0;
      attachTimeoutTerminal.current = null;
      attachWatchdog.cancel();
    }
    if (!paneTerminalId) {
      desiredTerminal.current = null;
      attachWatchdog.cancel();
      ui.setTerminalLoading(false);
      ui.setTerminalAttachError("");
      return;
    }
    desiredTerminal.current = paneTerminalId;
    if (status !== "connected") {
      attachedTerminal.current = null;
      attachingTerminal.current = null;
      attachWatchdog.cancel();
      ui.setTerminalLoading(false);
      ui.setTerminalAttachError("");
      return;
    }
    if (!term) return;
    focusTerminalSoon();
    if (attachedTerminal.current === paneTerminalId) return;
    if (attachingTerminal.current === paneTerminalId) return;
    const terminalId = paneTerminalId;
    const staleTerminalIds = [
      attachedTerminal.current,
      attachingTerminal.current,
    ].filter(
      (id, index, ids): id is string =>
        !!id && id !== terminalId && ids.indexOf(id) === index,
    );
    for (const staleTerminalId of staleTerminalIds) {
      detachTerminal(client, staleTerminalId);
    }
    if (staleTerminalIds.length > 0) {
      attachedTerminal.current = null;
      attachingTerminal.current = null;
    }
    if (attachTimeoutTerminal.current !== terminalId) {
      attachTimeoutTerminal.current = terminalId;
      attachTimeouts.current = 0;
    }
    attachingTerminal.current = terminalId;
    ui.setTerminalLoading(true);
    ui.setTerminalAttachError("");
    const attachAttempt = attachWatchdog.begin();
    const fitSize = fitVisibleTerminal();
    const cols = fitSize?.cols ?? term.cols;
    const rows = fitSize?.rows ?? term.rows;
    const relaySize = relayViewportFor({ cols, rows });
    const paneLayout = refs.paneLayout.current;
    const surfaceSize = terminalEndpointViewportSize(
      { cols, rows },
      paneLayout?.tab_id === refs.paneTabId.current ? paneLayout : null,
      refs.paneId.current,
    );
    // Keep the current buffer when re-attaching the same terminal (watchdog
    // retry, reconnect): the server repaints a full frame anyway, and keeping
    // the buffer avoids a blank flash plus losing local scrollback.
    if (renderedTerminal.current !== terminalId) {
      if (renderedTerminal.current)
        terminalScreens.keep?.(renderedTerminal.current, term);
      term.reset();
      refs.presentation.current?.screenChanged();
      renderedTerminal.current = terminalId;
    }
    refs.resizeSync.current?.markAttached({ cols, rows });
    store.setTerminalEndpoint(client, terminalId, null);
    const attachStartedAt = performance.now();
    client
      .call("terminal.attach", {
        terminal_id: terminalId,
        cols,
        rows,
        // Receive endpoint frames as acknowledged row updates.
        frame_delta: true,
        ...(refs.frameInterval.current > 0
          ? { min_frame_interval_ms: refs.frameInterval.current }
          : {}),
        ...(surfaceSize
          ? { surface_cols: surfaceSize.cols, surface_rows: surfaceSize.rows }
          : {}),
        relay_active: relaySize !== null,
        ...(relaySize
          ? { relay_cols: relaySize.cols, relay_rows: relaySize.rows }
          : {}),
      })
      .then(
        (result) => {
          noteTerminalAttached();
          if (!client.isCurrent() || !attachWatchdog.isCurrent(attachAttempt))
            return;
          if (desiredTerminal.current === terminalId)
            store.setTerminalEndpoint(client, terminalId, result?.endpoint);
          if (attachingTerminal.current === terminalId)
            attachingTerminal.current = null;
          if (desiredTerminal.current !== terminalId) return;
          attachedTerminal.current = terminalId;
          // Attaching a split focuses it in Herdr, even in the background.
          // Restore the current selection after each completed attach; use
          // current state so a late response cannot revive an old selection.
          const current = store.get();
          const selectedPaneId = activePaneIdForSnapshot(current);
          focusTerminalEndpoint(
            client,
            current.panes.find((p) => p.pane_id === selectedPaneId)
              ?.terminal_id,
          );
          focusTerminalSoon();
          // Resizes observed while the attach was in flight are dropped by
          // the sync's send guard; push the settled size now (deduped).
          const settledSize = fitVisibleTerminal();
          if (settledSize) refs.resizeSync.current?.sendNow(settledSize);
          // A text preview takes no frames, so none can be awaited.
          if (refs.framesPaused.current) {
            attachWatchdog.cancel(attachAttempt);
            ui.setTerminalLoading(false);
            void client
              .call("terminal.stream", {
                terminal_id: terminalId,
                paused: true,
              })
              .catch(() => {});
            return;
          }
          const watchdogMs = terminalAttachWatchdogMs(
            performance.now() - attachStartedAt,
          );
          attachWatchdog.arm(attachAttempt, watchdogMs, () => {
            if (!client.isCurrent() || desiredTerminal.current !== terminalId)
              return;
            attachTimeouts.current += 1;
            attachedTerminal.current = null;
            attachingTerminal.current = null;
            detachTerminal(client, terminalId);
            if (attachTimeouts.current <= 2) {
              ui.retryAttach();
              return;
            }
            ui.setTerminalLoading(false);
            // Repeated attaches produced no frames right after a foreground
            // resume: the session is wedged in a way in-place recovery cannot
            // fix (silently killed socket, wedged stream). Reload once,
            // rate-limited, replicating the manual refresh that restores the
            // terminal.
            const now = Date.now();
            if (
              shouldReloadTerminalAfterResume({
                now,
                resumedAt: resumedAt.current,
                lastReloadAt: readTerminalRecoveryReloadAt(),
              })
            ) {
              writeTerminalRecoveryReloadAt(now);
              window.location.reload();
              return;
            }
            ui.setTerminalAttachError(
              t(
                "Terminal stopped receiving frames. Reload the app to reconnect.",
              ),
            );
          });
        },
        (e) => {
          noteTerminalAttached();
          if (!client.isCurrent() || !attachWatchdog.isCurrent(attachAttempt))
            return;
          attachWatchdog.cancel(attachAttempt);
          if (attachingTerminal.current === terminalId)
            attachingTerminal.current = null;
          if (desiredTerminal.current === terminalId) {
            attachedTerminal.current = null;
            ui.setTerminalLoading(false);
            ui.setTerminalAttachError(
              e instanceof Error ? e.message : String(e),
            );
          }
          console.error("[term] attach failed", e);
        },
      );
  }, [
    attachEpoch,
    attachRetry,
    client,
    fitVisibleTerminal,
    focusTerminalSoon,
    paneTerminalId,
    refs,
    relayViewportFor,
    status,
    term,
    ui,
  ]);
  // Mobile browsers freeze the page while hidden: the socket can die
  // silently, rendering pauses, and composited content may come back blank.
  // On return, force a repaint and re-arm a stuck attach so the terminal
  // recovers without a full-page reload. A dead socket is handled by the
  // store-level probe, which flips the status and re-arms the attach epoch.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const { desiredTerminal, attachedTerminal, attachingTerminal } = refs;
    const { attachTimeouts } = refs;
    const recoverTerminal = (fromResume: boolean) => {
      if (document.visibilityState !== "visible") return;
      if (fromResume) {
        // Arm the last-resort reload only after a genuinely long suspension
        // (mobile lock screen, app backgrounding). Desktop tab switches
        // fire visibilitychange too; a measured short one keeps the cheap
        // recovery below but never arms an automatic reload.
        const now = Date.now();
        const hiddenSince = hiddenAt.current;
        hiddenAt.current = null;
        if (shouldArmTerminalRecoveryResume({ now, hiddenAt: hiddenSince })) {
          resumedAt.current = now;
        }
      }
      attachTimeouts.current = 0;
      const term = refs.term.current;
      if (term) {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // The attach recovery below still applies.
        }
      }
      if (!desiredTerminal.current) return;
      if (store.get().status !== "connected") return;
      // A live attach keeps streaming on its own; only a terminal that lost
      // its attach (watchdog give-up, failed attach) needs a nudge.
      if (attachedTerminal.current || attachingTerminal.current) return;
      ui.retryAttach();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      recoverTerminal(true);
    };
    const onForegroundEvent = () => recoverTerminal(false);
    const listeners = new AbortController();
    const { signal } = listeners;
    document.addEventListener("visibilitychange", onVisibilityChange, {
      signal,
    });
    window.addEventListener("pageshow", onForegroundEvent, { signal });
    window.addEventListener("focus", onForegroundEvent, { signal });
    return () => listeners.abort();
  }, [refs, ui]);
}

/** Applies theme, UI scale and font changes to the live xterm in place. */
export function useTerminalAppearance(
  { refs, fitVisibleTerminal }: TerminalSessionBindings,
  term: Terminal | null,
  {
    terminalTheme,
    uiScale,
    fontFamily,
  }: { terminalTheme: ITheme; uiScale: number; fontFamily: string },
) {
  useEffect(() => {
    refs.uiScale.current = uiScale;
    if (!term) return;
    term.options = terminalDensity(uiScale);
    const size = fitVisibleTerminal();
    if (size) refs.resizeSync.current?.sendNow(size);
  }, [uiScale, term, fitVisibleTerminal, refs]);

  useEffect(() => {
    if (!term) return;
    const resolved = resolveTerminalFontFamily(fontFamily);
    if (term.options.fontFamily === resolved) return;
    term.options.fontFamily = resolved;
    const size = fitVisibleTerminal();
    if (size) refs.resizeSync.current?.sendNow(size);
  }, [fontFamily, term, fitVisibleTerminal, refs]);

  useEffect(() => {
    refs.terminalTheme.current = terminalTheme;
    if (term) applyTerminalTheme(term, terminalTheme);
  }, [terminalTheme, term, refs]);
}
