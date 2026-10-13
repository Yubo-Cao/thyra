/**
 * Wire types for the instance admin API (`/api/admin/*`).
 *
 * Every route requires an instance admin and answers 403 otherwise. Mutating
 * routes are `POST` with a JSON body and answer `{ error: string }` with a
 * 4xx status when the request is refused.
 */

export type InstanceRole = "admin" | "member";

export type SignupPolicy = "invite" | "open";

export interface AdminIdentity {
  /** `email`, `google`, `github`, `microsoft`, `tailscale`, `passkey`, ... */
  provider: string;
  /** What the user would recognise: an address, a login or a passkey name. */
  label: string;
}

export interface AdminUser {
  id: string;
  name: string;
  displayName: string | null;
  emails: string[];
  role: InstanceRole;
  disabled: boolean;
  /** No way to sign in yet (invited, or made by `thyra user add`). */
  pending: boolean;
  /** An unexpired invitation signs in to this account. */
  invited: boolean;
  identities: AdminIdentity[];
  /** Live sessions. */
  sessions: number;
  /** Epoch ms of the latest session activity, or null. */
  lastSeenAt: number | null;
  createdAt: number;
  /** The requesting admin's own account. */
  self: boolean;
}

/** `GET /api/admin/users` */
export interface AdminUsersResponse {
  users: AdminUser[];
}

/** One way an account signs in, as the user detail lists it. */
export interface AdminSignInMethod {
  /** `identity` (email, OAuth, Tailscale) or `passkey`. */
  kind: "identity" | "passkey";
  /** Names it for removal: `<provider>:<subject>`, or the credential id. */
  id: string;
  /** `email`, `google`, `github`, `microsoft`, `oidc`, `tailscale` or `passkey`. */
  provider: string;
  /** An address, a login, a provider account or a passkey name. */
  label: string;
  /**
   * The address was confirmed (by a code, the provider or an admin). An
   * unverified one, such as an invitation's, is not a way in yet.
   */
  verified: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * `GET /api/admin/users/detail?user=<id>`, and the answer of every route
 * that changes an account's sign-in methods.
 */
export interface AdminUserDetail extends AdminUser {
  methods: AdminSignInMethod[];
}

/**
 * `POST /api/admin/users/emails`: link addresses the admin vouches for as
 * verified, all or none. An address another account has is refused (409),
 * so is an invalid one (400); one this account already has is skipped.
 */
export interface AdminEmailsRequest {
  user: string;
  emails: string[];
}

/** `POST /api/admin/users/tailscale`: link a Tailscale login (409 when taken). */
export interface AdminTailscaleRequest {
  user: string;
  login: string;
}

/**
 * `POST /api/admin/users/methods/remove`. Removing an account's last way to
 * sign in needs `allowLast` (409 otherwise); an admin can never remove
 * their own last one. Signed-in sessions stay.
 */
export interface AdminRemoveMethodRequest {
  user: string;
  method: Pick<AdminSignInMethod, "kind" | "id">;
  allowLast?: boolean;
}

/** `POST /api/admin/users/role` */
export interface AdminRoleRequest {
  user: string;
  role: InstanceRole;
}

/** `POST /api/admin/users/disable` */
export interface AdminDisableRequest {
  user: string;
  disabled: boolean;
}

/** `POST /api/admin/users/remove` and `POST /api/admin/users/revoke-sessions` */
export interface AdminUserRequest {
  user: string;
}

export interface AdminInvite {
  id: string;
  email: string;
  /** The account the invite signs in to. */
  userId: string;
  role: InstanceRole;
  /** Display name of the inviter, or null when unknown. */
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
}

/** `GET /api/admin/invites` */
export interface AdminInvitesResponse {
  invites: AdminInvite[];
  /** Whether the server can send invitation email. */
  emailAvailable: boolean;
}

/** `POST /api/admin/invites` */
export interface AdminInviteRequest {
  email: string;
  role: InstanceRole;
}

/** `POST /api/admin/invites/revoke` and `POST /api/admin/invites/resend` */
export interface AdminInviteIdRequest {
  id: string;
}

/**
 * Answer to creating or resending an invite. A resend replaces the token, so
 * older links stop working. `link` is always present so an admin can copy it
 * when email is unavailable or did not arrive.
 */
export interface AdminInviteResponse {
  invite: AdminInvite;
  link: string;
  emailed: boolean;
}

/** `GET /api/admin/signup`, and the body and answer of `POST /api/admin/signup`. */
export interface AdminSignupSettings {
  policy: SignupPolicy;
  /** Lower-case email domains whose verified addresses may sign up. */
  domains: string[];
}
