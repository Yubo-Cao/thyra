import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { thyraLocalStorage } from "../../browserStorage";
import { cn } from "../../utils";
import { CloseButton } from "./CloseButton";
import {
  clampRect,
  dragRect,
  GRIPS,
  type Grip,
  parseRect,
  type Rect,
  type Size,
} from "./floatingWindowGeometry";
import "./floatingWindow.css";

export type FloatingWindowProps = {
  /** Heading; also the window's accessible name. */
  title: ReactNode;
  /** One line under the heading. */
  description?: ReactNode;
  /** Extra controls in the title bar, before the close button. */
  headerActions?: ReactNode;
  onClose: () => void;
  /** localStorage key that keeps the window's place and size. */
  storageKey: string;
  /** Smallest size an edge drag allows (default 360x240). */
  minSize?: Size;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
};

const DEFAULT_MIN: Size = { w: 360, h: 240 };
// Controls in the title bar keep their own clicks.
const CONTROLS =
  "button, input, select, textarea, [role=button], [role=combobox]";

const viewportSize = (): Size => ({
  w: window.innerWidth,
  h: window.innerHeight,
});

/** Centered, most of the viewport: the first time a window opens. */
function defaultRect(viewport: Size): Rect {
  const w = Math.round(viewport.w * 0.7);
  const h = Math.round(viewport.h * 0.75);
  return {
    x: Math.round((viewport.w - w) / 2),
    y: Math.round((viewport.h - h) / 2),
    w,
    h,
  };
}

/**
 * Non-modal window over the app: drag the title bar to move it, any edge or
 * corner to resize it, double-click the title bar to fill the viewport. The
 * rest of the app stays usable; its place and size persist per storageKey.
 */
export function FloatingWindow({
  title,
  description,
  headerActions,
  onClose,
  storageKey,
  minSize = DEFAULT_MIN,
  className,
  bodyClassName,
  children,
}: FloatingWindowProps) {
  const min = minSize;
  const [rect, setRect] = useState<Rect>(() => {
    const viewport = viewportSize();
    const stored = parseRect(thyraLocalStorage.getItem(storageKey));
    return clampRect(stored ?? defaultRect(viewport), viewport, min);
  });
  // The size before a double-click filled the viewport.
  const [restore, setRestore] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const drag = useRef<{
    grip: Grip;
    start: Rect;
    x: number;
    y: number;
  } | null>(null);

  const commit = (next: Rect) => {
    setRect(next);
    thyraLocalStorage.setItem(storageKey, JSON.stringify(next));
  };

  // Keep the window inside a shrinking browser window.
  useEffect(() => {
    const onResize = () =>
      setRect((current) => clampRect(current, viewportSize(), min));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min]);

  const begin = (grip: Grip) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (grip === "move" && (event.target as Element).closest(CONTROLS))
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { grip, start: rect, x: event.clientX, y: event.clientY };
    setRestore(null);
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active) return;
    setRect(
      dragRect(
        active.start,
        active.grip,
        event.clientX - active.x,
        event.clientY - active.y,
        viewportSize(),
        min,
      ),
    );
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    thyraLocalStorage.setItem(storageKey, JSON.stringify(rectRef.current));
  };
  const handlers = (grip: Grip) => ({
    onPointerDown: begin(grip),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  const toggleFill = (event: ReactMouseEvent) => {
    if ((event.target as Element).closest(CONTROLS)) return;
    if (restore) {
      commit(clampRect(restore, viewportSize(), min));
      setRestore(null);
    } else {
      setRestore(rect);
      const viewport = viewportSize();
      setRect({ x: 0, y: 0, w: viewport.w, h: viewport.h });
    }
  };

  return (
    <section
      role="dialog"
      aria-label={typeof title === "string" ? title : undefined}
      className={cn("ui-floating-window", dragging && "is-dragging", className)}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <header
        className="ui-floating-window-header"
        onDoubleClick={toggleFill}
        {...handlers("move")}
      >
        <div className="ui-floating-window-titles">
          <h2 className="ui-floating-window-title">{title}</h2>
          {description ? (
            <p className="ui-floating-window-description">{description}</p>
          ) : null}
        </div>
        {headerActions}
        <CloseButton onClick={onClose} />
      </header>
      <div className={cn("ui-floating-window-body", bodyClassName)}>
        {children}
      </div>
      {GRIPS.map((grip) => (
        <div
          key={grip}
          aria-hidden="true"
          className={`ui-floating-window-grip is-${grip}`}
          {...handlers(grip)}
        />
      ))}
    </section>
  );
}
