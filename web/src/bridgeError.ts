import { t } from "./i18n";

/**
 * Why a bridge call failed. Code decides behavior; the message is translated
 * display text and must never be parsed.
 */
export type BridgeErrorCode =
  /** No open socket when the call was sent. */
  | "not_connected"
  /** The socket is open but its hello has not been accepted yet. */
  | "hello_unavailable"
  /** The connection's server runtime generation is not known yet. */
  | "runtime_generation_unavailable"
  /** The routing lease changed (connection switch or reconnect). */
  | "connection_changed"
  /** The socket closed, could not open, or stopped answering. */
  | "disconnected"
  /** The socket did not open before the connect deadline. */
  | "connect_timeout"
  /** The socket opened but no valid hello arrived before the deadline. */
  | "handshake_timeout"
  /** The heartbeat went unanswered and the socket was replaced. */
  | "heartbeat_timeout"
  /** The socket's send buffer overflowed and the socket was replaced. */
  | "send_buffer_full"
  /** The browser refused to send the frame. */
  | "send_failed"
  /** The user paused the connection. */
  | "paused"
  /** The browser session was logged out. */
  | "logged_out"
  /** The call reached the bridge but no reply arrived in time. */
  | "timeout"
  /** The caller aborted the call; any reply is dropped. */
  | "aborted"
  /** The call or its reply violated the bridge protocol. */
  | "protocol"
  /** The bridge or Herdr answered with an error. */
  | "rpc";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

/** A bridge failure whose message is English source text, translated late. */
export interface BridgeFailure {
  code: BridgeErrorCode;
  message: string;
}

export function bridgeErrorFrom(failure: BridgeFailure): BridgeError {
  return new BridgeError(failure.code, t(failure.message));
}

export function bridgeErrorCode(error: unknown): BridgeErrorCode | undefined {
  return error instanceof BridgeError ? error.code : undefined;
}
