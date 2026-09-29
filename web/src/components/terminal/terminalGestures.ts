import { terminalLinkModifierMatches } from "../../shortcutPreferences";
import { store } from "../../store";
import { reserveClipboardWrite } from "../../terminalClipboard";
import { terminalMouseUsesSelection } from "../../terminalEndpointPresentation";
import {
  terminalPointerShouldBlurInput,
  terminalTapOpensInput,
  terminalTouchShouldDismissInput,
} from "../../terminalFocus";
import {
  terminalCellAt,
  terminalCellAtPoint,
  terminalWheelScroll,
} from "../../terminalScroll";
import { TerminalSelectionDragGuard } from "../../terminalSelectionGuard";
import { terminalSelectedText } from "../../terminalTouchSelection";
import {
  cancelEvent,
  copyFinishedSelection,
  terminalClipboardRoot,
  dispatchMouseRelease,
  isSafariBrowser,
  shouldAvoidVirtualKeyboard,
  swallowEvent,
  type TerminalSession,
} from "./terminalSession";
import { TouchScroll } from "./terminalTouchScroll";
import { isEditableElement } from "../../utils";
import {
  terminalSelectionContent,
  terminalMarkdownContent,
} from "../../terminalRichCopy";

const TERMINAL_TOUCH_TAP_SLOP_PX = 8;

/**
 * The terminal's touch scroll, shared by one-finger drags and two-finger
 * pans (terminalPinch): Herdr scrolls its scrollback, or forwards wheel input
 * to a mouse-reporting or full-screen app, and a read-only viewer's request
 * opens its local history view (paneControl).
 */
export function terminalTouchScroll(session: TerminalSession): TouchScroll {
  const { client, refs, ui, term, presentation, signal } = session;
  const scroll = new TouchScroll((lines, at) => {
    session.invalidateLinks();
    ui.setFileLinkMenu(null);
    // A selection or the composer owns a mouse-reporting pane's drags.
    if (
      presentation.mouseReporting !== undefined &&
      (term.hasSelection() ||
        presentation.selectionDrag ||
        refs.composerOpen.current)
    )
      return;
    const terminalId = refs.desiredTerminal.current;
    if (
      !terminalId ||
      store.terminalScrollReason(terminalId, presentation.mouseReporting)
    )
      return;
    client
      .call("terminal.scroll", {
        terminal_id: terminalId,
        direction: lines < 0 ? "up" : "down",
        lines: Math.min(term.rows, Math.abs(lines)),
        source: "wheel",
        ...terminalCellAtPoint(term, at.x, at.y),
      })
      .catch(() => {});
  });
  signal.addEventListener("abort", () => scroll.stop());
  return scroll;
}

