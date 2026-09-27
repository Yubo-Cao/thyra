import "./PanePresence.css";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import {
  panePresenceLabel,
  presencePeople,
  presencePersonLabel,
} from "../collaborationGroups";
import { startFollowing, stopFollowing, useFollowTarget } from "../followState";
import { t } from "../i18n";
import { usePanePresence } from "../usePanePresence";
import { AvatarGroup } from "./ui/AvatarGroup";
import { ContextMenu, type ContextMenuPosition } from "./ui/ContextMenu";

/**
 * Avatars of the people looking at a pane (or every pane of a tab); the
 * person holding layout control comes first with an accent frame and a
 * keyboard badge. One avatar per person, however many tabs or devices.
 * Clicking them offers to follow (or stop following) each person.
 */
export function PanePresence({
  paneIds,
  className,
}: {
  paneIds: readonly string[];
  className?: string;
}) {
  const presence = usePanePresence(paneIds);
  const following = useFollowTarget();
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);
  const people = presencePeople(presence);
  if (people.length === 0) return null;
  return (
    <span
      className="pane-presence"
      // The row or tab around this selects it; clicks here (and in the menu,
      // which React bubbles through its portal) belong to the avatars.
      onClick={(event) => {
        event.stopPropagation();
        if (event.currentTarget.contains(event.target as Node))
          setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <AvatarGroup
        className={className}
        people={people.map((person) => ({
          ...person,
          followed: person.key === following?.key,
        }))}
        label={panePresenceLabel(presence)}
      />
      <ContextMenu
        position={menu}
        onClose={() => setMenu(null)}
        aria-label={t("Follow")}
        autoFocusFirst={false}
        items={people.map((person) =>
          person.key === following?.key
            ? {
                id: person.key,
                label: t("Stop following {name}", { name: person.name }),
                icon: <EyeOff size={14} aria-hidden="true" />,
                onAction: () => stopFollowing("user"),
              }
            : {
                id: person.key,
                label: t("Follow {name}", {
                  name: presencePersonLabel({ ...person, isSelf: false }),
                }),
                icon: <Eye size={14} aria-hidden="true" />,
                onAction: () =>
                  startFollowing({ key: person.key, name: person.name }),
              },
        )}
      />
    </span>
  );
}
