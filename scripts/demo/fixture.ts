/**
 * Demo content for `scripts/capture-screenshots.ts`: small Git projects, the
 * terminal transcripts fake agents print, their session files, and launcher
 * pins. Everything is fixed text so repeated captures show the same product.
 */

/** Commits and session entries are dated relative to this fixed moment. */
export const DEMO_TIME = Date.parse("2026-06-12T09:41:00-07:00");
export const DEMO_TIME_ZONE = "America/Los_Angeles";

const minutes = (count: number) => DEMO_TIME - count * 60_000;

export interface DemoProject {
  /** Directory under `~/code` and the Herdr workspace label. */
  name: string;
  /** Committed on `main`. */
  files: Record<string, string>;
  /** Optional feature branch with one commit on top of `main`. */
  branch?: { name: string; message: string; files: Record<string, string> };
  /** Uncommitted edits in the working tree; `null` deletes a file. */
  working?: Record<string, string | null>;
}

const API_RATE_LIMIT_BASE = `export interface RateLimitResult {
  ok: boolean;
  retryAfterMs: number;
}

/** Fixed-window limiter: resets every \`windowMs\`. */
export function createRateLimiter(limit: number, windowMs: number) {
  let windowStart = 0;
  let count = 0;
  return (now = Date.now()): RateLimitResult => {
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return { ok: count <= limit, retryAfterMs: windowStart + windowMs - now };
  };
}
`;

const API_RATE_LIMIT_WORKING = `export interface RateLimitResult {
  ok: boolean;
  retryAfterMs: number;
}

/**
 * Sliding-window limiter: counts requests in the last \`windowMs\`, so a burst
 * at the edge of a window can no longer double the allowed rate.
 */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits: number[] = [];
  return (now = Date.now()): RateLimitResult => {
    while (hits.length > 0 && hits[0]! <= now - windowMs) hits.shift();
    if (hits.length >= limit) {
      return { ok: false, retryAfterMs: hits[0]! + windowMs - now };
    }
    hits.push(now);
    return { ok: true, retryAfterMs: 0 };
  };
}
`;

const API_RATE_LIMIT_TEST = `import { expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limit";

test("allows a burst up to the limit", () => {
  const allow = createRateLimiter(3, 1_000);
  expect([0, 1, 2].map((t) => allow(t).ok)).toEqual([true, true, true]);
});

test("rejects the next request with a retry hint", () => {
  const allow = createRateLimiter(2, 1_000);
  allow(0);
  allow(10);
  expect(allow(20)).toEqual({ ok: false, retryAfterMs: 980 });
});

test("recovers once the window slides past old requests", () => {
  const allow = createRateLimiter(1, 1_000);
  expect(allow(0).ok).toBe(true);
  expect(allow(999).ok).toBe(false);
  expect(allow(1_000).ok).toBe(true);
});
`;

const API_README = `# Orbit API

Search and ingestion API for the Orbit dashboard. It runs on Bun and keeps
state in SQLite, so a laptop is enough for local development.

\`\`\`mermaid
flowchart LR
  client[Client] --> limiter{Rate limit}
  limiter -- ok --> search[Search index]
  limiter -- 429 --> client
  search --> db[(SQLite)]
\`\`\`

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| \`GET\` | \`/v1/search\` | Full-text search over indexed documents |
| \`POST\` | \`/v1/ingest\` | Queue a document for indexing |
| \`GET\` | \`/healthz\` | Liveness probe |

## Quick start

\`\`\`bash
bun install
bun run dev      # http://localhost:3000
bun test
\`\`\`
`;

const API_README_WORKING = `${API_README}
## Rate limits

\`/v1/search\` allows **60 requests per minute** per API key over a sliding
window. Rejected requests get \`429 Too Many Requests\` with a \`Retry-After\`
header in seconds.

> Tip: batch lookups with \`?ids=a,b,c\` instead of one request per ID.
`;

