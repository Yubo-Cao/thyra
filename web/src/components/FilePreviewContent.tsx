import { workspaceCan } from "../capabilities";
import { shortcutMatches } from "../shortcutPreferences";
import {
  FILE_WRITE_CONFLICT_MESSAGE,
  FILE_WRITE_MAX_BYTES,
  HTML_PREVIEW_MAX_BYTES,
  isHtmlPath,
} from "../../../shared/filePreview";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  FolderPlus,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { t } from "../i18n";
import type { FileExplorerEntry, FilePreview } from "../types";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { downloadFileFromUrl } from "../downloadFile";
import { useConnectionClient } from "../useConnectionClient";
import {
  resolveWorkspaceMarkdownImageUrl,
  workspaceMarkdownDocumentPath,
  workspaceFileUrl,
} from "../workspaceFileUrl";
import { MarkdownPreview } from "./markdown";
import { MermaidDiagram } from "./MermaidDiagram";
import { ImagePreview } from "./ImagePreview";
import {
  isEditablePreviewTarget,
  isPreviewKeyboardTarget,
  selectAllInPreviewElement,
} from "./previewSelection";
import { CodePreview, type CodePreviewHandle } from "./CodePreview";
import { syntaxLanguageForPath } from "../syntaxLanguage";
import { store, useStoreSelector } from "../store";
import { relativePathWithinCheckout } from "../workspaceResource";
import {
  directoryPreviewName,
  directoryPreviewPath,
  normalizeFilesystemPath,
} from "../filesystemPaths";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { invalidateFilePreviewCache } from "./fileExplorerResources";
import { lazyWithReload } from "../lazyWithReload";
import { Button } from "./ui/Button";
import { CloseButton } from "./ui/CloseButton";
import { IconButton } from "./ui/IconButton";
import { Token } from "./ui/Token";
import { SegmentedControl } from "./ui/SegmentedControl";
import { useDocumentTheme } from "./documentTheme";
import "./FilePreviewContent.css";

const FileEditor = lazyWithReload("file-editor", () =>
  import("./FileEditor").then((module) => ({ default: module.FileEditor })),
);
const PdfPreview = lazyWithReload("pdf-preview", () =>
  import("./PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

type EditorDraft = {
  /** Text the draft was based on, i.e. the file content at last load/save. */
  base: string;
  text: string;
  /** Modification time of `base`, sent as the save precondition. */
  mtimeMs: number;
};

/**
 * Open editor drafts keyed by connection, workspace, and path. They survive
 * switching files or closing the Inspector, so navigation never silently
 * discards unsaved edits; only Save, Revert, or a confirmed Close does.
 */
const editorDrafts = new Map<string, EditorDraft>();

function hasDirtyEditorDrafts() {
  for (const draft of editorDrafts.values()) {
    if (draft.text !== draft.base) return true;
  }
  return false;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!hasDirtyEditorDrafts()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function isAbsoluteFilePath(path: string) {
  return /^(?:\/|[a-z]:[\\/])/i.test(path);
}

export type ActiveFilePreviewSelection = {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fragment?: string;
};

export type FilePreviewSelectionMeta = {
  userInitiated?: boolean;
};

const PDF_INLINE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

function isMarkdownPath(path: string) {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdown") ||
    lower.endsWith(".mkdn")
  );
}

function isMermaidPath(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".mmd") || lower.endsWith(".mermaid");
}

function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf");
}

