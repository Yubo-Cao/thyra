import { expect, test } from "bun:test";
import {
  enrollmentBaseUrl,
  parseWorkspaceRef,
  runAccountsCommand,
} from "./cli";
import { openAccountDatabase } from "./database";
import { createAccountStore } from "./store";

function harness() {
  const store = createAccountStore(openAccountDatabase(":memory:"));
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    runAccountsCommand(argv, {
      store: () => store,
      env: { THYRA_CONFIG_PATH: "/nonexistent/thyra.env", PORT: "8833" },
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
  return { store, out, err, run };
}

test("ignores other commands and prints help", async () => {
  const { run, out } = harness();
  expect(await runAccountsCommand(["service", "status"])).toBeNull();
  expect(await run("user", "--help")).toBe(0);
  expect(out.join("\n")).toContain("thyra grant <user> <workspace>");
});

test("user add creates an admin with a Tailscale link and prints a one-time link", async () => {
  const { run, out, store } = harness();
  expect(
    await run(
      "user",
      "add",
      "--owner",
      "yubo",
      "--tailscale",
      "yubo@github",
      "--base-url",
      "https://thyra.example.com/",
    ),
  ).toBe(0);
  const user = store.findUserByName("yubo")!;
  expect(user.role).toBe("admin");
  expect(store.findIdentity("tailscale", "yubo@github")?.id).toBe(user.id);
  const link = out.find((line) => line.includes("/enroll#"))!.trim();
  expect(link).toMatch(/^https:\/\/thyra\.example\.com\/enroll#[\w-]{40,}$/);
  expect(store.enrollmentUser(link.split("#")[1]!)?.id).toBe(user.id);
  // Without --base-url the link uses localhost on the service port.
  expect(await run("user", "enroll", "yubo")).toBe(0);
  expect(out.at(-2)?.trim()).toMatch(/^http:\/\/localhost:8833\/enroll#/);
});

test("user add and user link attach a verified email address", async () => {
  const { run, err, store } = harness();
  expect(await run("user", "add", "pat", "--email", "Pat@Example.com")).toBe(0);
  const pat = store.findUserByName("pat")!;
  expect(store.findIdentity("email", "pat@example.com")?.id).toBe(pat.id);
  expect(store.usersWithVerifiedEmail("pat@example.com")).toEqual([pat.id]);
  expect(await run("user", "add", "sam")).toBe(0);
  expect(await run("user", "link", "sam", "--email", "pat@example.com")).toBe(
    1,
  );
  expect(err.at(-1)).toContain("already linked to pat");
  expect(await run("user", "link", "sam", "--email", "sam@example.com")).toBe(
    0,
  );
  expect(store.signInMethodCount(store.findUserByName("sam")!.id)).toBe(1);
});

test("share create prints the link once; list and revoke manage it", async () => {
  const { run, out, err, store } = harness();
  expect(
    await run(
      "share",
      "create",
      "ssh-box/w2",
      "--pane",
      "w2:p3",
      "--expires",
      "7d",
      "--max-uses",
      "3",
      "--label",
      "review",
      "--base-url",
      "https://thyra.example.com",
    ),
  ).toBe(0);
  const url = out.find((line) => line.includes("/s/"))!.trim();
  const match = url.match(
    /^https:\/\/thyra\.example\.com\/s\/([\w-]+)#([\w-]{43})$/,
  );
  expect(match).not.toBeNull();
  const [, id, secret] = match!;
  expect(out.join("\n")).toContain("pane w2:p3 only");
  out.length = 0;
  expect(await run("share", "list", "ssh-box/w2")).toBe(0);
  expect(out.join("\n")).toContain(
    `${id}\tssh-box/w2\tw2:p3\tactive\tuses=0/3`,
  );
  expect(out.join("\n")).not.toContain(secret!);
  expect(await run("share", "revoke", id!)).toBe(0);
  expect(store.listAudit(1)[0]).toMatchObject({
    actor: "cli",
    action: "share.revoke",
  });
  // A pane of another workspace, bad durations and unknown links fail.
  expect(await run("share", "create", "w1", "--pane", "w2:p1")).toBe(1);
  expect(await run("share", "create", "w1", "--expires", "soon")).toBe(1);
  expect(await run("share", "revoke", "nolinkhere")).toBe(1);
  expect(err.join("\n")).toContain("is not in workspace w1");
  // THYRA_PUBLIC_ORIGIN (the public listener) is the default base.
  const lines: string[] = [];
  await runAccountsCommand(["share", "create", "w1"], {
    store: () => store,
    env: {
      THYRA_CONFIG_PATH: "/nonexistent/thyra.env",
      THYRA_PUBLIC_ORIGIN: "https://public.example",
    },
    log: (line) => lines.push(line),
    error: () => undefined,
  });
  expect(lines.join("\n")).toContain("https://public.example/s/");
});

test("grants, roles, sessions and removal", async () => {
  const { run, out, err, store } = harness();
  await run("user", "add", "ann");
  expect(await run("grant", "ann", "w3", "editor")).toBe(0);
  expect(await run("grant", "ann", "ssh-box/w1", "viewer")).toBe(0);
  expect(store.grantsOf(store.findUserByName("ann")!.id)).toEqual(
    new Map([
      ["legacy-default\u0000w3", "editor"],
      ["ssh-box\u0000w1", "viewer"],
    ]),
  );
  expect(await run("grant", "ann", "w3", "editor")).toBe(0);
  expect(out.at(-1)).toContain("already has");
  expect(await run("grant", "list", "w3")).toBe(0);
  expect(out.at(-1)).toStartWith("ann\teditor");
  expect(await run("grant", "ann", "w3", "god")).toBe(1);
  expect(err.at(-1)).toContain("role must be");

  expect(await run("user", "role", "ann", "admin")).toBe(0);
  expect(store.findUserByName("ann")?.role).toBe("admin");
  const ann = store.findUserByName("ann")!;
  const session = store.createSession({
    userId: ann.id,
    authMethod: "passkey",
  });
  expect(await run("session", "list", "ann")).toBe(0);
  expect(out.at(-1)).toStartWith(`${session.session.publicId}\tann\tpasskey`);
  expect(await run("session", "revoke", session.session.publicId)).toBe(0);
  expect(store.resolveSession(session.token)).toBeNull();
  expect(await run("user", "disable", "ann")).toBe(0);
  expect(store.findUserByName("ann")?.disabled).toBe(true);
  expect(await run("user", "remove", "ann")).toBe(0);
  expect(store.findUserByName("ann")).toBeNull();
  expect(await run("user", "remove", "ann")).toBe(1);
});

test("workspace references and enrollment base URLs", () => {
  expect(parseWorkspaceRef("w1")).toEqual({
    connectionId: "legacy-default",
    workspaceId: "w1",
  });
  expect(parseWorkspaceRef("box/w2")).toEqual({
    connectionId: "box",
    workspaceId: "w2",
  });
  expect(() => parseWorkspaceRef("")).toThrow();
  expect(
    enrollmentBaseUrl(undefined, {
      THYRA_PUBLIC_BASE_URL: "http://lan.example https://thyra.example.com",
    }),
  ).toBe("https://thyra.example.com");
  expect(() => enrollmentBaseUrl("ftp://x", {})).toThrow("invalid --base-url");
});
