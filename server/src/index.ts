import packageJson from "../../package.json";
import { createAccountServices } from "./app/accounts";
import { createAgentBrowserWiring } from "./app/agent-browser";
import { verifyPaneWithHerdr } from "./agent-session/relay";
import { createAgentSessionService } from "./app/agent-sessions";
import { createListenerAuthRoutes } from "./app/auth-routes";
import { loadServerBootstrap } from "./app/bootstrap";
import { runStartupCommands } from "./app/commands";
import { createConnectionWiring } from "./app/connections";
import { createLiveSessions } from "./app/live-sessions";
import { installShutdown } from "./app/shutdown";
import { startServer } from "./app/startup";
import { createSocketTransports } from "./app/websocket";
import { createClientRegistry } from "./bridge/client-registry";
import { parseRtcConfig } from "./bridge/rtc-transport";
import { createAuthenticatedRouter } from "./http/authenticated-routes";
import { createConnectionHttpHandler } from "./http/connection-routes";
import { createListenerFetch } from "./http/listener-fetch";
import { readStaticText } from "./http/static-files";
import { createUpdateHandlers } from "./http/update";
import { createRpcDispatcher } from "./rpc/dispatch";
import { runProcessWithCodeTimeout, shQuote } from "./utils/process-utils";
import { createVscodeProxy, vscodeConfig } from "./vscode/proxy";

// The composition root: each step below creates one part of the server, in
// startup order. A part that needs one created after it takes a function and
// calls it per request, never while it is being created.

const APP_VERSION = packageJson.version;
await runStartupCommands(APP_VERSION);
const bootstrap = await loadServerBootstrap(APP_VERSION);
const { config, logger } = bootstrap;

const registry = createClientRegistry({
  logger,
  clientIdentity: () => accounts.clientIdentity,
  connectionManager: () => connections.connectionManager,
});
const accounts = createAccountServices({
  bootstrap,
  registry,
  connectionManager: () => connections.connectionManager,
});
const sessions = createLiveSessions({
  registry,
  accounts,
  connectionManager: () => connections.connectionManager,
});
const listenerAuth = createListenerAuthRoutes({
  bootstrap,
  registry,
  accounts,
  sessions,
  connectionProfiles: () => connections.connectionProfiles,
});
sessions.startSweeps();

const updateHandlers = createUpdateHandlers({
  appVersion: APP_VERSION,
  runProcessWithCodeTimeout,
  shQuote,
  scheduleProcessExit: () => shutdown.scheduleManagedShutdown(),
});
const vscodeProxy = createVscodeProxy({
  ...vscodeConfig(),
  readText: (pathname) => readStaticText(config.publicDir, pathname),
});
const { agentBrowser, agentBrowserConnection } = createAgentBrowserWiring({
  bootstrap,
  registry,
  accounts,
  connections: () => connections,
});
const rtcSetup = parseRtcConfig();
for (const warning of rtcSetup.warnings) logger.warn(warning);

const connections = createConnectionWiring({
  bootstrap,
  registry,
  accounts,
  sessions,
});
const { connectionManager, legacyRoutingLogger } = connections;
// Agent sessions run in the panes of the same connection the agent browser
// serves: the default one, when its Herdr is on this host.
const agentSessions = createAgentSessionService({
  logger: logger.child("agent-session"),
  registry,
  connection: () => {
    const id = agentBrowserConnection();
    const runtime = id ? connectionManager.currentRuntime(id) : null;
    return id && runtime
      ? {
          id,
          generation: connectionManager.status(id).generation,
          herdrSocketPath: runtime.socketPath,
        }
      : null;
  },
  viewerRoles: sessions.viewerRoles,
  peekScope: sessions.peekScope,
  verifyPane: verifyPaneWithHerdr((method, params, timeoutMs) => {
    const id = agentBrowserConnection();
    const runtime = id ? connectionManager.currentRuntime(id) : null;
    return runtime
      ? runtime.herdr.call(method, params, timeoutMs)
      : Promise.reject(new Error("no connection"));
  }),
});

const handleRpc = createRpcDispatcher({
  ...registry,
  ...sessions,
  logger,
  clientIdentity: accounts.clientIdentity,
  accessControl: accounts.accessControl,
  authzDeps: accounts.authzDeps,
  messageBoard: accounts.messageBoard,
  connectionManager,
  connectionProfiles: connections.connectionProfiles,
  legacyRoutingLogger,
  agentSessions,
  rtcTransport: () => rtcTransport,
});
const { websocketHandlers, rtcTransport } = createSocketTransports({
  bootstrap,
  registry,
  accounts,
  connections,
  vscodeProxy,
  agentBrowser,
  rtcConfig: rtcSetup.config,
  handleRpc,
});

const routeAuthenticated = createAuthenticatedRouter({
  APP_VERSION,
  config,
  voice: bootstrap.voice,
  webPush: bootstrap.webPush,
  tailnetSsoOrigin: bootstrap.tailnetSsoOrigin,
  clientIdentity: accounts.clientIdentity,
  vscodeProxy,
  agentBrowser,
  agentBrowserConnection,
  localConnections: connections.localConnections,
  connectionManager,
  rtcTransport,
  handleConnectionHttpRequest: createConnectionHttpHandler({
    connectionManager,
    legacyRoutingLogger,
  }),
  ...updateHandlers,
  handleHerdrStatus: connections.handleHerdrStatus,
  handleHerdrSetup: connections.handleHerdrSetup,
});
const { primaryFetch, publicFetch } = createListenerFetch({
  ...bootstrap,
  ...listenerAuth,
  primaryKind: accounts.primaryKind,
  messageBoard: accounts.messageBoard,
  authenticator: accounts.authenticator,
  authzDeps: accounts.authzDeps,
  accessControl: accounts.accessControl,
  connectionManager,
  routeAuthenticated,
});

const shutdown = installShutdown({
  bootstrap,
  connections,
  agentBrowser,
  agentSessions,
  rtcTransport,
});

try {
  startServer({
    bootstrap,
    accounts,
    connections,
    agentBrowser,
    agentSessions,
    primaryFetch,
    publicFetch,
    websocketHandlers,
  });
} catch (e) {
  logger.error("fatal startup error", { error: e });
  void shutdown.shutdownController.request(1);
}
