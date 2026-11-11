import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where agent hosts listen. Each host owns one Unix socket named after the
 * Herdr server and pane it runs in, inside a directory only the user can
 * open, so the bridge finds the session of a pane without asking Herdr.
 */

/** Overrides the socket directory (tests, probes). */
export const AGENT_SOCKET_DIR_ENV = "THYRA_AGENT_SOCKET_DIR";
const SOCKET_SUFFIX = ".sock";
/** `sun_path` holds 104 bytes on macOS and 108 on Linux, with the NUL. */
const SOCKET_PATH_LIMIT = 103;

export function agentSocketDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[AGENT_SOCKET_DIR_ENV];
  if (override) return resolve(override);
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "thyra", "agents");
  const home = env.HOME || homedir();
  return join(
    env.XDG_STATE_HOME || join(home, ".local", "state"),
    "thyra",
    "agents",
  );
}

/**
 * Twelve hex digits naming one Herdr server by its control socket, so panes
 * with the same ID in two Herdr sessions never share a socket file.
 */
export function herdrSocketKey(herdrSocketPath: string): string {
  let path = resolve(herdrSocketPath);
  try {
    path = realpathSync(path);
  } catch {
    // Not there (yet): the lexical path names it.
  }
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

export function agentSocketName(herdrKey: string, paneId: string): string {
  return `${herdrKey}-${encodeURIComponent(paneId)}${SOCKET_SUFFIX}`;
}

/** The Herdr key and pane ID a socket file name carries, or null. */
export function parseAgentSocketName(
  name: string,
): { herdrKey: string; paneId: string } | null {
  const match = /^([0-9a-f]{12})-(.+)\.sock$/.exec(name);
  if (!match) return null;
  try {
    const paneId = decodeURIComponent(match[2]!);
    // Only names this module would write: no second spelling of a pane.
    if (!paneId || agentSocketName(match[1]!, paneId) !== name) return null;
    return { herdrKey: match[1]!, paneId };
  } catch {
    return null;
  }
}

export function agentSocketPath(
  dir: string,
  herdrSocketPath: string,
  paneId: string,
): string {
  const path = join(
    dir,
    agentSocketName(herdrSocketKey(herdrSocketPath), paneId),
  );
  if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT)
    throw new Error(
      `agent socket path is too long (${Buffer.byteLength(path)} bytes): ${path}`,
    );
  return path;
}

/**
 * Create the socket directory for this user only, or verify an existing one:
 * a real directory, owned by this user, closed to everyone else.
 */
export function prepareAgentSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`agent socket directory is not a directory: ${dir}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error(`agent socket directory belongs to another user: ${dir}`);
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Whether a directory is safe to read sockets from (see above), not created. */
export function isPrivateAgentSocketDir(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    const uid = process.getuid?.();
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (uid === undefined || stat.uid === uid) &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}
