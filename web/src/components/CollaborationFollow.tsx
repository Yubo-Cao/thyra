import { Eye, EyeOff, LocateFixed, X } from "lucide-react";
import type { CollaborationSnapshot } from "../collaboration";
import {
  focusLocation,
  focusLocationLabel,
  followersOf,
  personFocus,
} from "../collaborationFocus";
import type { Collaborator, PresenceSelf } from "../collaborationGroups";
import { navigateToFocus } from "../followController";
import { startFollowing, stopFollowing, useFollowTarget } from "../followState";
import { t } from "../i18n";
import { useStoreSelector } from "../store";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Token } from "./ui/Token";
import { useShallow } from "zustand/react/shallow";

function useWorkspaceLists() {
  return useStoreSelector(
    useShallow((state) => ({
      workspaces: state.workspaces,
      tabs: state.tabs,
      panes: state.panes,
    })),
  );
}

/**
 * Where a collaborator is looking, with Jump and Follow. Shown in the
 * collaboration popovers; nothing for this page's own row.
 */
export function PersonFocusActions({
  person,
  snapshot,
  self,
  onDone,
}: {
  person: Collaborator;
  snapshot: CollaborationSnapshot | null;
  self: PresenceSelf;
  onDone?: () => void;
}) {
  const lists = useWorkspaceLists();
  const following = useFollowTarget();
  const focus = personFocus(snapshot, person.key, self);
  if (!focus) return null;
  const location = focusLocation(focus, lists);
  const isFollowed = following?.key === person.key;
  return (
    <span className="collaboration-focus">
      <span className="collaboration-focus-where">
        {location ? (
          <>
            <span className="collaboration-focus-label">
              {t("Viewing: {place}", { place: focusLocationLabel(location) })}
            </span>
            {location.paneId ? (
              <Token code className="collaboration-focus-pane">
                {location.paneId}
              </Token>
            ) : null}
          </>
        ) : (
          <span className="collaboration-focus-label">
            {t("Viewing: {place}", { place: t("not in a workspace") })}
          </span>
        )}
      </span>
      <IconButton
        className="collaboration-jump-button"
        label={t("Jump to {name}", { name: person.name })}
        icon={<LocateFixed size={14} aria-hidden="true" />}
        disabled={!location}
        onClick={() => {
          navigateToFocus(focus, "jump");
          onDone?.();
        }}
      />
      <Button
        className="collaboration-follow-button"
        aria-pressed={isFollowed}
        onClick={() => {
          if (isFollowed) stopFollowing("user");
          else startFollowing({ key: person.key, name: person.name });
          onDone?.();
        }}
      >
        {isFollowed ? (
          <EyeOff size={14} aria-hidden="true" />
        ) : (
          <Eye size={14} aria-hidden="true" />
        )}
        {isFollowed ? t("Stop") : t("Follow")}
      </Button>
    </span>
  );
}

/** "Following Yubo (iPhone) - Stop", while this page follows someone. */
export function FollowChip({
  snapshot,
  self,
}: {
  snapshot: CollaborationSnapshot | null;
  self: PresenceSelf;
}) {
  const target = useFollowTarget();
  if (!target) return null;
  const focus = personFocus(snapshot, target.key, self);
  const who = focus?.device ? `${target.name} (${focus.device})` : target.name;
  return (
    <span className="follow-chip" role="status">
      <Eye size={13} aria-hidden="true" />
      <span className="follow-chip-text">
        {t("Following {name}", { name: who })}
      </span>
      <Button
        className="follow-chip-stop"
        aria-label={t("Stop following {name}", { name: target.name })}
        onClick={() => stopFollowing("user")}
      >
        <X size={12} aria-hidden="true" />
        <span className="follow-chip-stop-text">{t("Stop")}</span>
      </Button>
    </span>
  );
}

/** A quiet "Alice is following you" beside this person's avatars. */
export function FollowersIndicator({
  snapshot,
  self,
}: {
  snapshot: CollaborationSnapshot | null;
  self: PresenceSelf;
}) {
  const followers = followersOf(snapshot, self);
  if (followers.length === 0) return null;
  const label =
    followers.length === 1
      ? t("{name} is following you", { name: followers[0].name })
      : t("{names} are following you", {
          names: followers.map((follower) => follower.name).join(", "),
        });
  return (
    <span
      className="collaboration-followers"
      role="img"
      aria-label={label}
      data-tooltip={label}
    >
      <Eye size={12} aria-hidden="true" />
      {followers.length > 1 ? (
        <span className="collaboration-followers-count">
          {followers.length}
        </span>
      ) : null}
    </span>
  );
}
