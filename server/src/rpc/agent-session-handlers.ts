import { AGENT_PROMPT_LIMIT } from "../../../shared/agentSession";
import type { ConnectionRpcContext, RpcHandler } from "./context";

const NO_SESSION = "no agent session in this pane";

function paneOf(params: Record<string, unknown>): string {
  const pane = params.pane_id;
  if (typeof pane !== "string" || !pane || pane.length > 256)
    throw new Error("pane_id required");
  return pane;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} required`);
  return value;
}

/**
 * `agent_session.*`: the sessions of panes running `thyra agent`. The policy
 * table has already checked the caller against the pane; this only talks to
 * the session service.
 */
async function agentSession(ctx: ConnectionRpcContext) {
  const { ws, id, method, params, connectionId, roles, scope } = ctx;
  const { sendReply, sendError } = ctx;
  const { agentSessions, clients } = ctx.services;
  try {
    const serves = agentSessions.serves(connectionId);
    if (method === "agent_session.list") {
      sendReply(
        {
          id,
          result: { sessions: serves ? agentSessions.list(roles, scope) : [] },
        },
        method,
      );
      return;
    }
    const pane = paneOf(params);
    if (method === "agent_session.unsubscribe") {
      agentSessions.unsubscribe(ws, pane);
      sendReply({ id, result: { ok: true } }, method);
      return;
    }
    if (!serves) throw new Error(NO_SESSION);
    if (method === "agent_session.subscribe") {
      // A socket that closed during authorization is not subscribed again.
      if (!clients.has(ws)) return;
      sendReply({ id, result: agentSessions.subscribe(ws, pane) }, method);
      return;
    }
    if (method === "agent_session.send") {
      const text = stringParam(params, "text");
      if (!text.trim()) throw new Error("text required");
      if (text.length > AGENT_PROMPT_LIMIT)
        throw new Error("the prompt is too long");
      await agentSessions.act(pane, { action: "send", text });
    } else if (method === "agent_session.interrupt") {
      await agentSessions.act(pane, { action: "interrupt" });
    } else if (method === "agent_session.approve") {
      await agentSessions.act(pane, {
        action: "approve",
        approval_id: stringParam(params, "approval_id"),
        option_id: stringParam(params, "option_id"),
      });
    } else if (method === "agent_session.set_mode") {
      await agentSessions.act(pane, {
        action: "set_mode",
        mode: stringParam(params, "mode"),
      });
    } else {
      throw new Error(`unknown agent session method: ${method}`);
    }
    sendReply({ id, result: { ok: true } }, method);
  } catch (error) {
    sendError(`${method}-error`, error);
  }
}

/** Agent sessions of one connection, by method name. */
export const agentSessionRpcMethods: Record<
  string,
  RpcHandler<ConnectionRpcContext>
> = {
  "agent_session.list": agentSession,
  "agent_session.subscribe": agentSession,
  "agent_session.unsubscribe": agentSession,
  "agent_session.send": agentSession,
  "agent_session.interrupt": agentSession,
  "agent_session.approve": agentSession,
  "agent_session.set_mode": agentSession,
};
