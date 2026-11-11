// Development only: a scripted agent session served through the same
// transport seam as the bridge, so the agent view can be worked on without
// a backend. `bun run dev:web`, then open the page with `?agentFixture`
// (main.tsx loads this file only in a dev build; production bundles never
// contain it). Every pane then has a session that replays the script below.
//
//   ?agentFixture          replay in real time
//   ?agentFixture=long     start from 1500 earlier items (scrolling, windowing)
//   ?agentFixture=exited   end with the agent process gone
//   ?agentFixture=resume   start empty, with stored conversations to continue
//   &agentFixtureSpeed=8   replay faster
//
// Prompt images stay in the page: an "upload" takes a moment and gets a host
// path the transcript can show again. A file named `fail...` is refused, and
// so is a prompt that starts with `/refuse`. A prompt sent while the script
// runs waits in the queue (or steers, or stops it), and `/compact` compacts.
// so is a prompt that starts with `/refuse`. Every prompt can be rewound
// to; a branch is refused, since only a bridge can open its pane.
import {
  AGENT_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED,
  type AgentApproval,
  type AgentItem,
  type AgentPromptDelivery,
  type AgentPromptImage,
  type AgentSessionEvent,
  type AgentSessionInfo,
  type AgentStoredSession,
} from "../../../shared/agentSession";
import {
  type AgentSessionTransport,
  agentSessionsStore,
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
  { id: "default", label: "Ask before edits and commands" },
  { id: "acceptEdits", label: "Accept edits, ask before commands" },
  { id: "plan", label: "Plan (read only)" },
  { id: "bypassPermissions", label: "Full access (bypass permissions)" },
];

