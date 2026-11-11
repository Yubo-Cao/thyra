import { ArrowDown } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { sessionShowsActivity } from "../../agentSession/reducer";
import type { AgentSessionStore } from "../../agentSession/session";
import {
  newerWindow,
  olderWindow,
  TAIL_WINDOW,
  type TranscriptWindow,
  WINDOW_SIZE,
  windowRange,
} from "../../agentSession/transcriptWindow";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { AgentItemRow } from "./AgentItems";

const NO_ITEMS: readonly string[] = [];
/** Within this distance of the newest output the view follows it. */
const FOLLOW_PX = 32;
/**
 * The same for a scroll down: while output streams, the bottom moves on
 * before an animated scroll toward it lands.
 */
const FOLLOW_DOWN_PX = 160;
/** A scroll this soon after the reader's wheel, touch or key is theirs. */
const READER_MS = 1000;
/** Within this distance of a window edge the next items mount. */
const EDGE_PX = 900;
export type AgentTranscriptHandle = {
  /** Return to the newest output and follow it again. */
  showLatest(): void;
  /** Scroll by most of a screen, as the reader's own paging does. */
  page(direction: "up" | "down"): void;
};

/**
 * The transcript, oldest first. It stays at the newest output while that
 * streams in unless the reader scrolled up, and mounts a window of the items
 * (transcriptWindow.ts) so a long session costs what its visible part does.
 * `children` follow the hint of a session with nothing in it yet, and
 * `footer` follows the newest item while the agent waits for a prompt.
 */
