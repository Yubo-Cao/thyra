import {
  TERMINAL_FRAME_TAIL_MARK,
  type TerminalFrameParts,
  terminalFrameRowUpdate,
  terminalFrameText,
} from "../../shared/terminalFrame";
import type { TerminalGraphics } from "../../shared/terminalGraphics";
import type { TerminalHistoryViewport } from "./terminalHistorySelection";

export interface TerminalPresentationFrame {
  graphics?: TerminalGraphics;
  /** The full repaint; built on first use for a frame that came as rows. */
  text: string;
  size?: { cols: number; rows: number };
  history?: TerminalHistoryViewport;
  linkFrame?: string;
  /** Row structure of `text`, when the bridge sent row updates. */
  parts?: TerminalFrameParts;
}

/**
 * A frame the bridge sent as rows. Nearly all of them are written as a row
 * update and never need the full repaint text, so it is built only on demand.
 */
class RowFrame implements TerminalPresentationFrame {
  private repaint: string | undefined;

  constructor(
    readonly parts: TerminalFrameParts,
    readonly size: TerminalPresentationFrame["size"],
    readonly history: TerminalHistoryViewport | undefined,
    readonly linkFrame: string | undefined,
    readonly graphics: TerminalGraphics | undefined,
  ) {}

  get text(): string {
    return (this.repaint ??= terminalFrameText(this.parts));
  }
}

function sameRows(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  // Unchanged rows of a row update are the same string objects.
  for (let y = 0; y < a.length; y++) if (a[y] !== b[y]) return false;
  return true;
}

/**
 * How `next` differs from `shown`: not at all, or (looked for only with
 * `wantTail`) just in the tail after the rows.
 */
function frameChange(
  shown: TerminalPresentationFrame,
  next: TerminalPresentationFrame,
  wantTail: boolean,
): { same: boolean; tail: string | null } {
  if (shown.parts && next.parts) {
    if (!sameRows(shown.parts.rows, next.parts.rows))
      return { same: false, tail: null };
    return shown.parts.tail === next.parts.tail
      ? { same: true, tail: null }
      : { same: false, tail: next.parts.tail };
  }
  const text = next.text;
  if (text === shown.text) return { same: true, tail: null };
  if (!wantTail) return { same: false, tail: null };
  // frameToAnsi ends its cell grid with DECAWM, then only cursor controls.
  const cursor = text.lastIndexOf(TERMINAL_FRAME_TAIL_MARK);
  return {
    same: false,
    tail:
      cursor >= 0 && text.slice(0, cursor) === shown.text.slice(0, cursor)
        ? text.slice(cursor)
        : null,
  };
}

/** xterm's native selection escape: Shift on non-Mac, Option on Mac. */
export function terminalMouseUsesSelection(
  mouseReporting: boolean | undefined,
  event: { shiftKey: boolean; altKey: boolean },
  applePlatform: boolean,
): boolean {
  return (
    mouseReporting !== true || (applePlatform ? event.altKey : event.shiftKey)
  );
}

/**
 * Endpoint frames are self-contained repaints, not an incremental PTY stream.
 * Retain just the newest while selecting so copied text stays the visible text.
 */
export class TerminalEndpointPresentation {
  mouseReporting: boolean | undefined;
  selectionDrag = false;
  private appliedMouseReporting: boolean | undefined;
  private pendingFrame: TerminalPresentationFrame | null = null;
  displayedFrame: TerminalPresentationFrame | null = null;
  // The xterm viewport when displayedFrame was written, while nothing else has
  // written since. Only then do its rows match the screen for a row update.
  private displayedViewport: string | null = null;
  private writing = false;
  private changingLinks = false;
  private disposed = false;
  private generation = 0;
  private deferredSelection: (() => void) | null = null;

  constructor(
    private hasSelection: () => boolean,
    private write: (
      text: string,
      parsed: () => void,
      linksChanged: boolean,
    ) => void,
    private viewportSize?: () => { cols: number; rows: number },
    private selectionHistory?: {
      accepts: (frame: TerminalPresentationFrame) => boolean;
      presented: (frame: TerminalPresentationFrame) => void;
      reset: () => void;
    },
  ) {}

  get selectionPending(): boolean {
    return this.deferredSelection !== null;
  }

  get writePending(): boolean {
    return this.writing;
  }

  get linkWritePending(): boolean {
    return this.writing && this.changingLinks;
  }

  /** Reserve selection immediately; replay native initiation only after parsing. */
  beginSelection(replay: () => void): boolean {
    if (this.disposed) return false;
    this.selectionDrag = true;
    if (!this.writing) return true;
    this.deferredSelection = replay;
    return false;
  }

  cancelSelection(): void {
    this.deferredSelection = null;
    this.selectionDrag = false;
    this.flush();
  }

