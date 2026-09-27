import { t } from "./i18n";
import type { ConnectionClient } from "./api";
import type { CollaborationSnapshot } from "./collaboration";

/** The device that sizes the pane, as this page sees it. */
export type PaneDisplayOwner = {
  participantId: string;
  /** This page, or another page (tab, reload) of this device. */
  mine: boolean;
  pinned: boolean;
  /** "Person (device)", or null when the owner has no live page. */
  name: string | null;
  /** The owner has a visible page (it is displaying the pane now). */
  active: boolean;
};

export type PaneControlState = {
  viewOnly: boolean;
  ownsLayout: boolean;
  canResize: boolean;
  ownerName: string | null;
  protectedUntil: number;
  /** Set while the pane has a display owner; only it sizes the pane. */
  display: PaneDisplayOwner | null;
  /**
   * This page holds the pane's control claim (it types) while another device
   * displays it: show the composer and a light preview, never resize.
   */
  inputOnly: boolean;
};

function participantLabel(
  snapshot: CollaborationSnapshot | null,
  participantId: string,
): string | null {
  const participant = snapshot?.participants.find(
    (item) => item.participant_id === participantId,
  );
  if (!participant) return null;
  // Name the device too: the owner may be this person on another device.
  const device = participant.device_id
    ? snapshot?.devices?.[participant.device_id]?.name
    : undefined;
  return device
    ? `${participant.display_name} (${device})`
    : participant.display_name;
}

function displayOwnerState(
  snapshot: CollaborationSnapshot | null,
  paneId: string | undefined,
  participantId: string,
): PaneDisplayOwner | null {
  const owner = snapshot?.display_owners?.find(
    (item) => item.pane_id === paneId,
  );
  if (!owner) return null;
  const participants = snapshot?.participants ?? [];
  const ownerParticipant = participants.find(
    (item) => item.participant_id === owner.participant_id,
  );
  const self = participants.find(
    (item) => item.participant_id === participantId,
  );
  const mine =
    owner.participant_id === participantId ||
    (owner.pinned &&
      !!self?.device_id &&
      self.device_id === ownerParticipant?.device_id);
  return {
    participantId: owner.participant_id,
    mine,
    pinned: owner.pinned,
    name: participantLabel(snapshot, owner.participant_id),
    active: ownerParticipant?.activity === "active",
  };
}

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
  const display = displayOwnerState(snapshot, paneId, participantId);
  return {
    viewOnly,
    ownsLayout,
    // A display owner alone sizes the pane; otherwise the claim holder does.
    canResize: !viewOnly && (display ? display.mine : !claim || ownsLayout),
    ownerName: claim
      ? (participantLabel(snapshot, claim.participant_id) ??
        t("Another collaborator"))
      : null,
    protectedUntil:
      claim && !ownsLayout ? (claim.protected_until_unix_ms ?? 0) : 0,
    display,
    inputOnly: !viewOnly && ownsLayout && !!display && !display.mine,
  };
}

// A viewing preference for this Thyra pane, not an authentication boundary.
// Keep every input path (IME, shortcuts, paste and composer) on one gate.
// The bridge enforces display ownership itself; skipping here saves RPCs.
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
        ((access.viewOnly || (access.display && !access.display.mine)) &&
          method === "terminal.focus")
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
