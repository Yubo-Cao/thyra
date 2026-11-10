import { isInstanceAdmin } from "../auth/principal";
import type { ClientRegistry } from "../bridge/client-registry";
import {
  agentBrowserConfig,
  createAgentBrowser,
  type ReviewRequest,
} from "../browser/agent-browser";
import { serializeHerdrEventEnvelope } from "../connections/protocol";
import type { AccountServices } from "./accounts";
import type { ServerBootstrap } from "./bootstrap";
import type { ConnectionWiring } from "./connections";

/**
 * The agent browser and the review requests it hands to admins.
 *
 * Connections are created later and read per request.
 */
export function createAgentBrowserWiring(deps: {
  bootstrap: ServerBootstrap;
  registry: ClientRegistry;
  accounts: AccountServices;
  connections: () => ConnectionWiring;
}) {
  const { logger, webPush } = deps.bootstrap;
  const { clients, socketPrincipals, safeSend } = deps.registry;
  const { accountStore } = deps.accounts;
  /** The agent browser serves the default connection when it is local. */
  function agentBrowserConnection(): string | null {
    const id = deps.connections().connectionManager.defaultId();
    return deps.connections().localConnections.has(id) &&
      deps.connections().connectionManager.has(id)
      ? id
      : null;
  }
  const agentBrowser = createAgentBrowser({
    ...agentBrowserConfig(),
    logger: logger.child("agent-browser"),
    onReview: notifyBrowserReview,
  });
  /** A tab handed over for review reaches admins like an agent needing input. */
  function notifyBrowserReview(review: ReviewRequest) {
    const connectionId = agentBrowserConnection();
    const workspaceId = review.owner.workspaceId;
    if (!connectionId || !workspaceId) return;
    const generation = deps
      .connections()
      .connectionManager.status(connectionId).generation;
    const isCurrent = () =>
      agentBrowserConnection() === connectionId &&
      deps.connections().connectionManager.status(connectionId).generation ===
        generation;
    const line = serializeHerdrEventEnvelope(
      connectionId,
      {
        event: "thyra.browser.review",
        data: {
          workspace_id: workspaceId,
          pane_id: review.owner.paneId,
          target_id: review.targetId,
          message: review.message,
          title: review.title,
          url: review.url,
        },
      },
      generation,
    );
    for (const ws of clients)
      if (isInstanceAdmin(socketPrincipals.get(ws)))
        safeSend(ws, line, "event");
    webPush.notify(
      {
        kind: "review",
        workspaceId,
        paneId: review.owner.paneId,
        agent: review.title || "Agent",
        message: review.message,
        connectionId,
        runtimeGeneration: generation,
      },
      isCurrent,
      (owner) => {
        if (!owner || owner === "local") return true;
        const user = owner.startsWith("user:")
          ? accountStore.getUser(owner.slice(5))
          : null;
        return !!user && !user.disabled && user.role === "admin";
      },
    );
  }
  return { agentBrowser, agentBrowserConnection };
}
