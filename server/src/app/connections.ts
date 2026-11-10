import { rmSync } from "node:fs";
import { filterEvent } from "../authz/filters";
import type { ClientRegistry } from "../bridge/client-registry";
import { HerdrClient } from "../bridge/herdr-client";
import type { SshTunnelConfig } from "../bridge/ssh-tunnel";
import { summarizeHerdrEvent } from "../connections/log-detail";
import {
  ConnectionManager,
  type ConnectionRuntimeContext,
  sanitizeConnectionError,
} from "../connections/manager";
import {
  ConnectionProfileService,
  connectionIdentityForProfile,
  loadConnectionProfileBootstrap,
  type SyntheticLocalProfile,
  testConnectionSockets,
} from "../connections/profile-service";
import {
  type ConnectionProfile,
  ConnectionProfileStore,
} from "../connections/profiles";
import {
  createLegacyRoutingLogger,
  serializeHerdrEventEnvelope,
} from "../connections/protocol";
import {
  createLegacyConnectionRuntime,
  type LegacyConnectionRuntime,
} from "../connections/runtime";
import { createSshProfileRuntimeConfig } from "../connections/ssh-profile-runtime";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import {
  createHerdrSetupHandlers,
  herdrSetupGuardForProfile,
} from "../http/herdr-setup";
import { createRecoveryReporter, type RecoveryReporter } from "../utils/logger";
import type { AccountServices } from "./accounts";
import type { ServerBootstrap } from "./bootstrap";
import type { LiveSessions } from "./live-sessions";

export type ConnectionWiring = ReturnType<typeof createConnectionWiring>;

/**
 * The connection registry: the profiles loaded from disk, the manager that
 * runs them and the runtime each profile starts, wired to the browser
 * sockets its events go to.
 */
