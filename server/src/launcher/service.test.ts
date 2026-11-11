import { describe, expect, test } from "bun:test";
import type { GuiSettings } from "../config/gui-settings";
import type { LauncherHost } from "./host";
import {
  agentSessionCommand,
  agentSessionDefaultArgs,
  createLauncherService,
} from "./service";

const NOW = 1_800_000_000_000;
const HOME = "/home/me";

function harness(
  options: {
    directories?: string[];
    zoxide?: Array<{ path: string; score: number }> | null;
    failSend?: boolean;
    launcher?: GuiSettings["launcher"];
    /** How panes start `thyra agent`; null where sessions are not served. */
    agentHostCommand?: string | null;
  } = {},
) {
  const directories = new Set(
    options.directories ?? [
      HOME,
      `${HOME}/repo`,
      `${HOME}/notes`,
      `${HOME}/pinned`,
    ],
  );
  let settings: GuiSettings = {
    version: 1,
    launcher: options.launcher ?? {},
    custom: {},
  };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const host: LauncherHost = {
    async probe(paths, probeOptions) {
      return {
        home: HOME,
        directories: new Set(paths.filter((path) => directories.has(path))),
        zoxide: probeOptions.zoxide ? (options.zoxide ?? null) : null,
      };
    },
    async listDirectories(path) {
      if (!directories.has(path)) throw new Error("not a directory");
      return {
        path,
        directories: [...directories]
          .filter((entry) => entry.startsWith(`${path}/`))
          .map((entry) => entry.slice(path.length + 1))
          .filter((name) => !name.includes("/")),
        truncated: false,
      };
    },
  };
  const service = createLauncherService({
    connectionId: "local",
    host,
    agentHostCommand: () => options.agentHostCommand ?? null,
    now: () => NOW,
    readSettings: async () => settings,
    updateSettings: async (update, shouldCommit = () => true) => {
      if (!shouldCommit()) throw new Error("settings update cancelled");
      settings = update(settings);
      return settings;
    },
    herdrCall: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "workspace.list")
        return {
          workspaces: [
            {
              workspace_id: "w1",
              label: "repo",
              worktree: { checkout_path: `${HOME}/repo` },
            },
          ],
        };
      if (method === "pane.list")
        return {
          panes: [{ workspace_id: "w1", pane_id: "p1", cwd: `${HOME}/repo` }],
        };
      if (method === "tab.create")
        return {
          type: "tab_created",
          tab: { tab_id: "w1:t2", workspace_id: "w1" },
          root_pane: { pane_id: "p9", tab_id: "w1:t2", workspace_id: "w1" },
        };
      if (method === "workspace.create")
        return {
          type: "workspace_created",
          workspace: { workspace_id: "w2" },
          tab: { tab_id: "w2:t1", workspace_id: "w2" },
          root_pane: { pane_id: "p10", tab_id: "w2:t1", workspace_id: "w2" },
        };
      if (method === "pane.send_input" && options.failSend)
        throw new Error("pane gone");
      return {};
    },
  });
  return {
    service,
    calls,
    settings: () => settings.launcher?.local,
    methods: () => calls.map((call) => call.method),
  };
}

describe("launcher.get", () => {
  test("lists pins, ranked recent folders, and agent commands", async () => {
    const { service } = harness({
      launcher: {
        local: {
          pinned: [`${HOME}/pinned`, `${HOME}/gone`],
          commands: { claude: "c" },
          history: [
            { path: `${HOME}/notes`, count: 2, last_used_at: NOW - 1000 },
            { path: `${HOME}/deleted`, count: 5, last_used_at: NOW },
          ],
        },
      },
      zoxide: [
        { path: `${HOME}/zoxide-only`, score: 5 },
        { path: `${HOME}/pinned`, score: 50 },
      ],
    });
    const result = (await service.call("launcher.get", {})) as any;
    expect(result.home).toBe(HOME);
    expect(result.zoxide).toBe(true);
    expect(result.pinned).toEqual([
      { path: `${HOME}/pinned`, display: "~/pinned", sources: ["pinned"] },
      {
        path: `${HOME}/gone`,
        display: "~/gone",
        sources: ["pinned"],
        missing: true,
      },
    ]);
    expect(result.recent).toEqual([
      { path: `${HOME}/notes`, display: "~/notes", sources: ["launched"] },
      {
        path: `${HOME}/repo`,
        display: "~/repo",
        sources: ["open"],
        workspace: { workspace_id: "w1", label: "repo" },
      },
      {
        path: `${HOME}/zoxide-only`,
        display: "~/zoxide-only",
        sources: ["zoxide"],
      },
    ]);
    expect(result.agents).toEqual([
      {
        id: "claude",
        label: "Claude",
        command: "c",
        default_command: "claude",
      },
      {
        id: "codex",
        label: "Codex",
        command: "codex",
        default_command: "codex",
      },
    ]);
  });

  test("lists open folders when zoxide is unavailable", async () => {
    const { service } = harness({ zoxide: null });
    const result = (await service.call("launcher.get", {})) as any;
    expect(result.zoxide).toBe(false);
    expect(result.recent.map((entry: any) => entry.path)).toEqual([
      `${HOME}/repo`,
    ]);
  });
});

