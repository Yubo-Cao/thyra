import {
  ExternalLink,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  Upload,
} from "lucide-react";
import {
  useCallback,
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
  relativePathWithinCheckout,
  type InspectorFileRequest,
  type InspectorDock,
  type WorkspaceInspectorState,
} from "../workspaceResource";
import {
  editorHasTextFile,
  editorUrl,
  editorWorkbench,
  openInEditor,
} from "./vscodeEditor";
import { previewKind, previewName } from "./inspectorPreviewModel";
import { WorkspaceInspectorPreview } from "./WorkspaceInspectorPreview";
import type { PreviewTarget } from "./useInspectorPreview";
import { isFilesystemPath, uploadWorkspaceFile } from "./workspaceFiles";
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

type EditorFrame = { folder: string; src: string; file?: InspectorFileRequest };

/** Keep the most recently used folders alive in a fixed DOM order. */
function useEditorFrames(
  folder: string,
  file: InspectorFileRequest | undefined,
  verifyText: boolean,
) {
  const [frames, setFrames] = useState<EditorFrame[]>([]);
  const elements = useRef(new Map<string, HTMLIFrameElement>());
  const [opened, setOpened] = useState<{
    folder: string;
    file?: InspectorFileRequest;
  }>();
  const [failed, setFailed] = useState<InspectorFileRequest>();
  const activeFrame = frames.find((frame) => frame.folder === folder);
  useLayoutEffect(() => {
    if (!folder) return;
    setFrames((current) => {
      if (current[0]?.folder === folder) return current;
      const existing = current.find((frame) => frame.folder === folder);
      return [
        existing ?? {
          folder,
          file,
          src: editorUrl(window.location.origin, folder, file),
        },
        ...current.filter((frame) => frame.folder !== folder),
      ].slice(0, MAX_EDITORS);
    });
  }, [folder, file]);

  useEffect(() => {
    if (!activeFrame) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    let requested = activeFrame.file === file;
    const until = Date.now() + 30_000;
    const wait = async () => {
      const element = elements.current.get(activeFrame.folder);
      const workbench = editorWorkbench(element);
      if (workbench && !requested && file) {
        // The embedder API exists before the remote filesystem provider.
        await workbench.env?.retrievePerformanceMarks().catch(() => undefined);
        if (!current) return;
        requested = await openInEditor(
          workbench,
          window.location.host,
          folder,
          file,
        );
        if (!current) return;
        if (!requested) {
          setFrames((frames) =>
            frames.map((frame) =>
              frame === activeFrame
                ? {
                    folder,
                    file,
                    src: editorUrl(window.location.origin, folder, file),
                  }
                : frame,
            ),
          );
          return;
        }
      }
      const document = workbench && element?.contentDocument;
      const hasFile =
        file &&
        (verifyText
          ? editorHasTextFile(document, window.location.host, folder, file)
          : document &&
            Array.from(
              document.querySelectorAll(
                ".tabs-container .tab.active[data-resource-name]",
              ),
            ).some(
              (tab) =>
                tab.getAttribute("data-resource-name") ===
                previewName(file.path),
            ));
      if (
        workbench &&
        (!file ||
          (hasFile &&
            !document?.querySelector(
              ".editor-instance .editor-placeholder-icon-container .codicon-error",
            )))
      ) {
        setFailed(undefined);
        setOpened({ folder, file });
      } else if (Date.now() >= until) {
        setFailed(file);
      } else {
        timer = setTimeout(wait, 50);
      }
    };
    void wait();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [activeFrame, folder, file, verifyText]);
  const bind = (folder: string) => (element: HTMLIFrameElement | null) => {
    if (element) elements.current.set(folder, element);
    else elements.current.delete(folder);
  };
  const ordered = useMemo(
    () =>
      [...frames].sort((a, b) =>
        a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0,
      ),
    [frames],
  );
  return {
    frames: ordered,
    bind,
    ready: opened?.folder === folder && opened.file === file,
    failed: !!failed && failed === file,
  };
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
  const initialTarget = useMemo<PreviewTarget>(() => {
    if (!state.file) return { path: "", directory: true, nonce: 0 };
    const path = state.file.path.replace(/\\/g, "/");
    const relative = relativePathWithinCheckout(root, path);
    const normalized =
      relative ?? path.replace(/^\.\//, "").replace(/(?!^)\/+$/, "");
    return {
      ...state.file,
      path: normalized,
      directory: !normalized || undefined,
    };
  }, [state.file, root]);
  const [selection, setSelection] = useState<{
    source: PreviewTarget;
    workspace: string;
    target: PreviewTarget;
  }>();
  const selected =
    selection?.source === initialTarget && selection.workspace === workspaceKey;
  const target = selected ? selection.target : initialTarget;
  const nextNonce = useRef(0);
  const [choice, setChoice] = useState<{
    target: PreviewTarget;
    editor: boolean;
  }>();
  const [prepared, setPrepared] = useState<{
    target: PreviewTarget;
    kind: "text" | "folder" | "other";
  }>();
  const onPreviewReady = useCallback(
    (target: PreviewTarget, kind: "text" | "folder" | "other") => {
      setPrepared((current) =>
        current?.target === target && current.kind === kind
          ? current
          : { target, kind },
      );
    },
    [],
  );
  const previewType = prepared?.target === target ? prepared.kind : undefined;
  const folderTarget = target.directory || previewType === "folder";
  const explicit = choice?.target === target ? choice.editor : undefined;
  const wantsEditor =
    explicit ?? (!selected && !!state.file && previewType === "text");
  const editorFolder =
    folderTarget && target.path
      ? isFilesystemPath(target.path)
        ? target.path
        : `${root.replace(/\/+$/, "")}/${target.path}`
      : root;
  const editorFile =
    wantsEditor && !folderTarget && target.path ? target : undefined;
  // Do not compete with the first text RPC or the native paint for a cold iframe.
  const startingText =
    state.open &&
    state.file &&
    !selected &&
    !target.directory &&
    previewKind(target.path) === "text" &&
    !previewType &&
    explicit !== true;
  const { frames, bind, ready, failed } = useEditorFrames(
    editorAvailable && !startingText ? editorFolder : "",
    editorFile,
    previewType === "text",
  );
  const showEditor = editorAvailable && wantsEditor && ready;
  const selectPreview = (
    path: string,
    directory?: boolean,
    fragment?: string,
  ) => {
    setSelection({
      source: initialTarget,
      workspace: workspaceKey,
      target: { path, directory, fragment, nonce: --nextNonce.current },
    });
  };

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
            <Button
              variant="secondary"
              onClick={() => setChoice({ target, editor: !wantsEditor })}
            >
              {showEditor || failed ? (
                t("Back to preview")
              ) : wantsEditor && !failed ? (
                <>
                  <Spinner size="sm" />
                  {t("Opening the editor")}
                </>
              ) : (
                t("Open in VS Code")
              )}
            </Button>
          ) : null}
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
      ) : (
        <div className="workspace-inspector-body">
          <WorkspaceInspectorPreview
            key={workspaceKey}
            client={connectionClient}
            workspaceId={workspace.workspace_id}
            target={target}
            active={state.open}
            hidden={showEditor}
            onSelect={selectPreview}
            onReady={onPreviewReady}
          />
          {frames.map((frame) => (
            <iframe
              key={frame.folder}
              ref={bind(frame.folder)}
              className={`workspace-inspector-editor ${frame.folder === editorFolder && showEditor ? "" : "is-hidden"}`}
              title={t("VS Code")}
              src={frame.src}
              inert={frame.folder !== editorFolder || !showEditor}
              allow="clipboard-read; clipboard-write"
            />
          ))}
        </div>
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
