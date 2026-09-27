import { useEffect, useState } from "react";
import { msg, t } from "../i18n";
import type { WorkspaceAccess } from "../types";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Select } from "./ui/Select";
import { TextField } from "./ui/TextField";
import { ShareLinksSection } from "./ShareLinksSection";
import "./ShareWorkspaceDialog.css";

type Grant = {
  user: { id: string; name: string; display_name: string };
  role: WorkspaceAccess;
};

const ROLE_OPTIONS: { value: WorkspaceAccess; label: string; hint: string }[] =
  [
    {
      value: "viewer",
      label: msg("Viewer"),
      hint: msg("Watches terminals and scrolls history"),
    },
    {
      value: "editor",
      label: msg("Editor"),
      hint: msg("Types after taking control, edits files"),
    },
    {
      value: "owner",
      label: msg("Owner"),
      hint: msg("Also shares and closes the workspace"),
    },
  ];

async function grantsRequest(
  body: Record<string, unknown> | null,
  connectionId: string,
  workspaceId: string,
): Promise<Grant[]> {
  const url = `/api/workspace-grants?${new URLSearchParams({
    connection_id: connectionId,
    workspace_id: workspaceId,
  })}`;
  const response = await fetch(url, {
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
  const data = (await response.json().catch(() => ({}))) as {
    grants?: Grant[];
    error?: string;
  };
  if (!response.ok)
    throw new Error(
      data.error || t("Request failed ({status})", { status: response.status }),
    );
  return data.grants ?? [];
}

/**
 * Invite existing users to one workspace and change or remove their roles,
 * and manage its anonymous read-only links. Only workspace owners and
 * instance admins see it; the bridge checks again.
 */
export function ShareWorkspaceDialog({
  open,
  connectionId,
  workspaceId,
  workspaceName,
  onClose,
}: {
  open: boolean;
  connectionId: string;
  workspaceId: string | null;
  workspaceName: string;
  onClose: () => void;
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [user, setUser] = useState("");
  const [role, setRole] = useState<WorkspaceAccess>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    setGrants(null);
    setError("");
    grantsRequest(null, connectionId, workspaceId).then(
      (next) => {
        if (!cancelled) setGrants(next);
      },
      (failure: Error) => {
        if (!cancelled) setError(failure.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, workspaceId]);

  const change = async (target: string, next: WorkspaceAccess | "none") => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError("");
    try {
      setGrants(
        await grantsRequest(
          { user: target, role: next },
          connectionId,
          workspaceId,
        ),
      );
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const roleOptions = ROLE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.label),
    description: t(option.hint),
  }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("Share workspace")}
      description={workspaceName}
      size="md"
      busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        const name = user.trim();
        if (!name) return;
        void change(name, role).then((ok) => {
          if (ok) setUser("");
        });
      }}
      footer={
        <Button variant="primary" size="md" onClick={onClose}>
          {t("Done")}
        </Button>
      }
    >
      <div className="share-workspace-invite">
        <TextField
          label={t("User name or login")}
          value={user}
          onValueChange={setUser}
          placeholder={t("alice or alice@example.com")}
          autoComplete="off"
          spellCheck={false}
          fullWidth
        />
        <Select
          label={t("Role")}
          value={role}
          options={roleOptions}
          onChange={setRole}
        />
        <Button type="submit" variant="primary" disabled={busy || !user.trim()}>
          {t("Invite")}
        </Button>
      </div>
      <p className="share-workspace-note">
        {t(
          "People need an account first: tailnet users get one on their first visit; others need `thyra user add` on the host.",
        )}
      </p>
      {error ? (
        <p className="share-workspace-error" role="alert">
          {error}
        </p>
      ) : null}
      <div
        className="share-workspace-list"
        aria-label={t("People with access")}
      >
        {grants === null && !error ? (
          <p className="share-workspace-note">{t("Loading...")}</p>
        ) : grants?.length === 0 ? (
          <p className="share-workspace-note">
            {t("Only instance admins can open this workspace.")}
          </p>
        ) : (
          grants?.map((grant) => (
            <div className="share-workspace-row" key={grant.user.id}>
              <span className="share-workspace-person">
                <strong>{grant.user.display_name}</strong>
                <span>{grant.user.name}</span>
              </span>
              <Select
                aria-label={t("Role of {name}", { name: grant.user.name })}
                value={grant.role}
                options={roleOptions}
                disabled={busy}
                onChange={(next) => void change(grant.user.name, next)}
              />
              <Button
                disabled={busy}
                onClick={() => void change(grant.user.name, "none")}
              >
                {t("Remove")}
              </Button>
            </div>
          ))
        )}
      </div>
      <ShareLinksSection
        open={open}
        connectionId={connectionId}
        workspaceId={workspaceId}
      />
    </Dialog>
  );
}