const WEB_FORMAT_DATE = `const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatDate(value: Date, locale = "en-US"): string {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    formatters.set(locale, formatter);
  }
  return formatter.format(value);
}
`;

const WEB_FORMAT_DATE_WORKING = `const formatters = new Map<string, Intl.DateTimeFormat>();

/** Format in the viewer's zone; callers pass the dashboard's locale. */
export function formatDate(
  value: Date,
  locale = "en-US",
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const key = \`\${locale}|\${timeZone}\`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone });
    formatters.set(key, formatter);
  }
  return formatter.format(value);
}
`;

export const DEMO_PROJECTS: DemoProject[] = [
  {
    name: "api",
    files: {
      "README.md": API_README,
      "package.json": `{
  "name": "orbit-api",
  "private": true,
  "type": "module",
  "scripts": { "dev": "bun --watch src/server.ts", "test": "bun test" }
}
`,
      "src/server.ts": `import { search } from "./routes/search";

Bun.serve({
  port: 3000,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname !== "/v1/search") return new Response(null, { status: 404 });
    return search(url.searchParams.get("q") ?? "");
  },
});
`,
      "src/routes/search.ts": `import { index } from "../store";

export function search(query: string): Response {
  const terms = query.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  if (terms.length === 0) return Response.json({ hits: [] });
  const hits = index.filter((doc) => terms.every((term) => doc.text.includes(term)));
  return Response.json({ hits: hits.slice(0, 20) });
}
`,
      "src/store.ts": `export interface Doc {
  id: string;
  text: string;
}

export const index: Doc[] = [];
`,
      "src/rate-limit.ts": API_RATE_LIMIT_BASE,
    },
    branch: {
      name: "feat/rate-limit",
      message: "Wire the rate limiter into /v1/search",
      files: {
        "src/server.ts": `import { createRateLimiter } from "./rate-limit";
import { search } from "./routes/search";

const allow = createRateLimiter(60, 60_000);

Bun.serve({
  port: 3000,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname !== "/v1/search") return new Response(null, { status: 404 });
    const verdict = allow();
    if (!verdict.ok) {
      const seconds = Math.ceil(verdict.retryAfterMs / 1000);
      return new Response(null, { status: 429, headers: { "Retry-After": String(seconds) } });
    }
    return search(url.searchParams.get("q") ?? "");
  },
});
`,
      },
    },
    working: {
      "src/rate-limit.ts": API_RATE_LIMIT_WORKING,
      "src/rate-limit.test.ts": API_RATE_LIMIT_TEST,
      "README.md": API_README_WORKING,
    },
  },
  {
    name: "web",
    files: {
      "README.md": `# Orbit Web

The Orbit dashboard: React, Vite, and a thin client for the Orbit API.

\`\`\`bash
pnpm install
pnpm dev
\`\`\`
`,
      "package.json": `{
  "name": "orbit-web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "test": "vitest" }
}
`,
      "src/lib/formatDate.ts": WEB_FORMAT_DATE,
      "src/components/DashboardHeader.tsx": `import { formatDate } from "../lib/formatDate";

export function DashboardHeader({ updatedAt, locale }: { updatedAt: Date; locale: string }) {
  return (
    <header className="dashboard-header">
      <h1>Orbit</h1>
      <span>Updated {formatDate(updatedAt, locale)}</span>
    </header>
  );
}
`,
    },
    working: { "src/lib/formatDate.ts": WEB_FORMAT_DATE_WORKING },
  },
  {
    name: "docs",
    files: {
      "README.md": `# Orbit Docs

User guides for Orbit in English and Simplified Chinese.

- [Getting started](guide/getting-started.md)
- [快速开始](guide/zh-CN/getting-started.md)
`,
      "guide/getting-started.md": `# Getting started

1. Create an API key under **Settings > Keys**.
2. Call \`GET /v1/search?q=orbit\` with the key in the \`Authorization\` header.
`,
      "guide/zh-CN/getting-started.md": `# 快速开始

1. 在 **设置 > 密钥** 中创建 API 密钥。
2. 在 \`Authorization\` 请求头中携带密钥，调用 \`GET /v1/search?q=orbit\`。
`,
    },
  },
];

