import { createHmac, randomBytes } from "node:crypto";
import { parseCookie } from "../utils/request";
import { type Logger, silentLogger } from "../utils/logger";
import { resolveClientAddress, type TrustedProxies } from "./client-address";
import { chooseMergeTarget } from "./device-merge";
import { type DeviceHints, deviceHintsFrom, deviceLabel } from "./device-hints";
import type { IdentityStore } from "./identity-store";
import { isTailnetAddress, type TailscaleWhois } from "./tailscale";

/**
 * Server-authoritative collaborator identity. Each WebSocket carries a
 * client context (resolved address, device cookie, User-Agent). A context is
 * resolved to a device and a person:
 *
 * - tailnet address with Tailscale `whois`: device = node, person = login;
 * - tailnet address without `whois`: device = that address (one per node);
 * - otherwise: device = the device cookie, possibly matched to an existing
 *   device by `chooseMergeTarget`; the person is that device.
 *
 * Browsers receive only opaque person/device ids, names and avatars; client
 * addresses and cookie values never leave this server.
 */

export const DEVICE_COOKIE = "thyra_device";
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const RESOLVE_TTL_MS = 5 * 60_000;
const PARTICIPANT_TTL_MS = 90_000;
const MAX_PARTICIPANTS = 1000;
const COLORS = [
  "#0969da",
  "#1a7f37",
  "#8250df",
  "#bf8700",
  "#cf222e",
  "#0a7c86",
];

export type ClientContext = {
  deviceId: string;
  address: string | null;
  userAgent: string;
  /**
   * The logged-in account: it is the person, whatever the device.
   * `fixedName` (share-link guests) ignores names saved for the device.
   */
  account?: {
    key: string;
    displayName: string;
    fixedName?: boolean;
    /** The account's uploaded picture, over the Tailscale one. */
    avatarUrl?: string;
  };
};

export type IdentityMatch =
  | "tailscale"
  | "tailnet-address"
  | "cookie"
  | "device-hints";

export type ResolvedIdentity = {
  personKey: string;
  deviceKey: string;
  personId: string;
  deviceId: string;
  displayName: string | null;
  customName: boolean;
  color: string;
  avatarUrl?: string;
  deviceName: string;
  os?: string;
  match: IdentityMatch;
  login?: string;
};

/**
 * Presence snapshots gain `person_id`/`device_id` on each known participant
 * plus one `people` and one `devices` table, so a person's avatar and name
 * are sent once however many tabs, devices and panes they have.
 */
export type SnapshotPerson = {
  display_name: string;
  color: string;
  avatar_url?: string;
};
export type SnapshotDevice = {
  name: string;
  os?: string;
  match?: IdentityMatch;
};

/** Which host a connection's Herdr TUI clients run on, for their labels. */
export type PresenceContext = { tuiDevice?: string };

const TUI_PARTICIPANT_PREFIX = "tui:";
const TUI_PERSON_NAME = "Herdr TUI";
const TUI_COLOR = "#8250df";

type Session = {
  context: ClientContext;
  hints: DeviceHints;
  reportedHints: boolean;
  resolved?: { value: Promise<ResolvedIdentity>; at: number };
  latest?: ResolvedIdentity;
};

type ParticipantEntry = { identity: ResolvedIdentity; expiresAt: number };

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 80);
  return name || undefined;
}

function cleanColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : undefined;
}

export function selfIdentityView(identity: ResolvedIdentity) {
  return {
    person_id: identity.personId,
    device_id: identity.deviceId,
    display_name: identity.displayName,
    custom_name: identity.customName,
    color: identity.color,
    device_name: identity.deviceName,
    match: identity.match,
    ...(identity.os ? { os: identity.os } : {}),
    ...(identity.avatarUrl ? { avatar_url: identity.avatarUrl } : {}),
    ...(identity.login ? { login: identity.login } : {}),
  };
}

export type SelfIdentityView = ReturnType<typeof selfIdentityView>;

export type IdentityService = ReturnType<typeof createIdentityService>;

