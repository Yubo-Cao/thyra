import { describe, expect, test } from "bun:test";
import { authorize } from "./authorize";
import { HTTP_POLICY } from "./http-policy";
import { DENIED_RPC_METHODS, RPC_POLICY } from "./policy";
import {
  httpMatrix,
  rpcMatrix,
  W1_PARAMS,
} from "../../test-support/authz/matrix";
import { PRINCIPALS, testDeps } from "../../test-support/authz/principals";

/**
 * The reviewed authorization matrix. Each row lists the roles allowed to
 * call a method (or route) on workspace w1: an instance admin, w1's owner,
 * editor and viewer, an outsider who owns only w2, an anonymous share-link
 * guest of w1, and a guest whose link shows only pane w1:p1 ("-": nobody).
 * The rows are generated from the policy tables, so a new method or route
 * fails this test until its row is reviewed and added here.
 */
const RPC_MATRIX: Record<string, string> = {
  "agent.list": "admin owner editor viewer guest guest-pane",
  "agent.prompt": "-",
  "bridge.identity": "admin owner editor viewer outsider guest guest-pane",
  "bridge.identity_profile": "admin owner editor viewer outsider",
  "bridge.pause_others": "admin",
  "bridge.ping": "admin owner editor viewer outsider guest guest-pane",
  "bridge.status": "admin owner editor viewer outsider guest guest-pane",
  "collaboration.claim": "admin owner editor",
  "collaboration.leave": "admin owner editor viewer outsider guest guest-pane",
  "collaboration.list": "admin owner editor viewer outsider guest guest-pane",
  "collaboration.release": "admin owner editor viewer outsider",
  "collaboration.update": "admin owner editor viewer outsider guest guest-pane",
  "connections.connect": "admin",
  "connections.create": "admin",
  "connections.disconnect": "admin",
  "connections.list": "admin owner editor viewer outsider guest guest-pane",
  "connections.remove": "admin",
  "connections.set_default": "admin",
  "connections.test": "admin",
  "connections.update": "admin",
  "file.list": "admin owner editor viewer guest",
  "file.mkdir": "admin owner editor",
  "file.read": "admin owner editor viewer guest",
  "file.resolve": "admin owner editor viewer guest",
  "file.write": "admin owner editor",
  "git.diff_file": "admin owner editor viewer guest",
  "git.diff_summary": "admin owner editor viewer guest",
  "git.file_action": "admin owner editor",
  "git.pull": "admin owner editor",
  "git.repo_action": "admin owner editor",
  "integration.install": "-",
  "integration.list": "admin",
  "integration.uninstall": "-",
  "launcher.browse": "admin",
  "launcher.commands.get": "admin",
  "launcher.commands.set": "admin",
  "launcher.get": "admin",
  "launcher.launch": "admin",
  "launcher.pins.set": "admin",
  "pane.close": "admin owner editor",
  "pane.focus_direction": "admin owner editor",
  "pane.get": "admin owner editor viewer guest guest-pane",
  "pane.layout": "admin owner editor viewer guest guest-pane",
  "pane.list": "admin owner editor viewer guest guest-pane",
  "pane.paste": "admin owner editor",
  "pane.resize": "admin owner editor",
  "pane.send_input": "admin owner editor",
  "shell.submit": "admin owner editor",
  "shell.history": "admin owner editor",
  "shell.complete": "admin owner editor",
  "shell.subscribe": "admin owner editor",
  "pane.send_key": "admin owner editor",
  "pane.send_keys": "admin owner editor",
  "pane.send_text": "admin owner editor",
  "pane.split": "admin owner editor",
  "pane.zoom": "admin owner editor",
  "plugin.action.invoke": "admin",
  "plugin.disable": "-",
  "plugin.enable": "-",
  "popup.close": "admin",
  "server.live_handoff": "-",
  "server.stop": "-",
  "session.appearance": "admin owner editor viewer outsider guest guest-pane",
  "settings.get": "admin",
  "settings.terminal_transport.get": "admin",
  "settings.terminal_transport.update": "admin",
  "tab.close": "admin owner editor",
  "tab.create": "admin owner editor",
  "tab.focus": "admin owner editor",
  "tab.list": "admin owner editor viewer guest guest-pane",
  "tab.rename": "admin owner editor",
  "terminal.attach": "admin owner editor viewer guest guest-pane",
  "terminal.detach": "admin owner editor viewer outsider guest guest-pane",
  "terminal.display": "admin owner editor",
  "terminal.focus": "admin owner editor",
  "terminal.frame_ack": "admin owner editor viewer outsider guest guest-pane",
  "terminal.history": "admin owner editor viewer guest guest-pane",
  "terminal.host_theme": "admin",
  "terminal.input": "admin owner editor",
  "terminal.key": "admin owner editor",
  "terminal.link.resolve": "admin owner editor viewer guest guest-pane",
  "terminal.preview_text": "admin owner editor viewer guest guest-pane",
  "terminal.relay_resize": "admin owner editor",
  "terminal.resize": "admin owner editor",
  "terminal.scroll": "admin owner editor",
  "terminal.stream": "admin owner editor viewer outsider guest guest-pane",
  "terminal.watch_popup": "admin",
  "workspace.close": "admin owner",
  "workspace.create": "admin",
  "workspace.focus": "admin owner editor",
  "workspace.get": "-",
  "workspace.list": "admin owner editor viewer guest guest-pane",
  "workspace.move": "admin",
  "workspace.rename": "admin owner",
  "worktree.create": "admin",
  "worktree.list": "admin owner editor viewer guest",
  "worktree.open": "admin",
  "worktree.remove": "admin",
};

