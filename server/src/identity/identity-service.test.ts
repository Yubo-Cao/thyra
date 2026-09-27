import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTrustedProxies } from "./client-address";
import {
  createIdentityService,
  DEVICE_COOKIE,
  herdrHostLabel,
  type SnapshotDevice,
  type SnapshotPerson,
} from "./identity-service";
import { createIdentityStore } from "./identity-store";
import { createTailscaleWhois } from "./tailscale";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const phoneHints = {
  screen: { width: 390, height: 844, dpr: 3 },
  timezone: "America/Los_Angeles",
  language: "en-US",
};

const WHOIS: Record<string, unknown> = {
  "100.85.156.15": {
    Node: {
      StableID: "nIPHONE",
      ComputedName: "iphone",
      Hostinfo: { OS: "iOS", Hostname: "localhost" },
    },
    UserProfile: {
      LoginName: "yubo@example.com",
      DisplayName: "Yubo",
      ProfilePicURL: "https://example.com/yubo.png",
    },
  },
  "100.90.63.23": {
    Node: { StableID: "nLIVEOPT", Name: "liveopt.tail0.ts.net." },
    UserProfile: { LoginName: "yubo@example.com", DisplayName: "Yubo" },
  },
};

function harness(options: { whois?: boolean; path?: string } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const whoisCalls: string[] = [];
  const service = createIdentityService<object>({
    store: createIdentityStore({ path: options.path ?? null, now }),
    whois: createTailscaleWhois({
      backend:
        options.whois === false
          ? null
          : async (address) => {
              whoisCalls.push(address);
              return WHOIS[address] ?? null;
            },
      now,
    }),
    trustedProxies: parseTrustedProxies(undefined),
    now,
  });
  const connect = (args: {
    peer: string;
    forwardedFor?: string;
    cookie?: string;
    userAgent?: string;
  }) => {
    const headers = new Headers({ "user-agent": args.userAgent ?? IPHONE });
    if (args.forwardedFor) headers.set("x-forwarded-for", args.forwardedFor);
    if (args.cookie) headers.set("cookie", `${DEVICE_COOKIE}=${args.cookie}`);
    const upgrade = service.upgradeContext(
      new Request("http://127.0.0.1:8822/ws", { headers }),
      args.peer,
    );
    const socket = {};
    service.attach(socket, upgrade.context);
    return { socket, upgrade };
  };
  return {
    service,
    connect,
    whoisCalls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function present(
  service: ReturnType<typeof harness>["service"],
  socket: object,
  participantId: string,
) {
  return service.presenceParams(socket, {
    participant_id: participantId,
    display_name: "iPhone user",
    color: "#000000",
  });
}

type Annotated = {
  participants: { person_id?: string; device_id?: string }[];
  people?: Record<string, SnapshotPerson>;
  devices?: Record<string, SnapshotDevice>;
};

function annotate(
  service: ReturnType<typeof harness>["service"],
  ids: string[],
  tuiDevice?: string,
) {
  return service.annotateSnapshot(
    {
      participants: [
        ...ids.map((participant_id) => ({ participant_id, display_name: "x" })),
        { participant_id: "tui:3", display_name: "Herdr TUI 3" },
      ],
      pane_claims: [],
    },
    { tuiDevice },
  ) as Annotated;
}

function identities(
  service: ReturnType<typeof harness>["service"],
  ids: string[],
) {
  const snapshot = annotate(service, ids);
  return snapshot.participants.map((participant) =>
    participant.person_id
      ? {
          person_id: participant.person_id,
          device_id: participant.device_id as string,
          person: snapshot.people?.[participant.person_id],
          device: snapshot.devices?.[participant.device_id as string],
        }
      : undefined,
  );
}

describe("device cookie", () => {
  test("issues a long-lived HttpOnly cookie once and reuses it", () => {
    const { connect } = harness();
    const first = connect({ peer: "127.0.0.1" });
    const cookie = first.upgrade.headers["set-cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=34560000");
    expect(cookie).not.toContain("Secure");
    const again = connect({
      peer: "127.0.0.1",
      cookie: first.upgrade.context.deviceId,
    });
    expect(again.upgrade.headers).toEqual({});
    expect(again.upgrade.context.deviceId).toBe(first.upgrade.context.deviceId);
  });

  test("marks the cookie Secure behind a trusted HTTPS proxy only", () => {
    const { service } = harness();
    const request = (peer: string) =>
      service.upgradeContext(
        new Request("http://127.0.0.1/ws", {
          headers: { "x-forwarded-proto": "https" },
        }),
        peer,
      ).headers["set-cookie"];
    expect(request("127.0.0.1")).toContain("; Secure");
    expect(request("192.0.2.4")).not.toContain("Secure");
  });

  test("adds the cookie to HTML pages only", async () => {
    const { service } = harness();
    const page = service.withPageCookie(
      new Request("http://127.0.0.1/"),
      "127.0.0.1",
      new Response("<!doctype html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(page.headers.get("set-cookie")).toContain(`${DEVICE_COOKIE}=`);
    expect(await page.text()).toBe("<!doctype html>");
    const script = new Response("x", {
      headers: { "content-type": "text/javascript" },
    });
    expect(
      service.withPageCookie(
        new Request("http://127.0.0.1/a.js"),
        null,
        script,
      ),
    ).toBe(script);
  });
});

describe("tailnet identity", () => {
  test("two contexts behind the proxy on one tailnet address are one person and one device", async () => {
    const { service, connect, whoisCalls } = harness();
    const a = connect({ peer: "127.0.0.1", forwardedFor: "100.85.156.15" });
    const b = connect({ peer: "127.0.0.1", forwardedFor: "100.85.156.15" });
    const helloA = await service.hello(a.socket, { hints: phoneHints });
    const helloB = await service.hello(b.socket, { hints: phoneHints });
    expect(helloA.identity).toMatchObject({
      display_name: "Yubo",
      custom_name: false,
      device_name: "iphone",
      os: "iOS",
      match: "tailscale",
      avatar_url: "https://example.com/yubo.png",
      login: "yubo@example.com",
    });
    expect(helloB.identity.person_id).toBe(helloA.identity.person_id);
    expect(helloB.identity.device_id).toBe(helloA.identity.device_id);
    expect(whoisCalls).toEqual(["100.85.156.15"]);

    const params = await present(service, a.socket, "web-a");
    expect(params.display_name).toBe("Yubo");
    expect(params.color).toBe(helloA.identity.color);
    await present(service, b.socket, "web-b");
    const [ia, ib, tui] = identities(service, ["web-a", "web-b"]);
    expect(ia?.device_id).toBe(ib?.device_id as string);
    expect(ia?.person_id).toBe(helloA.identity.person_id);
    expect(ia?.device).toEqual({
      name: "iphone",
      os: "iOS",
      match: "tailscale",
    });
    expect(ia?.person).toEqual({
      display_name: "Yubo",
      color: helloA.identity.color,
      avatar_url: "https://example.com/yubo.png",
    });
    expect(tui).toBeUndefined();
    // Profiles are sent once per person, however many contexts it has.
    const snapshot = annotate(service, ["web-a", "web-b"]);
    expect(Object.keys(snapshot.people ?? {})).toHaveLength(1);
    expect(Object.keys(snapshot.devices ?? {})).toHaveLength(1);
    // Nothing that identifies the network location or login reaches peers.
    expect(JSON.stringify(snapshot)).not.toContain("100.85");
    expect(JSON.stringify(snapshot)).not.toContain("yubo@example.com");
  });

  test("another tailnet device of the same user is the same person, second device", async () => {
    const { service, connect } = harness();
    const phone = connect({ peer: "127.0.0.1", forwardedFor: "100.85.156.15" });
    const desktop = connect({
      peer: "127.0.0.1",
      forwardedFor: "100.90.63.23",
      userAgent: LINUX,
    });
    const p = (await service.hello(phone.socket, {})).identity;
    const d = (await service.hello(desktop.socket, {})).identity;
    expect(d.person_id).toBe(p.person_id);
    expect(d.device_id).not.toBe(p.device_id);
    expect(d.device_name).toBe("liveopt");
    expect(d.os).toBe("Linux");
  });

  test("a forwarded tailnet address from an untrusted peer is ignored", async () => {
    const { service, connect, whoisCalls } = harness();
    const spoof = connect({
      peer: "192.0.2.50",
      forwardedFor: "100.85.156.15",
    });
    const identity = (await service.hello(spoof.socket, {})).identity;
    expect(identity.match).toBe("cookie");
    expect(identity.display_name).toBeNull();
    expect(identity.login).toBeUndefined();
    expect(whoisCalls).toEqual([]);
  });

  test("without whois a tailnet address still identifies one device", async () => {
    const { service, connect } = harness({ whois: false });
    const a = connect({ peer: "100.85.156.15" });
    const b = connect({ peer: "100.85.156.15" });
    const ia = (await service.hello(a.socket, {})).identity;
    const ib = (await service.hello(b.socket, {})).identity;
    expect(ia.match).toBe("tailnet-address");
    expect(ib.device_id).toBe(ia.device_id);
    expect(ia.device_name).toBe("iPhone");
  });
});

describe("fallback device identity", () => {
  test("home screen app and Safari on one address merge; the same address alone does not", async () => {
    const { service, connect } = harness({ whois: false });
    const safari = connect({ peer: "198.51.100.7" });
    const s = (await service.hello(safari.socket, { hints: phoneHints }))
      .identity;
    expect(s.match).toBe("cookie");
    const pwa = connect({ peer: "198.51.100.7" });
    const p = (
      await service.hello(pwa.socket, {
        hints: { ...phoneHints, standalone: true },
      })
    ).identity;
    expect(p.match).toBe("device-hints");
    expect(p.device_id).toBe(s.device_id);
    expect(p.person_id).toBe(s.person_id);

    const laptop = connect({ peer: "198.51.100.7", userAgent: LINUX });
    const l = (
      await service.hello(laptop.socket, {
        hints: { ...phoneHints, screen: { width: 1920, height: 1080, dpr: 1 } },
      })
    ).identity;
    expect(l.device_id).not.toBe(s.device_id);
    expect(l.match).toBe("cookie");
  });

  test("client counting groups tabs and merged contexts by device", async () => {
    const { service, connect } = harness({ whois: false });
    const tab1 = connect({ peer: "198.51.100.7" });
    const cookie = tab1.upgrade.context.deviceId;
    const tab2 = connect({ peer: "198.51.100.7", cookie });
    await service.hello(tab1.socket, { hints: phoneHints });
    await service.hello(tab2.socket, { hints: phoneHints });
    expect(service.deviceKeyOf(tab1.socket)).toBe(
      service.deviceKeyOf(tab2.socket) as string,
    );
    service.detach(tab1.socket);
    expect(service.deviceKeyOf(tab1.socket)).toBeNull();
  });
});

describe("server-side profiles", () => {
  test("a custom name is shared by every context of the person and survives restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thyra-identity-"));
    const path = join(directory, "identities.json");
    try {
      const first = harness({ path });
      const phone = first.connect({
        peer: "127.0.0.1",
        forwardedFor: "100.85.156.15",
      });
      const desktop = first.connect({
        peer: "127.0.0.1",
        forwardedFor: "100.90.63.23",
      });
      await first.service.hello(phone.socket, {});
      await first.service.hello(desktop.socket, {});
      await present(first.service, desktop.socket, "web-desktop");
      const updated = await first.service.updateProfile(phone.socket, {
        display_name: "  Captain  ",
        color: "#1a7f37",
      });
      expect(updated.identity).toMatchObject({
        display_name: "Captain",
        custom_name: true,
        color: "#1a7f37",
      });
      // Existing presence of the other device reflects the change at once.
      const snapshot = first.service.annotateSnapshot({
        participants: [{ participant_id: "web-desktop", display_name: "Yubo" }],
      }) as Annotated;
      expect(snapshot.participants[0]).toMatchObject({
        display_name: "Captain",
        color: "#1a7f37",
      });
      expect(Object.values(snapshot.people ?? {})[0]?.display_name).toBe(
        "Captain",
      );
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
      expect(readFileSync(path, "utf8")).not.toContain("100.85.156.15");

      const second = harness({ path });
      const again = second.connect({
        peer: "127.0.0.1",
        forwardedFor: "100.90.63.23",
      });
      expect(
        (await second.service.hello(again.socket, {})).identity.display_name,
      ).toBe("Captain");
      // Clearing the name falls back to the Tailscale display name.
      const cleared = await second.service.updateProfile(again.socket, {
        display_name: "",
      });
      expect(cleared.identity.display_name).toBe("Yubo");
      expect(cleared.identity.custom_name).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("migrates a legacy browser profile once", async () => {
    const { service, connect } = harness({ whois: false });
    const a = connect({ peer: "198.51.100.7" });
    const first = await service.hello(a.socket, {
      legacy_profile: { display_name: "Alice", color: "#8250df" },
    });
    expect(first.migrated).toBe(true);
    expect(first.identity).toMatchObject({
      display_name: "Alice",
      color: "#8250df",
    });
    const second = await service.hello(a.socket, {
      legacy_profile: { display_name: "Other", color: "#0969da" },
    });
    expect(second.migrated).toBe(false);
    expect(second.identity.display_name).toBe("Alice");
  });

  test("Herdr TUI clients are labelled by the Herdr host", () => {
    const { service } = harness();
    const snapshot = annotate(service, [], "liveopt");
    const tui = snapshot.participants[0];
    expect(snapshot.people?.[tui.person_id as string]?.display_name).toBe(
      "Herdr TUI",
    );
    expect(snapshot.devices?.[tui.device_id as string]).toEqual({
      name: "liveopt",
    });
    expect(annotate(service, []).people).toBeUndefined();
    expect(herdrHostLabel("yubo@build.example.com", "liveopt")).toBe("build");
    expect(herdrHostLabel(undefined, "liveopt.local")).toBe("liveopt");
  });

  test("participants are forgotten on leave", async () => {
    const { service, connect } = harness();
    const a = connect({ peer: "127.0.0.1", forwardedFor: "100.85.156.15" });
    await present(service, a.socket, "web-a");
    expect(identities(service, ["web-a"])[0]).toBeDefined();
    service.forgetParticipant("web-a");
    expect(identities(service, ["web-a"])[0]).toBeUndefined();
  });
});
