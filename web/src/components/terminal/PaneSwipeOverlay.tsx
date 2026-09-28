import type { Terminal } from "@xterm/xterm";
import { ChevronRight, SquareTerminal } from "lucide-react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n";
import { customTabLabel, paneDisplayName } from "../../paneIdentity";
import { activePaneIdForSnapshot } from "../../paneJump";
import { paneSwipeReversed } from "../../paneSwipeSettings";
import { store } from "../../store";
import { captureConnectionLease } from "../../store/core";
import { terminalScreens, TouchVelocity } from "../../touchGestures";
import type { Pane } from "../../types";
import { shortId } from "../../utils";
import { AgentIcon } from "../AgentIcon";
import { Token } from "../ui/Token";
import {
  adjacentPane,
  paneNavigationOrder,
  revealedEdge,
  SWIPE_COMMIT_FRACTION,
  SwipeChain,
  swipeProgress,
  swipeStep,
  SwipeTracker,
} from "./paneSwipeMotion";
import {
  FETCH_DEBOUNCE_MS,
  type PaneFont,
  type PaneScreen,
  PanePreviews,
  terminalFont,
  terminalScreenText,
} from "./paneSwipePreview";
import { previewText } from "./TerminalPreview";
import "./PaneSwipeOverlay.css";

const VISIBLE_MS = 1200;
const SETTLE_MS = 220;
const FADE_MS = 150;
const REVEAL_TIMEOUT_MS = 2000;
// Ease-out whose opening slope is about 2.8 times its average speed.
const EASE_OUT = "cubic-bezier(0.22, 0.61, 0.36, 1)";
/** Share of the width over which the destination's icon fades in. */
const CORNER_FADE_FRACTION = 0.12;

/** Workspace › tab › agent icon, pane name and ID. */
function PaneSwipeLabel({ pane }: { pane: Pane }) {
  const { workspaces, tabs } = store.get();
  const workspace = workspaces.find(
    (item) => item.workspace_id === pane.workspace_id,
  );
  const tab = tabs.find((item) => item.tab_id === pane.tab_id);
  const chevron = <ChevronRight size={14} aria-hidden="true" />;
  return (
    <>
      <span>{workspace?.label ?? shortId(pane.workspace_id)}</span>
      {chevron}
      <span>
        {customTabLabel(tab?.label) ||
          t("Tab {number}", { number: tab?.number ?? shortId(pane.tab_id) })}
      </span>
      {chevron}
      {pane.agent ? <AgentIcon agent={pane.agent} compact /> : null}
      <strong>{paneName(pane)}</strong>
      <Token code>{shortId(pane.pane_id)}</Token>
    </>
  );
}

function paneName(pane: Pane) {
  const tab = store.get().tabs.find((item) => item.tab_id === pane.tab_id);
  return paneDisplayName(pane, {
    tabLabel: tab?.label,
    tabPaneCount: tab?.pane_count,
  });
}

/** The destination in the revealed corner: its agent icon, name and ID. */
function PaneSwipeCorner({ pane }: { pane: Pane }) {
  const name = paneName(pane);
  const id = shortId(pane.pane_id);
  return (
    <>
      <span className="pane-swipe-corner-icon">
        {pane.agent ? (
          <AgentIcon agent={pane.agent} compact />
        ) : (
          <SquareTerminal size={16} aria-hidden="true" />
        )}
      </span>
      <span className="pane-swipe-corner-name">
        {name}
        {name === id ? null : <small>{id}</small>}
      </span>
    </>
  );
}

let bannerRoot: Root | null = null;
let hideTimer = 0;

/** Briefly names the pane a swipe moved to: workspace › tab › pane. */
export function showPaneSwipeOverlay(pane: Pane) {
  if (!bannerRoot) {
    const host = document.createElement("div");
    document.body.append(host);
    bannerRoot = createRoot(host);
  }
  bannerRoot.render(
    <div className="pane-swipe-overlay pane-swipe-label" role="status">
      <PaneSwipeLabel pane={pane} />
    </div>,
  );
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => bannerRoot?.render(null), VISIBLE_MS);
}

const chain = new SwipeChain();
const tracker = new SwipeTracker();
const activePaneId = () => activePaneIdForSnapshot(store.get());

function paneAfter(from: string | null, step: -1 | 1) {
  const { workspaces, tabs, panes } = store.get();
  return adjacentPane(paneNavigationOrder(workspaces, tabs, panes), from, step);
}

