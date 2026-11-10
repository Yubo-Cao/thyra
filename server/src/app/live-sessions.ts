import type { ServerWebSocket } from "bun";
import { isInstanceAdmin } from "../auth/principal";
import type { PaneScope } from "../authz/filters";
import type { ClientRegistry } from "../bridge/client-registry";
import type { ConnectionManager } from "../connections/manager";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import type { AccountServices } from "./accounts";

export type LiveSessions = ReturnType<typeof createLiveSessions>;

/**
 * What the open sockets may still see: closes the sockets of ended sessions
 * and changed privileges, and answers each viewer's roles and pane scope.
 *
 * The connection manager is created later and read per lookup.
 */
export function createLiveSessions(deps: {
  registry: ClientRegistry;
  accounts: AccountServices;
  connectionManager: () => ConnectionManager<LegacyConnectionRuntime>;
}) {
  const {
    clients,
    vncSockets,
    vscodeSockets,
    socketPrincipals,
    webSocketCleanup,
    closeSockets,
  } = deps.registry;
  const {
    accessControl,
    accountStore,
    shareLinks,
    tailnetSsoCodes,
    emailCodes,
    oauthFlows,
    invites,
  } = deps.accounts;

  /** Close the sockets of ended guest sessions (revoked links, leaving). */
  function closeGuestSockets(idHashes: string[]) {
    const ended = new Set(idHashes);
    if (ended.size === 0) return;
    closeSockets(
      (principal) =>
        principal.kind === "guest" && ended.has(principal.guest.idHash),
      4001,
      "Shared view ended",
    );
  }

  /**
   * Close browser sockets whose session ended (logout, revocation, expiry) or
   * whose account's privileges changed (role, grants, disabled): they
   * reconnect under current authority, or return to the login page. Runs when
   * the account database changed, here or in the CLI, and once a minute.
   */
  function checkLiveSessions(force = false) {
    if (!accessControl.refresh() && !force) return;
    for (const client of [
      ...clients,
      ...vncSockets.keys(),
      ...vscodeSockets.keys(),
    ]) {
      const principal = socketPrincipals.get(client);
      if (principal?.kind === "guest") {
        // Revoking a link deletes its guest sessions, here or in the CLI.
        if (!shareLinks.guestByHash(principal.guest.idHash)) {
          webSocketCleanup.cleanup(client);
          client.close(4001, "Shared view ended");
        }
        continue;
      }
      if (principal?.kind !== "user") continue;
      const session = accountStore.sessionByHash(principal.session.idHash);
      const user = accountStore.getUser(principal.user.id);
      if (!session || !user || user.disabled) {
        webSocketCleanup.cleanup(client);
        client.close(4001, "Session ended");
      } else if (user.privilegeEpoch !== principal.user.privilegeEpoch) {
        webSocketCleanup.cleanup(client);
        client.close(4003, "Access changed");
      }
    }
  }
  /** Guests whose link expired leave at once; expiry changes no database row. */
  function closeExpiredGuests() {
    const now = Date.now();
    closeSockets(
      (principal) =>
        principal.kind === "guest" && principal.guest.expiresAt <= now,
      4001,
      "Shared view ended",
    );
  }
  /** Start the periodic session check and the expired-record sweep. */
  function startSweeps() {
    setInterval(() => {
      checkLiveSessions();
      closeExpiredGuests();
    }, 1000).unref();
    setInterval(() => {
      accountStore.pruneExpired();
      shareLinks.pruneExpired();
      tailnetSsoCodes.pruneExpired();
      emailCodes.pruneExpired();
      oauthFlows.pruneExpired();
      invites.pruneExpired();
      checkLiveSessions(true);
    }, 60_000).unref();
  }

  /** A viewer's role lookup on one connection, or null for admins (no filter). */
  function viewerRoles(ws: ServerWebSocket<unknown>, connectionId: string) {
    const principal = socketPrincipals.get(ws);
    if (!principal || isInstanceAdmin(principal)) return null;
    return accessControl.roleOf(principal, connectionId);
  }

  function scopedPaneOf(ws: ServerWebSocket<unknown>): string | null {
    const principal = socketPrincipals.get(ws);
    return principal?.kind === "guest" ? principal.link.paneId : null;
  }

  /**
   * The pane a guest's link is narrowed to, with the tab holding it, from the
   * last loaded topology (events are filtered synchronously).
   */
  function peekScope(
    ws: ServerWebSocket<unknown>,
    connectionId: string,
  ): PaneScope | null {
    const pane = scopedPaneOf(ws);
    if (!pane) return null;
    const topology = deps
      .connectionManager()
      .readyRuntime(connectionId)?.topology;
    return { pane, tab: topology?.peek({ pane })?.tab ?? null };
  }

  /** `peekScope`, reloading a stale topology first (RPC results). */
  async function freshScope(
    ws: ServerWebSocket<unknown>,
    connectionId: string,
  ): Promise<PaneScope | null> {
    const pane = scopedPaneOf(ws);
    if (!pane) return null;
    const topology = deps
      .connectionManager()
      .readyRuntime(connectionId)?.topology;
    return { pane, tab: (await topology?.locate({ pane }))?.tab ?? null };
  }

  return {
    closeGuestSockets,
    checkLiveSessions,
    startSweeps,
    viewerRoles,
    scopedPaneOf,
    peekScope,
    freshScope,
  };
}