const HTTP_MATRIX: Record<string, string> = {
  "api.health": "admin owner editor viewer outsider guest guest-pane",
  "auth.avatar": "admin owner editor viewer outsider",
  "auth.avatar.remove": "admin owner editor viewer outsider",
  "auth.avatar.source": "admin owner editor viewer outsider",
  "auth.email.add": "admin owner editor viewer outsider",
  "auth.email.confirm": "admin owner editor viewer outsider",
  "auth.identities.remove": "admin owner editor viewer outsider",
  "auth.methods": "admin owner editor viewer outsider",
  "auth.passkeys.rename": "admin owner editor viewer outsider",
  "auth.profile": "admin owner editor viewer outsider",
  "auth.sessions.revoke_others": "admin owner editor viewer outsider",
  "avatar.file": "admin owner editor viewer outsider guest guest-pane",
  "email.page": "admin owner editor viewer outsider guest guest-pane anonymous",
  "email.start":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "email.verify":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "invite.accept":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "invite.check":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "invite.page":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "invites.create": "admin owner",
  "oauth.callback":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "oauth.confirm":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "oauth.poll": "admin owner editor viewer outsider guest guest-pane anonymous",
  "oauth.start":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "auth.me": "admin owner editor viewer outsider guest guest-pane",
  "auth.passkeys": "admin owner editor viewer outsider",
  "auth.passkeys.remove": "admin owner editor viewer outsider",
  "auth.sessions": "admin owner editor viewer outsider",
  "auth.sessions.revoke": "admin owner editor viewer outsider",
  "connection.file-delete": "admin owner editor",
  "connection.file-download": "admin owner editor viewer guest",
  "connection.file-upload": "admin owner editor",
  "connection.herdr-info": "admin owner editor viewer outsider",
  "connection.invalid": "admin owner editor viewer outsider guest guest-pane",
  "connection.upload-image": "admin owner editor outsider",
  "enroll.page":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "grants.list": "admin owner",
  "grants.set": "admin owner",
  health: "admin owner editor viewer outsider guest guest-pane anonymous",
  "herdr.setup": "admin",
  "herdr.status": "admin",
  "login.icon": "admin owner editor viewer outsider guest guest-pane anonymous",
  "login.page": "admin owner editor viewer outsider guest guest-pane anonymous",
  "login.script":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  logout: "admin owner editor viewer outsider guest guest-pane anonymous",
  mcp: "admin owner editor viewer outsider guest guest-pane anonymous",
  "passkey.login":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "passkey.register":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  push: "admin owner editor viewer outsider",
  "share.create": "admin owner",
  "share.list": "admin owner",
  "share.page": "admin owner editor viewer outsider guest guest-pane anonymous",
  "share.redeem":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "share.revoke": "admin owner",
  "sso.authorize":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "sso.callback":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "sso.config": "admin owner editor viewer outsider guest guest-pane anonymous",
  "sso.code": "admin owner editor viewer outsider guest guest-pane anonymous",
  "sso.redeem": "admin owner editor viewer outsider guest guest-pane anonymous",
  "sso.start": "admin owner editor viewer outsider guest guest-pane anonymous",
  static: "admin owner editor viewer outsider guest guest-pane",
  "static.asset":
    "admin owner editor viewer outsider guest guest-pane anonymous",
  "update.check": "admin",
  "update.install": "admin",
  "voice.cleanup": "admin owner editor outsider",
  "voice.status": "admin owner editor viewer outsider",
  "voice.transcribe": "admin owner editor outsider",
  ws: "admin owner editor viewer outsider guest guest-pane",
};

