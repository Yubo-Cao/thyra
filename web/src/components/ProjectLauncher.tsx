import { Drawer, Input, Spinner, TextField } from "@heroui/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderSearch,
  Pin,
  PinOff,
  Settings2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { store } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { basename } from "../utils";
import { AgentIcon } from "./AgentIcon";
import {
  type LauncherAgent,
  ProjectLauncherSettings,
} from "./ProjectLauncherSettings";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Token } from "./ui/Token";
import "./ProjectLauncher.css";

type LauncherFolder = {
  path: string;
  display: string;
  sources: string[];
  missing?: boolean;
  workspace?: { workspace_id: string; label: string };
};

type LauncherData = {
  home: string;
  zoxide: boolean;
  agents: LauncherAgent[];
  pinned: LauncherFolder[];
  recent: LauncherFolder[];
};

type BrowseListing = {
  path: string;
  display: string;
  parent: string | null;
  truncated: boolean;
  entries: Array<{ name: string; path: string }>;
  workspace?: LauncherFolder["workspace"];
};

type View = "folders" | "browse" | "settings";

function parentDisplay(display: string) {
  const index = display.lastIndexOf("/");
  if (index <= 0) return display === "~" ? "" : display.slice(0, index + 1);
  return display.slice(0, index);
}

function looksLikePath(value: string) {
  return value.startsWith("/") || value === "~" || value.startsWith("~/");
}

/**
 * Pick a frequent folder and start Claude or Codex there in a new tab.
 * Folder sources, pins, and commands live on the Thyra server per connection.
 */
