import type { ServerWebSocket } from "bun";
import { authorize, TAKEOVER_PROTECTION_MS } from "../authz/authorize";
import { lookupRpc } from "../authz/policy";
import {
  ConnectionRoutingError,
  createConnectionReplyPublisher,
  serializeConnectionEnvelope,
  validateConnectionGeneration,
  validateConnectionId,
} from "../connections/protocol";
import {
  type ConnectionRpcRequest,
  isConnectionRpcEnvelope,
  resolveRpcRoute,
} from "../connections/rpc-routing";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { bridgeRpcHandlers, handleMessageBoardRpc } from "./bridge-handlers";
import {
  type ConnectionRpcContext,
  exactRpcHandler,
  prefixRpcHandler,
  type RpcCallContext,
  type RpcHandlerTable,
  type RpcRequestContext,
  type RpcServices,
} from "./context";
import type { ParsedRpcMessage } from "./logging";
import {
  passThroughToHerdr,
  sessionRpcMethods,
  sessionRpcPrefixes,
} from "./session-handlers";
import {
  fileManagerRpcHandler,
  workspaceRpcMethods,
} from "./workspace-handlers";

type RpcRequest = ConnectionRpcRequest;

/** Methods of one ready connection, by name and by family. */
const connectionRpcHandlers: RpcHandlerTable<ConnectionRpcContext> = {
  methods: { ...sessionRpcMethods, ...workspaceRpcMethods },
  prefixes: sessionRpcPrefixes,
};

/**
 * The RPC entry point of a browser socket: validates the envelope, routes it
 * to a connection, authorizes it against the policy table, then hands it to
 * the handler its method names. Nothing runs for a request before it is
 * authorized.
 */