describe("authorization matrix", () => {
  test("covers every RPC method in the policy tables", () => {
    expect(Object.keys(RPC_MATRIX).sort()).toEqual(
      [
        ...Object.keys(RPC_POLICY),
        ...Object.keys(DENIED_RPC_METHODS),
        "workspace.get",
      ].sort(),
    );
  });

  test("RPC decisions match the reviewed matrix", async () => {
    expect(await rpcMatrix()).toEqual(RPC_MATRIX);
  });

  test("covers every HTTP route in the policy table", () => {
    expect(Object.keys(HTTP_MATRIX).sort()).toEqual(
      Object.keys(HTTP_POLICY).sort(),
    );
  });

  test("HTTP decisions match the reviewed matrix", async () => {
    expect(await httpMatrix()).toEqual(HTTP_MATRIX);
  });
});

const request = (
  role: keyof typeof PRINCIPALS,
  method: string,
  params: Record<string, unknown>,
  deps = testDeps(),
  participantId = `web-${role}`,
) =>
  authorize(
    {
      principal: PRINCIPALS[role],
      method,
      params,
      connectionId: "c1",
      participantId,
    },
    deps,
  );

describe("authorize", () => {
  test("host-wide file scopes and pane-less relay resizes need an admin", async () => {
    for (const method of ["file.read", "file.list", "file.write"]) {
      const params = { workspace_id: "w1", scope: "filesystem", path: "/" };
      expect((await request("owner", method, params)).allowed).toBe(false);
      expect((await request("admin", method, params)).allowed).toBe(true);
      expect((await request("local", method, params)).allowed).toBe(true);
    }
    expect(
      (await request("editor", "terminal.relay_resize", { cols: 80, rows: 24 }))
        .allowed,
    ).toBe(false);
  });

  test("every named id must be readable, and unknown ids fail closed", async () => {
    // A tab in w1 created from a source pane in w2.
    const cross = {
      workspace_id: "w1",
      browser_source: { pane_id: "w2:p1", workspace_id: "w1" },
    };
    expect((await request("editor", "tab.create", cross)).allowed).toBe(false);
    expect(
      (await request("editor", "terminal.attach", { terminal_id: "t2" }))
        .allowed,
    ).toBe(false);
    const unknown = await request("editor", "terminal.attach", {
      terminal_id: "nope",
    });
    expect(unknown).toMatchObject({ allowed: false });
    // Admins keep access to ids the bridge cannot place (popups).
    expect(
      (await request("admin", "terminal.attach", { terminal_id: "nope" }))
        .allowed,
    ).toBe(true);
    // Members must name a workspace.
    expect((await request("owner", "pane.split", {})).allowed).toBe(false);
    // Lists filtered to a workspace need access to it.
    expect(
      (await request("outsider", "tab.list", { workspace_id: "w1" })).allowed,
    ).toBe(false);
    expect(
      (await request("viewer", "tab.list", { workspace_id: "w1" })).allowed,
    ).toBe(true);
  });

  test("single writer: input needs the claim or an unclaimed pane", async () => {
    const claimed = testDeps({
      claims: { "w1:p1": { participantId: "web-other" } },
      participants: { "web-other": PRINCIPALS.admin.key },
    });
    for (const role of ["editor", "owner"] as const) {
      for (const method of [
        "terminal.input",
        "pane.send_text",
        "shell.submit",
        "shell.history",
        "shell.complete",
        "shell.subscribe",
        "terminal.resize",
        "terminal.focus",
      ]) {
        const decision = await request(role, method, W1_PARAMS, claimed);
        expect(decision.allowed).toBe(false);
        if (!decision.allowed)
          expect(decision.message).toContain("take control");
      }
    }
    // The holder, and the holder's other pages, may write.
    expect(
      (
        await request(
          "editor",
          "terminal.input",
          W1_PARAMS,
          claimed,
          "web-other",
        )
      ).allowed,
    ).toBe(true);
    const ownPages = testDeps({
      claims: { "w1:p1": { participantId: "web-editor-phone" } },
      participants: { "web-editor-phone": PRINCIPALS.editor.key },
    });
    expect(
      (await request("editor", "terminal.input", W1_PARAMS, ownPages)).allowed,
    ).toBe(true);
    // Input to an unclaimed pane claims it; resizing does not.
    expect(await request("editor", "terminal.input", W1_PARAMS)).toMatchObject({
      allowed: true,
      autoClaim: true,
      paneId: "w1:p1",
    });
    expect(await request("editor", "terminal.resize", W1_PARAMS)).toMatchObject(
      {
        allowed: true,
        autoClaim: false,
      },
    );
    // Viewers never write, claim or not.
    expect((await request("viewer", "terminal.input", W1_PARAMS)).allowed).toBe(
      false,
    );
  });

  test("viewers never move the shared history; non-holders scroll history only", async () => {
    const scroll = { terminal_id: "t1", direction: "up", source: "page-key" };
    // Herdr keeps one history position per pane: a viewer reads history
    // with terminal.history and browses it locally instead.
    expect((await request("viewer", "terminal.scroll", scroll)).allowed).toBe(
      false,
    );
    expect(
      (await request("viewer", "terminal.history", { pane_id: "w1:p1" }))
        .allowed,
    ).toBe(true);
    const claimed = testDeps({
      claims: { "w1:p1": { participantId: "web-other" } },
    });
    expect(
      await request("editor", "terminal.scroll", scroll, claimed),
    ).toMatchObject({ allowed: true, params: { source: "history" } });
    // A wheel, which may reach a full-screen app as cursor keys, too.
    const wheel = { ...scroll, source: "wheel" };
    expect((await request("viewer", "terminal.scroll", wheel)).allowed).toBe(
      false,
    );
    expect(
      await request("editor", "terminal.scroll", wheel, claimed),
    ).toMatchObject({ allowed: true, params: { source: "history" } });
    expect(await request("editor", "terminal.scroll", scroll)).toMatchObject({
      allowed: true,
      params: { source: "page-key" },
    });
  });

  test("claims: editors and up; owners take over anytime; protection is capped", async () => {
    const claim = { pane_id: "w1:p1", takeover: true, protect_ms: 60_000 };
    expect(
      (await request("viewer", "collaboration.claim", claim)).allowed,
    ).toBe(false);
    expect(await request("editor", "collaboration.claim", claim)).toMatchObject(
      {
        allowed: true,
        takeoverAnytime: false,
        params: { protect_ms: 15_000 },
      },
    );
    for (const role of ["owner", "admin", "local"] as const)
      expect(await request(role, "collaboration.claim", claim)).toMatchObject({
        allowed: true,
        takeoverAnytime: true,
      });
  });

  test("routine host calls from members get a harmless answer", async () => {
    expect(await request("editor", "terminal.watch_popup", {})).toMatchObject({
      allowed: true,
      stub: { result: { popup: null } },
    });
    const admin = await request("admin", "terminal.watch_popup", {});
    expect(admin.allowed && admin.stub).toBeUndefined();
    expect((await request("viewer", "settings.get", {})).allowed).toBe(false);
  });

  test("routing: another connection grants nothing", async () => {
    const decision = await authorize(
      {
        principal: PRINCIPALS.owner,
        method: "file.read",
        params: { workspace_id: "w1" },
        connectionId: "c2",
        participantId: null,
      },
      testDeps(),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("share-link guests", () => {
  test("guests are viewers of their one workspace and never write", async () => {
    for (const method of [
      "terminal.input",
      "terminal.resize",
      "terminal.focus",
      "collaboration.claim",
      "collaboration.release",
      "bridge.identity_profile",
      "file.write",
    ])
      expect((await request("guest", method, W1_PARAMS)).allowed).toBe(false);
    // Another workspace is invisible.
    expect(
      (await request("guest", "terminal.attach", { terminal_id: "t2" }))
        .allowed,
    ).toBe(false);
    expect(
      (await request("guest", "tab.list", { workspace_id: "w2" })).allowed,
    ).toBe(false);
    // Guests read history without moving anyone's view.
    expect(
      (
        await request("guest", "terminal.scroll", {
          terminal_id: "t1",
          direction: "up",
          source: "wheel",
        })
      ).allowed,
    ).toBe(false);
    expect(
      (await request("guest", "terminal.history", { pane_id: "w1:p1" }))
        .allowed,
    ).toBe(true);
  });

  test("a pane link admits only its pane and the tab holding it", async () => {
    const pane = (method: string, params: Record<string, unknown>) =>
      request("guest-pane", method, params).then(
        (decision) => decision.allowed,
      );
    expect(await pane("terminal.attach", { terminal_id: "t1" })).toBe(true);
    expect(await pane("pane.layout", { pane_id: "w1:p1" })).toBe(true);
    expect(await pane("pane.layout", { tab_id: "w1:t1" })).toBe(true);
    // The other pane of the same tab, and its terminal.
    expect(await pane("terminal.attach", { terminal_id: "t3" })).toBe(false);
    expect(await pane("pane.get", { pane_id: "w1:p2" })).toBe(false);
    expect(await pane("terminal.preview_text", { pane_id: "w1:p2" })).toBe(
      false,
    );
    expect(await pane("terminal.history", { pane_id: "w1:p2" })).toBe(false);
    // Another tab, and workspace-wide reads.
    expect(await pane("pane.layout", { tab_id: "w1:t9" })).toBe(false);
    expect(await pane("file.read", { workspace_id: "w1", path: "a" })).toBe(
      false,
    );
    expect(await pane("git.diff_summary", { workspace_id: "w1" })).toBe(false);
    // Lists name only the workspace; the bridge filters their items.
    expect(await pane("pane.list", { workspace_id: "w1" })).toBe(true);
    // Unknown terminals fail closed.
    expect(await pane("terminal.attach", { terminal_id: "nope" })).toBe(false);
  });
});
