import type { ServerWebSocket } from "bun";
import type { AccessControl } from "../auth/access";
import type { Principal } from "../auth/principal";
import type { AuthzDeps, RpcAuthorization } from "../authz/authorize";
import type { PaneScope } from "../authz/filters";
import type { ClientIdentity, ClientRegistry } from "../bridge/client-registry";
import type { RtcTransport } from "../bridge/rtc-transport";
import type { SocketData } from "../bridge/socket-data";
import type { ConnectionManager } from "../connections/manager";
import type { ConnectionProfileService } from "../connections/profile-service";
import type { LegacyRoutingLogger } from "../connections/protocol";
import type { ResolvedRpcRoute } from "../connections/rpc-routing";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import type { createMessageBoard } from "../message-board/service";
import type { Logger } from "../utils/logger";

/** The process-wide services every RPC handler may use. */
export type RpcServices = Pick<
  ClientRegistry,
  | "clients"
  | "socketPrincipals"
  | "participantIds"
  | "socketPresence"
  | "safeSend"
  | "markRpcError"
  | "clientLabel"
  | "countDevices"
> & {
  logger: Logger;
  clientIdentity: ClientIdentity;
  accessControl: AccessControl;
  authzDeps: AuthzDeps;
  messageBoard: ReturnType<typeof createMessageBoard>;
  connectionManager: ConnectionManager<LegacyConnectionRuntime>;
  connectionProfiles: ConnectionProfileService<LegacyConnectionRuntime>;
  legacyRoutingLogger: LegacyRoutingLogger;
  /** A viewer's role lookup on one connection, or null for admins. */
  viewerRoles(
    ws: ServerWebSocket<unknown>,
    connectionId: string,
  ): ReturnType<AccessControl["roleOf"]> | null;
  scopedPaneOf(ws: ServerWebSocket<unknown>): string | null;
  freshScope(
    ws: ServerWebSocket<unknown>,
    connectionId: string,
  ): Promise<PaneScope | null>;
  /** Created after the dispatcher; read when an offer arrives. */
  rtcTransport: () => RtcTransport<SocketData>;
};

/** One routed and authorized request, with the ways to answer it. */
export interface RpcRequestContext {
  services: RpcServices;
  ws: ServerWebSocket<unknown>;
  id: string;
  method: string;
  /** The parameters to dispatch: the caller's, as authorization narrowed them. */
  params: Record<string, any>;
  principal: Principal;
  participantId: string | null;
  authorization: Extract<RpcAuthorization, { allowed: true }>;
  route: ResolvedRpcRoute<LegacyConnectionRuntime>;
  /** The routed connection; null for bridge-global methods. */
  connectionId: string | null;
  requestIsCurrent(): boolean;
  encode(message: Record<string, unknown>): string;
  sendReply(message: Record<string, unknown>, context: string): boolean;
  /** Record the failure for the RPC log and reply with its message. */
  sendError(context: string, error: unknown): void;
}

/** A request past pane claiming, with the caller's result filters. */
export interface RpcCallContext extends RpcRequestContext {
  /** The viewer's roles on the routed connection; null: no filtering. */
  roles: ReturnType<RpcServices["viewerRoles"]>;
  /** The pane a guest link is narrowed to. */
  scope: PaneScope | null;
}

/** A call routed to a ready connection. */
export interface ConnectionRpcContext extends RpcCallContext {
  connection: LegacyConnectionRuntime;
}

export type RpcHandler<Context> = (ctx: Context) => unknown;

export interface RpcHandlerTable<Context> {
  /** Handlers by exact method name. */
  methods: Record<string, RpcHandler<Context>>;
  /** Handlers of a method family, by prefix: tried in order after `methods`. */
  prefixes: readonly (readonly [string, RpcHandler<Context>])[];
}

/** The handler registered for exactly this method name. */
export function exactRpcHandler<Context>(
  table: RpcHandlerTable<Context>,
  method: string,
): RpcHandler<Context> | undefined {
  return Object.hasOwn(table.methods, method)
    ? table.methods[method]
    : undefined;
}

/** The handler of the first registered family the method belongs to. */
export function prefixRpcHandler<Context>(
  table: RpcHandlerTable<Context>,
  method: string,
): RpcHandler<Context> | undefined {
  return table.prefixes.find(([prefix]) => method.startsWith(prefix))?.[1];
}
