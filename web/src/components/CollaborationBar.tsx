import "./CollaborationBar.css";
import { Check, Pencil, X } from "lucide-react";
import { AvatarGroup } from "./ui/AvatarGroup";
import { Avatar } from "./ui/Avatar";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Popover } from "./ui/Popover";
import { TextField } from "./ui/TextField";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  acceptCollaborationEvent,
  type CollaborationIdentityMatch,
  type CollaborationSnapshot,
  collaborationFocusIds,
  collaborationProfile,
  collaborationSelfIdentity,
  saveCollaborationDisplayName,
  startCollaborationIdentity,
  subscribeCollaborationIdentity,
  subscribeCollaborationSnapshot,
  updateCollaborationPresence,
} from "../collaboration";
import {
  type Collaborator,
  collaboratorGroups,
  collaboratorLabel,
  deviceSummary,
  type PresenceSelf,
} from "../collaborationGroups";
import { bridge } from "../api";
import { useFollowController } from "../followController";
import { useFollowTarget } from "../followState";
import { t } from "../i18n";
import { store, useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { usePresenceSelf } from "../usePanePresence";
import { usePrincipal } from "../principal";
import {
  FollowChip,
  FollowersIndicator,
  PersonFocusActions,
} from "./CollaborationFollow";
import { GuestBadge, GuestNote } from "./GuestBadge";

const HEARTBEAT_MS = 12_000;

function matchDescription(
  match: CollaborationIdentityMatch | undefined,
  login: string | undefined,
) {
  if (match === "tailscale") {
    return login
      ? t("Recognized through Tailscale as {login}", { login })
      : t("Recognized through Tailscale");
  }
  if (match === "tailnet-address") {
    return t("Recognized by this device's tailnet address");
  }
  if (match === "device-hints") {
    return t(
      "Matched to this device by its model, screen and time zone (likely, not certain)",
    );
  }
  return t("Recognized by this browser");
}

/** Each person with their devices, where they look, Jump and Follow. */
function CollaboratorList({
  people,
  snapshot,
  self,
  onDone,
}: {
  people: Collaborator[];
  snapshot: CollaborationSnapshot | null;
  self: PresenceSelf;
  /** Close the popover after Jump or Follow. */
  onDone: () => void;
}) {
  return (
    <ul className="collaboration-people">
      {people.map((person) => (
        <li key={person.key} className="collaboration-person">
          <Avatar
            name={person.name}
            color={person.color}
            src={person.avatarUrl}
          />
          <span className="collaboration-person-text">
            <span className="collaboration-person-name">
              {person.isSelf
                ? t("{name} (you)", { name: person.name })
                : person.typing
                  ? t("{name} · typing", { name: person.name })
                  : person.name}
            </span>
            <span className="collaboration-person-devices">
              {deviceSummary(person.devices)}
            </span>
            <PersonFocusActions
              person={person}
              snapshot={snapshot}
              self={self}
              onDone={onDone}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CollaborationBar() {
  const status = useStoreSelector((state) => state.status);
  const client = useConnectionClient();
  const self = usePresenceSelf();
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [identity, setIdentity] = useState(collaborationSelfIdentity);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() => collaborationProfile().displayName);
  const profile = collaborationProfile();
  const refreshRef = useRef<() => void>(() => {});
  const following = useFollowTarget();
  // Share-link guests have a fixed name ("Guest") and a read-only notice.
  const share = usePrincipal()?.share;
  useFollowController(client, self);

  useEffect(() => {
    startCollaborationIdentity();
    return subscribeCollaborationIdentity((next) => {
      setIdentity(next);
      // Re-announce presence so peers see the bridge-resolved identity now.
      refreshRef.current();
    });
  }, []);

  useEffect(() => {
    if (!open) setName(profile.displayName);
  }, [open, profile.displayName]);

  useEffect(
    () => subscribeCollaborationSnapshot(client, setSnapshot),
    [client],
  );

  useEffect(
    () =>
      bridge.onEvent((event) => void acceptCollaborationEvent(client, event)),
    [client],
  );

  useEffect(() => {
    if (status !== "connected" || !client.isCurrent()) return;
    let disposed = false;
    const refresh = () => {
      void updateCollaborationPresence(client, store.get())
        .then((next) => {
          if (!disposed && client.isCurrent()) setSnapshot(next);
        })
        .catch(() => {
          // The compatibility bridge will normally absorb old-core errors.
        });
    };
    refreshRef.current = refresh;
    refresh();
    const timer = window.setInterval(refresh, HEARTBEAT_MS);
    const onVisibility = () => refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      refreshRef.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    client,
    status,
    // Followers are announced with presence, so the followed person sees them.
    following?.key,
  ]);

  // Announce a new focus from the store update itself, not after React
  // renders the switch: followers move sooner.
  useEffect(() => {
    const focusKey = () => JSON.stringify(collaborationFocusIds(store.get()));
    let last = focusKey();
    const unsubscribe = store.subscribe(() => {
      const next = focusKey();
      if (next === last) return;
      last = next;
      refreshRef.current();
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const grouped = collaboratorGroups(snapshot, self);
  const people: Collaborator[] = grouped.some((person) => person.isSelf)
    ? grouped
    : [
        {
          key: "self",
          name: profile.displayName,
          color: profile.color,
          ...(identity?.avatar_url ? { avatarUrl: identity.avatar_url } : {}),
          isSelf: true,
          typing: false,
          activity: "active",
          devices: [
            {
              key: "self",
              name: identity?.device_name ?? "",
              contexts: 1,
              isSelf: true,
            },
          ],
          participants: [],
        },
        ...grouped,
      ];
  const submitName = (event: FormEvent) => {
    event.preventDefault();
    setOpen(false);
    void saveCollaborationDisplayName(name).then(() => {
      setName(collaborationProfile().displayName);
      refreshRef.current();
    });
  };

  const names = people
    .map((person) =>
      person.isSelf
        ? t("{name} (you)", { name: collaboratorLabel(person) })
        : collaboratorLabel(person),
    )
    .join("; ");

  return (
    <>
      {share ? <GuestBadge share={share} /> : null}
      <div className="collaboration-bar">
        <Popover
          trigger={
            <Button
              className="collaboration-trigger"
              aria-label={t("Live collaborators: {people}", { people: names })}
              data-tooltip={names}
            >
              <AvatarGroup
                people={people.map((person) => ({
                  ...person,
                  followed: person.key === following?.key,
                }))}
              />
            </Button>
          }
          aria-label={t("Live collaborators")}
          open={open}
          onOpenChange={setOpen}
          className="collaboration-popover"
        >
          <div className="collaboration-profile">
            {share ? (
              <GuestNote share={share} />
            ) : (
              <>
                <form className="collaboration-editor" onSubmit={submitName}>
                  <Pencil size={13} aria-hidden="true" />
                  <TextField
                    className="collaboration-name-field"
                    value={name}
                    maxLength={80}
                    placeholder={t("Display name")}
                    aria-label={t("Your collaboration display name")}
                    onValueChange={setName}
                  />
                  <IconButton
                    type="submit"
                    label={t("Save display name")}
                    icon={<Check size={14} aria-hidden="true" />}
                  />
                  <IconButton
                    label={t("Cancel")}
                    icon={<X size={14} aria-hidden="true" />}
                    onClick={() => setOpen(false)}
                  />
                </form>
                <p className="collaboration-note">
                  {matchDescription(identity?.match, identity?.login)}
                </p>
                <p className="collaboration-note">
                  {identity?.match === "tailscale"
                    ? t(
                        "Your name is kept by this Thyra server for all your devices.",
                      )
                    : t(
                        "Your name is kept by this Thyra server for this device.",
                      )}
                </p>
              </>
            )}
            <CollaboratorList
              people={people}
              snapshot={snapshot}
              self={self}
              onDone={() => setOpen(false)}
            />
          </div>
        </Popover>
        <FollowersIndicator snapshot={snapshot} self={self} />
        <FollowChip snapshot={snapshot} self={self} />
      </div>
    </>
  );
}
