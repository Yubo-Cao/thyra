import type { ServerWebSocket } from "bun";
import { isInstanceAdmin } from "../auth/principal";
import { filterBridgeStatus, filterConnections } from "../authz/filters";
import { RtcOfferError } from "../bridge/rtc-transport";
import { isRtcSocket, type SocketData } from "../bridge/socket-data";
import { sanitizeConnectionError } from "../connections/manager";
import type {
  RpcCallContext,
  RpcHandlerTable,
  RpcRequestContext,
} from "./context";

/**
 * The message board. It answers before pane claiming and result filtering:
 * it is per account, not per connection.
 */
export function handleMessageBoardRpc(ctx: RpcRequestContext) {
  const { id, method, params, principal, sendReply, sendError } = ctx;
  const { messageBoard } = ctx.services;
  if (principal.kind === "guest") {
    sendError("message-board", new Error("permission denied"));
    return;
  }
  try {
    const operation = method.slice("message_board.".length);
    const result =
      operation === "credentials.issue"
        ? messageBoard.issue(principal.key, params)
        : operation === "credentials.list"
          ? messageBoard.credentials(principal.key)
          : operation === "credentials.revoke"
            ? messageBoard.revoke(principal.key, params?.id)
            : messageBoard.execute(principal.key, "browser", operation, params);
    sendReply({ id, result }, "message-board");
  } catch (error) {
    sendError("message-board", error);
  }
}

function ping({ id, sendReply }: RpcCallContext) {
  sendReply({ id, result: { ok: true } }, "bridge-ping");
}

async function rtcOffer(ctx: RpcCallContext) {
  const { ws, id, method, params, sendReply, sendError } = ctx;
  const { logger } = ctx.services;
  const rtcTransport = ctx.services.rtcTransport();
  const data = (ws as ServerWebSocket<SocketData>).data;
  if (!data?.rtc || isRtcSocket(ws)) {
    sendError("rpc-denied", new Error("bridge.rtc_offer: not offered"));
    return;
  }
  try {
    const sdp = await rtcTransport.answer(
      ws,
      { ...data, rtc: false },
      ws.remoteAddress,
      params?.sdp,
    );
    sendReply({ id, result: { sdp } }, method);
  } catch (error) {
    if (!(error instanceof RtcOfferError))
      logger.warn("rtc offer failed", { error: (error as Error).message });
    sendError(`${method}-error`, error);
  }
}

async function identity(ctx: RpcCallContext) {
  const { ws, id, method, params, sendReply, sendError } = ctx;
  const { clientIdentity } = ctx.services;
  try {
    const result =
      method === "bridge.identity"
        ? await clientIdentity.hello(ws, params ?? {})
        : await clientIdentity.updateProfile(ws, params ?? {});
    sendReply({ id, result }, method);
  } catch (error) {
    sendError(`${method}-error`, error);
  }
}

function status(ctx: RpcCallContext) {
  const { id, principal, sendReply } = ctx;
  const {
    clients,
    countDevices,
    connectionManager,
    connectionProfiles,
    accessControl,
  } = ctx.services;
  const status = {
    clients: clients.size,
    devices: countDevices(clients),
    terminals:
      connectionManager
        .defaultReadyRuntime()
        ?.terminalBridge.statusTerminals() ?? [],
    default_connection_id: connectionManager.defaultId(),
    connections: connectionProfiles.list(),
  };
  const visible = accessControl.connectionsOf(principal);
  sendReply(
    {
      id,
      result: isInstanceAdmin(principal)
        ? status
        : filterBridgeStatus(
            status,
            (connection) =>
              connection === status.default_connection_id ||
              visible.has(connection),
          ),
    },
    "bridge-status",
  );
}

function listConnections(ctx: RpcCallContext) {
  const { id, principal, sendReply } = ctx;
  const { connectionManager, connectionProfiles, accessControl } = ctx.services;
  const connections = connectionProfiles.list();
  const visible = accessControl.connectionsOf(principal);
  sendReply(
    {
      id,
      result: {
        default_connection_id: connectionManager.defaultId(),
        connections: isInstanceAdmin(principal)
          ? connections
          : filterConnections(
              connections,
              (connection) =>
                connection === connectionManager.defaultId() ||
                visible.has(connection),
            ),
      },
    },
    "connections-list",
  );
}

/** `connections.*` other than `connections.list`: profile mutations. */
async function mutateConnections(ctx: RpcCallContext) {
  const { ws, id, method, params, sendReply } = ctx;
  const { connectionProfiles, markRpcError } = ctx.services;
  try {
    let result: unknown;
    if (method === "connections.create") {
      result = await connectionProfiles.create(params?.profile ?? params);
    } else if (method === "connections.update") {
      result = await connectionProfiles.update(
        params?.id,
        params?.profile ?? params,
      );
    } else if (method === "connections.remove") {
      result = await connectionProfiles.remove(params?.id);
    } else if (method === "connections.set_default") {
      result = await connectionProfiles.setDefault(params?.id);
    } else if (method === "connections.connect") {
      result = await connectionProfiles.connect(params?.id);
    } else if (method === "connections.disconnect") {
      result = await connectionProfiles.disconnect(params?.id);
    } else if (method === "connections.test") {
      result = await connectionProfiles.test(params?.profile ?? params);
    } else {
      throw new Error(`unknown bridge-global method: ${method}`);
    }
    sendReply({ id, result }, "connections-mutation");
  } catch (error) {
    const message = sanitizeConnectionError(error);
    markRpcError(ws, id, message);
    sendReply({ id, error: { message } }, "connections-mutation-error");
  }
}

function pauseOthers(ctx: RpcCallContext) {
  const { ws, id, sendReply } = ctx;
  const { clients, safeSend, clientIdentity, clientLabel, countDevices } =
    ctx.services;
  const targets = Array.from(clients).filter((client) => client !== ws);
  let pausedClients = 0;
  const pausedDevices = new Set<string>();
  for (const client of targets) {
    const ok = safeSend(
      client,
      JSON.stringify({
        control: {
          type: "pause_connection",
          reason:
            "Another Thyra client paused this connection. Resume when you want this browser to sync again.",
        },
      }),
      "pause-other-client",
    );
    if (ok) {
      pausedClients += 1;
      pausedDevices.add(
        clientIdentity.deviceKeyOf(client) ?? clientLabel(client),
      );
    }
  }
  sendReply(
    {
      id,
      result: {
        ok: true,
        paused_clients: pausedClients,
        paused_devices: pausedDevices.size,
        clients: clients.size,
        devices: countDevices(clients),
      },
    },
    "bridge-pause-others",
  );
}

/** Bridge-global methods: they act on this process, not on one connection. */
export const bridgeRpcHandlers: RpcHandlerTable<RpcCallContext> = {
  methods: {
    "bridge.ping": ping,
    "bridge.rtc_offer": rtcOffer,
    "bridge.identity": identity,
    "bridge.identity_profile": identity,
    "bridge.status": status,
    "connections.list": listConnections,
    "bridge.pause_others": pauseOthers,
  },
  prefixes: [["connections.", mutateConnections]],
};