export function AgentTranscript({
  store,
  ref,
  children,
  footer,
}: {
  store: AgentSessionStore;
  ref: Ref<AgentTranscriptHandle>;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const order = useStore(store, (view) => view.session?.order ?? NO_ITEMS);
  const working = useStore(
    store,
    (view) => !!view.session && sessionShowsActivity(view.session),
  );
  const starting = useStore(
    store,
    (view) => view.session?.info.status === "starting",
  );
  const [mounted, setMounted] = useState<TranscriptWindow>(TAIL_WINDOW);
  const { start, end } = windowRange(mounted, order);
  // Nothing to follow yet: what stands in for the items reads from its top.
  const blank = order.length === 0;
  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  // Layout scrolls the view too (the dock grows, the pane shrinks, a browser
  // clamps the offset mid-layout), and that must not stop it from following.
  // A scroll up is the reader's when the geometry last seen is unchanged and
  // they are scrolling: a wheel, touch, key or focus move just now, or a
  // held pointer.
  const seen = useRef({ top: 0, height: 0, client: 0 });
  const reader = useRef({ at: 0, pressed: false });
  const scrolling = () => {
    reader.current.at = performance.now();
  };
  const see = (element: HTMLElement) => {
    seen.current = {
      top: element.scrollTop,
      height: element.scrollHeight,
      client: element.clientHeight,
    };
  };
  // A row that must stay where it is while the window changes around it.
  const held = useRef<{ id: string; top: number } | null>(null);
  const toLatest = useRef(false);
  const row = (id: string) =>
    content.current?.querySelector<HTMLElement>(
      `[data-item="${CSS.escape(id)}"]`,
    );

  const slide = (next: TranscriptWindow, hold: string | undefined) => {
    if (next === mounted) return;
    const element = hold ? row(hold) : null;
    held.current =
      hold && element
        ? { id: hold, top: element.getBoundingClientRect().top }
        : null;
    setMounted(next);
  };
  // Once the window has changed: go to the newest output when that was asked
  // for, else keep the held row where it was.
  useLayoutEffect(() => {
    const hold = held.current;
    held.current = null;
    const element = scroller.current;
    if (!element) return;
    if (toLatest.current) {
      toLatest.current = false;
      element.scrollTop = element.scrollHeight;
      return;
    }
    const kept = hold ? row(hold.id) : null;
    if (hold && kept)
      element.scrollTop += kept.getBoundingClientRect().top - hold.top;
  }, [mounted]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const below =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const byReader =
      element.scrollTop < seen.current.top &&
      element.scrollHeight === seen.current.height &&
      element.clientHeight === seen.current.client &&
      (reader.current.pressed ||
        performance.now() - reader.current.at < READER_MS);
    const near =
      element.scrollTop > seen.current.top ? FOLLOW_DOWN_PX : FOLLOW_PX;
    see(element);
    if (blank) return;
    // Any scroll up by the reader lets go, however short; reaching the
    // bottom (or nearly, scrolling down) follows again.
    if (mounted.anchor !== null || byReader) following.current = false;
    else if (below < near) following.current = true;
    setAway(!following.current);
    if (following.current) {
      // Back at the newest: let go of older items mounted on the way up.
      if (mounted.size > WINDOW_SIZE) setMounted(TAIL_WINDOW);
    } else if (element.scrollTop < EDGE_PX && start > 0) {
      slide(olderWindow(mounted, order), order[start]);
    } else if (below < EDGE_PX && mounted.anchor !== null) {
      slide(newerWindow(mounted, order), order[end - 1]);
    }
  };

  // New output, a resized pane, or a taller dock keep the view at the bottom
  // while the reader is there.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !content.current) return;
    const pin = () => {
      if (following.current && !blank) element.scrollTop = element.scrollHeight;
      see(element);
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(content.current);
    observer.observe(element);
    return () => observer.disconnect();
  }, [blank]);

  const showLatest = () => {
    following.current = true;
    setAway(false);
    if (mounted !== TAIL_WINDOW) {
      // The newest items mount first; the effect above then scrolls to them.
      toLatest.current = true;
      setMounted(TAIL_WINDOW);
    } else if (scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  };
  useImperativeHandle(ref, () => ({
    showLatest,
    page(direction) {
      const element = scroller.current;
      scrolling();
      element?.scrollBy({
        top: (direction === "up" ? -0.9 : 0.9) * element.clientHeight,
      });
    },
  }));

  return (
    <div className="agent-transcript-frame">
      <div
        ref={scroller}
        className="agent-transcript"
        role="log"
        aria-label={t("Agent transcript")}
        tabIndex={0}
        onScroll={onScroll}
        onWheel={scrolling}
        onTouchMove={scrolling}
        onKeyDown={scrolling}
        onFocus={scrolling}
        onPointerDown={() => {
          // A scrollbar drag sends no further events until it is let go.
          reader.current.pressed = true;
          const release = () => {
            reader.current.pressed = false;
            window.removeEventListener("pointerup", release, true);
            window.removeEventListener("pointercancel", release, true);
          };
          window.addEventListener("pointerup", release, true);
          window.addEventListener("pointercancel", release, true);
        }}
      >
        <div ref={content} className="agent-transcript-content">
          {blank && !working ? (
            <>
              {/* One line for both states, so what follows it never moves. */}
              <p className="agent-empty" role={starting ? "status" : undefined}>
                {starting ? <Spinner size="sm" /> : null}
                {starting
                  ? t("Starting the agent")
                  : t("Send a prompt to start working with the agent.")}
              </p>
              {children}
            </>
          ) : null}
          {order.slice(start, end).map((id) => (
            <AgentItemRow key={id} store={store} id={id} />
          ))}
          {(working || (starting && !blank)) && mounted.anchor === null ? (
            <div className="agent-activity" role="status">
              <Spinner size="sm" />
              {starting ? t("Starting the agent") : t("Working")}
            </div>
          ) : null}
          {footer && !blank && !working && end === order.length ? footer : null}
        </div>
      </div>
      {away ? (
        <Button
          variant="secondary"
          className="agent-latest"
          onClick={showLatest}
        >
          <ArrowDown size={14} aria-hidden="true" />
          {t("Jump to latest")}
        </Button>
      ) : null}
    </div>
  );
}
