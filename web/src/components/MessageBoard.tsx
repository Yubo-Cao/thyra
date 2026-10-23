import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mail } from "lucide-react";
import type {
  BoardMessage,
  MessageBoardList,
  UpdateBoardMessage,
} from "../../../shared/messageBoard";
import { usePrincipal } from "../principal";
import { bridge } from "../api";
import { t } from "../i18n";
import { useStoreSelector } from "../store";
import type { FileExplorerEntry } from "../types";
import { Button } from "./ui/Button";
import { Token } from "./ui/Token";
import { toastController } from "./ui/toastQueue";
import { Latched } from "./LazyBoundary";
import { lazyPanel } from "../lazyWithReload";
const messageBoardPanel = lazyPanel("message-board", () =>
  import("./MessageBoardDialog").then((module) => module.MessageBoardDialog),
);
const LazyMessageBoardDialog = messageBoardPanel.Component;
import "./MessageBoard.css";

type MessageBoardProps = {
  onOpenFile: (
    workspaceId: string,
    entry: FileExplorerEntry,
    paneId?: string,
  ) => void;
};

export function MessageBoard(props: MessageBoardProps) {
  const principal = usePrincipal();
  if (principal?.kind === "guest") return null;
  return <MessageBoardController key={JSON.stringify(principal)} {...props} />;
}

function MessageBoardController({ onOpenFile }: MessageBoardProps) {
  const [open, setOpen] = useState(false);
  const [archived, setArchived] = useState(false);
  const [messages, setMessages] = useState<BoardMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const request = useRef(0);
  const invalidateRequests = useCallback(() => {
    ++request.current;
  }, []);
  const seen = useRef(new Set<string>());
  const toasts = useRef<string[]>([]);
  useEffect(() => {
    const toastIds = toasts.current;
    return () => {
      for (const id of toastIds) toastController.close(id);
    };
  }, []);
  const scope = useStoreSelector(
    useShallow((s) => ({
      activeConnectionId: s.activeConnectionId,
      workspaces: s.workspaces,
    })),
  );
  const refresh = useCallback(
    async (next?: string) => {
      const generation = ++request.current;
      setLoading(true);
      try {
        const result: MessageBoardList = await bridge.call(
          "message_board.list",
          { archived, limit: 50, ...(next ? { cursor: next } : {}) },
        );
        if (generation !== request.current) return;
        setMessages((current) =>
          next
            ? [
                ...current,
                ...result.messages.filter(
                  (message) => !current.some((item) => item.id === message.id),
                ),
              ]
            : result.messages,
        );
        setUnread(result.unread_count);
        setCursor(result.next_cursor);
        setError("");
      } catch (cause) {
        if (generation === request.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (generation === request.current) setLoading(false);
      }
    },
    [archived],
  );
  useEffect(() => {
    const stopStatus = bridge.onStatus((status) => {
      if (status === "connected") void refresh();
    });
    const stopMessages = bridge.onMessageBoardCreated((id) => {
      if (!seen.current.has(id)) {
        seen.current.add(id);
        toasts.current.push(
          toastController.show(
            {
              title: t("An agent left you a message"),
              action: {
                label: t("Open message board"),
                onAction: () => {
                  setArchived(false);
                  setOpen(true);
                  void refresh();
                },
              },
            },
            { timeout: 0 },
          ),
        );
      }
      void refresh();
    });
    const stopUpdates = bridge.onMessageBoardUpdated(() => void refresh());
    return () => {
      stopUpdates();
      invalidateRequests();
      stopStatus();
      stopMessages();
    };
  }, [refresh, invalidateRequests]);
  const update = async (change: UpdateBoardMessage) => {
    setBusy(change.id);
    try {
      await bridge.call("message_board.update", change);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const show = () => {
    setOpen(true);
    void refresh();
  };
  return (
    <>
      <Button
        className="message-board-trigger"
        aria-label={t("Agent messages ({count} unread)", { count: unread })}
        onClick={show}
      >
        <Mail size={16} aria-hidden="true" />
        <span className="message-board-trigger-label">{t("Messages")}</span>
        {unread > 0 ? (
          <Token tone="accent">{unread > 99 ? "99+" : unread}</Token>
        ) : null}
      </Button>
      <Latched open={open}>
        <LazyMessageBoardDialog
          {...{
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
          }}
        />
      </Latched>
    </>
  );
}