const MODELS = [
  {
    id: "claude-fable-5",
    label: "Fable 5",
    description: "Most capable for your hardest tasks",
    efforts: ["low", "medium", "high", "max"],
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    description: "Efficient for routine tasks",
    efforts: ["low", "medium", "high"],
  },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", description: "Fastest" },
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

const README_PATCH = `@@ -21,5 +21,6 @@ ## Rate limits
-The limiter refills its bucket once per second.
+The limiter refills continuously: \`rate\` tokens per second, up to
+\`capacity\`. \`take(count)\` takes several tokens at once.
`;

/** Prompt images by the host path each was given, as addresses to show. */
const uploads = new Map<string, string>();
/** An image on the "host" from the start, and one that is no longer there. */
const SAMPLE_IMAGE = "/tmp/herdr-img-fixture-load-test.png";
const GONE_IMAGE = "/tmp/herdr-img-fixture-earlier-run.png";
uploads.set(
  SAMPLE_IMAGE,
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="280" font-family="sans-serif" font-size="13">
<rect width="560" height="280" fill="#f7f8fa"/>
<text x="24" y="34" font-size="16" font-weight="700" fill="#24292f">Requests allowed per second</text>
<line x1="24" y1="230" x2="536" y2="230" stroke="#636c76"/>
<line x1="24" y1="150" x2="536" y2="150" stroke="#d03b3b" stroke-dasharray="6 4"/>
<text x="536" y="142" text-anchor="end" fill="#d03b3b">budget: 10</text>
${[10, 9, 20, 10, 8, 19, 10, 10]
  .map(
    (value, index) =>
      `<rect x="${44 + index * 60}" y="${230 - value * 8}" width="36" height="${value * 8}" fill="${value > 10 ? "#d03b3b" : "#2f6fe0"}"/><text x="${62 + index * 60}" y="250" text-anchor="middle" fill="#636c76">${index + 1}s</text>`,
  )
  .join("")}
</svg>`,
  )}`,
);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A stored conversation whose resume the host refuses. */
const UNREADABLE = "5d0e8a52-7c1b-4f0e-9d3a-0f6b2c8e4a17";
/** Stored conversations of every session's agent, newest first. */
const STORED: AgentStoredSession[] = (
  [
    [
      "b7a1f3c9-2e44-4d0a-8c55-91f0a6d2e3b4",
      "The rate limiter lets through twice its budget when a burst straddles a refill",
      4 * MINUTE,
    ],
    [
      "e2c9d7a0-63f1-4b8e-a2d4-5c7f9e1b0a36",
      "Add retry with backoff to the webhook sender",
      3 * HOUR,
    ],
    [
      "91d4b6e8-0a2c-47f3-b5e9-d8c1a3f7e062",
      "Why does the nightly export time out for the largest tenants? Start from the slow query log in ops/slow-2026-06.txt, compare the plans before and after the index change, and write up what you find",
      26 * HOUR,
    ],
    [UNREADABLE, "Bisect the flaky queue test", 4 * DAY],
    [
      "3f8e2a1d-9b07-4c6e-8d15-a4e0c7b9f2d8",
      "把限流器改成按经过时间连续补充令牌",
      9 * DAY,
    ],
    [
      "c05a9e7b-4d21-4f8a-9e63-2b7d1f0a8c5e",
      "Update the README for the new config format",
      21 * DAY,
    ],
    ["a64c0f2e-8b3d-4e19-b7a0-6d9e5c1f3a72", "", 70 * DAY],
    ["7e1b5d9c-3a60-4f2b-8c4e-0a9d6f2e1b83", "Set up the project", 400 * DAY],
  ] as const
).map(([id, title, age]) => ({ id, title, updated_at: Date.now() - age }));

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
      model: "claude-fable-5",
      models: MODELS,
      effort: "high",
      efforts: MODELS[0]!.efforts,
      mode: "default",
      modes: MODES,
      usage: { context_tokens: 18_400, context_window: 200_000 },
      can_resume: true,
      can_attach_images: true,
      can_set_model: true,
      can_queue: true,
      can_compact: true,
      can_rewind: true,
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
    if (variant === "resume") void this.settle(this.run);
    else void this.script(this.run);
  }

  /** A fresh session: the agent comes up and waits for a prompt. */
  private async settle(run: number) {
    try {
      await this.wait(600, run);
      this.setInfo({ status: "idle" });
    } catch {
      // Interrupted or resumed meanwhile.
    }
  }

  /** The transcript of a stored conversation, as it ended. */
  private stored(prompt: string, at: number): AgentItem[] {
    const tool = (body: Omit<Tool, "id" | "at" | "type" | "status">) => ({
      type: "tool",
      status: "done",
      ...body,
    });
    return [
      { type: "user", text: prompt || "Fix the rate limiter." },
      { type: "thinking", text: THINKING, streaming: false },
      {
        type: "plan",
        entries: [
          "Read the limiter and its callers",
          "Switch to a continuous refill",
          "Run the tests",
        ].map((text) => ({ text, status: "done" })),
      },
      tool({ kind: "read", name: "Read", title: "src/limiter.ts" }),
      tool({
        kind: "search",
        name: "Grep",
        title: "limiter.take(",
        output:
          "src/server.ts:41:  if (!limiter.take()) return tooMany();\nsrc/queue.ts:17:    while (limiter.take()) drain();",
      }),
      { type: "assistant", text: REPLY, streaming: false },
      {
        ...tool({
          kind: "command",
          name: "Bash",
          title: "bun test src/limiter.test.ts",
          command: "bun test src/limiter.test.ts",
          output: TEST_OUTPUT,
        }),
        status: "failed",
      },
      tool({
        kind: "edit",
        name: "Edit",
        title: "src/limiter.ts",
        diffs: [{ path: "src/limiter.ts", patch: PATCH }],
      }),
      tool({
        kind: "command",
        name: "Bash",
        title: "bun test src/limiter.test.ts",
        command: "bun test src/limiter.test.ts",
        output: " 3 pass\n 0 fail\nRan 3 tests across 1 file. [41.00ms]",
      }),
      { type: "assistant", text: SUMMARY, streaming: false },
      {
        type: "user",
        text: "Here is the load test before the change: [Image #1]\n\nThe run after it should be flat. I had a chart of an **earlier** run too: [Image #2]",
        images: [{ path: SAMPLE_IMAGE }, { path: GONE_IMAGE }],
      },
      {
        type: "assistant",
        text: "The two red bars are the bursts that straddle a refill: 19 and 20 requests against a budget of 10. I cannot open the second image.",
        streaming: false,
      },
      { type: "user", text: "Good. Bring the README in line with it." },
      tool({
        kind: "edit",
        name: "Edit",
        title: "README.md",
        diffs: [{ path: "README.md", patch: README_PATCH }],
      }),
      {
        type: "assistant",
        text: "`README.md` now describes the continuous refill and `take(count)`.",
        streaming: false,
      },
    ].map((body, index, all) => ({
      ...this.item(body),
      at: at - (all.length - index) * 20_000,
    }));
  }

  /** Continue a stored conversation; Claude restarts its process for it. */
  private async resume(run: number, stored: AgentStoredSession) {
    try {
      if (this.info.kind === "claude") {
        this.setInfo({ status: "starting" });
        await this.wait(1500, run);
      } else {
        await this.wait(300, run);
      }
      this.items = this.stored(stored.title, stored.updated_at);
      this.approvals = [];
      this.emit({ type: "reset", items: this.items });
      this.setInfo({
        status: "idle",
        agent_session_id: stored.id,
        usage: { context_tokens: 41_900, context_window: 200_000 },
      });
    } catch {
      // Interrupted: `interrupt` already settled the state.
    }
  }

  private item(body: Record<string, unknown>) {
    const id = `i${++this.count}`;
    // Every prompt can be gone back to, as one that started a turn can.
    const ref = body.type === "user" ? { ref: `ref-${id}` } : {};
    return { id, at: Date.now(), ...ref, ...body } as AgentItem;
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
    // Idle again: the next queued prompt goes, as a host sends it.
    const [next, ...rest] = this.info.queued ?? [];
    if (this.info.status === "idle" && next) {
      this.setInfo({ queued: rest.length ? rest : undefined });
      this.prompt(next.text, next.images ?? []);
    }
  }

  private prompt(text: string, images: AgentPromptImage[]) {
    this.put(
      this.item({ type: "user", text, ...(images.length ? { images } : {}) }),
    );
    if (text.trim() === "/compact") {
      this.put(
        this.item({
          type: "notice",
          level: "info",
          text: "Conversation compacted.",
        }),
      );
      this.setInfo({
        usage: { context_tokens: 6_200, context_window: 200_000 },
      });
    } else if (this.info.status === "idle")
      void this.script(++this.run, text, images.length);
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

  private async script(run: number, prompt?: string, images = 0) {
    try {
      await this.wait(prompt ? 0 : 600, run);
      this.setInfo({ status: "running" });
      if (prompt) {
        await this.wait(400, run);
        await this.stream(
          "assistant",
          `You said: *${prompt.trim()}*\n\n${
            images
              ? `It came with ${images} image${images > 1 ? "s" : ""}. `
              : ""
          }The fixture has only one script, so here is \`a short reply\` instead.`,
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
        if (text.startsWith("/refuse"))
          throw new Error("the agent did not take the prompt");
        const images = Array.isArray(params.images)
          ? (params.images as AgentPromptImage[])
          : [];
        const delivery = params.delivery as AgentPromptDelivery | undefined;
        if (this.info.status !== "idle" && delivery && delivery !== "steer") {
          const entry = {
            id: `q${++this.count}`,
            text,
            ...(images.length ? { images } : {}),
            at: Date.now(),
          };
          const queued = this.info.queued ?? [];
          this.setInfo({
            queued:
              delivery === "interrupt"
                ? [entry, ...queued]
                : [...queued, entry],
          });
          if (delivery === "interrupt")
            this.call("agent_session.interrupt", {});
          return {};
        }
        this.prompt(text, images);
        return {};
      }
      case "agent_session.unqueue": {
        const queued = this.info.queued ?? [];
        if (!queued.some((prompt) => prompt.id === params.prompt_id))
          throw new Error("that prompt is no longer queued");
        const rest = queued.filter((prompt) => prompt.id !== params.prompt_id);
        this.setInfo({ queued: rest.length ? rest : undefined });
        return {};
      }
      case "agent_session.set_model": {
        const model = MODELS.find((item) => item.id === params.model);
        if (!model) throw new Error(`unknown model: ${String(params.model)}`);
        this.setInfo({
          model: model.id,
          efforts: model.efforts,
          effort: model.efforts?.includes(this.info.effort ?? "")
            ? this.info.effort
            : model.efforts?.[0],
        });
        return {};
      }
      case "agent_session.set_effort":
        this.setInfo({ effort: String(params.effort) });
        return {};
      case "agent_session.compact":
        if (this.info.status !== "idle") throw new Error("a turn is running");
        this.prompt("/compact", []);
        return {};
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
      case "agent_session.history":
        return structuredClone({
          sessions: STORED.filter(
            (stored) => stored.id !== this.info.agent_session_id,
          ),
        });
      case "agent_session.rewind": {
        if (/running|awaiting_approval/.test(this.info.status))
          throw new Error("a turn is running");
        const index = this.items.findIndex(
          (item) => item.id === params.item_id,
        );
        if (index < 0 || this.items[index]!.type !== "user")
          throw new Error("that prompt is not in the transcript");
        this.items = this.items.slice(0, index);
        this.emit({ type: "reset", items: this.items });
        this.setInfo({});
        return { ok: true };
      }
      case "agent_session.fork":
        // A branch is a new pane, which only a bridge can open.
        throw new Error("the fixture cannot open a pane for the branch");
      case "agent_session.resume": {
        const stored = STORED.find((item) => item.id === params.session_id);
        if (!stored) throw new Error("no such stored conversation");
        if (/running|awaiting_approval/.test(this.info.status))
          throw new Error("a turn is running");
        if (stored.id === UNREADABLE)
          throw new Error("its transcript file could not be read");
        // Answered before the transcript is there, like a slow host would.
        void this.resume(++this.run, stored);
        return { ok: true };
      }
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
  async uploadImage(file) {
    await new Promise((resolve) => setTimeout(resolve, 900 / speed));
    if (file.name.startsWith("fail"))
      throw new Error("the host did not take the image");
    const path = `/tmp/herdr-img-fixture-${uploads.size}.${file.type.split("/")[1] || "png"}`;
    uploads.set(path, URL.createObjectURL(file));
    // What reached the "host", after the page prepared it.
    console.info(
      `[agentFixture] uploaded ${file.name}: ${file.type}, ${file.size} bytes`,
    );
    return path;
  },
  imageUrl: (path) => uploads.get(path) ?? null,
};

export function installAgentSessionFixture() {
  installAgentSessionTransport(() => transport);
  // A bridge that runs agent sessions may be followed already. Off for a
  // moment, the page lets go of it and follows again through the fixture.
  agentSessionsStore.setState({ available: false, sessions: {} });
  setTimeout(() => agentSessionsStore.setState({ available: true }));
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
