import { join } from "node:path";
import type { ShellInputState } from "../../../shared/shell";
import { ShellCompleter } from "./completion";
import { ShellHistoryStore } from "./history";
import { shellPaths } from "./paths";
import { ShellStateTracker, type ShellCall } from "./state";

export function createShellService(args: {
  call: ShellCall;
  dir?: string;
  stateDir?: string;
  /** Legacy SSH profiles tunnel Herdr, not a remote Thyra service. */
  enabled?: boolean;
}) {
  const paths = shellPaths();
  const listeners = new Map<
    object,
    Map<string, (state: ShellInputState) => void>
  >();
  const pending = new Map<string, ShellInputState>();
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  const deliver = (value: ShellInputState) => {
    for (const panes of listeners.values()) panes.get(value.pane_id)?.(value);
  };
  const flush = () => {
    deliveryTimer = undefined;
    const updates = [...pending.values()];
    pending.clear();
    for (const value of updates) deliver(value);
    if (updates.length) deliveryTimer = setTimeout(flush, 50);
  };
  const state = new ShellStateTracker({
    dir: args.dir ?? paths.runtime,
    call: args.call,
    changed(value) {
      if (!listeners.size) return;
      if (!deliveryTimer) {
        deliver(value);
        deliveryTimer = setTimeout(flush, 50);
      } else pending.set(value.pane_id, value);
    },
  });
  const complete = new ShellCompleter();
  let history: ShellHistoryStore | undefined;
  return {
    state,
    start: () => (args.enabled === false ? Promise.resolve() : state.start()),
    async stop() {
      listeners.clear();
      clearTimeout(deliveryTimer);
      pending.clear();
      await state.stop();
      await history?.close();
    },
    unsubscribe(client: object) {
      listeners.delete(client);
    },
    async rpc(
      method: string,
      params: Record<string, unknown>,
      client: object,
      publish: (state: ShellInputState) => void,
      current = () => true,
    ) {
      const pane = params.pane_id;
      if (typeof pane !== "string" || !pane || pane.length > 256)
        throw new Error("pane_id required");
      if (args.enabled === false) {
        if (method === "shell.submit")
          return { ok: false, reason: "no_integration" };
        if (method === "shell.subscribe")
          return {
            pane_id: pane,
            available: false,
            reason: "no_integration",
            seq: 0,
            bracketed_paste: false,
          };
        throw new Error("no_integration");
      }
      if (method === "shell.submit") {
        if (
          !Number.isSafeInteger(params.seq) ||
          typeof params.text !== "string" ||
          typeof params.execute !== "boolean"
        )
          throw new Error("invalid shell.submit params");
        return state.submit(
          {
            pane_id: pane,
            seq: params.seq as number,
            text: params.text,
            execute: params.execute,
          },
          current,
        );
      }
      const snapshot = await state.refresh(pane);
      if (!current()) throw new Error("connection changed during request");
      if (method === "shell.subscribe") {
        if (params.enabled !== undefined && typeof params.enabled !== "boolean")
          throw new Error("enabled must be a boolean");
        let panes = listeners.get(client);
        if (!panes) {
          panes = new Map();
          listeners.set(client, panes);
        }
        if (params.enabled === false) panes.delete(pane);
        else panes.set(pane, publish);
        return snapshot;
      }
      const record = state.record(pane);
      if (!record) throw new Error("no_integration");
      if (method === "shell.history") {
        if (
          (params.limit !== undefined &&
            (!Number.isInteger(params.limit) || Number(params.limit) < 1)) ||
          [params.prefix, params.query, params.cwd].some(
            (value) =>
              value !== undefined &&
              (typeof value !== "string" || value.length > 16384),
          ) ||
          (params.latest !== undefined && typeof params.latest !== "boolean")
        )
          throw new Error("invalid shell.history params");
        const dir = args.stateDir ?? paths.state;
        history ??= new ShellHistoryStore(
          join(dir, "shell-history.sqlite"),
          join(dir, "shell-history.jsonl"),
        );
        await history.ingest();
        await history.import(record);
        return {
          entries: history.search({ pane_id: pane, ...params }, record.cwd),
        };
      }
      if (method === "shell.complete") {
        if (
          typeof params.line !== "string" ||
          params.line.length > 16384 ||
          !Number.isInteger(params.cursor) ||
          Number(params.cursor) < 0 ||
          Number(params.cursor) > params.line.length
        )
          throw new Error("invalid shell.complete params");
        return complete.complete(record, params.line, params.cursor as number);
      }
      throw new Error("unknown shell method");
    },
  };
}
