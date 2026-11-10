import type {
  BoardMessage,
  MessageBoardList,
  UpdateBoardMessage,
} from "../../shared/messageBoard";

export const MESSAGE_BOARD_PAGE_SIZE = 50;
/** The most `message_board.list` returns in one call. */
export const MESSAGE_BOARD_MAX_PAGE_SIZE = 100;

export type MessageBoardPages = {
  messages: BoardMessage[];
  cursor: string | null;
};

/**
 * How many messages a refresh asks for: as many as are shown, so reloading
 * after "Load more" does not shrink the list under the reader.
 */
export function messageBoardRefreshLimit(shown: number): number {
  return Math.min(
    MESSAGE_BOARD_MAX_PAGE_SIZE,
    Math.max(MESSAGE_BOARD_PAGE_SIZE, shown),
  );
}

/** Adds the next page after the messages already shown. */
export function appendMessageBoardPage(
  current: MessageBoardPages,
  page: Pick<MessageBoardList, "messages" | "next_cursor">,
): MessageBoardPages {
  const shown = new Set(current.messages.map((message) => message.id));
  return {
    messages: [
      ...current.messages,
      ...page.messages.filter((message) => !shown.has(message.id)),
    ],
    cursor: page.next_cursor,
  };
}

/**
 * Replaces the head of the list with a fresh first page. Messages loaded
 * beyond what the page covers stay, with the cursor that continues after
 * them: dropping them shortened the list and threw the reader back to the
 * top on every update. They go only when the fresh page no longer lines up
 * with what was shown.
 */
export function refreshMessageBoardPages(
  current: MessageBoardPages,
  page: Pick<MessageBoardList, "messages" | "next_cursor">,
): MessageBoardPages {
  const fresh = { messages: page.messages, cursor: page.next_cursor };
  const last = page.messages[page.messages.length - 1];
  // The page is the whole board, or nothing was shown past it.
  if (!page.next_cursor || !last) return fresh;
  const boundary = current.messages.findIndex(
    (message) => message.id === last.id,
  );
  if (boundary < 0) return fresh;
  const head = new Set(page.messages.map((message) => message.id));
  const rest = current.messages
    .slice(boundary + 1)
    .filter((message) => !head.has(message.id));
  if (rest.length === 0) return fresh;
  return { messages: [...page.messages, ...rest], cursor: current.cursor };
}

/**
 * Applies a saved change to the messages shown, so one kept from a later
 * page (which a refresh does not reload) is not left stale. A message whose
 * archived state changed leaves the list: it belongs to the other tab now.
 */
export function applyMessageBoardChange(
  messages: BoardMessage[],
  change: UpdateBoardMessage,
  now = Date.now(),
): BoardMessage[] {
  if (change.archived !== undefined)
    return messages.filter((message) => message.id !== change.id);
  return messages.map((message) =>
    message.id === change.id
      ? {
          ...message,
          ...(change.pinned === undefined ? {} : { pinned: change.pinned }),
          ...(change.read === undefined
            ? {}
            : { read_at: change.read ? (message.read_at ?? now) : null }),
        }
      : message,
  );
}
