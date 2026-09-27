import type { ITheme } from "@xterm/xterm";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type ComponentProps,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TerminalWorkspaceFileRequest } from "../components/TerminalView";
import { IconButton } from "../components/ui/IconButton";
import { t } from "../i18n";
import { useLayoutPreferences } from "../layoutPreferences";
import { lazyWithReload } from "../lazyWithReload";
import type {
  MobileTerminalShortcutRows,
  MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import { paneLayoutNeedsSwitcher } from "../paneLayoutSizing";
import { shallowEqual, type State, store, useStoreSelector } from "../store";
import { terminalMountKey } from "../terminalConnection";
import { blurActiveInput } from "./MobileControls";

const LazyTerminalView = lazyWithReload("terminal-view", () =>
  import("../components/TerminalView").then((module) => ({
    default: module.TerminalView,
  })),
);

export function TerminalLoadingFallback({
  label = t("Loading terminal"),
}: {
  label?: string;
}) {
  return (
    <div className="terminal-loading" role="status">
      <span className="terminal-loading-dot" />
      {label}
    </div>
  );
}

function TerminalView(props: ComponentProps<typeof LazyTerminalView>) {
  return (
    <Suspense fallback={<TerminalLoadingFallback />}>
      <LazyTerminalView {...props} />
    </Suspense>
  );
}

// Herdr reports pane rectangles in terminal-cell coordinates. The GUI maps
// those rectangles into CSS percentages so panes scale with the browser.
function rectPercent(value: number, start: number, size: number) {
  if (size <= 0) return 0;
  return ((value - start) / size) * 100;
}

function paneTitle(paneId: string, panes: State["panes"]) {
  const pane = panes.find((p) => p.pane_id === paneId);
  if (pane?.agent) return pane.agent;
  const cwd = pane?.foreground_cwd ?? pane?.cwd;
  const name = cwd?.split(/[\\/]/).filter(Boolean).pop();
  return name || paneId;
}

type PaneLayoutSnapshot = NonNullable<State["layout"]>;
type PaneLayoutPaneSnapshot = PaneLayoutSnapshot["panes"][number];
type PaneLayoutSplitSnapshot = PaneLayoutSnapshot["splits"][number];

function overlapLength(
  aStart: number,
  aSize: number,
  bStart: number,
  bSize: number,
) {
  return Math.max(
    0,
    Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart),
  );
}

function ratioBoundary(split: PaneLayoutSplitSnapshot) {
  return split.direction === "right"
    ? split.rect.x + split.rect.width * split.ratio
    : split.rect.y + split.rect.height * split.ratio;
}

function bestPaneNearSplit(
  panes: PaneLayoutPaneSnapshot[],
  split: PaneLayoutSplitSnapshot,
  side: "before" | "after",
  pointerPerpendicular: number,
) {
  const boundary = ratioBoundary(split);
  const edgeTolerance = 6;
  const containsPointer = (pane: PaneLayoutPaneSnapshot) =>
    split.direction === "right"
      ? pointerPerpendicular >= pane.rect.y &&
        pointerPerpendicular <= pane.rect.y + pane.rect.height
      : pointerPerpendicular >= pane.rect.x &&
        pointerPerpendicular <= pane.rect.x + pane.rect.width;
  const candidates = panes
    .map((pane) => {
      const edge =
        split.direction === "right"
          ? side === "before"
            ? pane.rect.x + pane.rect.width
            : pane.rect.x
          : side === "before"
            ? pane.rect.y + pane.rect.height
            : pane.rect.y;
      const perpendicularOverlap =
        split.direction === "right"
          ? overlapLength(
              pane.rect.y,
              pane.rect.height,
              split.rect.y,
              split.rect.height,
            )
          : overlapLength(
              pane.rect.x,
              pane.rect.width,
              split.rect.x,
              split.rect.width,
            );
      return {
        pane,
        edgeDistance: Math.abs(edge - boundary),
        perpendicularOverlap,
      };
    })
    .filter(
      ({ pane, edgeDistance, perpendicularOverlap }) =>
        edgeDistance <= edgeTolerance &&
        perpendicularOverlap > 0 &&
        containsPointer(pane),
    )
    .sort((a, b) => b.perpendicularOverlap - a.perpendicularOverlap);
  return candidates[0]?.pane ?? null;
}

