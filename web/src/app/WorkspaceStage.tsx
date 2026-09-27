import { type ReactNode, Suspense, useRef } from "react";
import type { ConnectionClient } from "../api";
import { t } from "../i18n";
import {
  INSPECTOR_MIN_BOTTOM,
  INSPECTOR_MIN_RIGHT,
  inspectorMaximumSize,
  resourceOwnerKey,
} from "../workspaceResource";
import { workspaceInspectorPanel } from "./lazySurfaces";
import { TerminalLoadingFallback } from "./TerminalPaneLayout";
import type { MobileView } from "./useShellLayout";
import type { WorkspaceInspector } from "./useWorkspaceInspector";

const WorkspaceInspectorPanel = workspaceInspectorPanel.Component;

/** The terminal surface with the docked, resizable Workspace Inspector. */
export function WorkspaceStage({
  inspector,
  mobile,
  mobileView,
  onMobileViewChange,
  resourceUiKey,
  connectionClient,
  children,
}: {
  inspector: WorkspaceInspector;
  mobile: boolean;
  mobileView: MobileView;
  onMobileViewChange: (view: MobileView) => void;
  resourceUiKey: string;
  connectionClient: ConnectionClient;
  children: ReactNode;
}) {
  const { state, stateRef, stageRef, commit, commitAndSave } = inspector;
  const resizeFrameRef = useRef<number | null>(null);
  const resizeWithKeyboard = (e: React.KeyboardEvent) => {
    const current = stateRef.current;
    const stage = stageRef.current;
    if (!current || !stage || current.expanded) return;
    const increase =
      current.dock === "right" ? e.key === "ArrowLeft" : e.key === "ArrowUp";
    const decrease =
      current.dock === "right" ? e.key === "ArrowRight" : e.key === "ArrowDown";
    if (!increase && !decrease) return;
    e.preventDefault();
    const bounds = stage.getBoundingClientRect();
    const minimum =
      current.dock === "right" ? INSPECTOR_MIN_RIGHT : INSPECTOR_MIN_BOTTOM;
    const maximum = inspectorMaximumSize(
      current.dock,
      bounds.width,
      bounds.height,
    );
    commitAndSave({
      ...current,
      size: Math.min(
        maximum,
        Math.max(
          minimum,
          Math.min(current.size, maximum) + (increase ? 24 : -24),
        ),
      ),
    });
  };
  const startResize = (e: React.PointerEvent) => {
    const current = stateRef.current;
    const stage = stageRef.current;
    if (!current || !stage || current.expanded) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const dock = current.dock;
    const bounds = stage.getBoundingClientRect();
    const maxSize = inspectorMaximumSize(dock, bounds.width, bounds.height);
    const startSize = Math.min(current.size, maxSize);
    let finalSize = startSize;
    const onMove = (event: PointerEvent) => {
      finalSize = Math.min(
        maxSize,
        Math.max(
          dock === "right" ? INSPECTOR_MIN_RIGHT : INSPECTOR_MIN_BOTTOM,
          startSize +
            (dock === "right"
              ? startX - event.clientX
              : startY - event.clientY),
        ),
      );
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const value = stateRef.current;
        commit(value ? { ...value, size: finalSize } : value);
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      const latest = stateRef.current;
      if (latest) commitAndSave({ ...latest, size: finalSize });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    <div
      ref={stageRef}
      className={`workspace-stage ${
        state?.open ? `has-inspector inspector-dock-${state.dock}` : ""
      } ${state?.open && state.expanded ? "is-inspector-expanded" : ""}`}
    >
      <div className="workspace-terminal-surface">{children}</div>
      {state?.open && !state.expanded ? (
        <div
          className="workspace-inspector-resizer"
          role="separator"
          aria-label={
            state.dock === "bottom"
              ? t("Resize bottom Inspector")
              : t("Resize right Inspector")
          }
          aria-orientation={state.dock === "right" ? "vertical" : "horizontal"}
          tabIndex={0}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
        />
      ) : null}
      {state ? (
        <div
          className={`workspace-inspector-slot ${state.open ? "" : "is-closed"}`}
          style={
            state.expanded
              ? undefined
              : state.dock === "right"
                ? { width: state.size }
                : { height: state.size }
          }
        >
          <Suspense
            fallback={
              <TerminalLoadingFallback label={t("Loading Inspector")} />
            }
          >
            <WorkspaceInspectorPanel
              key={`${resourceUiKey}:${resourceOwnerKey(state.scope)}`}
              inspector={inspector}
              state={state}
              visible={!mobile || mobileView === state.view}
              mobile={mobile}
              onMobileViewChange={onMobileViewChange}
              connectionClient={connectionClient}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
