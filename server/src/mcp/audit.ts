import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeDataPath, dataRoot } from "../config/data-paths";
import { thyraEnv } from "../config/environment";
import { redactText } from "./redact";

/** One MCP request outcome, appended as a JSON line. */
export type McpAuditEntry = {
  ts: string;
  token_id: string | null;
  token_name: string | null;
  transport: "http" | "stdio";
  remote: string | null;
  method: string;
  tool?: string;
  args?: string;
  status: "ok" | "error" | "denied" | "unauthorized" | "rate_limited";
  detail?: string;
  duration_ms: number;
  bytes?: number;
};

const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_CHARS = 300;

export function defaultMcpAuditPath(): string {
  const override = thyraEnv("MCP_AUDIT_PATH")?.trim();
  const path = override || join(dataRoot(), "mcp-audit.jsonl");
  assertSafeDataPath(path);
  return path;
}

/** Arguments are summarized, redacted, and truncated before logging. */
export function summarizeAuditValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = redactText(text).replace(/[\u0000-\u001f\u007f]/g, " ");
  return text.length > MAX_FIELD_CHARS
    ? `${text.slice(0, MAX_FIELD_CHARS)}...`
    : text;
}

export type McpAuditLog = {
  record(entry: McpAuditEntry): void;
};

export function createMcpAuditLog(
  args: {
    path?: string;
    maxBytes?: number;
    onError?: (error: unknown) => void;
  } = {},
): McpAuditLog {
  const path = args.path ?? defaultMcpAuditPath();
  const maxBytes = args.maxBytes ?? MAX_AUDIT_BYTES;
  return {
    record(entry) {
      try {
        assertSafeDataPath(path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const line = `${JSON.stringify({
          ...entry,
          detail: summarizeAuditValue(entry.detail),
        })}\n`;
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {
          size = 0;
        }
        // Keep one rotated generation so the log stays bounded.
        if (size > 0 && size + line.length > maxBytes) {
          const previous = `${path}.1`;
          rmSync(previous, { force: true });
          renameSync(path, previous);
        }
        appendFileSync(path, line, { mode: 0o600 });
      } catch (error) {
        args.onError?.(error);
      }
    },
  };
}
