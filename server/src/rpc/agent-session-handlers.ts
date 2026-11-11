import {
  AGENT_PROMPT_IMAGE_LIMIT,
  AGENT_PROMPT_LIMIT,
  type AgentPromptImage,
} from "../../../shared/agentSession";
import { forkArgsOf, isAgentSessionId } from "../agent-session/link";
import { isUploadedImagePath } from "../http/image-upload";
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
 * The images of a prompt: each must be a file the upload endpoint made, so a
 * page cannot have the host read (and the agent see) any other file.
 */
function promptImages(params: Record<string, unknown>): AgentPromptImage[] {
  const { images } = params;
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error("images must be a list");
  if (images.length > AGENT_PROMPT_IMAGE_LIMIT)
    throw new Error(
      `a prompt takes at most ${AGENT_PROMPT_IMAGE_LIMIT} images`,
    );
  return images.map((image, index) => {
    const path = (image as { path?: unknown } | null)?.path;
    if (!isUploadedImagePath(path))
      throw new Error(`image ${index + 1} is not an uploaded image`);
    return { path };
  });
}

/**
 * Branch a session: its host names the arguments that start a session on a
 * copy of its conversation, and the launcher starts one with them in a new
 * pane beside it. Answers with the new pane, which this page now types into.
 */
async function forkSession(ctx: ConnectionRpcContext, pane: string) {
  const { ws, params, requestIsCurrent } = ctx;
  const { agentSessions, clients } = ctx.services;
  const itemId = params.item_id;
  if (itemId !== undefined && (typeof itemId !== "string" || !itemId))
    throw new Error("item_id must name a prompt");
  const info = agentSessions.info(pane);
  if (!info) throw new Error(NO_SESSION);
  const args = forkArgsOf(
    await agentSessions.act(pane, {
      action: "fork",
      ...(itemId ? { item_id: itemId } : {}),
    }),
  );
  if (!args) throw new Error("the agent session did not say how to branch");
  const result = await ctx.connection.launcher.launchBeside(
    { agent: info.kind, paneId: pane, cwd: info.cwd, args },
    requestIsCurrent,
  );
  if (clients.has(ws))
    ctx.connection.terminalBridge.notePaneInput(ws, result.pane_id);
  return result;
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
    if (method === "agent_session.history") {
      const sessions = await agentSessions.history(pane);
      sendReply({ id, result: { sessions } }, method);
      return;
    }
    if (method === "agent_session.fork") {
      sendReply({ id, result: await forkSession(ctx, pane) }, method);
      return;
    }
    if (method === "agent_session.send") {
      const images = promptImages(params);
      // With images the text may be empty; without, it is the prompt.
      const text = params.text ?? "";
      if (typeof text !== "string" || (!text.trim() && images.length === 0))
        throw new Error("text required");
      if (text.length > AGENT_PROMPT_LIMIT)
        throw new Error("the prompt is too long");
      await agentSessions.act(pane, {
        action: "send",
        text,
        ...(images.length > 0 ? { images } : {}),
      });
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
    } else if (method === "agent_session.rewind") {
      await agentSessions.act(pane, {
        action: "rewind",
        item_id: stringParam(params, "item_id"),
      });
    } else if (method === "agent_session.resume") {
      // The ID reaches a command line and a file name on the host.
      const sessionId = params.session_id;
      if (!isAgentSessionId(sessionId))
        throw new Error("session_id must be a conversation ID");
      await agentSessions.act(pane, {
        action: "resume",
        session_id: sessionId,
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
  "agent_session.history": agentSession,
  "agent_session.resume": agentSession,
  "agent_session.rewind": agentSession,
  "agent_session.fork": agentSession,
};
