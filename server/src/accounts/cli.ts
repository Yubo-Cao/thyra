import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataRoot } from "../config/data-paths";
import { browserUrlFor } from "../config/server-config";
import { parsePublicBaseUrls } from "../http/request-access";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import { defaultDatabasePath, openAccountDatabase } from "./database";
import {
  type AccountStore,
  createAccountStore,
  ENROLLMENT_TTL_MS,
  isWorkspaceRole,
  type User,
} from "./store";

/**
 * `thyra user`, `thyra session` and `thyra grant`: account administration on
 * the host. They write the account database directly; a running server
 * notices within a second (closing affected browser connections).
 */

export function accountsHelp(): string {
  return `Accounts, login sessions and workspace sharing.

Usage:
  thyra user add <name> [--admin] [--display-name <text>] [--tailscale <login>] [--base-url <url>]
  thyra user enroll <name> [--base-url <url>]
  thyra user list
  thyra user role <name> <admin|member>
  thyra user disable <name> | thyra user enable <name>
  thyra user remove <name>
  thyra session list [<user>]
  thyra session revoke <session-id> | thyra session revoke --user <name>
  thyra grant <user> <workspace> <owner|editor|viewer|none>
  thyra grant list <workspace>

\`user add\` creates an account (\`--admin\`, alias \`--owner\`, makes it an
instance admin) and prints a one-time passkey enrollment link, valid for 24
hours. \`user enroll\` prints a new link for an existing account, for example to
add a passkey for another address. A passkey works only on the host name of
the link: pass --base-url (default: the first THYRA_PUBLIC_BASE_URL, else
http://localhost:$PORT). Passkeys need HTTPS or localhost.

\`--tailscale <login>\` links the account to a Tailscale login, so that user's
tailnet devices log in to it through a trusted proxy.

A workspace is \`w1\` on the default connection or \`<connection-id>/w1\`.
`;
}

type Env = Record<string, string | undefined>;

/** The service environment file's values, under the process environment. */
export function serviceEnvironment(env: Env = process.env): Env {
  const merged: Env = {};
  const path = env.THYRA_CONFIG_PATH || join(dataRoot(), "thyra.env");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
      );
      if (!match || line.trim().startsWith("#")) continue;
      const raw = match[2] ?? "";
      const quoted =
        raw.length >= 2 &&
        (raw[0] === "'" || raw[0] === '"') &&
        raw.at(-1) === raw[0];
      merged[match[1]!] = quoted ? raw.slice(1, -1) : raw;
    }
  }
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) merged[key] = value;
  return merged;
}

/** Where enrollment links point: --base-url, the public URL, or localhost. */
export function enrollmentBaseUrl(
  baseUrl: string | undefined,
  env: Env,
): string {
  if (baseUrl) {
    const parsed = parsePublicBaseUrls(baseUrl);
    if (parsed.origins.length !== 1 || parsed.invalid.length > 0)
      throw new Error(`invalid --base-url ${JSON.stringify(baseUrl)}`);
    return parsed.origins[0]!;
  }
  const origins = parsePublicBaseUrls(env.THYRA_PUBLIC_BASE_URL).origins;
  const https = origins.find((origin) => origin.startsWith("https:"));
  if (https ?? origins[0]) return (https ?? origins[0])!;
  const port = Number(env.PORT || 8787);
  const tls = Boolean(env.THYRA_TLS_CERT && env.THYRA_TLS_KEY);
  return browserUrlFor("localhost", port, tls);
}

export function parseWorkspaceRef(value: string): {
  connectionId: string;
  workspaceId: string;
} {
  const slash = value.lastIndexOf("/");
  const connectionId =
    slash >= 0 ? value.slice(0, slash) : LEGACY_DEFAULT_CONNECTION_ID;
  const workspaceId = slash >= 0 ? value.slice(slash + 1) : value;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId) || !connectionId)
    throw new Error(`invalid workspace ${JSON.stringify(value)}`);
  return { connectionId, workspaceId };
}