/** Extra folders so the launcher lists more than the open workspaces. */
export const DEMO_EXTRA_FOLDERS = ["code/infra", "code/mobile", "notes"];

/** Launcher pins and history, stored in Thyra's settings per connection. */
export const DEMO_LAUNCHER = {
  pinned: ["~/code/api", "~/code/web", "~/code/infra"],
  history: [
    { path: "~/code/docs", count: 6, minutesAgo: 30 },
    { path: "~/code/mobile", count: 3, minutesAgo: 60 * 26 },
    { path: "~/notes", count: 2, minutesAgo: 60 * 50 },
  ],
};

// ---------------------------------------------------------------------------
// Terminal screens printed by the fake agents, re-rendered on every resize

const ESC = "\u001b[";
const sgr = (code: string) => (text: string) => `${ESC}${code}m${text}${ESC}0m`;
const dim = sgr("2");
const bold = sgr("1");
const inverse = sgr("7");
const orange = sgr("38;5;173");
const green = sgr("38;5;114");
const red = sgr("38;5;174");
const blue = sgr("38;5;75");
const violet = sgr("38;5;141");
const gray = sgr("38;5;245");

/** SGR color and style escapes, which take no terminal cells. */
const SGR_PATTERN = /\u001b\[[0-9;]*m/g;

/** Terminal cell width: East Asian wide characters take two cells. */
function cellWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(SGR_PATTERN, "")) {
    const code = char.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60)
        ? 2
        : 1;
  }
  return width;
}

/** One screen line, a full-width rule, or a box that shrinks to fit. */
type ScreenLine =
  | string
  | { rule: (text: string) => string }
  | { box: string[]; width: number; color: (text: string) => string };

/** Word-wrap an ANSI line, continuing under its first word's indent. */
function wrapLine(line: string, columns: number): string[] {
  if (cellWidth(line) <= columns) return [line];
  const visible = line.replace(SGR_PATTERN, "");
  const indent = " ".repeat(
    visible.match(/^\s*(?:[⏺•›>✢✻⎿└+-]\s+|\d+\s+)?/)?.[0].length ?? 0,
  );
  const tokens = line.split(/(?<= )/);
  const rows: string[] = [];
  let row = "";
  for (const token of tokens) {
    if (row && cellWidth(row + token.trimEnd()) > columns) {
      rows.push(row.trimEnd());
      row = indent + token.trimStart();
    } else {
      row += token;
    }
  }
  if (row.trim()) rows.push(row.trimEnd());
  return rows;
}

function renderBox(
  lines: string[],
  width: number,
  color: (text: string) => string,
  columns: number,
): string[] {
  const inner = Math.max(10, Math.min(width, columns - 4));
  const body = lines.flatMap((line) => (line ? wrapLine(line, inner) : [line]));
  return [
    color(`╭${"─".repeat(inner + 2)}╮`),
    ...body.map(
      (line) =>
        `${color("│")} ${line}${" ".repeat(Math.max(0, inner - cellWidth(line)))} ${color("│")}`,
    ),
    color(`╰${"─".repeat(inner + 2)}╯`),
  ];
}

function renderScreen(lines: ScreenLine[], columns: number): string {
  return lines
    .flatMap((line) => {
      if (typeof line === "string") return wrapLine(line, columns);
      if ("rule" in line) return [line.rule("─".repeat(columns))];
      return renderBox(line.box, line.width, line.color, columns);
    })
    .join("\r\n");
}

