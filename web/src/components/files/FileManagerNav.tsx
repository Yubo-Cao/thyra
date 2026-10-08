import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Folder,
  LocateFixed,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  filesystemBaseName,
  filesystemBreadcrumbs,
  normalizeFilesystemPath,
} from "../../filesystemPaths";
import { t } from "../../i18n";
import { useStoreSelector } from "../../store";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { TextField } from "../ui/TextField";
import { Token } from "../ui/Token";

type Crumb = { label: string; path: string; collapsed?: boolean };

export function locationCrumbs(
  location: string,
  filesystem: boolean,
  rootLabel: string,
): Crumb[] {
  if (filesystem) return filesystemBreadcrumbs(location);
  return [
    { label: rootLabel || t("Workspace"), path: "" },
    ...location
      .split("/")
      .filter(Boolean)
      .map((part, index, parts) => ({
        label: part,
        path: parts.slice(0, index + 1).join("/"),
      })),
  ];
}

/**
 * Back/forward/up, the breadcrumbs (a path editor in filesystem scope) and,
 * for the filesystem, quick locations as tokens.
 */
export function FileManagerNav({
  workspaceId,
  filesystem,
  location,
  rootPath,
  rootLabel,
  canBack,
  canForward,
  atRoot,
  loading,
  canReveal,
  onBack,
  onForward,
  onUp,
  onNavigate,
  onRefresh,
  onReveal,
}: {
  workspaceId: string;
  filesystem: boolean;
  location: string;
  rootPath: string;
  rootLabel: string;
  canBack: boolean;
  canForward: boolean;
  atRoot: boolean;
  loading: boolean;
  canReveal: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onReveal: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const crumbs = locationCrumbs(location, filesystem, rootLabel);
  // Keep the root and the deepest three segments; the middle collapses.
  const visible: Crumb[] =
    crumbs.length > 5
      ? [
          crumbs[0]!,
          {
            label: "...",
            path: crumbs[crumbs.length - 4]!.path,
            collapsed: true,
          },
          ...crumbs.slice(-3),
        ]
      : crumbs;
  const editPath = () => {
    if (filesystem) setDraft(location);
  };

  const paneCwds = useStoreSelector((state) =>
    filesystem
      ? state.panes
          .filter((pane) => pane.workspace_id === workspaceId)
          .map((pane) => pane.foreground_cwd ?? pane.cwd ?? "")
          .filter(Boolean)
          .join("\n")
      : "",
  );
  const places = useMemo(() => {
    if (!filesystem) return [];
    const seen = new Set<string>();
    const result: Array<{
      key: string;
      label: string;
      path: string;
      title: string;
    }> = [];
    const add = (key: string, label: string, path: string, title = path) => {
      const normalized = path.startsWith("~")
        ? path
        : normalizeFilesystemPath(path);
      if (!path || seen.has(normalized)) return;
      seen.add(normalized);
      result.push({ key, label, path, title });
    };
    if (rootPath) add("workspace", t("Workspace"), rootPath);
    for (const cwd of paneCwds ? paneCwds.split("\n") : []) {
      add(
        `cwd:${cwd}`,
        filesystemBaseName(cwd),
        cwd,
        t("Pane directory {path}", { path: cwd }),
      );
    }
    add("home", t("Home"), "~", t("Home directory on the connected host"));
    add("root", "/", "/", t("Filesystem root"));
    return result;
  }, [filesystem, paneCwds, rootPath]);

  return (
    <>
      <div className="ui-bar file-manager-nav">
        <IconButton
          label={t("Back")}
          disabled={!canBack}
          onClick={onBack}
          icon={<ArrowLeft size={14} />}
        />
        <IconButton
          label={t("Forward")}
          disabled={!canForward}
          onClick={onForward}
          icon={<ArrowRight size={14} />}
        />
        <IconButton
          label={t("Parent directory")}
          disabled={atRoot}
          onClick={onUp}
          icon={<ArrowUp size={14} />}
        />
        {draft !== null ? (
          <form
            className="file-manager-path-form"
            onSubmit={(event) => {
              event.preventDefault();
              setDraft(null);
              onNavigate(draft);
            }}
          >
            <TextField
              autoFocus
              fullWidth
              inputClassName="file-manager-path-input"
              aria-label={t("Directory path")}
              value={draft}
              placeholder={t("/absolute/path or ~/path on the connected host")}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onValueChange={setDraft}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setDraft(null);
              }}
              onBlur={() => setDraft(null)}
            />
          </form>
        ) : (
          <nav
            className="file-manager-crumbs"
            aria-label={t("Directory path")}
            onClick={(event) => {
              if (event.target === event.currentTarget) editPath();
            }}
          >
            {visible.map((crumb, index) => (
              <span
                className={`file-manager-crumb ${
                  index > 0 && index < visible.length - 1 && !crumb.collapsed
                    ? "is-ancestor"
                    : ""
                }`}
                key={`${crumb.path}:${index}`}
              >
                {index > 0 && visible[index - 1]?.label !== "/" ? (
                  <span className="file-manager-crumb-separator">/</span>
                ) : null}
                <Button
                  title={
                    crumb.collapsed
                      ? t("Show ancestors of {path}", { path: location })
                      : crumb.path || rootPath
                  }
                  aria-current={
                    index === visible.length - 1 ? "location" : undefined
                  }
                  onClick={() => onNavigate(crumb.path)}
                >
                  <span>{crumb.label}</span>
                </Button>
              </span>
            ))}
            {filesystem ? (
              <Button
                className="file-manager-path-edit"
                aria-label={t("Edit path")}
                title={t("Type a path")}
                onClick={editPath}
              />
            ) : null}
          </nav>
        )}
        <IconButton
          label={t("Reveal active file")}
          disabled={!canReveal}
          onClick={onReveal}
          icon={<LocateFixed size={14} />}
        />
        <IconButton
          label={t("Refresh")}
          onClick={onRefresh}
          icon={
            <RefreshCw size={14} className={loading ? "is-spinning" : ""} />
          }
        />
      </div>
      {places.length ? (
        <div className="file-manager-places" aria-label={t("Locations")}>
          {places.map((place) => (
            <Token
              as="button"
              key={place.key}
              className="file-manager-place"
              tone={
                normalizeFilesystemPath(place.path) ===
                normalizeFilesystemPath(location)
                  ? "accent"
                  : "neutral"
              }
              title={place.title}
              onClick={() => onNavigate(place.path)}
              icon={
                place.key === "workspace" || place.key.startsWith("cwd:") ? (
                  <Folder size={11} />
                ) : null
              }
            >
              {place.label}
            </Token>
          ))}
        </div>
      ) : null}
    </>
  );
}
