import { authorize } from "../authz/authorize";
import { collaborationParams } from "../authz/collaboration-params";
import {
  annotateOwnerAccess,
  filterDisplayOwners,
  filterListResult,
  filterPresenceResult,
  narrowLayoutResult,
} from "../authz/filters";
import { enrichIntegrationVersions } from "../herdr/integration-versions";
import type { ConnectionRpcContext, RpcHandler } from "./context";
import { PANE_INPUT_METHODS } from "./methods";

/** `shell.*`: shell integration state of a pane. */
async function shell(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, principal, connectionId } = ctx;
  const { requestIsCurrent, encode, sendReply, sendError, connection } = ctx;
  const { clients, socketPrincipals, participantIds, authzDeps, safeSend } =
    ctx.services;
  try {
    const result = await connection.shell.rpc(
      method,
      params ?? {},
      ws,
      (state) => {
        // Claims and grants can change after subscribing; never reuse the
        // subscription's authorization for later private shell state.
        void authorize(
          {
            principal: socketPrincipals.get(ws) ?? principal,
            method: "shell.subscribe",
            params: { pane_id: state.pane_id },
            connectionId,
            participantId: participantIds.get(ws) ?? null,
          },
          authzDeps,
        )
          .then((decision) => {
            if (!decision.allowed || !clients.has(ws) || !requestIsCurrent())
              return;
            safeSend(
              ws,
              encode({
                event: "shell.state",
                data: connection.shell.state.current(state.pane_id) ?? state,
              }),
              "shell-state",
            );
          })
          .catch(() => {});
      },
      requestIsCurrent,
      // A socket that closed meanwhile must not be subscribed again.
      () => clients.has(ws),
    );
    sendReply({ id, result }, method);
  } catch (error) {
    sendError("shell-rpc-error", error);
  }
}

/**
 * `tab.create` and `workspace.create`: a browser terminal as the source
 * creates through the terminal bridge; otherwise Herdr creates it.
 */
async function createTabOrWorkspace(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, requestIsCurrent, sendReply, sendError } =
    ctx;
  const { terminalBridge } = ctx.connection;
  if (
    !(
      (method === "tab.create" || method === "workspace.create") &&
      params &&
      Object.hasOwn(params, "browser_source")
    )
  )
    return passThroughToHerdr(ctx);
  try {
    const result = await terminalBridge.createFromTerminal(
      ws,
      method,
      params,
      requestIsCurrent,
    );
    sendReply({ id, result }, method);
  } catch (error) {
    sendError(`${method}-error`, error);
  }
}

/** `terminal.*`: the terminal bridge answers on the socket itself. */
function terminal(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, requestIsCurrent, roles, scope } = ctx;
  const { terminalBridge } = ctx.connection;
  return terminalBridge.handleTerminalRpc(
    ws,
    id,
    method,
    params ?? {},
    requestIsCurrent,
    roles ? (result) => filterDisplayOwners(result, roles, scope) : undefined,
  );
}