const CLAUDE_API_SCREEN: ScreenLine[] = [
  {
    box: [
      `${orange("✻")} Welcome to ${bold("Claude Code")}`,
      "",
      dim("  /help for help, /status for your setup"),
      "",
      dim("  cwd: ~/code/api"),
    ],
    width: 44,
    color: orange,
  },
  "",
  `${gray(">")} Replace the fixed-window limiter with a sliding window, keep the 429 Retry-After contract, and cover the edge cases with tests.`,
  "",
  `${orange("⏺")} I'll read the limiter and the route that uses it first.`,
  "",
  `${orange("⏺")} ${bold("Read")}(src/rate-limit.ts)`,
  `  ${dim("⎿")}  Read 18 lines`,
  `${orange("⏺")} ${bold("Read")}(src/server.ts)`,
  `  ${dim("⎿")}  Read 21 lines`,
  "",
  `${orange("⏺")} ${bold("Update")}(src/rate-limit.ts)`,
  `  ${dim("⎿")}  Updated src/rate-limit.ts with 9 additions and 7 removals`,
  `      ${green("+ const hits: number[] = [];")}`,
  `      ${green("+ while (hits.length > 0 && hits[0]! <= now - windowMs) hits.shift();")}`,
  `      ${red("- if (now - windowStart >= windowMs) {")}`,
  "",
  `${orange("⏺")} ${bold("Bash")}(bun test src/rate-limit.test.ts)`,
  `  ${dim("⎿")}  ${green("✓")} allows a burst up to the limit ${dim("[0.21ms]")}`,
  `     ${green("✓")} rejects the next request with a retry hint ${dim("[0.08ms]")}`,
  `     ${green("✓")} recovers once the window slides past old requests ${dim("[0.05ms]")}`,
  `     ${green("3 pass")} ${dim("·")} 0 fail ${dim("·")} 6 expect() calls`,
  "",
  `${orange("⏺")} Tests pass. Request times now live in a queue, so ${blue("hits.length >= limit")} is exact for any window, and a rejected request still returns 429 (${blue("verdict.ok !== true")} => Retry-After).`,
  "",
  `${orange("✢")} ${orange("Documenting rate limits in README…")} ${dim("(esc to interrupt)")}`,
  "",
  { rule: gray },
  `${gray(">")} `,
  { rule: gray },
  `  ${dim("? for shortcuts")}`,
];

const CODEX_WEB_SCREEN: ScreenLine[] = [
  {
    box: [
      `${bold(">_ OpenAI Codex")} ${dim("(v0.48.0)")}`,
      "",
      `${dim("model:")}     gpt-5-codex high`,
      `${dim("directory:")} ~/code/web`,
    ],
    width: 40,
    color: gray,
  },
  "",
  `${bold("›")} Dashboard dates show the server's day. Format them in the viewer's time zone and keep zh-CN output like 2026年6月12日.`,
  "",
  `${violet("•")} ${bold("Explored")}`,
  `  ${dim("└")} Read formatDate.ts, DashboardHeader.tsx`,
  "",
  `${violet("•")} ${bold("Edited")} src/lib/formatDate.ts ${green("(+9")} ${red("-3)")}`,
  `    ${dim("4")} ${green("+  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,")}`,
  `    ${dim("6")} ${green("+  const key = `${locale}|${timeZone}`;")}`,
  "",
  `${violet("•")} ${bold("Ran")} pnpm vitest run formatDate`,
  `  ${dim("└")} ${green("✓")} formats 2026-06-12 as Jun 12, 2026 for en-US`,
  `    ${green("✓")} formats 2026-06-12 as 2026年6月12日 for zh-CN`,
  `    ${green("✓")} uses the viewer's zone (UTC-7) => Jun 11`,
  "",
  `${violet("•")} Formatting now follows the viewer's zone. The type check needs the lockfile refreshed first.`,
  "",
  {
    box: [
      bold("Allow command?"),
      "",
      blue("$ pnpm install"),
      "",
      `${inverse(" 1 Yes ")}  2 Always  3 No`,
    ],
    width: 40,
    color: blue,
  },
];

