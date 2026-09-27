import {
  type CollaborationParticipant,
  type CollaborationSnapshot,
  participantIsTyping,
} from "./collaboration";
import { t } from "./i18n";

/**
 * Presence grouped the way people think about it: one entry per person
 * (a tailnet user, or one browser device without Tailscale), listing their
 * devices; every tab or browser context of a device collapses into it.
 */

export type CollaboratorDevice = {
  key: string;
  name: string;
  /** Browser tabs/contexts (or TUI clients) on this device. */
  contexts: number;
  isSelf: boolean;
};

export type Collaborator = {
  key: string;
  name: string;
  color: string;
  avatarUrl?: string;
  isSelf: boolean;
  typing: boolean;
  activity: CollaborationParticipant["activity"];
  devices: CollaboratorDevice[];
  participants: CollaborationParticipant[];
};

const ACTIVITY_RANK = { active: 0, idle: 1, away: 2 } as const;

function deviceName(
  snapshot: CollaborationSnapshot,
  participant: CollaborationParticipant,
) {
  const device = participant.device_id
    ? snapshot.devices?.[participant.device_id]
    : undefined;
  if (device?.name) return device.name;
  return participant.surface === "tui" ? t("Herdr TUI") : t("Browser");
}

export function collaboratorGroups(
  snapshot: CollaborationSnapshot | null,
  self: PresenceSelf,
  now = Date.now(),
): Collaborator[] {
  if (!snapshot) return [];
  const groups = new Map<string, Collaborator>();
  for (const participant of snapshot.participants) {
    if (participant.expires_at_unix_ms <= now) continue;
    const key =
      participant.person_id ?? `participant:${participant.participant_id}`;
    const person = participant.person_id
      ? snapshot.people?.[participant.person_id]
      : undefined;
    const isSelf = isSelfParticipant(participant, self);
    const onThisDevice =
      participant.participant_id === self.participantId ||
      (!!self.deviceId && participant.device_id === self.deviceId);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: person?.display_name || participant.display_name,
        color: person?.color ?? participant.color,
        ...(person?.avatar_url ? { avatarUrl: person.avatar_url } : {}),
        isSelf: false,
        typing: false,
        activity: participant.activity,
        devices: [],
        participants: [],
      };
      groups.set(key, group);
    }
    group.participants.push(participant);
    group.isSelf ||= isSelf;
    group.typing ||= participantIsTyping(participant, now);
    if (ACTIVITY_RANK[participant.activity] < ACTIVITY_RANK[group.activity]) {
      group.activity = participant.activity;
    }
    const deviceKey = participant.device_id ?? participant.participant_id;
    const device = group.devices.find((entry) => entry.key === deviceKey);
    if (device) {
      device.contexts += 1;
      device.isSelf ||= onThisDevice;
    } else {
      group.devices.push({
        key: deviceKey,
        name: deviceName(snapshot, participant),
        contexts: 1,
        isSelf: onThisDevice,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.isSelf) - Number(a.isSelf) ||
      ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity] ||
      a.name.localeCompare(b.name),
  );
}

/** "iPhone, liveopt (2)": device names, with a count for several tabs. */
export function deviceSummary(devices: CollaboratorDevice[]) {
  return devices
    .map((device) =>
      device.contexts > 1 ? `${device.name} (${device.contexts})` : device.name,
    )
    .filter(Boolean)
    .join(", ");
}

/** "Yubo · iPhone, liveopt" */
export function collaboratorLabel(collaborator: Collaborator) {
  const devices = deviceSummary(collaborator.devices);
  return devices ? `${collaborator.name} · ${devices}` : collaborator.name;
}

export type PanePresencePerson = {
  key: string;
  name: string;
  color: string;
  avatarUrl?: string;
  /** Devices this person uses on the pane(s), e.g. `iPhone`. */
  devices: string[];
  isSelf: boolean;
};

export type PanePresence = {
  viewers: PanePresencePerson[];
  controller: PanePresencePerson | null;
};

const EMPTY_PRESENCE: PanePresence = { viewers: [], controller: null };

/** This page's participant and, once the bridge answered, its person. */
export type PresenceSelf = {
  participantId: string;
  personId?: string;
  deviceId?: string;
};

function isSelfParticipant(
  participant: CollaborationParticipant,
  self: PresenceSelf,
) {
  return (
    participant.participant_id === self.participantId ||
    (!!self.personId && participant.person_id === self.personId)
  );
}