describe("launcher.launch", () => {
  test("adds a tab to the folder's workspace and types the configured command", async () => {
    const { service, calls, settings } = harness({
      launcher: {
        local: { pinned: [], commands: { claude: "c" }, history: [] },
      },
    });
    const result = (await service.call("launcher.launch", {
      path: "~/repo/",
      agent: "claude",
      command: "rm -rf /",
    })) as any;
    expect(calls.find((call) => call.method === "tab.create")?.params).toEqual({
      workspace_id: "w1",
      cwd: `${HOME}/repo`,
      focus: false,
    });
    expect(
      calls.find((call) => call.method === "pane.send_input")?.params,
    ).toEqual({ pane_id: "p9", text: "c", keys: ["enter"] });
    expect(result).toMatchObject({
      type: "tab_created",
      pane_id: "p9",
      path: `${HOME}/repo`,
      agent: "claude",
      command: "c",
      reused_workspace: true,
    });
    expect(result.start_error).toBeUndefined();
    expect(settings()?.history).toEqual([
      { path: `${HOME}/repo`, count: 1, last_used_at: NOW },
    ]);
  });

  test("waits for the prompt before sending the command", async () => {
    const { service, methods } = harness();
    await service.call("launcher.launch", {
      path: `${HOME}/repo`,
      agent: "codex",
    });
    const order = methods();
    expect(order.indexOf("pane.wait_for_output")).toBeGreaterThan(
      order.indexOf("tab.create"),
    );
    expect(order.indexOf("pane.send_input")).toBeGreaterThan(
      order.indexOf("pane.wait_for_output"),
    );
  });

  test("rejects unknown agents, relative paths, and missing folders before creating", async () => {
    const { service, methods } = harness();
    await expect(
      service.call("launcher.launch", { path: `${HOME}/repo`, agent: "sh" }),
    ).rejects.toThrow("known agent");
    await expect(
      service.call("launcher.launch", { path: "repo", agent: "claude" }),
    ).rejects.toThrow("absolute path");
    await expect(
      service.call("launcher.launch", {
        path: `${HOME}/missing`,
        agent: "claude",
      }),
    ).rejects.toThrow("Folder not found");
    expect(methods()).toEqual([]);
  });

  test("does not create anything for a retired request", async () => {
    const { service, methods } = harness();
    await expect(
      service.call(
        "launcher.launch",
        { path: `${HOME}/repo`, agent: "claude" },
        () => false,
      ),
    ).rejects.toThrow();
    expect(methods()).not.toContain("tab.create");
  });

  test("reports a failed command start without hiding the new tab", async () => {
    const { service } = harness({ failSend: true });
    const result = (await service.call("launcher.launch", {
      path: `${HOME}/repo`,
      agent: "claude",
    })) as any;
    expect(result.root_pane.pane_id).toBe("p9");
    expect(result.start_error).toBe("pane gone");
  });
});

