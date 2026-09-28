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
  /** No input or resizing: chosen here, a viewer, or another person controls it. */
  viewOnly: boolean;
  /** The caller is a viewer of this workspace and cannot take control. */
  readOnly: boolean;
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
  options: {
    readOnly?: boolean;
    overridesProtection?: boolean;
    personId?: string | null;
  } = {},
): PaneControlState {
  const claim = snapshot?.pane_claims.find(
    (item) => item.pane_id === paneId && item.expires_at_unix_ms > now,
  );
  const ownsLayout = claim?.participant_id === participantId;
  const display = displayOwnerState(snapshot, paneId, participantId);
  const owner = claim
    ? snapshot?.participants.find(
        (item) => item.participant_id === claim.participant_id,
      )
    : undefined;
  // One writer per pane: the claim holder, or this person's other pages.
  const samePerson =
    !!options.personId && owner?.person_id === options.personId;
  const heldByOther = !!claim && !ownsLayout && !samePerson;
  const readOnly = options.readOnly === true;
  const blocked = viewOnly || readOnly || heldByOther;
  return {
    viewOnly: blocked,
    readOnly,
    ownsLayout,
    // A display owner alone sizes the pane; otherwise the claim holder does.
    canResize: !blocked && (display ? display.mine : !claim || ownsLayout),
    ownerName: claim
      ? (participantLabel(snapshot, claim.participant_id) ??
        t("Another collaborator"))
      : null,
    protectedUntil:
      claim && !ownsLayout && !options.overridesProtection
        ? (claim.protected_until_unix_ms ?? 0)
        : 0,
    display,
    inputOnly: !blocked && ownsLayout && !!display && !display.mine,
  };
}

// A viewing preference for this Thyra pane, not an authentication boundary.
// Keep every input path (IME, shortcuts, paste and composer) on one gate.
// The bridge enforces display ownership itself; skipping here saves RPCs.
export function paneControlClient(
  client: ConnectionClient,
  read: () => PaneControlState,
  /**
   * Where a read-only viewer's history scrolling goes: Herdr keeps one
   * history position per pane, shared by everyone watching it, so viewers
   * browse a local copy instead of moving it.
   */
  localScroll: () => ((params: Record<string, unknown>) => void) | null = () =>
    null,
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
          method === "shell.submit" ||
          method === "shell.complete" ||
          method === "shell.history" ||
          (method === "shell.subscribe" && params?.enabled !== false) ||
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
      if (access.readOnly && method === "terminal.scroll") {
        localScroll()?.(params ?? {});
        return { ok: true, local: true };
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
