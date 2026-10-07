import { expect, test } from "bun:test";
import { createLegacyConnectionRuntime } from "./runtime";

test("legacy runtime exposes and reports its configured connection identity", async () => {
  const events: Array<{ event: unknown; connectionId: string }> = [];
  const errors: Array<{ error: unknown; connectionId: string }> = [];
  const runtime = createLegacyConnectionRuntime({
    identity: { id: "remote-dev", label: "Remote Dev", source: "test" },
    config: {
      socketPath: "/tmp/m3-runtime-control.sock",
      clientSocketPath: "/tmp/m3-runtime-client.sock",
      sshHost: undefined,
      session: undefined,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    safeSend: () => true,
    clientLabel: () => "browser",
    markRpcError: () => undefined,
    onEvent: (event, identity) => {
      events.push({ event, connectionId: identity.id });
    },
    onError: (error, identity) => {
      errors.push({ error, connectionId: identity.id });
    },
  });

  const event = { event: "workspace.updated", data: { workspace_id: "same" } };
  const error = new Error("downstream failed");
  runtime.herdr.emit("event", event);
  runtime.herdr.emit("error", error);

  expect(runtime.identity).toEqual({
    id: "remote-dev",
    label: "Remote Dev",
    source: "test",
  });
  expect(events).toEqual([{ event, connectionId: "remote-dev" }]);
  expect(errors).toEqual([{ error, connectionId: "remote-dev" }]);
  const stopping = runtime.stop();
  runtime.herdr.emit("event", {
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent_status: "working",
    },
  });
  await stopping;
  expect(events).toEqual([{ event, connectionId: "remote-dev" }]);
});

test("layout subscription ACK and reconnect request browser and terminal reconciliation", async () => {
  const events: unknown[] = [];
  const subscriptions: Array<{ ack: () => void; close: () => void }> = [];
  const runtime = createLegacyConnectionRuntime({
    config: {
      socketPath: "/tmp/unused-layout-contract-control.sock",
      clientSocketPath: "/tmp/unused-layout-contract-client.sock",
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    safeSend: () => true,
    clientLabel: () => "test",
    markRpcError: () => undefined,
    onEvent: (event) => events.push(event),
  });
  // No real sockets, settings-driven git operations, or pane processes.
  runtime.herdr.call = async () => ({ panes: [] });
  // A reconnect can follow a live handoff that renumbered every terminal.
  const reconciled: string[] = [];
  runtime.terminalBridge.reconcileTerminals = async (reason) => {
    reconciled.push(reason);
  };
  runtime.herdr.subscribe = (types) => {
    expect(types).toContain("layout.updated");
    let ack!: () => void;
    let close!: () => void;
    const ready = new Promise<void>((resolve) => {
      ack = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    subscriptions.push({ ack, close });
    return { ready, closed, close };
  };
  try {
    runtime.startBackground();
    expect(subscriptions).toHaveLength(1);
    expect(events).toEqual([]); // No snapshot invalidation before the ACK.
    subscriptions[0]!.ack();
    await Bun.sleep(10);
    expect(events).toEqual([{ event: "session.resync_required", data: {} }]);
    expect(reconciled).toEqual([]);
    // Subscription name is dotted; tagged event envelopes use snake_case.
    const layout = {
      event: "layout_updated",
      data: { layout: { tab_id: "tab_1" } },
    };
    runtime.herdr.emit("event", layout);
    expect(events.at(-1)).toEqual(layout);
    subscriptions[0]!.close();
    const deadline = Date.now() + 3000;
    while (subscriptions.length < 2 && Date.now() < deadline)
      await Bun.sleep(10);
    expect(subscriptions).toHaveLength(2);
    expect(events).toHaveLength(2);
    subscriptions[1]!.ack();
    await Bun.sleep(10);
    expect(events.at(-1)).toEqual({
      event: "session.resync_required",
      data: {},
    });
    expect(events).toHaveLength(3);
    expect(reconciled).toEqual(["event subscription recovered"]);
  } finally {
    await runtime.stop();
  }
});
