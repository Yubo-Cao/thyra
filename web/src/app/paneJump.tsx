import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { agentStatusText } from "../agentOrder";
import { AgentIcon } from "../components/AgentIcon";
import { focusIfUnchanged } from "../components/dialogFocus";
import { t } from "../i18n";
import {
  paneJumpEntries,
  paneJumpTargetId,
  paneSearchEntries,
} from "../paneJump";
import { type State, store } from "../store";
import { agentClass } from "../utils";

type PaneJumpModifier = "ctrlKey" | "altKey" | "metaKey";

/**
 * The recent-pane switcher (held modifier, commit on release) and its typed
 * search mode. Keys are routed here by useAppShortcuts.
 */
export function usePaneJump(
  s: Pick<State, "layout" | "panes" | "recentPaneIds" | "tabs" | "workspaces">,
  activePaneId: string | undefined,
  resourceUiKey: string,
  onJump: () => void,
) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  // null keeps the most-recently-used list; a string switches to typed search.
  const [search, setSearch] = useState<string | null>(null);
  const modifierRef = useRef<PaneJumpModifier | null>(null);
  const indexRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const options = useMemo(() => {
    const snapshot = {
      layout: s.layout,
      panes: s.panes,
      recentPaneIds: s.recentPaneIds,
      tabs: s.tabs,
      workspaces: s.workspaces,
    };
    return search === null
      ? paneJumpEntries(snapshot, activePaneId)
      : paneSearchEntries(snapshot, search, activePaneId);
  }, [
    activePaneId,
    search,
    s.layout,
    s.panes,
    s.recentPaneIds,
    s.tabs,
    s.workspaces,
  ]);

  const close = useCallback((restoreFocus = false) => {
    const target = returnFocusRef.current;
    const source = document.activeElement;
    returnFocusRef.current = null;
    modifierRef.current = null;
    setSearch(null);
    setOpen(false);
    if (restoreFocus && target) {
      // Wait for unmount, without stealing focus from a new user selection.
      requestAnimationFrame(() => {
        if (target.isConnected) focusIfUnchanged(target, source);
      });
    }
  }, []);
  const select = useCallback(
    (next: number) => {
      const length = options.length;
      const wrapped = length > 0 ? ((next % length) + length) % length : 0;
      indexRef.current = wrapped;
      setIndex(wrapped);
    },
    [options.length],
  );
  const commit = useCallback(
    (target = indexRef.current) => {
      const targetPaneId = paneJumpTargetId(options, target);
      close(!targetPaneId);
      if (!targetPaneId) return;
      onJump();
      void store.focusPane(targetPaneId);
    },
    [close, onJump, options],
  );
  const move = useCallback(
    (delta: number) => select(indexRef.current + delta),
    [select],
  );
  /** Open the recent list on the previous pane, committing on `modifier` up. */
  const openRecent = useCallback(
    (modifier: PaneJumpModifier | null) => {
      modifierRef.current = modifier;
      const previousPaneIndex = options.findIndex((entry) => !entry.current);
      select(previousPaneIndex >= 0 ? previousPaneIndex : 0);
      setOpen(true);
    },
    [options, select],
  );
  // Typed search drops the held modifier: releasing it must keep the list open
  // instead of committing the way the recent switcher does.
  const openSearch = useCallback(() => {
    if (store.get().panes.length === 0) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    modifierRef.current = null;
    indexRef.current = 0;
    setIndex(0);
    setSearch("");
    setOpen(true);
  }, []);
  const changeSearch = useCallback((value: string) => {
    indexRef.current = 0;
    setIndex(0);
    setSearch(value);
  }, []);

  const resourceKeyRef = useRef(resourceUiKey);
  useLayoutEffect(() => {
    if (resourceKeyRef.current === resourceUiKey) return;
    resourceKeyRef.current = resourceUiKey;
    returnFocusRef.current = null;
    setOpen(false);
    setIndex(0);
    setSearch(null);
  }, [resourceUiKey]);
  // Search keeps the current pane listed for context, but focusing it is a
  // no-op, so selection lands on the first entry a jump can actually reach.
  useEffect(() => {
    if (!open || search === null) return;
    if (!options[indexRef.current]?.current) return;
    const target = options.findIndex((entry) => !entry.current);
    if (target >= 0) select(target);
  }, [open, options, search, select]);
  useEffect(() => {
    if (open && search === null && options.length === 0) close();
    if (indexRef.current >= options.length) select(options.length - 1);
  }, [close, open, options.length, search, select]);

  return {
    open,
    index,
    search,
    options,
    modifierRef,
    close,
    select,
    commit,
    move,
    openRecent,
    openSearch,
    changeSearch,
  };
}
export type PaneJump = ReturnType<typeof usePaneJump>;