export function createConnectionWiring(deps: {
  bootstrap: ServerBootstrap;
  registry: ClientRegistry;
  accounts: AccountServices;
  sessions: LiveSessions;
}) {
  const { config, logger, downstreamConnectionConfig, webPush } =
    deps.bootstrap;
  const {
    clients,
    socketPrincipals,
    participantIds,
    safeSend,
    clientLabel,
    markRpcError,
  } = deps.registry;
  const { clientIdentity, accessControl, accountStore, shareLinks } =
    deps.accounts;
  const { checkLiveSessions, viewerRoles, peekScope } = deps.sessions;
  const legacyRoutingLogger = createLegacyRoutingLogger({
    log: (message) =>
      logger.warn("deprecated request routing", { detail: message }),
  });

  const connectionProfileStore = new ConnectionProfileStore();
  const syntheticLegacyProfile: SyntheticLocalProfile = {
    id: LEGACY_DEFAULT_CONNECTION_ID,
    label: "Default",
    type: "local",
    control_socket_path: config.socketPath,
    client_socket_path: config.clientSocketPath,
    auto_connect: true,
  };
  const explicitLegacyOverride = Boolean(
    config.hasExplicitSocketPath ||
      config.hasExplicitClientSocketPath ||
      config.sshHost ||
      config.session,
  );
  let connectionBootstrap;
  try {
    connectionBootstrap = loadConnectionProfileBootstrap({
      store: connectionProfileStore,
      legacyProfile: syntheticLegacyProfile,
      explicitLegacyOverride,
    });
  } catch (error) {
    const registryLoadError = sanitizeConnectionError(error);
    logger.error("invalid connection registry preserved", {
      error: registryLoadError,
      profile_mutations: "disabled",
    });
    connectionBootstrap = {
      defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
      explicitLegacyOverride,
      persistedRegistry: null,
      registryLoadError,
      registrations: [
        { profile: syntheticLegacyProfile, readOnly: true as const },
      ],
    };
  }

  const connectionFailureReporters = new Map<string, RecoveryReporter>();
  const readyConnectionGenerations = new Map<string, number>();

  function connectionFailureReporter(connectionId: string): RecoveryReporter {
    let reporter = connectionFailureReporters.get(connectionId);
    if (!reporter) {
      reporter = createRecoveryReporter({
        logger: logger.child("connections"),
        failureMessage: "connection degraded",
        recoveryMessage: "connection recovered",
      });
      connectionFailureReporters.set(connectionId, reporter);
    }
    return reporter;
  }

  const connectionManager = new ConnectionManager<LegacyConnectionRuntime>(
    connectionBootstrap.defaultConnectionId,
    (status) => {
      const fields = {
        connection: status.id,
        state: status.state,
        generation: status.generation,
      };
      logger.debug("connection status", {
        ...fields,
        error: status.error?.message,
      });
      const reporter = connectionFailureReporter(status.id);
      if (
        (status.state === "error" || status.state === "reconnecting") &&
        status.error
      ) {
        reporter.failure(status.error.message, fields);
        return;
      }
      if (status.state !== "ready") return;
      if (reporter.recovered(fields)) {
        readyConnectionGenerations.set(status.id, status.generation);
      } else if (
        readyConnectionGenerations.get(status.id) !== status.generation
      ) {
        readyConnectionGenerations.set(status.id, status.generation);
        logger.info("connection ready", fields);
      }
    },
    logger.child("connections"),
  );

  const { handleHerdrStatus, handleHerdrSetup } = createHerdrSetupHandlers({
    ping: () => {
      const runtime = connectionManager.defaultReadyRuntime();
      return runtime
        ? runtime.herdr.ping()
        : new HerdrClient(config.socketPath).ping();
    },
    guard: () =>
      herdrSetupGuardForProfile(
        config,
        connectionProfiles
          .list()
          .find((profile) => profile.id === connectionManager.defaultId()),
      ),
  });

  /** Connections whose Herdr runs on this host (no SSH), by id. */
  const localConnections = new Set<string>();

  function runtimeFactoryForProfile(
    profile: ConnectionProfile | SyntheticLocalProfile,
  ) {
    const identity = connectionIdentityForProfile(profile);
    return (context: ConnectionRuntimeContext) => {
      const profileConfig: SshTunnelConfig =
        profile.id === LEGACY_DEFAULT_CONNECTION_ID
          ? downstreamConnectionConfig
          : profile.type === "ssh"
            ? createSshProfileRuntimeConfig(profile)
            : {
                socketPath: profile.control_socket_path,
                clientSocketPath: profile.client_socket_path,
                sshHost: undefined,
                session: undefined,
                hasExplicitSocketPath: true,
                hasExplicitClientSocketPath: true,
                ownedRuntimeDirectory: undefined,
              };
      if (profileConfig.sshHost) localConnections.delete(identity.id);
      else localConnections.add(identity.id);
      let runtime: LegacyConnectionRuntime;
      try {
        runtime = createLegacyConnectionRuntime({
          identity,
          connectionGeneration: context.generation,
          config: profileConfig,
          logger: logger.child("connection"),
          safeSend,
          clientLabel,
          markRpcError,
          presentSnapshot: clientIdentity.annotateSnapshot,
          socketIdentity: (ws) => {
            const participantId = participantIds.get(ws);
            return participantId
              ? {
                  participantId,
                  deviceKey: clientIdentity.deviceKeyOf(ws) ?? clientLabel(ws),
                }
              : null;
          },
          onTaskEvent: (event) => {
            const connections = connectionProfiles.list();
            webPush.notify(
              {
                ...event,
                connectionId: identity.id,
                connectionLabel:
                  connections.length > 1
                    ? (connections.find(
                        (connection) => connection.id === identity.id,
                      )?.label ?? identity.label)
                    : undefined,
                runtimeGeneration: context.generation,
              },
              context.isCurrent,
              (owner) =>
                accessControl.subscriberSees(
                  owner,
                  identity.id,
                  event.workspaceId,
                ),
            );
          },
          onEvent: (event, eventIdentity) => {
            if (!context.isCurrent()) return;
            if (logger.enabled("debug"))
              logger.debug("Herdr event", {
                connection: eventIdentity.id,
                detail: summarizeHerdrEvent(event),
              });
            const name = (event as { event?: unknown } | null)?.event;
            if (name === "workspace.closed") {
              const workspaceId = (
                event as { data?: { workspace_id?: unknown } }
              ).data?.workspace_id;
              // Herdr may reuse the id of a closed workspace; its grants and
              // share links go.
              if (typeof workspaceId === "string") {
                const grants = accountStore.removeWorkspaceGrants(
                  eventIdentity.id,
                  workspaceId,
                ).length;
                const links = shareLinks.revokeWorkspaceLinks(
                  eventIdentity.id,
                  workspaceId,
                );
                if (grants > 0 || links > 0) {
                  accessControl.invalidate();
                  checkLiveSessions();
                }
              }
            }
            try {
              const line = serializeHerdrEventEnvelope(
                eventIdentity.id,
                event,
                context.generation,
              );
              // Each viewer sees only its workspaces' events.
              const views = new Map<string, string | null>();
              for (const ws of clients) {
                const roles = viewerRoles(ws, eventIdentity.id);
                if (!roles) {
                  safeSend(ws, line, "event");
                  continue;
                }
                const key = socketPrincipals.get(ws)?.key ?? "";
                let view = views.get(key);
                if (view === undefined) {
                  const filtered = filterEvent(
                    event,
                    roles,
                    peekScope(ws, eventIdentity.id),
                  );
                  view = !filtered
                    ? null
                    : serializeHerdrEventEnvelope(
                        eventIdentity.id,
                        "resync" in filtered
                          ? { event: "session.resync_required", data: {} }
                          : filtered.event,
                        context.generation,
                      );
                  views.set(key, view);
                }
                if (view) safeSend(ws, view, "event");
              }
            } catch (error) {
              logger.warn("dropped invalid Herdr event", {
                connection: eventIdentity.id,
                error: sanitizeConnectionError(error),
              });
            }
          },
          onTransportExit: profileConfig.sshHost
            ? (error) => {
                if (!context.isCurrent()) return;
                const reconnecting = connectionProfiles.willRetry(
                  profile.id,
                  error,
                );
                context.reportError(error, { reconnecting });
                connectionProfiles.runtimeFailed(profile.id, error);
              }
            : undefined,
        });
      } catch (error) {
        if (profileConfig.ownedRuntimeDirectory) {
          rmSync(profileConfig.ownedRuntimeDirectory, {
            recursive: true,
            force: true,
          });
        }
        throw error;
      }
      return {
        ...runtime,
        async startTransport() {
          await runtime.startTransport();
          await testConnectionSockets(
            profileConfig.socketPath,
            profileConfig.clientSocketPath,
          );
        },
      };
    };
  }

  const connectionProfiles = new ConnectionProfileService({
    manager: connectionManager,
    store: connectionProfileStore,
    bootstrap: connectionBootstrap,
    createRuntime: runtimeFactoryForProfile,
  });

  return {
    connectionManager,
    connectionProfiles,
    localConnections,
    legacyRoutingLogger,
    handleHerdrStatus,
    handleHerdrSetup,
  };
}
