import { describe, expect, test } from "bun:test";
import type { BoardMessage } from "../../shared/messageBoard";
import {
  appendMessageBoardPage,
  applyMessageBoardChange,
  messageBoardRefreshLimit,
  refreshMessageBoardPages,
} from "./messageBoardList";

const message = (id: string, extra: Partial<BoardMessage> = {}) =>
  ({
    id,
    owner_id: "o",
    title: id,
    body: "",
    author_label: "agent",
    created_at: 0,
    updated_at: 0,
    pinned: false,
    read_at: null,
    archived_at: null,
    attachments: [],
    ...extra,
  }) satisfies BoardMessage;
const ids = (messages: BoardMessage[]) => messages.map((item) => item.id);
const list = (...names: string[]) => names.map((name) => message(name));

describe("message board paging", () => {
  test("a refresh asks for as much as is shown, within the server's limit", () => {
    expect(messageBoardRefreshLimit(0)).toBe(50);
    expect(messageBoardRefreshLimit(73)).toBe(73);
    expect(messageBoardRefreshLimit(240)).toBe(100);
  });

  test("load more appends without repeating a message", () => {
    const next = appendMessageBoardPage(
      { messages: list("a", "b"), cursor: "c1" },
      { messages: list("b", "c"), next_cursor: "c2" },
    );
    expect(ids(next.messages)).toEqual(["a", "b", "c"]);
    expect(next.cursor).toBe("c2");
  });

  test("a refresh keeps the pages loaded past it, and their cursor", () => {
    const current = { messages: list("a", "b", "c", "d", "e"), cursor: "c5" };
    // A new message arrived and the page ends where "b" was shown.
    const next = refreshMessageBoardPages(current, {
      messages: [message("new"), message("a", { read_at: 5 }), message("b")],
      next_cursor: "c2",
    });
    expect(ids(next.messages)).toEqual(["new", "a", "b", "c", "d", "e"]);
    expect(next.messages[1]!.read_at).toBe(5);
    expect(next.cursor).toBe("c5");
  });

  test("a message that moved to the head is not shown twice", () => {
    const next = refreshMessageBoardPages(
      { messages: list("a", "b", "c", "d"), cursor: null },
      { messages: list("d", "a", "b"), next_cursor: "c3" },
    );
    expect(ids(next.messages)).toEqual(["d", "a", "b", "c"]);
  });

  test("a complete or unrelated page replaces the list", () => {
    const current = { messages: list("a", "b", "c"), cursor: "c3" };
    expect(
      refreshMessageBoardPages(current, {
        messages: list("a"),
        next_cursor: null,
      }),
    ).toEqual({ messages: list("a"), cursor: null });
    expect(
      refreshMessageBoardPages(current, {
        messages: list("x", "y"),
        next_cursor: "c9",
      }),
    ).toEqual({ messages: list("x", "y"), cursor: "c9" });
    expect(
      refreshMessageBoardPages(current, { messages: [], next_cursor: null }),
    ).toEqual({ messages: [], cursor: null });
  });

  test("a saved change reaches messages a refresh does not reload", () => {
    const shown = list("a", "b");
    expect(
      ids(applyMessageBoardChange(shown, { id: "b", archived: true })),
    ).toEqual(["a"]);
    const read = applyMessageBoardChange(shown, { id: "b", read: true }, 9);
    expect(read[1]!.read_at).toBe(9);
    expect(read[0]).toBe(shown[0]!);
    expect(
      applyMessageBoardChange(read, { id: "b", read: false })[1]!.read_at,
    ).toBeNull();
    expect(
      applyMessageBoardChange(shown, { id: "a", pinned: true })[0]!.pinned,
    ).toBe(true);
  });
});
