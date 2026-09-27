/** Pure layout and motion rules of `AvatarGroup` (and `Avatar` initials). */

/** Hover spring: the hovered avatar lifts most, its neighbours less. */
export const AVATAR_LIFT_PX = -4;
export const AVATAR_LIFT_FALLOFF = 0.45;
export const AVATAR_HOVER_SCALE = 1.05;

/** Vertical shift of the avatar at `index` while `active` is hovered. */
export function avatarLift(index: number, active: number) {
  const shift =
    AVATAR_LIFT_PX * AVATAR_LIFT_FALLOFF ** Math.abs(index - active);
  return Math.round(shift * 1000) / 1000;
}

/** The first `max` entries, and how many more a "+N" chip stands for. */
export function avatarSlots<T>(items: readonly T[], max: number) {
  const limit = Math.max(1, Math.floor(max));
  return {
    shown: items.slice(0, limit),
    overflow: Math.max(0, items.length - limit),
  };
}

/** "Yubo Cao" -> "YC"; at most two letters. */
export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => Array.from(part)[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
