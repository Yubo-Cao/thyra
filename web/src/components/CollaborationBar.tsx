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

function CollaboratorList({
  people,
  onFocusPane,
}: {
  people: Collaborator[];
  onFocusPane: (paneId: string) => void;
}) {
  return (
    <ul className="collaboration-people">
      {people.map((person) => {
        const paneId = person.isSelf
          ? undefined
          : person.participants.find((participant) => participant.pane_id)
              ?.pane_id;
        const content = (
          <>
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
            </span>
          </>
        );
        return (
          <li key={person.key}>
            {paneId ? (
              <Button
                fullWidth
                className="collaboration-person"
                onClick={() => onFocusPane(paneId)}
              >
                {content}
              </Button>
            ) : (
              <span className="collaboration-person">{content}</span>
            )}
          </li>
        );
      })}
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
  const [open, setOpen] = useState(false);
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
    <div className="collaboration-bar">
      <Popover
        trigger={
          <Button
            className="collaboration-trigger"
            aria-label={t("Live collaborators: {people}", { people: names })}
            data-tooltip={names}
          >
            <AvatarGroup people={people} />
          </Button>
        }
        aria-label={t("Live collaborators")}
        open={open}
        onOpenChange={setOpen}
        className="collaboration-popover"
      >
        <div className="collaboration-profile">
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
              : t("Your name is kept by this Thyra server for this device.")}
          </p>
          <CollaboratorList
            people={people}
            onFocusPane={(paneId) => {
              setOpen(false);
              void store.focusPane(paneId);
            }}
          />
        </div>
      </Popover>
    </div>
  );
}