describe("launcher.launch view", () => {
  const sent = (calls: Array<{ method: string; params: any }>) =>
    calls.find((call) => call.method === "pane.send_input")?.params.text;

  test("the terminal view is the default and types the configured command", async () => {
    const { service, calls } = harness({ agentHostCommand: "/opt/thyra" });
    const result = (await service.call("launcher.launch", {
      path: `${HOME}/repo`,
      agent: "claude",
    })) as any;
    expect(sent(calls)).toBe("claude");
    expect(result).toMatchObject({ view: "terminal", command: "claude" });
    const explicit = harness({ agentHostCommand: "/opt/thyra" });
    await explicit.service.call("launcher.launch", {
      path: `${HOME}/repo`,
      agent: "codex",
      view: "terminal",
    });
    expect(sent(explicit.calls)).toBe("codex");
  });

  test("the gui view runs this executable's agent host with the command's arguments", async () => {
    const { service, calls } = harness({
      agentHostCommand: "/opt/thyra/bin/thyra",
      launcher: {
        local: {
          pinned: [],
          commands: { claude: "claude --model opus  --effort high" },
          history: [],
        },
      },
    });
    const result = (await service.call("launcher.launch", {
      path: `${HOME}/repo`,
      agent: "claude",
      view: "gui",
    })) as any;
    const command =
      "/opt/thyra/bin/thyra agent claude --model opus  --effort high";
    expect(sent(calls)).toBe(command);
    expect(result).toMatchObject({
      view: "gui",
      agent: "claude",
      command,
      pane_id: "p9",
    });
    const plain = harness({ agentHostCommand: "/opt/thyra/bin/thyra" });
    await plain.service.call("launcher.launch", {
      path: `${HOME}/repo`,
      agent: "codex",
      view: "gui",
    });
    expect(sent(plain.calls)).toBe("/opt/thyra/bin/thyra agent codex");
  });

  test("a command that is not the agent's own contributes no arguments", () => {
    const host = "bun /src/index.ts";
    expect(agentSessionCommand(host, "claude", "claude")).toBe(
      "bun /src/index.ts agent claude",
    );
    expect(agentSessionCommand(host, "codex", " codex  -m gpt-x ")).toBe(
      "bun /src/index.ts agent codex -m gpt-x",
    );
    for (const configured of [
      "claude-wrapper --flag",
      "FOO=1 claude --flag",
      "npx claude --flag",
      "cc",
      "codex --flag",
    ])
      expect(agentSessionCommand(host, "claude", configured)).toBe(
        "bun /src/index.ts agent claude",
      );
  });

  test("the deployment's arguments apply when the command gives none", () => {
    const host = "/opt/thyra/bin/thyra";
    // An alias or a bare command leaves the deployment's arguments.
    for (const configured of ["x", "codex", "wrapper --flag"])
      expect(agentSessionCommand(host, "codex", configured, " --yolo ")).toBe(
        "/opt/thyra/bin/thyra agent codex --yolo",
      );
    // The command's own arguments win.
    expect(
      agentSessionCommand(host, "codex", "codex -a on-request", "--yolo"),
    ).toBe("/opt/thyra/bin/thyra agent codex -a on-request");
    expect(
      agentSessionDefaultArgs("codex", { THYRA_AGENT_CODEX_ARGS: " --yolo " }),
    ).toBe("--yolo");
    expect(
      agentSessionDefaultArgs("claude", {
        THYRA_AGENT_CLAUDE_ARGS: "--permission-mode plan",
        THYRA_AGENT_CODEX_ARGS: "--yolo",
      }),
    ).toBe("--permission-mode plan");
    expect(agentSessionDefaultArgs("claude", {})).toBe("");
    expect(
      agentSessionDefaultArgs("claude", {
        THYRA_AGENT_CLAUDE_ARGS: "--model x\nrm -rf /",
      }),
    ).toBe("");
  });

  test("the gui view is refused where sessions are not served, and bad views always", async () => {
    const remote = harness({ agentHostCommand: null });
    await expect(
      remote.service.call("launcher.launch", {
        path: `${HOME}/repo`,
        agent: "claude",
        view: "gui",
      }),
    ).rejects.toThrow("only available on the default local connection");
    expect(remote.methods()).toEqual([]);
    const local = harness({ agentHostCommand: "/opt/thyra" });
    await expect(
      local.service.call("launcher.launch", {
        path: `${HOME}/repo`,
        agent: "claude",
        view: "tui",
      }),
    ).rejects.toThrow('view must be "gui" or "terminal"');
    expect(local.methods()).toEqual([]);
  });
});

describe("launcher settings", () => {
  test("pins must exist when added and keep the requested order", async () => {
    const { service, settings } = harness({
      launcher: {
        local: { pinned: [`${HOME}/gone`], commands: {}, history: [] },
      },
    });
    await expect(
      service.call("launcher.pins.set", { pinned: [`${HOME}/nope`] }),
    ).rejects.toThrow("Folder not found");
    expect(
      await service.call("launcher.pins.set", {
        pinned: ["~/notes", `${HOME}/gone`, "~/notes/"],
      }),
    ).toEqual({ pinned: [`${HOME}/notes`, `${HOME}/gone`] });
    expect(settings()?.pinned).toEqual([`${HOME}/notes`, `${HOME}/gone`]);
    await expect(
      service.call("launcher.pins.set", { pinned: "~/notes" }),
    ).rejects.toThrow("pinned array");
  });

  test("commands validate and reset to defaults", async () => {
    const { service, settings } = harness();
    const updated = (await service.call("launcher.commands.set", {
      commands: { claude: " c ", codex: "x" },
    })) as any;
    expect(updated.agents.map((agent: any) => agent.command)).toEqual([
      "c",
      "x",
    ]);
    expect(settings()?.commands).toEqual({ claude: "c", codex: "x" });
    expect(
      ((await service.call("launcher.commands.get", {})) as any).agents[0]
        .command,
    ).toBe("c");
    await service.call("launcher.commands.set", {
      commands: { claude: "", codex: "codex" },
    });
    expect(settings()?.commands).toEqual({});
    await expect(
      service.call("launcher.commands.set", { commands: { claude: "a\nb" } }),
    ).rejects.toThrow("single line");
    await expect(
      service.call("launcher.commands.set", { commands: { bash: "bash" } }),
    ).rejects.toThrow("Unknown launcher agent");
  });
});

test("launcher.browse lists subfolders from home by default", async () => {
  const { service } = harness();
  expect(
    ((await service.call("launcher.browse", { path: "~/repo" })) as any)
      .workspace,
  ).toEqual({ workspace_id: "w1", label: "repo" });
  expect(await service.call("launcher.browse", {})).toEqual({
    path: HOME,
    display: "~",
    parent: "/home",
    truncated: false,
    entries: [
      { name: "repo", path: `${HOME}/repo` },
      { name: "notes", path: `${HOME}/notes` },
      { name: "pinned", path: `${HOME}/pinned` },
    ],
  });
  await expect(
    service.call("launcher.browse", { path: "/missing" }),
  ).rejects.toThrow("Cannot open folder /missing");
});
