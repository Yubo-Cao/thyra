import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openAccountDatabase } from "./database";
import { createAccountStore, hashSecret, suggestUserName } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function memoryStore(now = () => 1_000_000) {
  return createAccountStore(openAccountDatabase(":memory:"), { now });
}

describe("account database", () => {
  test("is private, migrated once, and refuses a newer schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "thyra-db-"));
    dirs.push(dir);
    const path = join(dir, "thyra", "thyra.db");
    const db = openAccountDatabase(path);
    if (process.platform !== "win32")
      expect(statSync(path).mode & 0o777).toBe(0o600);
    migrate(db);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    db.run("PRAGMA user_version = 99");
    expect(() => migrate(db)).toThrow("newer than this Thyra");
    db.close();
  });

  test("stores session and enrollment secrets only as digests", () => {
    const dir = mkdtempSync(join(tmpdir(), "thyra-db-"));
    dirs.push(dir);
    const path = join(dir, "thyra.db");
    const store = createAccountStore(openAccountDatabase(path));
    const user = store.createUser({ name: "alice", role: "member" });
    const { token } = store.createSession({
      userId: user.id,
      authMethod: "passkey",
    });
    const { secret } = store.createEnrollment(user.id, "cli");
    store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(path).toString("latin1");
    expect(bytes).not.toContain(token);
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain(hashSecret(token));
    store.db.close();
  });
});

describe("account store", () => {
  test("names are validated, unique, and suggested from logins", () => {
    const store = memoryStore();
    store.createUser({ name: "Alice", role: "admin" });
    expect(() => store.createUser({ name: "alice", role: "member" })).toThrow(
      "already exists",
    );
    expect(() =>
      store.createUser({ name: "no spaces", role: "member" }),
    ).toThrow();
    expect(suggestUserName("Yubo.Cao@example.com")).toBe("yubo.cao");
    expect(store.uniqueName("alice@github")).toBe("alice-2");
  });

  test("sessions resolve, expire, rotate on privilege change and revoke", () => {
    let now = 1_000_000;
    const store = memoryStore(() => now);
    const user = store.createUser({ name: "bob", role: "member" });
    const { token, session } = store.createSession({
      userId: user.id,
      authMethod: "passkey",
      ttlMs: 60_000,
    });
    expect(store.resolveSession(token)?.user.id).toBe(user.id);
    expect(store.resolveSession("guess")).toBeNull();

    // A grant bumps the privilege epoch; the old session is rotated.
    expect(
      store.setGrant({
        connectionId: "c1",
        workspaceId: "w1",
        userId: user.id,
        role: "viewer",
        actor: "cli",
      }),
    ).toBe(true);
    const bumped = store.getUser(user.id)!;
    expect(bumped.privilegeEpoch).toBe(session.privilegeEpoch + 1);
    const rotated = store.rotateSession(session.idHash)!;
    expect(rotated.token).not.toBe(token);
    expect(rotated.session.publicId).toBe(session.publicId);
    expect(rotated.session.privilegeEpoch).toBe(bumped.privilegeEpoch);
    // The old cookie survives briefly for racing requests, at the new epoch.
    expect(store.resolveSession(token)?.session.privilegeEpoch).toBe(
      bumped.privilegeEpoch,
    );
    expect(store.listSessions(user.id).map((entry) => entry.publicId)).toEqual([
      session.publicId,
    ]);
    now += 61_000;
    expect(store.resolveSession(token)).toBeNull();
    expect(store.resolveSession(rotated.token)).toBeNull();

    const next = store.createSession({
      userId: user.id,
      authMethod: "tailscale",
    });
    expect(
      store.revokeSession(next.session.publicId, {
        userId: "someone-else",
        actor: null,
      }),
    ).toBeNull();
    expect(
      store.revokeSession(next.session.publicId, {
        userId: user.id,
        actor: user.id,
      }),
    ).not.toBeNull();
    expect(store.resolveSession(next.token)).toBeNull();
  });

  test("disabled users lose sessions; deleting cascades", () => {
    const store = memoryStore();
    const user = store.createUser({ name: "carol", role: "member" });
    const { token } = store.createSession({
      userId: user.id,
      authMethod: "passkey",
    });
    store.setDisabled(user.id, true, "cli");
    expect(store.resolveSession(token)).toBeNull();
    store.setDisabled(user.id, false, "cli");
    store.linkIdentity({
      provider: "tailscale",
      subject: "carol@gh",
      userId: user.id,
    });
    store.setGrant({
      connectionId: "c1",
      workspaceId: "w1",
      userId: user.id,
      role: "editor",
      actor: null,
    });
    expect(store.findUser("carol@gh")?.id).toBe(user.id);
    expect(store.deleteUser(user.id, "cli")).toBe(true);
    expect(store.findIdentity("tailscale", "carol@gh")).toBeNull();
    expect(store.grantsOn("c1", "w1")).toEqual([]);
  });

  test("grants change roles, report no-ops, and go when a workspace closes", () => {
    const store = memoryStore();
    const a = store.createUser({ name: "a", role: "member" });
    const b = store.createUser({ name: "b", role: "member" });
    const grant = (
      userId: string,
      role: "owner" | "editor" | "viewer" | null,
    ) =>
      store.setGrant({
        connectionId: "c1",
        workspaceId: "w1",
        userId,
        role,
        actor: null,
      });
    expect(grant(a.id, "editor")).toBe(true);
    expect(grant(a.id, "editor")).toBe(false);
    expect(grant(a.id, "owner")).toBe(true);
    expect(grant(b.id, "viewer")).toBe(true);
    expect(store.grantsOf(a.id).get("c1\u0000w1")).toBe("owner");
    expect(
      store.grantsOn("c1", "w1").map((entry) => [entry.userName, entry.role]),
    ).toEqual([
      ["a", "owner"],
      ["b", "viewer"],
    ]);
    const before = store.changeStamp();
    expect(store.removeWorkspaceGrants("c1", "w1").sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(store.changeStamp()).not.toBe(before);
    expect(grant(b.id, null)).toBe(false);
    expect(store.listAudit(3).map((entry) => entry.action)).toContain(
      "grant.workspace_closed",
    );
  });

  test("enrollment secrets are single-use and expire", () => {
    let now = 5_000;
    const store = memoryStore(() => now);
    const user = store.createUser({ name: "dave", role: "member" });
    const { secret } = store.createEnrollment(user.id, "cli", 1000);
    expect(store.enrollmentUser(secret)?.id).toBe(user.id);
    expect(store.consumeEnrollment(secret)).toBe(true);
    expect(store.consumeEnrollment(secret)).toBe(false);
    const late = store.createEnrollment(user.id, "cli", 1000);
    now += 2000;
    expect(store.enrollmentUser(late.secret)).toBeNull();
  });
});