export function createRpcDispatcher(services: RpcServices) {
  const {
    clients,
    socketPrincipals,
    participantIds,
    safeSend,
    markRpcError,
    authzDeps,
    connectionManager,
    legacyRoutingLogger,
    viewerRoles,
    scopedPaneOf,
    freshScope,
  } = services;

  async function handleRpc(
    ws: ServerWebSocket<unknown>,
    message: ParsedRpcMessage,
  ) {
    if (!message) {
      safeSend(
        ws,
        JSON.stringify({ error: { message: "bad json" } }),
        "bad-json",
      );
      return;
    }
    const parsed = message.value;
    if (!isConnectionRpcEnvelope(parsed)) {
      safeSend(
        ws,
        JSON.stringify({ error: { message: "invalid request envelope" } }),
        "invalid-request-envelope",
      );
      return;
    }
    const req = parsed as RpcRequest;
    const { id, method } = req;
    let params: Record<string, any> | undefined = req.params;
    let validationConnectionId: string | undefined;
    let connectionIdValidationFailed = false;
    if (Object.hasOwn(req, "connection_id")) {
      try {
        validationConnectionId = validateConnectionId(req.connection_id);
      } catch {
        connectionIdValidationFailed = true;
      }
    }
    let validationConnectionGeneration: number | undefined;
    let connectionGenerationValidationFailed = false;
    if (Object.hasOwn(req, "connection_generation")) {
      try {
        validationConnectionGeneration = validateConnectionGeneration(
          req.connection_generation,
        );
      } catch {
        connectionGenerationValidationFailed = true;
      }
    }
    if (
      typeof id !== "string" ||
      !id ||
      typeof method !== "string" ||
      !method
    ) {
      const message = connectionIdValidationFailed
        ? "invalid connection_id"
        : connectionGenerationValidationFailed
          ? "invalid connection_generation"
          : "missing id/method";
      markRpcError(ws, typeof id === "string" ? id : undefined, message);
      const responseId = typeof id === "string" ? id : undefined;
      const payload = validationConnectionId
        ? serializeConnectionEnvelope(
            validationConnectionId,
            {
              ...(responseId ? { id: responseId } : {}),
              error: { message },
            },
            validationConnectionGeneration,
          )
        : JSON.stringify({
            ...(responseId ? { id: responseId } : {}),
            error: { message },
          });
      safeSend(ws, payload, "invalid-request");
      return;
    }
    // Deny by default: only methods in the policy table reach routing or any
    // handler, including the Herdr passthrough at the end.
    const known = lookupRpc(method);
    if (!known.allowed) {
      const message = known.message;
      markRpcError(ws, id, message);
      safeSend(
        ws,
        validationConnectionId
          ? serializeConnectionEnvelope(
              validationConnectionId,
              { id, error: { message } },
              validationConnectionGeneration,
            )
          : JSON.stringify({ id, error: { message } }),
        "rpc-denied",
      );
      return;
    }
    let route: ReturnType<typeof resolveRpcRoute<LegacyConnectionRuntime>>;
    try {
      route = resolveRpcRoute({
        request: req,
        registry: connectionManager,
        legacyClient: ws,
        legacyLogger: legacyRoutingLogger,
      });
    } catch (error) {
      const message = (error as Error).message;
      markRpcError(ws, id, message);
      const connectionId =
        error instanceof ConnectionRoutingError
          ? error.connectionId
          : undefined;
      const connectionGeneration =
        error instanceof ConnectionRoutingError
          ? error.connectionGeneration
          : undefined;
      const payload = connectionId
        ? serializeConnectionEnvelope(
            connectionId,
            {
              id,
              error: { message },
            },
            connectionGeneration,
          )
        : JSON.stringify({ id, error: { message } });
      safeSend(ws, payload, "connection-routing-error");
      return connectionId ?? null;
    }
    const connectionId =
      route.scope === "connection" ? route.connectionId : null;
    const requestIsCurrent = () =>
      route.scope === "bridge" || route.isCurrent();
    const encode = (message: Record<string, unknown>) =>
      route.scope === "connection"
        ? serializeConnectionEnvelope(
            route.connectionId,
            message,
            route.generation,
          )
        : JSON.stringify(message);
    const replyPublisher =
      route.scope === "connection"
        ? createConnectionReplyPublisher({
            connectionId: route.connectionId,
            generation: route.generation,
            requestId: id,
            isCurrent: route.isCurrent,
            send: (payload, context) => safeSend(ws, payload, context),
            markError: (message) => markRpcError(ws, id, message),
          })
        : null;
    const sendReply = (
      message: Record<string, unknown>,
      context: string,
    ): boolean =>
      replyPublisher
        ? replyPublisher.send(message, context)
        : safeSend(ws, encode(message), context);
    const sendError = (context: string, error: unknown) => {
      const message = (error as Error).message;
      markRpcError(ws, id, message);
      sendReply({ id, error: { message } }, context);
    };
    // Authorize against the caller's account, grants and pane claims.
    const principal = socketPrincipals.get(ws);
    if (!principal) {
      sendError("rpc-denied", new Error("not logged in"));
      return;
    }
    const participantId = participantIds.get(ws) ?? null;
    if (
      route.scope === "connection" &&
      method.startsWith("terminal.") &&
      !(typeof params?.terminal_id === "string" && params.terminal_id)
    ) {
      // Terminal methods without terminal_id act on the socket's current one.
      const current = route.runtime.terminalBridge.currentTerminalId(ws);
      if (current) params = { ...(params ?? {}), terminal_id: current };
    }
    const authorization = await authorize(
      { principal, method, params: params ?? {}, connectionId, participantId },
      authzDeps,
    );
    if (!authorization.allowed) {
      sendError("rpc-denied", new Error(authorization.message));
      return;
    }
    params = authorization.params;
    if (authorization.stub) {
      sendReply({ id, result: authorization.stub.result }, "rpc-stub");
      return;
    }
    const request: RpcRequestContext = {
      services,
      ws,
      id,
      method,
      params,
      principal,
      participantId,
      authorization,
      route,
      connectionId,
      requestIsCurrent,
      encode,
      sendReply,
      sendError,
    };
    if (method.startsWith("message_board."))
      return handleMessageBoardRpc(request);
    const roles = connectionId ? viewerRoles(ws, connectionId) : null;
    // A guest link narrowed to one pane filters results to that pane.
    const scope =
      connectionId && scopedPaneOf(ws)
        ? await freshScope(ws, connectionId)
        : null;
    if (
      authorization.autoClaim &&
      authorization.paneId &&
      participantId &&
      route.scope === "connection"
    ) {
      // Input to an unclaimed pane claims it: one writer at a time.
      const claimParams = {
        participant_id: participantId,
        pane_id: authorization.paneId,
        protect_ms: TAKEOVER_PROTECTION_MS,
      };
      try {
        const claimed = await route.runtime.collaboration.call(
          "collaboration.claim",
          claimParams,
        );
        route.runtime.claims.observeResult(
          "collaboration.claim",
          claimParams,
          claimed,
        );
        if (claimed?.granted === false) {
          sendError(
            "rpc-denied",
            new Error(
              `${method}: another collaborator controls this pane; take control first`,
            ),
          );
          return;
        }
      } catch {
        // Presence is unavailable (no participant yet): nobody else holds it.
      }
    }
    const call: RpcCallContext = { ...request, roles, scope };
    // Authorization awaited: a socket that closed meanwhile was already cleaned
    // up, so nothing below may register state for it again.
    if (
      !clients.has(ws) &&
      (method === "bridge.rtc_offer" ||
        method === "bridge.identity" ||
        method === "bridge.identity_profile")
    )
      return;
    const bridgeHandler =
      exactRpcHandler(bridgeRpcHandlers, method) ??
      prefixRpcHandler(bridgeRpcHandlers, method);
    if (bridgeHandler) return bridgeHandler(call);

    if (route.scope === "bridge") {
      sendError(
        "unknown-bridge-method",
        new Error(`unknown bridge-global method: ${method}`),
      );
      return null;
    }
    const connection = route.runtime;
    // A connection's handlers: by name, then its file-manager table, then by
    // family; every other allowed method goes to Herdr.
    const handler =
      exactRpcHandler(connectionRpcHandlers, method) ??
      fileManagerRpcHandler(connection, method) ??
      prefixRpcHandler(connectionRpcHandlers, method) ??
      passThroughToHerdr;
    return handler({ ...call, connection });
  }

  return handleRpc;
}
