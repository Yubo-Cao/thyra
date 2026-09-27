import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeDataPath, dataRoot } from "../config/data-paths";
import { thyraEnv } from "../config/environment";
import { type Logger, silentLogger } from "../utils/logger";
import { createMcpActivityLog } from "./activity";
import { createMcpAuditLog } from "./audit";
import { createFilePolicy } from "./file-policy";
import {
  createMcpConnection,
  type McpConnection,
  type OperationClassifier,
  type ReadableRuntime,
} from "./gateway";
import { createMcpHttpService, type McpHttpService } from "./server";
import { createMcpTokenStore } from "./tokens";

export type McpConfig = {
  deny_files: string[];
  rate_limit_per_minute: number;
};

const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/**
 * Optional `mcp.json` in the data directory:
 * `{ "deny_files": ["*.sqlite"], "rate_limit_per_minute": 120 }`.
 * `THYRA_MCP_DENY_FILES` (comma-separated globs) adds patterns.
 */
export function loadMcpConfig(
  path = join(dataRoot(), "mcp.json"),
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  let raw: Record<string, unknown> = {};
  try {
    assertSafeDataPath(path);
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `invalid MCP config ${path}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  const deny = Array.isArray(raw.deny_files)
    ? raw.deny_files.filter((item): item is string => typeof item === "string")
    : [];
  const envDeny = (thyraEnv("MCP_DENY_FILES", env) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const rate = raw.rate_limit_per_minute;
  return {
    deny_files: [...deny, ...envDeny],
    rate_limit_per_minute:
      typeof rate === "number" && Number.isFinite(rate) && rate >= 1
        ? Math.floor(rate)
        : DEFAULT_RATE_LIMIT_PER_MINUTE,
  };
}

export type ThyraMcpService = McpHttpService & {
  recordHerdrEvent(connectionId: string, event: unknown): void;
  recordTaskEvent(
    connectionId: string,
    event: Parameters<
      ReturnType<typeof createMcpActivityLog>["recordTaskEvent"]
    >[1],
  ): void;
};

/** Wire tokens, audit, policy, and live connections into the /mcp route. */
export function createThyraMcpService<Runtime extends ReadableRuntime>(args: {
  version: string;
  readyRuntimes: () => Runtime[];
  defaultConnectionId: () => string;
  classify?: OperationClassifier;
  logger?: Logger;
}): ThyraMcpService {
  const logger = args.logger ?? silentLogger;
  let config: McpConfig;
  try {
    config = loadMcpConfig();
  } catch (error) {
    // Fail closed: a broken deny list must not silently widen access.
    logger.error("MCP disabled", { error: (error as Error).message });
    return {
      handle: async () =>
        Response.json(
          { error: "MCP is disabled: invalid mcp.json" },
          { status: 503 },
        ),
      close: async () => {},
      recordHerdrEvent: () => {},
      recordTaskEvent: () => {},
    };
  }
  const filePolicy = createFilePolicy(config.deny_files);
  const activity = createMcpActivityLog();
  const adapters = new WeakMap<
    Runtime,
    { connection: McpConnection; isDefault: boolean }
  >();
  const connections = () => {
    const defaultId = args.defaultConnectionId();
    return args.readyRuntimes().map((runtime) => {
      const isDefault = runtime.identity.id === defaultId;
      let cached = adapters.get(runtime);
      if (!cached || cached.isDefault !== isDefault) {
        cached = {
          connection: createMcpConnection(runtime, {
            isDefault,
            classify: args.classify,
          }),
          isDefault,
        };
        adapters.set(runtime, cached);
      }
      return cached.connection;
    });
  };
  const http = createMcpHttpService({
    version: args.version,
    tokens: createMcpTokenStore(),
    audit: createMcpAuditLog({
      onError: (error) =>
        logger.warn("MCP audit write failed", {
          error: (error as Error).message,
        }),
    }),
    rateLimitPerMinute: config.rate_limit_per_minute,
    context: (principal) => ({
      principal,
      connections,
      defaultConnectionId: args.defaultConnectionId,
      activity: () => activity.list(),
      filePolicy,
    }),
  });
  return {
    ...http,
    recordHerdrEvent: (connectionId, event) =>
      activity.recordHerdrEvent(connectionId, event),
    recordTaskEvent: (connectionId, event) =>
      activity.recordTaskEvent(connectionId, event),
  };
}
