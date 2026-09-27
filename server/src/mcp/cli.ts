import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { thyraEnv } from "../config/environment";
import {
  MCP_TRANSPORT_HEADER,
  type ToolCaller,
  buildMcpServer,
} from "./server";
import {
  createMcpTokenStore,
  formatScope,
  type McpTokenStore,
  parseScope,
} from "./tokens";

function mcpHelp(): string {
  return `Read-only MCP (Model Context Protocol) access to Thyra workspaces.

Usage:
  thyra mcp [--url <url>] [--token-file <path>]
  thyra mcp token create --name <name> --scope <all|w1,w2,conn/w3>
  thyra mcp token list
  thyra mcp token revoke <id|name>

\`thyra mcp\` serves MCP over stdio for local agents and forwards each tool
call to a running Thyra at --url (env THYRA_MCP_URL, default
http://127.0.0.1:$PORT/mcp with PORT defaulting to 8787). It authenticates with
the token in THYRA_MCP_TOKEN or --token-file.

Remote agents connect to the running server's /mcp endpoint over Streamable
HTTP with "Authorization: Bearer <token>".

Token scope \`all\` covers every workspace on every connection. A list of
workspace ids limits the token to those workspaces: an unqualified id (w1)
refers to the default connection, \`<connection-id>/w1\` to another one.
Tokens are stored hashed; the plaintext is shown only when created.
`;
}

export type McpCommandDeps = {
  store?: () => Pick<McpTokenStore, "create" | "list" | "revoke" | "path">;
  serveStdio?: (callTool: ToolCaller, version: string) => Promise<void>;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/** Parse a JSON or SSE response body from the MCP endpoint. */
function parseEndpointResponse(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    let last: unknown = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        last = JSON.parse(line.slice(5).trim());
      } catch {
        // Keep the last complete message.
      }
    }
    return last;
  }
  return JSON.parse(text);
}

/** Forward one tool call to a running Thyra's HTTP MCP endpoint. */
export function createRemoteToolCaller(args: {
  url: string;
  token: string;
  fetch?: typeof fetch;
}): ToolCaller {
  const doFetch = args.fetch ?? fetch;
  let nextId = 1;
  return async (name, toolArgs) => {
    let response: Response;
    try {
      response = await doFetch(args.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${args.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          [MCP_TRANSPORT_HEADER]: "stdio",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: toolArgs ?? {} },
        }),
      });
    } catch (error) {
      return {
        text: `Thyra is not reachable at ${args.url}: ${(error as Error).message}`,
        isError: true,
      };
    }
    const text = await response.text();
    let message: any;
    try {
      message = parseEndpointResponse(
        response.headers.get("content-type") ?? "",
        text,
      );
    } catch {
      message = null;
    }
    if (!response.ok || !message || message.error) {
      const detail =
        message?.error?.message ?? (text.slice(0, 200) || response.statusText);
      return {
        text: `Thyra MCP endpoint error (HTTP ${response.status}): ${detail}`,
        isError: true,
      };
    }
    const content = Array.isArray(message.result?.content)
      ? message.result.content
      : [];
    return {
      text: content
        .filter((item: any) => item?.type === "text")
        .map((item: any) => String(item.text))
        .join("\n"),
      isError: message.result?.isError === true,
    };
  };
}

async function serveStdioDefault(callTool: ToolCaller, version: string) {
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  const handle = serveStdio(() => buildMcpServer(version, callTool), {
    onerror: (error) => console.error(`[thyra mcp] ${error.message}`),
  });
  await closed;
  await handle.close();
}

function readTokenFile(path: string): string {
  return readFileSync(path, "utf8").trim();
}

/**
 * Handle `thyra mcp ...`. Returns null when argv is not an MCP command,
 * matching the other subcommand conventions.
 */
export async function runMcpCommand(
  argv: string[],
  appVersion: string,
  deps: McpCommandDeps = {},
): Promise<number | null> {
  if (argv[0] !== "mcp") return null;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const env = deps.env ?? process.env;
  const action = argv[1];
  if (action === "help" || action === "--help" || action === "-h") {
    log(mcpHelp());
    return 0;
  }

  if (action === "token") {
    const store = (deps.store ?? (() => createMcpTokenStore()))();
    const sub = argv[2];
    try {
      if (sub === "create") {
        const { values } = parseArgs({
          args: argv.slice(3),
          options: {
            name: { type: "string" },
            scope: { type: "string" },
          },
          strict: true,
          allowPositionals: false,
        });
        if (!values.name || !values.scope) {
          error("thyra mcp token create requires --name and --scope");
          return 2;
        }
        const { token, record } = store.create({
          name: values.name,
          scope: parseScope(values.scope),
        });
        log(
          `Created MCP token "${record.name}" (id ${record.id}, scope ${formatScope(parseScope(record.scope))}).`,
        );
        log("Store it now; it is not shown again:");
        log(token);
        return 0;
      }
      if (sub === "list") {
        const records = store.list();
        if (records.length === 0) {
          log(`No MCP tokens (${store.path}).`);
          return 0;
        }
        for (const record of records) {
          log(
            `${record.id}  ${record.name}  scope=${formatScope(parseScope(record.scope))}  created=${record.created_at}`,
          );
        }
        return 0;
      }
      if (sub === "revoke") {
        const target = argv[3];
        if (!target || argv.length > 4) {
          error("usage: thyra mcp token revoke <id|name>");
          return 2;
        }
        const removed = store.revoke(target);
        if (removed.length === 0) {
          error(`no MCP token matches ${target}`);
          return 1;
        }
        for (const record of removed) {
          log(`Revoked MCP token "${record.name}" (id ${record.id}).`);
        }
        return 0;
      }
      error("usage: thyra mcp token <create|list|revoke>");
      return 2;
    } catch (cause) {
      error(`thyra mcp token: ${(cause as Error).message}`);
      return 1;
    }
  }

  if (action !== undefined && action !== "stdio" && !action.startsWith("-")) {
    error(`unknown mcp action: ${action}\n\n${mcpHelp()}`);
    return 2;
  }
  let values: { url?: string; "token-file"?: string };
  try {
    values = parseArgs({
      args: argv.slice(action === "stdio" ? 2 : 1),
      options: {
        url: { type: "string" },
        "token-file": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (cause) {
    error(`thyra mcp: ${(cause as Error).message}`);
    return 2;
  }
  const url =
    values.url ??
    thyraEnv("MCP_URL", env) ??
    `http://127.0.0.1:${env.PORT || 8787}/mcp`;
  let token: string | undefined;
  try {
    token = values["token-file"]
      ? readTokenFile(values["token-file"])
      : thyraEnv("MCP_TOKEN", env)?.trim();
  } catch (cause) {
    error(`thyra mcp: cannot read token file: ${(cause as Error).message}`);
    return 1;
  }
  if (!token) {
    error(
      "thyra mcp: set THYRA_MCP_TOKEN or pass --token-file (create one with `thyra mcp token create`)",
    );
    return 2;
  }
  const callTool = createRemoteToolCaller({ url, token, fetch: deps.fetch });
  await (deps.serveStdio ?? serveStdioDefault)(callTool, appVersion);
  return 0;
}
