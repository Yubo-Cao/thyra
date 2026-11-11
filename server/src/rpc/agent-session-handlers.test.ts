import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type {
  AgentSessionEvent,
  AgentSessionSnapshot,
} from "../../../shared/agentSession";
import {
  type MatrixRole,
  PRINCIPALS,
  testDeps,
} from "../../test-support/authz/principals";
import type { AgentAction } from "../agent-session/link";
import type { AgentSessionRelay } from "../agent-session/relay";
import { createAgentSessionService } from "../app/agent-sessions";
import { isInstanceAdmin, type Principal } from "../auth/principal";
import { silentLogger } from "../utils/logger";
import type { RpcServices } from "./context";
import { createRpcDispatcher } from "./dispatch";

type Ws = ServerWebSocket<unknown>;

function session(paneId: string, status = "idle"): AgentSessionSnapshot {
  return {
    info: {
      pane_id: paneId,
      kind: "claude",
      status: status as AgentSessionSnapshot["info"]["status"],
      cwd: "/work",
      started_at: 1,
      modes: [],
    },
    items: [{ id: "u1", type: "user", text: `prompt in ${paneId}`, at: 2 }],
    approvals: [],
    seq: 4,
  };
}

/**
 * The dispatcher and the session service over a scripted relay, with one
 * page per role of the authorization matrix on connection `c1`.
 */
function harness() {
  const sessions = new Map(
    ["w1:p1", "w1:p2", "w2:p1"].map((pane) => [pane, session(pane)]),
  );
  const actions: [string, AgentAction][] = [];
  const claims: unknown[] = [];
  let refusal: string | null = null;
  let served = true;
  const relay: AgentSessionRelay = {
    start() {},
    stop() {},
    rescan() {},
    list: () => [...sessions.values()].map((snapshot) => snapshot.info),
    snapshot: (paneId) => sessions.get(paneId) ?? null,
    async act(paneId, action) {
      actions.push([paneId, action]);
      if (refusal) throw new Error(refusal);
    },
  };
  const matrix = testDeps();
  // Instance admins own every workspace of every connection.
  const deps: typeof matrix = {
    ...matrix,
    roleOn: (principal, connectionId, workspaceId) =>
      isInstanceAdmin(principal)
        ? "owner"
        : matrix.roleOn(principal, connectionId, workspaceId),
  };
  const revoked = new Set<Principal>();
  const clients = new Set<Ws>();
  const socketPrincipals = new WeakMap<Ws, Principal>();
  const sent = new Map<Ws, any[]>();
  const pages = {} as Record<MatrixRole, Ws>;
  for (const role of Object.keys(PRINCIPALS) as MatrixRole[]) {
    const ws = { role } as unknown as Ws;
    pages[role] = ws;
    clients.add(ws);
    socketPrincipals.set(ws, PRINCIPALS[role]);
    sent.set(ws, []);
  }
  const safeSend = (ws: Ws, payload: string) => {
    sent.get(ws)!.push(JSON.parse(payload));
    return true;
  };
  const viewerRoles = (ws: Ws, connectionId: string) => {
    const principal = socketPrincipals.get(ws)!;
    if (isInstanceAdmin(principal)) return null;
    return (workspaceId: string) =>
      revoked.has(principal)
        ? null
        : deps.roleOn(principal, connectionId, workspaceId);
  };
  const scopedPaneOf = (ws: Ws) => {
    const principal = socketPrincipals.get(ws)!;
    return principal.kind === "guest" ? principal.link.paneId : null;
  };
  const scope = (ws: Ws) => {
    const pane = scopedPaneOf(ws);
    return pane ? { pane, tab: "w1:t1" } : null;
  };
  const agentSessions = createAgentSessionService({
    logger: silentLogger,
    registry: { clients, safeSend },
    connection: () =>
      served ? { id: "c1", generation: 3, herdrSocketPath: "/herdr" } : null,
    viewerRoles,
    peekScope: scope,
    relay,
  });
  const runtime = {
    collaboration: {
      call: async (method: string, params: unknown) => {
        claims.push([method, params]);
        return { granted: true };
      },
    },
    claims: { observeResult: () => undefined, get: () => null },
  };
  const services = {
    clients,
    socketPrincipals,
    participantIds: {
      get: (ws: Ws) => `web-${(ws as unknown as { role: string }).role}`,
    },
    safeSend,
    markRpcError: () => undefined,
    authzDeps: deps,
    agentSessions,
    connectionManager: {
      defaultId: () => "c1",
      has: (id: string) => id === "c1" || id === "c2",
      readyRuntimeLease: (id: string) => ({
        connectionId: id,
        generation: 3,
        runtime,
        isCurrent: () => true,
      }),
    },
    viewerRoles,
    scopedPaneOf,
    freshScope: async (ws: Ws) => scope(ws),
  } as unknown as RpcServices;
  const handleRpc = createRpcDispatcher(services);
  let nextId = 1;
  return {
    pages,
    sessions,
    actions,
    claims,
    clients,
    agentSessions,
    /** Everything a page received that is not an RPC reply. */
    pushed: (role: MatrixRole) =>
      sent.get(pages[role])!.filter((message) => message.id === undefined),
    refuse(message: string | null) {
      refusal = message;
    },
    unserve() {
      served = false;
    },
    revoke(role: MatrixRole) {
      revoked.add(PRINCIPALS[role]);
    },
    /** Call a method as a role; resolves with `result` or `{ error }`. */
    async call(
      role: MatrixRole,
      method: string,
      params: Record<string, unknown> = {},
      connectionId = "c1",
    ): Promise<any> {
      const id = `r${nextId++}`;
      await handleRpc(pages[role], {
        value: { id, method, params, connection_id: connectionId },
      });
      const reply = sent.get(pages[role])!.find((message) => message.id === id);
      expect(reply).toMatchObject({ connection_id: connectionId });
      return reply.error ? { error: reply.error.message } : reply.result;
    },
  };
}

