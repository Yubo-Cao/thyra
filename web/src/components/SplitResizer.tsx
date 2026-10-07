import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { t } from "../i18n";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
} from "../workspaceResource";

/**
 * The 1px divider between a list and its detail, dragged or moved with the
 * arrow keys, Home, and End; a double-click resets it. The ratio is measured
 * across the parent grid minus its horizontal `inset`.
 */
export function SplitResizer({
  ratio,
  resetRatio = DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inset = 0,
  label,
  controls,
  onChange,
  onCommit,
}: {
  ratio: number;
  resetRatio?: number;
  inset?: number;
  label: string;
  controls?: string;
  onChange: (ratio: number) => void;
  onCommit?: (ratio: number) => void;
}) {
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const update = (next: number, commit = false) => {
    ratioRef.current = next;
    onChange(next);
    if (commit) onCommit?.(next);
  };
  const width = (element: HTMLElement) =>
    (element.parentElement?.getBoundingClientRect().width ?? 0) - inset;
  const fromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    update(
      inspectorNavigationRatioAtPosition(
        event.clientX - bounds.left - inset / 2,
        bounds.width - inset,
      ),
    );
  };
  const release = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit?.(ratioRef.current);
  };
  return (
    <div
      className="workspace-inspector-split-resizer"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={15}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      title={t("Drag to resize; double-click to reset")}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        fromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          fromPointer(event);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={() => update(resetRatio, true)}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        const available = width(event.currentTarget);
        const offset =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? available
              : event.key === "ArrowLeft" || event.key === "ArrowRight"
                ? ratioRef.current * available +
                  (event.key === "ArrowLeft" ? -16 : 16)
                : null;
        if (offset === null) return;
        event.preventDefault();
        update(inspectorNavigationRatioAtPosition(offset, available), true);
      }}
    />
  );
}
