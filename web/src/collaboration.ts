import { bridge, type ConnectionClient, type HerdrEventMsg } from "./api";
import { thyraLocalStorage } from "./browserStorage";
import { t } from "./i18n";
import type { State } from "./store";

export type CollaborationParticipant = {
  participant_id: string;
  display_name: string;
  color: string;
  role: "owner" | "editor" | "viewer";
  activity: "active" | "idle" | "away";
  surface: string;
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  typing?: boolean;
  typing_expires_at_unix_ms?: number;
  updated_at_unix_ms: number;
  expires_at_unix_ms: number;
  /** Opaque bridge-assigned ids; keys of the snapshot's people/devices. */
  person_id?: string;
  device_id?: string;
};

/** How the bridge recognized a device (see docs/ARCHITECTURE.md). */
export type CollaborationIdentityMatch =
  | "tailscale"
  | "tailnet-address"
  | "cookie"
  | "device-hints";

export type CollaborationPerson = {
  display_name: string;
  color: string;
  avatar_url?: string;
};

export type CollaborationDevice = {
  name: string;
  os?: string;
  match?: CollaborationIdentityMatch;
};

/** This browser's identity as resolved by the bridge (`bridge.identity`). */
export type CollaborationSelfIdentity = {
  person_id: string;
  device_id: string;
  display_name: string | null;
  custom_name: boolean;
  color: string;
  device_name: string;
  match: CollaborationIdentityMatch;
  os?: string;
  avatar_url?: string;
  login?: string;
};

export type CollaborationPaneClaim = {
  pane_id: string;
  participant_id: string;
  acquired_at_unix_ms: number;
  updated_at_unix_ms: number;
  expires_at_unix_ms: number;
  protected_until_unix_ms?: number;
};

export type CollaborationSnapshot = {
  participants: CollaborationParticipant[];
  pane_claims: CollaborationPaneClaim[];
  lease_ttl_ms: number;
  people?: Record<string, CollaborationPerson>;
  devices?: Record<string, CollaborationDevice>;
};

export type CollaborationProfile = {
  participantId: string;
  displayName: string;
  color: string;
};

const PROFILE_KEY = "collaborationProfile";
const COLORS = [
  "#0969da",
  "#1a7f37",
  "#8250df",
  "#bf8700",
  "#cf222e",
  "#0a7c86",
];
let cachedProfile: CollaborationProfile | null = null;
let clientSessionId: string | null = null;
let selfIdentity: CollaborationSelfIdentity | null = null;
const identityListeners = new Set<
  (identity: CollaborationSelfIdentity | null) => void
>();
let identityStarted = false;
let identityRequestSeq = 0;
const snapshots = new Map<string, CollaborationSnapshot>();
const snapshotListeners = new Set<
  (scope: string, snapshot: CollaborationSnapshot) => void
>();
const TYPING_IDLE_MS = 1_600;
const TYPING_REFRESH_MS = 800;
let typingScope = "";
let typingDeadline = 0;
let typingLastSentAt = 0;
let typingTimer: ReturnType<typeof setTimeout> | null = null;

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function defaultName(device = navigator.platform?.trim()) {
  return device ? t("{device} user", { device }) : t("Thyra user");
}

/** Names the browser generated before profiles moved to the bridge. */
export function isLegacyDefaultName(name: string, platform: string) {
  const defaults = ["Thyra user", "Thyra \u7528\u6237"];
  if (platform) defaults.push(`${platform} user`, `${platform} \u7528\u6237`);
  return defaults.includes(name.trim());
}

export function collaborationProfileForSession(
  participantId: string,
  stored: unknown,
  fallbackDisplayName: string,
): CollaborationProfile {
  if (
    stored &&
    typeof stored === "object" &&
    typeof (stored as { displayName?: unknown }).displayName === "string" &&
    /^#[0-9a-f]{6}$/i.test(String((stored as { color?: unknown }).color ?? ""))
  ) {
    return {
      participantId,
      displayName:
        (stored as { displayName: string }).displayName.trim().slice(0, 80) ||
        fallbackDisplayName,
      color: String((stored as { color: string }).color),
    };
  }
  return {
    participantId,
    displayName: fallbackDisplayName,
    color:
      COLORS[
        Array.from(participantId).reduce(
          (sum, character) => sum + character.charCodeAt(0),
          0,
        ) % COLORS.length
      ],
  };
}

function readStoredProfile(): unknown {
  try {
    return JSON.parse(thyraLocalStorage.getItem(PROFILE_KEY) ?? "null");
  } catch {
    // A restricted storage context still gets an in-memory identity.
    return null;
  }
}

export function collaborationProfile(): CollaborationProfile {
  // participant_id deliberately identifies this page lifetime. Persisting it
  // made every tab/window impersonate the same collaborator and bypass pane
  // ownership checks intended for independent client sessions. People and
  // devices are recognized by the bridge instead (bridge.identity).
  clientSessionId ??= `web-${randomId()}`;
  if (selfIdentity) {
    return {
      participantId: clientSessionId,
      displayName:
        selfIdentity.display_name ??
        defaultName(selfIdentity.device_name || undefined),
      color: selfIdentity.color,
    };
  }
  cachedProfile ??= collaborationProfileForSession(
    clientSessionId,
    readStoredProfile(),
    defaultName(),
  );
  return cachedProfile;
}

