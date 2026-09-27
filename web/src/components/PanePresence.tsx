import { panePresenceLabel, presencePeople } from "../collaborationGroups";
import { usePanePresence } from "../usePanePresence";
import { AvatarGroup } from "./ui/AvatarGroup";

/**
 * Avatars of the people looking at a pane (or every pane of a tab); the
 * person holding layout control comes first with an accent frame and a
 * keyboard badge. One avatar per person, however many tabs or devices.
 */
export function PanePresence({
  paneIds,
  className,
}: {
  paneIds: readonly string[];
  className?: string;
}) {
  const presence = usePanePresence(paneIds);
  const people = presencePeople(presence);
  if (people.length === 0) return null;
  return (
    <AvatarGroup
      className={className}
      people={people}
      label={panePresenceLabel(presence)}
    />
  );
}
