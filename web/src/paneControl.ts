import { t } from "./i18n";
import type { ConnectionClient } from "./api";
import type { CollaborationSnapshot } from "./collaboration";

export type PaneControlState = {
  viewOnly: boolean;
  ownsLayout: boolean;
  canResize: boolean;
  ownerName: string | null;
  protectedUntil: number;
};

export function paneControlState(
  snapshot: CollaborationSnapshot | null,
  paneId: string | undefined,
  participantId: string,
  viewOnly: boolean,
  now = Date.now(),
): PaneControlState {
  const claim = snapshot?.pane_claims.find(
    (item) => item.pane_id === paneId && item.expires_at_unix_ms > now,
  );
  const ownsLayout = claim?.participant_id === participantId;
  const owner = claim
    ? snapshot?.participants.find(
        (item) => item.participant_id === claim.participant_id,
      )
    : undefined;
  // Name the device too: the owner may be this person on another device.
  const ownerDevice = owner?.device_id
    ? snapshot?.devices?.[owner.device_id]?.name
    : undefined;
  return {
    viewOnly,
    ownsLayout,
    canResize: !viewOnly && (!claim || ownsLayout),
    ownerName: claim
      ? owner
        ? ownerDevice
          ? `${owner.display_name} (${ownerDevice})`
          : owner.display_name
        : t("Another collaborator")
      : null,
    protectedUntil:
      claim && !ownsLayout ? (claim.protected_until_unix_ms ?? 0) : 0,
  };
}

// A viewing preference for this Thyra pane, not an authentication boundary.
// Keep every input path (IME, shortcuts, paste and composer) on one gate.
export function paneControlClient(
  client: ConnectionClient,
  read: () => PaneControlState,
): ConnectionClient {
  return {
    connectionId: client.connectionId,
    generation: client.generation,
    serverRuntimeGeneration: client.serverRuntimeGeneration,
    isCurrent: () => client.isCurrent(),
    acceptsServerGeneration: (value) => client.acceptsServerGeneration(value),
    async call(method, params, timeout) {
      const access = read();
      if (
        access.viewOnly &&
        (method === "terminal.input" ||
          method === "pane.send_input" ||
          method === "pane.send_text" ||
          method === "pane.paste" ||
          method === "pane.send_key")
      ) {
        throw new Error(
          t("This pane is view only. Take control to send input."),
        );
      }
      if (
        (!access.canResize &&
          (method === "terminal.resize" ||
            method === "terminal.relay_resize")) ||
        (access.viewOnly && method === "terminal.focus")
      ) {
        return { ok: true, skipped: true };
      }
      if (access.viewOnly && method === "terminal.scroll") {
        return client.call(method, { ...params, source: "history" }, timeout);
      }
      return client.call(
        method,
        method === "terminal.attach"
          ? { ...params, preserve_size: !access.canResize }
          : params,
        timeout,
      );
    },
  };
}
