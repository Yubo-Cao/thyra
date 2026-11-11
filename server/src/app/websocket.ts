import type { ServerWebSocket, WebSocketHandler } from "bun";
import { isInstanceAdmin, principalView } from "../auth/principal";
import type { ClientRegistry } from "../bridge/client-registry";
import {
  createRtcTransport,
  type RtcConfig,
  type RtcSocket,
} from "../bridge/rtc-transport";
import { isRtcSocket, type SocketData } from "../bridge/socket-data";
import {
  flushCoalescedMessages,
  WS_PER_MESSAGE_DEFLATE,
} from "../bridge/websocket-send";
import type { AgentBrowser, VncPeer } from "../browser/agent-browser";
import { createKeyedSerialQueue } from "../connections/keyed-serial-queue";
import {
  isBridgeGlobalMethod,
  serializeConnectionEnvelope,
  validateConnectionId,
} from "../connections/protocol";
import { inputOrderKey } from "../rpc/input-order";
import {
  createRpcLogger,
  type ParsedRpcMessage,
  parseRpcMessage,
  parseRpcMeta,
} from "../rpc/logging";
import {
  BRIDGE_RPC_CAPABILITIES,
  TERMINAL_RPC_CAPABILITIES,
} from "../rpc/methods";
import type { VscodeProxy } from "../vscode/proxy";
import type { AccountServices } from "./accounts";
import type { ServerBootstrap } from "./bootstrap";
import type { ConnectionWiring } from "./connections";

/** An RTC socket stands in for a `ServerWebSocket` (see rtc-transport.ts). */
function asServerSocket(socket: RtcSocket<SocketData>) {
  return socket as unknown as ServerWebSocket<SocketData>;
}

/**
 * The handlers of every browser socket (app, VS Code and agent-browser VNC)
 * and the peer-to-peer transport whose data channels they also drive.
 */