const panes = (result: any) =>
  result.sessions.map((info: { pane_id: string }) => info.pane_id);

test("the list holds the sessions of panes the caller may read", async () => {
  const h = harness();
  expect(panes(await h.call("admin", "agent_session.list"))).toEqual([
    "w1:p1",
    "w1:p2",
    "w2:p1",
  ]);
  for (const role of ["owner", "editor", "viewer", "guest"] as const)
    expect(panes(await h.call(role, "agent_session.list"))).toEqual([
      "w1:p1",
      "w1:p2",
    ]);
  expect(panes(await h.call("outsider", "agent_session.list"))).toEqual([
    "w2:p1",
  ]);
  // A link narrowed to one pane lists that pane's session only.
  expect(panes(await h.call("guest-pane", "agent_session.list"))).toEqual([
    "w1:p1",
  ]);
  expect((await h.call("viewer", "agent_session.list")).sessions[0]).toEqual(
    h.sessions.get("w1:p1")!.info,
  );
});

test("connections without agent sessions answer with an empty list", async () => {
  const h = harness();
  expect(await h.call("admin", "agent_session.list", {}, "c2")).toEqual({
    sessions: [],
  });
  expect(
    await h.call(
      "admin",
      "agent_session.subscribe",
      { pane_id: "w1:p1" },
      "c2",
    ),
  ).toEqual({ error: "no agent session in this pane" });
  expect(
    await h.call(
      "admin",
      "agent_session.send",
      { pane_id: "w1:p1", text: "x" },
      "c2",
    ),
  ).toEqual({ error: "no agent session in this pane" });
  expect(h.actions).toEqual([]);
  // The default connection is not on this host: nothing is served at all.
  h.unserve();
  expect(await h.call("admin", "agent_session.list")).toEqual({ sessions: [] });
});

test("subscribing returns the snapshot to readers of the pane only", async () => {
  const h = harness();
  for (const role of [
    "admin",
    "owner",
    "editor",
    "viewer",
    "guest",
    "guest-pane",
  ] as const)
    expect(
      await h.call(role, "agent_session.subscribe", { pane_id: "w1:p1" }),
    ).toEqual(h.sessions.get("w1:p1")!);
  expect(
    (await h.call("outsider", "agent_session.subscribe", { pane_id: "w1:p1" }))
      .error,
  ).toContain("do not have access");
  expect(
    (
      await h.call("guest-pane", "agent_session.subscribe", {
        pane_id: "w1:p2",
      })
    ).error,
  ).toContain("one pane only");
  expect(
    await h.call("admin", "agent_session.subscribe", { pane_id: "w1:p9" }),
  ).toEqual({ error: "no agent session in this pane" });
  expect((await h.call("admin", "agent_session.subscribe", {})).error).toBe(
    "pane_id required",
  );
});

test("events reach subscribers in the connection's envelope until they unsubscribe", async () => {
  const h = harness();
  const event: AgentSessionEvent = {
    pane_id: "w1:p1",
    seq: 5,
    type: "delta",
    id: "m1",
    text: "hi",
  };
  h.agentSessions.publishEvent(event);
  for (const role of ["admin", "viewer"] as const)
    expect(h.pushed(role)).toEqual([]);
  await h.call("viewer", "agent_session.subscribe", { pane_id: "w1:p1" });
  await h.call("admin", "agent_session.subscribe", { pane_id: "w1:p2" });
  h.agentSessions.publishEvent(event);
  expect(h.pushed("viewer")).toEqual([
    {
      connection_id: "c1",
      connection_generation: 3,
      event: "agent_session.event",
      data: event,
    },
  ]);
  // Another pane's subscriber and everyone else hear nothing.
  expect(h.pushed("admin")).toEqual([]);
  expect(h.pushed("editor")).toEqual([]);
  expect(
    await h.call("viewer", "agent_session.unsubscribe", { pane_id: "w1:p1" }),
  ).toEqual({ ok: true });
  h.agentSessions.publishEvent({ ...event, seq: 6 });
  expect(h.pushed("viewer")).toHaveLength(1);
});

