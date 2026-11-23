import type { RtcTransport } from "../bridge/rtc-transport";
import type { SocketData } from "../bridge/socket-data";
import type { AgentBrowser } from "../browser/agent-browser";
import type { RemoteMic } from "../voice/remote-mic";
import { sanitizeConnectionError } from "../connections/manager";
import { createShutdownController } from "../connections/shutdown";
import type { AgentSessionService } from "./agent-sessions";
import type { ServerBootstrap } from "./bootstrap";
import type { ConnectionWiring } from "./connections";

/**
 * Stop everything once on exit, SIGINT or SIGTERM, and offer the delayed
 * shutdown an installed update asks for.
 */
export function installShutdown(deps: {
  bootstrap: ServerBootstrap;
  connections: ConnectionWiring;
  agentBrowser: AgentBrowser;
  remoteMic: RemoteMic;
  agentSessions: AgentSessionService;
  rtcTransport: RtcTransport<SocketData>;
}) {
  const { logger, webPush } = deps.bootstrap;
  const { connectionManager, connectionProfiles } = deps.connections;
  const { agentBrowser, remoteMic, rtcTransport } = deps;
  let managerStopTask: Promise<void> | null = null;
  function stopManagerOnce(): Promise<void> {
    rtcTransport.closeAll();
    webPush.stop();
    agentBrowser.stop();
    // Only the links close: the hosts keep their sessions for the next bridge.
    deps.agentSessions.stop();
    connectionProfiles.stopSupervision();
    managerStopTask ??= Promise.all([
      connectionManager.stopAll(),
      // Give the host its own default microphone back.
      remoteMic.stop(),
    ]).then(() => undefined);
    return managerStopTask;
  }

  const shutdownController = createShutdownController({
    stop: stopManagerOnce,
    exit: (code) => process.exit(code),
    onStopError: (error) => {
      logger.error("connection shutdown failed", {
        error: sanitizeConnectionError(error),
      });
    },
  });

  function scheduleManagedShutdown(): void {
    const timer = setTimeout(() => {
      void shutdownController.request(0);
    }, 1_000);
    timer.unref();
  }

  process.on("exit", () => {
    remoteMic.stopSync();
    void stopManagerOnce();
  });
  process.on("SIGINT", () => {
    void shutdownController.request(130);
  });
  process.on("SIGTERM", () => {
    void shutdownController.request(143);
  });

  return { shutdownController, scheduleManagedShutdown };
}
