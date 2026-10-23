import { createInterface } from "node:readline";
import { defaultDatabasePath, openAccountDatabase } from "../accounts/database";
import { createMessageBoard } from "./service";

const schemas = [
  {
    name: "leave_message",
    description:
      "Persist a message in the owner's inbox. Use update_message to pin it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        author_label: { type: "string" },
        idempotency_key: { type: "string" },
        source: {
          type: "object",
          properties: {
            connection_id: { type: "string" },
            workspace_id: { type: "string" },
            pane_id: { type: "string" },
          },
          additionalProperties: false,
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              kind: { enum: ["url", "file"] },
              url: { type: "string" },
              path: { type: "string" },
              preview_url: { type: "string" },
              download_url: { type: "string" },
            },
            required: ["label", "kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "list_messages",
    description: "List persisted messages and unread count.",
    inputSchema: {
      type: "object",
      properties: {
        archived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_message",
    description: "Pin, read, or archive an existing message.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        pinned: { type: "boolean" },
        read: { type: "boolean" },
        archived: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
const methods: Record<string, string> = {
  leave_message: "create",
  list_messages: "list",
  update_message: "update",
};
async function remote(method: string, params: unknown) {
  const base = process.env.THYRA_BOARD_URL,
    token = process.env.THYRA_BOARD_TOKEN;
  if (!base || !token)
    throw new Error("set THYRA_BOARD_URL and THYRA_BOARD_TOKEN");
  const url = new URL("/api/agent/message-board", base);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("agent API requires HTTPS (except loopback)");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const body = (await response.json()) as {
    result?: unknown;
    error?: { code?: string; message: string };
  };
  if (!response.ok || body.error)
    throw new Error(
      JSON.stringify(
        body.error ?? {
          code: "http_error",
          message: `HTTP ${response.status}`,
        },
      ),
    );
  return body.result;
}
function toolError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message);
    if (
      parsed &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    )
      return parsed;
  } catch {}
  return { code: "transport_error", message };
}
export async function runMessageBoardCommand(
  args: string[],
): Promise<number | null> {
  if (args[0] !== "message-board") return null;
  try {
    if (
      args[1] === "token-issue" ||
      args[1] === "token-revoke" ||
      args[1] === "tokens"
    ) {
      const db = openAccountDatabase(defaultDatabasePath());
      try {
        const board = createMessageBoard(db),
          owner = args[2];
        if (!owner || !(owner === "local" || owner.startsWith("user:")))
          throw new Error("specify owner: local or user:<id>");
        const result =
          args[1] === "token-issue"
            ? board.issue(owner, JSON.parse(args[3] ?? "{}"))
            : args[1] === "tokens"
              ? board.credentials(owner)
              : board.revoke(owner, args[3]);
        console.log(JSON.stringify(result));
      } finally {
        db.close();
      }
      return 0;
    }
    if (args[1] !== "mcp") {
      const method = Object.hasOwn(methods, args[1] ?? "")
        ? methods[args[1]!]
        : args[1];
      if (!method)
        throw new Error(
          "expected mcp, leave_message, list_messages, update_message, token-issue, tokens, or token-revoke",
        );
      console.log(
        JSON.stringify(await remote(method, JSON.parse(args[2] ?? "{}"))),
      );
      return 0;
    }
    for await (const line of createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })) {
      let request: {
        id?: string | number;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      try {
        request = JSON.parse(line);
      } catch {
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        continue;
      }
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        (request as unknown as { jsonrpc: unknown }).jsonrpc !== "2.0" ||
        typeof request.method !== "string" ||
        (request.id !== undefined &&
          typeof request.id !== "string" &&
          typeof request.id !== "number")
      ) {
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request" },
          }),
        );
        continue;
      }
      if (request.id === undefined) continue;
      let result: unknown;
      try {
        if (request.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "thyra-message-board", version: "1.0.0" },
          };
        else if (request.method === "ping") result = {};
        else if (request.method === "tools/list") result = { tools: schemas };
        else if (request.method === "tools/call") {
          const name = request.params?.name ?? "",
            method = Object.hasOwn(methods, name) ? methods[name] : undefined;
          if (!method) throw new Error("unknown tool");
          try {
            const value = await remote(method, request.params?.arguments ?? {});
            result = {
              content: [{ type: "text", text: JSON.stringify(value) }],
            };
          } catch (error) {
            result = {
              isError: true,
              content: [
                { type: "text", text: JSON.stringify(toolError(error)) },
              ],
            };
          }
        } else {
          console.log(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
          continue;
        }
        console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      } catch (error) {
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32602, message: (error as Error).message },
          }),
        );
      }
    }
    return 0;
  } catch (error) {
    console.error(JSON.stringify(toolError(error)));
    return 1;
  }
}
