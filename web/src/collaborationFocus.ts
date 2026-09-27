import type {
  CollaborationParticipant,
  CollaborationSnapshot,
} from "./collaboration";
import { deviceName, type PresenceSelf } from "./collaborationGroups";
import { t } from "./i18n";
import { customTabLabel, paneDisplayName } from "./paneIdentity";
import type { Pane, Tab, Workspace } from "./types";
import { shortId } from "./utils";

/**
 * Where people are looking. A person's focus is the focus of their most
 * recently active browser page (device and tab), preferring pages that are
 * visible; follow mode moves this page there.
 */

export type PersonFocus = {
  participantId: string;
  /** Device of the page that speaks for the person, e.g. `iPhone`. */
  device: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
};

/** Presence key of a participant: its person, or the page itself. */
export function presenceKey(participant: CollaborationParticipant) {
  return participant.person_id ?? `participant:${participant.participant_id}`;
}

/** This page's presence key, as followers name it. */
export function selfPresenceKey(self: PresenceSelf) {
  return self.personId ?? `participant:${self.participantId}`;
}

const activeAt = (participant: CollaborationParticipant) =>
  participant.active_at_unix_ms ?? participant.updated_at_unix_ms;

function speaksBefore(
  a: CollaborationParticipant,
  b: CollaborationParticipant,
) {
  const visible = Number(a.activity !== "away") - Number(b.activity !== "away");
  return visible !== 0 ? visible > 0 : activeAt(a) > activeAt(b);
}

/**
 * The page that represents `key`'s focus: never this page, visible pages
 * before hidden ones, then the most recently active. Null when the person
 * has no live page (disconnected).
 */
export function personFocus(
  snapshot: CollaborationSnapshot | null,
  key: string,
  self: PresenceSelf,
  now = Date.now(),
): PersonFocus | null {
  if (!snapshot) return null;
  let best: CollaborationParticipant | null = null;
  for (const participant of snapshot.participants) {
    if (participant.expires_at_unix_ms <= now) continue;
    if (participant.participant_id === self.participantId) continue;
    if (presenceKey(participant) !== key) continue;
    if (!best || speaksBefore(participant, best)) best = participant;
  }
  if (!best) return null;
  return {
    participantId: best.participant_id,
    device: deviceName(snapshot, best),
    ...(best.workspace_id ? { workspaceId: best.workspace_id } : {}),
    ...(best.tab_id ? { tabId: best.tab_id } : {}),
    ...(best.pane_id ? { paneId: best.pane_id } : {}),
  };
}

export function focusSignature(focus: PersonFocus | null) {
  return focus
    ? `${focus.workspaceId ?? ""}\n${focus.tabId ?? ""}\n${focus.paneId ?? ""}`
    : "";
}

export type Follower = { key: string; name: string };

/** People (other than this page) whose pages follow this page's person. */
export function followersOf(
  snapshot: CollaborationSnapshot | null,
  self: PresenceSelf,
  now = Date.now(),
): Follower[] {
  if (!snapshot) return [];
  const selfKey = selfPresenceKey(self);
  const followers = new Map<string, Follower>();
  for (const participant of snapshot.participants) {
    if (participant.expires_at_unix_ms <= now) continue;
    if (participant.participant_id === self.participantId) continue;
    if (participant.following !== selfKey) continue;
    const key = presenceKey(participant);
    if (followers.has(key)) continue;
    const person = participant.person_id
      ? snapshot.people?.[participant.person_id]
      : undefined;
    followers.set(key, {
      key,
      name: person?.display_name || participant.display_name,
    });
  }
  return [...followers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type FocusLocation = {
  workspace: string;
  tab: string;
  pane: string;
  /** Short pane id, e.g. `p3`. */
  paneId: string;
};

/** Names for a focus in this page's workspace list; null when unknown. */
export function focusLocation(
  focus: Pick<PersonFocus, "workspaceId" | "tabId" | "paneId"> | null,
  lists: {
    workspaces: readonly Workspace[];
    tabs: readonly Tab[];
    panes: readonly Pane[];
  },
): FocusLocation | null {
  if (!focus) return null;
  const pane = focus.paneId
    ? lists.panes.find((entry) => entry.pane_id === focus.paneId)
    : undefined;
  const tabId = pane?.tab_id ?? focus.tabId;
  const tab = tabId
    ? lists.tabs.find((entry) => entry.tab_id === tabId)
    : undefined;
  const workspaceId =
    pane?.workspace_id ?? tab?.workspace_id ?? focus.workspaceId;
  const workspace = workspaceId
    ? lists.workspaces.find((entry) => entry.workspace_id === workspaceId)
    : undefined;
  if (!workspace) return null;
  return {
    workspace: workspace.label || workspace.workspace_id,
    tab: tab
      ? customTabLabel(tab.label) || t("Tab {number}", { number: tab.number })
      : "",
    pane: pane
      ? paneDisplayName(pane, {
          tabLabel: tab?.label,
          tabPaneCount: tab?.pane_count,
        })
      : "",
    paneId: pane ? shortId(pane.pane_id) : "",
  };
}

/** "workspace > tab > pane", without repeating a pane named like its tab. */
export function focusLocationLabel(location: FocusLocation) {
  return [location.workspace, location.tab, location.pane]
    .filter((part, index, parts) => part && part !== parts[index - 1])
    .join(" \u203a ");
}