export function PaneJumpOverlay({ paneJump }: { paneJump: PaneJump }) {
  const {
    options: entries,
    index: selectedIndex,
    search,
    changeSearch: onSearchChange,
    select: onSelectIndex,
    commit: onCommit,
    close,
  } = paneJump;
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searching = search !== null;
  const selectedPaneId = entries[selectedIndex]?.paneId;

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, selectedPaneId]);
  useEffect(() => {
    if (searching) searchInputRef.current?.focus();
  }, [searching]);

  if (entries.length === 0 && !searching) return null;
  const listId = "pane-jump-list";
  return (
    <div className="pane-jump-backdrop">
      <div className="pane-jump-popover">
        <div className="pane-jump-head">
          <strong>{searching ? t("Find Pane") : t("Switch Pane")}</strong>
          <span>
            {searching
              ? t("Filters every open pane. Use Up / Down and Enter")
              : t("K to search; Enter or release modifier to switch")}
          </span>
        </div>
        {searching ? (
          <input
            ref={searchInputRef}
            className="pane-jump-search"
            type="text"
            value={search}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("Workspace, tab, directory, or agent")}
            role="combobox"
            aria-label={t("Search panes")}
            aria-expanded={true}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={
              selectedPaneId
                ? `${listId}-${encodeURIComponent(selectedPaneId)}`
                : undefined
            }
            onChange={(event) => onSearchChange(event.target.value)}
            onBlur={() => close()}
          />
        ) : null}
        {entries.length === 0 ? (
          <p className="pane-jump-empty" role="status">
            {t("No panes match this search.")}
          </p>
        ) : null}
        <div
          className="pane-jump-list"
          id={listId}
          role="listbox"
          aria-label={searching ? t("Matching panes") : t("Recent panes")}
        >
          {entries.map((entry, index) => (
            <button
              key={entry.paneId}
              id={`${listId}-${encodeURIComponent(entry.paneId)}`}
              ref={index === selectedIndex ? selectedItemRef : undefined}
              type="button"
              tabIndex={-1}
              className={`pane-jump-item ${
                index === selectedIndex ? "is-selected" : ""
              } ${entry.current ? "is-current" : ""}`}
              role="option"
              aria-selected={index === selectedIndex}
              onPointerEnter={() => onSelectIndex(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onCommit(index)}
            >
              {entry.agent ? (
                <span className="pane-jump-agent-identity">
                  <AgentIcon agent={entry.agent} compact />
                  <span
                    className={`pane-jump-status status-${entry.agentStatus ?? "unknown"}`}
                  />
                </span>
              ) : null}
              <span className="pane-jump-text">
                <span className="pane-jump-title-line">
                  <strong>{entry.title}</strong>
                  {entry.current ? (
                    <span className="pane-jump-current-badge">
                      {t("Current")}
                    </span>
                  ) : null}
                  {entry.agentStatus ? (
                    <span
                      className={`${agentClass(entry.agentStatus)} pane-jump-agent-status`}
                    >
                      {agentStatusText(entry.agentStatus)}
                    </span>
                  ) : null}
                </span>
                <span className="pane-jump-subtitle">
                  <span className="pane-jump-tab" title={entry.tabLabel}>
                    {entry.tabLabel}
                  </span>
                  <span className="pane-jump-id" title={entry.paneId}>
                    {" · "}
                    {entry.paneLabel}
                  </span>
                  {entry.cwd ? (
                    <span className="pane-jump-cwd" title={entry.cwd}>
                      {" · "}
                      {entry.cwd}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
