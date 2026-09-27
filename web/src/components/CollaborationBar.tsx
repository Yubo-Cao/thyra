import "./CollaborationBar.css";
import { Check, Pencil, Users, X } from "lucide-react";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Popover } from "./ui/Popover";
import { TextField } from "./ui/TextField";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  acceptCollaborationEvent,
  type CollaborationIdentityMatch,
  type CollaborationSnapshot,
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
} from "../collaborationGroups";
import { bridge } from "../api";
import { t } from "../i18n";
import { shallowEqual, store, useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { usePresenceSelf } from "../usePanePresence";
import { PersonAvatar } from "./PersonAvatar";

const HEARTBEAT_MS = 12_000;
const MAX_AVATARS = 3;

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

function CollaboratorList({ people }: { people: Collaborator[] }) {
  return (
    <ul className="collaboration-people">
      {people.map((person) => (
        <li key={person.key} className="collaboration-person">
          <PersonAvatar
            name={person.name}
            color={person.color}
            avatarUrl={person.avatarUrl}
          />
          <span className="collaboration-person-text">
            <span className="collaboration-person-name">
              {person.isSelf
                ? t("{name} (you)", { name: person.name })
                : person.name}
            </span>
            <span className="collaboration-person-devices">
              {deviceSummary(person.devices)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CollaborationBar() {
  const session = useStoreSelector(
    (state) => ({
      status: state.status,
      workspaces: state.workspaces,
      tabs: state.tabs,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      layout: state.layout,
    }),
    shallowEqual,
  );
  const client = useConnectionClient();
  const self = usePresenceSelf();
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [identity, setIdentity] = useState(collaborationSelfIdentity);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(() => collaborationProfile().displayName);
  const profile = collaborationProfile();
  const latestSession = useRef(session);
  latestSession.current = session;
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    startCollaborationIdentity();
    return subscribeCollaborationIdentity((next) => {
      setIdentity(next);
      // Re-announce presence so peers see the bridge-resolved identity now.
      refreshRef.current();
    });
  }, []);

  useEffect(() => {
    if (!editing) setName(profile.displayName);
  }, [editing, profile.displayName]);

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
    if (session.status !== "connected" || !client.isCurrent()) return;
    let disposed = false;
    const refresh = () => {
      void updateCollaborationPresence(client, latestSession.current)
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
    session.layout?.focused_pane_id,
    session.layout?.tab_id,
    session.selectedPaneId,
    session.status,
  ]);

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
    setEditing(false);
    void saveCollaborationDisplayName(name).then(() => {
      setName(collaborationProfile().displayName);
      refreshRef.current();
    });
  };

  return (
    <div className="collaboration-bar">
      <div
        className="collaboration-roster"
        aria-label={t("Live collaborators")}
      >
        <Users size={14} aria-hidden="true" />
        <span
          className="collaboration-count"
          title={t("{count} people", { count: people.length })}
        >
          {people.length}
        </span>
        <div className="collaboration-avatars">
          {people.slice(0, MAX_AVATARS).map((person) => {
            const label = collaboratorLabel(person);
            const focusPaneId = person.participants.find(
              (participant) => participant.pane_id,
            )?.pane_id;
            const avatarButton = (
              <IconButton
                className={`collaboration-avatar activity-${person.activity} ${person.isSelf ? "is-self" : ""} ${person.typing ? "is-typing" : ""}`}
                tooltip={
                  person.typing ? t("{name} · typing", { name: label }) : label
                }
                label={
                  person.isSelf ? t("{name} (you)", { name: label }) : label
                }
                icon={
                  <PersonAvatar
                    name={person.name}
                    color={person.color}
                    avatarUrl={person.avatarUrl}
                  />
                }
                onClick={() => {
                  if (!person.isSelf && focusPaneId)
                    void store.focusPane(focusPaneId);
                }}
              />
            );
            return person.isSelf ? (
              <Popover
                key={person.key}
                trigger={avatarButton}
                aria-label={t("Your collaboration profile")}
                open={editing}
                onOpenChange={setEditing}
                className="collaboration-popover"
              >
                <div className="collaboration-profile">
                  <form className="collaboration-editor" onSubmit={submitName}>
                    <Pencil size={13} aria-hidden="true" />
                    <TextField
                      className="collaboration-name-field"
                      autoFocus
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
                      onClick={() => setEditing(false)}
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
                  <CollaboratorList people={people} />
                </div>
              </Popover>
            ) : (
              <span className="collaboration-peer" key={person.key}>
                {avatarButton}
              </span>
            );
          })}
          {people.length > MAX_AVATARS ? (
            <Popover
              trigger={
                <Button
                  className="collaboration-overflow"
                  aria-label={t("{count} collaborators", {
                    count: people.length,
                  })}
                >
                  +{people.length - MAX_AVATARS}
                </Button>
              }
              aria-label={t("Live collaborators")}
              className="collaboration-popover"
            >
              <CollaboratorList people={people} />
            </Popover>
          ) : null}
        </div>
        <span className="collaboration-live">{t("Live")}</span>
      </div>
    </div>
  );
}
