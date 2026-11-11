// Development only: a scripted agent session served through the same
// transport seam as the bridge, so the agent view can be worked on without
// a backend. `bun run dev:web`, then open the page with `?agentFixture`
// (main.tsx loads this file only in a dev build; production bundles never
// contain it). Every pane then has a session that replays the script below.
//
//   ?agentFixture          replay in real time
//   ?agentFixture=long     start from 1500 earlier items (scrolling, windowing)
//   ?agentFixture=exited   end with the agent process gone
//   &agentFixtureSpeed=8   replay faster
import {
  AGENT_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED,
  type AgentApproval,
  type AgentItem,
  type AgentSessionEvent,
  type AgentSessionInfo,
} from "../../../shared/agentSession";
import {
  type AgentSessionTransport,
  installAgentSessionTransport,
} from "../agentSessions";
import { store } from "../store";

type Listener = (name: string, data: unknown) => void;
type Tool = Extract<AgentItem, { type: "tool" }>;
type EventBody<T = AgentSessionEvent> = T extends unknown
  ? Omit<T, "pane_id" | "seq">
  : never;

const query = new URLSearchParams(window.location.search);
const variant = query.get("agentFixture");
const speed = Math.max(0.1, Number(query.get("agentFixtureSpeed")) || 1);
const listeners = new Set<Listener>();

