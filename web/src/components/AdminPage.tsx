import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ChevronLeft, MoreHorizontal, RefreshCw, Send, X } from "lucide-react";
import type {
  AdminInviteIdRequest,
  AdminInviteRequest,
  AdminInviteResponse,
  AdminInvitesResponse,
  AdminSignupSettings,
  AdminUser,
  AdminUsersResponse,
  InstanceRole,
} from "../../../shared/admin";
import { request } from "../accountRequests";
import {
  normalizeAccentColor,
  normalizeThemePreference,
  resolveSystemTheme,
  SYSTEM_THEME_QUERY,
} from "../appearance";
import { thyraLocalStorage } from "../browserStorage";
import { t } from "../i18n";
import { relativeExpiry } from "../shareLinks";
import { addDomains, sameDomains } from "../signupDomains";
import { copyTextFromUserGesture } from "../terminalClipboard";
import {
  AdminLink,
  ErrorLine,
  lastSeen,
  providerName,
  ProviderToken,
  ROLE_LABELS,
  ROLES,
  UserTokens,
  useAdminPath,
  useUserActions,
} from "./adminParts";
import { AdminUserView } from "./AdminUserView";
import { GlobalTooltip } from "./GlobalTooltip";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Menu } from "./ui/Menu";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import { TextField } from "./ui/TextField";
import { Token } from "./ui/Token";
import "./AdminPage.css";

type Section = "invites" | "signup";

/**
 * The instance admin page (`/admin`, admins only): accounts, invitations
 * and who may sign up; `/admin/users/<id>` shows one account and its
 * sign-in methods. The bridge enforces every rule; errors it returns show
 * beside the section that caused them.
 */
export function AdminPage() {
  const path = useAdminPath();
  const userId = /^\/admin\/users\/([^/]+)\/?$/.exec(path)?.[1];
  useLayoutEffect(() => {
    document.title = `${t("Administration")} · Thyra`;
    // The workspace's theme and accent (it applies them in useAppearance).
    const root = document.documentElement;
    const theme = normalizeThemePreference(thyraLocalStorage.getItem("theme"));
    root.dataset.theme =
      theme === "light" || theme === "dark"
        ? theme
        : resolveSystemTheme(window.matchMedia(SYSTEM_THEME_QUERY));
    root.style.colorScheme = root.dataset.theme;
    root.dataset.accent = normalizeAccentColor(
      thyraLocalStorage.getItem("accentColor"),
    );
  }, []);
  useEffect(() => {
    document.querySelector(".admin-page")?.scrollTo(0, 0);
  }, [path]);
  return (
    <div className="admin-page">
      <header className="ui-bar admin-bar">
        <a className="button button--sm button--ghost" href="/">
          <ChevronLeft size={14} />
          {t("Workspace")}
        </a>
        <span className="ui-bar-title">
          {userId ? (
            <AdminLink href="/admin">{t("Administration")}</AdminLink>
          ) : (
            t("Administration")
          )}
        </span>
      </header>
      <main className="admin-main">
        {userId ? (
          <AdminUserView key={userId} id={decodeURIComponent(userId)} />
        ) : (
          <Overview />
        )}
      </main>
      <GlobalTooltip />
    </div>
  );
}

function Overview() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [usersError, setUsersError] = useState("");
  const [invites, setInvites] = useState<AdminInvitesResponse | null>(null);
  const [signup, setSignup] = useState<AdminSignupSettings | null>(null);
  const [draft, setDraft] = useState<AdminSignupSettings | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Section, string>>>({});
  const [busy, setBusy] = useState(false);
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
  const actions = useUserActions(loadUsers);
  useEffect(() => {
    loadUsers().catch((failure: Error) => setUsersError(failure.message));
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

  return (
    <>
      <section className="admin-section admin-section-wide">
        <h2 className="admin-heading">{t("Users")}</h2>
        {users === null && !usersError ? (
          <p className="admin-note">{t("Loading...")}</p>
        ) : null}
        {users?.length ? (
          <table className="admin-users">
            <thead>
              <tr>
                <th>{t("User")}</th>
                <th>{t("Status")}</th>
                <th>{t("Sign-in methods")}</th>
                <th>{t("Activity")}</th>
                <th aria-label={t("Actions")} />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  actions={actions}
                  disabled={actions.busy}
                />
              ))}
            </tbody>
          </table>
        ) : null}
        <ErrorLine error={usersError || actions.error} />
        {actions.dialog}
      </section>

      <section className="admin-section">
        <h2 className="admin-heading">{t("Invitations")}</h2>
        {invites && !invites.emailAvailable ? (
          <p className="admin-note">
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
          <div className="admin-inline-form">
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
            <div className="admin-copy">
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
          <p className="admin-note">{t("No pending invitations.")}</p>
        ) : null}
      </section>

      <section className="admin-section">
        <h2 className="admin-heading">{t("Sign-up")}</h2>
        {draft ? (
          <>
            <div className="admin-row admin-policy">
              <div className="admin-copy">
                <strong>{t("Who can sign up")}</strong>
                <span>
                  {draft.policy === "open"
                    ? t(
                        "Anyone who can reach this server can create an account.",
                      )
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
            <p className="admin-note">
              {t(
                "Verified addresses in these domains can sign up even when sign-up is invite-only.",
              )}
            </p>
            {draft.domains.length ? (
              <div className="admin-tokens">
                {draft.domains.map((domain) => (
                  <Token
                    as="button"
                    key={domain}
                    aria-label={t("Remove {domain}", { domain })}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        domains: draft.domains.filter(
                          (item) => item !== domain,
                        ),
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
              className="admin-inline-form"
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
              <Button
                variant="primary"
                disabled={busy || !dirty}
                onClick={save}
              >
                {t("Save")}
              </Button>
            </div>
          </>
        ) : null}
        <ErrorLine error={errors.signup} />
      </section>
    </>
  );
}

/** One account: name and addresses, status, sign-in methods, activity. */
function UserRow({
  user,
  actions,
  disabled,
}: {
  user: AdminUser;
  actions: ReturnType<typeof useUserActions>;
  disabled: boolean;
}) {
  const name = user.displayName || user.name;
  const providers = new Map<string, string[]>();
  for (const identity of user.identities)
    providers.set(identity.provider, [
      ...(providers.get(identity.provider) ?? []),
      identity.label,
    ]);
  return (
    <tr>
      <td className="admin-user-cell">
        <div className="admin-copy">
          <AdminLink href={`/admin/users/${encodeURIComponent(user.id)}`}>
            <strong>{name}</strong>
          </AdminLink>
          <span>
            {[name === user.name ? null : user.name, ...user.emails]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </td>
      <td>
        <div className="admin-tokens">
          <UserTokens user={user} />
        </div>
      </td>
      <td>
        <div className="admin-tokens">
          {[...providers].map(([provider, accounts]) => (
            <ProviderToken
              key={provider}
              provider={provider}
              tooltip={t("{provider}: {accounts}", {
                provider: providerName(provider),
                accounts: accounts.join(", "),
              })}
            />
          ))}
        </div>
      </td>
      <td className="admin-meta">{lastSeen(user)}</td>
      <td className="admin-actions-cell">
        {user.self ? null : (
          <Menu
            trigger={
              <IconButton
                label={t("Manage {name}", { name })}
                icon={<MoreHorizontal size={15} />}
                disabled={disabled}
              />
            }
            items={actions.menu(user)}
            aria-label={t("Manage {name}", { name })}
            placement="bottom end"
          />
        )}
      </td>
    </tr>
  );
}
