import { Archive, Pin } from "lucide-react";
import type {
  BoardMessage,
  UpdateBoardMessage,
} from "../../../shared/messageBoard";
import { t, getLocale } from "../i18n";
import type { FileExplorerEntry } from "../types";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import "./MessageBoard.css";
export function safeMessageUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || url.protocol === "http:")
    )
      return url.href;
  } catch {
    /* Invalid artifact reference. */
  }
}

type Props = {
  open: boolean;
  setOpen: (open: boolean) => void;
  archived: boolean;
  setArchived: (archived: boolean) => void;
  messages: BoardMessage[];
  unread: number;
  cursor: string | null;
  loading: boolean;
  error: string;
  busy: string | null;
  refresh: (next?: string) => Promise<void>;
  update: (change: UpdateBoardMessage) => Promise<void>;
  scope: { activeConnectionId: string; workspaces: { workspace_id: string }[] };
  onOpenFile: (
    workspaceId: string,
    entry: FileExplorerEntry,
    paneId?: string,
  ) => void;
};
export function MessageBoardDialog({
  open,
  setOpen,
  archived,
  setArchived,
  messages,
  unread,
  cursor,
  loading,
  error,
  busy,
  refresh,
  update,
  scope,
  onOpenFile,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={t("Agent messages")}
      size="lg"
      placement="side"
      className="message-board-dialog"
      headerActions={
        <Button aria-pressed={archived} onClick={() => setArchived(!archived)}>
          {archived ? t("Show inbox") : t("Show archived")}
        </Button>
      }
    >
      <div className="message-board-toolbar">
        <span>{t("{count} unread messages", { count: unread })}</span>
        <Button disabled={loading} onClick={() => void refresh()}>
          {t("Refresh")}
        </Button>
      </div>
      {error ? (
        <div role="alert" className="message-board-error">
          {error}
        </div>
      ) : null}
      {loading && !messages.length ? (
        <p role="status">{t("Loading messages")}</p>
      ) : null}
      {!loading && !error && !messages.length ? (
        <p>{archived ? t("No archived messages") : t("No messages yet")}</p>
      ) : null}
      <div className="message-board-list">
        {messages.map((message) => (
          <article
            key={message.id}
            className={`message-board-card ${message.read_at === null ? "unread" : ""}`}
          >
            <div className="message-board-heading">
              <h3>{message.title}</h3>
              {message.pinned ? (
                <Pin size={15} aria-label={t("Pinned")} />
              ) : null}
            </div>
            <div className="message-board-meta">
              {message.author_label} ·{" "}
              <time dateTime={new Date(message.created_at).toISOString()}>
                {new Date(message.created_at).toLocaleString(getLocale())}
              </time>
              {message.read_at === null ? <span> · {t("Unread")}</span> : null}
            </div>
            {message.source ? (
              <div className="message-board-meta">
                {t("Message source")}:{" "}
                {[
                  message.source.connection_id,
                  message.source.workspace_id,
                  message.source.pane_id,
                ]
                  .filter(Boolean)
                  .join(" / ")}
              </div>
            ) : null}
            {message.updated_at !== message.created_at ? (
              <div className="message-board-meta">
                {t("Message updated")}:{" "}
                {new Date(message.updated_at).toLocaleString(getLocale())}
              </div>
            ) : null}
            <p className="message-board-body">{message.body}</p>
            {message.attachments.length ? (
              <ul className="message-board-attachments">
                {message.attachments.map((attachment, index) => {
                  if (attachment.kind === "url") {
                    const url = safeMessageUrl(attachment.url);
                    return (
                      <li key={index}>
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {attachment.label}
                          </a>
                        ) : (
                          <span>
                            {attachment.label} — {t("Unavailable")}
                          </span>
                        )}
                        {safeMessageUrl(attachment.preview_url) ? (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={safeMessageUrl(attachment.preview_url)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t("Preview")}
                            </a>
                          </>
                        ) : null}
                        {safeMessageUrl(attachment.download_url) ? (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={safeMessageUrl(attachment.download_url)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t("Download")}
                            </a>
                          </>
                        ) : null}
                      </li>
                    );
                  }
                  const source = message.source;
                  const available =
                    !!attachment.path &&
                    !!source?.workspace_id &&
                    !!source.connection_id &&
                    source.connection_id === scope.activeConnectionId &&
                    scope.workspaces.some(
                      (workspace) =>
                        workspace.workspace_id === source.workspace_id,
                    );
                  return (
                    <li key={index}>
                      <Button
                        disabled={!available}
                        onClick={() => {
                          if (
                            !available ||
                            !source?.workspace_id ||
                            !attachment.path
                          )
                            return;
                          onOpenFile(
                            source.workspace_id,
                            {
                              name:
                                attachment.path.split("/").pop() ||
                                attachment.label,
                              path: attachment.path,
                              type: "file",
                              size: 0,
                              mtime_ms: 0,
                              hidden: false,
                            },
                            source.pane_id,
                          );
                          setOpen(false);
                        }}
                      >
                        {attachment.label}
                      </Button>
                      {!available ? (
                        <span>
                          {t(
                            "File unavailable in the current workspace connection",
                          )}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <div className="message-board-actions">
              <Button
                disabled={busy !== null}
                aria-pressed={message.pinned}
                onClick={() =>
                  void update({ id: message.id, pinned: !message.pinned })
                }
              >
                <Pin size={13} />
                {message.pinned ? t("Unpin") : t("Pin")}
              </Button>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void update({
                    id: message.id,
                    read: message.read_at === null,
                  })
                }
              >
                {message.read_at === null ? t("Mark read") : t("Mark unread")}
              </Button>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void update({
                    id: message.id,
                    archived: message.archived_at === null,
                  })
                }
              >
                <Archive size={13} />
                {message.archived_at === null
                  ? t("Archive")
                  : t("Restore to inbox")}
              </Button>
            </div>
          </article>
        ))}
      </div>
      {cursor ? (
        <Button disabled={loading} onClick={() => void refresh(cursor)}>
          {t("Load more messages")}
        </Button>
      ) : null}
    </Dialog>
  );
}