// Previews: every open terminal's screen is kept as it leaves the view (and
// the visible ones as a swipe starts), so swiping back shows it at once; a
// pane this page has not shown lately is fetched as text.

// Keyed by Herdr's random terminal IDs alone: the active connection ID can
// change (the default alias resolving to its profile) over the same panes.
const previews = new PanePreviews();

function keepScreen(terminalId: string, term: Terminal) {
  const text = terminalScreenText(term);
  if (text)
    previews.keep(terminalId, {
      text,
      kind: "screen",
      font: terminalFont(term),
      at: performance.now(),
    });
}
terminalScreens.keep = keepScreen;

/** Keeps the surface's visible screens; returns one's font and height. */
function keepVisibleScreens(surface: HTMLElement) {
  let live: { font: PaneFont; rows: number } | null = null;
  for (const [term, rendered] of terminalScreens.open) {
    if (!term.element || !surface.contains(term.element)) continue;
    if (rendered.current) keepScreen(rendered.current, term);
    live ??= { font: terminalFont(term), rows: term.rows };
  }
  return live;
}

async function fetchLines(
  paneId: string,
  live: Gesture["live"],
): Promise<PaneScreen | null> {
  const { client } = captureConnectionLease();
  if (!client.isCurrent()) return null;
  const rows = Math.max(1, Math.min(200, live?.rows ?? 60));
  const text = previewText(
    await client.call("terminal.preview_text", {
      pane_id: paneId,
      lines: rows,
    }),
  )?.replace(/\s+$/, "");
  if (!text) return null;
  return {
    text,
    kind: "lines",
    font: live?.font ?? { fontFamily: "", fontSize: 13, lineHeight: 1.2 },
    at: performance.now(),
  };
}

/**
 * A neighbouring pane: `element` slides in beside the content and clips
 * `sheet`, which holds its preview. A pane revealed on the left is uncovered
 * in place (its sheet stays put, like a page underneath), so its
 * left-aligned text shows from the first pixels; one on the right slides in
 * whole.
 */
type Card = {
  element: HTMLDivElement;
  sheet: HTMLDivElement;
  label: Root;
  screen: HTMLPreElement;
  paneId?: string;
};
type Gesture = {
  layers: HTMLElement[];
  peek: Card;
  /** Pane width in client px, and local px per client px. */
  width: number;
  scale: number;
  from: string | null;
  /** +1 while the content moves right, revealing the pane on the left. */
  direction: -1 | 1;
  /** The pane being revealed; undefined until the first frame. */
  target?: Pane | null;
  /** The pane the card and icon show. */
  shows?: string;
  /** The fingers' horizontal travel, and the content's offset (local px). */
  dx: number;
  offset: number;
  velocity: TouchVelocity;
  armed: boolean;
  frame: number;
  reduced: boolean;
  reversed: boolean;
  live: { font: PaneFont; rows: number } | null;
};

let host: HTMLDivElement | null = null;
let cards: Card[] = [];
let corner: { element: HTMLDivElement; root: Root } | null = null;
/** The committed destination's card, covering the pane area. */
let shown: Card | null = null;
/** Pane content moved aside, restored once the destination is on screen. */
const moved = new Set<HTMLElement>();
let gesture: Gesture | null = null;
let settling: { animations: Animation[]; done(): void } | null = null;
let revealTimer = 0;
let fetchTimer = 0;
let watching = false;

const px = (x: number) => `translate3d(${x}px,0,0)`;

function ensureHost(surface: HTMLElement) {
  if (host && host.parentElement === surface) return host;
  host?.remove();
  for (const card of cards) card.label.unmount();
  corner?.root.unmount();
  host = document.createElement("div");
  host.className = "pane-swipe-peek";
  cards = [0, 1].map(() => {
    const element = document.createElement("div");
    element.className = "pane-swipe-card";
    const screen = document.createElement("pre");
    screen.className = "pane-swipe-screen";
    const label = document.createElement("div");
    label.className = "pane-swipe-label";
    const sheet = document.createElement("div");
    sheet.className = "pane-swipe-sheet";
    sheet.append(screen, label);
    element.append(sheet);
    host?.append(element);
    return { element, sheet, screen, label: createRoot(label) };
  });
  const cornerElement = document.createElement("div");
  cornerElement.className = "pane-swipe-corner";
  host.append(cornerElement);
  corner = { element: cornerElement, root: createRoot(cornerElement) };
  shown = null;
  surface.append(host);
  return host;
}

