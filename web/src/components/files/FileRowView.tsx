import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { useRef, useState } from "react";
import { t } from "../../i18n";
import type { FileExplorerEntry } from "../../types";
import {
  type buildGitStatusMaps,
  symlinkDescription,
} from "../fileExplorerResources";
import { IconButton } from "../ui/IconButton";
import { TextField } from "../ui/TextField";
import {
  type FileRow,
  type FileView,
  formatSize,
  isDirectoryEntry,
} from "./fileManagerModel";
import { FileIcon, FileThumbnail } from "./FileVisual";

type GitStatusMaps = ReturnType<typeof buildGitStatusMaps>;

/** Inline name field for rename and new entries; Enter or blur commits. */
export function NameInput({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <TextField
      autoFocus
      className="file-name-field"
      inputClassName="file-name-input"
      aria-label={label}
      value={value}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onValueChange={setValue}
      onFocus={(event) => {
        // Select the stem, as VS Code does, so typing keeps the extension.
        const dot = initial.lastIndexOf(".");
        event.currentTarget.setSelectionRange(
          0,
          dot > 0 ? dot : initial.length,
        );
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

function shortDate(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** What every row reads from the file manager. */
export type RowContext = {
  view: FileView;
  light: boolean;
  parentName: (path: string) => string;
  tabStop: string | undefined;
  activePath?: string;
  selected: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  dropTarget: string | null;
  cut: ReadonlySet<string> | null;
  busy: (path: string) => boolean;
  gitStatus?: GitStatusMaps;
  renaming: string | null;
  thumbnail: (entry: FileExplorerEntry) => string | null;
  onFocus: (path: string) => void;
  onRename: (entry: FileExplorerEntry, name: string) => void;
  onRenameCancel: (path: string) => void;
};

const indent = (view: FileView, depth: number) =>
  view === "list" ? { paddingLeft: 4 + depth * 12 } : undefined;

/**
 * One tree row (list view) or tile (grid view). Events are delegated to the
 * body by `data-file-path`, so rows carry no handlers of their own.
 */
export function FileEntryRow({
  row: { entry, depth },
  context: row,
}: {
  row: FileRow;
  context: RowContext;
}) {
  const { path } = entry;
  const list = row.view === "list";
  const folder = isDirectoryEntry(entry);
  const open = folder && row.expanded.has(path);
  const selected = row.selected.has(path);
  const renaming = row.renaming === path;
  const status = folder
    ? row.gitStatus?.directoryStatuses.get(path)
    : row.gitStatus?.fileStatuses.get(path);
  const icon = (
    <FileIcon
      name={entry.name}
      directory={folder}
      open={open}
      parent={row.parentName(path)}
      light={row.light}
      size={list ? 16 : 40}
    />
  );
  const name = renaming ? (
    <NameInput
      initial={entry.name}
      label={t("New name for {name}", { name: entry.name })}
      onCommit={(value) => row.onRename(entry, value)}
      onCancel={() => row.onRenameCancel(path)}
    />
  ) : (
    <span className="file-name">{entry.name}</span>
  );
  const meta = [symlinkDescription(entry), folder ? "" : formatSize(entry.size)]
    .filter(Boolean)
    .join(" · ");
  const className = [
    list ? "file-row" : "file-tile",
    selected && "is-selected",
    row.dropTarget === path && "is-drop-target",
    row.cut?.has(path) && "is-cut",
    entry.ignored && "is-ignored",
    entry.hidden && "is-hidden-entry",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={className}
      role={list ? "treeitem" : "option"}
      data-file-path={path}
      tabIndex={path === row.tabStop ? 0 : -1}
      aria-level={list ? depth + 1 : undefined}
      aria-selected={selected}
      aria-expanded={list && folder ? open : undefined}
      aria-current={path === row.activePath ? "true" : undefined}
      draggable={!renaming}
      title={entry.ignored ? t("{path} · Ignored by Git", { path }) : path}
      style={indent(row.view, depth)}
      onFocus={(event) => {
        if (event.target === event.currentTarget) row.onFocus(path);
      }}
    >
      {list ? (
        <>
          <span className="file-twisty" aria-hidden="true">
            {folder ? (
              open ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : null}
          </span>
          <span className="file-icon">{icon}</span>
          {name}
          {status ? (
            <span
              className="file-git-status"
              title={status.title}
              role="img"
              aria-label={status.title}
            >
              {status.codes.map((code) => (
                <span
                  className={`git-status-code git-status-${code.toLowerCase()}`}
                  key={code}
                  aria-hidden="true"
                >
                  {code}
                </span>
              ))}
            </span>
          ) : null}
          {meta ? <span className="file-meta">{meta}</span> : null}
          <span className="file-meta file-meta-date">
            {shortDate(entry.mtime_ms)}
          </span>
        </>
      ) : (
        <>
          <FileThumbnail src={row.thumbnail(entry)}>{icon}</FileThumbnail>
          {name}
        </>
      )}
      {row.busy(path) ? <span className="row-spinner" /> : null}
      <span className="file-row-action">
        <IconButton
          tabIndex={-1}
          label={t("Actions for {name}", { name: entry.name })}
          icon={<Ellipsis size={14} />}
        />
      </span>
    </div>
  );
}

/** The inline field of a new file or folder, at the top of its folder. */
export function CreateEntryRow({
  type,
  depth,
  view,
  light,
  onCommit,
  onCancel,
}: {
  type: "file" | "directory";
  depth: number;
  view: FileView;
  light: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={`${view === "grid" ? "file-tile" : "file-row"} is-editing`}
      style={indent(view, depth)}
    >
      {view === "list" ? <span className="file-twisty" /> : null}
      <span className="file-icon">
        <FileIcon
          name=""
          directory={type === "directory"}
          light={light}
          size={view === "grid" ? 40 : 16}
        />
      </span>
      <NameInput
        initial=""
        label={type === "directory" ? t("New folder name") : t("New file name")}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}
