import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AtSign,
  Ban,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Network,
  RefreshCw,
  Send,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";
import type {
  AdminDisableRequest,
  AdminIdentity,
  AdminInviteIdRequest,
  AdminInviteRequest,
  AdminInviteResponse,
  AdminInvitesResponse,
  AdminRoleRequest,
  AdminSignupSettings,
  AdminUser,
  AdminUserRequest,
  AdminUsersResponse,
  InstanceRole,
} from "../../../shared/admin";
import { msg, t } from "../i18n";
import { relativeExpiry } from "../shareLinks";
import { addDomains, sameDomains } from "../signupDomains";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { PROVIDER_NAMES, request, since } from "./AccountSettings";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { IconButton } from "./ui/IconButton";
import { Menu, type MenuEntry } from "./ui/Menu";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import { TextField } from "./ui/TextField";
import { Token } from "./ui/Token";
import "./AccountSettings.css";
import "./AdminSettings.css";

const ROLES: InstanceRole[] = ["member", "admin"];
const ROLE_LABELS: Record<InstanceRole, string> = {
  admin: msg("Admin"),
  member: msg("Member"),
};
const IDENTITY_ICONS: Record<string, ReactNode> = {
  email: <AtSign size={12} />,
  passkey: <KeyRound size={12} />,
  tailscale: <Network size={12} />,
};

type Section = "users" | "invites" | "signup";

/**
 * The Administration tab (instance admins only): accounts and their roles,
 * invitations, and who may sign up. The bridge enforces every rule; errors
 * it returns show beside the section that caused them.
 */