/** Where a card's sheet sits in it, keeping a left pane's in place. */
const sheetAt = (direction: -1 | 1, offset: number, width: number) =>
  direction > 0 ? width - offset : 0;

function hideCard(card: Card) {
  card.element.style.visibility = "";
  card.element.style.transform = "";
  card.sheet.style.transform = "";
  card.element.style.opacity = "";
}

/** Shows a pane's screen on its card, or its name card without one. */
function paint(card: Card, screen: PaneScreen | null) {
  const pre = card.screen;
  if (!screen) {
    delete card.element.dataset.ready;
    delete card.element.dataset.full;
    pre.textContent = "";
    return;
  }
  card.element.dataset.ready = screen.kind;
  pre.textContent = screen.text;
  pre.style.fontFamily = screen.font.fontFamily;
  pre.style.fontSize = `${screen.font.fontSize}px`;
  pre.style.lineHeight = String(screen.font.lineHeight * 1.2);
  // Lines that overflow keep the newest at the bottom, as a terminal does
  // (one layout read per preview, never per move).
  card.element.toggleAttribute(
    "data-full",
    screen.kind === "lines" && pre.offsetHeight > card.sheet.clientHeight,
  );
}

/** Fills a card with its pane's preview, fetching it once if needed. */
function preview(card: Card, pane: Pane, live: Gesture["live"]) {
  const key = pane.terminal_id;
  const source = previews.source(key, performance.now());
  paint(card, source.use);
  window.clearTimeout(fetchTimer);
  if (!source.fetch) return;
  // Waits out a direction the fingers only brushed.
  fetchTimer = window.setTimeout(() => {
    if (card.paneId !== pane.pane_id) return;
    void previews
      .fetch(
        key,
        () => fetchLines(pane.pane_id, live),
        () => performance.now(),
      )
      .then((screen) => {
        if (screen && card.paneId === pane.pane_id) paint(card, screen);
      });
  }, FETCH_DEBOUNCE_MS);
}

function slide(element: HTMLElement, from: number, to: number, ms: number) {
  element.style.transform = px(to);
  return element.animate([{ transform: px(from) }, { transform: px(to) }], {
    duration: ms,
    easing: EASE_OUT,
  });
}

function fade(element: HTMLElement, from: number, to: number) {
  element.style.opacity = String(to);
  return element.animate([{ opacity: from }, { opacity: to }], {
    duration: FADE_MS,
    easing: "ease-out",
  });
}

function settle(animations: Animation[], done: () => void) {
  const current = { animations, done };
  settling = current;
  void Promise.all(animations.map((item) => item.finished)).then(
    () => {
      if (settling !== current) return;
      settling = null;
      done();
    },
    () => undefined,
  );
}

/** Jumps a running animation to its end, as a new swipe takes over. */
function finishSettling() {
  const current = settling;
  if (!current) return;
  settling = null;
  for (const animation of current.animations) animation.cancel();
  current.done();
}

function begin(surface: HTMLElement): Gesture {
  finishSettling();
  const area = ensureHost(surface);
  const width = surface.offsetWidth;
  const clientWidth = surface.getBoundingClientRect().width || width;
  Object.assign(area.style, {
    left: `${surface.offsetLeft}px`,
    top: `${surface.offsetTop}px`,
    width: `${width}px`,
    height: `${surface.offsetHeight}px`,
  });
  area.hidden = false;
  // A chained swipe drags the previous destination's card.
  const layers = shown
    ? [shown.element]
    : (Array.from(surface.children).filter(
        (child) => child !== area,
      ) as HTMLElement[]);
  for (const layer of layers) {
    layer.style.willChange = "transform";
    if (!shown) moved.add(layer);
  }
  return {
    layers,
    peek: cards.find((card) => card !== shown) ?? cards[0],
    width: clientWidth,
    scale: width / clientWidth,
    from: chain.from(activePaneId()),
    direction: 1,
    dx: 0,
    offset: 0,
    velocity: new TouchVelocity(),
    armed: false,
    frame: 0,
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    reversed: paneSwipeReversed(),
    // The panes on screen now are the ones a swipe back returns to.
    live: keepVisibleScreens(surface),
  };
}

