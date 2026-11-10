import type { ConnectionClient } from "./api";

type FrameAckClient = Pick<ConnectionClient, "call" | "supports" | "notify">;

/**
 * Tells the bridge a frame arrived, which makes room for the next one in the
 * viewer's frame window. Sent one-way when the bridge accepts that: no reply
 * to wait for, parse or time out. An acknowledgement that is lost is covered
 * by the bridge's own acknowledgement timeout.
 */
export function acknowledgeTerminalFrame(
  client: FrameAckClient,
  terminalId: string,
  seq: number,
): void {
  const params = { terminal_id: terminalId, seq };
  if (
    client.supports?.("terminal_frame_ack_notify") &&
    client.notify?.("terminal.frame_ack", params)
  )
    return;
  void client.call("terminal.frame_ack", params).catch(() => {});
}

/**
 * Asks the bridge to restart a terminal's stream from a full frame. This
 * stays a request on every bridge: it is rare, and its retry timer covers a
 * lost one.
 */
export function requestTerminalResync(
  client: FrameAckClient,
  terminalId: string,
): void {
  void client
    .call("terminal.frame_ack", { terminal_id: terminalId, resync: true })
    .catch(() => {});
}
