import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { startTestServer } from "./test-harness";

const ORIGIN = "https://dev.example";

function guestCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("thyra_guest="));
  expect(cookie).toBeDefined();
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("; Secure");
  expect(cookie).toContain("SameSite=Lax");
  return cookie!.split(";", 1)[0]!;
}

function linkParts(text: string) {
  const match = text.match(/https:\/\/dev\.example\/s\/([\w-]+)#([\w-]+)/);
  expect(match).not.toBeNull();
  return { id: match![1]!, secret: match![2]! };
}

// The real router behind a simulated Caddy: links from the CLI and the API,
// redemption, the guest's authority on HTTP and the WebSocket, revocation,
// expiry, max uses and the redemption rate limit.
test("share links make read-only guests that end with their link", async () => {
  const server = await startTestServer({
    whois: { "100.64.7.7": "owner@example.com" },
  });
  try {
    const { request, proxy } = server;
    const outside = proxy("203.0.113.5");
    const json = {
      ...outside,
      origin: ORIGIN,
      "content-type": "application/json",
    };
    const redeem = (
      body: Record<string, unknown>,
      headers: Record<string, string> = json,
    ) =>
      request("/api/share/redeem", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

    const created = await server.cli(
      "share",
      "create",
      "w1",
      "--label",
      "demo",
      "--expires",
      "1h",
    );
    expect(created.code).toBe(0);
    const link = linkParts(created.stdout);

    // The landing page carries no secret and sends no Referer.
    const page = await request(`/s/${link.id}`, {
      headers: { ...outside, accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Open shared view");
    expect(
      (await request("/s/x", { headers: { ...outside, accept: "text/html" } }))
        .status,
    ).toBe(405);

    // Guessing is rate-limited per client address.
    const guesser = { ...json, ...proxy("198.51.100.9") };
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect(
        (await redeem({ id: link.id, secret: `guess-${attempt}` }, guesser))
          .status,
      ).toBe(404);
    const blocked = await redeem(link, guesser);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();

    // Redeeming creates a guest principal with a guest cookie.
    const redeemed = await redeem(link);
    expect(redeemed.status).toBe(200);
    const cookie = guestCookie(redeemed);
    const guest = { ...outside, cookie };
    const health = await (
      await request("/api/health", { headers: guest })
    ).json();
    expect(health).toMatchObject({
      auth_required: false,
      principal: {
        kind: "guest",
        role: "guest",
        share: {
          connection_id: "legacy-default",
          workspace_id: "w1",
          pane_id: null,
          label: "demo",
        },
      },
    });
    expect(health.socket).toBeUndefined();
    // The same browser redeeming again keeps its session and its use.
    expect((await redeem(link, { ...json, cookie })).status).toBe(200);
    // Guests reach no account, push, sharing or host routes.
    for (const path of [
      "/api/auth/sessions",
      "/api/auth/passkeys",
      "/api/notifications/push",
      "/api/voice/status",
      "/api/update/check",
      "/api/workspace-grants?connection_id=legacy-default&workspace_id=w1",
      "/api/share-links?connection_id=legacy-default&workspace_id=w1",
    ])
      expect((await request(path, { headers: guest })).status).toBe(403);
    expect(
      (await request("/", { headers: { ...guest, accept: "text/html" } }))
        .status,
    ).toBe(200);

    // On the WebSocket the guest watches but never writes. (Without a
    // Herdr, connection-scoped calls may fail routing first; the matrix
    // and the browser E2E cover their authorization.)
    const socket = await server.connect({ ...outside, origin: ORIGIN, cookie });
    expect(socket.hello.principal).toMatchObject({ kind: "guest" });
    expect(socket.hello.socket).toBeUndefined();
    expect((await socket.call("bridge.ping")).result).toEqual({ ok: true });
    expect(
      (await socket.call("bridge.identity_profile", { display_name: "x" }))
        .error?.message,
    ).toContain("share link");
    expect(
      (await socket.call("connections.create", { profile: {} })).error?.message,
    ).toContain("instance admin");
    for (const [method, params] of [
      ["terminal.input", { terminal_id: "t1", data: "ls\r" }],
      ["pane.send_text", { pane_id: "w1:p1", text: "ls" }],
      ["terminal.resize", { pane_id: "w1:p1", cols: 1, rows: 1 }],
      ["collaboration.claim", { pane_id: "w1:p1" }],
      ["file.write", { workspace_id: "w1", path: "a" }],
      ["launcher.get", {}],
      ["workspace.create", {}],
    ] as const) {
      const reply = await socket.call(method, params);
      expect(reply.result).toBeUndefined();
      expect(reply.error?.message).toBeString();
    }

    // Revoking the link closes the guest's socket within a second or two.
    const revoked = await server.cli("share", "revoke", link.id);
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain("1 guest session(s) ended");
    expect(await socket.closed).toMatchObject({ code: 4001 });
    expect((await request("/api/health", { headers: guest })).status).toBe(401);
    expect((await redeem(link)).status).toBe(410);
    // The ended view explains itself and clears the stale cookie.
    const ended = await request("/login", {
      headers: { ...guest, accept: "text/html" },
    });
    expect(await ended.text()).toContain("Shared view ended");
    expect(
      ended.headers
        .getSetCookie()
        .some((value) => value.startsWith("thyra_guest=;")),
    ).toBe(true);

    // A tailnet admin creates, lists and revokes links over HTTP.
    const tailnet = proxy("100.64.7.7");
    const admin = await request("/", {
      headers: { ...tailnet, accept: "text/html" },
    });
    const adminCookie = admin.headers
      .getSetCookie()
      .find((value) => value.startsWith("thyra_session="))!
      .split(";", 1)[0]!;
    const api = "/api/share-links?connection_id=legacy-default&workspace_id=w1";
    const made = await request(api, {
      method: "POST",
      headers: { ...json, cookie: adminCookie },
      body: JSON.stringify({ expires: "7d", max_uses: 1, pane_id: "w1:p2" }),
    });
    expect(made.status).toBe(200);
    const body = (await made.json()) as {
      url: string;
      link: { id: string; pane_id: string; max_uses: number; state: string };
    };
    expect(body.link).toMatchObject({
      pane_id: "w1:p2",
      max_uses: 1,
      state: "active",
    });
    const second = linkParts(body.url);
    expect(
      (
        await request(api, {
          method: "POST",
          headers: { ...json, cookie: adminCookie },
          body: JSON.stringify({ pane_id: "w2:p1" }),
        })
      ).status,
    ).toBe(400);
    // The list never repeats the secret.
    const listed = await request(api, {
      headers: { ...outside, cookie: adminCookie },
    });
    const listText = await listed.text();
    expect(listText).toContain(second.id);
    expect(listText).not.toContain(second.secret);

    // Max uses: the second browser is refused.
    const first = await redeem(second);
    expect(first.status).toBe(200);
    const paneCookie = guestCookie(first);
    expect(
      (await redeem(second, { ...json, ...proxy("203.0.113.6") })).status,
    ).toBe(410);
    const paneGuest = await server.connect(
      { ...outside, origin: ORIGIN, cookie: paneCookie },
      "page-session-2",
    );
    expect(paneGuest.hello.principal).toMatchObject({
      kind: "guest",
      share: { pane_id: "w1:p2" },
    });
    // Expiry (here: the database says so) closes the socket too.
    const db = new Database(join(server.root, ".config", "thyra", "thyra.db"));
    db.run("UPDATE share_links SET expires_at = 1 WHERE id = ?", [second.id]);
    db.run("UPDATE guest_sessions SET expires_at = 1 WHERE link_id = ?", [
      second.id,
    ]);
    db.close();
    expect(await paneGuest.closed).toMatchObject({ code: 4001 });
    expect((await redeem(second)).status).toBe(410);

    const audit = await server.cli("share", "list");
    expect(audit.stdout).toContain(link.id);
    expect(audit.stdout).toContain("revoked");
    expect(audit.stdout).toContain("expired");
    expect(server.logs()).not.toContain(link.secret);
    expect(server.logs()).not.toContain(second.secret);
  } finally {
    await server.stop();
  }
}, 60_000);
