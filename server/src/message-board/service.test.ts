import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccountDatabase } from "../accounts/database";
import { createMessageBoard } from "./service";
import { handleAgentBoard } from "./http";
const databases: ReturnType<typeof openAccountDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = openAccountDatabase(":memory:");
  databases.push(db);
  const events: unknown[] = [];
  const board = createMessageBoard(db, (...args) => events.push(args));
  return { db, board, events };
}
test("create validates, deduplicates, isolates owners, updates and paginates pins", () => {
  const { board, events } = setup();
  const a = board.execute("local", "agent", "create", {
    title: "First",
    body: "hello",
    idempotency_key: "retry",
  }) as { id: string };
  expect(
    board.execute("local", "agent", "create", {
      title: "Again",
      body: "hello",
      idempotency_key: "retry",
    }),
  ).toMatchObject({ id: a.id, title: "First" });
  expect(events).toHaveLength(1);
  expect(() =>
    board.execute("user:other", "agent", "get", { id: a.id }),
  ).toThrow("not found");
  const b = board.execute("local", "agent", "create", {
    title: "Pinned",
    body: "",
  }) as { id: string };
  board.execute("local", "agent", "update", {
    id: b.id,
    pinned: true,
    read: true,
  });
  const page = board.execute("local", "agent", "list", { limit: 1 }) as {
    messages: { id: string }[];
    next_cursor: string;
    unread_count: number;
  };
  expect(page.messages[0]?.id).toBe(b.id);
  expect(page.unread_count).toBe(1);
  const next = board.execute("local", "agent", "list", {
    limit: 1,
    cursor: page.next_cursor,
  }) as { messages: { id: string }[]; next_cursor: null };
  expect(next.messages[0]?.id).toBe(a.id);
  expect(next.next_cursor).toBeNull();
  board.execute("local", "agent", "update", { id: a.id, archived: true });
  expect(board.execute("local", "agent", "list", {})).toMatchObject({
    unread_count: 0,
  });
  expect(events.at(-1)).toEqual(["local", a.id, "updated"]);
  for (const params of [
    { title: "", body: "" },
    { title: "x", body: "a".repeat(32769) },
    { title: "x", body: "", owner_id: "victim" },
    {
      title: "x",
      body: "",
      attachments: [{ label: "bad", kind: "url", url: "javascript:alert(1)" }],
    },
    {
      title: "x",
      body: "",
      attachments: [
        {
          label: "bad",
          kind: "file",
          path: "/tmp/a",
          preview_url: "https://example.com",
        },
      ],
    },
  ])
    expect(() => board.execute("local", "a", "create", params)).toThrow();
});
test("credentials are scoped, hashed, expiring, revocable and invalid for missing owners", () => {
  const { db, board } = setup();
  const token = board.issue("local", {
    label: "test",
    scopes: ["create"],
    expires_at: Date.now() + 10000,
  });
  expect(board.authenticate(token.token, "create").owner_id).toBe("local");
  expect(() => board.authenticate(token.token, "list")).toThrow();
  expect(
    JSON.stringify(db.query("SELECT * FROM board_credentials").all()),
  ).not.toContain(token.token);
  board.revoke("local", token.id);
  expect(() => board.authenticate(token.token)).toThrow();
  const missing = board.issue("user:missing", {
    label: "test",
    scopes: ["create"],
    expires_at: Date.now() + 10000,
  });
  expect(() => board.authenticate(missing.token)).toThrow(
    "account unavailable",
  );
  const expired = board.issue("local", {
    label: "test",
    scopes: ["create"],
    expires_at: Date.now() + 10000,
  });
  db.run("UPDATE board_credentials SET expires_at=0 WHERE id=?", [expired.id]);
  expect(() => board.authenticate(expired.token)).toThrow();
});
test("durability survives closing and reopening database", () => {
  const dir = mkdtempSync(join(tmpdir(), "thyra-board-"));
  try {
    let db = openAccountDatabase(join(dir, "account.db"));
    const created = createMessageBoard(db).execute("local", "a", "create", {
      title: "Persist",
      body: "after session closure",
    }) as { id: string };
    db.close();
    db = openAccountDatabase(join(dir, "account.db"));
    expect(
      createMessageBoard(db).execute("local", "a", "get", { id: created.id }),
    ).toMatchObject({ title: "Persist" });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("agent HTTP rejects browser credentials, enforces scopes and bounded body", async () => {
  const { board } = setup();
  const token = board.issue("local", {
    label: "test",
    scopes: ["create", "list"],
    expires_at: Date.now() + 10000,
  }).token;
  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://thyra.test/api/agent/message-board", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
    });
  const response = await handleAgentBoard(
    request(
      JSON.stringify({
        method: "create",
        params: { title: "Remote", body: "persisted" },
      }),
    ),
    board,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { title: "Remote" } });
  expect(
    (
      await handleAgentBoard(
        request("{}", { origin: "https://thyra.test" }),
        board,
      )
    ).status,
  ).toBe(403);
  expect(
    (await handleAgentBoard(request("{}", { cookie: "session=abc" }), board))
      .status,
  ).toBe(403);
  expect(
    (
      await handleAgentBoard(
        request(JSON.stringify({ method: "update", params: {} })),
        board,
      )
    ).status,
  ).toBe(401);
  expect(
    (await handleAgentBoard(request("a".repeat(131073)), board)).status,
  ).toBe(413);
});
