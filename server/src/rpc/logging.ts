import type { ServerWebSocket } from "bun";
import { logDetail } from "../connections/log-detail";
import type { Logger } from "../utils/logger";
import { rpcLogLevel } from "../utils/rpc-logging";
import { IMPORTANT_RPC_METHODS } from "./methods";

const SLOW_RPC_LOG_MS = 750;

/** A socket message parsed once; `null` when it was not JSON. */
export type ParsedRpcMessage = { value: unknown } | null;

export function parseRpcMessage(raw: string): ParsedRpcMessage {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return null;
  }
}

export function parseRpcMeta(message: ParsedRpcMessage): {
  id: string | null;
  method: string | null;
  connectionId: unknown;
  connectionGeneration: unknown;
} {
  try {
    if (!message) throw new Error("bad json");
    const msg = message.value as any;
    return {
      id: typeof msg?.id === "string" ? msg.id : null,
      method: typeof msg?.method === "string" ? msg.method : null,
      connectionId: Object.hasOwn(msg ?? {}, "connection_id")
        ? msg.connection_id
        : undefined,
      connectionGeneration: Object.hasOwn(msg ?? {}, "connection_generation")
        ? msg.connection_generation
        : undefined,
    };
  } catch {
    return {
      id: null,
      method: null,
      connectionId: undefined,
      connectionGeneration: undefined,
    };
  }
}

function shouldLogRpc(
  method: string | null,
  elapsedMs: number,
  failed: boolean,
) {
  if (!method) return failed;
  if (failed) return true;
  if (method === "bridge.ping" || method === "bridge.status") return false;
  if (
    method === "terminal.input" ||
    method === "terminal.key" ||
    method === "terminal.scroll" ||
    method === "terminal.frame_ack"
  )
    return false;
  if (method === "terminal.resize" && elapsedMs < SLOW_RPC_LOG_MS) return false;
  return IMPORTANT_RPC_METHODS.has(method) || elapsedMs >= SLOW_RPC_LOG_MS;
}

/** The completion log of one RPC: failures, slow calls and important methods. */
export function createRpcLogger(deps: {
  logger: Logger;
  clientLabel: (ws: ServerWebSocket<unknown>) => string;
}) {
  const { logger, clientLabel } = deps;
  return function logRpc(
    ws: ServerWebSocket<unknown>,
    method: string | null,
    startedAt: number,
    status: "ok" | "error",
    connectionId: string | null,
    detail?: string,
  ) {
    const elapsedMs = Date.now() - startedAt;
    const failed = status === "error";
    if (!shouldLogRpc(method, elapsedMs, failed)) return;
    const level = rpcLogLevel({ method, status, detail });
    logger[level]("rpc completed", {
      status,
      client: clientLabel(ws),
      method: method ? logDetail(method) : "unknown",
      connection: connectionId ? logDetail(connectionId) : undefined,
      duration_ms: elapsedMs,
      detail: detail ? logDetail(detail) : undefined,
    });
  };
}
