import { Check, Copy, Square, SquareCheck } from "lucide-react";
import type { Token, Tokens } from "marked";
import {
  createElement,
  Fragment,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  decodeMarkdownText,
  lexMarkdownStream,
  type MarkdownStream,
} from "../../agentSession/markdownStream";
import { t } from "../../i18n";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import { isSafeMarkdownUrl } from "../markdown";
import { IconButton } from "../ui/IconButton";

/** Code with a copy button: fenced blocks, commands, and tool input. */
export function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="agent-code">
      <pre>
        <code>{text}</code>
      </pre>
      <div className="agent-code-tools">
        {lang ? <span className="agent-code-lang">{lang}</span> : null}
        <IconButton
          label={copied ? t("Copied") : t("Copy code")}
          icon={copied ? <Check size={13} /> : <Copy size={13} />}
          onClick={() =>
            void copyTextFromUserGesture(text).then(
              () => setCopied(true),
              () => {},
            )
          }
        />
      </div>
    </div>
  );
}

/** How a run of plain text draws when not as itself (a prompt's images). */
type TextRun = (text: string) => ReactNode;

// Tokens render as React elements, never as HTML: text is escaped by React,
// raw HTML in a reply shows as text, links keep only safe addresses, and a
// growing reply patches the text nodes that changed.
function inline(
  tokens: readonly Token[] | undefined,
  run?: TextRun,
): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    switch (token.type) {
      case "text":
      case "escape": {
        const text = token as Tokens.Text;
        if (text.tokens)
          return <Fragment key={index}>{inline(text.tokens, run)}</Fragment>;
        const plain = decodeMarkdownText(text.text);
        return run ? <Fragment key={index}>{run(plain)}</Fragment> : plain;
      }
      case "strong":
        return <strong key={index}>{inline(token.tokens, run)}</strong>;
      case "em":
        return <em key={index}>{inline(token.tokens, run)}</em>;
      case "del":
        return <del key={index}>{inline(token.tokens, run)}</del>;
      case "codespan":
        return <code key={index}>{token.text}</code>;
      case "br":
        return <br key={index} />;
      case "link":
      case "image": {
        // Images stay links: loading one would call out to an address the
        // agent (or text it quoted) chose.
        const label =
          token.type === "link"
            ? inline(token.tokens, run)
            : token.text || token.href;
        return isSafeMarkdownUrl(token.href) ? (
          <a
            key={index}
            href={token.href}
            title={token.title ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
          >
            {label}
          </a>
        ) : (
          <Fragment key={index}>{label}</Fragment>
        );
      }
      case "html":
        return /^<br\s*\/?>$/i.test(token.text) ? (
          <br key={index} />
        ) : (
          token.text
        );
      default:
        return token.raw;
    }
  });
}

function blocks(
  tokens: readonly Token[] | undefined,
  run?: TextRun,
): ReactNode[] {
  return (tokens ?? []).map((token, index) => (
    <Fragment key={index}>{block(token, run)}</Fragment>
  ));
}

function block(token: Token, run?: TextRun): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading":
      return createElement(`h${token.depth}`, null, inline(token.tokens, run));
    case "paragraph":
      return <p>{inline(token.tokens, run)}</p>;
    case "text":
      return inline([token], run);
    case "code":
      return <CodeBlock text={token.text} lang={token.lang || undefined} />;
    case "blockquote":
      return <blockquote>{blocks(token.tokens, run)}</blockquote>;
    case "hr":
      return <hr />;
    case "checkbox":
      return token.checked ? (
        <SquareCheck
          className="agent-md-check"
          size={14}
          aria-label={t("Done")}
        />
      ) : (
        <Square className="agent-md-check" size={14} aria-label={t("To do")} />
      );
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        <li key={index} className={item.task ? "agent-md-task" : undefined}>
          {blocks(item.tokens, run)}
        </li>
      ));
      return list.ordered ? (
        <ol start={list.start === "" ? undefined : list.start}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      const cell = (item: Tokens.TableCell, index: number) =>
        createElement(
          item.header ? "th" : "td",
          { key: index, style: { textAlign: item.align ?? undefined } },
          inline(item.tokens, run),
        );
      return (
        <table>
          <thead>
            <tr>{table.header.map(cell)}</tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={index}>{row.map(cell)}</tr>
            ))}
          </tbody>
        </table>
      );
    }
    default:
      return <p>{token.raw}</p>;
  }
}

const MarkdownBlockView = memo(function MarkdownBlockView({
  token,
  run,
}: {
  token: Token;
  run?: TextRun;
}) {
  return block(token, run);
});

/**
 * A message as Markdown. While `streaming`, finished blocks keep their
 * elements and only the last block renders again as text arrives. `run`
 * draws its plain text (outside code), and must keep its identity.
 */
export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  streaming,
  run,
}: {
  text: string;
  streaming: boolean;
  run?: TextRun;
}) {
  const previous = useRef<MarkdownStream | undefined>(undefined);
  const stream = useMemo(
    () => lexMarkdownStream(text, streaming, previous.current),
    [text, streaming],
  );
  previous.current = stream;
  return (
    <div className="file-preview-markdown agent-md">
      {stream.blocks.map((item) => (
        <MarkdownBlockView key={item.start} token={item.token} run={run} />
      ))}
    </div>
  );
});