/** `collaboration.*`: presence and single-writer pane control. */
async function collaborate(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, principal, authorization } = ctx;
  const { sendReply, sendError, roles, scope, connection } = ctx;
  const { clients, participantIds, socketPresence, clientIdentity } =
    ctx.services;
  const { collaboration } = connection;
  try {
    // The bridge, not the page, decides the participant id, role, name
    // and color; a page can only act as its own participant.
    const participantId = participantIds.get(ws);
    if (!participantId) throw new Error("presence unavailable");
    const validParams = collaborationParams(
      method,
      params ?? {},
      participantId,
      principal.kind === "guest"
        ? {
            workspace: principal.link.workspaceId,
            pane: principal.link.paneId,
          }
        : null,
    );
    const callParams =
      method === "collaboration.update"
        ? await clientIdentity.presenceParams(ws, validParams)
        : validParams;
    if (
      method === "collaboration.claim" &&
      authorization.takeoverAnytime &&
      callParams.takeover === true
    ) {
      // Workspace owners and admins, and the holder's other windows, take
      // control during the protection.
      const paneId = String(callParams.pane_id);
      const holder = connection.claims.get(paneId);
      if (
        holder &&
        holder.participantId !== participantId &&
        (holder.protectedUntil ?? 0) > Date.now()
      ) {
        const releaseParams = {
          participant_id: holder.participantId,
          pane_id: paneId,
        };
        connection.claims.observeResult(
          "collaboration.release",
          releaseParams,
          await collaboration.call("collaboration.release", releaseParams),
        );
      }
    }
    let raw: unknown;
    if (method === "collaboration.leave") {
      // Presence comes off the socket first, so a page closing meanwhile
      // does not leave a second time. A failed call puts it back: the
      // participant is still present upstream, and a retry or the socket's
      // close must still be able to leave for it.
      const held = socketPresence.get(ws);
      socketPresence.delete(ws);
      try {
        raw = await collaboration.call(method, callParams);
      } catch (error) {
        if (held && clients.has(ws) && !socketPresence.has(ws))
          socketPresence.set(ws, held);
        throw error;
      }
      // An update that raced the call made the participant present again.
      if (!socketPresence.has(ws))
        clientIdentity.forgetParticipant(participantId);
    } else {
      if (method === "collaboration.update") {
        // A page that closed meanwhile has already left; do not revive it.
        if (!clients.has(ws)) return;
        socketPresence.set(ws, collaboration);
      }
      raw = await collaboration.call(method, callParams);
    }
    connection.claims.observeResult(method, callParams, raw);
    const result = clientIdentity.annotateResult(
      raw,
      connection.presenceContext,
    );
    sendReply(
      {
        id,
        result: roles ? filterPresenceResult(result, roles, scope) : result,
      },
      method,
    );
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

/** `settings.*`: the settings service answers on the socket itself. */
function settings(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, requestIsCurrent } = ctx;
  const { handleSettingsRpc } = ctx.connection;
  return handleSettingsRpc(ws, id, method, params ?? {}, requestIsCurrent);
}

/** `launcher.*`: starting agents and shells. */
async function launcher(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, requestIsCurrent, sendReply, sendError } =
    ctx;
  const { clients } = ctx.services;
  const { connection } = ctx;
  const { terminalBridge } = connection;
  try {
    const result = await connection.launcher.call(
      method,
      params ?? {},
      requestIsCurrent,
    );
    const paneId = (result as { pane_id?: unknown }).pane_id;
    if (typeof paneId === "string" && clients.has(ws))
      terminalBridge.notePaneInput(ws, paneId);
    sendReply({ id, result }, method);
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

/**
 * Every other allowed method goes to Herdr as it is; list results are
 * filtered to what the caller may see.
 */
export async function passThroughToHerdr(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, authorization, roles, scope } = ctx;
  const { sendReply, sendError } = ctx;
  const { clients } = ctx.services;
  const { sshHost, herdr, worktreeParents, terminalBridge } = ctx.connection;
  const { enrichWorkspacesWithGitStatus } = ctx.connection.status;
  if (
    PANE_INPUT_METHODS.has(method) &&
    typeof params?.pane_id === "string" &&
    params.pane_id &&
    // The socket may have closed during authorization; do not re-register it.
    clients.has(ws)
  )
    terminalBridge.notePaneInput(ws, params.pane_id);
  try {
    const rawResult = await herdr.call(method, params ?? {});
    let result = rawResult;
    if (method === "integration.list") {
      result = await enrichIntegrationVersions(result, {
        sshHost: sshHost(),
        ping: () => herdr.ping(),
      });
    }
    if (method === "workspace.list") {
      result = await worktreeParents.enrichWorkspaceList(result);
      result = await enrichWorkspacesWithGitStatus(result);
      result = {
        ...result,
        endpoint_availability: terminalBridge.endpointAvailability(),
      };
    }
    if (authorization.entry.scope === "list")
      result = roles
        ? filterListResult(result, roles, scope)
        : method === "workspace.list"
          ? annotateOwnerAccess(result)
          : result;
    else if (scope && method === "pane.layout")
      result = narrowLayoutResult(result, scope);
    sendReply({ id, result }, method);
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

/** Terminals, panes and presence of one connection's session. */
export const sessionRpcMethods: Record<
  string,
  RpcHandler<ConnectionRpcContext>
> = {
  "tab.create": createTabOrWorkspace,
  "workspace.create": createTabOrWorkspace,
};

export const sessionRpcPrefixes: readonly (readonly [
  string,
  RpcHandler<ConnectionRpcContext>,
])[] = [
  ["shell.", shell],
  ["terminal.", terminal],
  ["collaboration.", collaborate],
  ["settings.", settings],
  ["launcher.", launcher],
];