const CLAUDE_DOCS_SCREEN: ScreenLine[] = [
  {
    box: [
      `${orange("✻")} Welcome to ${bold("Claude Code")}`,
      "",
      dim("  cwd: ~/code/docs"),
    ],
    width: 44,
    color: orange,
  },
  "",
  `${gray(">")} Translate the getting-started guide into Simplified Chinese.`,
  "",
  `${orange("⏺")} ${bold("Write")}(guide/zh-CN/getting-started.md)`,
  `  ${dim("⎿")}  Wrote 4 lines`,
  "      # 快速开始",
  "      1. 在 **设置 > 密钥** 中创建 API 密钥。",
  "",
  `${orange("⏺")} Done. The Chinese guide mirrors both steps, and the README links to either language.`,
  "",
  { rule: gray },
  `${gray(">")} `,
  { rule: gray },
];

/** Fake agent screens keyed by `<agent>-<project>`. */
export const AGENT_SCREENS: Record<string, ScreenLine[]> = {
  "claude-api": CLAUDE_API_SCREEN,
  "codex-web": CODEX_WEB_SCREEN,
  "claude-docs": CLAUDE_DOCS_SCREEN,
};

export function renderAgentScreen(key: string, columns: number): string {
  const screen = AGENT_SCREENS[key];
  if (!screen) return `${key}: no demo screen\r\n`;
  return renderScreen(screen, Math.max(20, columns));
}

// ---------------------------------------------------------------------------
// Agent session files (Claude Code and Codex JSONL formats)

const iso = (minutesAgo: number) => new Date(minutes(minutesAgo)).toISOString();

export const CLAUDE_API_SESSION_ID = "4f1c2a9e-6b0d-4d7e-9a51-3c2f8e7b1d40";
export const CLAUDE_DOCS_SESSION_ID = "9d7e3b21-58c4-4a0f-b6e2-71c0a4d95f18";
export const CODEX_WEB_SESSION_ID = "0199a3c4-7e21-7b40-9c5d-2f8a61e0b3d7";

function claudeRecord(
  sessionId: string,
  cwd: string,
  minutesAgo: number,
  role: "user" | "assistant",
  content: unknown[],
) {
  return {
    type: role,
    sessionId,
    cwd,
    version: "2.1.3",
    gitBranch: "feat/rate-limit",
    timestamp: iso(minutesAgo),
    message: {
      role,
      ...(role === "assistant"
        ? {
            model: "claude-sonnet-4-5",
            usage: { input_tokens: 1840, output_tokens: 312 },
          }
        : {}),
      content,
    },
  };
}

export function claudeApiSession(cwd: string) {
  const r = (m: number, role: "user" | "assistant", content: unknown[]) =>
    claudeRecord(CLAUDE_API_SESSION_ID, cwd, m, role, content);
  return [
    r(14, "user", [
      {
        type: "text",
        text: "Replace the fixed-window limiter with a sliding window, keep the 429 Retry-After contract, and cover the edge cases with tests.",
      },
    ]),
    r(14, "assistant", [
      {
        type: "text",
        text: "I'll read the limiter and the route that uses it first.",
      },
      {
        type: "tool_use",
        id: "toolu_01",
        name: "Read",
        input: { file_path: `${cwd}/src/rate-limit.ts` },
      },
    ]),
    r(13, "user", [
      {
        type: "tool_result",
        tool_use_id: "toolu_01",
        content:
          "export function createRateLimiter(limit: number, windowMs: number) {\n  let windowStart = 0;\n  let count = 0;\n  …",
      },
    ]),
    r(12, "assistant", [
      {
        type: "text",
        text: "The fixed window lets a client send `2 × limit` requests across a window boundary. A queue of request times fixes that without a timer.",
      },
      {
        type: "tool_use",
        id: "toolu_02",
        name: "Edit",
        input: {
          file_path: `${cwd}/src/rate-limit.ts`,
          old_string: "if (now - windowStart >= windowMs) {",
          new_string:
            "while (hits.length > 0 && hits[0]! <= now - windowMs) hits.shift();",
        },
      },
    ]),
    r(12, "user", [
      {
        type: "tool_result",
        tool_use_id: "toolu_02",
        content: "The file src/rate-limit.ts has been updated.",
      },
    ]),
    r(10, "assistant", [
      {
        type: "tool_use",
        id: "toolu_03",
        name: "Bash",
        input: {
          command: "bun test src/rate-limit.test.ts",
          description: "Run the limiter tests",
        },
      },
    ]),
    r(9, "user", [
      {
        type: "tool_result",
        tool_use_id: "toolu_03",
        content:
          "src/rate-limit.test.ts:\n✓ allows a burst up to the limit [0.21ms]\n✓ rejects the next request with a retry hint [0.08ms]\n✓ recovers once the window slides past old requests [0.05ms]\n\n 3 pass\n 0 fail\n 6 expect() calls",
      },
    ]),
    r(8, "assistant", [
      {
        type: "text",
        text: "Tests pass. The limiter now keeps request times in a queue, so `hits.length >= limit` is exact for any window, and the route's 429 path is unchanged.\n\nNext I'll document the limit in the README.",
      },
    ]),
  ];
}