test("a subscription stops delivering once access is gone or the page closed", async () => {
  const h = harness();
  const event: AgentSessionEvent = {
    pane_id: "w1:p1",
    seq: 5,
    type: "approval_resolved",
    id: "a",
  };
  await h.call("viewer", "agent_session.subscribe", { pane_id: "w1:p1" });
  await h.call("editor", "agent_session.subscribe", { pane_id: "w1:p1" });
  h.revoke("viewer");
  h.clients.delete(h.pages.editor);
  h.agentSessions.publishEvent(event);
  expect(h.pushed("viewer")).toEqual([]);
  expect(h.pushed("editor")).toEqual([]);
});

test("every page hears the session list change, filtered like the list", async () => {
  const h = harness();
  await h.call("viewer", "agent_session.subscribe", { pane_id: "w1:p2" });
  h.sessions.set("w1:p1", session("w1:p1", "running"));
  h.sessions.delete("w1:p2");
  h.agentSessions.publishChanged();
  const changed = (role: MatrixRole) => {
    const [message] = h.pushed(role);
    expect(message).toMatchObject({
      connection_id: "c1",
      connection_generation: 3,
      event: "agent_session.changed",
    });
    return message.data.sessions.map(
      (info: { pane_id: string; status: string }) =>
        `${info.pane_id} ${info.status}`,
    );
  };
  expect(changed("admin")).toEqual(["w1:p1 running", "w2:p1 idle"]);
  expect(changed("viewer")).toEqual(["w1:p1 running"]);
  expect(changed("outsider")).toEqual(["w2:p1 idle"]);
  expect(changed("guest-pane")).toEqual(["w1:p1 running"]);
  // The ended session's subscription ended with it.
  h.sessions.set("w1:p2", session("w1:p2"));
  h.agentSessions.publishEvent({
    pane_id: "w1:p2",
    seq: 5,
    type: "approval_resolved",
    id: "a",
  });
  expect(h.pushed("viewer")).toHaveLength(1);
});

test("acting needs pane input rights and claims the pane like typing", async () => {
  const h = harness();
  expect(
    await h.call("editor", "agent_session.send", {
      pane_id: "w1:p1",
      text: "fix it",
    }),
  ).toEqual({ ok: true });
  expect(
    await h.call("owner", "agent_session.approve", {
      pane_id: "w1:p1",
      approval_id: "ap1",
      option_id: "allow",
    }),
  ).toEqual({ ok: true });
  expect(
    await h.call("admin", "agent_session.set_mode", {
      pane_id: "w1:p1",
      mode: "plan",
    }),
  ).toEqual({ ok: true });
  expect(
    await h.call("editor", "agent_session.interrupt", { pane_id: "w1:p1" }),
  ).toEqual({ ok: true });
  expect(h.actions).toEqual([
    ["w1:p1", { action: "send", text: "fix it" }],
    ["w1:p1", { action: "approve", approval_id: "ap1", option_id: "allow" }],
    ["w1:p1", { action: "set_mode", mode: "plan" }],
    ["w1:p1", { action: "interrupt" }],
  ]);
  expect(h.claims[0]).toEqual([
    "collaboration.claim",
    { participant_id: "web-editor", pane_id: "w1:p1", protect_ms: 15_000 },
  ]);
  // Readers, and members of other workspaces, cannot act.
  for (const role of ["viewer", "guest", "guest-pane", "outsider"] as const) {
    const before = h.actions.length;
    for (const [method, params] of [
      ["agent_session.send", { text: "x" }],
      ["agent_session.interrupt", {}],
      ["agent_session.approve", { approval_id: "a", option_id: "allow" }],
      ["agent_session.set_mode", { mode: "plan" }],
    ] as const)
      expect(
        (await h.call(role, method, { pane_id: "w1:p1", ...params })).error,
      ).toBeString();
    expect(h.actions).toHaveLength(before);
  }
});

test("malformed actions are refused before they reach a host", async () => {
  const h = harness();
  const send = (params: Record<string, unknown>) =>
    h.call("admin", "agent_session.send", { pane_id: "w1:p1", ...params });
  expect(await send({})).toEqual({ error: "text required" });
  expect(await send({ text: "   " })).toEqual({ error: "text required" });
  expect(await send({ text: 7 })).toEqual({ error: "text required" });
  expect(await send({ text: "x".repeat(256 * 1024 + 1) })).toEqual({
    error: "the prompt is too long",
  });
  expect(
    await h.call("admin", "agent_session.approve", {
      pane_id: "w1:p1",
      approval_id: "a",
    }),
  ).toEqual({ error: "option_id required" });
  expect(
    await h.call("admin", "agent_session.set_mode", { pane_id: "w1:p1" }),
  ).toEqual({ error: "mode required" });
  expect(h.actions).toEqual([]);
});

test("a host's refusal is the call's error", async () => {
  const h = harness();
  h.refuse("this approval is no longer pending");
  expect(
    await h.call("admin", "agent_session.approve", {
      pane_id: "w1:p1",
      approval_id: "gone",
      option_id: "allow",
    }),
  ).toEqual({ error: "this approval is no longer pending" });
});
