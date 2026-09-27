import { expect, test } from "bun:test";
import { createSoftwareAuthenticator } from "./test-authenticator";
import { startTestServer } from "./test-harness";

const ORIGIN = "https://dev.example";

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("thyra_session="));
  expect(cookie).toBeDefined();
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("; Secure");
  return cookie!.split(";", 1)[0]!;
}

// The real router on a loopback listener behind a simulated Caddy.
test("loopback listener enforces Host, Origin, login and the RPC policy", async () => {
  const server = await startTestServer();
  try {
    const { request, proxy } = server;
    const upgrade = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    // Direct local use keeps working without login, as the host owner.
    const health = await request("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      auth_required: false,
      principal: { kind: "local", role: "admin" },
    });
    const page = await request("/", { headers: { accept: "text/html" } });
    expect(page.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    // DNS rebinding: a foreign name resolving to loopback.
    expect(
      (await request("/", { headers: { host: "attacker.example:8787" } }))
        .status,
    ).toBe(421);
    // Another local origin cannot open the WebSocket or POST.
    expect(
      (
        await request("/ws", {
          headers: { ...upgrade, origin: "http://127.0.0.1:1" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/logout", {
          method: "POST",
          headers: { origin: "http://localhost:1", "x-thyra-logout": "1" },
        })
      ).status,
    ).toBe(403);

    // Through the proxy nothing is local: login is required.
    const outside = proxy("203.0.113.5");
    expect(
      (
        await request("/api/health", {
          headers: { ...outside, "sec-fetch-site": "same-origin" },
        })
      ).status,
    ).toBe(401);
    const redirect = await request("/", {
      headers: { ...outside, accept: "text/html" },
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login");
    expect(
      (await request("/ws", { headers: { ...upgrade, ...outside } })).status,
    ).toBe(403);
    const login = await request("/login", {
      headers: { ...outside, "accept-language": "zh-CN,zh;q=0.9" },
    });
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("使用通行密钥登录");
    // The old shared-secret login is gone.
    expect(
      (
        await request("/api/login", {
          method: "POST",
          headers: { ...outside, origin: ORIGIN },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/?token=anything", {
          headers: { ...outside, accept: "text/html" },
        })
      ).status,
    ).toBe(302);

    const local = await server.connect({});
    expect(local.hello.principal).toMatchObject({
      kind: "local",
      role: "admin",
    });
    expect(local.hello.socket).toBeString();
    for (const method of ["server.stop", "plugin.enable", "workspace.get"]) {
      const reply = await local.call(method);
      expect(reply.error?.message).toContain(`${method} is not allowed`);
    }
  } finally {
    await server.stop();
  }
}, 30_000);

test("tailnet admins, passkey members, grants and revocation", async () => {
  const server = await startTestServer({
    whois: { "100.64.7.7": "owner@example.com" },
  });
  try {
    const { request, proxy } = server;
    const tailnet = proxy("100.64.7.7");
    const outside = proxy("203.0.113.5");

    // A tailnet user becomes an instance admin with a session cookie.
    const first = await request("/", {
      headers: { ...tailnet, accept: "text/html" },
    });
    expect(first.status).toBe(200);
    const adminCookie = sessionCookie(first);
    const me = await (
      await request("/api/auth/me", {
        headers: { ...outside, cookie: adminCookie },
      })
    ).json();
    expect(me).toMatchObject({
      kind: "user",
      role: "admin",
      user: { name: "owner", role: "admin" },
      identities: [{ provider: "tailscale", subject: "owner@example.com" }],
    });
    // Unknown tailnet peers and whois failures must log in.
    expect(
      (
        await request("/", {
          headers: { ...proxy("100.64.7.9"), accept: "text/html" },
        })
      ).status,
    ).toBe(302);

    // The owner invites bob from the host; bob enrolls a passkey.
    const added = await server.cli("user", "add", "bob");
    expect(added.code).toBe(0);
    const link = added.stdout.match(/https:\/\/dev\.example\/enroll#([\w-]+)/);
    expect(link).not.toBeNull();
    const key = await createSoftwareAuthenticator();
    const json = {
      ...outside,
      origin: ORIGIN,
      "content-type": "application/json",
    };
    const options = await request("/api/auth/passkey/register/options", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ secret: link![1] }),
    });
    expect(options.status).toBe(200);
    const enrollment = (await options.json()) as any;
    expect(enrollment.user.name).toBe("bob");
    const verified = await request("/api/auth/passkey/register/verify", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        flow: enrollment.flow,
        response: key.create(enrollment.options, ORIGIN),
      }),
    });
    expect(verified.status).toBe(200);
    let bobCookie = sessionCookie(verified);

    // Bob is a member: no host administration, a filtered bridge.
    const bobHeaders = { ...outside, cookie: bobCookie };
    expect(
      (await request("/api/update/check", { headers: bobHeaders })).status,
    ).toBe(403);
    const bob = await server.connect({
      ...outside,
      origin: ORIGIN,
      cookie: bobCookie,
    });
    expect(bob.hello.principal).toMatchObject({ kind: "user", role: "member" });
    expect(bob.hello.socket).toBeUndefined();
    expect(
      (await bob.call("connections.create", { profile: {} })).error?.message,
    ).toContain("needs an instance admin");
    const status = (await bob.call("bridge.status")).result;
    expect(status.terminals).toEqual([]);
    expect(Object.keys(status.connections[0]).sort()).toEqual([
      "generation",
      "id",
      "is_default",
      "label",
      "source",
      "state",
    ]);

    // Sharing a workspace with bob changes his privileges: his socket is
    // reconnected and his session rotates on the next request.
    const share = await request(
      "/api/workspace-grants?connection_id=legacy-default&workspace_id=w1",
      {
        method: "POST",
        headers: { ...json, cookie: adminCookie },
        body: JSON.stringify({ user: "bob", role: "viewer" }),
      },
    );
    expect(share.status).toBe(200);
    expect(await bob.closed).toMatchObject({ code: 4003 });
    const rotated = await request("/api/auth/me", { headers: bobHeaders });
    expect(rotated.status).toBe(200);
    bobCookie = sessionCookie(rotated);
    // Bob cannot share on (he is a viewer).
    expect(
      (
        await request(
          "/api/workspace-grants?connection_id=legacy-default&workspace_id=w1",
          {
            headers: { ...outside, cookie: bobCookie },
          },
        )
      ).status,
    ).toBe(403);

    // Revoking bob's sessions on the host closes his live connection.
    const again = await server.connect(
      { ...outside, origin: ORIGIN, cookie: bobCookie },
      "page-session-2",
    );
    const revoked = await server.cli("session", "revoke", "--user", "bob");
    expect(revoked.code).toBe(0);
    expect(await again.closed).toMatchObject({ code: 4001 });
    expect(
      (
        await request("/api/auth/me", {
          headers: { ...outside, cookie: bobCookie },
        })
      ).status,
    ).toBe(401);

    // His passkey still logs him in.
    const start = (await (
      await request("/api/auth/passkey/login/options", {
        method: "POST",
        headers: json,
        body: "{}",
      })
    ).json()) as any;
    const loggedIn = await request("/api/auth/passkey/login/verify", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        flow: start.flow,
        response: await key.get(start.options, ORIGIN, "dev.example"),
      }),
    });
    expect(loggedIn.status).toBe(200);
    const fresh = sessionCookie(loggedIn);
    expect(
      (
        await (
          await request("/api/auth/me", {
            headers: { ...outside, cookie: fresh },
          })
        ).json()
      ).user.name,
    ).toBe("bob");

    // Logout ends only this session.
    const logout = await request("/api/logout", {
      method: "POST",
      headers: {
        ...outside,
        origin: ORIGIN,
        cookie: fresh,
        "x-thyra-logout": "1",
      },
    });
    expect(logout.status).toBe(204);
    expect(
      (
        await request("/api/auth/me", {
          headers: { ...outside, cookie: fresh },
        })
      ).status,
    ).toBe(401);
  } finally {
    await server.stop();
  }
}, 60_000);
