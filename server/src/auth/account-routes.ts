import {
  type AvatarFiles,
  avatarUrl,
  inspectAvatar,
  AVATAR_MAX_BYTES,
} from "../accounts/avatars";
import {
  type AccountStore,
  cleanText,
  type IdentityRecord,
  isWorkspaceRole,
  type User,
} from "../accounts/store";
import type { HttpRouteId } from "../authz/http-policy";
import type { RequestAccess } from "../http/request-access";
import {
  createRequestRateLimiter,
  rateLimitedResponse,
  type RequestRateLimiter,
} from "../http/request-rate-limit";
import { type Logger, silentLogger } from "../utils/logger";
import {
  type EmailCodeStore,
  inviteEmail,
  type Mailer,
  normalizeEmail,
  verifyEmail,
} from "./email";
import { isInstanceAdmin, type Principal } from "./principal";
import { type AuthProviders, providerFlags } from "./providers";
import { INVITE_TTL_MS, type InviteStore } from "./sign-in";
import { oauthCapableOrigin } from "./sign-in-routes";

/**
 * The account page's routes: profile (display name, avatar), sign-in
 * methods (passkey names, linked identities, verified emails), other
 * sessions, and invitations by email from the Share workspace dialog.
 * `HTTP_POLICY` admits signed-in accounts (and workspace owners for
 * invitations) before these run.
 *
 * The Tailscale identity is internal plumbing: it is listed only for
 * instance admins or on the tailnet listener.
 */

