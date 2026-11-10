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
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import type { WorkspaceInspector } from "../app/useWorkspaceInspector";
import { getLocale, t } from "../i18n";
import { shortcutTitle } from "../shortcutPreferences";
import { store, useStoreSelector } from "../store";
import { selectPanesWithoutActivity } from "../agentOrder";
import type { Pane, Workspace } from "../types";
import {
  readInspectorPreferences,
  type InspectorFileRequest,
  type InspectorDock,
  type WorkspaceInspectorState,
} from "../workspaceResource";
import { editorUrl, editorWorkbench, openInEditor } from "./vscodeEditor";
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

const EDITOR_LOCALE_KEY = "thyra.vscodeLocale";

/**
 * VS Code shows Thyra's language: whenever Thyra's language differs from
 * the one last handed to VS Code, set VS Code's locale cookie and storage
 * (its server picks the translation file from the cookie). In between, a
 * language chosen inside VS Code stays.
 */
function syncEditorLocale(thyraLocale: ReturnType<typeof getLocale>) {
  const locale = thyraLocale === "zh-CN" ? "zh-cn" : "en";
  try {
    if (localStorage.getItem(EDITOR_LOCALE_KEY) === locale) return;
    localStorage.setItem(EDITOR_LOCALE_KEY, locale);
    localStorage.setItem("vscode.nls.locale", locale);
    // biome-ignore lint/suspicious/noDocumentCookie: VS Code reads this cookie.
    document.cookie = `vscode.nls.locale=${locale};path=/;max-age=3153600000`;
  } catch {
    /* Storage disabled: VS Code follows the browser language. */
  }
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

/**
 * One live VS Code per folder, the most recent first. A file request opens
 * in the folder's running editor, and reloads that editor with the file only
 * when it cannot take the request.
 */
function useEditorFrames(folder: string, file?: InspectorFileRequest) {
  const [frames, setFrames] = useState<{ folder: string; src: string }[]>([]);
  const elements = useRef(new Map<string, HTMLIFrameElement>());
  const fileNonce = useRef(0);
  useLayoutEffect(() => {
    if (!folder) return;
    const fresh = !!file && file.nonce !== fileNonce.current;
    if (file) fileNonce.current = file.nonce;
    const show = (load: boolean) =>
      setFrames((current) => {
        const existing = current.find((frame) => frame.folder === folder);
        if (existing && !load && current[0] === existing) return current;
        const next = {
          folder,
          src:
            existing && !load
              ? existing.src
              : editorUrl(window.location.origin, folder, file),
        };
        return [
          next,
          ...current.filter((frame) => frame.folder !== folder),
        ].slice(0, MAX_EDITORS);
      });
    const workbench = fresh
      ? editorWorkbench(elements.current.get(folder))
      : null;
    if (!file || !workbench) return show(fresh);
    show(false);
    let current = true;
    void openInEditor(workbench, window.location.host, folder, file).then(
      (opened) => {
        if (!opened && current) show(true);
      },
    );
    return () => {
      current = false;
    };
  }, [folder, file]);
  const bind = (folder: string) => (element: HTMLIFrameElement | null) => {
    if (element) elements.current.set(folder, element);
    else elements.current.delete(folder);
  };
  // Moving an iframe in the document reloads it, so the editors render in a
  // fixed order whichever is the most recent.
  const ordered = useMemo(
    () =>
      [...frames].sort((a, b) =>
        a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0,
      ),
    [frames],
  );
  return { frames: ordered, bind };
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
  const panes = useStoreSelector(selectPanesWithoutActivity);
  // A pane's cwd moves with `cd`; the editor keeps the folder it opened.
  const roots = useRef(new Map<string, string>());
  const workspaceKey = workspace?.workspace_id ?? "";
  const root =
    roots.current.get(workspaceKey) || checkoutRoot(workspace, panes);
  useEffect(() => {
    if (root && workspaceKey) roots.current.set(workspaceKey, root);
  }, [root, workspaceKey]);
  const editorAvailable =
    !!root && !!editorConnections?.has(connectionClient.connectionId);
  const locale = getLocale();
  // A layout effect declared before the frames' own: the cookie has to be
  // in place before an editor iframe requests its page.
  useLayoutEffect(() => {
    if (editorAvailable) syncEditorLocale(locale);
  }, [editorAvailable, locale]);
  const { frames, bind } = useEditorFrames(
    editorAvailable ? root : "",
    state.file,
  );

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
              onClick={() =>
                window.open(
                  editorUrl(window.location.origin, root),
                  "_blank",
                  "noopener",
                )
              }
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
              ref={bind(frame.folder)}
              className={`workspace-inspector-editor ${
                frame.folder === root ? "" : "is-hidden"
              }`}
              title={t("VS Code")}
              src={frame.src}
              // A kept-alive editor takes no focus, keys or pointer.
              inert={frame.folder !== root}
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
