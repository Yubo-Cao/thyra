import { describe, expect, test } from "bun:test";
import {
  agentCommand,
  compactFolderPath,
  emptyLauncherSettings,
  launchFrecency,
  liveFolderWeights,
  MAX_HISTORY_ENTRIES,
  normalizeFolderPath,
  normalizeLauncherSettings,
  parseZoxideOutput,
  rankRecentFolders,
  recordLaunch,
  validateAgentCommand,
  workspaceForFolder,
} from "./folders";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("folder paths", () => {
  test("normalizes absolute paths and rejects everything else", () => {
    expect(normalizeFolderPath("/home/me//proj/")).toBe("/home/me/proj");
    expect(normalizeFolderPath(" /home/me/./proj ")).toBe("/home/me/proj");
    expect(normalizeFolderPath("/")).toBe("/");
    expect(normalizeFolderPath("proj")).toBeNull();
    expect(normalizeFolderPath("~/proj")).toBeNull();
    expect(normalizeFolderPath("/home/me/../root")).toBeNull();
    expect(normalizeFolderPath("/home/me\nproj")).toBeNull();
    expect(normalizeFolderPath(42)).toBeNull();
  });

  test("shortens the home directory to ~", () => {
    expect(compactFolderPath("/home/me", "/home/me")).toBe("~");
    expect(compactFolderPath("/home/me/proj/a", "/home/me/")).toBe("~/proj/a");
    expect(compactFolderPath("/home/meadow", "/home/me")).toBe("/home/meadow");
    expect(compactFolderPath("/srv/x", "/home/me")).toBe("/srv/x");
  });
});

describe("agent commands", () => {
  test("accept one line of shell text", () => {
    expect(validateAgentCommand("  c ")).toBe("c");
    expect(validateAgentCommand("claude --model opus")).toBe(
      "claude --model opus",
    );
    expect(() => validateAgentCommand("")).toThrow("empty");
    expect(() => validateAgentCommand("c\nrm -rf ~")).toThrow("single line");
    expect(() => validateAgentCommand("x".repeat(257))).toThrow("256");
    expect(() => validateAgentCommand(null)).toThrow("text");
  });

  test("default to claude and codex until configured", () => {
    const settings = emptyLauncherSettings();
    expect(agentCommand(settings, "claude")).toBe("claude");
    expect(agentCommand(settings, "codex")).toBe("codex");
    settings.commands.claude = "c";
    expect(agentCommand(settings, "claude")).toBe("c");
  });
});

describe("settings normalization", () => {
  test("keeps valid pins, commands, and history and drops the rest", () => {
    const settings = normalizeLauncherSettings({
      pinned: ["/a/", "/a", "relative", 7, "/b"],
      commands: { claude: " c ", codex: "x\ny", other: "z" },
      history: [
        { path: "/a", count: 3, last_used_at: 10 },
        { path: "/a", count: 9, last_used_at: 11 },
        { path: "rel", count: 1, last_used_at: 1 },
        { path: "/c", count: 0, last_used_at: 1 },
        { path: "/d", count: 2.4, last_used_at: 5 },
      ],
    });
    expect(settings).toEqual({
      pinned: ["/a", "/b"],
      commands: { claude: "c" },
      history: [
        { path: "/a", count: 3, last_used_at: 10 },
        { path: "/d", count: 2, last_used_at: 5 },
      ],
    });
    expect(normalizeLauncherSettings("junk")).toEqual(emptyLauncherSettings());
  });
});

