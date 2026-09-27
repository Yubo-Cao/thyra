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

export function collaborationParams(
  method: string,
  params: Record<string, unknown>,
  participantId: string,
): Record<string, unknown> {
  switch (method) {
    case "collaboration.list":
      return {};
    case "collaboration.update":
      return {
        ...params,
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
