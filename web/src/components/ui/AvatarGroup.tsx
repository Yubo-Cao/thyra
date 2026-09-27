import { Keyboard } from "lucide-react";
import { useState, type CSSProperties, type PointerEvent } from "react";
import { cn } from "../../utils";
import { Avatar } from "./Avatar";
import {
  AVATAR_HOVER_SCALE,
  avatarLift,
  avatarSlots,
} from "./avatarGroupModel";

export type AvatarGroupPerson = {
  key: string;
  name: string;
  color?: string;
  avatarUrl?: string;
  /** Holds control: accent frame, plus a keyboard badge after the group. */
  controller?: boolean;
  /** This page follows them: a heavier accent frame. */
  followed?: boolean;
};

/**
 * A compact stack of square avatars with a "+N" overflow chip. Each avatar
 * after the first tucks under its predecessor behind a small gap. Hovering
 * one lifts it and, less and less, its neighbours (a spring written once per
 * pointer enter/leave through CSS variables; focus-visible on a containing
 * control does the same, touch never does).
 *
 * With `label` the group is an image with that accessible name and tooltip;
 * without it, it is decoration inside a labelled control.
 */
export function AvatarGroup({
  people,
  max = 3,
  size = "sm",
  label,
  className,
}: {
  people: readonly AvatarGroupPerson[];
  max?: number;
  size?: "sm" | "md";
  label?: string;
  className?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const { shown, overflow } = avatarSlots(people, max);
  const item = (index: number) => ({
    className: "ui-avatar-group-item",
    "data-active": active === index || undefined,
    style: {
      "--avatar-index": index,
      ...(active === null
        ? {}
        : {
            "--avatar-shift": `${avatarLift(index, active)}px`,
            "--avatar-scale": index === active ? AVATAR_HOVER_SCALE : 1,
          }),
    } as CSSProperties,
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== "touch") setActive(index);
    },
  });
  return (
    <span
      className={cn("ui-avatar-group", className)}
      data-size={size}
      data-hover={active !== null || undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-tooltip={label}
      onPointerLeave={() => setActive(null)}
    >
      {shown.map((person, index) => (
        <span
          key={person.key}
          {...item(index)}
          data-controller={person.controller || undefined}
          data-followed={person.followed || undefined}
        >
          <Avatar
            name={person.name}
            color={person.color}
            src={person.avatarUrl}
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span {...item(shown.length)} data-more="">
          +{overflow}
        </span>
      ) : null}
      {people.some((person) => person.controller) ? (
        <Keyboard
          className="ui-avatar-group-control"
          size={11}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}
