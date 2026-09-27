import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { msg, t } from "../i18n";
import { paneDisplayName } from "../paneIdentity";
import {
  createShareLink,
  listShareLinks,
  relativeExpiry,
  revokeShareLink,
  type ShareExpiry,
  type ShareLinkView,
} from "../shareLinks";
import { useStoreSelector } from "../store";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { TextField } from "./ui/TextField";

const EXPIRY_OPTIONS: { value: ShareExpiry; label: string }[] = [
  { value: "1h", label: msg("1 hour") },
  { value: "24h", label: msg("24 hours") },
  { value: "7d", label: msg("7 days") },
];

const STATE_LABELS = {
  expired: msg("Expired"),
  revoked: msg("Revoked"),
  used: msg("Used up"),
} as const;

const WHOLE_WORKSPACE = "workspace";

/**
 * Anonymous read-only links to one workspace (or one of its panes): create
 * one (its URL is shown once), see who is watching, and revoke. Guests never
 * type, resize or take control; the bridge enforces it.
 */
export function ShareLinksSection({
  open,
  connectionId,
  workspaceId,
}: {
  open: boolean;
  connectionId: string;
  workspaceId: string | null;
}) {
  const [links, setLinks] = useState<ShareLinkView[] | null>(null);
  const [scope, setScope] = useState(WHOLE_WORKSPACE);
  const [expires, setExpires] = useState<ShareExpiry>("24h");
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panes = useStoreSelector(
    useShallow((state) =>
      state.panes.filter((pane) => pane.workspace_id === workspaceId),
    ),
  );

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    setLinks(null);
    setCreated(null);
    setError("");
    listShareLinks(connectionId, workspaceId).then(
      (next) => {
        if (!cancelled) setLinks(next);
      },
      (failure: Error) => {
        if (!cancelled) setError(failure.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, workspaceId]);

  const run = async (action: () => Promise<void>) => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const uses = Number(maxUses);
  const usesValid =
    maxUses.trim() === "" || (Number.isInteger(uses) && uses > 0);
  const create = () =>
    run(async () => {
      const result = await createShareLink(connectionId, workspaceId!, {
        paneId: scope === WHOLE_WORKSPACE ? null : scope,
        expires,
        label,
        maxUses: maxUses.trim() ? uses : null,
      });
      setCreated(result.url);
      setCopied(false);
      setLabel("");
      setMaxUses("");
      setLinks(await listShareLinks(connectionId, workspaceId!));
    });
  const revoke = (id: string) =>
    run(async () => {
      setLinks(await revokeShareLink(connectionId, workspaceId!, id));
    });
  const paneName = (paneId: string) => {
    const pane = panes.find((item) => item.pane_id === paneId);
    return pane ? paneDisplayName(pane) : paneId;
  };

  return (
    <section className="share-links" aria-labelledby="share-links-title">
      <h3 id="share-links-title" className="share-links-title">
        {t("Links")}
      </h3>
      <p className="share-workspace-note">
        {t(
          "Anyone with a link can watch without an account: read-only, scrolling history, never typing.",
        )}
      </p>
      <div className="share-links-scope">
        <Select
          label={t("Shows")}
          value={scope}
          options={[
            { value: WHOLE_WORKSPACE, label: t("Whole workspace") },
            ...panes.map((pane) => ({
              value: pane.pane_id,
              label: t("Only {pane}", { pane: paneDisplayName(pane) }),
            })),
          ]}
          onChange={setScope}
        />
        <Select
          label={t("Expires after")}
          value={expires}
          options={EXPIRY_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={setExpires}
        />
      </div>
      <div className="share-links-create">
        <TextField
          label={t("Label")}
          value={label}
          onValueChange={setLabel}
          placeholder={t("Optional")}
          maxLength={40}
          autoComplete="off"
        />
        <TextField
          label={t("Max uses")}
          value={maxUses}
          onValueChange={setMaxUses}
          placeholder={t("Unlimited")}
          inputMode="numeric"
          autoComplete="off"
          error={usesValid ? undefined : t("Enter a whole number")}
        />
        <Button
          variant="primary"
          disabled={busy || !usesValid}
          onClick={() => void create()}
        >
          {t("Create link")}
        </Button>
      </div>
      {created ? (
        <div className="share-links-created">
          <TextField
            label={t("New link: copy it now, it is shown only once")}
            value={created}
            readOnly
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            fullWidth
          />
          <Button
            variant="primary"
            onClick={() =>
              void copyTextFromUserGesture(created).then(
                () => setCopied(true),
                () =>
                  setError(t("Could not copy. Select the link and copy it.")),
              )
            }
          >
            {copied ? t("Copied") : t("Copy")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="share-workspace-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="share-workspace-list" aria-label={t("Share links")}>
        {links === null && !error ? (
          <p className="share-workspace-note">{t("Loading...")}</p>
        ) : links?.length === 0 ? (
          <p className="share-workspace-note">{t("No links yet.")}</p>
        ) : (
          links?.map((link) => (
            <div className="share-workspace-row share-link-row" key={link.id}>
              <span className="share-workspace-person">
                <strong>
                  {link.label ||
                    (link.pane_id
                      ? t("Only {pane}", { pane: paneName(link.pane_id) })
                      : t("Whole workspace"))}
                </strong>
                <span>
                  {[
                    link.state === "active"
                      ? t("Expires {when}", {
                          when: relativeExpiry(link.expires_at),
                        })
                      : t(STATE_LABELS[link.state]),
                    link.max_uses
                      ? t("{uses} of {max} uses", {
                          uses: link.uses,
                          max: link.max_uses,
                        })
                      : link.uses === 0
                        ? t("Not used yet")
                        : link.uses === 1
                          ? t("Used once")
                          : t("Used {uses} times", { uses: link.uses }),
                    link.guests > 0
                      ? t("{count} watching", { count: link.guests })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {link.state === "active" ? (
                <Button disabled={busy} onClick={() => void revoke(link.id)}>
                  {t("Revoke")}
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
