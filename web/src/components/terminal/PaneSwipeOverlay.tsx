import { ChevronRight } from "lucide-react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n";
import { customTabLabel, paneDisplayName } from "../../paneIdentity";
import { activePaneIdForSnapshot } from "../../paneJump";
import { store } from "../../store";
import { adjacentPane, paneNavigationOrder } from "../../touchGestures";
import type { Pane } from "../../types";
import { shortId } from "../../utils";
import { AgentIcon } from "../AgentIcon";
import { Token } from "../ui/Token";
import {
  rubberBand,
  SwipeChain,
  swipeRecognition,
  swipeRelease,
  SwipeVelocity,
} from "./paneSwipeMotion";
import "./PaneSwipeOverlay.css";

const VISIBLE_MS = 1200;
const SETTLE_MS = 220;
const FADE_MS = 150;
const REVEAL_TIMEOUT_MS = 2000;
// Ease-out whose opening slope is about 2.8 times its average speed.
const EASE_OUT = "cubic-bezier(0.22, 0.61, 0.36, 1)";

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
      <strong>
        {paneDisplayName(pane, {
          tabLabel: tab?.label,
          tabPaneCount: tab?.pane_count,
        })}
      </strong>
      <Token code>{shortId(pane.pane_id)}</Token>
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
const activePaneId = () => activePaneIdForSnapshot(store.get());

function paneAfter(from: string | null, step: -1 | 1) {
  const { workspaces, tabs, panes } = store.get();
  return adjacentPane(paneNavigationOrder(workspaces, tabs, panes), from, step);
}

/** Switches at once and names the destination (the drag had not loaded). */
export function switchPane(step: -1 | 1) {
  const target = paneAfter(chain.from(activePaneId()), step);
  if (!target) return;
  // The pane switcher's path: a pane another device displays is neither
  // resized by this page nor focused by the bridge on its behalf.
  void store.focusPane(target.pane_id);
  showPaneSwipeOverlay(target);
}

// The drag: the pane area's content follows the fingers (transforms only, no
// layout reads after the first) while a card naming the neighbouring pane
// slides in beside it. Only a settled commit switches panes, and the card
// covers the area until the new pane is on screen.

type Card = { element: HTMLDivElement; root: Root; paneId?: string };
type Gesture = {
  layers: HTMLElement[];
  peek: Card;
  /** Pane width in client px, and local px per client px. */
  width: number;
  scale: number;
  from: string | null;
  step: -1 | 1;
  /** The pane `step` leads to; undefined until the first move. */
  target?: Pane | null;
  offset: number;
  velocity: SwipeVelocity;
  reduced: boolean;
};

let host: HTMLDivElement | null = null;
let cards: Card[] = [];
/** The committed destination's card, covering the pane area. */
let shown: Card | null = null;
/** Pane content moved aside, restored once the destination is on screen. */
const moved = new Set<HTMLElement>();
let gesture: Gesture | null = null;
let rejected = false;
let settling: { animations: Animation[]; done(): void } | null = null;
let revealTimer = 0;
let watching = false;

const px = (x: number) => `translate3d(${x}px,0,0)`;

function ensureHost(surface: HTMLElement) {
  if (host && host.parentElement === surface) return host;
  host?.remove();
  for (const card of cards) card.root.unmount();
  host = document.createElement("div");
  host.className = "pane-swipe-peek";
  cards = [0, 1].map(() => {
    const element = document.createElement("div");
    element.className = "pane-swipe-card";
    host?.append(element);
    return { element, root: createRoot(element) };
  });
  shown = null;
  surface.append(host);
  return host;
}

