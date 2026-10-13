import {
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import {
  AtSign,
  Ban,
  KeyRound,
  LogOut,
  Network,
  Trash2,
  UserCheck,
} from "lucide-react";
import type {
  AdminDisableRequest,
  AdminRoleRequest,
  AdminUser,
  AdminUserRequest,
  InstanceRole,
} from "../../../shared/admin";
import { PROVIDER_NAMES, request, since } from "../accountRequests";
import { msg, t } from "../i18n";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import type { MenuEntry } from "./ui/Menu";
import { Token } from "./ui/Token";

// Pieces the admin page's overview and user detail share: in-page
// navigation, account tokens, and the account actions menu.

export const ROLES: InstanceRole[] = ["member", "admin"];
export const ROLE_LABELS: Record<InstanceRole, string> = {
  admin: msg("Admin"),
  member: msg("Member"),
};
const PROVIDER_ICONS: Record<string, ReactNode> = {
  email: <AtSign size={12} />,
  passkey: <KeyRound size={12} />,
  tailscale: <Network size={12} />,
};

const pathListeners = new Set<() => void>();

/** Go to another `/admin` path, as a history entry. */
export function navigate(to: string) {
  window.history.pushState(null, "", to);
  for (const listener of pathListeners) listener();
}

/** The current path, following `navigate` and back/forward. */
export function useAdminPath(): string {
  return useSyncExternalStore(
    (listener) => {
      pathListeners.add(listener);
      window.addEventListener("popstate", listener);
      return () => {
        pathListeners.delete(listener);
        window.removeEventListener("popstate", listener);
      };
    },
    () => window.location.pathname,
  );
}

/** A link within the admin page; modified clicks keep their default. */
export function AdminLink({
  href,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(href);
      }}
      {...props}
    />
  );
}

export function providerName(provider: string): string {
  if (provider === "email") return t("Email");
  if (provider === "passkey") return t("Passkey");
  return PROVIDER_NAMES[provider] ?? provider;
}

/** A sign-in provider as one token: its icon where it has one, else its name. */
export function ProviderToken({
  provider,
  tooltip,
}: {
  provider: string;
  tooltip?: string;
}) {
  const name = providerName(provider);
  const icon = PROVIDER_ICONS[provider];
  return (
    <Token
      icon={icon}
      role={icon ? "img" : undefined}
      aria-label={icon ? name : undefined}
      data-tooltip={tooltip ?? (icon ? name : undefined)}
    >
      {icon ? null : name}
    </Token>
  );
}

/** You, the role, and why the account cannot sign in, if it cannot. */
export function UserTokens({ user }: { user: AdminUser }) {
  return (
    <>
      {user.self ? <Token>{t("You")}</Token> : null}
      <Token tone={user.role === "admin" ? "accent" : "neutral"}>
        {t(ROLE_LABELS[user.role])}
      </Token>
      {user.disabled ? (
        <Token tone="danger">{t("Disabled")}</Token>
      ) : user.pending ? (
        <Token tone="warning">
          {user.invited ? t("Invited") : t("No sign-in method")}
        </Token>
      ) : null}
    </>
  );
}

export function lastSeen(user: AdminUser): string {
  if (user.lastSeenAt === null && user.sessions === 0)
    return user.pending ? t("Never signed in") : t("No recent activity");
  const seen = user.lastSeenAt
    ? t("Seen {time}", { time: since(user.lastSeenAt) })
    : t("No recent activity");
  if (user.sessions === 0) return seen;
  return `${seen} · ${
    user.sessions === 1
      ? t("1 session")
      : t("{count} sessions", { count: user.sessions })
  }`;
}

export function ErrorLine({ error }: { error?: string }) {
  return error ? (
    <p className="admin-error" role="alert">
      {error}
    </p>
  ) : null;
}

/**
 * Role, disable, sign-out and remove for an account: `menu` builds its
 * items, `dialog` confirms removal. `reload` runs after each change and
 * `onRemoved` after a removal.
 */
export function useUserActions(
  reload: () => Promise<unknown>,
  onRemoved?: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<AdminUser | null>(null);
  const run = async (path: string, body: Record<string, unknown>) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await request(`/api/admin/users/${path}`, body);
      await reload();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const menu = (user: AdminUser): MenuEntry[] => [
    {
      title: t("Role"),
      selectionMode: "single",
      items: ROLES.map((role) => ({
        id: `role-${role}`,
        label: t(ROLE_LABELS[role]),
        checked: user.role === role,
        onAction: () => {
          if (role !== user.role)
            void run("role", {
              user: user.id,
              role,
            } satisfies AdminRoleRequest);
        },
      })),
    },
    {
      items: [
        {
          id: "disable",
          label: user.disabled ? t("Enable account") : t("Disable account"),
          icon: user.disabled ? <UserCheck size={14} /> : <Ban size={14} />,
          onAction: () =>
            void run("disable", {
              user: user.id,
              disabled: !user.disabled,
            } satisfies AdminDisableRequest),
        },
        {
          id: "revoke",
          label: t("Sign out everywhere"),
          icon: <LogOut size={14} />,
          disabled: user.sessions === 0,
          onAction: () =>
            void run("revoke-sessions", {
              user: user.id,
            } satisfies AdminUserRequest),
        },
      ],
    },
    {
      danger: true,
      items: [
        {
          id: "remove",
          label: t("Remove account"),
          icon: <Trash2 size={14} />,
          onAction: () => setRemoving(user),
        },
      ],
    },
  ];
  const dialog = (
    <ConfirmDialog
      open={removing !== null}
      onOpenChange={(open) => {
        if (!open) setRemoving(null);
      }}
      title={t("Remove {name}?", {
        name: removing?.displayName || removing?.name || "",
      })}
      message={t(
        "The account, its sign-in methods and sessions are deleted. This cannot be undone.",
      )}
      confirmLabel={t("Remove account")}
      tone="danger"
      onConfirm={async () => {
        if (
          removing &&
          (await run("remove", {
            user: removing.id,
          } satisfies AdminUserRequest))
        )
          onRemoved?.();
      }}
    />
  );
  return { busy, error, menu, dialog };
}