export function claudeDocsSession(cwd: string) {
  const r = (m: number, role: "user" | "assistant", content: unknown[]) => ({
    ...claudeRecord(CLAUDE_DOCS_SESSION_ID, cwd, m, role, content),
    gitBranch: "main",
  });
  return [
    r(42, "user", [
      {
        type: "text",
        text: "Translate the getting-started guide into Simplified Chinese.",
      },
    ]),
    r(41, "assistant", [
      {
        type: "tool_use",
        id: "toolu_11",
        name: "Write",
        input: {
          file_path: `${cwd}/guide/zh-CN/getting-started.md`,
          content: "# 快速开始\n…",
        },
      },
    ]),
    r(41, "user", [
      {
        type: "tool_result",
        tool_use_id: "toolu_11",
        content: "File created successfully.",
      },
    ]),
    r(40, "assistant", [
      {
        type: "text",
        text: "Done. The Chinese guide mirrors both steps, and the README links to either language.",
      },
    ]),
  ];
}

export function codexWebSession(cwd: string) {
  const item = (m: number, payload: Record<string, unknown>) => ({
    timestamp: iso(m),
    type: "response_item",
    payload,
  });
  return [
    {
      timestamp: iso(6),
      type: "session_meta",
      payload: {
        id: CODEX_WEB_SESSION_ID,
        timestamp: iso(6),
        cwd,
        originator: "codex_cli_rs",
        cli_version: "0.48.0",
      },
    },
    item(6, {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Dashboard dates show the server's day. Format them in the viewer's time zone and keep zh-CN output like 2026年6月12日.",
        },
      ],
    }),
    item(5, {
      type: "reasoning",
      summary: [
        {
          type: "summary_text",
          text: "**Checking the formatter cache**\n\nThe cache is keyed by locale only, so adding a time zone needs a composite key.",
        },
      ],
    }),
    item(5, {
      type: "function_call",
      name: "shell",
      call_id: "call_1",
      arguments: JSON.stringify({
        command: ["bash", "-lc", "pnpm vitest run formatDate"],
        workdir: cwd,
      }),
    }),
    item(4, {
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({
        output:
          " ✓ formats 2026-06-12 as Jun 12, 2026 for en-US\n ✓ formats 2026-06-12 as 2026年6月12日 for zh-CN\n ✓ uses the viewer's zone (UTC-7)\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)",
        metadata: { exit_code: 0, duration_seconds: 1.4 },
      }),
    }),
    item(3, {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Formatting now uses the viewer's time zone and caches one formatter per locale and zone. The type check needs `pnpm install` to refresh the lockfile; approve it to continue.",
        },
      ],
    }),
  ];
}
