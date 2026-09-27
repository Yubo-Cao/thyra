import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccountDatabase } from "./database";
import {
  createShareLinkStore,
  parseShareDuration,
  SHARE_LINK_DEFAULT_TTL_MS,
  shareLinkPath,
} from "./share-links";
import { createAccountStore, hashSecret } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function stores(path = ":memory:") {
  const clock = { now: 1_000_000 };
  const store = createAccountStore(openAccountDatabase(path), {
    now: () => clock.now,
  });
  return { clock, store, shares: createShareLinkStore(store) };
}

const W1 = { connectionId: "local", workspaceId: "w1" };

describe("share links", () => {
  test("store only digests: the secret and guest cookie never hit disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "thyra-share-"));
    dirs.push(dir);
    const path = join(dir, "thyra.db");
    const { store, shares } = stores(path);
    const { link, secret } = shares.createLink({
      ...W1,
      label: "demo",
      actor: "cli",
    });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(shareLinkPath(link.id, secret)).toBe(`/s/${link.id}#${secret}`);
    const redeemed = shares.redeem({ id: link.id, secret });
    if (!redeemed.ok) throw new Error("redeem failed");
    store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(path).toString("latin1");
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain(redeemed.token);
    expect(bytes).toContain(hashSecret(secret));
    // Audit entries name the link and session, never a secret.
    const audit = JSON.stringify(store.listAudit());
    expect(audit).toContain("share.create");
    expect(audit).toContain("share.redeem");
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain(redeemed.token);
  });

  test("defaults to viewer for 24 hours and bounds expiry and uses", () => {
    const { shares, clock } = stores();
    const { link } = shares.createLink({ ...W1, actor: null });
    expect(link).toMatchObject({
      role: "viewer",
      paneId: null,
      maxUses: null,
      expiresAt: clock.now + SHARE_LINK_DEFAULT_TTL_MS,
    });
    expect(() =>
      shares.createLink({ ...W1, ttlMs: 60_000, actor: null }),
    ).toThrow("5 minutes to 30 days");
    expect(() =>
      shares.createLink({ ...W1, ttlMs: 31 * 86_400_000, actor: null }),
    ).toThrow("5 minutes to 30 days");
    expect(() => shares.createLink({ ...W1, maxUses: 0, actor: null })).toThrow(
      "max uses",
    );
    expect(parseShareDuration("1h")).toBe(3_600_000);
    expect(parseShareDuration("7d")).toBe(7 * 86_400_000);
    expect(parseShareDuration("30m")).toBe(1_800_000);
    expect(parseShareDuration("soon")).toBeNull();
  });

  test("wrong secrets and unknown ids are the same refusal", () => {
    const { shares } = stores();
    const { link, secret } = shares.createLink({ ...W1, actor: null });
    for (const [id, attempt] of [
      [link.id, `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`],
      [link.id, ""],
      ["unknownlink1", secret],
      ["bad id!", secret],
      [link.id, "x".repeat(500)],
    ])
      expect(shares.redeem({ id: id!, secret: attempt! })).toEqual({
        ok: false,
        reason: "invalid",
      });
    expect(shares.verifySecret(link.id, secret)).toBe(true);
    expect(shares.verifySecret(link.id, "nope")).toBe(false);
    expect(shares.getLink(link.id)?.uses).toBe(0);
  });

  test("expiry ends the link and its guests", () => {
    const { shares, clock } = stores();
    const { link, secret } = shares.createLink({
      ...W1,
      ttlMs: 3_600_000,
      actor: null,
    });
    const redeemed = shares.redeem({ id: link.id, secret });
    if (!redeemed.ok) throw new Error("redeem failed");
    expect(redeemed.session.expiresAt).toBe(link.expiresAt);
    expect(shares.resolveGuest(redeemed.token)?.link.id).toBe(link.id);
    clock.now = link.expiresAt;
    expect(shares.resolveGuest(redeemed.token)).toBeNull();
    expect(shares.guestByHash(redeemed.session.idHash)).toBeNull();
    expect(shares.redeem({ id: link.id, secret })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(shares.stateOf(shares.getLink(link.id)!)).toBe("expired");
    // Ended links are pruned a week later.
    clock.now += 8 * 86_400_000;
    shares.pruneExpired();
    expect(shares.getLink(link.id)).toBeNull();
  });

  test("max uses count redemptions; existing guests keep watching", () => {
    const { shares } = stores();
    const { link, secret } = shares.createLink({
      ...W1,
      maxUses: 2,
      actor: null,
    });
    const first = shares.redeem({ id: link.id, secret });
    const second = shares.redeem({ id: link.id, secret });
    expect(first.ok && second.ok).toBe(true);
    expect(shares.redeem({ id: link.id, secret })).toEqual({
      ok: false,
      reason: "used",
    });
    if (first.ok) expect(shares.resolveGuest(first.token)).not.toBeNull();
    expect(shares.listLinks(W1)[0]).toMatchObject({ uses: 2, guests: 2 });
  });

  test("revocation ends every guest session at once", () => {
    const { shares, store } = stores();
    const { link, secret } = shares.createLink({ ...W1, actor: "u_owner" });
    const redeemed = shares.redeem({ id: link.id, secret });
    if (!redeemed.ok) throw new Error("redeem failed");
    const stamp = store.changeStamp();
    // Scoped revocation refuses another workspace's link.
    expect(
      shares.revokeLink(link.id, {
        actor: "u_owner",
        scope: { connectionId: "local", workspaceId: "w2" },
      }),
    ).toBeNull();
    const revoked = shares.revokeLink(link.id, {
      actor: "u_owner",
      scope: W1,
    });
    expect(revoked?.ended).toEqual([redeemed.session.idHash]);
    expect(store.changeStamp()).not.toBe(stamp);
    expect(shares.resolveGuest(redeemed.token)).toBeNull();
    expect(shares.redeem({ id: link.id, secret })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(store.listAudit()[0]).toMatchObject({
      actor: "u_owner",
      action: "share.revoke",
      target: link.id,
    });
  });

  test("a closed workspace takes its links along", () => {
    const { shares } = stores();
    const { link, secret } = shares.createLink({ ...W1, actor: null });
    const other = shares.createLink({
      connectionId: "local",
      workspaceId: "w2",
      actor: null,
    });
    const redeemed = shares.redeem({ id: link.id, secret });
    expect(shares.revokeWorkspaceLinks("local", "w1")).toBe(1);
    if (redeemed.ok) expect(shares.resolveGuest(redeemed.token)).toBeNull();
    expect(shares.stateOf(shares.getLink(other.link.id)!)).toBe("active");
  });

  test("pane links keep their pane; guests can leave", () => {
    const { shares } = stores();
    const { link, secret } = shares.createLink({
      ...W1,
      paneId: "w1:p2",
      actor: null,
    });
    expect(link.paneId).toBe("w1:p2");
    const redeemed = shares.redeem({ id: link.id, secret, userAgent: "UA" });
    if (!redeemed.ok) throw new Error("redeem failed");
    expect(shares.resolveGuest(redeemed.token)?.link.paneId).toBe("w1:p2");
    expect(shares.endGuest(redeemed.session.idHash)).toBe(true);
    expect(shares.resolveGuest(redeemed.token)).toBeNull();
  });
});