/** Points the drag at the pane on the side it now reveals. */
function aim(g: Gesture, direction: -1 | 1) {
  g.direction = direction;
  g.target = paneAfter(g.from, swipeStep(direction, g.reversed));
  const { element, label } = g.peek;
  const target = g.target;
  element.style.visibility = target && !g.reduced ? "visible" : "";
  if (!corner) return;
  corner.element.dataset.edge = revealedEdge(direction);
  corner.element.style.visibility = target ? "visible" : "";
  if (!target || g.shows === target.pane_id) return;
  // Rendered once per gesture and destination, never per move.
  g.shows = target.pane_id;
  g.peek.paneId = target.pane_id;
  const { root } = corner;
  flushSync(() => {
    label.render(<PaneSwipeLabel pane={target} />);
    root.render(<PaneSwipeCorner pane={target} />);
  });
  preview(g.peek, target, g.live);
}

function schedule(g: Gesture) {
  g.frame ||= requestAnimationFrame(() => {
    g.frame = 0;
    if (gesture === g) frame(g, performance.now());
  });
}

/** Moves the content to the fingers and arms the icon by the release rule. */
function frame(g: Gesture, now: number) {
  const direction = g.dx < 0 ? -1 : g.dx > 0 ? 1 : g.direction;
  if (direction !== g.direction || g.target === undefined) aim(g, direction);
  const { offset, revealed, armed } = swipeProgress(
    g.dx,
    g.width,
    !!g.target,
    g.velocity.at(now),
  );
  if (armed !== g.armed) {
    g.armed = armed;
    corner?.element.toggleAttribute("data-armed", armed);
  }
  if (corner)
    corner.element.style.opacity = String(
      Math.min(1, revealed / CORNER_FADE_FRACTION),
    );
  // A flick arms the icon only while it lasts: look again as it slows.
  if (armed && revealed <= SWIPE_COMMIT_FRACTION) schedule(g);
  if (g.reduced) return;
  g.offset = offset * g.scale;
  for (const layer of g.layers) layer.style.transform = px(g.offset);
  const width = g.width * g.scale;
  g.peek.element.style.transform = px(g.offset - direction * width);
  g.peek.sheet.style.transform = px(sheetAt(direction, g.offset, width));
}

/** The fingers lifted (`lifted`) or the touch was taken away. */
function release(g: Gesture, lifted: boolean) {
  gesture = null;
  cancelAnimationFrame(g.frame);
  window.clearTimeout(fetchTimer);
  // The release does exactly what the icon shows after this last frame.
  const now = performance.now();
  if (lifted) frame(g, now);
  const target = lifted && g.armed ? g.target : null;
  const direction = g.direction;
  const width = g.width * g.scale;
  const peek = g.peek;
  const unhint = () => {
    for (const layer of g.layers) layer.style.willChange = "";
  };
  const cornerElement = corner?.element;
  const hideCorner = () => {
    if (!cornerElement || cornerElement.style.visibility !== "visible")
      return [];
    return [fade(cornerElement, Number(cornerElement.style.opacity) || 0, 0)];
  };
  const resetCorner = () => {
    if (!cornerElement || gesture) return;
    cornerElement.style.visibility = "";
    cornerElement.removeAttribute("data-armed");
  };
  if (target) {
    const outgoing = shown;
    shown = peek;
    chain.commit(target.pane_id);
    chain.animating = true;
    const done = () => {
      unhint();
      resetCorner();
      chain.animating = false;
      if (outgoing) hideCard(outgoing);
      flush();
    };
    if (g.reduced) {
      // A crossfade to the destination's card, which the banner names.
      peek.element.style.transform = "";
      peek.sheet.style.transform = "";
      peek.element.style.visibility = "visible";
      showPaneSwipeOverlay(target);
      settle([fade(peek.element, 0, 1), ...hideCorner()], done);
      return;
    }
    // Matches the fingers' speed as it leaves, within the usual range.
    const rest = width - Math.abs(g.offset);
    const speed = Math.abs(g.velocity.at(now)) * g.scale;
    const ms = Math.min(
      SETTLE_MS + 30,
      Math.max(150, (rest * 2.8) / Math.max(0.01, speed)),
    );
    settle(
      [
        ...g.layers.map((layer) =>
          slide(layer, g.offset, direction * width, ms),
        ),
        slide(peek.element, g.offset - direction * width, 0, ms),
        slide(peek.sheet, sheetAt(direction, g.offset, width), 0, ms),
        ...hideCorner(),
      ],
      done,
    );
    return;
  }
  const done = () => {
    unhint();
    resetCorner();
    if (peek !== shown) hideCard(peek);
    if (!shown) {
      for (const layer of moved) layer.style.transform = "";
      moved.clear();
      if (host) host.hidden = true;
    }
    flush();
  };
  if (g.reduced || !g.offset) {
    settle(hideCorner(), done);
    return;
  }
  settle(
    [
      ...g.layers.map((layer) => slide(layer, g.offset, 0, SETTLE_MS)),
      slide(
        peek.element,
        g.offset - direction * width,
        -direction * width,
        SETTLE_MS,
      ),
      slide(
        peek.sheet,
        sheetAt(direction, g.offset, width),
        sheetAt(direction, 0, width),
        SETTLE_MS,
      ),
      ...hideCorner(),
    ],
    done,
  );
}

