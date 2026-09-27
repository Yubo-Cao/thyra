import { randomBytes } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AccountStore, User } from "../accounts/store";

/**
 * Passkey (WebAuthn) registration and login. Credentials are discoverable
 * (resident), so login needs no user name. The relying party is the host
 * the browser uses (from the request-access policy, so a trusted proxy's
 * public host counts); a passkey works only on the host it was created on.
 * Challenges are single-use, held in memory for five minutes.
 */

const FLOW_TTL_MS = 5 * 60_000;
const MAX_FLOWS = 1000;
const TRANSPORTS = new Set<string>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export type PasskeyOrigin = { origin: string; rpId: string };

/**
 * The WebAuthn origin and RP ID for a request, or null when the page is not a
 * secure context (WebAuthn needs HTTPS, or `localhost`).
 */
export function passkeyOrigin(ownOrigin: string | null): PasskeyOrigin | null {
  if (!ownOrigin) return null;
  let url: URL;
  try {
    url = new URL(ownOrigin);
  } catch {
    return null;
  }
  const localhost =
    url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !localhost) return null;
  // WebAuthn RP IDs are domains; IP-literal origins cannot hold passkeys.
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("["))
    return null;
  return { origin: url.origin, rpId: url.hostname };
}

type Flow = {
  kind: "login" | "register";
  challenge: string;
  origin: PasskeyOrigin;
  userId?: string;
  enrollmentSecret?: string;
  expiresAt: number;
};

export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type PasskeyService = ReturnType<typeof createPasskeyService>;

export function createPasskeyService(args: {
  store: AccountStore;
  rpName?: string;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const flows = new Map<string, Flow>();

  function prune() {
    const at = now();
    for (const [id, flow] of flows) if (flow.expiresAt <= at) flows.delete(id);
    while (flows.size > MAX_FLOWS) {
      const oldest = flows.keys().next().value;
      if (oldest === undefined) break;
      flows.delete(oldest);
    }
  }

  function startFlow(flow: Omit<Flow, "expiresAt">): string {
    prune();
    const id = randomBytes(18).toString("base64url");
    flows.set(id, { ...flow, expiresAt: now() + FLOW_TTL_MS });
    return id;
  }

  function takeFlow(
    id: unknown,
    kind: Flow["kind"],
    origin: PasskeyOrigin,
  ): Flow {
    if (typeof id !== "string") throw new PasskeyError("flow required");
    const flow = flows.get(id);
    flows.delete(id);
    if (
      !flow ||
      flow.kind !== kind ||
      flow.expiresAt <= now() ||
      flow.origin.origin !== origin.origin
    )
      throw new PasskeyError("this passkey request expired; try again");
    return flow;
  }

  function transports(value: unknown): AuthenticatorTransportFuture[] {
    return Array.isArray(value)
      ? (value.filter(
          (item) => typeof item === "string" && TRANSPORTS.has(item),
        ) as AuthenticatorTransportFuture[])
      : [];
  }

  return {
    async loginOptions(origin: PasskeyOrigin) {
      const options = await generateAuthenticationOptions({
        rpID: origin.rpId,
        userVerification: "preferred",
      });
      const flow = startFlow({
        kind: "login",
        challenge: options.challenge,
        origin,
      });
      return { flow, options };
    },

    /** Verify a login assertion; returns the account on success. */
    async loginVerify(
      origin: PasskeyOrigin,
      body: { flow?: unknown; response?: unknown },
    ): Promise<User> {
      const flow = takeFlow(body.flow, "login", origin);
      const response = body.response as AuthenticationResponseJSON | undefined;
      if (!response || typeof response.id !== "string")
        throw new PasskeyError("passkey response required");
      const passkey = args.store.getPasskey(response.id);
      if (!passkey || passkey.rpId !== origin.rpId)
        throw new PasskeyError("this passkey is not registered here", 401);
      const user = args.store.getUser(passkey.userId);
      if (!user || user.disabled)
        throw new PasskeyError("this account is disabled", 403);
      const userHandle = response.response?.userHandle;
      if (
        userHandle &&
        Buffer.from(userHandle, "base64url").toString("utf8") !== user.id
      )
        throw new PasskeyError("passkey does not match its account", 401);
      let verification: Awaited<
        ReturnType<typeof verifyAuthenticationResponse>
      >;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: flow.challenge,
          expectedOrigin: origin.origin,
          expectedRPID: origin.rpId,
          credential: {
            id: passkey.credentialId,
            publicKey: passkey.publicKey,
            counter: passkey.counter,
            transports: transports(passkey.transports),
          },
          requireUserVerification: false,
        });
      } catch (error) {
        throw new PasskeyError(
          `passkey verification failed: ${(error as Error).message}`,
          401,
        );
      }
      if (!verification.verified)
        throw new PasskeyError("passkey verification failed", 401);
      args.store.usePasskey(
        passkey.credentialId,
        verification.authenticationInfo.newCounter,
      );
      return user;
    },

    /**
     * Registration for `user`: a logged-in account adding a passkey, or the
     * holder of an enrollment secret (consumed when registration succeeds).
     */
    async registrationOptions(
      origin: PasskeyOrigin,
      user: User,
      enrollmentSecret?: string,
    ) {
      const existing = args.store
        .passkeysOf(user.id)
        .filter((passkey) => passkey.rpId === origin.rpId);
      const options = await generateRegistrationOptions({
        rpName: args.rpName ?? "Thyra",
        rpID: origin.rpId,
        userName: user.name,
        userID: new TextEncoder().encode(user.id),
        userDisplayName: user.displayName,
        attestationType: "none",
        excludeCredentials: existing.map((passkey) => ({
          id: passkey.credentialId,
          transports: transports(passkey.transports),
        })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "preferred",
        },
      });
      const flow = startFlow({
        kind: "register",
        challenge: options.challenge,
        origin,
        userId: user.id,
        enrollmentSecret,
      });
      return { flow, options };
    },

    /** Verify and store a new passkey; returns its account. */
    async registrationVerify(
      origin: PasskeyOrigin,
      body: { flow?: unknown; response?: unknown; name?: unknown },
    ): Promise<User> {
      const flow = takeFlow(body.flow, "register", origin);
      const user = flow.userId ? args.store.getUser(flow.userId) : null;
      if (!user || user.disabled)
        throw new PasskeyError("this account is disabled", 403);
      const response = body.response as RegistrationResponseJSON | undefined;
      if (!response || typeof response.id !== "string")
        throw new PasskeyError("passkey response required");
      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: flow.challenge,
          expectedOrigin: origin.origin,
          expectedRPID: origin.rpId,
          requireUserVerification: false,
        });
      } catch (error) {
        throw new PasskeyError(
          `passkey registration failed: ${(error as Error).message}`,
        );
      }
      if (!verification.verified)
        throw new PasskeyError("passkey registration failed");
      if (
        flow.enrollmentSecret &&
        !args.store.consumeEnrollment(flow.enrollmentSecret)
      )
        throw new PasskeyError("this enrollment link was already used", 410);
      const credential = verification.registrationInfo.credential;
      if (args.store.getPasskey(credential.id))
        throw new PasskeyError("this passkey is already registered", 409);
      args.store.addPasskey({
        credentialId: credential.id,
        userId: user.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: transports(
          credential.transports ?? response.response?.transports,
        ),
        rpId: origin.rpId,
        name:
          typeof body.name === "string" && body.name.trim() ? body.name : null,
      });
      return user;
    },
  };
}
