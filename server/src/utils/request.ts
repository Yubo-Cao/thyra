/** An error a request handler answers with `status` and its message. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type RequestErrorClass = new (message: string, status?: number) => Error;

/**
 * Read a small JSON-object request body. An empty body is `{}`; anything
 * else that is not a JSON object throws `ErrorClass`.
 */
export async function readJsonObject(
  req: Request,
  maxBytes: number,
  ErrorClass: RequestErrorClass = RequestError,
): Promise<Record<string, unknown>> {
  if (
    req.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new ErrorClass("expected a JSON request", 415);
  const text = await req.text();
  if (text.length > maxBytes) throw new ErrorClass("request too large", 413);
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ErrorClass("invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ErrorClass("expected a JSON object");
  return value as Record<string, unknown>;
}

/** One cookie's URL-decoded value, or null when absent or malformed. */
export function parseCookie(header: string | null, name: string) {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}