function addPerson(
  people: Map<string, PanePresencePerson>,
  snapshot: CollaborationSnapshot,
  participant: CollaborationParticipant,
  self: PresenceSelf,
) {
  const key =
    participant.person_id ?? `participant:${participant.participant_id}`;
  const person = participant.person_id
    ? snapshot.people?.[participant.person_id]
    : undefined;
  const entry = people.get(key) ?? {
    key,
    name: person?.display_name || participant.display_name,
    color: person?.color ?? participant.color,
    ...(person?.avatar_url ? { avatarUrl: person.avatar_url } : {}),
    devices: [],
    isSelf: false,
  };
  const name = deviceName(snapshot, participant);
  if (!entry.devices.includes(name)) entry.devices.push(name);
  entry.isSelf ||= isSelfParticipant(participant, self);
  people.set(key, entry);
  return entry;
}

/**
 * Who is looking at and who controls a set of panes (one pane row, or every
 * pane of a tab). Viewers are grouped by person; this page itself and
 * hidden (away) pages are not viewers. The controller is the holder of the
 * pane's layout claim ("Take control"), shown even when it is this page.
 * Computed from the presence snapshot, so it costs no extra traffic.
 */
export function panePresence(
  snapshot: CollaborationSnapshot | null,
  paneIds: readonly string[],
  self: PresenceSelf,
  now = Date.now(),
): PanePresence {
  if (!snapshot || paneIds.length === 0) return EMPTY_PRESENCE;
  const panes = new Set(paneIds);
  const byId = new Map(
    snapshot.participants
      .filter((participant) => participant.expires_at_unix_ms > now)
      .map((participant) => [participant.participant_id, participant]),
  );
  const claim = snapshot.pane_claims.find(
    (entry) =>
      panes.has(entry.pane_id) &&
      entry.expires_at_unix_ms > now &&
      byId.has(entry.participant_id),
  );
  const controllers = new Map<string, PanePresencePerson>();
  const controllerParticipant = claim
    ? byId.get(claim.participant_id)
    : undefined;
  const controller = controllerParticipant
    ? addPerson(controllers, snapshot, controllerParticipant, self)
    : null;
  const viewers = new Map<string, PanePresencePerson>();
  for (const participant of byId.values()) {
    if (!participant.pane_id || !panes.has(participant.pane_id)) continue;
    if (participant.participant_id === self.participantId) continue;
    if (participant.activity === "away") continue;
    addPerson(viewers, snapshot, participant, self);
  }
  if (!controller && viewers.size === 0) return EMPTY_PRESENCE;
  return {
    viewers: [...viewers.values()].sort(
      (a, b) =>
        Number(b.key === controller?.key) - Number(a.key === controller?.key) ||
        a.name.localeCompare(b.name),
    ),
    controller,
  };
}

/** "Yubo (iPhone, liveopt)", or "You (iPhone)" for this person. */
export function presencePersonLabel(person: PanePresencePerson) {
  const devices = person.devices.filter(Boolean).join(", ");
  const name = person.isSelf ? t("You") : person.name;
  return devices ? `${name} (${devices})` : name;
}

/** Tooltip and accessible description of a pane's presence. */
export function panePresenceLabel(presence: PanePresence) {
  const lines: string[] = [];
  if (presence.viewers.length > 0) {
    lines.push(
      t("Viewing: {people}", {
        people: presence.viewers.map(presencePersonLabel).join(", "),
      }),
    );
  }
  if (presence.controller) {
    lines.push(
      t("Controlling: {person}", {
        person: presencePersonLabel(presence.controller),
      }),
    );
  }
  return lines.join("; ");
}

/**
 * One avatar per person, the controller first and marked; a controller who
 * also views is listed once.
 */
export function presencePeople(presence: PanePresence) {
  const { controller, viewers } = presence;
  const people = controller
    ? [controller, ...viewers.filter((viewer) => viewer.key !== controller.key)]
    : viewers;
  return people.map((person) => ({
    ...person,
    controller: person.key === controller?.key,
  }));
}

/** A stable key: rows re-render only when their presence changes. */
export function panePresenceSignature(presence: PanePresence) {
  if (presence === EMPTY_PRESENCE) return "";
  return JSON.stringify([
    presence.controller
      ? [
          presence.controller.key,
          presence.controller.name,
          presence.controller.color,
          presence.controller.avatarUrl ?? "",
          presence.controller.devices,
          presence.controller.isSelf,
        ]
      : null,
    presence.viewers.map((viewer) => [
      viewer.key,
      viewer.name,
      viewer.color,
      viewer.avatarUrl ?? "",
      viewer.devices,
      viewer.isSelf,
    ]),
  ]);
}
