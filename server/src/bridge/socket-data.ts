import type { ServerWebSocket } from "bun";
import type { Principal } from "../auth/principal";
import type { ClientContext } from "../identity/identity-service";

/** What an upgrade attaches to its socket (`ws.data`). */
export type SocketData = {
  /** Fixed at upgrade: who the socket acts for on its listener. */
  principal: Principal;
  client?: ClientContext;
  clientSession: string | null;
  /**
   * The tailnet listener's origin, offered in the hello to account sessions
   * on the public listener so a page on a tailnet device can move there.
   */
  directOrigin: string | null;
  /**
   * The hello offers the peer-to-peer transport (public listener only). An
   * RTC socket copies its negotiating socket's data with this off.
   */
  rtc: boolean;
  /** An agent-browser VNC socket and the device scale its viewer wants. */
  vnc?: { scale: number };
  /** A VS Code remote socket and the request it opens upstream. */
  vscode?: { req: Request; url: URL };
};

export function isRtcSocket(ws: ServerWebSocket<unknown>): boolean {
  return (ws as { transport?: string }).transport === "rtc";
}