export function createIdentityService<Socket extends object>(args: {
  store: IdentityStore;
  whois: TailscaleWhois;
  trustedProxies: TrustedProxies;
  /** Native TLS: device cookies are always `Secure`. */
  secureCookies?: boolean;
  now?: () => number;
  logger?: Logger;
}) {
  const now = args.now ?? Date.now;
  const logger = args.logger ?? silentLogger;
  const sessions = new Map<Socket, Session>();
  const participants = new Map<string, ParticipantEntry>();

  const keyed = (value: string) =>
    createHmac("sha256", args.store.secret).update(value).digest("base64url");
  const publicId = (value: string) => keyed(`public:${value}`).slice(0, 20);
  const colorFor = (personKey: string) =>
    COLORS[
      createHmac("sha256", "thyra-color").update(personKey).digest()[0] %
        COLORS.length
    ];

  function requestContext(req: Request, peer: string | null | undefined) {
    const client = resolveClientAddress({
      peer,
      headers: req.headers,
      trusted: args.trustedProxies,
    });
    const cookie = parseCookie(req.headers.get("cookie"), DEVICE_COOKIE);
    const known = cookie && DEVICE_ID_PATTERN.test(cookie) ? cookie : null;
    const deviceId = known ?? randomBytes(18).toString("base64url");
    let secure =
      Boolean(args.secureCookies) || client.forwardedProto === "https";
    try {
      secure ||= new URL(req.url).protocol === "https:";
    } catch {}
    const headers: Record<string, string> = known
      ? {}
      : {
          "set-cookie": `${DEVICE_COOKIE}=${deviceId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`,
        };
    const context: ClientContext = {
      deviceId,
      address: client.address,
      userAgent: (req.headers.get("user-agent") ?? "").slice(0, 512),
    };
    return { context, headers };
  }

  async function resolveSession(session: Session): Promise<ResolvedIdentity> {
    const { context } = session;
    const address = context.address;
    const tailnet = isTailnetAddress(address);
    const tailscale =
      tailnet && address ? await args.whois.lookup(address) : null;
    const addressHash = address ? keyed(`address:${address}`) : undefined;
    const record = args.store.touchDevice(context.deviceId, {
      addressHash,
      ...(session.reportedHints ? { hints: session.hints } : {}),
    });
    if (!tailnet && session.reportedHints) {
      const target = chooseMergeTarget({
        deviceId: context.deviceId,
        device: record,
        addressHash,
        devices: args.store.devices(),
        rootId: args.store.rootId,
        now: now(),
      });
      if (target) {
        args.store.alias(context.deviceId, target);
        logger.debug("matched browser context to a known device");
      }
    }
    const root = args.store.rootId(context.deviceId);
    const deviceKey = tailscale
      ? `ts-node:${tailscale.nodeId}`
      : tailnet
        ? `tailnet:${address}`
        : `device:${root}`;
    const tailscalePerson = tailscale?.user
      ? `ts-user:${tailscale.user.login}`
      : null;
    const personKey = context.account?.key ?? tailscalePerson ?? deviceKey;
    const profiles = [
      ...new Set([
        personKey,
        ...(tailscalePerson ? [tailscalePerson] : []),
        deviceKey,
        `device:${root}`,
        `device:${context.deviceId}`,
      ]),
    ].flatMap((key) => {
      const profile = args.store.profile(key);
      return profile ? [profile] : [];
    });
    const customName = context.account?.fixedName
      ? undefined
      : profiles.find((profile) => profile.displayName)?.displayName;
    const color =
      profiles.find((profile) => profile.color)?.color ?? colorFor(personKey);
    const os = tailscale?.os ?? session.hints.os;
    const identity: ResolvedIdentity = {
      personKey,
      deviceKey,
      personId: publicId(personKey),
      deviceId: publicId(deviceKey),
      displayName:
        customName ??
        context.account?.displayName ??
        tailscale?.user?.displayName ??
        null,
      customName: Boolean(customName),
      color,
      deviceName: tailscale?.deviceName || deviceLabel(session.hints),
      match: tailscale
        ? "tailscale"
        : tailnet
          ? "tailnet-address"
          : root !== context.deviceId
            ? "device-hints"
            : "cookie",
      ...(os ? { os } : {}),
      ...((context.account?.avatarUrl ?? tailscale?.user?.avatarUrl)
        ? {
            avatarUrl: context.account?.avatarUrl ?? tailscale?.user?.avatarUrl,
          }
        : {}),
      ...(tailscale?.user ? { login: tailscale.user.login } : {}),
    };
    session.latest = identity;
    return identity;
  }

  function resolve(socket: Socket): Promise<ResolvedIdentity | null> {
    const session = sessions.get(socket);
    if (!session) return Promise.resolve(null);
    const cached = session.resolved;
    if (cached && now() - cached.at < RESOLVE_TTL_MS) return cached.value;
    const value = resolveSession(session);
    session.resolved = { value, at: now() };
    value.catch(() => {
      if (session.resolved?.value === value) session.resolved = undefined;
    });
    return value;
  }

  function invalidatePerson(personKey: string) {
    for (const session of sessions.values()) {
      if (session.latest?.personKey === personKey) session.resolved = undefined;
    }
  }

  function refreshParticipants(identity: ResolvedIdentity) {
    for (const entry of participants.values()) {
      if (entry.identity.personKey !== identity.personKey) continue;
      entry.identity = {
        ...entry.identity,
        displayName: identity.displayName,
        customName: identity.customName,
        color: identity.color,
      };
    }
  }

  function pruneParticipants() {
    const at = now();
    for (const [id, entry] of participants) {
      if (entry.expiresAt <= at) participants.delete(id);
    }
    while (participants.size > MAX_PARTICIPANTS) {
      const oldest = participants.keys().next().value;
      if (oldest === undefined) break;
      participants.delete(oldest);
    }
  }

  function annotateSnapshot<T>(snapshot: T, context: PresenceContext = {}): T {
    const value = snapshot as { participants?: unknown } | null;
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray(value.participants)
    )
      return snapshot;
    const people: Record<string, SnapshotPerson> = {};
    const devices: Record<string, SnapshotDevice> = {};
    let changed = false;
    const annotated = value.participants.map((participant) => {
      const record = participant as {
        participant_id?: unknown;
        display_name?: unknown;
      } | null;
      const id = record?.participant_id;
      if (typeof id !== "string") return participant;
      const entry = participants.get(id);
      if (entry) {
        const identity = entry.identity;
        const displayName =
          identity.displayName ??
          (typeof record?.display_name === "string" ? record.display_name : "");
        people[identity.personId] ??= {
          display_name: displayName,
          color: identity.color,
          ...(identity.avatarUrl ? { avatar_url: identity.avatarUrl } : {}),
        };
        devices[identity.deviceId] ??= {
          name: identity.deviceName,
          match: identity.match,
          ...(identity.os ? { os: identity.os } : {}),
        };
        changed = true;
        return {
          ...(participant as object),
          ...(identity.displayName
            ? { display_name: identity.displayName }
            : {}),
          color: identity.color,
          person_id: identity.personId,
          device_id: identity.deviceId,
        };
      }
      // Real Herdr TUI clients run on the Herdr host; label them by it.
      if (id.startsWith(TUI_PARTICIPANT_PREFIX) && context.tuiDevice) {
        const personId = publicId(`tui-person:${context.tuiDevice}`);
        const deviceId = publicId(`tui-device:${context.tuiDevice}`);
        people[personId] ??= {
          display_name: TUI_PERSON_NAME,
          color: TUI_COLOR,
        };
        devices[deviceId] ??= { name: context.tuiDevice };
        changed = true;
        return {
          ...(participant as object),
          person_id: personId,
          device_id: deviceId,
        };
      }
      return participant;
    });
    return changed
      ? ({ ...value, participants: annotated, people, devices } as T)
      : snapshot;
  }

  return {
    /** Context for a WebSocket upgrade, with a `Set-Cookie` for new devices. */
    upgradeContext: requestContext,

    /** Add the device cookie to an HTML page response that lacks one. */
    withPageCookie(
      req: Request,
      peer: string | null | undefined,
      response: Response,
    ): Response {
      if (!(response.headers.get("content-type") ?? "").startsWith("text/html"))
        return response;
      const { headers } = requestContext(req, peer);
      if (!headers["set-cookie"]) return response;
      const next = new Headers(response.headers);
      next.append("set-cookie", headers["set-cookie"]);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: next,
      });
    },

    attach(socket: Socket, context: ClientContext | undefined) {
      if (!context) return;
      sessions.set(socket, {
        context,
        hints: deviceHintsFrom(context.userAgent, null),
        reportedHints: false,
      });
    },

    detach(socket: Socket) {
      sessions.delete(socket);
    },

    resolve,

    /**
     * `bridge.identity`: record the page's device hints, migrate a legacy
     * browser-stored display name once, and return this client's identity.
     */
    async hello(socket: Socket, params: Record<string, unknown> = {}) {
      const session = sessions.get(socket);
      if (!session) throw new Error("identity unavailable for this client");
      session.hints = deviceHintsFrom(session.context.userAgent, params.hints);
      session.reportedHints = true;
      session.resolved = undefined;
      let identity = await resolve(socket);
      if (!identity) throw new Error("identity unavailable for this client");
      const legacy = params.legacy_profile as
        | { display_name?: unknown; color?: unknown }
        | undefined;
      const legacyName = cleanName(legacy?.display_name);
      let migrated = false;
      if (legacyName && !identity.customName) {
        args.store.setProfile(identity.personKey, {
          displayName: legacyName,
          ...(cleanColor(legacy?.color)
            ? { color: cleanColor(legacy?.color) }
            : {}),
        });
        migrated = true;
        invalidatePerson(identity.personKey);
        identity = (await resolve(socket)) ?? identity;
        refreshParticipants(identity);
      }
      return { identity: selfIdentityView(identity), migrated };
    },

    /**
     * Forget a person's custom presence name (the account page renamed the
     * account, which then shows everywhere).
     */
    clearCustomName(personKey: string) {
      const existing = args.store.profile(personKey);
      if (!existing?.displayName) return;
      args.store.setProfile(personKey, {
        ...(existing.color ? { color: existing.color } : {}),
      });
      invalidatePerson(personKey);
    },

    /** `bridge.identity_profile`: set or clear the custom display name. */
    async updateProfile(socket: Socket, params: Record<string, unknown> = {}) {
      const current = await resolve(socket);
      if (!current) throw new Error("identity unavailable for this client");
      const existing = args.store.profile(current.personKey);
      const displayName =
        params.display_name === undefined
          ? existing?.displayName
          : cleanName(params.display_name);
      const color =
        params.color === undefined
          ? existing?.color
          : (cleanColor(params.color) ?? existing?.color);
      args.store.setProfile(current.personKey, {
        ...(displayName ? { displayName } : {}),
        ...(color ? { color } : {}),
      });
      invalidatePerson(current.personKey);
      const identity = (await resolve(socket)) ?? current;
      refreshParticipants(identity);
      return { identity: selfIdentityView(identity) };
    },

    /**
     * Stamp a `collaboration.update` with the server-side name and color, and
     * remember which identity owns the participant for later snapshots.
     */
    async presenceParams(
      socket: Socket,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const participantId = params.participant_id;
      if (typeof participantId !== "string" || !participantId) return params;
      const identity = await resolve(socket);
      if (!identity) return params;
      pruneParticipants();
      participants.delete(participantId);
      participants.set(participantId, {
        identity,
        expiresAt: now() + PARTICIPANT_TTL_MS,
      });
      return {
        ...params,
        ...(identity.displayName ? { display_name: identity.displayName } : {}),
        color: identity.color,
      };
    },

    /**
     * The presence participant id the bridge assigns to a socket. A page
     * reconnecting with the same `clientSession` nonce keeps its id (and
     * pane claims); the device cookie in the derivation keeps other
     * browsers from reproducing it.
     */
    participantId(socket: Socket, clientSession: string | null): string {
      const deviceId = sessions.get(socket)?.context.deviceId;
      if (!deviceId || !clientSession)
        return `web-${randomBytes(12).toString("base64url")}`;
      return `web-${keyed(`participant:${deviceId}:${clientSession}`).slice(0, 22)}`;
    },

    forgetParticipant(participantId: unknown) {
      if (typeof participantId === "string") participants.delete(participantId);
    },

    annotateSnapshot,

    /** Annotate a collaboration RPC result carrying a `snapshot`. */
    annotateResult(result: unknown, context: PresenceContext = {}): unknown {
      if (!result || typeof result !== "object") return result;
      const snapshot = (result as { snapshot?: unknown }).snapshot;
      if (!snapshot || typeof snapshot !== "object") return result;
      const annotated = annotateSnapshot(snapshot, context);
      return annotated === snapshot
        ? result
        : { ...result, snapshot: annotated };
    },

    /** Whether a Tailscale `whois` backend is configured. */
    whoisAvailable: args.whois.available,

    /**
     * The Tailscale user owning a tailnet address, via the cached `whois`.
     * Null for non-tailnet addresses, tagged or unknown nodes, and lookup
     * failures, so callers fail closed.
     */
    async tailnetUser(
      address: string | null | undefined,
    ): Promise<{ login: string; displayName?: string } | null> {
      if (!address || !isTailnetAddress(address)) return null;
      const identity = await args.whois.lookup(address);
      return identity?.user
        ? {
            login: identity.user.login,
            ...(identity.user.displayName
              ? { displayName: identity.user.displayName }
              : {}),
          }
        : null;
    },

    /** Device key for client counting; falls back to the cookie device. */
    deviceKeyOf(socket: Socket): string | null {
      const session = sessions.get(socket);
      if (!session) return null;
      return (
        session.latest?.deviceKey ??
        `device:${args.store.rootId(session.context.deviceId)}`
      );
    },

    flush: () => args.store.flush(),
  };
}

/** The host a connection's Herdr runs on: the SSH host, else this machine. */
export function herdrHostLabel(sshHost: string | undefined, localHost: string) {
  const host = sshHost?.split("@").pop()?.trim();
  return (host || localHost).split(".")[0] || localHost;
}
