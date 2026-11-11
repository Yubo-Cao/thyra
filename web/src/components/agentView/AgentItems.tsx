import {
  Bot,
  Brain,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  FileDiff,
  FilePenLine,
  FileText,
  Globe,
  Info,
  ListChecks,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { useStore } from "zustand";
import type {
  AgentFileDiff,
  AgentItem,
  AgentToolKind,
} from "../../../../shared/agentSession";
import { diffTotals, parseUnifiedDiff } from "../../agentSession/diff";
import type { AgentSessionStore } from "../../agentSession/session";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { Token } from "../ui/Token";
import { AgentMarkdown, CodeBlock } from "./AgentMarkdown";

type Tool = Extract<AgentItem, { type: "tool" }>;

/** What rows share: which are open (kept while they scroll out) and file opening. */
export const AgentViewContext = createContext<{
  expanded: Map<string, boolean>;
  onOpenFile?: (path: string) => void;
}>({ expanded: new Map() });

/** Diff lines drawn before the rest is summarized. */
const DIFF_LINE_LIMIT = 400;

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="agent-diff-counts">
      {added ? <span className="is-add">+{added}</span> : null}
      {removed ? <span className="is-remove">-{removed}</span> : null}
    </span>
  );
}

/** One file's unified diff under its path. */
export function DiffView({ diff }: { diff: AgentFileDiff }) {
  const { onOpenFile } = useContext(AgentViewContext);
  const parsed = useMemo(() => parseUnifiedDiff(diff.patch), [diff.patch]);
  const hidden = parsed.lines.length - DIFF_LINE_LIMIT;
  return (
    <div className="agent-diff">
      <div className="agent-diff-head">
        <FileDiff size={13} aria-hidden="true" />
        {onOpenFile ? (
          <Button
            className="agent-diff-path"
            title={t("Open {path}", { path: diff.path })}
            onClick={() => onOpenFile(diff.path)}
          >
            {diff.path}
          </Button>
        ) : (
          <span className="agent-diff-path">{diff.path}</span>
        )}
        <DiffCounts added={parsed.added} removed={parsed.removed} />
      </div>
      <div className="agent-diff-body">
        <div className="agent-diff-lines">
          {parsed.lines.slice(0, DIFF_LINE_LIMIT).map((line, index) => (
            <div key={index} className={`agent-diff-line is-${line.kind}`}>
              <span className="agent-diff-number">{line.line ?? ""}</span>
              <span className="agent-diff-sign">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
        {hidden > 0 ? (
          <div className="agent-detail-note">
            {t("{count} more lines not shown", { count: hidden })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A one-line row that opens the detail under it. */
function Disclosure({
  id,
  icon,
  title,
  mono = false,
  trailing,
  dim = false,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: ReactNode;
  mono?: boolean;
  trailing?: ReactNode;
  dim?: boolean;
  /** Absent: the row has nothing to open. */
  children?: ReactNode;
}) {
  const { expanded } = useContext(AgentViewContext);
  const [open, setOpen] = useState(() => expanded.get(id) ?? false);
  const toggle = () => {
    expanded.set(id, !open);
    setOpen(!open);
  };
  return (
    <>
      <Button
        fullWidth
        className={`agent-row ${dim ? "is-dim" : ""}`}
        aria-expanded={children ? open : undefined}
        disabled={!children}
        onClick={toggle}
      >
        {icon}
        <span className={`agent-row-title ${mono ? "is-mono" : ""}`}>
          {title}
        </span>
        {trailing}
        {children ? (
          <ChevronRight
            className="agent-row-chevron"
            size={13}
            aria-hidden="true"
          />
        ) : null}
      </Button>
      {open && children ? <div className="agent-detail">{children}</div> : null}
    </>
  );
}

const TOOL_ICONS: Record<AgentToolKind, typeof Wrench> = {
  command: SquareTerminal,
  edit: FilePenLine,
  read: FileText,
  search: Search,
  fetch: Globe,
  task: Bot,
  other: Wrench,
};

function ToolRow({ item }: { item: Tool }) {
  const Icon = TOOL_ICONS[item.kind] ?? Wrench;
  const totals = useMemo(
    () => (item.diffs?.length ? diffTotals(item.diffs) : null),
    [item.diffs],
  );
  const hasDetail =
    !!item.command || !!item.input || !!item.output || !!item.diffs?.length;
  return (
    <Disclosure
      id={item.id}
      icon={<Icon size={14} aria-hidden="true" />}
      title={item.title || item.name}
      mono={item.kind === "command"}
      trailing={
        <>
          {totals ? <DiffCounts {...totals} /> : null}
          {item.status === "running" || item.status === "pending" ? (
            <Spinner size="sm" label={t("Running")} />
          ) : item.status === "failed" ? (
            <Token tone="danger">{t("Failed")}</Token>
          ) : item.status === "denied" ? (
            <Token tone="warning">{t("Denied")}</Token>
          ) : null}
        </>
      }
    >
      {hasDetail ? (
        <>
          {item.command ? <CodeBlock text={item.command} /> : null}
          {item.input ? <CodeBlock text={item.input} lang="json" /> : null}
          {item.diffs?.map((diff, index) => (
            <DiffView key={`${index}:${diff.path}`} diff={diff} />
          ))}
          {item.output ? (
            <pre className="agent-output">{item.output}</pre>
          ) : null}
          {item.output_truncated ? (
            <div className="agent-detail-note">
              {t("The output was cut off here.")}
            </div>
          ) : null}
        </>
      ) : undefined}
    </Disclosure>
  );
}

/** The last line of text, for a row that shows what is being written. */
function lastLine(text: string) {
  const trimmed = text.trimEnd();
  return trimmed.slice(trimmed.lastIndexOf("\n") + 1);
}

function Item({ item }: { item: AgentItem }) {
  switch (item.type) {
    case "user":
      return <div className="agent-user">{item.text}</div>;
    case "assistant":
      return <AgentMarkdown text={item.text} streaming={item.streaming} />;
    case "thinking":
      return (
        <Disclosure
          id={item.id}
          dim
          icon={<Brain size={14} aria-hidden="true" />}
          title={
            item.streaming ? (
              <>
                {t("Thinking")}
                <span className="agent-row-preview">{lastLine(item.text)}</span>
              </>
            ) : (
              t("Thought")
            )
          }
          trailing={
            item.streaming ? <Spinner size="sm" label={t("Thinking")} /> : null
          }
        >
          {item.text ? (
            <div className="agent-thinking">{item.text}</div>
          ) : undefined}
        </Disclosure>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return (
        <div className="agent-plan">
          <div className="agent-plan-title">
            <ListChecks size={14} aria-hidden="true" />
            {t("Plan")}
            <Token>
              {t("{done} of {total}", {
                done: item.entries.filter((entry) => entry.status === "done")
                  .length,
                total: item.entries.length,
              })}
            </Token>
          </div>
          <ul>
            {item.entries.map((entry, index) => (
              <li key={index} className={`is-${entry.status}`}>
                {entry.status === "done" ? (
                  <CircleCheck size={14} aria-label={t("Done")} />
                ) : entry.status === "in_progress" ? (
                  <Spinner size="sm" label={t("In progress")} />
                ) : (
                  <Circle size={14} aria-label={t("To do")} />
                )}
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "notice":
      return (
        <div
          className={`agent-notice is-${item.level}`}
          role={item.level === "error" ? "alert" : undefined}
        >
          {item.level === "error" ? (
            <CircleAlert size={14} aria-hidden="true" />
          ) : (
            <Info size={14} aria-hidden="true" />
          )}
          <span>{item.text}</span>
        </div>
      );
  }
}

/** One transcript item, following only its own changes in the store. */
export const AgentItemRow = memo(function AgentItemRow({
  store,
  id,
}: {
  store: AgentSessionStore;
  id: string;
}) {
  const item = useStore(store, (view) => view.session?.items[id]);
  if (!item) return null;
  return (
    <div className="agent-item" data-item={id} data-type={item.type}>
      <Item item={item} />
    </div>
  );
});
