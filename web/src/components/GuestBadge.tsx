import { Eye, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { type BridgePrincipal, logoutBrowserSession } from "../api";
import { t } from "../i18n";
import { relativeExpiry } from "../shareLinks";
import { store } from "../store";
import { IconButton } from "./ui/IconButton";
import { Token } from "./ui/Token";

type Share = NonNullable<BridgePrincipal["share"]>;

/** "Read-only", who shared the view and when it ends, as separate parts. */
export function guestShareParts(share: Share, now = Date.now()) {
  return {
    sharedBy: share.shared_by
      ? t("Shared by {name}", { name: share.shared_by })
      : null,
    expires: t("Expires {when}", {
      when: relativeExpiry(share.expires_at, now),
    }),
  };
}

/** Re-render every 30 seconds so the expiry stays current. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * What a share-link guest is looking at: a read-only view, who shared it and
 * when it ends (details fold away on phones; the roster popover repeats
 * them), and a way out. The bridge closes the view when the link expires or
 * is revoked; leaving ends this browser's guest session on the server and
 * returns to the login page (or to the account signed in here).
 */
export function GuestBadge({ share }: { share: Share }) {
  const { sharedBy, expires } = guestShareParts(share, useNow());
  return (
    <>
      <Token
        className="guest-badge"
        role="status"
        icon={<Eye size={12} aria-hidden="true" />}
        title={[t("Read-only"), sharedBy, expires].filter(Boolean).join(" · ")}
      >
        <span>{t("Read-only")}</span>
        {sharedBy ? (
          <span className="guest-badge-detail guest-badge-by">{sharedBy}</span>
        ) : null}
        <span className="guest-badge-detail">{expires}</span>
      </Token>
      <IconButton
        label={t("Leave shared view")}
        icon={<LogOut size={14} aria-hidden="true" />}
        onClick={() =>
          logoutBrowserSession().catch((error: Error) =>
            store.notify({ kind: "error", message: error.message }),
          )
        }
      />
    </>
  );
}

/** The guest's note in the collaborator popover. */
export function GuestNote({ share }: { share: Share }) {
  const { sharedBy, expires } = guestShareParts(share, useNow());
  return (
    <>
      <p className="collaboration-note">
        {t("You are watching through a share link. Others see you as a guest.")}
      </p>
      <p className="collaboration-note">
        {[t("Read-only"), sharedBy, expires].filter(Boolean).join(" · ")}
      </p>
    </>
  );
}