function splitBoundaryFromPaneRects(
  panes: PaneLayoutPaneSnapshot[],
  split: PaneLayoutSplitSnapshot,
) {
  const horizontal = split.direction === "right";
  const middle = horizontal
    ? split.rect.y + split.rect.height / 2
    : split.rect.x + split.rect.width / 2;
  const before = bestPaneNearSplit(panes, split, "before", middle);
  const after = bestPaneNearSplit(panes, split, "after", middle);
  if (!before || !after) return ratioBoundary(split);
  const beforeEdge = horizontal
    ? before.rect.x + before.rect.width
    : before.rect.y + before.rect.height;
  const afterEdge = horizontal ? after.rect.x : after.rect.y;
  return (beforeEdge + afterEdge) / 2;
}

function resizeTargetForSplit(
  layout: PaneLayoutSnapshot,
  split: PaneLayoutSplitSnapshot,
  dragSign: 1 | -1,
  pointerPerpendicular: number,
) {
  const side = dragSign > 0 ? "before" : "after";
  const pane = bestPaneNearSplit(
    layout.panes,
    split,
    side,
    pointerPerpendicular,
  );
  if (!pane) return null;
  const direction =
    split.direction === "right"
      ? dragSign > 0
        ? "right"
        : "left"
      : dragSign > 0
        ? "down"
        : "up";
  return { paneId: pane.pane_id, direction } as const;
}

export type TerminalPaneLayoutProps = {
  terminalTheme: ITheme;
  uiScale: number;
  fontFamily: string;
  mobileShortcuts: MobileTerminalShortcutRows;
  mobileSideShortcuts: MobileTerminalSideShortcuts;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
  agentHistoryOpen: boolean;
  onAgentHistoryOpenChange: (open: boolean) => void;
  onOpenWorkspaceFile: (request: TerminalWorkspaceFileRequest) => void;
};

