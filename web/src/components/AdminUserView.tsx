import { useCallback, useEffect, useState } from "react";
import { MoreHorizontal, Trash2 } from "lucide-react";
import type {
  AdminEmailsRequest,
  AdminRemoveMethodRequest,
  AdminSignInMethod,
  AdminTailscaleRequest,
  AdminUserDetail,
} from "../../../shared/admin";
import { request, since } from "../accountRequests";
import { parseEmails } from "../emailList";
import { t } from "../i18n";
import {
  AdminLink,
  ErrorLine,
  lastSeen,
  navigate,
  providerName,
  ProviderToken,
  UserTokens,
  useUserActions,
} from "./adminParts";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { IconButton } from "./ui/IconButton";
import { Menu } from "./ui/Menu";
import { TextArea } from "./ui/TextArea";
import { TextField } from "./ui/TextField";

/**
 * One account on the admin page (`/admin/users/<id>`): its profile and
 * every way it signs in. Admins bind email addresses (verified, as they
 * vouch for them) and Tailscale logins, and remove any method; the last
 * one goes only after a confirmation.
 */
export function AdminUserView({ id }: { id: string }) {
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [emails, setEmails] = useState("");
  const [emailError, setEmailError] = useState("");
  const [login, setLogin] = useState("");
  const [lastMethod, setLastMethod] = useState<AdminSignInMethod | null>(null);
  const load = useCallback(
    () =>
      request<AdminUserDetail>(
        `/api/admin/users/detail?user=${encodeURIComponent(id)}`,
      ).then(setUser),
    [id],
  );
  useEffect(() => {
    load().catch((failure: Error) => setLoadError(failure.message));
  }, [load]);
  const actions = useUserActions(load, () => navigate("/admin"));

  /** Send a change; the answer is the account as it is now. */
  const change = async (route: string, body: Record<string, unknown>) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      setUser(
        await request<AdminUserDetail>(`/api/admin/users/${route}`, body),
      );
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const bindEmails = async () => {
    const parsed = parseEmails(emails);
    if (parsed.invalid.length)
      return setEmailError(
        t("Not an email address: {entries}", {
          entries: parsed.invalid.join(", "),
        }),
      );
    if (
      parsed.emails.length &&
      (await change("emails", {
        user: id,
        emails: parsed.emails,
      } satisfies AdminEmailsRequest))
    )
      setEmails("");
  };
  const bindTailscale = async () => {
    if (
      await change("tailscale", {
        user: id,
        login: login.trim(),
      } satisfies AdminTailscaleRequest)
    )
      setLogin("");
  };
  const remove = (method: AdminSignInMethod, allowLast = false) =>
    change("methods/remove", {
      user: id,
      method: { kind: method.kind, id: method.id },
      allowLast,
    } satisfies AdminRemoveMethodRequest);

  if (!user)
    return (
      <section className="admin-section admin-section-wide">
        {loadError ? (
          <>
            <ErrorLine error={loadError} />
            <AdminLink href="/admin">{t("Back to users")}</AdminLink>
          </>
        ) : (
          <p className="admin-note">{t("Loading...")}</p>
        )}
      </section>
    );

  const name = user.displayName || user.name;
  const usable = user.methods.filter((method) => method.verified).length;
  return (
    <>
      <section className="admin-section admin-section-wide">
        <div className="admin-row">
          <div className="admin-copy">
            <h2 className="admin-title">{name}</h2>
            <span>
              {[user.name, ...user.emails].filter(Boolean).join(" · ")}
            </span>
          </div>
          {user.self ? null : (
            <Menu
              trigger={
                <IconButton
                  label={t("Manage {name}", { name })}
                  icon={<MoreHorizontal size={15} />}
                  disabled={actions.busy}
                />
              }
              items={actions.menu(user)}
              aria-label={t("Manage {name}", { name })}
              placement="bottom end"
            />
          )}
        </div>
        <div className="admin-tokens">
          <UserTokens user={user} />
          <span className="admin-meta">
            {t("Created {time}", { time: since(user.createdAt) })} ·{" "}
            {lastSeen(user)}
          </span>
        </div>
        <ErrorLine error={actions.error} />
        {actions.dialog}
      </section>

      <section className="admin-section admin-section-wide">
        <h2 className="admin-heading">{t("Sign-in methods")}</h2>
        {user.methods.length === 0 ? (
          <p className="admin-note">
            {t(
              "No way to sign in: add an email address or a Tailscale login below, or send an invitation.",
            )}
          </p>
        ) : null}
        {user.methods.map((method) => (
          <div className="admin-row admin-method" key={method.id}>
            <ProviderToken provider={method.provider} />
            <div className="admin-copy">
              <strong>{method.label}</strong>
              <span>
                {[
                  providerName(method.provider),
                  method.verified ? null : t("Not verified"),
                  t("Added {time}", { time: since(method.createdAt) }),
                  method.lastUsedAt
                    ? t("Used {time}", { time: since(method.lastUsedAt) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {user.self && method.verified && usable <= 1 ? null : (
              <IconButton
                label={t("Remove {method}", { method: method.label })}
                tone="danger"
                icon={<Trash2 size={15} />}
                disabled={busy}
                onClick={() => {
                  if (method.verified && usable <= 1) setLastMethod(method);
                  else void remove(method);
                }}
              />
            )}
          </div>
        ))}
        <ErrorLine error={error} />
      </section>

      <section className="admin-section">
        <h2 className="admin-heading">{t("Add email addresses")}</h2>
        <p className="admin-note">
          {t(
            "Addresses you add count as verified: {name} signs in with a code sent to any of them, or with a Google, GitHub or Microsoft account that uses one.",
            { name },
          )}
        </p>
        <form
          className="admin-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void bindEmails();
          }}
        >
          <TextArea
            label={t("Email addresses")}
            description={t("Separate several with commas, spaces or lines.")}
            value={emails}
            onValueChange={(value) => {
              setEmails(value);
              setEmailError("");
            }}
            error={emailError || undefined}
            placeholder="name@example.com, name@work.example"
            rows={2}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            fullWidth
          />
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !emails.trim()}
          >
            {t("Add")}
          </Button>
        </form>
      </section>

      <section className="admin-section">
        <h2 className="admin-heading">{t("Tailscale login")}</h2>
        <p className="admin-note">
          {t(
            "On the tailnet, the person with this Tailscale login signs in as {name} without a password.",
            { name },
          )}
        </p>
        <form
          className="admin-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void bindTailscale();
          }}
        >
          <TextField
            label={t("Tailscale login")}
            value={login}
            onValueChange={setLogin}
            placeholder="name@github"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            fullWidth
          />
          <Button type="submit" disabled={busy || !login.trim()}>
            {t("Add")}
          </Button>
        </form>
      </section>

      <ConfirmDialog
        open={lastMethod !== null}
        onOpenChange={(open) => {
          if (!open) setLastMethod(null);
        }}
        title={t("Remove the last sign-in method?")}
        message={t(
          "{name} will not be able to sign in until you add another method or send a new invitation. Browsers already signed in stay signed in.",
          { name },
        )}
        confirmLabel={t("Remove")}
        tone="danger"
        onConfirm={async () => {
          if (lastMethod) await remove(lastMethod, true);
        }}
      />
    </>
  );
}
