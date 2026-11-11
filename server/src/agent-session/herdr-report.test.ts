import { afterEach, expect, jest, test } from "bun:test";
import { rmSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import {
  createHerdrReporter,
  herdrSocketRequest,
  herdrStateOf,
} from "./herdr-report";
import { settle, socketRoot, until } from "./test-support";

const roots: string[] = [];
afterEach(() => {
  jest.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function reporter(now: () => number = () => 5000) {
  const sent: [string, Record<string, unknown>][] = [];
  const created = createHerdrReporter({
    paneId: "w1:p1",
    kind: "codex",
    request: async (method, params) => {
      sent.push([method, params]);
    },
    now,
  });
  return { reporter: created, sent };
}

test("session statuses map to Herdr's agent states", () => {
  expect(herdrStateOf("starting")).toBe("idle");
  expect(herdrStateOf("idle")).toBe("idle");
  expect(herdrStateOf("running")).toBe("working");
  expect(herdrStateOf("awaiting_approval")).toBe("blocked");
});

test("each change is one report from this source with a rising sequence", async () => {
  const { reporter: herdr, sent } = reporter();
  herdr.report("idle");
  herdr.report("working");
  herdr.report("working");
  herdr.report("blocked", "Run: rm -rf build");
  await settle();
  expect(sent).toEqual([
    [
      "pane.report_agent",
      {
        pane_id: "w1:p1",
        source: "thyra:agent",
        agent: "codex",
        seq: 5000,
        state: "idle",
      },
    ],
    [
      "pane.report_agent",
      {
        pane_id: "w1:p1",
        source: "thyra:agent",
        agent: "codex",
        seq: 5001,
        state: "working",
      },
    ],
    [
      "pane.report_agent",
      {
        pane_id: "w1:p1",
        source: "thyra:agent",
        agent: "codex",
        seq: 5002,
        state: "blocked",
        message: "Run: rm -rf build",
      },
    ],
  ]);
});

test("the first state is repeated in case Herdr was not listening yet", async () => {
  jest.useFakeTimers();
  const { reporter: herdr, sent } = reporter();
  herdr.report("idle");
  await settle();
  jest.advanceTimersByTime(10_000);
  await settle();
  expect(sent.map(([, params]) => params.state)).toEqual([
    "idle",
    "idle",
    "idle",
  ]);
  // A newer state cancels the repeats instead of being overwritten by them.
  const second = reporter();
  second.reporter.report("idle");
  second.reporter.report("working");
  await settle();
  jest.advanceTimersByTime(10_000);
  await settle();
  expect(second.sent.map(([, params]) => params.state)).toEqual([
    "idle",
    "working",
  ]);
});

test("release is final", async () => {
  jest.useFakeTimers();
  const { reporter: herdr, sent } = reporter();
  herdr.report("working");
  await herdr.release();
  await herdr.release();
  herdr.report("idle");
  jest.advanceTimersByTime(10_000);
  await settle();
  expect(sent.map(([method]) => method)).toEqual([
    "pane.report_agent",
    "pane.release_agent",
  ]);
  expect(sent[1]![1]).toEqual({
    pane_id: "w1:p1",
    source: "thyra:agent",
    agent: "codex",
    seq: 5001,
  });
});

test("a request is one line on its own connection, and no Herdr is not an error", async () => {
  const root = socketRoot();
  roots.push(root);
  const path = join(root, "herdr.sock");
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      lines.push(chunk.toString());
      socket.end('{"id":"x","result":{"type":"ok"}}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const request = herdrSocketRequest(path);
    await request("pane.report_agent", { pane_id: "w1:p1", state: "idle" });
    await request("pane.release_agent", { pane_id: "w1:p1" });
    await until(() => lines.length === 2, "both requests");
    expect(lines.map((line) => line.endsWith("\n"))).toEqual([true, true]);
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      {
        method: "pane.report_agent",
        params: { pane_id: "w1:p1", state: "idle" },
      },
      { method: "pane.release_agent", params: { pane_id: "w1:p1" } },
    ]);
  } finally {
    server.close();
  }
  await herdrSocketRequest(join(root, "missing.sock"))("pane.report_agent", {});
});
