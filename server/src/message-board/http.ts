import { BoardError, type createMessageBoard } from "./service";

export const AGENT_BOARD_PATH = "/api/agent/message-board";
/** Dedicated bearer endpoint; call after Host/rate checks, before browser auth. */
export async function handleAgentBoard(
  req: Request,
  board: ReturnType<typeof createMessageBoard>,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    if (req.method !== "POST")
      return new Response("method not allowed", { status: 405, headers });
    if (req.headers.has("origin") || req.headers.has("cookie"))
      throw new BoardError(
        "forbidden",
        "agent endpoint does not accept browser credentials",
        403,
      );
    const bearer = req.headers.get("authorization") ?? "";
    const secret = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
    const credential = board.authenticate(secret);
    if (Number(req.headers.get("content-length") ?? 0) > 131072)
      throw new BoardError("too_large", "request too large", 413);
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 131072) {
            await reader.cancel();
            throw new BoardError("too_large", "request too large", 413);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.method !== "string" ||
      Object.keys(input).some((k) => !["method", "params"].includes(k))
    )
      throw new BoardError("invalid_params", "invalid request");
    board.authenticate(secret, input.method);
    return Response.json(
      {
        result: board.execute(
          credential.owner_id,
          credential.id,
          input.method,
          input.params,
        ),
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error: {
          code: error instanceof BoardError ? error.code : "invalid_request",
          message:
            error instanceof BoardError ? error.message : "invalid request",
        },
      },
      { status: error instanceof BoardError ? error.status : 400, headers },
    );
  }
}