const MODES = [
  { id: "default", label: "Ask before edits" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan mode" },
];

const THINKING = `The limiter refills on a fixed interval, so a burst right after a refill can take twice the budget.
A token bucket with a monotonic clock fixes that without a timer.
I should check how callers use take() before changing its signature.`;

const REPLY = `I found the problem in \`src/limiter.ts\`: the bucket refills on a **fixed interval**, so two bursts on either side of a refill pass together.

## What I will change

1. Refill continuously from elapsed time instead of on a timer.
2. Let \`take()\` ask for more than one token:
   \`\`\`ts
   limiter.take(3); // false when fewer than 3 tokens remain
   \`\`\`
3. Keep the public API otherwise unchanged.

| Case | Before | After |
| --- | --- | --- |
| Burst across a refill | 20 requests | 10 requests |
| Idle, then one call | allowed | allowed |

The core of it:

\`\`\`ts
export class Limiter {
  private tokens: number;
  private last = performance.now();

  take(count = 1): boolean {
    const now = performance.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.rate,
    );
    this.last = now;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}
\`\`\`

See the [token bucket](https://en.wikipedia.org/wiki/Token_bucket) description for the model. Running the tests first.`;

const PATCH = `@@ -8,14 +8,19 @@ export class Limiter {
   private tokens: number;
-  private timer: ReturnType<typeof setInterval>;
+  private last = performance.now();

   constructor(
     private readonly capacity: number,
     private readonly rate: number,
   ) {
     this.tokens = capacity;
-    this.timer = setInterval(() => (this.tokens = capacity), 1000);
   }

-  take(): boolean {
-    if (this.tokens < 1) return false;
-    this.tokens -= 1;
+  take(count = 1): boolean {
+    const now = performance.now();
+    this.tokens = Math.min(
+      this.capacity,
+      this.tokens + ((now - this.last) / 1000) * this.rate,
+    );
+    this.last = now;
+    if (this.tokens < count) return false;
+    this.tokens -= count;
     return true;
   }
`;

const TEST_OUTPUT = `bun test v1.4.2

src/limiter.test.ts:
(pass) allows a burst up to capacity [0.31ms]
(pass) refuses when empty [0.08ms]
(fail) does not double the budget across a refill [1.92ms]
  expected 10 to be 20

 2 pass
 1 fail
Ran 3 tests across 1 file. [48.00ms]`;

const SUMMARY = `Done. The limiter now refills from elapsed time:

- \`take(count)\` takes several tokens at once
- no timer to clean up, so \`dispose()\` is gone
- 3 tests pass

One thing left for you: \`README.md\` still describes the interval refill.`;

class FixtureSession {
  info: AgentSessionInfo;
  items: AgentItem[] = [];
  approvals: AgentApproval[] = [];
  seq = 0;
  private run = 0;
  private count = 0;
  private answer: ((option: string) => void) | null = null;

  constructor(paneId: string, kind: AgentSessionInfo["kind"], cwd: string) {
    this.info = {
      pane_id: paneId,
      kind,
      status: "starting",
      cwd,
      started_at: Date.now(),
      model: kind === "claude" ? "claude-fable-5" : "gpt-5.2-codex",
      mode: "default",
      modes: MODES,
      usage: { context_tokens: 18_400, context_window: 200_000 },
    };
    if (variant === "long") {
      for (let index = 0; index < 500; index++) {
        this.items.push(
          this.item({ type: "user", text: `Earlier prompt ${index + 1}` }),
          this.item({
            type: "tool",
            kind: "read",
            name: "Read",
            title: `src/module-${index + 1}.ts`,
            status: "done",
          }),
          this.item({
            type: "assistant",
            streaming: false,
            text: `Earlier reply ${index + 1} with \`code\` and a list:\n\n- one\n- two`,
          }),
        );
      }
    }
    void this.script(this.run);
  }

  private item(body: Record<string, unknown>) {
    return { id: `i${++this.count}`, at: Date.now(), ...body } as AgentItem;
  }

  private emit(event: EventBody) {
    const data = { pane_id: this.info.pane_id, seq: ++this.seq, ...event };
    // Copied like the wire would: the page must never share these objects.
    for (const listener of listeners)
      listener(AGENT_SESSION_EVENT, structuredClone(data));
  }

  private put(item: AgentItem) {
    const index = this.items.findIndex((known) => known.id === item.id);
    if (index < 0) this.items.push(item);
    else this.items[index] = item;
    this.emit({ type: "item", item });
    return item;
  }

  private setInfo(patch: Partial<AgentSessionInfo>) {
    const statusChanged =
      patch.status !== undefined && patch.status !== this.info.status;
    this.info = { ...this.info, ...patch };
    this.emit({ type: "info", info: this.info });
    if (statusChanged) announceSessions();
  }

  /** Waits, then says whether this run was interrupted meanwhile. */
  private async wait(ms: number, run: number) {
    await new Promise((resolve) => setTimeout(resolve, ms / speed));
    if (run !== this.run) throw new Error("interrupted");
  }

  private async stream(
    type: "assistant" | "thinking",
    text: string,
    run: number,
  ) {
    const item = this.put(this.item({ type, text: "", streaming: true }));
    for (let at = 0; at < text.length; ) {
      const size = 2 + Math.floor(Math.random() * 6);
      const delta = text.slice(at, at + size);
      at += size;
      const current = this.items.find((known) => known.id === item.id);
      if (current && "text" in current) current.text += delta;
      this.emit({ type: "delta", id: item.id, text: delta });
      await this.wait(16, run);
    }
    this.put({ ...item, text, streaming: false } as AgentItem);
  }

  private async tool(
    body: Omit<Tool, "id" | "at" | "type" | "status">,
    run: number,
    result: Partial<Tool> = {},
    ms = 700,
  ) {
    const item = this.put(
      this.item({ type: "tool", status: "running", ...body }),
    ) as Tool;
    await this.wait(ms, run);
    return this.put({ ...item, status: "done", ...result }) as Tool;
  }

  private async script(run: number, prompt?: string) {
    try {
      await this.wait(prompt ? 0 : 600, run);
      this.setInfo({ status: "running" });
      if (prompt) {
        await this.wait(400, run);
        await this.stream(
          "assistant",
          `You said: *${prompt.trim()}*\n\nThe fixture has only one script, so here is \`a short reply\` instead.`,
          run,
        );
        this.setInfo({ status: "idle" });
        return;
      }
      this.put(
        this.item({
          type: "user",
          text: "The rate limiter lets through twice its budget when a burst straddles a refill. Find out why and fix it.",
        }),
      );
      await this.wait(500, run);
      await this.stream("thinking", THINKING, run);
      const plan = this.put(
        this.item({
          type: "plan",
          entries: [
            { text: "Read the limiter and its callers", status: "in_progress" },
            { text: "Switch to a continuous refill", status: "pending" },
            { text: "Run the tests", status: "pending" },
          ],
        }),
      ) as Extract<AgentItem, { type: "plan" }>;
      await this.tool(
        { kind: "read", name: "Read", title: "src/limiter.ts" },
        run,
      );
      await this.tool(
        {
          kind: "search",
          name: "Grep",
          title: "limiter.take(",
          input:
            '{\n  "pattern": "limiter\\\\.take\\\\(",\n  "glob": "src/**/*.ts"\n}',
        },
        run,
        {
          output:
            "src/server.ts:41:  if (!limiter.take()) return tooMany();\nsrc/queue.ts:17:    while (limiter.take()) drain();",
        },
      );
      await this.stream("assistant", REPLY, run);
      this.put({
        ...plan,
        entries: [
          { text: "Read the limiter and its callers", status: "done" },
          { text: "Switch to a continuous refill", status: "in_progress" },
          { text: "Run the tests", status: "pending" },
        ],
      });
      await this.tool(
        {
          kind: "command",
          name: "Bash",
          title: "bun test src/limiter.test.ts",
          command: "bun test src/limiter.test.ts",
        },
        run,
        { status: "failed", output: TEST_OUTPUT },
        1400,
      );
      const edit = this.put(
        this.item({
          type: "tool",
          kind: "edit",
          name: "Edit",
          title: "src/limiter.ts",
          status: "pending",
          diffs: [{ path: "src/limiter.ts", patch: PATCH }],
        }),
      ) as Tool;
      const approval: AgentApproval = {
        id: `approval-${edit.id}`,
        item_id: edit.id,
        title: "Edit src/limiter.ts?",
        detail: "The agent wants to change this file.",
        options: [
          { id: "allow", label: "Allow", kind: "allow" },
          { id: "always", label: "Allow all edits", kind: "allow_always" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      };
      this.approvals.push(approval);
      this.emit({ type: "approval", approval });
      this.setInfo({ status: "awaiting_approval" });
      const option = await new Promise<string>((resolve) => {
        this.answer = resolve;
      });
      if (run !== this.run) return;
      this.setInfo({ status: "running" });
      if (option === "deny") {
        this.put({ ...edit, status: "denied" });
        this.put(
          this.item({
            type: "notice",
            level: "info",
            text: "The edit was denied; nothing changed.",
          }),
        );
        this.setInfo({ status: "idle" });
        return;
      }
      this.put({ ...edit, status: "running" });
      await this.wait(500, run);
      this.put({ ...edit, status: "done" });
      await this.tool(
        {
          kind: "command",
          name: "Bash",
          title: "bun test src/limiter.test.ts",
          command: "bun test src/limiter.test.ts",
        },
        run,
        { output: " 3 pass\n 0 fail\nRan 3 tests across 1 file. [41.00ms]" },
        1200,
      );
      this.put({
        ...plan,
        entries: plan.entries.map((entry) => ({ ...entry, status: "done" })),
      });
      this.put(
        this.item({
          type: "notice",
          level: "error",
          text: "Could not reach the package registry; skipped the dependency audit.",
        }),
      );
      await this.stream("assistant", SUMMARY, run);
      this.setInfo(
        variant === "exited"
          ? {
              status: "exited",
              error: "The agent process exited with code 1: out of memory.",
            }
          : {
              status: "idle",
              usage: { context_tokens: 41_900, context_window: 200_000 },
            },
      );
    } catch {
      // Interrupted: `interrupt` already settled the state.
    }
  }

  call(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "agent_session.subscribe":
        return structuredClone({
          info: this.info,
          items: this.items,
          approvals: this.approvals,
          seq: this.seq,
        });
      case "agent_session.send": {
        const text = String(params.text ?? "");
        this.put(this.item({ type: "user", text }));
        if (this.info.status === "idle") void this.script(++this.run, text);
        return {};
      }
      case "agent_session.interrupt": {
        this.run++;
        this.answer = null;
        for (const item of this.items) {
          if ("streaming" in item && item.streaming)
            this.put({ ...item, streaming: false });
          if (item.type === "tool" && /pending|running/.test(item.status))
            this.put({ ...item, status: "failed" });
        }
        for (const approval of this.approvals.splice(0))
          this.emit({ type: "approval_resolved", id: approval.id });
        this.put(
          this.item({ type: "notice", level: "info", text: "Interrupted." }),
        );
        this.setInfo({ status: "idle" });
        return {};
      }
      case "agent_session.approve": {
        const index = this.approvals.findIndex(
          (approval) => approval.id === params.approval_id,
        );
        if (index < 0) throw new Error("no such approval");
        this.approvals.splice(index, 1);
        this.emit({
          type: "approval_resolved",
          id: String(params.approval_id),
        });
        this.answer?.(String(params.option_id));
        this.answer = null;
        return {};
      }
      case "agent_session.set_mode":
        this.setInfo({ mode: String(params.mode) });
        return {};
      default:
        return {};
    }
  }
}

const sessions = new Map<string, FixtureSession>();

function sessionList() {
  for (const pane of store.get().panes) {
    if (!sessions.has(pane.pane_id))
      sessions.set(
        pane.pane_id,
        new FixtureSession(
          pane.pane_id,
          /codex/i.test(pane.agent ?? "") ? "codex" : "claude",
          pane.cwd ?? "~",
        ),
      );
  }
  return [...sessions.values()].map((session) => session.info);
}

function announceSessions() {
  const data = structuredClone({ sessions: sessionList() });
  for (const listener of listeners) listener(AGENT_SESSIONS_CHANGED, data);
}

const transport: AgentSessionTransport = {
  // Asynchronous like the bridge, and failing the same way.
  async call(method, params = {}) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (method === "agent_session.list")
      return structuredClone({ sessions: sessionList() });
    const session = sessions.get(String(params.pane_id));
    if (!session) throw new Error("no agent session in this pane");
    return session.call(method, params);
  },
  onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function installAgentSessionFixture() {
  installAgentSessionTransport(() => transport);
  // New panes get a session, like agents started later would.
  let known = "";
  store.subscribe(() => {
    const ids = store
      .get()
      .panes.map((pane) => pane.pane_id)
      .join();
    if (ids === known) return;
    known = ids;
    announceSessions();
  });
}