  /**
   * Presents a frame and returns it (null once disposed). `text` may be null
   * for a frame given as `parts`.
   */
  update(
    text: string | null,
    mouseReporting: boolean,
    size?: { cols: number; rows: number },
    history?: TerminalHistoryViewport,
    linkFrame?: string,
    parts?: TerminalFrameParts,
    graphics?: TerminalGraphics,
  ): TerminalPresentationFrame | null {
    if (this.disposed) return null;
    let frame: TerminalPresentationFrame;
    if (text !== null)
      frame = { text, size, history, linkFrame, parts, graphics };
    else if (parts)
      frame = new RowFrame(parts, size, history, linkFrame, graphics);
    else return null;
    this.mouseReporting = mouseReporting;
    this.pendingFrame = frame;
    this.flush();
    return frame;
  }

  /** Whether the screen shows exactly this frame's content. */
  shows(frame: TerminalPresentationFrame): boolean {
    const displayed = this.displayedFrame;
    return (
      !!displayed &&
      (displayed === frame || frameChange(displayed, frame, false).same)
    );
  }

  flush(): void {
    if (
      this.disposed ||
      this.writing ||
      ((this.selectionDrag || this.hasSelection()) &&
        !(
          this.pendingFrame && this.selectionHistory?.accepts(this.pendingFrame)
        ))
    )
      return;
    const frame = this.pendingFrame;
    if (frame) this.pendingFrame = null;
    const viewport = this.viewportSize?.();
    // A resize can overtake a frame on the wire or while selection holds it.
    // The bridge clips subsequent frames to the new viewer size.
    if (
      frame?.size &&
      viewport &&
      (frame.size.cols > viewport.cols || frame.size.rows > viewport.rows)
    )
      return;
    let prefix = "";
    if (
      this.mouseReporting !== undefined &&
      this.appliedMouseReporting !== this.mouseReporting
    ) {
      // Activation clears xterm selection, so apply only after selection ends.
      // Drag tracking suffices for pane applications; no hover reports that
      // could clear a retained browser selection after the escape is released.
      prefix = this.mouseReporting
        ? "\x1b[?1006h\x1b[?1002h"
        : "\x1b[?1002l\x1b[?1006l";
      this.appliedMouseReporting = this.mouseReporting;
    }
    // What to write; the full repaint is built only if nothing shorter does.
    let text: string | null = null;
    let linksChanged = true;
    const displayed = this.displayedFrame;
    if (frame && displayed && !prefix) {
      const change = frameChange(
        displayed,
        frame,
        !!frame.linkFrame && frame.linkFrame === displayed.linkFrame,
      );
      if (change.same) {
        // Metadata may advance without changing the physical xterm buffer.
        this.displayedFrame = frame;
        this.selectionHistory?.presented(frame);
        return;
      }
      if (change.tail !== null) {
        // Only the cursor controls after the cell grid changed. Updating just
        // that suffix preserves OSC8 IDs and the pressed link.
        text = change.tail;
        linksChanged = false;
      }
    }
    const viewportKey = viewport ? `${viewport.cols}x${viewport.rows}` : null;
    if (
      linksChanged &&
      frame?.parts &&
      displayed?.parts &&
      !prefix &&
      viewportKey !== null &&
      viewportKey === this.displayedViewport &&
      frame.size?.cols === displayed.size?.cols &&
      frame.size?.rows === displayed.size?.rows
    ) {
      // Rewrite only the changed rows; xterm then repaints only those rows
      // instead of clearing and redrawing the whole screen.
      const update = terminalFrameRowUpdate(displayed.parts, frame.parts);
      if (update !== null) text = update;
    }
    if (prefix || frame !== null) {
      this.writing = true;
      this.changingLinks = linksChanged;
      const generation = this.generation;
      this.write(
        prefix + (text ?? frame?.text ?? ""),
        () => {
          // reset() cannot cancel the physical xterm write. Its completion must
          // still release the gate for current intent, never restore old state.
          if (frame && !this.disposed && generation === this.generation) {
            this.displayedFrame = frame;
            this.displayedViewport = viewportKey;
            this.selectionHistory?.presented(frame);
          }
          this.writing = false;
          if (this.disposed) return;
          const replay = this.deferredSelection;
          this.deferredSelection = null;
          if (replay) replay();
          this.flush();
        },
        linksChanged,
      );
    }
  }

  /** Something else rewrote the xterm screen; the next frame repaints fully. */
  screenChanged(): void {
    this.displayedViewport = null;
  }

  reset(): void {
    // Invalidate presentation/replay, not the outstanding parser operation.
    this.generation++;
    this.deferredSelection = null;
    this.mouseReporting = undefined;
    this.appliedMouseReporting = undefined;
    this.pendingFrame = null;
    this.displayedFrame = null;
    this.displayedViewport = null;
    this.selectionHistory?.reset();
    this.selectionDrag = false;
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }
}