export function AdminSettings() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [invites, setInvites] = useState<AdminInvitesResponse | null>(null);
  const [signup, setSignup] = useState<AdminSignupSettings | null>(null);
  const [draft, setDraft] = useState<AdminSignupSettings | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Section, string>>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AdminUser | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InstanceRole>("member");
  const [issued, setIssued] = useState<AdminInviteResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [domainError, setDomainError] = useState("");

  const fail = (section: Section, failure: unknown) =>
    setErrors((current) => ({
      ...current,
      [section]: failure instanceof Error ? failure.message : String(failure),
    }));
  const loadUsers = useCallback(
    () =>
      request<AdminUsersResponse>("/api/admin/users").then((response) =>
        setUsers(response.users),
      ),
    [],
  );
  const loadInvites = useCallback(
    () => request<AdminInvitesResponse>("/api/admin/invites").then(setInvites),
    [],
  );
  useEffect(() => {
    loadUsers().catch((failure) => fail("users", failure));
    loadInvites().catch((failure) => fail("invites", failure));
    request<AdminSignupSettings>("/api/admin/signup").then(
      (settings) => {
        setSignup(settings);
        setDraft(settings);
      },
      (failure) => fail("signup", failure),
    );
  }, [loadUsers, loadInvites]);

  const act = async (section: Section, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setErrors((current) => ({ ...current, [section]: "" }));
    try {
      await action();
    } catch (failure) {
      fail(section, failure);
    } finally {
      setBusy(false);
    }
  };
  const userAction = (path: string, body: Record<string, unknown>) =>
    act("users", async () => {
      await request(`/api/admin/users/${path}`, body);
      await loadUsers();
    });
  const issue = (response: AdminInviteResponse) => {
    setIssued(response);
    setCopied(false);
    return Promise.all([loadInvites(), loadUsers()]);
  };
  const invite = () =>
    act("invites", async () => {
      await issue(
        await request<AdminInviteResponse>("/api/admin/invites", {
          email: inviteEmail.trim(),
          role: inviteRole,
        } satisfies AdminInviteRequest),
      );
      setInviteEmail("");
    });
  const inviteAction = (path: "resend" | "revoke", id: string) =>
    act("invites", async () => {
      const body = { id } satisfies AdminInviteIdRequest;
      if (path === "resend")
        await issue(
          await request<AdminInviteResponse>("/api/admin/invites/resend", body),
        );
      else {
        await request("/api/admin/invites/revoke", body);
        if (issued?.invite.id === id) setIssued(null);
        await Promise.all([loadInvites(), loadUsers()]);
      }
    });
  const addDomainInput = () => {
    if (!draft) return null;
    const next = addDomains(draft.domains, domainInput);
    if (next.invalid.length) {
      setDomainError(
        t("Not a domain: {entries}", { entries: next.invalid.join(", ") }),
      );
      setDomainInput(next.invalid.join(" "));
    } else setDomainInput("");
    setDraft({ ...draft, domains: next.domains });
    return next.invalid.length ? null : next.domains;
  };
  const save = () => {
    const domains = addDomainInput();
    if (!draft || !domains) return;
    void act("signup", async () => {
      const saved = await request<AdminSignupSettings>("/api/admin/signup", {
        policy: draft.policy,
        domains,
      } satisfies AdminSignupSettings);
      setSignup(saved);
      setDraft(saved);
    });
  };
  const dirty =
    !!draft &&
    !!signup &&
    (draft.policy !== signup.policy ||
      !sameDomains(draft.domains, signup.domains) ||
      !!domainInput.trim());

  const userMenu = (user: AdminUser): MenuEntry[] => [
    {
      title: t("Role"),
      selectionMode: "single",
      items: ROLES.map((role) => ({
        id: `role-${role}`,
        label: t(ROLE_LABELS[role]),
        checked: user.role === role,
        onAction: () => {
          if (role !== user.role)
            void userAction("role", {
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
            void userAction("disable", {
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
            void userAction("revoke-sessions", {
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

  return (
    <div className="account-settings admin-settings">
      <div className="config-title">{t("Users")}</div>
      {users === null && !errors.users ? (
        <p className="account-note">{t("Loading...")}</p>
      ) : null}
      {users?.map((user) => {
        const name = user.displayName || user.name;
        return (
          <div className="admin-row" key={user.id}>
            <div className="config-item-copy">
              <strong>{name}</strong>
              <span>
                {[name === user.name ? null : user.name, ...user.emails]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <div className="admin-row-tokens">
                {user.self ? <Token>{t("You")}</Token> : null}
                <Token tone={user.role === "admin" ? "accent" : "neutral"}>
                  {t(ROLE_LABELS[user.role])}
                </Token>
                {user.disabled ? (
                  <Token tone="danger">{t("Disabled")}</Token>
                ) : user.pending ? (
                  <Token tone="warning">{t("Invited")}</Token>
                ) : null}
                <IdentityTokens identities={user.identities} />
                <span className="admin-row-meta">{lastSeen(user)}</span>
              </div>
            </div>
            {user.self ? null : (
              <Menu
                trigger={
                  <IconButton
                    label={t("Manage {name}", { name })}
                    icon={<MoreHorizontal size={15} />}
                    disabled={busy}
                  />
                }
                items={userMenu(user)}
                aria-label={t("Manage {name}", { name })}
                placement="bottom end"
              />
            )}
          </div>
        );
      })}
      <ErrorLine error={errors.users} />

      <div className="config-title">{t("Invitations")}</div>
      {invites && !invites.emailAvailable ? (
        <p className="account-note">
          {t(
            "This server cannot send email: copy each invitation link and share it yourself.",
          )}
        </p>
      ) : null}
      <form
        className="admin-invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          void invite();
        }}
      >
        <TextField
          label={t("Email address")}
          type="email"
          value={inviteEmail}
          onValueChange={setInviteEmail}
          autoComplete="off"
          placeholder="name@example.com"
          fullWidth
        />
        <Select
          aria-label={t("Role")}
          value={inviteRole}
          options={ROLES.map((role) => ({
            value: role,
            label: t(ROLE_LABELS[role]),
          }))}
          onChange={setInviteRole}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !inviteEmail.includes("@")}
        >
          {t("Invite")}
        </Button>
      </form>
      {issued ? (
        <div className="account-inline-form">
          <TextField
            label={
              issued.emailed
                ? t("Emailed to {email}; you can also share this link", {
                    email: issued.invite.email,
                  })
                : t("Not emailed: share this link with {email}", {
                    email: issued.invite.email,
                  })
            }
            value={issued.link}
            readOnly
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            fullWidth
          />
          <Button
            variant="primary"
            onClick={() =>
              void copyTextFromUserGesture(issued.link).then(
                () => setCopied(true),
                () =>
                  fail(
                    "invites",
                    t("Could not copy. Select the link and copy it."),
                  ),
              )
            }
          >
            {copied ? t("Copied") : t("Copy")}
          </Button>
        </div>
      ) : null}
      <ErrorLine error={errors.invites} />
      {invites?.invites.map((item) => (
        <div className="admin-row" key={item.id}>
          <div className="config-item-copy">
            <strong>{item.email}</strong>
            <span>
              {[
                t(ROLE_LABELS[item.role]),
                item.createdBy
                  ? t("Invited by {name}", { name: item.createdBy })
                  : null,
                item.expiresAt <= Date.now()
                  ? t("Expired")
                  : t("Expires {when}", {
                      when: relativeExpiry(item.expiresAt),
                    }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <div className="admin-row-actions">
            <IconButton
              label={
                invites.emailAvailable
                  ? t("Send again with a new link")
                  : t("Make a new link")
              }
              icon={
                invites.emailAvailable ? (
                  <Send size={15} />
                ) : (
                  <RefreshCw size={15} />
                )
              }
              disabled={busy}
              onClick={() => void inviteAction("resend", item.id)}
            />
            <IconButton
              label={t("Revoke invitation")}
              tone="danger"
              icon={<X size={15} />}
              disabled={busy}
              onClick={() => void inviteAction("revoke", item.id)}
            />
          </div>
        </div>
      ))}
      {invites?.invites.length === 0 ? (
        <p className="account-note">{t("No pending invitations.")}</p>
      ) : null}

      <div className="config-title">{t("Sign-up")}</div>
      {draft ? (
        <>
          <div className="admin-row">
            <div className="config-item-copy">
              <strong>{t("Who can sign up")}</strong>
              <span>
                {draft.policy === "open"
                  ? t("Anyone who can reach this server can create an account.")
                  : t("Only invited people, and the domains below.")}
              </span>
            </div>
            <SegmentedControl
              aria-label={t("Who can sign up")}
              value={draft.policy}
              options={[
                { value: "invite", label: t("Invite only") },
                { value: "open", label: t("Open sign-up") },
              ]}
              onChange={(policy) => setDraft({ ...draft, policy })}
            />
          </div>
          <p className="account-note">
            {t(
              "Verified addresses in these domains can sign up even when sign-up is invite-only.",
            )}
          </p>
          {draft.domains.length ? (
            <div className="admin-domains">
              {draft.domains.map((domain) => (
                <Token
                  as="button"
                  key={domain}
                  aria-label={t("Remove {domain}", { domain })}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      domains: draft.domains.filter((item) => item !== domain),
                    })
                  }
                >
                  {domain}
                  <X size={12} />
                </Token>
              ))}
            </div>
          ) : null}
          <form
            className="account-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              addDomainInput();
            }}
          >
            <TextField
              label={t("Add domains")}
              value={domainInput}
              onValueChange={(value) => {
                setDomainInput(value);
                setDomainError("");
              }}
              error={domainError || undefined}
              placeholder="example.com"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              fullWidth
            />
            <Button type="submit" disabled={!domainInput.trim()}>
              {t("Add")}
            </Button>
          </form>
          <div className="admin-save-row">
            <Button variant="primary" disabled={busy || !dirty} onClick={save}>
              {t("Save")}
            </Button>
          </div>
        </>
      ) : null}
      <ErrorLine error={errors.signup} />

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
        onConfirm={() =>
          removing
            ? userAction("remove", {
                user: removing.id,
              } satisfies AdminUserRequest)
            : undefined
        }
      />
    </div>
  );
}

function lastSeen(user: AdminUser): string {
  if (user.pending) return t("Never signed in");
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

/** One token per sign-in provider; the accounts show in its tooltip. */
function IdentityTokens({ identities }: { identities: AdminIdentity[] }) {
  const labels = new Map<string, string[]>();
  for (const identity of identities)
    labels.set(identity.provider, [
      ...(labels.get(identity.provider) ?? []),
      identity.label,
    ]);
  return [...labels].map(([provider, accounts]) => {
    const name =
      provider === "email"
        ? t("Email")
        : provider === "passkey"
          ? t("Passkey")
          : (PROVIDER_NAMES[provider] ?? provider);
    const icon = IDENTITY_ICONS[provider];
    return (
      <Token
        key={provider}
        icon={icon}
        role={icon ? "img" : undefined}
        aria-label={icon ? name : undefined}
        data-tooltip={t("{provider}: {accounts}", {
          provider: name,
          accounts: accounts.join(", "),
        })}
      >
        {icon ? null : name}
      </Token>
    );
  });
}

function ErrorLine({ error }: { error?: string }) {
  return error ? (
    <p className="account-error" role="alert">
      {error}
    </p>
  ) : null;
}
