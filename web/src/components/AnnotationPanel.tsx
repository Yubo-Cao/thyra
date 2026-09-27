import {
  ArrowDown,
  ArrowUp,
  Clipboard,
  MessageSquareText,
  Pin,
  PinOff,
  Send,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  diffReviewLineDisplayLabel,
  fileReviewLineDisplayLabel,
  terminalAnnotationTitle,
  type ReviewAnnotation,
} from "../annotations";
import { t } from "../i18n";
import {
  getShortcutSnapshot,
  shortcutLabel,
  shortcutMatches,
  shortcutTitle,
  useShortcutPreferences,
} from "../shortcutPreferences";
import type { Pane } from "../types";
import { Button } from "./ui/Button";
import { CloseButton } from "./ui/CloseButton";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { IconButton } from "./ui/IconButton";
import { Kbd } from "./ui/Kbd";
import { Select } from "./ui/Select";
import { TextArea } from "./ui/TextArea";
import "./AnnotationPanel.css";

function annotationLocation(annotation: ReviewAnnotation) {
  if (annotation.source === "terminal")
    return t("Terminal · {title} · selected passage", {
      title: annotation.title,
    });
  if (annotation.source === "diff") {
    return t("Diff · {path} · {lines}", {
      path: annotation.path,
      lines: diffReviewLineDisplayLabel(annotation),
    });
  }
  if (annotation.anchor === "line") {
    return t("File · {path} · {lines}", {
      path: annotation.path,
      lines: fileReviewLineDisplayLabel(annotation),
    });
  }
  return annotation.section.length
    ? t("Markdown · {path} · {section}", {
        path: annotation.path,
        section: annotation.section.join(" › "),
      })
    : t("Markdown · {path} · selected passage", { path: annotation.path });
}

function paneLabel(pane: Pane) {
  return terminalAnnotationTitle(pane);
}