function hideCard(card: Card) {
  card.element.style.visibility = "";
  card.element.style.transform = "";
  card.element.style.opacity = "";
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
    step: 1,
    offset: 0,
    velocity: new SwipeVelocity(),
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

function aim(g: Gesture, step: -1 | 1) {
  g.step = step;
  g.target = paneAfter(g.from, step);
  const { element, root } = g.peek;
  const target = g.target;
  element.style.visibility = target && !g.reduced ? "visible" : "";
  // The name rides the card's leading edge, in view from the first pixels.
  element.dataset.edge = step > 0 ? "left" : "right";
  if (target && g.peek.paneId !== target.pane_id) {
    g.peek.paneId = target.pane_id;
    flushSync(() =>
      root.render(
        <div className="pane-swipe-label">
          <PaneSwipeLabel pane={target} />
        </div>,
      ),
    );
  }
}

function move(g: Gesture, dx: number, time: number) {
  g.velocity.add(time, dx);
  const step = dx < 0 ? -1 : 1;
  if (step !== g.step || g.target === undefined) aim(g, step);
  if (g.reduced) return;
  g.offset = rubberBand(dx, g.width, g.target ? undefined : 0) * g.scale;
  for (const layer of g.layers) layer.style.transform = px(g.offset);
  g.peek.element.style.transform = px(g.offset - step * g.width * g.scale);
}

function release(
  g: Gesture,
  delta: { dx: number; dy: number } | null,
  time: number,
) {
  gesture = null;
  const velocity = g.velocity.at(time);
  const step =
    delta && g.target ? swipeRelease(delta.dx, delta.dy, g.width, velocity) : 0;
  const width = g.width * g.scale;
  const peek = g.peek;
  const target = g.target;
  const unhint = () => {
    for (const layer of g.layers) layer.style.willChange = "";
  };
  if (step === g.step && target) {
    const outgoing = shown;
    shown = peek;
    chain.commit(target.pane_id);
    chain.animating = true;
    const done = () => {
      unhint();
      chain.animating = false;
      if (outgoing) hideCard(outgoing);
      flush();
    };
    if (g.reduced) {
      peek.element.style.transform = "";
      peek.element.style.visibility = "visible";
      showPaneSwipeOverlay(target);
      settle([fade(peek.element, 0, 1)], done);
      return;
    }
    // Matches the fingers' speed as it leaves, within the usual range.
    const rest = width - Math.abs(g.offset);
    const ms = Math.min(
      SETTLE_MS + 30,
      Math.max(150, (rest * 2.8) / Math.max(0.01, Math.abs(velocity))),
    );
    settle(
      [
        ...g.layers.map((layer) => slide(layer, g.offset, step * width, ms)),
        slide(peek.element, g.offset - step * width, 0, ms),
      ],
      done,
    );
    return;
  }
  const done = () => {
    unhint();
    if (peek !== shown) hideCard(peek);
    if (!shown) {
      for (const layer of moved) layer.style.transform = "";
      moved.clear();
      if (host) host.hidden = true;
    }
    flush();
  };
  if (g.reduced || !g.offset) return done();
  settle(
    [
      ...g.layers.map((layer) => slide(layer, g.offset, 0, SETTLE_MS)),
      slide(
        peek.element,
        g.offset - g.step * width,
        -g.step * width,
        SETTLE_MS,
      ),
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
 * Every touch on the pane area while swiping is on: `delta` is the swiping
 * fingers' travel while the recognizer tracks them (at a touchend, the
 * release), `touches` the fingers still down.
 */
export function paneSwipeTouch(
  surface: HTMLElement,
  touches: number,
  delta: { dx: number; dy: number } | null,
  event: TouchEvent,
) {
  const ended = event.type === "touchend" || event.type === "touchcancel";
  chain.touching = event.type !== "touchcancel" && touches > 0;
  if (!delta) rejected = false;
  if (delta && !ended && !rejected) {
    if (!gesture) {
      const recognized = swipeRecognition(delta.dx, delta.dy);
      rejected = recognized === "reject";
      if (recognized === "track") gesture = begin(surface);
    }
    if (gesture) move(gesture, delta.dx, event.timeStamp);
  } else if (gesture) {
    release(gesture, ended ? delta : null, event.timeStamp);
  }
  if (!chain.touching) flush();
}