const MAX_BODY_BYTES = 8 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const NO_STORE = { "cache-control": "no-store" };

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (
    req.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new RequestError("expected a JSON request", 415);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    throw new RequestError("request too large", 413);
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new RequestError("invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError("expected a JSON object");
  return value as Record<string, unknown>;
}

/** Read at most `limit` bytes of a body. */
async function readBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new RequestError("image too large", 413);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Counted as a way to sign in (an unverified address is not). */
function countsAsMethod(identity: IdentityRecord): boolean {
  return identity.provider !== "email" || identity.emailVerified;
}

export type AccountRoutes = ReturnType<typeof createAccountRoutes>;

export function createAccountRoutes(args: {
  store: AccountStore;
  providers: AuthProviders;
  mailer: Mailer | null;
  codes: EmailCodeStore;
  invites: InviteStore;
  avatars: AvatarFiles;
  /** Where invitation links point (`THYRA_PUBLIC_ORIGIN` when set). */
  inviteOrigin: (access: RequestAccess) => string | null;
  connectionExists: (connectionId: string) => boolean;
  onChange: () => void;
  onSessionEnded: (idHash: string) => void;
  /** Name or picture changed: reconnect the account's pages. */
  onProfileChanged: (userId: string, change: { name?: boolean }) => void;
  sendLimiter?: RequestRateLimiter;
  fetch?: typeof fetch;
  logger?: Logger;
}) {
  const logger = args.logger ?? silentLogger;
  const fetchImpl = args.fetch ?? fetch;
  const sendLimiter =
    args.sendLimiter ??
    createRequestRateLimiter({ limit: 10, windowMs: 10 * 60_000 });

  const tailnetVisible = (principal: Principal, access: RequestAccess) =>
    isInstanceAdmin(principal) || access.listener === "tailnet";

  function account(principal: Principal): User {
    if (principal.kind !== "user")
      throw new RequestError(
        "direct local use has no account; run `thyra user add` to create one",
        400,
      );
    const user = args.store.getUser(principal.user.id);
    if (!user) throw new RequestError("unknown account", 404);
    return user;
  }

  function identityView(identity: IdentityRecord) {
    return {
      provider: identity.provider,
      subject: identity.subject,
      label:
        identity.provider === "email"
          ? identity.subject
          : (identity.displayName ?? identity.email ?? identity.subject),
      email: identity.email,
      verified: identity.emailVerified,
      has_avatar: Boolean(identity.avatarUrl),
      created_at: identity.createdAt,
      last_used_at: identity.lastUsedAt,
    };
  }

  function methods(principal: Principal, access: RequestAccess) {
    const user = account(principal);
    const visible = tailnetVisible(principal, access);
    return {
      user: {
        name: user.name,
        display_name: user.displayName,
        avatar_url: avatarUrl(user.avatar) ?? null,
      },
      passkeys: args.store.passkeysOf(user.id).map((passkey) => ({
        id: passkey.credentialId,
        name: passkey.name,
        rp_id: passkey.rpId,
        created_at: passkey.createdAt,
        last_used_at: passkey.lastUsedAt,
      })),
      identities: args.store
        .identitiesOf(user.id)
        .filter((identity) => identity.provider !== "tailscale" || visible)
        .map(identityView),
      method_count: args.store.signInMethodCount(user.id),
      providers: providerFlags(args.providers),
      can_link_oauth: oauthCapableOrigin(access.ownOrigin),
      tailnet_visible: visible,
    };
  }

  async function setAvatarFrom(user: User, bytes: Uint8Array) {
    const checked = inspectAvatar(bytes);
    if (!checked.ok) throw new RequestError(checked.error, 415);
    const name = args.avatars.save(bytes, checked.image);
    const previous = user.avatar;
    args.store.setAvatar(user.id, name, user.id);
    if (previous && previous !== name && !args.store.avatarInUse(previous))
      args.avatars.remove(previous);
    args.onProfileChanged(user.id, {});
    return json({ avatar_url: avatarUrl(name) });
  }

  /** A linked identity's picture, fetched from the provider's image host. */
  async function avatarSource(user: User, url: URL) {
    const provider = url.searchParams.get("provider");
    if (provider !== "github" && provider !== "google")
      throw new RequestError("provider must be github or google");
    const config = args.providers[provider];
    const identity = args.store
      .identitiesOf(user.id)
      .find((entry) => entry.provider === provider && entry.avatarUrl);
    if (!config || !identity?.avatarUrl)
      throw new RequestError("no picture to import", 404);
    let source: URL;
    try {
      source = new URL(identity.avatarUrl);
    } catch {
      throw new RequestError("no picture to import", 404);
    }
    const loopback =
      source.hostname === "127.0.0.1" || source.hostname === "localhost";
    if (
      !config.avatarHosts.test(source.hostname) ||
      (source.protocol !== "https:" &&
        !(loopback && source.protocol === "http:"))
    )
      throw new RequestError("that picture's host is not allowed", 400);
    const response = await fetchImpl(source.href, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const type = response.headers.get("content-type") ?? "";
    if (
      !response.ok ||
      !/^image\/(?:png|jpeg|webp|gif)$/.test(type.split(";")[0]!.trim())
    )
      throw new RequestError("the provider did not return a picture", 502);
    const bytes = await readBytes(response.body, MAX_SOURCE_BYTES);
    return new Response(bytes, {
      headers: {
        "content-type": type,
        "x-content-type-options": "nosniff",
        ...NO_STORE,
      },
    });
  }

  function removeIdentity(
    principal: Principal,
    access: RequestAccess,
    body: Record<string, unknown>,
  ) {
    const user = account(principal);
    const provider = typeof body.provider === "string" ? body.provider : "";
    const subject = typeof body.subject === "string" ? body.subject : "";
    const identity = args.store
      .identitiesOf(user.id)
      .find(
        (entry) => entry.provider === provider && entry.subject === subject,
      );
    if (
      !identity ||
      (provider === "tailscale" && !tailnetVisible(principal, access))
    )
      throw new RequestError("no such sign-in method", 404);
    if (countsAsMethod(identity) && args.store.signInMethodCount(user.id) <= 1)
      throw new RequestError(
        "this is your last way to sign in; add another first",
        409,
      );
    args.store.unlinkIdentity(provider, subject, user.id, user.id);
    args.onChange();
    return json({ ok: true });
  }

  async function addEmail(
    principal: Principal,
    access: RequestAccess,
    body: Record<string, unknown>,
  ) {
    const user = account(principal);
    if (!args.mailer) throw new RequestError("email is not configured", 404);
    const email = normalizeEmail(body.email);
    if (!email) throw new RequestError("enter a valid email address");
    if (
      args.store
        .identitiesOf(user.id)
        .some(
          (entry) =>
            entry.provider === "email" &&
            entry.subject === email &&
            entry.emailVerified,
        )
    )
      throw new RequestError("this address is already a sign-in method", 409);
    const retry = sendLimiter.take(access.clientAddress ?? "unknown");
    if (retry) return rateLimitedResponse(retry);
    const issued = args.codes.issue({
      email,
      purpose: "verify",
      userId: user.id,
    });
    if (!issued)
      throw new RequestError(
        "a code was sent to this address a moment ago; wait a minute",
        429,
      );
    try {
      await args.mailer.send({
        to: email,
        ...verifyEmail({ code: issued.code }),
      });
    } catch (error) {
      args.codes.release(issued.id);
      logger.error("verification email failed", {
        error: (error as Error).message,
      });
      throw new RequestError("email delivery failed; try again later", 503);
    }
    return json({ flow: issued.id });
  }

  function confirmEmail(principal: Principal, body: Record<string, unknown>) {
    const user = account(principal);
    const result = args.codes.verify({
      id: typeof body.flow === "string" ? body.flow : "",
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    });
    if (!result.ok || result.purpose !== "verify" || result.userId !== user.id)
      throw new RequestError("that code is wrong or expired", 401);
    const owner = args.store.findIdentity("email", result.email);
    if (owner && owner.id !== user.id)
      throw new RequestError("this address belongs to another account", 409);
    args.store.linkIdentity({
      provider: "email",
      subject: result.email,
      userId: user.id,
      email: result.email,
      emailVerified: true,
      displayName: result.email,
      actor: user.id,
    });
    args.onChange();
    return json({ ok: true });
  }

  function revokeOthers(principal: Principal) {
    if (principal.kind !== "user") return json({ revoked: 0 });
    const ended = args.store.revokeOtherSessions(
      principal.user.id,
      principal.session.idHash,
      principal.user.id,
    );
    for (const hash of ended) args.onSessionEnded(hash);
    args.onChange();
    return json({ revoked: ended.length });
  }

  async function invite(
    principal: Principal,
    access: RequestAccess,
    url: URL,
    body: Record<string, unknown>,
  ) {
    if (!args.mailer) throw new RequestError("email is not configured", 404);
    const connectionId = url.searchParams.get("connection_id") ?? "";
    const workspaceId = url.searchParams.get("workspace_id") ?? "";
    if (!workspaceId || !args.connectionExists(connectionId))
      throw new RequestError("unknown workspace", 404);
    const email = normalizeEmail(body.email);
    if (!email) throw new RequestError("enter a valid email address");
    const role = body.role ?? "viewer";
    if (!isWorkspaceRole(role))
      throw new RequestError("role must be owner, editor or viewer");
    const origin = args.inviteOrigin(access);
    if (!origin) throw new RequestError("no address to invite to", 400);
    const retry = sendLimiter.take(access.clientAddress ?? "unknown");
    if (retry) return rateLimitedResponse(retry);
    const actor = principal.kind === "user" ? principal.user.id : "local";
    const known =
      args.store.findIdentity("email", email) ??
      (() => {
        const owners = args.store.usersWithVerifiedEmail(email);
        return owners.length === 1 ? args.store.getUser(owners[0]!) : null;
      })();
    if (known && principal.kind === "user" && known.id === principal.user.id)
      throw new RequestError("you cannot change your own access");
    const user =
      known ??
      args.store.db.transaction(() => {
        const created = args.store.createUser({
          name: args.store.uniqueName(email),
          displayName: email.split("@")[0] || email,
          role: "member",
          actor,
        });
        args.store.linkIdentity({
          provider: "email",
          subject: email,
          userId: created.id,
          email,
          displayName: email,
          actor,
        });
        return created;
      })();
    args.store.setGrant({
      connectionId,
      workspaceId,
      userId: user.id,
      role,
      actor,
    });
    // Accounts that can already sign in just get the grant.
    const invited = args.store.signInMethodCount(user.id) === 0;
    if (invited) {
      const token = args.invites.create({ userId: user.id, email, actor });
      const inviter =
        principal.kind === "user" ? principal.user.displayName : "The owner";
      try {
        await args.mailer.send({
          to: email,
          ...inviteEmail({
            inviter,
            link: `${origin}/invite#${token}`,
            days: INVITE_TTL_MS / 86_400_000,
          }),
        });
      } catch (error) {
        logger.error("invitation email failed", {
          error: (error as Error).message,
        });
        throw new RequestError(
          "the invitation email could not be sent; try again",
          503,
        );
      }
    }
    args.onChange();
    return json({
      user: { id: user.id, name: user.name, display_name: user.displayName },
      role,
      invited,
    });
  }

  return {
    async handle(
      route: HttpRouteId,
      req: Request,
      url: URL,
      access: RequestAccess,
      principal: Principal,
    ): Promise<Response | null> {
      try {
        switch (route) {
          case "auth.methods":
            return json(methods(principal, access));
          case "auth.profile": {
            const user = account(principal);
            const body = await readJson(req);
            const name = cleanText(
              typeof body.display_name === "string" ? body.display_name : "",
              80,
            );
            if (!name) throw new RequestError("display name required");
            args.store.setDisplayName(user.id, name, user.id);
            args.onProfileChanged(user.id, { name: true });
            return json({ ok: true, display_name: name });
          }
          case "auth.avatar": {
            const user = account(principal);
            const length = Number(req.headers.get("content-length") ?? 0);
            if (length > AVATAR_MAX_BYTES)
              throw new RequestError("image too large (128 KiB at most)", 413);
            return await setAvatarFrom(
              user,
              await readBytes(req.body, AVATAR_MAX_BYTES),
            );
          }
          case "auth.avatar.remove": {
            const user = account(principal);
            if (user.avatar) {
              args.store.setAvatar(user.id, null, user.id);
              if (!args.store.avatarInUse(user.avatar))
                args.avatars.remove(user.avatar);
              args.onProfileChanged(user.id, {});
            }
            return json({ ok: true });
          }
          case "auth.avatar.source":
            return await avatarSource(account(principal), url);
          case "avatar.file": {
            const name = url.pathname.slice("/avatars/".length);
            const bytes = args.avatars.read(name);
            if (!bytes) return new Response("not found", { status: 404 });
            return new Response(req.method === "HEAD" ? null : bytes, {
              headers: {
                "content-type": name.endsWith(".webp")
                  ? "image/webp"
                  : "image/jpeg",
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
              },
            });
          }
          case "auth.identities.remove":
            return removeIdentity(principal, access, await readJson(req));
          case "auth.email.add":
            return await addEmail(principal, access, await readJson(req));
          case "auth.email.confirm":
            return confirmEmail(principal, await readJson(req));
          case "auth.passkeys.rename": {
            const user = account(principal);
            const body = await readJson(req);
            if (
              typeof body.id !== "string" ||
              typeof body.name !== "string" ||
              !args.store.renamePasskey(body.id, user.id, body.name, user.id)
            )
              throw new RequestError("no such passkey", 404);
            args.onChange();
            return json({ ok: true });
          }
          case "auth.sessions.revoke_others":
            return revokeOthers(principal);
          case "invites.create":
            return await invite(principal, access, url, await readJson(req));
          default:
            return null;
        }
      } catch (error) {
        if (error instanceof RequestError)
          return json({ error: error.message }, error.status);
        logger.warn("account request failed", {
          route,
          error: (error as Error).message,
        });
        return json({ error: "request failed" }, 500);
      }
    },
  };
}
