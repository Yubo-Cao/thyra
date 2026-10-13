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
  /** True until the account first signs in (it was created by an invite). */
  pending: boolean;
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
