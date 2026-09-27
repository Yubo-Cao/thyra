/**
 * Server-side validation of collaboration RPC parameters. The bridge assigns
 * each socket its participant id; browser-supplied ids and roles are
 * replaced, so a client can only update, claim, release or leave as itself.
 */

const MAX_PANE_ID_LENGTH = 256;
const WEB_PARTICIPANT_ROLE = "editor";

function paneId(params: Record<string, unknown>): string {
  const value = params.pane_id;
  if (typeof value !== "string" || !value || value.length > MAX_PANE_ID_LENGTH)
    throw new Error("pane_id required");
  return value;
}

/**
 * Where a share-link guest may be seen: its link's workspace (and pane).
 * Its presence never names another location and never shows typing.
 */
export type PresenceLimit = { workspace: string; pane: string | null };

function limitedLocation(
  params: Record<string, unknown>,
  limit: PresenceLimit,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params, typing: false };
  if (
    next.workspace_id !== limit.workspace ||
    (limit.pane && next.pane_id !== limit.pane)
  ) {
    if (next.workspace_id !== limit.workspace) delete next.workspace_id;
    delete next.tab_id;
    delete next.pane_id;
  }
  return next;
}

export function collaborationParams(
  method: string,
  params: Record<string, unknown>,
  participantId: string,
  limit?: PresenceLimit | null,
): Record<string, unknown> {
  switch (method) {
    case "collaboration.list":
      return {};
    case "collaboration.update":
      return {
        ...(limit ? limitedLocation(params, limit) : params),
        participant_id: participantId,
        role: WEB_PARTICIPANT_ROLE,
      };
    case "collaboration.claim": {
      const protectMs = params.protect_ms;
      return {
        participant_id: participantId,
        pane_id: paneId(params),
        ...(params.takeover === true ? { takeover: true } : {}),
        ...(typeof protectMs === "number" && Number.isFinite(protectMs)
          ? { protect_ms: protectMs }
          : {}),
      };
    }
    case "collaboration.release":
      return { participant_id: participantId, pane_id: paneId(params) };
    case "collaboration.leave":
      return { participant_id: participantId };
    default:
      throw new Error(`unknown collaboration method: ${method}`);
  }
}
