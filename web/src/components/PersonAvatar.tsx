import type { CSSProperties } from "react";
import { initials } from "../collaborationGroups";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/Avatar";

/**
 * A collaborator's avatar: the Tailscale profile picture when it loads,
 * otherwise initials on the person's color.
 */
export function PersonAvatar({
  name,
  color,
  avatarUrl,
  className,
}: {
  name: string;
  color: string;
  avatarUrl?: string;
  className?: string;
}) {
  return (
    <Avatar
      className={className}
      style={{ "--participant-color": color } as CSSProperties}
    >
      {avatarUrl ? (
        <AvatarImage
          src={avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
        />
      ) : null}
      <AvatarFallback delayMs={avatarUrl ? 400 : undefined}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
