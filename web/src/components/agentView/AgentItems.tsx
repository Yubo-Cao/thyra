import {
  Bot,
  Check,
  Copy,
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
  useEffect,
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
import {
  splitPromptImages,
  unplacedPromptImages,
} from "../../agentSession/promptImages";
import type { AgentSessionStore } from "../../agentSession/session";
import { t } from "../../i18n";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import { composerImageToken } from "../../terminalComposer";
import { openImageViewer } from "../promptEditor/imageViewer";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Spinner } from "../ui/Spinner";
import { Token } from "../ui/Token";
import { AgentMarkdown, CodeBlock } from "./AgentMarkdown";
import {
  diffSides,
  renderHighlighted,
  spansByLine,
  useHighlight,
} from "./highlightSpans";
import { installTranscriptCopy } from "./transcriptCopy";

// A selection copied from the transcript reads as Markdown when pasted.
installTranscriptCopy();

type Tool = Extract<AgentItem, { type: "tool" }>;

/** What rows share: which are open (kept while they scroll out), where a prompt's images load from, and file opening. */
export const AgentViewContext = createContext<{
  expanded: Map<string, boolean>;
  /** The address of an image at `path` on the agent's host. */
  imageUrl?: (path: string) => string | null;
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
  const shown = useMemo(
    () => parsed.lines.slice(0, DIFF_LINE_LIMIT),
    [parsed.lines],
  );
  // Coloured by the file's language, each side parsed as its own file.
  const sides = useMemo(() => diffSides(shown), [shown]);
  const nextSpans = useHighlight(sides.next, diff.path);
  const prevSpans = useHighlight(sides.prev, diff.path);
  const lineSpans = useMemo(
    () => ({
      next: nextSpans ? spansByLine(sides.next, nextSpans) : null,
      prev: prevSpans ? spansByLine(sides.prev, prevSpans) : null,
    }),
    [sides, nextSpans, prevSpans],
  );
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
        <div className="agent-diff-lines" data-md-code="diff">
          {shown.map((line, index) => {
            const at = sides.at[index];
            return (
              <div key={index} className={`agent-diff-line is-${line.kind}`}>
                <span className="agent-diff-number" data-md-skip="">
                  {line.line ?? ""}
                </span>
                <span className="agent-diff-sign">
                  {line.kind === "add"
                    ? "+"
                    : line.kind === "remove"
                      ? "-"
                      : line.kind === "context"
                        ? " "
                        : ""}
                </span>
                <span>
                  {renderHighlighted(
                    line.text,
                    at ? lineSpans[at.side]?.[at.line] : null,
                  )}
                </span>
              </div>
            );
          })}
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
          {item.command ? (
            <CodeBlock text={item.command} syntax="bash" />
          ) : null}
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

/**
 * An image sent with a prompt; a click shows it full size. Its placeholder
 * stands in when it does not load: the file is gone from the host, or is
 * not this viewer's to read.
 */
function PromptImage({ path, number }: { path: string; number: number }) {
  const { imageUrl } = useContext(AgentViewContext);
  const [failed, setFailed] = useState(false);
  const src = imageUrl?.(path);
  const name = t("Image {number}", { number });
  if (!src || failed)
    return (
      <span
        className="agent-user-image-missing"
        title={t("This image is not available")}
      >
        {composerImageToken(number)}
      </span>
    );
  return (
    <Button
      className="agent-user-image"
      onClick={(event) => {
        const button = event.currentTarget;
        openImageViewer(src, name, () => button.focus());
      }}
    >
      <img
        src={src}
        alt={name}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </Button>
  );
}

/** A prompt as Markdown, each image where its placeholder stands. */
function UserMessage({ item }: { item: Extract<AgentItem, { type: "user" }> }) {
  const { text, images } = item;
  const run = useMemo(
    () =>
      images?.length
        ? (plain: string) =>
            splitPromptImages(plain, images.length).map((part, index) =>
              typeof part === "string" ? (
                part
              ) : (
                <PromptImage
                  key={index}
                  path={images[part].path}
                  number={part + 1}
                />
              ),
            )
        : undefined,
    [images],
  );
  // Images no placeholder shows follow the text.
  const rest = useMemo(
    () => (images?.length ? unplacedPromptImages(text, images.length) : []),
    [images, text],
  );
  return (
    <div className="agent-user">
      <AgentMarkdown text={text} streaming={false} run={run} />
      {rest.length ? (
        <div className="agent-user-images">
          {rest.map((index) => (
            <PromptImage
              key={index}
              path={images![index].path}
              number={index + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A reply, with a button that copies its Markdown source once it is done. */
function AssistantMessage({
  item,
}: {
  item: Extract<AgentItem, { type: "assistant" }>;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <AgentMarkdown text={item.text} streaming={item.streaming} />
      {item.streaming || !item.text.trim() ? null : (
        <div className="agent-message-tools" data-md-skip="">
          <IconButton
            label={copied ? t("Copied") : t("Copy as Markdown")}
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
            onClick={() =>
              void copyTextFromUserGesture(item.text).then(
                () => setCopied(true),
                () => {},
              )
            }
          />
        </div>
      )}
    </>
  );
}

function Item({ item }: { item: AgentItem }) {
  switch (item.type) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantMessage item={item} />;
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
