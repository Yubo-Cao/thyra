import "./PanePresence.css";
import { Keyboard } from "lucide-react";
import { panePresenceLabel } from "../collaborationGroups";
import { usePanePresence } from "../usePanePresence";
import { PersonAvatar } from "./PersonAvatar";

const MAX_AVATARS = 3;

/**
 * Stacked avatars of the people looking at a pane (or a tab's panes); the
 * person holding layout control comes first with an accent ring and a
 * keyboard badge. One avatar per person, however many tabs or devices.
 */
export function PanePresence({ paneIds }: { paneIds: readonly string[] }) {
  const presence = usePanePresence(paneIds);
  const { controller } = presence;
  if (!controller && presence.viewers.length === 0) return null;
  const people = controller
    ? [controller, ...presence.viewers.filter((v) => v.key !== controller.key)]
    : presence.viewers;
  const label = panePresenceLabel(presence);
  return (
    <span
      className="pane-presence"
      role="img"
      aria-label={label}
      data-tooltip={label}
    >
      {people.slice(0, MAX_AVATARS).map((person) => (
        <PersonAvatar
          key={person.key}
          className={`pane-presence-avatar${person.key === controller?.key ? " is-controller" : ""}`}
          name={person.name}
          color={person.color}
          avatarUrl={person.avatarUrl}
        />
      ))}
      {people.length > MAX_AVATARS ? (
        <span className="pane-presence-more">
          +{people.length - MAX_AVATARS}
        </span>
      ) : null}
      {controller ? (
        <Keyboard
          className="pane-presence-control"
          size={11}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}