export function collaborationSelfIdentity() {
  return selfIdentity;
}

export function subscribeCollaborationIdentity(
  listener: (identity: CollaborationSelfIdentity | null) => void,
) {
  identityListeners.add(listener);
  return () => {
    identityListeners.delete(listener);
  };
}

function parseSelfIdentity(value: unknown): CollaborationSelfIdentity | null {
  const identity = value as Partial<CollaborationSelfIdentity> | null;
  if (
    !identity ||
    typeof identity !== "object" ||
    typeof identity.person_id !== "string" ||
    typeof identity.device_id !== "string" ||
    typeof identity.color !== "string"
  ) {
    return null;
  }
  return {
    ...(identity as CollaborationSelfIdentity),
    display_name:
      typeof identity.display_name === "string" ? identity.display_name : null,
    device_name:
      typeof identity.device_name === "string" ? identity.device_name : "",
  };
}

function applySelfIdentity(value: unknown) {
  const identity = parseSelfIdentity(value);
  if (!identity) return false;
  selfIdentity = identity;
  identityListeners.forEach((listener) => listener(identity));
  return true;
}

type NavigatorUAData = {
  platform?: string;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ platform?: string; platformVersion?: string; model?: string }>;
};

/**
 * Coarse hints that let the bridge recognize one device across browser
 * contexts that cannot share cookies. No canvas, audio or font probing.
 */
export async function collectDeviceHints(): Promise<Record<string, unknown>> {
  const hints: Record<string, unknown> = {};
  try {
    hints.screen = {
      width: screen.width,
      height: screen.height,
      dpr: window.devicePixelRatio,
    };
    hints.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    hints.language = navigator.language;
    hints.touch_points = navigator.maxTouchPoints;
    hints.standalone =
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as { standalone?: boolean }).standalone === true;
    const uaData = (navigator as { userAgentData?: NavigatorUAData })
      .userAgentData;
    if (uaData?.platform) hints.platform = uaData.platform;
    const details = await uaData
      ?.getHighEntropyValues?.(["platformVersion", "model"])
      .catch(() => null);
    if (details?.platformVersion)
      hints.platform_version = details.platformVersion;
    if (details?.model) hints.model = details.model;
  } catch {
    // Hints only refine the match; the request still identifies the device.
  }
  return hints;
}

async function requestSelfIdentity() {
  const seq = ++identityRequestSeq;
  const stored = readStoredProfile() as {
    displayName?: unknown;
    color?: unknown;
  } | null;
  const legacyName =
    typeof stored?.displayName === "string" &&
    stored.displayName.trim() &&
    !isLegacyDefaultName(stored.displayName, navigator.platform?.trim() ?? "")
      ? stored.displayName.trim().slice(0, 80)
      : null;
  try {
    const result = await bridge.call("bridge.identity", {
      hints: await collectDeviceHints(),
      ...(legacyName
        ? {
            legacy_profile: {
              display_name: legacyName,
              ...(typeof stored?.color === "string"
                ? { color: stored.color }
                : {}),
            },
          }
        : {}),
    });
    if (seq !== identityRequestSeq) return;
    // The bridge now owns the profile; the browser copy was migrated once.
    if (applySelfIdentity(result?.identity) && stored) {
      try {
        thyraLocalStorage.removeItem(PROFILE_KEY);
      } catch {}
    }
  } catch {
    // Keep the browser-local profile until the next connection.
  }
}

/** Ask the bridge who this browser is, now and after every reconnect. */
export function startCollaborationIdentity() {
  if (identityStarted) return;
  identityStarted = true;
  bridge.onHello(() => void requestSelfIdentity());
  if (bridge.hello && bridge.status === "connected") void requestSelfIdentity();
}

/** Store a custom display name for this person (all their devices). */
export async function saveCollaborationDisplayName(displayName: string) {
  const name = displayName.trim().slice(0, 80);
  try {
    const result = await bridge.call("bridge.identity_profile", {
      display_name: name,
    });
    if (applySelfIdentity(result?.identity)) return;
  } catch {
    // Fall back to this page until the bridge is reachable again.
  }
  cachedProfile = {
    ...collaborationProfile(),
    displayName: name || defaultName(),
  };
}

function parseSnapshot(result: unknown): CollaborationSnapshot | null {
  if (!result || typeof result !== "object") return null;
  const snapshot = (result as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Partial<CollaborationSnapshot>;
  if (!Array.isArray(value.participants) || !Array.isArray(value.pane_claims)) {
    return null;
  }
  const table = <T>(input: unknown) =>
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, T>)
      : undefined;
  const people = table<CollaborationPerson>(value.people);
  const devices = table<CollaborationDevice>(value.devices);
  return {
    participants: value.participants,
    pane_claims: value.pane_claims,
    lease_ttl_ms: Number(value.lease_ttl_ms ?? 45_000),
    ...(people ? { people } : {}),
    ...(devices ? { devices } : {}),
  };
}

