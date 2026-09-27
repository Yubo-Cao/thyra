import { describe, expect, test } from "bun:test";
import {
  createCollaborationService,
  filterCollaborationEvent,
} from "./collaboration";
import {
  acquireOwnShellClients,
  createOwnShellClients,
} from "./own-shell-clients";

function participant(participantId: string, surface = "tui") {
  return {
    participant_id: participantId,
    display_name: participantId,
    color: "#8250df",
    role: "editor",
    activity: "active",
    surface,
  };
}

/** Herdr's collaboration state plus client ids assigned on each attach. */
function fakeHerdr(initial: string[] = []) {
  const participants = initial.map((id) =>
    participant(id, id.startsWith("tui:") ? "tui" : "web"),
  );
  let nextClientId = 1;
  const herdr = {
    participants,
    attach() {
      const id = `tui:${nextClientId++}`;
      participants.push(participant(id));
      return id;
    },
    snapshot() {
      return {
        participants: participants.map((entry) => ({ ...entry })),
        pane_claims: [],
        lease_ttl_ms: 45_000,
      };
    },
    list: async () => {
      return { type: "collaboration_snapshot", snapshot: herdr.snapshot() };
    },
  };
  return herdr;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const ids = (snapshot: { participants: { participant_id: string }[] }) =>
  snapshot.participants.map((entry) => entry.participant_id);

describe("own endpoint shell presence", () => {
  test("hides the participant created by the bridge's own handshake", async () => {
    const herdr = fakeHerdr(["tui:9", "web-alice"]);
    const clients = createOwnShellClients({ list: herdr.list });
    let own = "";
    await clients.track(async () => {
      own = herdr.attach();
      return "boot-1";
    });
    await settled();

    expect(clients.isOwn(own)).toBe(true);
    expect(clients.isOwn("tui:9")).toBe(false);
    expect(ids(clients.filterSnapshot(herdr.snapshot()))).toEqual([
      "tui:9",
      "web-alice",
    ]);
  });

  test("drops own pane claims with the participant", async () => {
    const herdr = fakeHerdr();
    const clients = createOwnShellClients({ list: herdr.list });
    let own = "";
    await clients.track(async () => {
      own = herdr.attach();
      return "boot-1";
    });
    await settled();

    const filtered = clients.filterSnapshot({
      participants: [participant(own), participant("web-bob", "web")],
      pane_claims: [
        { pane_id: "w1:p1", participant_id: own },
        { pane_id: "w1:p2", participant_id: "web-bob" },
      ],
    });
    expect(filtered.pane_claims).toEqual([
      { pane_id: "w1:p2", participant_id: "web-bob" },
    ]);
  });

  test("never claims browsers that update presence during a handshake", async () => {
    const herdr = fakeHerdr();
    const clients = createOwnShellClients({ list: herdr.list });
    await clients.track(async () => {
      herdr.participants.push(participant("web-carol", "web"));
      herdr.attach();
      return "boot-1";
    });
    await settled();

    expect(clients.isOwn("web-carol")).toBe(false);
    expect(ids(clients.filterSnapshot(herdr.snapshot()))).toEqual([
      "web-carol",
    ]);
  });

  test("keeps a real client that attaches during the same handshake visible", async () => {
    const herdr = fakeHerdr();
    const clients = createOwnShellClients({ list: herdr.list });
    await clients.track(async () => {
      herdr.attach(); // a real `herdr` TUI
      herdr.attach(); // this bridge
      return "boot-1";
    });
    await settled();

    expect(clients.isOwn("tui:1")).toBe(false);
    expect(clients.isOwn("tui:2")).toBe(false);
  });

  test("attributes concurrent handshakes of the same bridge", async () => {
    const herdr = fakeHerdr();
    const clients = createOwnShellClients({ list: herdr.list });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = clients.track(async () => {
      await firstGate;
      herdr.attach();
      return "boot-1";
    });
    const second = clients.track(async () => {
      herdr.attach();
      return "boot-1";
    });
    await second;
    releaseFirst();
    await first;
    await settled();

    expect(clients.isOwn("tui:1")).toBe(true);
    expect(clients.isOwn("tui:2")).toBe(true);
    expect(ids(clients.filterSnapshot(herdr.snapshot()))).toEqual([]);
  });

  test("forgets ids from an earlier Herdr boot", async () => {
    const herdr = fakeHerdr();
    const clients = createOwnShellClients({ list: herdr.list });
    await clients.track(async () => {
      herdr.attach();
      return "boot-1";
    });
    await settled();
    expect(clients.isOwn("tui:1")).toBe(true);

    // The restarted server numbers clients from 1 again; its tui:1 is a real
    // TUI that attached before this bridge reconnected.
    herdr.participants.splice(0, herdr.participants.length);
    herdr.participants.push(participant("tui:1"));
    await clients.track(async () => {
      herdr.participants.push(participant("tui:2"));
      return "boot-2";
    });
    await settled();

    expect(clients.isOwn("tui:1")).toBe(false);
    expect(clients.isOwn("tui:2")).toBe(true);
  });

  test("notifies listeners with the snapshot that revealed an own shell", async () => {
    const herdr = fakeHerdr();
    const clients = createOwnShellClients({ list: herdr.list });
    const seen: unknown[] = [];
    const stop = clients.onChange((result) => seen.push(result));
    await clients.track(async () => {
      herdr.attach();
      return "boot-1";
    });
    await settled();
    stop();

    expect(seen).toHaveLength(1);
    expect(
      clients.filterSnapshot(
        (seen[0] as { snapshot: ReturnType<typeof herdr.snapshot> }).snapshot,
      ).participants,
    ).toEqual([]);
  });

  test("propagates handshake failures without attributing anything", async () => {
    const herdr = fakeHerdr();
    const clients = createOwnShellClients({ list: herdr.list });
    await expect(
      clients.track(async () => {
        throw new Error("endpoint refused");
      }),
    ).rejects.toThrow("endpoint refused");
    herdr.attach();
    await settled();
    expect(clients.isOwn("tui:1")).toBe(false);
  });

  test("stops listing on a Herdr without the collaboration API", async () => {
    let lists = 0;
    let connects = 0;
    const clients = createOwnShellClients({
      list: async () => {
        lists += 1;
        throw new Error("unknown_method: collaboration.list");
      },
    });
    await clients.track(async () => {
      connects += 1;
      return undefined;
    });
    await clients.track(async () => {
      connects += 1;
      return undefined;
    });
    expect(connects).toBe(2);
    expect(lists).toBe(1);
  });

  test("profiles on one Herdr share a registry until the last releases it", async () => {
    const herdr = fakeHerdr();
    const path = `/tmp/own-shell-${crypto.randomUUID()}.sock`;
    const a = acquireOwnShellClients(path, herdr.list);
    const b = acquireOwnShellClients(path, herdr.list);
    expect(b.clients).toBe(a.clients);
    await a.clients.track(async () => {
      herdr.attach();
      return "boot-1";
    });
    await settled();
    expect(b.clients.isOwn("tui:1")).toBe(true);

    a.release();
    b.release();
    const c = acquireOwnShellClients(path, herdr.list);
    expect(c.clients).not.toBe(a.clients);
    c.release();
  });
});

describe("collaboration snapshot filtering", () => {
  const hideTui = <T>(snapshot: T): T => {
    const value = snapshot as { participants: { participant_id: string }[] };
    return {
      ...value,
      participants: value.participants.filter(
        (entry) => !entry.participant_id.startsWith("tui:"),
      ),
    } as T;
  };

  test("filters snapshots returned by the Herdr API", async () => {
    const service = createCollaborationService({
      herdrCall: async () => ({
        type: "collaboration_snapshot",
        snapshot: {
          participants: [participant("tui:1"), participant("web-a", "web")],
          pane_claims: [],
        },
      }),
      filterSnapshot: hideTui,
    });
    const result = await service.call("collaboration.update", {});
    expect(ids(result.snapshot)).toEqual(["web-a"]);
  });

  test("filters forwarded collaboration events", () => {
    const event = {
      event: "collaboration_updated",
      data: {
        type: "collaboration_updated",
        snapshot: {
          participants: [participant("tui:1"), participant("web-a", "web")],
          pane_claims: [],
        },
      },
    };
    const filtered = filterCollaborationEvent(event, hideTui) as typeof event;
    expect(filtered.event).toBe("collaboration_updated");
    expect(ids(filtered.data.snapshot)).toEqual(["web-a"]);
    expect(filterCollaborationEvent({ event: "other" }, hideTui)).toEqual({
      event: "other",
    });
  });
});
