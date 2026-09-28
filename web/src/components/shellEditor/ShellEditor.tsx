import type { ITheme, Terminal } from "@xterm/xterm";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type {
  ShellCompletion,
  ShellInputState,
  ShellSubmitResult,
} from "../../../../shared/shell";
import { bridge, type ConnectionClient } from "../../api";
import { t } from "../../i18n";
import { useShellEditorMode } from "../../shellEditorPreferences";
import type { PromptEditorControl } from "../promptEditor/PromptEditor";
import { measureTerminal, type TerminalMetrics } from "../promptEditor/metrics";
import { PromptTextarea } from "../promptEditor/PromptTextarea";
import type { PromptEditorSurface } from "../promptEditor/surface";
import { ShellSuggestions } from "../ui/ShellSuggestions";
import { historyCache, readDraft, refreshHistory, writeDraft } from "./cache";
import {
  applyCompletion,
  autoEnabled,
  commonPrefix,
  ghostText,
  historyMatches,
  incomplete,
  navigateHistory,
  searchHistory,
  shellKey,
} from "./model";
import "../promptEditor/PromptEditor.css";
import "./ShellEditor.css";

export function ShellEditor({
  client,
  paneId,
  draftKey,
  term,
  terminalTheme,
  active,
  controlRef,
  onForward,
  onFocusTerminal,
}: {
  client: ConnectionClient;
  paneId: string;
  draftKey: string;
  term: Terminal;
  terminalTheme: ITheme;
  active: boolean;
  controlRef: RefObject<PromptEditorControl | null>;
  onForward(data: string): void;
  onFocusTerminal(): void;
}) {
  const mode = useShellEditorMode();
  const [auto, setAuto] = useState(false);
  const [state, setState] = useState<ShellInputState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [text, setText] = useState(() => readDraft(draftKey));
  const textRef = useRef(text);
  textRef.current = text;
  const [caret, setCaret] = useState(text.length);
  const selectionRef = useRef({ start: text.length, end: text.length });
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [pending, setPending] = useState<{ text: string; seq: number } | null>(
    null,
  );
  const sending = useRef(false);
  const [hint, setHint] = useState("");
  const [metrics, setMetrics] = useState<TerminalMetrics | null>(null);
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);
  const [height, setHeight] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const lifted = useRef(0);
  const surface = useRef<PromptEditorSurface | null>(null);
  const composing = useRef(false);
  const [completion, setCompletion] = useState<ShellCompletion | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [older, setOlder] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [, updateHistory] = useState(0);
  const navigation = useRef<{
    draft: string;
    matches: string[];
    index: number;
  } | null>(null);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listId = useId();
  const enabled = mode === "on" || (mode === "auto" && auto);
  const visible =
    enabled &&
    !!state?.available &&
    state.seq !== dismissed &&
    term.buffer.active.type !== "alternate" &&
    atBottom &&
    !!metrics;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const history = historyCache(client).entries;
  const suggestion = ghostText(history, text, state?.cwd);
  const searchItems =
    search === null
      ? []
      : [...new Set([...searchHistory(history, search), ...older])].slice(
          0,
          50,
        );
  const items: ShellCompletion["items"] =
    search !== null
      ? searchItems.map((text) => ({ text, kind: "history" }))
      : (completion?.items ?? []);

  const edit = (next: string, at = next.length, reset = true) => {
    request.current++;
    clearTimeout(timer.current);
    setCompletion(null);
    setSelected(0);
    if (reset) navigation.current = null;
    textRef.current = next;
    selectionRef.current = { start: at, end: at };
    setText(next);
    setCaret(at);
    writeDraft(draftKey, next);
    surface.current?.setText(next, at);
  };
  useEffect(() => {
    const update = () =>
      setAuto((previous) => autoEnabled(bridge.recentRoundTrips, previous));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    let live = true;
    let revision = 0;
    const accept = (next: ShellInputState) => {
      if (!live || !client.isCurrent()) return;
      setState(next);
      setPending((value) => (value && value.seq !== next.seq ? null : value));
    };
    const off = bridge.onEvent((event) => {
      if (
        event.event !== "shell.state" ||
        event.connection_id !== client.connectionId ||
        !client.acceptsServerGeneration(event.connection_generation)
      )
        return;
      const next = event.data as unknown as ShellInputState;
      if (next.pane_id === paneId) {
        revision++;
        accept(next);
      }
    });
    const before = revision;
    void client
      .call("shell.subscribe", { pane_id: paneId })
      .then((next) => {
        if (revision === before) accept(next);
      })
      .catch(() => {
        if (live) setState(null);
      });
    return () => {
      live = false;
      off();
      // This is a request generation, not a DOM ref: invalidate its latest value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;
      clearTimeout(timer.current);
      if (client.isCurrent())
        void client
          .call("shell.subscribe", { pane_id: paneId, enabled: false })
          .catch(() => {});
    };
  }, [client, paneId]);
  useEffect(() => {
    const measure = () => {
      const buffer = term.buffer.active;
      const measured = measureTerminal(
        term,
        root.current?.parentElement ?? null,
      );
      if (measured) measured.top += lifted.current;
      setMetrics(measured);
      setRow(buffer.baseY + buffer.cursorY - buffer.viewportY);
      setCol(buffer.cursorX);
      setAtBottom(
        buffer.viewportY === buffer.baseY && buffer.type !== "alternate",
      );
    };
    measure();
    const parsed = term.onWriteParsed(() => {
      measure();
      setPending(null);
    });
    const resized = term.onResize(measure);
    const scroll = term.onScroll(measure);
    const observer = new ResizeObserver(measure);
    if (term.element) observer.observe(term.element);
    return () => {
      parsed.dispose();
      resized.dispose();
      scroll.dispose();
      observer.disconnect();
    };
  }, [term]);
  useEffect(() => {
    if (!visible) return;
    const refresh = () =>
      void refreshHistory(client, paneId)
        .then(() => updateHistory((n) => n + 1))
        .catch(() => {});
    refresh();
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, [client, paneId, visible]);
  useLayoutEffect(() => {
    if (!visible) {
      if (root.current?.contains(document.activeElement)) onFocusTerminal();
      request.current++;
      setCompletion(null);
      setSearch(null);
    } else if (
      active &&
      (!document.activeElement ||
        document.activeElement === document.body ||
        term.element?.contains(document.activeElement))
    ) {
      surface.current?.focus();
    }
    controlRef.current = {
      focus: () => {
        if (!visible) return false;
        surface.current?.focus();
        return true;
      },
      hasFocus: () => !!root.current?.contains(document.activeElement),
      visible: () => visible,
    };
  }, [active, controlRef, onFocusTerminal, pending, term, visible]);
  useLayoutEffect(() => {
    const element = root.current;
    return () => {
      if (element?.contains(document.activeElement)) onFocusTerminal();
      controlRef.current = null;
    };
  }, [controlRef, onFocusTerminal]);
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(""), 3000);
    return () => clearTimeout(id);
  }, [hint]);
  useEffect(() => {
    if (search === null || !search) {
      setOlder([]);
      return;
    }
    let live = true;
    const id = setTimeout(() => {
      void client
        .call("shell.history", { pane_id: paneId, query: search, limit: 50 })
        .then((result) => {
          if (live && client.isCurrent())
            setOlder(
              result.entries.map((entry: { command: string }) => entry.command),
            );
        })
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [client, paneId, search]);

  const complete = (
    line = textRef.current,
    cursor = surface.current?.selection()?.end ?? line.length,
    depth = 0,
  ) => {
    const id = ++request.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void client
        .call("shell.complete", { pane_id: paneId, line, cursor })
        .then((result: ShellCompletion) => {
          if (
            id !== request.current ||
            !client.isCurrent() ||
            !visibleRef.current ||
            textRef.current !== line
          )
            return;
          if (result.items.length === 1) {
            const next = applyCompletion(line, result, result.items[0].text);
            edit(next.text, next.caret);
            if (
              result.items[0].kind === "dir" &&
              next.text !== line &&
              depth < 8
            )
              complete(next.text, next.caret, depth + 1);
          } else if (result.items.length) {
            const prefix = commonPrefix(result.items);
            const token = line.slice(result.replace_start, result.replace_end);
            if (prefix.length > token.length && prefix.startsWith(token)) {
              const next = applyCompletion(line, result, prefix);
              edit(next.text, next.caret);
              result = { ...result, replace_end: next.caret };
            }
            setCompletion(result);
            setSelected(0);
          }
        })
        .catch(() => {
          if (id === request.current) setHint(t("Completion unavailable"));
        });
    }, 80);
  };
  const accept = (index: number) => {
    const item = items[index];
    if (!item) return;
    if (search !== null) {
      setSearch(null);
      edit(item.text);
      return;
    }
    if (!completion) return;
    const next = applyCompletion(textRef.current, completion, item.text);
    edit(next.text, next.caret);
    if (item.kind === "dir") complete(next.text, next.caret);
  };
  const submit = async (execute: boolean) => {
    const snapshot = stateRef.current;
    if (sending.current || !snapshot?.available || !client.isCurrent()) return;
    const command = textRef.current;
    sending.current = true;
    setPending({ text: command, seq: snapshot.seq });
    try {
      const params = {
        pane_id: paneId,
        seq: snapshot.seq,
        text: command,
        execute,
      };
      let result: ShellSubmitResult = await client.call("shell.submit", params);
      if (!result.ok && result.reason === "stale_seq") {
        const fresh: ShellInputState = await client.call("shell.subscribe", {
          pane_id: paneId,
        });
        if (client.isCurrent()) setState(fresh);
        if (
          fresh.available &&
          fresh.seq === snapshot.seq &&
          stateRef.current?.seq === snapshot.seq &&
          client.isCurrent()
        )
          result = await client.call("shell.submit", params);
      }
      if (!client.isCurrent()) return;
      if (result.ok) {
        if (execute && command.trim() && !command.startsWith(" ")) {
          historyCache(client).entries.unshift({
            command,
            cwd: snapshot.cwd ?? "",
            exit: null,
            start_ts: Date.now(),
            end_ts: null,
            pane: paneId,
            shell: snapshot.shell ?? "",
            host: client.connectionId,
          });
        }
        edit("");
        setDismissed(snapshot.seq);
        onFocusTerminal();
      } else {
        setPending(null);
        setHint(
          t("Shell input unavailable: {reason}", { reason: result.reason }),
        );
        if (
          ["busy", "dirty", "submitted", "alternate_screen"].includes(
            result.reason,
          )
        ) {
          setDismissed(snapshot.seq);
          onFocusTerminal();
        }
      }
    } catch {
      // Unknown dispatch status: retain the draft, never automatically replay.
      setPending(null);
      setHint(t("Could not confirm shell input"));
    } finally {
      sending.current = false;
    }
  };
  useLayoutEffect(() => {
    if (!controlRef.current) return;
    controlRef.current.insertText = async (value, execute) => {
      if (!visible || sending.current) return;
      const selection = surface.current?.selection();
      const start = selection?.start ?? textRef.current.length;
      const end = selection?.end ?? start;
      edit(
        textRef.current.slice(0, start) + value + textRef.current.slice(end),
        start + value.length,
      );
      if (execute && !incomplete(textRef.current)) await submit(true);
    };
  });
  const onKey = (event: KeyboardEvent, empty: boolean) => {
    if (composing.current || event.isComposing || event.keyCode === 229)
      return false;
    if (sending.current) return true;
    if (event.key === "Escape" && (completion || search !== null)) {
      request.current++;
      setCompletion(null);
      setSearch(null);
      return true;
    }
    if (
      items.length &&
      ["ArrowUp", "ArrowDown", "Tab", "Enter"].includes(event.key)
    ) {
      if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))
        accept(selected);
      else
        setSelected(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length,
        );
      return true;
    }
    const selection = surface.current?.selection();
    const end = selection?.end ?? text.length;
    if (search !== null) {
      if (event.key === "Backspace") {
        setSearch(search.slice(0, -1));
        setSelected(0);
        setOlder([]);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        setSearch(search + event.key);
        setSelected(0);
        setOlder([]);
      } else if (event.ctrlKey && event.key === "r")
        setSelected((index) => (items.length ? (index + 1) % items.length : 0));
      return true;
    }
    if (
      suggestion &&
      end === text.length &&
      selection?.start === end &&
      (event.key === "ArrowRight" || event.key === "End")
    ) {
      edit(
        text +
          (event.altKey
            ? (suggestion.match(/^\s*\S+\s*/)?.[0] ?? suggestion)
            : suggestion),
      );
      return true;
    }
    if (
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      ((event.key === "ArrowUp" && !text.slice(0, end).includes("\n")) ||
        (event.key === "ArrowDown" && !text.slice(end).includes("\n")))
    ) {
      navigation.current ??= {
        draft: text,
        matches: historyMatches(history, text, state?.cwd),
        index: -1,
      };
      const nav = navigation.current;
      const next = navigateHistory(
        nav.matches,
        nav.index,
        event.key === "ArrowUp" ? 1 : -1,
        nav.draft,
      );
      nav.index = next.index;
      edit(next.text, next.text.length, false);
      return true;
    }
    const action = shellKey(event, empty);
    if (!action) return false;
    if (action === "submit") {
      if (incomplete(text)) surface.current?.insertText("\n");
      else void submit(true);
    } else if (action === "newline") surface.current?.insertText("\n");
    else if (action === "complete") complete();
    else if (action === "clear") edit("");
    else if (action === "search") {
      setSearch("");
      setSelected(0);
    } else if (action === "escape-hatch") void submit(false);
    else if (action === "hide") {
      setDismissed(state?.seq ?? null);
      onFocusTerminal();
    } else {
      onForward(action);
      setDismissed(state?.seq ?? null);
      onFocusTerminal();
    }
    return true;
  };
  const lineHeight = metrics?.rowHeight ?? 17;
  const editorHeight = Math.min(
    Math.max(lineHeight, height),
    Math.max(lineHeight, (metrics?.rows ?? 24) * lineHeight * 0.4),
  );
  // Make room below a prompt on the last row, moving the real PS1 with the
  // terminal. No terminal resize or PTY input is needed for local draft growth.
  const lift =
    metrics && (visible || pending)
      ? Math.max(
          0,
          row * lineHeight +
            editorHeight +
            (items.length ? Math.min(180, items.length * 28) : 0) +
            (hint || search !== null ? lineHeight : 0) -
            metrics.rows * lineHeight,
        )
      : 0;
  useLayoutEffect(() => {
    const element = term.element;
    if (!element) return;
    const previous = element.style.translate;
    const screen = element.querySelector<HTMLElement>(".xterm-screen");
    const scale = screen?.offsetHeight
      ? screen.getBoundingClientRect().height / screen.offsetHeight
      : 1;
    lifted.current = lift;
    element.style.translate = `0 ${-lift / scale}px`;
    return () => {
      element.style.translate = previous;
      lifted.current = 0;
    };
  }, [lift, term]);
  const style = metrics
    ? ({
        left: metrics.left + col * metrics.cellWidth,
        top: metrics.top + row * lineHeight - lift,
        width: Math.max(
          metrics.cellWidth,
          metrics.width - col * metrics.cellWidth,
        ),
        height: editorHeight,
        fontFamily: term.options.fontFamily,
        fontSize: metrics.fontSize,
        "--prompt-editor-row": `${lineHeight}px`,
        "--shell-editor-hint-height": `${hint || search !== null ? lineHeight : 0}px`,
        "--prompt-editor-bg": terminalTheme.background,
        "--prompt-editor-fg": terminalTheme.foreground,
        "--prompt-editor-caret": terminalTheme.cursor,
        "--prompt-editor-selection": terminalTheme.selectionBackground,
      } as CSSProperties)
    : undefined;
  return (
    <div
      ref={root}
      className="shell-editor"
      style={style}
      hidden={!visible && !pending}
    >
      {pending ? (
        <div className="shell-editor-pending">{pending.text}</div>
      ) : (
        <>
          {suggestion && caret === text.length && !text.includes("\n") && (
            <div className="shell-editor-ghost" aria-hidden="true">
              <span>{text}</span>
              {suggestion}
            </div>
          )}
          <PromptTextarea
            surfaceRef={surface}
            initialText={text}
            initialSelection={null}
            focus={false}
            label={t("Shell command line")}
            placeholder=""
            font={{
              family: term.options.fontFamily ?? "monospace",
              size: metrics?.fontSize ?? 13,
              lineHeight,
            }}
            onChange={(next, start, end) => {
              if (next !== textRef.current) edit(next, end);
              else {
                setCaret(start === end ? end : -1);
                if (
                  selectionRef.current.start !== start ||
                  selectionRef.current.end !== end
                ) {
                  request.current++;
                  setCompletion(null);
                }
              }
              selectionRef.current = { start, end };
            }}
            onKey={onKey}
            onContentHeight={setHeight}
            onPasteFiles={() => false}
            onCompositionChange={(value) => {
              composing.current = value;
            }}
            controls={items.length ? listId : undefined}
            activeDescendant={
              items.length ? `${listId}-${selected}` : undefined
            }
          />
          {(hint || search !== null) && (
            <div className="shell-editor-hint" role="status">
              {search !== null
                ? t("Search history: {query}", { query: search })
                : hint}
            </div>
          )}
          {!!items.length && (
            <ShellSuggestions
              id={listId}
              items={items}
              selected={selected}
              label={t("Shell suggestions")}
              onSelect={accept}
            />
          )}
        </>
      )}
    </div>
  );
}
