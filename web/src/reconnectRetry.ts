import { type BridgeErrorCode, bridgeErrorCode } from "./bridgeError";

/**
 * Focus-style actions (workspace/tab/pane switches) fired while the bridge
 * socket is reconnecting fail before reaching the server. These errors are
 * safe to retry once the connection is back because the underlying Herdr
 * focus calls are idempotent. The decision uses the typed error code only:
 * messages are translated for display and differ per locale.
 */
const RECONNECT_RETRYABLE_CODES: ReadonlySet<BridgeErrorCode> = new Set([
  "not_connected",
  "hello_unavailable",
  "runtime_generation_unavailable",
  "connection_changed",
  "disconnected",
  "connect_timeout",
  "handshake_timeout",
  "heartbeat_timeout",
]);

export function isReconnectRetryableError(error: unknown): boolean {
  const code = bridgeErrorCode(error);
  return code !== undefined && RECONNECT_RETRYABLE_CODES.has(code);
}
