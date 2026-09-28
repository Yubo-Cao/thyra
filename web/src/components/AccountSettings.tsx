import { useCallback, useEffect, useState } from "react";
import { KeyRound, Laptop, UserRound } from "lucide-react";
import { logoutBrowserSession } from "../api";
import { t } from "../i18n";
import { usePrincipal } from "../principal";
import { formatUiRelativeTime } from "../uiLocale";
import { Button } from "./ui/Button";
import "./AccountSettings.css";

type SessionInfo = {
  id: string;
  auth_method: string;
  user_agent: string | null;
  last_seen_at: number;
  current: boolean;
};

type PasskeyInfo = {
  id: string;
  name: string | null;
  rp_id: string;
  created_at: number;
  last_used_at: number | null;
};

async function request<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(
      data.error || t("Request failed ({status})", { status: response.status }),
    );
  return data;
}

/** "Firefox on Linux" from a User-Agent, for the session list. */
function browserLabel(userAgent: string | null): string {
  if (!userAgent) return t("Unknown browser");
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser && os) return t("{browser} on {os}", { browser, os });
  return browser ?? os ?? t("Unknown browser");
}

function since(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return formatUiRelativeTime(seconds, "second");
  if (absolute < 3600)
    return formatUiRelativeTime(Math.round(seconds / 60), "minute");
  if (absolute < 86400)
    return formatUiRelativeTime(Math.round(seconds / 3600), "hour");
  return formatUiRelativeTime(Math.round(seconds / 86400), "day");
}

const METHOD_LABELS: Record<string, string> = {
  passkey: "Passkey",
  tailscale: "Tailscale",
  "tailnet-sso": "Tailscale",
  enrollment: "Passkey",
};

/** The Account tab: who is logged in, passkeys and login sessions. */
export function AccountSettings() {
  const principal = usePrincipal();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [sessionList, passkeyList] = await Promise.all([
        request<{ sessions: SessionInfo[] }>("/api/auth/sessions"),
        request<{ passkeys: PasskeyInfo[] }>("/api/auth/passkeys"),
      ]);
      setSessions(sessionList.sessions);
      setPasskeys(passkeyList.passkeys);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!principal?.user) {
    return (
      <div className="account-settings">
        <p className="account-note">
          {t(
            "This browser uses Thyra directly on the host, without an account. Create accounts with `thyra user add` on the host.",
          )}
        </p>
      </div>
    );
  }
  const user = principal.user;
  return (
    <div className="account-settings">
      <div className="config-preference-row">
        <span className="config-item-icon">
          <UserRound size={15} />
        </span>
        <div className="config-item-copy">
          <strong>{user.display_name}</strong>
          <span>
            {user.name} ·{" "}
            {user.role === "admin" ? t("Instance admin") : t("Member")}
          </span>
        </div>
        <Button
          disabled={busy}
          onClick={() => void act(() => logoutBrowserSession())}
        >
          {t("Log out")}
        </Button>
      </div>

      <div className="config-title">{t("Passkeys")}</div>
      {passkeys?.length === 0 ? (
        <p className="account-note">
          {t("No passkeys yet. Add one to log in from outside the tailnet.")}
        </p>
      ) : null}
      {passkeys?.map((passkey) => (
        <div className="config-preference-row" key={passkey.id}>
          <span className="config-item-icon">
            <KeyRound size={15} />
          </span>
          <div className="config-item-copy">
            <strong>{passkey.name || t("Passkey")}</strong>
            <span>
              {passkey.rp_id} ·{" "}
              {passkey.last_used_at
                ? t("Used {time}", {
                    time: since(passkey.last_used_at),
                  })
                : t("Never used")}
            </span>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              void act(() =>
                request("/api/auth/passkeys/remove", { id: passkey.id }),
              )
            }
          >
            {t("Remove")}
          </Button>
        </div>
      ))}
      <Button
        className="account-add-passkey"
        disabled={busy || !window.isSecureContext}
        title={
          window.isSecureContext
            ? undefined
            : t("Passkeys need HTTPS or localhost")
        }
        onClick={() => location.assign("/enroll")}
      >
        <KeyRound size={14} />
        <span>
          {t("Add a passkey for {host}", { host: location.hostname })}
        </span>
      </Button>

      <div className="config-title">{t("Login sessions")}</div>
      {sessions?.map((session) => (
        <div className="config-preference-row" key={session.id}>
          <span className="config-item-icon">
            <Laptop size={15} />
          </span>
          <div className="config-item-copy">
            <strong>
              {browserLabel(session.user_agent)}
              {session.current ? ` · ${t("This browser")}` : ""}
            </strong>
            <span>
              {METHOD_LABELS[session.auth_method] ?? session.auth_method} ·{" "}
              {since(session.last_seen_at)}
            </span>
          </div>
          {session.current ? null : (
            <Button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  request("/api/auth/sessions/revoke", { id: session.id }),
                )
              }
            >
              {t("Sign out")}
            </Button>
          )}
        </div>
      ))}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