export function createSocketTransports(deps: {
  bootstrap: ServerBootstrap;
  registry: ClientRegistry;
  accounts: AccountServices;
  connections: ConnectionWiring;
  vscodeProxy: VscodeProxy;
  agentBrowser: AgentBrowser;
  rtcConfig: RtcConfig;
  handleRpc: (
    ws: ServerWebSocket<unknown>,
    message: ParsedRpcMessage,
  ) => Promise<unknown>;
}) {
  const { config, logger } = deps.bootstrap;
  const {
    clients,
    vncSockets,
    vscodeSockets,
    socketPrincipals,
    participantPrincipals,
    participantIds,
    webSocketCleanup,
    safeSend,
    assignClientId,
    clientLabel,
    trackRpc,
    takeRpcOutcome,
  } = deps.registry;
  const { clientIdentity } = deps.accounts;
  const { connectionManager } = deps.connections;
  const { vscodeProxy, agentBrowser, handleRpc } = deps;
  const logRpc = createRpcLogger({
    logger,
    clientLabel,
  });
  const inputOrder = createKeyedSerialQueue();

  const websocketHandlers: WebSocketHandler<SocketData> = {
    perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
    open(ws) {
      if (ws.data.vscode) {
        socketPrincipals.set(ws, ws.data.principal);
        const { req, url } = ws.data.vscode;
        vscodeSockets.set(ws, vscodeProxy.openSocket(ws, req, url));
        ws.data.vscode = undefined;
        return;
      }
      if (ws.data.vnc) {
        socketPrincipals.set(ws, ws.data.principal);
        vncSockets.set(
          ws,
          agentBrowser.openVnc(ws as VncPeer, ws.data.vnc.scale),
        );
        return;
      }
      clients.add(ws);
      socketPrincipals.set(ws, ws.data.principal);
      clientIdentity.attach(ws, ws.data.client);
      const participantId = clientIdentity.participantId(
        ws,
        ws.data.clientSession,
      );
      participantIds.set(ws, participantId);
      participantPrincipals.set(participantId, ws.data.principal.key);
      const label = assignClientId(ws);
      const webEntry = deps.bootstrap.webEntry();
      logger.debug("client connected", {
        client: label,
        clients: clients.size,
        ...(isRtcSocket(ws) ? { transport: "rtc" } : {}),
      });
      safeSend(
        ws,
        JSON.stringify({
          hello: true,
          ...(isInstanceAdmin(ws.data.principal)
            ? { socket: config.socketPath }
            : {}),
          principal: principalView(ws.data.principal),
          ...(ws.data.directOrigin
            ? { direct_origin: ws.data.directOrigin }
            : {}),
          ...(ws.data.rtc
            ? { rtc: true, rtc_ice_servers: rtcTransport.iceServers }
            : {}),
          bridge_protocol_version: 2,
          ...(webEntry ? { web_entry: webEntry } : {}),
          default_connection_id: connectionManager.defaultId(),
          participant_id: participantId,
          capabilities: {
            connection_id: true,
            connection_scoped_http: true,
            connection_runtime_generation: true,
            ...TERMINAL_RPC_CAPABILITIES,
            ...BRIDGE_RPC_CAPABILITIES,
          },
        }),
        "hello",
      );
    },
    drain(ws) {
      if (ws.data.vnc || vscodeSockets.has(ws)) return;
      // The viewer caught up: send the newest repaint we held back.
      flushCoalescedMessages(ws, {
        cleanup: () => {
          webSocketCleanup.cleanup(ws);
        },
        warn: (detail) =>
          logger.warn("websocket send failed", {
            detail: detail.replace(/^\[bridge\] /, ""),
          }),
      });
    },
    message(ws, message) {
      const vscode = vscodeSockets.get(ws);
      if (vscode) return vscode.message(message);
      const vnc = vncSockets.get(ws);
      if (vnc) {
        if (typeof message !== "string") vnc.message(message);
        return;
      }
      if (!clients.has(ws)) return;
      const text = typeof message === "string" ? message : message.toString();
      const parsedMessage = parseRpcMessage(text);
      const { id, method, connectionId, connectionGeneration } =
        parseRpcMeta(parsedMessage);
      const startedAt = Date.now();
      let responseConnectionId: string | null = null;
      let logConnectionId: string | null = null;
      if (method && !isBridgeGlobalMethod(method)) {
        if (connectionId === undefined) {
          responseConnectionId = connectionManager.defaultId();
          logConnectionId = responseConnectionId;
        } else {
          try {
            responseConnectionId = validateConnectionId(connectionId);
            logConnectionId = responseConnectionId;
          } catch {
            logConnectionId = "invalid";
          }
        }
      }
      // Input is ordered where it arrives (see inputOrderKey): everything
      // after this point may await.
      const orderKey = inputOrderKey(
        clientLabel(ws),
        logConnectionId,
        method,
        parsedMessage?.value,
      );
      trackRpc(ws, id);
      (orderKey === null
        ? handleRpc(ws, parsedMessage)
        : inputOrder.run(orderKey, () => handleRpc(ws, parsedMessage))
      )
        .then(() => {
          const outcome = takeRpcOutcome(ws, id);
          logRpc(
            ws,
            method,
            startedAt,
            outcome?.status ?? "ok",
            logConnectionId,
            outcome?.detail,
          );
        })
        .catch((e) => {
          takeRpcOutcome(ws, id);
          logRpc(
            ws,
            method,
            startedAt,
            "error",
            logConnectionId,
            (e as Error).message,
          );
          const errorMessage: Record<string, unknown> = {
            error: { message: (e as Error).message },
          };
          if (id) errorMessage.id = id;
          safeSend(
            ws,
            responseConnectionId
              ? serializeConnectionEnvelope(
                  responseConnectionId,
                  errorMessage,
                  typeof connectionGeneration === "number"
                    ? connectionGeneration
                    : undefined,
                )
              : JSON.stringify(errorMessage),
            "message-error",
          );
        });
    },
    close(ws) {
      const vscode = vscodeSockets.get(ws);
      if (vscode) {
        vscode.close();
        vscodeSockets.delete(ws);
        return;
      }
      if (ws.data.vnc) {
        vncSockets.get(ws)?.close();
        vncSockets.delete(ws);
        return;
      }
      rtcTransport.ownerClosed(ws);
      const { client, viewedTerminals } = webSocketCleanup.complete(ws);
      logger.debug("client disconnected", {
        client,
        clients: clients.size,
        terminals: viewedTerminals.length ? viewedTerminals.join(",") : "none",
      });
    },
  };

  /**
   * Data channels negotiated with `bridge.rtc_offer` become sockets the
   * handlers above drive like WebSockets: they join `clients`, so hello, RPC
   * routing, terminal streams, presence and revocation cover them too.
   */
  const rtcTransport = createRtcTransport<SocketData>({
    config: deps.rtcConfig,
    logger: logger.child("rtc"),
    handlers: {
      open: (socket) => websocketHandlers.open?.(asServerSocket(socket)),
      message: (socket, message) =>
        websocketHandlers.message(asServerSocket(socket), message),
      close: (socket, code, reason) =>
        websocketHandlers.close?.(asServerSocket(socket), code, reason),
      drain: (socket) => websocketHandlers.drain?.(asServerSocket(socket)),
    },
  });

  return { websocketHandlers, rtcTransport };
}