function time(value: number | null | undefined): string {
  return value ? new Date(value).toISOString().replace(/\.\d+Z$/, "Z") : "-";
}

export type AccountsCommandDeps = {
  store?: () => AccountStore;
  env?: Env;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export async function runAccountsCommand(
  argv: string[],
  deps: AccountsCommandDeps = {},
): Promise<number | null> {
  const group = argv[0];
  if (group !== "user" && group !== "session" && group !== "grant") return null;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const action = argv[1];
  if (!action || action === "help" || action === "--help" || action === "-h") {
    log(accountsHelp());
    return action ? 0 : 2;
  }
  const env = serviceEnvironment(deps.env ?? process.env);
  let store: AccountStore;
  try {
    store =
      deps.store?.() ??
      createAccountStore(openAccountDatabase(defaultDatabasePath(env)));
  } catch (cause) {
    error(`thyra ${group}: ${(cause as Error).message}`);
    return 1;
  }
  const requireUser = (name: string | undefined): User => {
    const user = name ? store.findUser(name) : null;
    if (!user) throw new Error(`no user named ${JSON.stringify(name ?? "")}`);
    return user;
  };
  const printEnrollment = (user: User, baseUrl: string | undefined) => {
    const base = enrollmentBaseUrl(baseUrl, env);
    const { secret } = store.createEnrollment(user.id, "cli");
    log(
      `Passkey enrollment link for ${user.name} (single use, valid ${ENROLLMENT_TTL_MS / 3_600_000} hours):`,
    );
    log(`  ${base}/enroll#${secret}`);
    log(
      `Open it on the device or password manager that will keep the passkey. The passkey works on ${new URL(base).host} only.`,
    );
  };
  try {
    if (group === "user") {
      const rest = argv.slice(2);
      if (action === "add") {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            admin: { type: "boolean" },
            owner: { type: "boolean" },
            "display-name": { type: "string" },
            tailscale: { type: "string" },
            "base-url": { type: "string" },
          },
          strict: true,
          allowPositionals: true,
        });
        if (positionals.length !== 1)
          throw new Error("user add needs one <name>");
        const role = values.admin || values.owner ? "admin" : "member";
        const user = store.db.transaction(() => {
          const created = store.createUser({
            name: positionals[0]!,
            displayName: values["display-name"],
            role,
            actor: "cli",
          });
          if (values.tailscale) {
            if (store.findIdentity("tailscale", values.tailscale))
              throw new Error(
                `Tailscale login ${values.tailscale} is already linked to another user`,
              );
            store.linkIdentity({
              provider: "tailscale",
              subject: values.tailscale,
              userId: created.id,
              actor: "cli",
            });
          }
          return created;
        })();
        log(
          `Created ${role === "admin" ? "instance admin" : "member"} ${user.name}.`,
        );
        printEnrollment(user, values["base-url"]);
        return 0;
      }
      if (action === "enroll") {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { "base-url": { type: "string" } },
          strict: true,
          allowPositionals: true,
        });
        printEnrollment(requireUser(positionals[0]), values["base-url"]);
        return 0;
      }
      if (action === "list") {
        const users = store.listUsers();
        if (users.length === 0)
          log("No users. Create one with `thyra user add <name> --admin`.");
        for (const user of users) {
          const identities = store
            .identitiesOf(user.id)
            .map((identity) => `${identity.provider}:${identity.subject}`);
          log(
            [
              user.name,
              user.role,
              user.disabled ? "disabled" : "active",
              `passkeys=${store.passkeysOf(user.id).length}`,
              identities.join(",") || "-",
              JSON.stringify(user.displayName),
            ].join("\t"),
          );
        }
        return 0;
      }
      if (action === "role") {
        const role = rest[1];
        if (role !== "admin" && role !== "member")
          throw new Error("role must be admin or member");
        const user = store.setRole(requireUser(rest[0]).id, role, "cli");
        log(
          `${user.name} is now ${role === "admin" ? "an instance admin" : "a member"}.`,
        );
        return 0;
      }
      if (action === "disable" || action === "enable") {
        const user = store.setDisabled(
          requireUser(rest[0]).id,
          action === "disable",
          "cli",
        );
        log(`${user.name} is ${action}d.`);
        return 0;
      }
      if (action === "remove") {
        const user = requireUser(rest[0]);
        const tailnet = store
          .identitiesOf(user.id)
          .some((identity) => identity.provider === "tailscale");
        store.deleteUser(user.id, "cli");
        log(`Removed ${user.name} with its passkeys, sessions and grants.`);
        if (tailnet)
          log(
            "Its Tailscale login gets a new account on its next tailnet visit; use `thyra user disable` to block it instead.",
          );
        return 0;
      }
    }
    if (group === "session") {
      if (action === "list") {
        const user = argv[2] ? requireUser(argv[2]) : null;
        const users = new Map(
          store.listUsers().map((entry) => [entry.id, entry]),
        );
        for (const session of store.listSessions(user?.id)) {
          log(
            [
              session.publicId,
              users.get(session.userId)?.name ?? session.userId,
              session.authMethod,
              `last=${time(session.lastSeenAt)}`,
              `expires=${time(session.expiresAt)}`,
              JSON.stringify(session.userAgent ?? ""),
            ].join("\t"),
          );
        }
        return 0;
      }
      if (action === "revoke") {
        const { values, positionals } = parseArgs({
          args: argv.slice(2),
          options: { user: { type: "string" } },
          strict: true,
          allowPositionals: true,
        });
        if (values.user) {
          const user = requireUser(values.user);
          log(
            `Revoked ${store.revokeUserSessions(user.id, "cli")} session(s) of ${user.name}.`,
          );
          return 0;
        }
        if (positionals.length !== 1)
          throw new Error("session revoke needs <session-id> or --user");
        if (!store.revokeSession(positionals[0]!, { actor: "cli" }))
          throw new Error(`no session ${positionals[0]}`);
        log(`Revoked session ${positionals[0]}.`);
        return 0;
      }
    }
    if (group === "grant") {
      if (action === "list") {
        const ref = parseWorkspaceRef(argv[2] ?? "");
        const grants = store.grantsOn(ref.connectionId, ref.workspaceId);
        if (grants.length === 0)
          log("No grants; only instance admins can open it.");
        for (const grant of grants)
          log([grant.userName, grant.role, time(grant.updatedAt)].join("\t"));
        return 0;
      }
      const [userName, workspace, role] = argv.slice(1);
      if (!userName || !workspace || !role)
        throw new Error(
          "usage: thyra grant <user> <workspace> <owner|editor|viewer|none>",
        );
      if (role !== "none" && !isWorkspaceRole(role))
        throw new Error("role must be owner, editor, viewer or none");
      const user = requireUser(userName);
      const ref = parseWorkspaceRef(workspace);
      const changed = store.setGrant({
        ...ref,
        userId: user.id,
        role: role === "none" ? null : role,
        actor: "cli",
      });
      const label =
        ref.connectionId === LEGACY_DEFAULT_CONNECTION_ID
          ? ref.workspaceId
          : `${ref.connectionId}/${ref.workspaceId}`;
      log(
        !changed
          ? `${user.name} already has that access to ${label}.`
          : role === "none"
            ? `Removed ${user.name}'s access to ${label}.`
            : `${user.name} is now ${role} of ${label}.`,
      );
      return 0;
    }
    error(`thyra ${group}: unknown action ${JSON.stringify(action)}`);
    log(accountsHelp());
    return 2;
  } catch (cause) {
    error(`thyra ${group}: ${(cause as Error).message}`);
    return 1;
  }
}