// Render the active tab's Herdr pane layout; single-pane and zoomed tabs keep
// the old full terminal view.
export function TerminalPaneLayout(props: TerminalPaneLayoutProps) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
    }),
    shallowEqual,
  );
  const { mobile } = useLayoutPreferences();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [responsivePaneSwitcher, setResponsivePaneSwitcher] = useState(false);
  const layout = s.layout;
  const visiblePanes =
    layout?.panes.filter((lp) =>
      s.panes.some((pane) => pane.pane_id === lp.pane_id),
    ) ?? [];
  const fallbackPaneId = visiblePanes[0]?.pane_id ?? null;
  const activePaneId =
    visiblePanes.find((lp) => lp.pane_id === s.selectedPaneId)?.pane_id ??
    visiblePanes.find((lp) => lp.pane_id === layout?.focused_pane_id)
      ?.pane_id ??
    fallbackPaneId;
  const mountKeyForPane = (paneId: string | null) => {
    const terminalId =
      s.panes.find((pane) => pane.pane_id === paneId)?.terminal_id ?? null;
    return terminalMountKey(
      {
        connectionId: s.activeConnectionId,
        generation: s.connectionGeneration,
      },
      paneId,
      terminalId,
    );
  };
  const setLayoutContainer = useCallback((element: HTMLDivElement | null) => {
    layoutRef.current = element;
    setLayoutElement(element);
  }, []);
  useLayoutEffect(() => {
    if (!layoutElement || !layout) return setResponsivePaneSwitcher(false);
    const update = () =>
      setResponsivePaneSwitcher(
        paneLayoutNeedsSwitcher(layout, layoutElement.clientWidth),
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(layoutElement);
    return () => observer.disconnect();
  }, [layout, layoutElement]);

  if (!layout || layout.zoomed || visiblePanes.length <= 1) {
    return <TerminalView key={mountKeyForPane(activePaneId)} {...props} />;
  }

  if ((mobile || responsivePaneSwitcher) && activePaneId) {
    const activeIndex = Math.max(
      0,
      visiblePanes.findIndex((lp) => lp.pane_id === activePaneId),
    );
    const previousPane =
      visiblePanes[
        (activeIndex - 1 + visiblePanes.length) % visiblePanes.length
      ];
    const nextPane = visiblePanes[(activeIndex + 1) % visiblePanes.length];
    return (
      <div
        ref={setLayoutContainer}
        className="pane-switcher-layout"
        aria-label={t("Terminal pane switcher")}
      >
        <div className="pane-switcher">
          <IconButton
            className="pane-switcher-button"
            label={t("Previous pane")}
            icon={<ChevronLeft size={15} aria-hidden="true" />}
            tabIndex={-1}
            onPointerDown={blurActiveInput}
            onClick={() => void store.focusPane(previousPane.pane_id)}
          />
          <div className="pane-switcher-label">
            <strong>
              {t("Pane {index} / {count}", {
                index: activeIndex + 1,
                count: visiblePanes.length,
              })}
            </strong>
            <span>{paneTitle(activePaneId, s.panes)}</span>
          </div>
          <IconButton
            className="pane-switcher-button"
            label={t("Next pane")}
            icon={<ChevronRight size={15} aria-hidden="true" />}
            tabIndex={-1}
            onPointerDown={blurActiveInput}
            onClick={() => void store.focusPane(nextPane.pane_id)}
          />
        </div>
        <TerminalView
          key={mountKeyForPane(activePaneId)}
          paneId={activePaneId}
          {...props}
        />
      </div>
    );
  }

  const area = layout.area;
  const areaWidth = Math.max(1, area.width);
  const areaHeight = Math.max(1, area.height);
  const startPaneResize = (
    e: React.PointerEvent<HTMLDivElement>,
    split: PaneLayoutSplitSnapshot,
  ) => {
    if (e.button !== 0) return;
    const container = layoutRef.current;
    if (!container) return;
    e.preventDefault();
    e.stopPropagation();

    const bounds = container.getBoundingClientRect();
    const horizontal = split.direction === "right";
    const startAxis = horizontal ? e.clientX : e.clientY;
    const pointerPerpendicular = horizontal
      ? area.y +
        ((e.clientY - bounds.top) / Math.max(1, bounds.height)) * areaHeight
      : area.x +
        ((e.clientX - bounds.left) / Math.max(1, bounds.width)) * areaWidth;
    const splitPixelSize = horizontal
      ? (split.rect.width / areaWidth) * bounds.width
      : (split.rect.height / areaHeight) * bounds.height;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    // Capture the pointer so pointerup still reaches the window (and restores
    // cursor/user-select) even when released outside the browser window.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; window listeners still apply.
    }

    const cancel = () => {
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    const finish = (event: PointerEvent) => {
      cancel();
      const endAxis = horizontal ? event.clientX : event.clientY;
      const deltaPx = endAxis - startAxis;
      if (Math.abs(deltaPx) < 4) return;
      const dragSign = deltaPx > 0 ? 1 : -1;
      const target = resizeTargetForSplit(
        layout,
        split,
        dragSign,
        pointerPerpendicular,
      );
      if (!target) return;
      const amount = Math.min(
        0.5,
        Math.abs(deltaPx) / Math.max(1, splitPixelSize),
      );
      void store.resizePane(target.paneId, target.direction, amount);
    };
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
  };

  return (
    <div
      ref={setLayoutContainer}
      className="pane-layout"
      aria-label={t("Terminal panes")}
    >
      {visiblePanes.map((layoutPane) => {
        const rect = layoutPane.rect;
        const isActive = layoutPane.pane_id === activePaneId;
        return (
          <div
            key={mountKeyForPane(layoutPane.pane_id)}
            className={`pane-layout-cell ${isActive ? "is-active" : ""}`}
            style={{
              left: `${rectPercent(rect.x, area.x, areaWidth)}%`,
              top: `${rectPercent(rect.y, area.y, areaHeight)}%`,
              width: `${(rect.width / areaWidth) * 100}%`,
              height: `${(rect.height / areaHeight) * 100}%`,
            }}
            onPointerDownCapture={() => {
              if (!isActive) void store.focusPane(layoutPane.pane_id);
            }}
          >
            <TerminalView
              key={mountKeyForPane(layoutPane.pane_id)}
              {...props}
              paneId={layoutPane.pane_id}
              showMobileKeys={isActive}
              composerOpen={isActive && props.composerOpen}
              onComposerOpenChange={
                isActive ? props.onComposerOpenChange : undefined
              }
              agentHistoryOpen={isActive && props.agentHistoryOpen}
            />
          </div>
        );
      })}
      {layout.splits.map((split) => {
        const horizontal = split.direction === "right";
        const boundary = splitBoundaryFromPaneRects(layout.panes, split);
        return (
          <div
            key={split.id}
            className={`pane-resize-handle ${horizontal ? "is-vertical" : "is-horizontal"}`}
            style={
              horizontal
                ? {
                    left: `${rectPercent(boundary, area.x, areaWidth)}%`,
                    top: `${rectPercent(split.rect.y, area.y, areaHeight)}%`,
                    height: `${(split.rect.height / areaHeight) * 100}%`,
                  }
                : {
                    top: `${rectPercent(boundary, area.y, areaHeight)}%`,
                    left: `${rectPercent(split.rect.x, area.x, areaWidth)}%`,
                    width: `${(split.rect.width / areaWidth) * 100}%`,
                  }
            }
            onPointerDown={(event) => startPaneResize(event, split)}
            role="separator"
            aria-orientation={horizontal ? "vertical" : "horizontal"}
          />
        );
      })}
    </div>
  );
}
