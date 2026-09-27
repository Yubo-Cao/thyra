import {
  type McpHttpHandler,
  McpServer,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import type { McpAuditEntry, McpAuditLog } from "./audit";
import { summarizeAuditValue } from "./audit";
import { createRateLimiter } from "./rate-limit";
import type { McpPrincipal, McpTokenStore } from "./tokens";
import {
  MCP_TOOLS,
  type McpToolContext,
  type McpToolResult,
  runMcpTool,
} from "./tools";

export const MCP_SERVER_NAME = "thyra";
export const MCP_TRANSPORT_HEADER = "x-thyra-mcp-transport";
const MAX_REQUEST_BYTES = 256 * 1024;

const INSTRUCTIONS =
  "Read-only view of the owner's Herdr workspaces through Thyra. Start with list_workspaces or get_activity to find workspace and pane ids, then read pane output, agent sessions, Git state, or files. Nothing here can send input, run commands, or change files. Secrets are redacted and secret files are denied.";

export type ToolCaller = (
  name: string,
  args: unknown,
) => Promise<McpToolResult>;

/** Build an MCP server whose tools delegate to `callTool`. */
export function buildMcpServer(version: string, callTool: ToolCaller) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: "Thyra", version },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const result = await callTool(tool.name, args);
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      },
    );
  }
  return server;
}

function jsonError(status: number, message: string, headers?: HeadersInit) {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
    { status, headers },
  );
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** Browsers must not drive the MCP endpoint; agents send no Origin. */
function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

type PeekedRequest = { method: string; tool?: string; args?: unknown };

function peek(body: unknown): PeekedRequest[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) && typeof message === "object",
    )
    .map((message) => {
      const method =
        typeof message.method === "string" ? message.method : "response";
      const params =
        message.params && typeof message.params === "object"
          ? (message.params as Record<string, unknown>)
          : {};
      return method === "tools/call"
        ? {
            method,
            tool: typeof params.name === "string" ? params.name : undefined,
            args: params.arguments,
          }
        : { method };
    });
}

export type McpHttpService = {
  handle(req: Request, remoteAddress?: string | null): Promise<Response>;
  close(): Promise<void>;
};

export function createMcpHttpService(args: {
  version: string;
  tokens: Pick<McpTokenStore, "verify">;
  audit: McpAuditLog;
  /** Builds the tool context for one authenticated caller. */
  context: (principal: McpPrincipal) => McpToolContext;
  rateLimitPerMinute?: number;
  now?: () => number;
}): McpHttpService {
  const now = args.now ?? Date.now;
  const perToken = createRateLimiter({
    perMinute: args.rateLimitPerMinute ?? 120,
    burst: Math.max(10, Math.floor((args.rateLimitPerMinute ?? 120) / 2)),
    now,
  });
  const failedAuth = createRateLimiter({ perMinute: 20, burst: 10, now });

  const handler: McpHttpHandler = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as
        | {
            principal?: McpPrincipal;
            transport?: "http" | "stdio";
            remote?: string | null;
          }
        | undefined;
      const principal = extra?.principal;
      if (!principal) throw new Error("unauthenticated MCP request");
      const toolContext = args.context(principal);
      return buildMcpServer(args.version, async (name, toolArgs) => {
        const started = now();
        const result = await runMcpTool(name, toolArgs, toolContext);
        args.audit.record({
          ts: new Date(started).toISOString(),
          token_id: principal.tokenId,
          token_name: principal.name,
          transport: extra?.transport ?? "http",
          remote: extra?.remote ?? null,
          method: "tools/call",
          tool: name,
          args: summarizeAuditValue(toolArgs),
          status: result.isError ? "error" : "ok",
          ...(result.isError ? { detail: result.text } : {}),
          duration_ms: now() - started,
          bytes: Buffer.byteLength(result.text),
        });
        return result;
      });
    },
    { legacy: "stateless", maxRequestBodySize: MAX_REQUEST_BYTES },
  );

  return {
    async handle(req, remoteAddress) {
      const started = now();
      const transport =
        req.headers.get(MCP_TRANSPORT_HEADER) === "stdio" ? "stdio" : "http";
      const base = {
        transport,
        remote: remoteAddress ?? null,
      } as const;
      const audit = (
        entry: Omit<McpAuditEntry, "ts" | "duration_ms" | keyof typeof base>,
      ) =>
        args.audit.record({
          ts: new Date(started).toISOString(),
          ...base,
          ...entry,
          duration_ms: now() - started,
        });

      if (crossOrigin(req)) {
        audit({
          token_id: null,
          token_name: null,
          method: req.method,
          status: "denied",
          detail: "cross-origin request",
        });
        return jsonError(403, "cross-origin requests are not allowed");
      }
      const token = bearerToken(req);
      const principal = token ? args.tokens.verify(token) : null;
      if (!principal) {
        const addressKey = `addr:${remoteAddress ?? "unknown"}`;
        const wait = failedAuth.take(addressKey);
        audit({
          token_id: null,
          token_name: null,
          method: req.method,
          status: wait ? "rate_limited" : "unauthorized",
          detail: token ? "invalid token" : "missing bearer token",
        });
        if (wait) {
          return jsonError(429, "too many failed attempts", {
            "retry-after": String(wait),
          });
        }
        return jsonError(401, "a Thyra MCP bearer token is required", {
          "www-authenticate": 'Bearer realm="thyra-mcp"',
        });
      }
      const identity = {
        token_id: principal.tokenId,
        token_name: principal.name,
      };
      const wait = perToken.take(principal.tokenId);
      if (wait) {
        audit({ ...identity, method: req.method, status: "rate_limited" });
        return jsonError(429, "MCP rate limit exceeded", {
          "retry-after": String(wait),
        });
      }

      let parsedBody: unknown;
      if (req.method === "POST") {
        const length = Number(req.headers.get("content-length") ?? 0);
        if (length > MAX_REQUEST_BYTES) {
          return jsonError(413, "request body too large");
        }
        const text = await req.text();
        if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) {
          return jsonError(413, "request body too large");
        }
        try {
          parsedBody = JSON.parse(text);
        } catch {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            },
            { status: 400 },
          );
        }
        // Tool calls are audited with their outcome by the tool wrapper.
        for (const message of peek(parsedBody)) {
          if (message.method === "tools/call") continue;
          if (message.method.startsWith("notifications/")) continue;
          audit({ ...identity, method: message.method, status: "ok" });
        }
        req = new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: text,
        });
      }
      return handler.fetch(req, {
        authInfo: {
          token: "",
          clientId: principal.tokenId,
          scopes: [],
          extra: { principal, ...base },
        },
        ...(parsedBody !== undefined ? { parsedBody } : {}),
      });
    },
    close: () => handler.close(),
  };
}
