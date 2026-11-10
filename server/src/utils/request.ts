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
 * Read a request body of at most `maxBytes`. A larger declared
 * `Content-Length` is refused before anything is read, and the stream is
 * abandoned as soon as it passes the limit, so an oversized body is never
 * held in memory.
 */
export async function readBodyBytes(
  req: Request,
  maxBytes: number,
  ErrorClass: RequestErrorClass = RequestError,
): Promise<Uint8Array> {
  const declared = req.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes)
    throw new ErrorClass("request too large", 413);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ErrorClass("request too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

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
  const text = new TextDecoder().decode(
    await readBodyBytes(req, maxBytes, ErrorClass),
  );
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