export function ProjectLauncher({
  onClose,
  onLaunched,
}: {
  onClose: () => void;
  onLaunched?: () => void;
}) {
  const client = useConnectionClient();
  const mobile =
    typeof document !== "undefined" &&
    document.documentElement.dataset.layout === "mobile";
  const [data, setData] = useState<LauncherData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("folders");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editingPins, setEditingPins] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [browse, setBrowse] = useState<BrowseListing | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const mounted = useRef(true);
  const loadSequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const live = useCallback(
    () => mounted.current && client.isCurrent(),
    [client],
  );

  const load = useCallback(async () => {
    const request = ++loadSequence.current;
    try {
      const result: LauncherData = await client.call("launcher.get");
      if (!live() || request !== loadSequence.current) return;
      setData(result);
      setLoadError(null);
    } catch (reason) {
      if (live() && request === loadSequence.current)
        setLoadError((reason as Error).message);
    }
  }, [client, live]);

  useEffect(() => {
    void load();
  }, [load]);

  const openBrowse = useCallback(
    async (path?: string) => {
      setView("browse");
      setBrowseError(null);
      try {
        const result: BrowseListing = await client.call("launcher.browse", {
          path: path ?? "~",
        });
        if (!live()) return;
        setBrowse(result);
      } catch (reason) {
        if (live()) setBrowseError((reason as Error).message);
      }
    },
    [client, live],
  );

  const pinnedPaths = data?.pinned.map((folder) => folder.path) ?? [];

  const savePins = async (pinned: string[]) => {
    if (busy) return;
    setBusy("pins");
    setError(null);
    try {
      await client.call("launcher.pins.set", { pinned });
      if (live()) await load();
    } catch (reason) {
      if (live()) setError((reason as Error).message);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const togglePin = (path: string) =>
    savePins(
      pinnedPaths.includes(path)
        ? pinnedPaths.filter((entry) => entry !== path)
        : [...pinnedPaths, path],
    );

  const movePin = (index: number, offset: number) => {
    const next = [...pinnedPaths];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void savePins(next);
  };

  const launch = async (path: string, agent: LauncherAgent) => {
    if (busy) return;
    setBusy(`launch:${agent.id}`);
    setError(null);
    try {
      const result: { pane_id: string; start_error?: string } =
        await client.call("launcher.launch", { path, agent: agent.id });
      if (!client.isCurrent()) return;
      await store.refresh();
      await store.focusPane(result.pane_id);
      if (result.start_error)
        store.notify({
          kind: "error",
          message: t("Tab opened, but the agent did not start"),
          detail: result.start_error,
        });
      onLaunched?.();
      onClose();
    } catch (reason) {
      if (live()) setError((reason as Error).message);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const matches = useCallback(
    (folder: LauncherFolder) =>
      !needle ||
      folder.display.toLowerCase().includes(needle) ||
      folder.path.toLowerCase().includes(needle),
    [needle],
  );
  const pinned = useMemo(
    () => data?.pinned.filter(matches) ?? [],
    [data, matches],
  );
  const recent = useMemo(
    () => data?.recent.filter(matches) ?? [],
    [data, matches],
  );
  const typedPath = looksLikePath(query.trim()) ? query.trim() : null;

  const agentChoice = (
    path: string,
    workspace?: LauncherFolder["workspace"],
  ) => (
    <div className="project-launcher-agents">
      <div className="project-launcher-agent-buttons">
        {data?.agents.map((agent) => (
          <Button
            key={agent.id}
            variant="primary"
            className="project-launcher-agent"
            disabled={busy !== null}
            aria-label={t("Start {agent} in {folder}", {
              agent: agent.label,
              folder: basename(path) || path,
            })}
            onClick={() => void launch(path, agent)}
          >
            {busy === `launch:${agent.id}` ? (
              <Spinner size="sm" color="current" />
            ) : (
              <AgentIcon agent={agent.id} />
            )}
            <span>{agent.label}</span>
            <code>{agent.command}</code>
          </Button>
        ))}
      </div>
      <p className="project-launcher-note">
        {workspace
          ? t("Opens a new tab in workspace {name}.", { name: workspace.label })
          : t("Opens a new workspace in this folder.")}
      </p>
    </div>
  );

  const folderRow = (folder: LauncherFolder, index: number, isPin: boolean) => {
    const isSelected = selected === folder.path;
    const name = basename(folder.path) || folder.path;
    return (
      <li
        key={folder.path}
        className="project-launcher-item"
        data-selected={isSelected || undefined}
      >
        <div className="project-launcher-row">
          <button
            type="button"
            className="project-launcher-folder"
            aria-expanded={isSelected}
            disabled={folder.missing}
            onClick={() => setSelected(isSelected ? null : folder.path)}
          >
            <Folder size={16} aria-hidden="true" />
            <span className="project-launcher-folder-text">
              <strong>{name}</strong>
              <span>{parentDisplay(folder.display)}</span>
            </span>
            {folder.missing ? (
              <Token tone="warning">{t("Missing")}</Token>
            ) : folder.workspace ? (
              <Token>{folder.workspace.label}</Token>
            ) : null}
          </button>
          {isPin && editingPins ? (
            <>
              <IconButton
                label={t("Move up")}
                icon={<ArrowUp size={15} />}
                disabled={busy !== null || index === 0}
                onClick={() => movePin(index, -1)}
              />
              <IconButton
                label={t("Move down")}
                icon={<ArrowDown size={15} />}
                disabled={busy !== null || index === pinnedPaths.length - 1}
                onClick={() => movePin(index, 1)}
              />
              <IconButton
                label={t("Unpin {name}", { name })}
                icon={<X size={15} />}
                tone="danger"
                disabled={busy !== null}
                onClick={() => void togglePin(folder.path)}
              />
            </>
          ) : (
            <IconButton
              label={
                isPin ? t("Unpin {name}", { name }) : t("Pin {name}", { name })
              }
              icon={isPin ? <PinOff size={15} /> : <Pin size={15} />}
              disabled={busy !== null}
              onClick={() => void togglePin(folder.path)}
            />
          )}
        </div>
        {isSelected ? agentChoice(folder.path, folder.workspace) : null}
      </li>
    );
  };

  const header = (
    <div className="project-launcher-head ui-bar">
      {view !== "folders" ? (
        <IconButton
          label={t("Back")}
          icon={<ArrowLeft size={16} />}
          onClick={() => setView("folders")}
        />
      ) : null}
      <Drawer.Heading className="project-launcher-title">
        {view === "settings"
          ? t("Launcher settings")
          : view === "browse"
            ? t("Choose folder")
            : t("Launch agent")}
      </Drawer.Heading>
      {view === "folders" ? (
        <IconButton
          label={t("Launcher settings")}
          icon={<Settings2 size={16} />}
          onClick={() => setView("settings")}
        />
      ) : null}
      <IconButton
        label={t("Close launcher")}
        icon={<X size={16} />}
        onClick={onClose}
      />
    </div>
  );

  const foldersView = (
    <>
      <div className="project-launcher-search">
        <TextField
          aria-label={t("Filter folders or type a path")}
          className="project-launcher-query"
          value={query}
          onChange={setQuery}
        >
          <Input
            placeholder={t("Filter or type a path")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </TextField>
        <IconButton
          label={t("Browse folders")}
          icon={<FolderSearch size={16} />}
          onClick={() => void openBrowse(typedPath ?? undefined)}
        />
      </div>
      {error ? (
        <p className="project-launcher-error" role="alert">
          {error}
        </p>
      ) : null}
      {!data && !loadError ? (
        <div className="project-launcher-loading">
          <Spinner size="sm" color="current" />
          <span>{t("Loading folders...")}</span>
        </div>
      ) : null}
      {loadError ? (
        <div className="project-launcher-error" role="alert">
          <span>{loadError}</span>
          <Button variant="outline" onClick={() => void load()}>
            {t("Retry")}
          </Button>
        </div>
      ) : null}
      {typedPath ? (
        <ul className="project-launcher-list">
          <li
            className="project-launcher-item"
            data-selected={selected === typedPath || undefined}
          >
            <div className="project-launcher-row">
              <button
                type="button"
                className="project-launcher-folder"
                aria-expanded={selected === typedPath}
                onClick={() =>
                  setSelected(selected === typedPath ? null : typedPath)
                }
              >
                <ChevronRight size={16} aria-hidden="true" />
                <span className="project-launcher-folder-text">
                  <strong>{t("Use this path")}</strong>
                  <span>{typedPath}</span>
                </span>
              </button>
            </div>
            {selected === typedPath ? agentChoice(typedPath) : null}
          </li>
        </ul>
      ) : null}
      {data ? (
        <>
          <div className="project-launcher-section">
            <h3>{t("Pinned")}</h3>
            {data.pinned.length > 0 ? (
              <Button
                aria-pressed={editingPins}
                onClick={() => setEditingPins((value) => !value)}
              >
                {editingPins ? t("Done") : t("Edit")}
              </Button>
            ) : null}
          </div>
          {pinned.length ? (
            <ul className="project-launcher-list">
              {pinned.map((folder) =>
                folderRow(folder, data.pinned.indexOf(folder), true),
              )}
            </ul>
          ) : (
            <p className="project-launcher-note">
              {needle
                ? t("No pinned folders match.")
                : t("Pin folders you start agents in often.")}
            </p>
          )}
          <div className="project-launcher-section">
            <h3>{t("Recent")}</h3>
          </div>
          {recent.length ? (
            <ul className="project-launcher-list">
              {recent.map((folder, index) => folderRow(folder, index, false))}
            </ul>
          ) : (
            <p className="project-launcher-note">
              {needle
                ? t("No recent folders match.")
                : t("Folders you open or launch in appear here.")}
            </p>
          )}
        </>
      ) : null}
    </>
  );

  const browseView = (
    <>
      <div className="project-launcher-browse-bar">
        <IconButton
          label={t("Parent folder")}
          icon={<ArrowUp size={16} />}
          disabled={!browse?.parent}
          onClick={() => void openBrowse(browse?.parent ?? undefined)}
        />
        <code className="project-launcher-browse-path">
          {browse?.display ?? "~"}
        </code>
      </div>
      {browseError ? (
        <p className="project-launcher-error" role="alert">
          {browseError}
        </p>
      ) : null}
      {error ? (
        <p className="project-launcher-error" role="alert">
          {error}
        </p>
      ) : null}
      {browse ? (
        <ul className="project-launcher-list project-launcher-browse-list">
          {browse.entries.map((entry) => (
            <li key={entry.path} className="project-launcher-item">
              <div className="project-launcher-row">
                <button
                  type="button"
                  className="project-launcher-folder"
                  onClick={() => void openBrowse(entry.path)}
                >
                  <Folder size={16} aria-hidden="true" />
                  <span className="project-launcher-folder-text">
                    <strong>{entry.name}</strong>
                  </span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
          {browse.entries.length === 0 ? (
            <li className="project-launcher-note">{t("No subfolders.")}</li>
          ) : null}
          {browse.truncated ? (
            <li className="project-launcher-note">
              {t("Only the first 500 folders are shown.")}
            </li>
          ) : null}
        </ul>
      ) : !browseError ? (
        <div className="project-launcher-loading">
          <Spinner size="sm" color="current" />
        </div>
      ) : null}
    </>
  );

  const browseFooter = browse ? (
    <div className="project-launcher-browse-footer">
      <div className="project-launcher-section">
        <h3>{basename(browse.path) || browse.path}</h3>
        <Button
          disabled={busy !== null}
          onClick={() => void togglePin(browse.path)}
        >
          {pinnedPaths.includes(browse.path) ? (
            <PinOff size={15} />
          ) : (
            <Pin size={15} />
          )}
          {pinnedPaths.includes(browse.path) ? t("Unpin") : t("Pin")}
        </Button>
      </div>
      {agentChoice(browse.path, browse.workspace)}
    </div>
  ) : null;

  return (
    <Drawer.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="project-launcher-backdrop"
    >
      <Drawer.Content placement={mobile ? "bottom" : "right"}>
        <Drawer.Dialog className="project-launcher" aria-busy={busy !== null}>
          {header}
          <Drawer.Body className="project-launcher-body">
            {view === "folders"
              ? foldersView
              : view === "browse"
                ? browseView
                : null}
            {view === "settings" ? (
              <ProjectLauncherSettings
                agents={data?.agents}
                onSaved={(agents) =>
                  setData((current) =>
                    current ? { ...current, agents } : current,
                  )
                }
              />
            ) : null}
          </Drawer.Body>
          {view === "browse" && browseFooter ? (
            <Drawer.Footer className="project-launcher-footer">
              {browseFooter}
            </Drawer.Footer>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