describe("launch history", () => {
  test("counts repeat launches and caps the list", () => {
    let history = recordLaunch([], "/a", 1);
    history = recordLaunch(history, "/b", 2);
    history = recordLaunch(history, "/a", 3);
    expect(history).toEqual([
      { path: "/a", count: 2, last_used_at: 3 },
      { path: "/b", count: 1, last_used_at: 2 },
    ]);
    for (let index = 0; index < MAX_HISTORY_ENTRIES + 5; index += 1)
      history = recordLaunch(history, `/p${index}`, 10 + index);
    expect(history).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(history[0].path).toBe(`/p${MAX_HISTORY_ENTRIES + 4}`);
  });

  test("weights recent launches above old ones", () => {
    const entry = (age: number) => ({
      path: "/a",
      count: 2,
      last_used_at: NOW - age,
    });
    expect(launchFrecency(entry(10), NOW)).toBe(8);
    expect(launchFrecency(entry(2 * HOUR), NOW)).toBe(4);
    expect(launchFrecency(entry(48 * HOUR), NOW)).toBe(2);
    expect(launchFrecency(entry(30 * 24 * HOUR), NOW)).toBe(0.5);
  });
});

test("parses zoxide list output", () => {
  expect(
    parseZoxideOutput(
      "1140.0 /home/me/Downloads\n  12.5 /home/me/a b/\njunk\n3 relative\n",
    ),
  ).toEqual([
    { path: "/home/me/Downloads", score: 1140 },
    { path: "/home/me/a b", score: 12.5 },
  ]);
});

describe("workspace matching", () => {
  const workspaces = [
    { workspace_id: "w1", worktree: { checkout_path: "/repo" } },
    { workspace_id: "w2" },
    { workspace_id: "w3" },
  ];
  const panes = [
    { workspace_id: "w2", cwd: "/notes" },
    { workspace_id: "w3", cwd: "/notes" },
    { workspace_id: "w3", cwd: "/notes/" },
    { workspace_id: "w1", cwd: "/notes" },
    { workspace_id: "gone", cwd: "/elsewhere" },
  ];

  test("prefers the checkout, then the workspace with most panes there", () => {
    expect(workspaceForFolder("/repo", workspaces, panes)).toBe("w1");
    expect(workspaceForFolder("/notes", workspaces, panes)).toBe("w3");
    expect(workspaceForFolder("/elsewhere", workspaces, panes)).toBeNull();
    expect(workspaceForFolder("/new", workspaces, panes)).toBeNull();
  });

  test("weights open checkouts above single pane directories", () => {
    const weights = liveFolderWeights(workspaces, [
      ...panes,
      { workspace_id: "w1", cwd: "/repo", foreground_cwd: "/repo/src" },
    ]);
    expect(weights.get("/repo")).toBe(8);
    expect(weights.get("/repo/src")).toBe(1);
    expect(weights.get("/notes")).toBe(8);
  });
});

describe("recent folder ranking", () => {
  test("merges sources, dedupes, and excludes pins, home, and root", () => {
    const ranked = rankRecentFolders({
      history: [
        { path: "/home/me/a", count: 3, last_used_at: NOW - 10 },
        { path: "/home/me/old", count: 1, last_used_at: NOW - 60 * 24 * HOUR },
        { path: "/home/me/pinned", count: 9, last_used_at: NOW },
      ],
      live: new Map([
        ["/home/me/b", 8],
        ["/home/me", 12],
        ["/", 2],
        ["/home/me/old", 2],
      ]),
      zoxide: [
        { path: "/home/me/Downloads", score: 1000 },
        { path: "/home/me/a", score: 10 },
        { path: "/home/me/c", score: 250 },
      ],
      exclude: ["/home/me/pinned"],
      home: "/home/me/",
      now: NOW,
    });
    expect(ranked.map((entry) => entry.path)).toEqual([
      "/home/me/a",
      "/home/me/b",
      "/home/me/Downloads",
      "/home/me/old",
      "/home/me/c",
    ]);
    expect(ranked[0].sources).toEqual(["launched", "zoxide"]);
    expect(ranked[3].sources).toEqual(["launched", "open"]);
  });

  test("works without zoxide or history", () => {
    expect(
      rankRecentFolders({
        history: [],
        live: new Map([["/srv/app", 2]]),
        zoxide: [],
        exclude: [],
        home: "/home/me",
        now: NOW,
      }),
    ).toEqual([{ path: "/srv/app", sources: ["open"], score: 2 }]);
  });
});
