import { useState, type CSSProperties } from "react";
import { cn } from "../../utils";
import { initials } from "./avatarGroupModel";
import "./avatar.css";

/**
 * A person's square avatar: initials on a neutral tone (the person's color
 * tints the letters), covered by the profile picture once it loads. The box
 * has a fixed size, so loading or failing images never shift the layout.
 */
export function Avatar({
  name,
  color,
  src,
  className,
}: {
  name: string;
  color?: string;
  src?: string;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return (
    <span
      className={cn("ui-avatar", className)}
      style={
        color ? ({ "--participant-color": color } as CSSProperties) : undefined
      }
    >
      <span>{initials(name)}</span>
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
      ) : null}
    </span>
  );
}