// Mouse selections copy on release and extend through history. Touch drags
// scroll, a long-press selects, and a tap on the input rows opens the keyboard.
export function installTerminalGestures(
  session: TerminalSession,
  scroll: TouchScroll,
): () => void {
  const { client, refs, ui, container, term } = session;
  const { desiredTerminal } = refs;
  const { signal, applePlatform, presentation, history, touch } = session;
  const { openTerminalInput, closeTerminalInput } = session;
  let lastPointerType = "";
  // WebKit lacks sourceCapabilities. Compatibility mouse events retain the
  // touch pointer type until a genuine mouse pointerdown replaces it.
  const isTouchMouse = (e: MouseEvent) => {
    const capabilities = (
      e as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }
    ).sourceCapabilities;
    return capabilities?.firesTouchEvents ?? lastPointerType === "touch";
  };
  const capture = { capture: true, signal };
  const selectionChange = term.onSelectionChange(() => {
    if (
      !presentation.selectionDrag &&
      !presentation.writePending &&
      !term.hasSelection()
    )
      history.reset();
    presentation.flush();
  });
  const selectionResize = term.onResize(() => {
    session.invalidateLinks();
    refs.linkReady.current = false;
    session.latestLinkFrame = undefined;
    ui.setFileLinkMenu(null);
    touch.reset();
    history.reset();
    if (presentation.selectionDrag) onSelectionBlur();
    term.clearSelection();
    presentation.cancelSelection();
  });

  const onCopy = (e: ClipboardEvent) => {
    if ((!term.hasSelection() && !history.active) || !e.clipboardData) return;
    const selectedText =
      history.text ??
      (touch.active ? terminalSelectedText(term) : term.getSelection());
    if (!selectedText) return;
    cancelEvent(e);
    const content = terminalSelectionContent(
      selectedText,
      term,
      terminalClipboardRoot(refs),
    );
    e.clipboardData.setData("text/plain", content.text);
    if (content.html) e.clipboardData.setData("text/html", content.html);
  };
  container.addEventListener("copy", onCopy, capture);
  // WebKit enables Copy only for a DOM range selection unless beforecopy is
  // cancelled; xterm's textarea holds just a caret, so opt in explicitly.
  const onBeforeCopy = (e: Event) => {
    if (term.hasSelection() || history.active) e.preventDefault();
  };
  container.addEventListener("beforecopy", onBeforeCopy, capture);

  const onClick = (e: MouseEvent) => {
    if (
      !terminalMouseUsesSelection(presentation.mouseReporting, e, applePlatform)
    )
      return;
    if (!isSafariBrowser() || term.hasSelection()) return;
    term.clearSelection();
    dispatchMouseRelease(container.ownerDocument, e);
  };
  container.addEventListener("click", onClick, { signal });

  // xterm only disarms its document-level drag listeners on mouseup. When
  // the release is lost (released outside the window, or the browser drops
  // the mouseup after the mousedown target was re-rendered mid-gesture),
  // every later move keeps growing the selection without a button pressed.
  // Detect the lost release on the first button-less move and force it.
  const selectionDragGuard = new TerminalSelectionDragGuard();
  let deferredMove: MouseEvent | null = null;
  let deferredUp: MouseEvent | null = null;
  const replayMouse = (target: EventTarget, event: MouseEvent) => {
    // The reporting mode may have changed while parsing. Preserve the
    // original modifiers and add only xterm's local selection escape.
    const forceSelection = term.modes.mouseTrackingMode !== "none";
    target.dispatchEvent(
      new MouseEvent(event.type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: event.button,
        buttons: event.buttons,
        detail: event.detail,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey || (forceSelection && applePlatform),
        shiftKey: event.shiftKey || (forceSelection && !applePlatform),
      }),
    );
  };
  let selectionDragActive = false;
  // A drag handed to the pane app (mouse reporting) may end in an OSC 52
  // copy that arrives after the gesture; reserve the write while it lasts.
  let appDragStart: { x: number; y: number } | null = null;
  const onTerminalMouseDown = (e: MouseEvent) => {
    if (session.replayingSelection) return;
    if (touch.active && !isTouchMouse(e)) touch.reset();
    if (
      (lastPointerType !== "mouse" &&
        window.matchMedia("(pointer: coarse)").matches) ||
      isTouchMouse(e)
    ) {
      swallowEvent(e);
      if (!isTouchMouse(e)) closeTerminalInput();
      return;
    }
    // A physical mouse on a hybrid desktop retains normal xterm input.
    openTerminalInput(
      term,
      refs.composerOpen.current || refs.touchSelection.current?.active === true,
    );
    if (
      e.button === 0 &&
      e.shiftKey &&
      history.extendTo(e.clientX, e.clientY)
    ) {
      // Shift-click after scrolling extends a selection across history.
      swallowEvent(e);
      if (history.text) copyFinishedSelection(history.text, refs);
      return;
    }
    if (
      !terminalMouseUsesSelection(presentation.mouseReporting, e, applePlatform)
    ) {
      appDragStart =
        e.button === 0 && presentation.mouseReporting
          ? { x: e.clientX, y: e.clientY }
          : null;
      return;
    }
    appDragStart = null;
    selectionDragGuard.mouseDown(e.button);
    if (e.button !== 0) return;
    selectionDragActive = true;
    history.reset();
    if (
      presentation.mouseReporting === undefined &&
      !presentation.writePending
    ) {
      presentation.selectionDrag = true;
      return;
    }
    const terminalId = desiredTerminal.current;
    deferredMove = deferredUp = null;
    if (
      !presentation.beginSelection(() => {
        if (
          session.disposed ||
          !client.isCurrent() ||
          terminalId !== desiredTerminal.current ||
          !(e.target instanceof Node) ||
          !e.target.isConnected
        )
          return;
        session.replayingSelection = true;
        try {
          replayMouse(e.target, e);
          if (deferredMove) replayMouse(container.ownerDocument, deferredMove);
          if (deferredUp) replayMouse(container.ownerDocument, deferredUp);
        } finally {
          session.replayingSelection = false;
          deferredMove = deferredUp = null;
        }
      })
    ) {
      swallowEvent(e);
    }
  };
  const onDeferredMouseMove = (e: MouseEvent) => {
    if (
      !presentation.selectionPending &&
      history.move(
        e,
        presentation.selectionDrag && !(e.altKey && !applePlatform),
      )
    ) {
      swallowEvent(e);
      return;
    }
    if (!presentation.selectionPending || deferredUp) return;
    if (e.buttons === 0) {
      // A lost release finalizes at the last held-button move, not this hover.
      deferredUp = new MouseEvent("mouseup", e);
      selectionDragGuard.mouseUp();
    } else {
      deferredMove = e;
    }
    swallowEvent(e);
  };
  const onDocumentMouseUp = (e: MouseEvent) => {
    if (history.releasingNative) return;
    history.finish();
    if (presentation.selectionPending) {
      if (deferredUp) return; // the first release froze this gesture
      deferredUp = e;
      selectionDragGuard.mouseUp();
      swallowEvent(e);
      return;
    }
    if (
      appDragStart &&
      e.button === 0 &&
      Math.hypot(e.clientX - appDragStart.x, e.clientY - appDragStart.y) > 4
    ) {
      session.reservedClipboard?.cancel();
      const root = terminalClipboardRoot(refs);
      session.reservedClipboard = reserveClipboardWrite(4000, (text) =>
        terminalMarkdownContent(text, root),
      );
    }
    appDragStart = null;
    if (
      selectionDragActive &&
      e.button === 0 &&
      !terminalLinkModifierMatches(e)
    ) {
      // Copy inside the release itself: Safari only allows clipboard
      // writes during the gesture.
      const selected = history.text ?? term.getSelection();
      if (selected) copyFinishedSelection(selected, refs);
    }
    selectionDragActive = false;
    selectionDragGuard.mouseUp();
    presentation.selectionDrag = false;
    queueMicrotask(() => {
      if (!session.disposed) presentation.flush();
    });
  };
  const onNativeMouseDown = (e: MouseEvent) => {
    // A new physical gesture anywhere owns document listeners now. Cancel
    // this deferred replay before a sibling terminal can start an app drag.
    // Synthetic selection replay must not cancel another pane's intent.
    if (!e.isTrusted) return;
    if (history.active) {
      history.finish();
      selectionDragGuard.reset();
      presentation.selectionDrag = false;
    }
    if (!presentation.selectionPending) return;
    deferredMove = deferredUp = null;
    selectionDragGuard.reset();
    presentation.cancelSelection();
  };
  const onSelectionBlur = () => {
    touch.cancelPending();
    history.finish();
    if (presentation.selectionPending) {
      deferredMove = deferredUp = null;
      selectionDragGuard.reset();
      presentation.cancelSelection();
      return;
    }
    if (
      presentation.mouseReporting === undefined ||
      !presentation.selectionDrag
    )
      return;
    // End xterm's document listeners too; merely resetting our guard would
    // leave a lost native release extending the selection on later moves.
    dispatchMouseRelease(container.ownerDocument);
  };
  const onDocumentMouseMove = (e: MouseEvent) => {
    if (!selectionDragGuard.mouseMoveNeedsRelease(e.buttons)) return;
    dispatchMouseRelease(container.ownerDocument, e);
  };
  container.addEventListener("mousedown", onTerminalMouseDown, capture);
  window.addEventListener("blur", onSelectionBlur, { signal });
  document.addEventListener("mousedown", onNativeMouseDown, capture);
  document.addEventListener("mouseup", onDocumentMouseUp, capture);
  document.addEventListener("mousemove", onDeferredMouseMove, capture);
  document.addEventListener("mousemove", onDocumentMouseMove, { signal });

  const onWheel = (e: WheelEvent) => {
    if (session.replayingWheel) return;
    session.invalidateLinks();
    ui.setFileLinkMenu(null);
    touch.cancelPending();
    if (touch.active) {
      swallowEvent(e);
      return;
    }
    const selectionScroll = terminalWheelScroll(
      e.deltaY,
      e.deltaMode,
      term.rows,
    );
    if (
      selectionScroll &&
      history.wheel(
        selectionScroll.direction,
        selectionScroll.lines,
        (e.buttons & 1) === 1 || presentation.selectionDrag,
      )
    ) {
      cancelEvent(e);
      return;
    }
    if (presentation.mouseReporting !== undefined) {
      if (
        term.hasSelection() ||
        presentation.selectionDrag ||
        refs.composerOpen.current
      ) {
        cancelEvent(e);
        return;
      }
      // Let xterm produce pane-local SGR coordinates and modifiers only on
      // endpoint streams. Legacy AttachScroll routing stays unchanged.
      if (
        presentation.mouseReporting &&
        term.modes.mouseTrackingMode !== "none"
      ) {
        if (session.acceptsInput()) return;
        swallowEvent(e);
        if (!session.acceptsEndpointInput()) return;
        // Let xterm encode only this wheel event without authorizing keyboard input.
        const disabled = term.options.disableStdin;
        session.replayingWheel = true;
        try {
          term.options.disableStdin = false;
          e.target?.dispatchEvent(new WheelEvent("wheel", e));
        } finally {
          term.options.disableStdin = disabled;
          session.replayingWheel = false;
        }
        return;
      }
    }
    const scroll = terminalWheelScroll(e.deltaY, e.deltaMode, term.rows);
    const terminalId = desiredTerminal.current;
    if (
      !scroll ||
      !terminalId ||
      store.terminalScrollReason(terminalId, presentation.mouseReporting)
    )
      return;
    client
      .call("terminal.scroll", {
        terminal_id: terminalId,
        ...scroll,
        ...terminalCellAt(term, e),
      })
      .catch(() => {});
    cancelEvent(e);
  };
  container.addEventListener("wheel", onWheel, { ...capture, passive: false });

  const onTouchSelectionEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !touch.active) return;
    swallowEvent(event);
    touch.reset();
  };
  document.addEventListener("keydown", onTouchSelectionEscape, capture);

  let touchStartX: number | null = null;
  let touchStartY: number | null = null;
  // One finger drives the shared touch scroll; two drive it from the pinch.
  let touchScrolls = false;
  let touchMoved = false;
  let touchSelectionBeforeTouch = false;
  const resetTouch = () => {
    touchStartX = null;
    touchStartY = null;
    touchScrolls = false;
    touchMoved = false;
  };
  const onTouchStart = (e: TouchEvent) => {
    lastPointerType = "touch";
    if (e.touches.length !== 1) {
      session.retireTouchLink();
      touchMoved = true;
      // A finger left over from a pinch or swipe must not scroll.
      touchScrolls = false;
      touch.cancelPending();
      if (!touch.active) presentation.cancelSelection();
      return;
    }
    e.stopPropagation();
    const point = e.touches[0];
    const at = { x: point.clientX, y: point.clientY };
    touchStartX = at.x;
    touchStartY = at.y;
    touchScrolls = true;
    touchMoved = false;
    touchSelectionBeforeTouch = touch.active;
    scroll.begin(at.y, at, performance.now());
    touch.start(at);
  };
  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length !== 1 || !touchScrolls) return;
    session.invalidateLinks();
    ui.setFileLinkMenu(null);
    const point = e.touches[0];
    const at = { x: point.clientX, y: point.clientY };
    touch.move(at);
    if (
      touchStartX !== null &&
      touchStartY !== null &&
      Math.hypot(at.x - touchStartX, at.y - touchStartY) >
        TERMINAL_TOUCH_TAP_SLOP_PX
    ) {
      touchMoved = true;
      if (!touch.active) presentation.cancelSelection();
    }
    scroll.move(at.y, at, performance.now());
    cancelEvent(e);
  };
  const onTouchEnd = (e: TouchEvent) => {
    // A drag flings on; a tap or a selection drag stops.
    if (touchScrolls) {
      if (touchMoved && !touch.active) scroll.release(performance.now());
      else scroll.stop();
    }
    touch.cancelPending();
    // A long-press that just selected a word copies it on release.
    if (touch.active && !touchSelectionBeforeTouch)
      copyFinishedSelection(terminalSelectedText(term), refs);
    touchSelectionBeforeTouch = touch.active;
    if (!touch.active) presentation.cancelSelection();
    const tapped = touchStartX !== null && touchStartY !== null && !touchMoved;
    const endTouch = e.changedTouches[0];
    const screen = term.element
      ?.querySelector(".xterm-screen")
      ?.getBoundingClientRect();
    // Taps on the agent input rows mean "type here": open the keyboard, or
    // keep it open. Taps higher up are for reading and dismiss it.
    const inInputZone =
      tapped &&
      !touch.active &&
      !!endTouch &&
      !!screen &&
      screen.height > 0 &&
      terminalTapOpensInput(
        Math.floor(
          ((endTouch.clientY - screen.top) / screen.height) * term.rows,
        ),
        term.rows,
        term.buffer.active.cursorY,
      );
    const openInput =
      inInputZone &&
      !refs.inputActive.current &&
      !refs.composerOpen.current &&
      !refs.viewOnly.current &&
      session.acceptsEndpointInput() &&
      refs.isActivePane.current;
    const dismissInput =
      !inInputZone &&
      terminalTouchShouldDismissInput(
        touchStartX !== null && touchStartY !== null,
        touchMoved,
        refs.inputActive.current,
      );
    resetTouch();
    // Cancel compatibility mouse events before xterm can focus or report them.
    swallowEvent(e);
    if (dismissInput) closeTerminalInput();
    if (openInput) {
      // Focus inside touchend: iOS only raises the keyboard for a focus()
      // made during the gesture.
      openTerminalInput(term, false);
      term.focus();
    }
  };
  const onTouchCancel = () => {
    if (touchScrolls) scroll.stop();
    session.retireTouchLink();
    touch.cancelPending();
    if (!touch.active) presentation.cancelSelection();
    resetTouch();
  };
  const onDocumentPointerDown = (e: PointerEvent) => {
    if (e.pointerType) lastPointerType = e.pointerType;
    const targetInsideTerminal =
      e.target instanceof Node && container.contains(e.target);
    if (
      !targetInsideTerminal &&
      !(
        e.target instanceof Element &&
        e.target.closest(".terminal-touch-selection-ui")
      )
    ) {
      touch.cancelPending();
      if (touch.active) touch.reset();
    }
    if (
      !terminalPointerShouldBlurInput(
        shouldAvoidVirtualKeyboard(),
        isEditableElement(e.target),
        targetInsideTerminal,
      )
    )
      return;
    term.textarea?.blur();
  };
  const onTerminalFocus = () => {
    if (touch.active) {
      term.blur();
      return;
    }
    if (!shouldAvoidVirtualKeyboard() || refs.inputActive.current) return;
    // Fine-mouse/physical-keyboard focus restoration also works in a narrow layout.
    if (
      lastPointerType === "mouse" ||
      (!window.matchMedia("(any-pointer: coarse)").matches &&
        lastPointerType !== "touch")
    ) {
      openTerminalInput(
        term,
        refs.composerOpen.current ||
          refs.touchSelection.current?.active === true,
      );
    } else {
      term.blur();
    }
  };
  const blockMobileMouse = (e: MouseEvent) => {
    if (
      (lastPointerType === "mouse" ||
        !window.matchMedia("(pointer: coarse)").matches) &&
      !isTouchMouse(e)
    )
      return;
    swallowEvent(e);
  };
  term.textarea?.addEventListener("focus", onTerminalFocus, { signal });
  for (const event of ["mouseup", "click", "dblclick", "contextmenu"] as const)
    container.addEventListener(event, blockMobileMouse, capture);
  container.addEventListener("touchstart", onTouchStart, {
    ...capture,
    passive: true,
  });
  container.addEventListener("touchmove", onTouchMove, {
    ...capture,
    passive: false,
  });
  container.addEventListener("touchend", onTouchEnd, {
    ...capture,
    passive: false,
  });
  container.addEventListener("touchcancel", onTouchCancel, capture);
  document.addEventListener("pointerdown", onDocumentPointerDown, capture);
  return () => {
    selectionChange.dispose();
    selectionResize.dispose();
  };
}