function collaborationScope(client: ConnectionClient): string {
  return `${client.connectionId}:${client.generation}:${client.serverRuntimeGeneration ?? "legacy"}`;
}

export function publishCollaborationSnapshot(
  client: ConnectionClient,
  snapshot: CollaborationSnapshot,
) {
  const scope = collaborationScope(client);
  snapshots.set(scope, snapshot);
  snapshotListeners.forEach((listener) => listener(scope, snapshot));
}

export function subscribeCollaborationSnapshot(
  client: ConnectionClient,
  listener: (snapshot: CollaborationSnapshot | null) => void,
) {
  const scope = collaborationScope(client);
  listener(snapshots.get(scope) ?? null);
  const scopedListener = (
    changedScope: string,
    snapshot: CollaborationSnapshot,
  ) => {
    if (changedScope === scope) listener(snapshot);
  };
  snapshotListeners.add(scopedListener);
  return () => {
    snapshotListeners.delete(scopedListener);
  };
}

export function acceptCollaborationEvent(
  client: ConnectionClient,
  event: HerdrEventMsg,
): boolean {
  if (
    (event.event !== "collaboration.updated" &&
      event.event !== "collaboration_updated") ||
    event.connection_id !== client.connectionId ||
    !client.isCurrent() ||
    !client.acceptsServerGeneration(event.connection_generation)
  ) {
    return false;
  }
  const parsed = parseSnapshot({ snapshot: event.data.snapshot });
  if (!parsed) return false;
  publishCollaborationSnapshot(client, parsed);
  return true;
}

export function participantIsTyping(
  participant: CollaborationParticipant,
  now = Date.now(),
): boolean {
  return (
    participant.typing === true &&
    (participant.typing_expires_at_unix_ms === undefined ||
      participant.typing_expires_at_unix_ms > now)
  );
}

export function shouldTakeOverPaneFromMouse(event: {
  button: number;
  shiftKey: boolean;
}): boolean {
  return event.button === 0 && event.shiftKey;
}

export function collaborationPresenceParams(
  snapshot: Pick<
    State,
    "workspaces" | "tabs" | "panes" | "selectedPaneId" | "layout"
  >,
  typing = false,
) {
  const profile = collaborationProfile();
  const workspace = snapshot.workspaces.find((entry) => entry.focused);
  const tab = snapshot.tabs.find(
    (entry) =>
      entry.tab_id === (workspace?.active_tab_id ?? snapshot.layout?.tab_id),
  );
  const paneId =
    snapshot.selectedPaneId ??
    snapshot.layout?.focused_pane_id ??
    snapshot.panes.find((entry) => entry.focused)?.pane_id;
  return {
    participant_id: profile.participantId,
    display_name: profile.displayName,
    color: profile.color,
    role: "editor",
    activity: document.visibilityState === "hidden" ? "away" : "active",
    surface: "web",
    typing,
    ...(workspace ? { workspace_id: workspace.workspace_id } : {}),
    ...(tab ? { tab_id: tab.tab_id } : {}),
    ...(paneId ? { pane_id: paneId } : {}),
  };
}

export async function updateCollaborationPresence(
  client: ConnectionClient,
  snapshot: Pick<
    State,
    "workspaces" | "tabs" | "panes" | "selectedPaneId" | "layout"
  >,
  options: { typing?: boolean } = {},
): Promise<CollaborationSnapshot> {
  const scope = collaborationScope(client);
  const typing =
    options.typing ?? (typingScope === scope && typingDeadline > Date.now());
  const result = await client.call(
    "collaboration.update",
    collaborationPresenceParams(snapshot, typing),
  );
  const parsed = parseSnapshot(result);
  if (!parsed) throw new Error(t("invalid collaboration snapshot"));
  publishCollaborationSnapshot(client, parsed);
  return parsed;
}

export function markCollaborationTyping(
  client: ConnectionClient,
  readState: () => Pick<
    State,
    "workspaces" | "tabs" | "panes" | "selectedPaneId" | "layout"
  >,
) {
  if (!client.isCurrent()) return;
  const scope = collaborationScope(client);
  const now = Date.now();
  if (typingScope !== scope) {
    typingScope = scope;
    typingLastSentAt = 0;
  }
  typingDeadline = now + TYPING_IDLE_MS;
  if (now - typingLastSentAt >= TYPING_REFRESH_MS) {
    typingLastSentAt = now;
    void updateCollaborationPresence(client, readState(), {
      typing: true,
    }).catch(() => null);
  }
  if (typingTimer) clearTimeout(typingTimer);
  const expectedDeadline = typingDeadline;
  typingTimer = setTimeout(() => {
    if (typingScope !== scope || typingDeadline !== expectedDeadline) return;
    typingTimer = null;
    typingDeadline = 0;
    typingLastSentAt = 0;
    if (!client.isCurrent()) return;
    void updateCollaborationPresence(client, readState(), {
      typing: false,
    }).catch(() => null);
  }, TYPING_IDLE_MS);
}
