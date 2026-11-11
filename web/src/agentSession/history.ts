import {
  AGENT_SESSION_HISTORY_LIMIT,
  type AgentStoredSession,
} from "../../../shared/agentSession";
import { formatUiRelativeTime } from "../uiLocale";

/** Stored conversations listed before "show more". */
export const HISTORY_PREVIEW = 5;

/** The usable conversations of an `agent_session.history` reply, in its order. */
export function storedSessions(reply: unknown): AgentStoredSession[] {
  const list = (reply as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (item): item is AgentStoredSession =>
        typeof item?.id === "string" &&
        typeof item.title === "string" &&
        Number.isFinite(item.updated_at),
    )
    .slice(0, AGENT_SESSION_HISTORY_LIMIT);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a stored conversation was last active, in whole units of the
 * largest one that fits: "5 minutes ago", "yesterday", "2 weeks ago".
 */
export function storedSessionAge(updatedAt: number, now = Date.now()): string {
  // A host clock ahead of the browser's must not read as the future.
  const age = Math.max(0, now - updatedAt);
  const ago = (size: number, unit: Intl.RelativeTimeFormatUnit) =>
    formatUiRelativeTime(-Math.floor(age / size), unit);
  if (age < MINUTE) return formatUiRelativeTime(0, "second");
  if (age < HOUR) return ago(MINUTE, "minute");
  if (age < DAY) return ago(HOUR, "hour");
  if (age < 7 * DAY) return ago(DAY, "day");
  if (age < 30 * DAY) return ago(7 * DAY, "week");
  if (age < 365 * DAY) return ago(30 * DAY, "month");
  return ago(365 * DAY, "year");
}
