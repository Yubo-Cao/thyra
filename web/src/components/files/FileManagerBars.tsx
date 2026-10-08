import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ClipboardPaste,
  Copy,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  LayoutGrid,
  List,
  Pencil,
  Scissors,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { t } from "../../i18n";
import type { FileExplorerEntry } from "../../types";
import { IconButton } from "../ui/IconButton";
import { keepFocus } from "../ui/keepFocus";
import { Menu } from "../ui/Menu";
import { SearchField } from "../ui/SearchField";
import { Token } from "../ui/Token";
import { type FileMenuActions, sortMenu } from "./fileManagerMenus";
import type { FileView, SortState } from "./fileManagerModel";

/** Filter, entry count, view, sort, hidden files and the create buttons. */
export function FileManagerTools({
  filter,
  onFilter,
  onFilterExit,
  count,
  view,
  onView,
  sort,
  onSort,
  showHidden,
  onShowHidden,
  onCreate,
  onUpload,
}: {
  filter: string;
  onFilter: (value: string) => void;
  /** ArrowDown in the filter moves into the list. */
  onFilterExit: () => void;
  count: { shown: number; total: number } | null;
  view: FileView;
  onView: (view: FileView) => void;
  sort: SortState;
  onSort: (sort: SortState) => void;
  showHidden: boolean;
  onShowHidden: (value: boolean) => void;
  /** Absent for viewers. */
  onCreate?: (kind: "file" | "directory") => void;
  onUpload?: () => void;
}) {
  return (
    <div className="ui-bar file-manager-tools">
      <SearchField
        className="file-manager-filter"
        fullWidth
        value={filter}
        onValueChange={onFilter}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          onFilterExit();
        }}
        placeholder={t("Filter")}
        aria-label={t("Filter loaded entries")}
        title={t(
          "Filter loaded names or paths. Globs: r*md, ?.txt, **/*.md, *.{md,txt}",
        )}
        maxLength={512}
      />
      {count ? (
        <Token title={t("{count} entries", { count: count.total })}>
          {filter ? `${count.shown}/${count.total}` : count.total}
        </Token>
      ) : null}
      <IconButton
        aria-pressed={view === "grid"}
        label={view === "grid" ? t("List view") : t("Grid view")}
        onClick={() => onView(view === "grid" ? "list" : "grid")}
        icon={view === "grid" ? <List size={14} /> : <LayoutGrid size={14} />}
      />
      <Menu
        aria-label={t("Sort")}
        items={sortMenu(sort, onSort)}
        trigger={
          <IconButton
            label={t("Sort")}
            icon={
              sort.descending ? (
                <ArrowDownWideNarrow size={14} />
              ) : (
                <ArrowUpNarrowWide size={14} />
              )
            }
          />
        }
      />
      <IconButton
        aria-pressed={showHidden}
        label={t("Show hidden files")}
        tooltip={showHidden ? t("Hide hidden files") : t("Show hidden files")}
        onClick={() => onShowHidden(!showHidden)}
        icon={showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
      />
      {onCreate ? (
        <>
          <IconButton
            label={t("New file")}
            onClick={() => onCreate("file")}
            icon={<FilePlus size={14} />}
          />
          <IconButton
            label={t("New folder")}
            onClick={() => onCreate("directory")}
            icon={<FolderPlus size={14} />}
          />
        </>
      ) : null}
      {onUpload ? (
        <IconButton
          label={t("Upload files")}
          tooltip={t("Upload files here")}
          onClick={onUpload}
          icon={<Upload size={14} />}
        />
      ) : null}
    </div>
  );
}

/**
 * The selection's commands for touch screens (and any multi-selection).
 * Buttons keep the list's focus: WebKit drops a tap whose pointerdown is
 * prevented, so only mousedown is (see ui/keepFocus.ts).
 */
export function FileSelectionBar({
  selected,
  actions,
  folder,
  onMore,
  onDone,
}: {
  selected: FileExplorerEntry[];
  actions: FileMenuActions;
  folder: string;
  onMore: (x: number, y: number) => void;
  onDone: () => void;
}) {
  const single = selected.length === 1 ? selected[0] : undefined;
  const none = !selected.length;
  const button = (
    label: string,
    icon: React.ReactNode,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void,
    extra: { disabled?: boolean; danger?: boolean } = {},
  ) => (
    <IconButton
      label={label}
      disabled={extra.disabled}
      tone={extra.danger ? "danger" : undefined}
      onMouseDown={keepFocus}
      onClick={onClick}
      icon={icon}
    />
  );
  return (
    <div
      className="ui-bar file-manager-selection-bar"
      role="toolbar"
      aria-label={t("Selection")}
    >
      <Token tone="accent">
        {t("{count} selected", { count: selected.length })}
      </Token>
      <span className="ui-bar-spacer" />
      {actions.cut
        ? button(
            t("Cut"),
            <Scissors size={15} />,
            () => actions.cut?.(selected),
            {
              disabled: none,
            },
          )
        : null}
      {actions.copy
        ? button(
            t("Copy"),
            <Copy size={15} />,
            () => actions.copy?.(selected),
            {
              disabled: none,
            },
          )
        : null}
      {actions.paste
        ? button(t("Paste"), <ClipboardPaste size={15} />, () =>
            actions.paste?.(folder),
          )
        : null}
      {actions.rename && single
        ? button(t("Rename"), <Pencil size={15} />, () =>
            actions.rename?.(single),
          )
        : null}
      {single
        ? button(t("Download"), <Download size={15} />, () =>
            actions.download(single),
          )
        : null}
      {actions.trash
        ? button(
            t("Move to trash"),
            <Trash2 size={15} />,
            () => actions.trash?.(selected),
            { disabled: none, danger: true },
          )
        : null}
      {button(
        t("More actions"),
        <Ellipsis size={15} />,
        (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMore(rect.left, rect.top);
        },
        { disabled: none },
      )}
      {button(t("Done"), <X size={15} />, onDone)}
    </div>
  );
}
