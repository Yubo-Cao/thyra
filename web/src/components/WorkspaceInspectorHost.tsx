import {
  ExternalLink,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import type { WorkspaceInspector } from "../app/useWorkspaceInspector";
import { t } from "../i18n";
import { shortcutTitle } from "../shortcutPreferences";
import { store, useStoreSelector } from "../store";
import type { Pane, Workspace } from "../types";
import {
  readInspectorPreferences,
  type InspectorFileRequest,
  type InspectorDock,
  type WorkspaceInspectorState,
} from "../workspaceResource";
import { uploadWorkspaceFile } from "./workspaceFiles";
import { Button } from "./ui/Button";
import { CloseButton } from "./ui/CloseButton";
import { IconButton } from "./ui/IconButton";
import { Spinner } from "./ui/Spinner";
import "./WorkspaceInspectorHost.css";

/** Editors kept alive at once, so switching back to a workspace is instant. */
const MAX_EDITORS = 3;

let vscodeConnections: Promise<Set<string>> | null = null;
/** Connections whose files the host's VS Code can open (admins only). */
function loadVscodeConnections(): Promise<Set<string>> {
  vscodeConnections ??= fetch("/api/vscode", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { connections: [] }))
    .then(
      (body: { connections?: unknown }) =>
        new Set(
          Array.isArray(body.connections)
            ? body.connections.filter((id) => typeof id === "string")
            : [],
        ),
    )
    .catch(() => new Set<string>());
  return vscodeConnections;
}

/**
 * VS Code Web's zh-CN translations from Microsoft's CDN do not match the
 * workbench build and garble its labels, so the editor starts in English
 * unless its own language setting chose otherwise.
 */
function defaultEditorLocale() {
  try {
    if (localStorage.getItem("vscode.nls.locale")) return;
    localStorage.setItem("vscode.nls.locale", "en");
    // biome-ignore lint/suspicious/noDocumentCookie: VS Code reads this cookie.
    document.cookie = "vscode.nls.locale=en;path=/;max-age=3153600000";
  } catch {
    /* Storage disabled: VS Code follows the browser language. */
  }
}

function joinPath(root: string, path: string) {
  if (path.startsWith("/")) return path;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.?\//, "")}`;
}

function editorUrl(folder: string, file?: InspectorFileRequest) {
  const url = new URL("/vscode/", window.location.origin);
  url.searchParams.set("folder", folder);
  if (file) {
    const target = `vscode-remote://${window.location.host}${joinPath(folder, file.path)}`;
    url.searchParams.set(
      "payload",
      JSON.stringify([
        ["openFile", file.line ? `${target}:${file.line}` : target],
        ...(file.line ? [["gotoLineMode", "true"]] : []),
      ]),
    );
  }
  return `${url.pathname}${url.search}`;
}

/** The checkout, else the workspace's directory, else its focused pane's. */
function checkoutRoot(workspace: Workspace | undefined, panes: Pane[]) {
  if (!workspace) return "";
  if (workspace.worktree?.checkout_path)
    return workspace.worktree.checkout_path;
  if (workspace.cwd) return workspace.cwd;
  const own = panes.filter(
    (pane) => pane.workspace_id === workspace.workspace_id,
  );
  const pane = own.find((candidate) => candidate.focused) ?? own[0];
  return pane?.cwd ?? "";
}

function checkoutLabel(workspace?: Workspace) {
  if (!workspace) return t("Unavailable checkout");
  return (
    workspace.worktree?.git_status?.branch ||
    workspace.worktree?.repo_name ||
    workspace.label ||
    workspace.workspace_id
  );
}

/** One live VS Code per folder, the most recent first. */
function useEditorFrames(folder: string, file?: InspectorFileRequest) {
  const [frames, setFrames] = useState<{ folder: string; src: string }[]>([]);
  const fileNonce = useRef(0);
  useLayoutEffect(() => {
    if (!folder) return;
    const fresh = !!file && file.nonce !== fileNonce.current;
    if (file) fileNonce.current = file.nonce;
    setFrames((current) => {
      const existing = current.find((frame) => frame.folder === folder);
      if (existing && !fresh && current[0] === existing) return current;
      const next = {
        folder,
        // A new file request reloads that folder's editor with it open.
        src: existing && !fresh ? existing.src : editorUrl(folder, file),
      };
      return [
        next,
        ...current.filter((frame) => frame.folder !== folder),
      ].slice(0, MAX_EDITORS);
    });
  }, [folder, file]);
  return frames;
}

function UploadPanel({
  uploading,
  root,
  onChoose,
}: {
  uploading: boolean;
  root: string;
  onChoose: () => void;
}) {
  return (
    <div className="workspace-inspector-upload">
      <strong>{t("Upload files")}</strong>
      <span>
        {t("Drop files here or choose them to copy into the workspace.")}
      </span>
      {root ? <code>{root}</code> : null}
      <Button variant="secondary" disabled={uploading} onClick={onChoose}>
        {uploading ? <Spinner size="sm" /> : <Upload size={14} />}
        {t("Choose files")}
      </Button>
    </div>
  );
}

