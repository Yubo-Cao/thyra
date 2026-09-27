import "./CollaborationBar.css";
import { Check, Pencil, Users, X } from "lucide-react";
import { Avatar, AvatarFallback } from "./ui/Avatar";
import { IconButton } from "./ui/IconButton";
import { Popover } from "./ui/Popover";
import { TextField } from "./ui/TextField";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  acceptCollaborationEvent,
  type CollaborationParticipant,
  type CollaborationSnapshot,
  collaborationProfile,
  participantIsTyping,
  saveCollaborationProfile,
  subscribeCollaborationSnapshot,
  updateCollaborationPresence,
} from "../collaboration";
import { bridge } from "../api";
import { t } from "../i18n";
import { shallowEqual, store, useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";

const HEARTBEAT_MS = 12_000;

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
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(() => collaborationProfile().displayName);
  const profile = collaborationProfile();
  const latestSession = useRef(session);
  latestSession.current = session;

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
    refresh();
    const timer = window.setInterval(refresh, HEARTBEAT_MS);
    const onVisibility = () => refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
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

  const participants: CollaborationParticipant[] = snapshot?.participants ?? [];
  const visibleParticipants: CollaborationParticipant[] = participants.length
    ? participants
    : [
        {
          participant_id: profile.participantId,
          display_name: profile.displayName,
          color: profile.color,
          role: "editor",
          activity: "active",
          surface: "web",
          updated_at_unix_ms: Date.now(),
          expires_at_unix_ms: Date.now() + HEARTBEAT_MS,
          typing: false,
        },
      ];
  const submitName = (event: FormEvent) => {
    event.preventDefault();
    saveCollaborationProfile({ ...profile, displayName: name });
    setName(collaborationProfile().displayName);
    setEditing(false);
    void updateCollaborationPresence(client, latestSession.current).then(
      setSnapshot,
      () => {},
    );
  };

  return (
    <div className="collaboration-bar">
      <div
        className="collaboration-roster"
        aria-label={t("Live collaborators")}
      >
        <Users size={14} aria-hidden="true" />
        <span className="collaboration-count">{participants.length || 1}</span>
        <div className="collaboration-avatars">
          {[...visibleParticipants]
            .sort(
              (a, b) =>
                Number(b.participant_id === profile.participantId) -
                Number(a.participant_id === profile.participantId),
            )
            .slice(0, 3)
            .map((participant) => {
              const isSelf =
                participant.participant_id === profile.participantId;
              const isTyping = participantIsTyping(participant);
              const avatarButton = (
                <IconButton
                  className={`collaboration-avatar activity-${participant.activity} ${isSelf ? "is-self" : ""} ${isTyping ? "is-typing" : ""}`}
                  style={
                    {
                      "--participant-color": participant.color,
                    } as CSSProperties
                  }
                  tooltip={
                    isTyping
                      ? t("{name} · typing", {
                          name: participant.display_name,
                        })
                      : participant.pane_id
                        ? t("{name} · viewing a pane", {
                            name: participant.display_name,
                          })
                        : participant.display_name
                  }
                  label={
                    isSelf
                      ? t("{name} (you)", { name: participant.display_name })
                      : participant.display_name
                  }
                  icon={
                    <Avatar>
                      <AvatarFallback>
                        {participant.display_name
                          .split(/\s+/)
                          .filter(Boolean)
                          .map((part) => Array.from(part)[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  }
                  onClick={() => {
                    if (!isSelf && participant.pane_id)
                      void store.focusPane(participant.pane_id);
                  }}
                />
              );
              return isSelf ? (
                <Popover
                  key={participant.participant_id}
                  trigger={avatarButton}
                  aria-label={t("Your collaboration display name")}
                  open={editing}
                  onOpenChange={setEditing}
                  className="collaboration-popover"
                >
                  <form className="collaboration-editor" onSubmit={submitName}>
                    <Pencil size={13} aria-hidden="true" />
                    <TextField
                      className="collaboration-name-field"
                      autoFocus
                      value={name}
                      maxLength={80}
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
                </Popover>
              ) : (
                <span
                  className="collaboration-peer"
                  key={participant.participant_id}
                >
                  {avatarButton}
                </span>
              );
            })}
          {visibleParticipants.length > 3 ? (
            <span
              className="collaboration-overflow"
              title={t("{count} collaborators", {
                count: visibleParticipants.length,
              })}
            >
              +{visibleParticipants.length - 3}
            </span>
          ) : null}
        </div>
        <span className="collaboration-live">{t("Live")}</span>
      </div>
    </div>
  );
}