/** Requests a due switch and uncovers a switch that reached the screen. */
function flush() {
  const next = chain.due();
  if (next) {
    void store.focusPane(next);
    window.clearTimeout(revealTimer);
    revealTimer = window.setTimeout(() => {
      chain.touching = false;
      chain.revealed();
      reveal();
    }, REVEAL_TIMEOUT_MS);
    if (!watching) {
      watching = true;
      store.subscribe(() => {
        if (shown) reveal();
      });
    }
  }
  reveal();
}

function reveal() {
  const card = shown;
  if (!card || gesture || settling || !chain.revealable(activePaneId())) return;
  chain.revealed();
  window.clearTimeout(revealTimer);
  // Let the new pane render under the card before it fades.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (shown !== card || gesture || settling) return;
      for (const layer of moved) layer.style.transform = "";
      moved.clear();
      settle([fade(card.element, 1, 0)], () => {
        shown = null;
        hideCard(card);
        if (host) host.hidden = true;
      });
    }),
  );
}

/**
 * How far a zoomed view under the fingers can still pan toward `direction`
 * (+1: its content moving right), in px. Only a view that follows another
 * device's size is larger than its pane; a pinch-zoomed one pans by two
 * fingers, and a swipe waits until it reaches that edge.
 */
function panRoom(target: EventTarget | null, direction: -1 | 1): number {
  const view =
    target instanceof Element
      ? target.closest<HTMLElement>(".terminal-view.is-following")
      : null;
  if (!view) return 0;
  const read = (name: string) =>
    Number.parseFloat(view.style.getPropertyValue(`--terminal-follow-${name}`));
  const x = read("x") || 0;
  const extent = (read("width") || 0) * (read("scale") || 1);
  const min = Math.min(0, view.clientWidth - extent);
  return direction > 0 ? -x : x - min;
}

/**
 * Every touch on the pane area while swiping is on (`fingers` of them make
 * a swipe). A touch is classified once it moves; a swipe then owns it, and
 * pinches, scrolls and pans are left to the terminal.
 */
export function paneSwipeTouch(
  surface: HTMLElement,
  event: TouchEvent,
  fingers: number,
) {
  const { type, touches } = event;
  chain.touching = type !== "touchcancel" && touches.length > 0;
  if (type === "touchstart") {
    // The lifts after a switch may target an unmounted pane and never
    // arrive here, so a touch whose fingers are all new starts over.
    if (touches.length === event.changedTouches.length) {
      if (gesture) release(gesture, false);
      tracker.cancel();
    }
    if (tracker.mode === "idle") {
      if (touches.length === fingers) tracker.begin(touches);
    } else {
      // Another finger joined: this is no longer the swipe.
      if (gesture) release(gesture, false);
      tracker.finish();
    }
  } else if (type === "touchmove") {
    const mode = tracker.move(touches, (direction) =>
      panRoom(event.target, direction),
    );
    if (mode === "swipe") {
      // The terminal's pinch, pan and scroll never see a swipe.
      event.preventDefault();
      event.stopPropagation();
      gesture ??= begin(surface);
      gesture.dx = tracker.delta().dx;
      gesture.velocity.add(performance.now(), gesture.dx);
      schedule(gesture);
    }
  } else {
    // The first finger to lift ends the swipe.
    if (gesture) release(gesture, type === "touchend");
    if (touches.length) tracker.finish();
    else tracker.cancel();
  }
  if (!chain.touching) flush();
}