export function AnnotationPanel({
  open,
  floating,
  onToggleFloating,
  annotations,
  agentPanes,
  preferredPaneId,
  busy,
  focusedAnnotationId,
  onClose,
  onUpdateComment,
  onDelete,
  onMove,
  onClear,
  onCopy,
  onSend,
  onGoToAgent,
}: {
  open: boolean;
  floating: boolean;
  onToggleFloating?: () => void;
  annotations: readonly ReviewAnnotation[];
  agentPanes: readonly Pane[];
  preferredPaneId?: string;
  busy: boolean;
  focusedAnnotationId?: string | null;
  onClose: () => void;
  onUpdateComment: (id: string, comment: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onClear: () => void;
  onCopy: () => void;
  onSend: (paneId: string | null) => void;
  onGoToAgent?: () => void;
}) {
  useShortcutPreferences();
  const copyShortcut = shortcutLabel("annotations.copy");
  const prefillShortcut = shortcutLabel("annotations.prefill");
  const { bindings } = getShortcutSnapshot().preset;
  const hasCopyShortcut = bindings["annotations.copy"].length > 0;
  const hasPrefillShortcut = bindings["annotations.prefill"].length > 0;
  const hasFeedback = annotations.some((annotation) =>
    annotation.comment.trim(),
  );
  const [targetPaneId, setTargetPaneId] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (preferredPaneId) setTargetPaneId(preferredPaneId);
  }, [preferredPaneId]);

  useEffect(() => {
    const preferred = agentPanes.find(
      (pane) => pane.pane_id === preferredPaneId,
    );
    setTargetPaneId((current) => {
      if (agentPanes.some((pane) => pane.pane_id === current)) return current;
      return preferred?.pane_id ?? agentPanes[0]?.pane_id ?? "";
    });
  }, [agentPanes, preferredPaneId]);

  useEffect(() => {
    if (!open || !focusedAnnotationId) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const card = Array.from(
          document.querySelectorAll<HTMLElement>("[data-review-annotation-id]"),
        ).find(
          (element) =>
            element.dataset.reviewAnnotationId === focusedAnnotationId,
        );
        card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        card?.querySelector("textarea")?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedAnnotationId, open]);

  if (!open) return null;

  return (
    <aside
      className={`annotation-panel ${floating ? "is-floating" : ""}`}
      aria-label={t("Review annotations")}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          confirmClear ||
          !(event.target instanceof Node) ||
          !event.currentTarget.contains(event.target)
        )
          return;
        const copy = shortcutMatches(event.nativeEvent, "annotations.copy");
        const prefill = shortcutMatches(
          event.nativeEvent,
          "annotations.prefill",
        );
        if (!copy && !prefill) return;
        event.preventDefault();
        event.stopPropagation();
        if (busy || !hasFeedback || event.repeat) return;
        if (copy) onCopy();
        else onSend(targetPaneId || null);
      }}
    >
      <header className="annotation-panel-head">
        <div>
          <strong>{t("Review feedback")}</strong>
          <span>
            {annotations.length === 1
              ? t("1 comment")
              : t("{count} comments", { count: annotations.length })}
          </span>
        </div>
        {onToggleFloating ? (
          <IconButton
            label={floating ? t("Pin annotations") : t("Float annotations")}
            tooltip={floating ? t("Fixed layout") : t("Floating layout")}
            aria-pressed={!floating}
            onClick={onToggleFloating}
            icon={floating ? <Pin size={16} /> : <PinOff size={16} />}
          />
        ) : null}
        <CloseButton
          label={t("Close review feedback")}
          tooltip={t("Close")}
          onClick={onClose}
        />
      </header>

      <div className="annotation-panel-list">
        {annotations.length === 0 ? (
          <div className="annotation-panel-empty">
            <MessageSquareText size={24} />
            <strong>{t("No review comments yet")}</strong>
            <span>
              {t(
                "Click or drag across diff line numbers or a source gutter, or select rendered Markdown or terminal text.",
              )}
            </span>
          </div>
        ) : (
          annotations.map((annotation, index) => (
            <article
              key={annotation.id}
              data-review-annotation-id={annotation.id}
              className={`annotation-card ${
                annotation.id === focusedAnnotationId ? "is-focused" : ""
              }`}
            >
              <div className="annotation-card-head">
                <strong title={annotationLocation(annotation)}>
                  {index + 1}. {annotationLocation(annotation)}
                </strong>
                {annotation.stale ? (
                  <span>
                    {annotation.source === "terminal"
                      ? t("Pane unavailable")
                      : t("Stale anchor")}
                  </span>
                ) : null}
              </div>
              <blockquote
                tabIndex={0}
                aria-label={t("Selected text for comment {number}", {
                  number: index + 1,
                })}
              >
                {annotation.quote || t("Blank line")}
              </blockquote>
              <TextArea
                fullWidth
                value={annotation.comment}
                rows={3}
                maxLength={10_000}
                aria-label={t("Comment {number}", { number: index + 1 })}
                onValueChange={(value) => onUpdateComment(annotation.id, value)}
              />
              <div className="annotation-card-actions">
                <IconButton
                  disabled={index === 0}
                  label={t("Move comment {number} up", {
                    number: index + 1,
                  })}
                  tooltip={t("Move up")}
                  onClick={() => onMove(annotation.id, -1)}
                  icon={<ArrowUp size={14} />}
                />
                <IconButton
                  disabled={index === annotations.length - 1}
                  label={t("Move comment {number} down", {
                    number: index + 1,
                  })}
                  tooltip={t("Move down")}
                  onClick={() => onMove(annotation.id, 1)}
                  icon={<ArrowDown size={14} />}
                />
                <IconButton
                  tone="danger"
                  label={t("Delete comment {number}", {
                    number: index + 1,
                  })}
                  tooltip={t("Delete")}
                  onClick={() => onDelete(annotation.id)}
                  icon={<Trash2 size={14} />}
                />
              </div>
            </article>
          ))
        )}
      </div>

      <footer className="annotation-panel-footer">
        {agentPanes.length > 1 ? (
          <Select
            className="annotation-target-picker"
            label={t("Agent pane")}
            aria-label={t("Agent pane")}
            fullWidth
            value={targetPaneId}
            options={agentPanes.map((pane) => ({
              value: pane.pane_id,
              label: paneLabel(pane),
            }))}
            onChange={setTargetPaneId}
          />
        ) : agentPanes.length === 1 ? (
          <div className="annotation-target-summary">
            {t("Agent pane: {pane}", { pane: paneLabel(agentPanes[0]) })}
          </div>
        ) : (
          <div className="annotation-target-summary">
            {t("No agent pane; Send uses the clipboard.")}
          </div>
        )}
        <div className="annotation-delivery-actions">
          <Button
            size="md"
            disabled={busy || !hasFeedback}
            onClick={onCopy}
            title={shortcutTitle(t("Copy review feedback"), "annotations.copy")}
          >
            <Clipboard size={14} /> {t("Copy")}
            {hasCopyShortcut ? <Kbd>{copyShortcut}</Kbd> : null}
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy || !hasFeedback}
            onClick={() => onSend(targetPaneId || null)}
            title={shortcutTitle(
              agentPanes.length ? t("Pre-fill agent") : t("Copy feedback"),
              "annotations.prefill",
            )}
          >
            {agentPanes.length ? <Send size={14} /> : <Clipboard size={14} />}
            {agentPanes.length ? t("Pre-fill agent") : t("Copy feedback")}
            {hasPrefillShortcut ? <Kbd>{prefillShortcut}</Kbd> : null}
          </Button>
        </div>
        {onGoToAgent ? (
          <Button onClick={onGoToAgent}>{t("Go to agent")}</Button>
        ) : null}
        <Button
          className="annotation-clear-button"
          data-tone="danger"
          disabled={busy || annotations.length === 0}
          onClick={() => setConfirmClear(true)}
        >
          {t("Clear draft")}
        </Button>
      </footer>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("Clear review feedback?")}
        message={t("This removes every unsent review comment from this draft.")}
        confirmLabel={t("Clear feedback")}
        tone="danger"
        onConfirm={onClear}
      />
    </aside>
  );
}