export function FilePreviewContent({
  entry,
  preview,
  loading,
  error,
  fragment,
  changesContent,
  changesKey,
  backAction,
  onOpenChanges,
  onOpenFile,
  onRefresh,
}: {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fragment?: string;
  changesContent?: ReactNode;
  changesKey?: string;
  backAction?: { label: string; onClick: () => void };
  onOpenChanges?: () => void;
  onOpenFile?: (path: string, fragment?: string) => void;
  onRefresh?: () => void;
}) {
  const connectionClient = useConnectionClient();
  const workspaces = useStoreSelector((state) => state.workspaces);
  const previewSectionRef = useRef<HTMLElement | null>(null);
  const previewContentRef = useRef<HTMLDivElement | null>(null);
  const codePreviewRef = useRef<CodePreviewHandle | null>(null);
  const onOpenChangesRef = useRef(onOpenChanges);
  onOpenChangesRef.current = onOpenChanges;
  const [previewMode, setPreviewMode] = useState<"rendered" | "raw">(
    "rendered",
  );
  const [detailTab, setDetailTab] = useState<"file" | "changes">("file");
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const theme = useDocumentTheme();
  const previewText = preview?.text ?? null;
  const previewPath = preview?.path ?? "";
  const draftKey =
    preview?.workspace_id && previewPath
      ? `${connectionClient.connectionId}:${connectionClient.generation}:${preview.workspace_id}:${previewPath}`
      : "";
  const [, setDraftRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveConflict, setSaveConflict] = useState<string | null>(null);
  const draft = draftKey ? editorDrafts.get(draftKey) : undefined;
  const editing = !!draft;
  const dirty = !!draft && draft.text !== draft.base;
  const canEdit =
    !!preview &&
    previewText !== null &&
    !preview.binary &&
    !preview.truncated &&
    preview.type !== "directory" &&
    !preview.image_data_url &&
    !!preview.workspace_id &&
    preview.size <= FILE_WRITE_MAX_BYTES &&
    // Viewers (and share-link guests) read files but never write them.
    workspaceCan(
      workspaces.find((item) => item.workspace_id === preview.workspace_id),
      "edit",
    );
  const updateDraft = useCallback(
    (next: EditorDraft | null) => {
      if (!draftKey) return;
      if (next) editorDrafts.set(draftKey, next);
      else editorDrafts.delete(draftKey);
      setDraftRevision((revision) => revision + 1);
    },
    [draftKey],
  );
  const markdownDocumentPath = preview
    ? workspaceMarkdownDocumentPath(previewPath, preview.root)
    : previewPath;
  const hasPreviewText = previewText !== null;
  const hasMarkdownPreview = hasPreviewText && isMarkdownPath(previewPath);
  const hasMermaidPreview = hasPreviewText && isMermaidPath(previewPath);
  const hasPdfPreview = Boolean(preview && isPdfPath(previewPath));
  const pdfTooLarge =
    hasPdfPreview && (preview?.size ?? 0) > PDF_INLINE_PREVIEW_MAX_BYTES;
  const hasHtmlPreview =
    hasPreviewText &&
    !preview?.binary &&
    preview?.type !== "directory" &&
    isHtmlPath(previewPath) &&
    (!/^(?:\/|[a-z]:[\\/])/i.test(previewPath) ||
      relativePathWithinCheckout(preview?.root ?? "", previewPath) !==
        undefined);
  const htmlTooLarge =
    hasHtmlPreview &&
    ((preview?.size ?? 0) > HTML_PREVIEW_MAX_BYTES || !!preview?.truncated);
  const hasRichPreview =
    hasMarkdownPreview || hasMermaidPreview || hasHtmlPreview;
  const renderRichPreview = hasRichPreview && previewMode === "rendered";
  const inlinePreviewUrl = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return null;
    return workspaceFileUrl(
      connectionClient,
      preview.workspace_id,
      previewPath,
      { inline: true, revision: preview.resource_revision },
    );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
  ]);
  const markdownImageUrlResolver = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return undefined;
    return (source: string) =>
      resolveWorkspaceMarkdownImageUrl(
        source,
        markdownDocumentPath,
        connectionClient,
        preview.workspace_id,
        preview.resource_revision,
      );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
    markdownDocumentPath,
  ]);
  const markdownLinkUrlResolver = useMemo(() => {
    if (!preview?.workspace_id) return undefined;
    return (path: string) =>
      workspaceFileUrl(connectionClient, preview.workspace_id, path);
  }, [connectionClient, preview?.workspace_id]);
  const changesAvailable =
    changesContent !== undefined && !!changesKey && !!onOpenChanges;
  const showingChanges = detailTab === "changes" && changesAvailable;
  const directoryPath = directoryPreviewPath(preview);
  const directoryWorkspaceRoot = directoryPath
    ? workspaces.some((workspace) => {
        const root = workspace.worktree?.checkout_path ?? workspace.cwd;
        return !!root && normalizeFilesystemPath(root) === directoryPath;
      })
    : false;
  const showDirectoryWorkspaceAction =
    !!directoryPath && !directoryWorkspaceRoot;
  const directoryWorkspaceName = directoryPath
    ? directoryPreviewName(directoryPath)
    : "";
  useEffect(() => {
    setPreviewMode("rendered");
  }, [entry?.path]);

  useEffect(() => {
    setSaveConflict(null);
  }, [previewPath]);

  useEffect(() => {
    // A clean draft follows reloads; a dirty one keeps the user's text and
    // relies on the save precondition to detect the external change.
    const current = draftKey ? editorDrafts.get(draftKey) : undefined;
    if (!current || previewText === null || !preview) return;
    if (current.text !== current.base || current.base === previewText) return;
    updateDraft({
      base: previewText,
      text: previewText,
      mtimeMs: preview.mtime_ms,
    });
  }, [draftKey, preview, previewText, updateDraft]);

  const startEditing = () => {
    if (!preview || previewText === null || !canEdit) return;
    setSaveConflict(null);
    updateDraft({
      base: previewText,
      text: previewText,
      mtimeMs: preview.mtime_ms,
    });
  };

  const stopEditing = () => {
    if (
      dirty &&
      !window.confirm(
        t("Discard unsaved changes to {name}?", {
          name: entry?.name ?? previewPath,
        }),
      )
    )
      return;
    setSaveConflict(null);
    updateDraft(null);
  };

  const revertDraft = () => {
    if (!draft) return;
    setSaveConflict(null);
    updateDraft({ ...draft, text: draft.base });
  };

  const saveDraft = async (force = false) => {
    const current = draftKey ? editorDrafts.get(draftKey) : undefined;
    if (!preview || !current || saving) return;
    if (new TextEncoder().encode(current.text).length > FILE_WRITE_MAX_BYTES) {
      store.notify({
        kind: "error",
        message: t("File is too large to save"),
        detail: t("The editor saves files up to {size} MiB.", {
          size: FILE_WRITE_MAX_BYTES / 1024 / 1024,
        }),
      });
      return;
    }
    const absolute = isAbsoluteFilePath(previewPath);
    setSaving(true);
    try {
      const result = (await connectionClient.call("file.write", {
        workspace_id: preview.workspace_id,
        path: previewPath,
        content: current.text,
        expected_mtime_ms: current.mtimeMs,
        ...(force ? { force: true } : {}),
        ...(absolute ? { scope: "filesystem" } : {}),
      })) as { mtime_ms: number };
      if (!connectionClient.isCurrent()) return;
      // Keep typing that happened while the save was in flight.
      const latest = editorDrafts.get(draftKey) ?? current;
      editorDrafts.set(draftKey, {
        base: current.text,
        text: latest.text,
        mtimeMs: result.mtime_ms,
      });
      setDraftRevision((revision) => revision + 1);
      setSaveConflict(null);
      invalidateFilePreviewCache(
        connectionClient,
        preview.workspace_id,
        previewPath,
      );
      onRefresh?.();
      store.notify({
        kind: "success",
        message: t("File saved"),
        detail: previewPath,
        autoDismissMs: 3000,
      });
    } catch (saveError) {
      const message = (saveError as Error).message;
      if (message.includes(FILE_WRITE_CONFLICT_MESSAGE)) {
        setSaveConflict(message);
      } else {
        store.notify({
          kind: "error",
          message: t("Failed to save file"),
          detail: message,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadAfterConflict = () => {
    if (
      dirty &&
      !window.confirm(t("Discard your edits and reload the file from disk?"))
    )
      return;
    setSaveConflict(null);
    updateDraft(null);
    if (preview) {
      invalidateFilePreviewCache(
        connectionClient,
        preview.workspace_id,
        previewPath,
      );
    }
    onRefresh?.();
  };

  useEffect(() => {
    if (detailTab === "changes" && changesAvailable) {
      onOpenChangesRef.current?.();
    }
  }, [changesAvailable, changesKey, detailTab]);

  useEffect(() => {
    if (showingChanges || !hasPreviewText || editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".shortcut-modal"))
        return;
      const find = shortcutMatches(e, "preview.search");
      if (!find && !shortcutMatches(e, "preview.selectAll")) return;
      const section = previewSectionRef.current;
      if (!section || section.offsetParent === null) return;
      if (isEditablePreviewTarget(e.target)) return;
      if (find) {
        if (renderRichPreview) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        codePreviewRef.current?.openSearch();
        return;
      }
      if (!isPreviewKeyboardTarget(section, e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (renderRichPreview) {
        selectAllInPreviewElement(previewContentRef.current);
      } else {
        codePreviewRef.current?.selectAll();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [editing, hasPreviewText, renderRichPreview, showingChanges]);

  const copyPreviewText = async () => {
    if (previewText === null) return;
    try {
      await copyTextFromUserGesture(previewText);
      store.notify({
        kind: "success",
        message: t("File content copied"),
        detail: previewPath,
        autoDismissMs: 3000,
      });
    } catch (copyError) {
      store.notify({
        kind: "error",
        message: t("Failed to copy file content"),
        detail: (copyError as Error).message,
      });
    }
  };

  return (
    <section
      ref={previewSectionRef}
      className="file-preview"
      aria-label={t("File preview")}
      tabIndex={-1}
      onKeyDownCapture={(e) => {
        if (shortcutMatches(e.nativeEvent, "preview.search")) {
          if (showingChanges || renderRichPreview || editing) return;
          e.preventDefault();
          e.stopPropagation();
          codePreviewRef.current?.openSearch();
        }
      }}
    >
      <div className="file-preview-head">
        <div className="file-preview-title-row">
          {backAction ? (
            <IconButton
              className="file-preview-back"
              label={backAction.label}
              onClick={backAction.onClick}
              icon={<ChevronLeft size={14} aria-hidden="true" />}
            />
          ) : null}
          <div className="file-preview-title" title={entry?.name}>
            {entry?.name ?? t("Preview")}
          </div>
          <div className="file-preview-head-actions">
            {!showingChanges && hasPdfPreview && preview?.workspace_id ? (
              <Button
                onClick={() =>
                  void downloadFileFromUrl({
                    url: workspaceFileUrl(
                      connectionClient,
                      preview.workspace_id,
                      previewPath,
                      { revision: preview.resource_revision },
                    ),
                    filename: entry?.name ?? previewPath,
                  })
                }
              >
                {t("Download")}
              </Button>
            ) : null}
            {!showingChanges && showDirectoryWorkspaceAction ? (
              <IconButton
                label={t("New workspace with this directory as CWD")}
                onClick={() => setWorkspaceDialogOpen(true)}
                icon={<FolderPlus size={13} aria-hidden="true" />}
              />
            ) : null}
            {!showingChanges && entry && onRefresh ? (
              <IconButton
                label={t("Refresh preview")}
                disabled={loading}
                onClick={onRefresh}
                icon={
                  <RefreshCw
                    size={13}
                    className={loading ? "is-spinning" : undefined}
                    aria-hidden="true"
                  />
                }
              />
            ) : null}
            {!showingChanges && canEdit && !editing ? (
              <IconButton
                label={t("Edit file")}
                onClick={startEditing}
                icon={<Pencil size={13} aria-hidden="true" />}
              />
            ) : null}
            {!showingChanges && hasPreviewText && !preview?.truncated ? (
              <Button
                title={t("Copy entire file content")}
                onClick={() => void copyPreviewText()}
              >
                {t("Copy")}
              </Button>
            ) : null}
            {!showingChanges && hasRichPreview && !editing ? (
              <SegmentedControl
                className="file-preview-mode-toggle"
                aria-label={t("Preview mode")}
                value={previewMode}
                onChange={setPreviewMode}
                options={[
                  {
                    value: "rendered",
                    label: hasMermaidPreview ? t("Diagram") : t("Preview"),
                  },
                  { value: "raw", label: t("Source") },
                ]}
              />
            ) : null}
            {changesAvailable ? (
              <Button
                aria-pressed={showingChanges}
                title={
                  showingChanges ? t("Show file preview") : t("Show changes")
                }
                onClick={() =>
                  setDetailTab(showingChanges ? "file" : "changes")
                }
              >
                {t("Changes")}
              </Button>
            ) : null}
          </div>
        </div>
        {entry ? <span>{entry.path}</span> : null}
      </div>

      {!showingChanges && editing && draft ? (
        <div
          className="file-preview-file-content file-editor-shell"
          role="region"
          aria-label={t("Editing {name}", { name: entry?.name ?? previewPath })}
        >
          <div className="ui-bar file-editor-bar">
            <span className="ui-bar-title">{t("Editing")}</span>
            <Token tone={dirty ? "warning" : "neutral"}>
              {saving ? t("Saving") : dirty ? t("Unsaved") : t("Saved")}
            </Token>
            <span className="ui-bar-spacer" />
            <Button
              variant="primary"
              disabled={!dirty || saving}
              title={t("Save (Ctrl+S / Cmd+S)")}
              onClick={() => void saveDraft()}
            >
              <Save size={13} aria-hidden="true" />
              {t("Save")}
            </Button>
            <Button
              disabled={!dirty || saving}
              title={t("Revert to the last loaded or saved content")}
              onClick={revertDraft}
            >
              <RotateCcw size={13} aria-hidden="true" />
              {t("Revert")}
            </Button>
            <CloseButton
              label={t("Close editor")}
              tooltip={t("Close editor")}
              onClick={stopEditing}
            />
          </div>
          {saveConflict ? (
            <div className="file-editor-conflict" role="alert">
              {saveConflict}.
              <span className="file-editor-conflict-actions">
                <Button variant="secondary" onClick={reloadAfterConflict}>
                  {t("Reload")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={saving}
                  onClick={() => void saveDraft(true)}
                >
                  {t("Overwrite")}
                </Button>
              </span>
            </div>
          ) : null}
          <Suspense
            fallback={
              <div className="file-editor-loading">{t("Loading editor")}</div>
            }
          >
            <FileEditor
              path={previewPath}
              value={draft.text}
              theme={theme}
              onChange={(text) => {
                const current = editorDrafts.get(draftKey);
                if (!current || current.text === text) return;
                const wasDirty = current.text !== current.base;
                editorDrafts.set(draftKey, { ...current, text });
                if (wasDirty !== (text !== current.base))
                  setDraftRevision((revision) => revision + 1);
              }}
              onSave={() => void saveDraft()}
            />
          </Suspense>
        </div>
      ) : showingChanges ? (
        <div
          className="file-preview-changes"
          role="region"
          aria-label={
            entry?.name
              ? t("Changes for {name}", { name: entry.name })
              : t("Changes for selected file")
          }
        >
          {changesContent}
        </div>
      ) : (
        <div
          ref={previewContentRef}
          className="file-preview-file-content"
          role="region"
          aria-label={
            entry?.name
              ? t("Preview of {name}", { name: entry.name })
              : t("Preview of selected file")
          }
        >
          {!entry ? (
            <div className="file-preview-state">
              {t("Select a text file to preview.")}
            </div>
          ) : null}
          {loading ? (
            <div className="file-preview-state">
              <span className="file-loading-spinner" />
              {t("Loading preview")}
            </div>
          ) : null}
          {error ? (
            <div className="file-preview-state is-error">{error}</div>
          ) : null}
          {!loading && !error && directoryPath ? (
            <div className="file-preview-state">
              {t("Directories cannot be previewed.")}
            </div>
          ) : null}
          {!loading && !error && preview?.image_data_url ? (
            <ImagePreview
              key={previewPath}
              src={preview.image_data_url}
              name={entry?.name ?? preview.path}
            />
          ) : null}
          {!loading &&
          !error &&
          hasPdfPreview &&
          !pdfTooLarge &&
          inlinePreviewUrl ? (
            <Suspense
              fallback={
                <div className="file-preview-state">{t("Loading preview")}</div>
              }
            >
              <PdfPreview
                url={inlinePreviewUrl}
                name={entry?.name ?? previewPath}
              />
            </Suspense>
          ) : null}
          {!loading && !error && pdfTooLarge ? (
            <div className="file-preview-state">
              {t(
                "PDF is too large to preview. Use Download to open the original file.",
              )}
            </div>
          ) : null}
          {!loading &&
          !error &&
          preview?.binary &&
          !preview.image_data_url &&
          !hasPdfPreview ? (
            <div className="file-preview-state">
              {t("Binary file cannot be previewed.")}
            </div>
          ) : null}
          {!loading && !error && hasHtmlPreview && renderRichPreview ? (
            htmlTooLarge ? (
              <div className="file-preview-state">
                {t(
                  "HTML is too large to render. Use Source or Download from the file menu.",
                )}
              </div>
            ) : inlinePreviewUrl ? (
              <>
                <div className="file-preview-banner">
                  {t(
                    "Static HTML preview. Scripts are blocked; HTTPS stylesheets can access the network.",
                  )}
                </div>
                <iframe
                  key={inlinePreviewUrl}
                  className="file-preview-html"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  src={inlinePreviewUrl}
                  aria-label={t("HTML preview: {name}", {
                    name: entry?.name ?? previewPath,
                  })}
                />
              </>
            ) : null
          ) : null}
          {!loading &&
          !error &&
          preview?.truncated &&
          !hasPdfPreview &&
          !(hasHtmlPreview && renderRichPreview) ? (
            <div className="file-preview-banner">
              {t("Preview truncated at 512 KB.")}
            </div>
          ) : null}
          {!loading && !error && hasMarkdownPreview && renderRichPreview ? (
            <MarkdownPreview
              text={previewText}
              imageUrlResolver={markdownImageUrlResolver}
              documentPath={onOpenFile ? markdownDocumentPath : undefined}
              linkUrlResolver={markdownLinkUrlResolver}
              fragment={fragment}
              onOpenDocument={onOpenFile}
            />
          ) : null}
          {!loading && !error && hasMermaidPreview && renderRichPreview ? (
            <MermaidDiagram
              key={previewPath}
              code={previewText}
              className="file-preview-mermaid"
            />
          ) : null}
          {!loading &&
          !error &&
          hasPreviewText &&
          !renderRichPreview &&
          !hasPdfPreview ? (
            <CodePreview
              text={previewText}
              language={syntaxLanguageForPath(previewPath)}
              handle={codePreviewRef}
            />
          ) : null}
        </div>
      )}
      <CreateWorkspaceDialog
        open={workspaceDialogOpen}
        initialName={directoryWorkspaceName}
        initialCwd={directoryPath ?? ""}
        onClose={() => setWorkspaceDialogOpen(false)}
      />
    </section>
  );
}