export function WorkspaceInspectorHost({
  state,
  workspace,
  connectionClient,
  onDockChange,
  onExpandedChange,
  onClose,
}: {
  state: WorkspaceInspectorState;
  workspace?: Workspace;
  connectionClient: ConnectionClient;
  onDockChange: (dock: InspectorDock) => void;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
}) {
  const [editorConnections, setEditorConnections] =
    useState<Set<string> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    let current = true;
    void loadVscodeConnections().then((ids) => {
      if (current) setEditorConnections(ids);
    });
    return () => {
      current = false;
    };
  }, []);
  const panes = useStoreSelector((current) => current.panes);
  // A pane's cwd moves with `cd`; the editor keeps the folder it opened.
  const roots = useRef(new Map<string, string>());
  const workspaceKey = workspace?.workspace_id ?? "";
  const root =
    roots.current.get(workspaceKey) || checkoutRoot(workspace, panes);
  if (root && workspaceKey) roots.current.set(workspaceKey, root);
  const editorAvailable =
    !!root && !!editorConnections?.has(connectionClient.connectionId);
  if (editorAvailable) defaultEditorLocale();
  const frames = useEditorFrames(editorAvailable ? root : "", state.file);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!workspace || !list.length || uploading) return;
    setUploading(true);
    try {
      for (const file of list)
        await uploadWorkspaceFile(
          connectionClient,
          workspace.workspace_id,
          "",
          file,
        );
      store.notify({
        kind: "success",
        message: list.length === 1 ? t("File uploaded") : t("Files uploaded"),
        detail: root || undefined,
      });
    } catch (error) {
      store.notify({
        kind: "error",
        message: t("Upload failed"),
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUploading(false);
    }
  };
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget === event.target) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      setDragging(false);
      void upload(event.dataTransfer.files);
    },
  };

  return (
    <aside
      className={`workspace-inspector ${dragging ? "is-dropping" : ""}`}
      aria-label={t("Workspace Inspector")}
      {...dropProps}
    >
      <header className="workspace-inspector-head">
        <div className="workspace-inspector-identity">
          <span className="workspace-inspector-checkout">
            {checkoutLabel(workspace)}
          </span>
          {root ? (
            <code className="workspace-inspector-path" title={root}>
              {root}
            </code>
          ) : null}
        </div>
        <div className="workspace-inspector-actions">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const input = event.currentTarget;
              if (input.files) void upload(input.files);
              input.value = "";
            }}
          />
          <IconButton
            label={t("Upload files")}
            icon={uploading ? <Spinner size="sm" /> : <Upload size={15} />}
            disabled={!workspace || uploading}
            onClick={() => fileInput.current?.click()}
          />
          {editorAvailable ? (
            <IconButton
              label={t("Open VS Code in a new tab")}
              icon={<ExternalLink size={15} />}
              onClick={() => window.open(editorUrl(root), "_blank", "noopener")}
            />
          ) : null}
          <IconButton
            label={
              state.dock === "right"
                ? t("Dock Inspector at bottom")
                : t("Dock Inspector at right")
            }
            tooltip={
              state.dock === "right" ? t("Dock at bottom") : t("Dock at right")
            }
            icon={
              state.dock === "right" ? (
                <PanelBottom size={15} />
              ) : (
                <PanelRight size={15} />
              )
            }
            onClick={() =>
              onDockChange(state.dock === "right" ? "bottom" : "right")
            }
          />
          <IconButton
            label={
              state.expanded
                ? t("Restore Inspector dock")
                : t("Expand Inspector")
            }
            tooltip={shortcutTitle(
              state.expanded
                ? t("Restore Inspector dock")
                : t("Expand Inspector"),
              "inspector.expand",
            )}
            icon={
              state.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />
            }
            aria-pressed={state.expanded}
            onClick={() => onExpandedChange(!state.expanded)}
          />
          <CloseButton
            label={t("Close Workspace Inspector")}
            tooltip={t("Close Inspector")}
            onClick={onClose}
          />
        </div>
      </header>
      {!workspace ? (
        <div className="workspace-inspector-unavailable">
          <strong>{t("Checkout unavailable")}</strong>
          <span>
            {t("The workspace used to route this Inspector is no longer open.")}
          </span>
        </div>
      ) : editorConnections === null ? (
        <div className="workspace-inspector-unavailable">
          <Spinner />
        </div>
      ) : editorAvailable ? (
        <div className="workspace-inspector-body">
          {frames.map((frame) => (
            <iframe
              key={frame.folder}
              className={`workspace-inspector-editor ${
                frame.folder === root ? "" : "is-hidden"
              }`}
              title={t("VS Code")}
              src={frame.src}
              allow="clipboard-read; clipboard-write"
            />
          ))}
        </div>
      ) : (
        <UploadPanel
          uploading={uploading}
          root={root}
          onChoose={() => fileInput.current?.click()}
        />
      )}
    </aside>
  );
}

/** The host bound to the app's inspector controller. */
export function WorkspaceInspectorPanel({
  inspector,
  state,
  connectionClient,
}: {
  inspector: WorkspaceInspector;
  state: WorkspaceInspectorState;
  connectionClient: ConnectionClient;
}) {
  const { stateRef, commitAndSave } = inspector;
  return (
    <WorkspaceInspectorHost
      state={state}
      workspace={inspector.workspace}
      connectionClient={connectionClient}
      onDockChange={(dock) => {
        const current = stateRef.current;
        if (!current || current.dock === dock) return;
        const preferences = readInspectorPreferences(
          thyraLocalStorage,
          current.scope,
        );
        commitAndSave({
          ...current,
          dock,
          size:
            dock === "right" ? preferences.rightSize : preferences.bottomSize,
          expanded: false,
        });
      }}
      onExpandedChange={inspector.setExpanded}
      onClose={inspector.close}
    />
  );
}
