import { useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import {
  type TerminalTouchSelection,
  terminalSelectedText,
} from "../../terminalTouchSelection";
import type { TerminalFileLinkMenuState } from "../TerminalFileLinkMenu";
import { Button } from "../ui/Button";
import {
  copyFinishedSelection,
  type TerminalRefs,
  type TerminalTouchLinkState,
} from "./terminalSession";

const clampHandle = (value: number, size: number) =>
  Math.max(22, Math.min(value, size - 22));

/** Touch selection handles plus the Copy / Done / link action bar. */
export function TerminalTouchSelectionBar({
  handles,
  touchLink,
  refs,
  onTouchLinkChange,
  onFileLinkMenu,
  onCopyError,
}: {
  handles: TerminalTouchSelection["handles"];
  touchLink: TerminalTouchLinkState | null;
  refs: TerminalRefs;
  onTouchLinkChange: (link: null) => void;
  onFileLinkMenu: (menu: TerminalFileLinkMenuState) => void;
  onCopyError: (message: string) => void;
}) {
  const handleOffset = useRef({ x: 0, y: 0 });
  const handleYs = handles.map((handle) => handle.y);
  const actionsTop =
    Math.max(...handleYs) + 80 < window.innerHeight
      ? Math.max(...handleYs) + 28
      : Math.max(8, Math.min(...handleYs) - 76);
  return createPortal(
    <div className="terminal-touch-selection-ui">
      <div
        className="terminal-touch-selection-actions"
        style={{ top: actionsTop }}
        role="group"
        aria-label={t("Selected terminal output")}
      >
        <Button
          variant="secondary"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const text = refs.term.current
              ? terminalSelectedText(refs.term.current)
              : "";
            if (text)
              void copyTextFromUserGesture(text).catch((error) =>
                onCopyError(
                  t("Copy failed: {error}", {
                    error: (error as Error).message,
                  }),
                ),
              );
          }}
        >
          {t("Copy")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => refs.touchSelection.current?.reset()}
        >
          {t("Done")}
        </Button>
        {touchLink ? (
          <Button
            variant="secondary"
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              if (!touchLink.current()) {
                onTouchLinkChange(null);
                return;
              }
              if (touchLink.kind === "url") {
                window.open(touchLink.value, "_blank", "noopener,noreferrer");
              } else {
                const workspaceId = refs.workspaceId.current;
                if (workspaceId)
                  onFileLinkMenu({
                    path: touchLink.value,
                    workspaceId,
                    x: event.clientX,
                    y: event.clientY,
                  });
              }
              refs.touchSelection.current?.reset();
            }}
          >
            {touchLink.kind === "url" ? t("Open link") : t("File actions")}
          </Button>
        ) : null}
      </div>
      {handles.map((handle) => (
        <button
          key={handle.index}
          type="button"
          className="terminal-selection-handle"
          aria-label={handle.label}
          style={{
            left: clampHandle(handle.x, window.innerWidth),
            top: clampHandle(handle.y, window.innerHeight),
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            if (!event.isPrimary) return;
            refs.touchLinkIntent.current++;
            onTouchLinkChange(null);
            handleOffset.current = {
              x: event.clientX - handle.x,
              y: event.clientY - handle.cellY,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              refs.touchSelection.current?.drag(handle.index, {
                x: event.clientX - handleOffset.current.x,
                y: event.clientY - handleOffset.current.y,
              });
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
              if (refs.term.current)
                copyFinishedSelection(terminalSelectedText(refs.term.current));
            }
          }}
          onKeyDown={(event) => {
            const delta = {
              ArrowLeft: -1,
              ArrowRight: 1,
              ArrowUp: -(refs.term.current?.cols ?? 1),
              ArrowDown: refs.term.current?.cols ?? 1,
            }[event.key];
            if (delta) {
              event.preventDefault();
              refs.touchSelection.current?.nudge(handle.index, delta);
            }
          }}
        >
          <svg aria-hidden="true" width="44" height="44">
            <line
              x1="22"
              y1="22"
              x2={22 + handle.x - clampHandle(handle.x, window.innerWidth)}
              y2={
                22 + handle.markerY - clampHandle(handle.y, window.innerHeight)
              }
            />
          </svg>
        </button>
      ))}
    </div>,
    document.body,
  );
}
