// Framing for bridge messages over a WebRTC data channel. SCTP messages much
// over 64 KB are unsafe across browsers, so every bridge message travels as
// one or more chunks of at most RTC_CHUNK_BYTES payload behind a one-byte
// header. The header also carries the close code and reason a WebSocket close
// frame would, so a revoked session closes the channel with the same 4001 the
// page acts on.

/** Payload bytes per chunk: the size every browser's SCTP stack accepts. */
export const RTC_CHUNK_BYTES = 16 * 1024;
/** Largest reassembled message; Bun's WebSocket default is the same 16 MiB. */
export const RTC_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** More chunks of this message follow. */
const FLAG_MORE = 0x01;
/** The message is binary rather than UTF-8 text. */
const FLAG_BINARY = 0x02;
/** A close frame: two bytes of code, then the UTF-8 reason. */
const FLAG_CLOSE = 0x04;
const KNOWN_FLAGS = FLAG_MORE | FLAG_BINARY | FLAG_CLOSE;

export type RtcDecoded =
  | { kind: "message"; data: string | Uint8Array }
  | { kind: "close"; code: number; reason: string };

const encoder = new TextEncoder();

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = flags;
  out.set(payload, 1);
  return out;
}

/** Split one message into chunks; text stays text after reassembly. */
export function encodeRtcMessage(
  data: string | Uint8Array,
  chunkBytes = RTC_CHUNK_BYTES,
): Uint8Array[] {
  const binary = typeof data !== "string";
  const bytes = binary ? data : encoder.encode(data);
  const base = binary ? FLAG_BINARY : 0;
  if (bytes.byteLength <= chunkBytes) return [frame(base, bytes)];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, bytes.byteLength);
    const last = end === bytes.byteLength;
    chunks.push(
      frame(last ? base : base | FLAG_MORE, bytes.subarray(offset, end)),
    );
  }
  return chunks;
}

/** A close frame carrying a WebSocket close code and a short reason. */
export function encodeRtcClose(code: number, reason = ""): Uint8Array {
  const text = encoder.encode(reason).subarray(0, 123);
  const out = new Uint8Array(text.byteLength + 3);
  out[0] = FLAG_CLOSE;
  out[1] = (code >> 8) & 0xff;
  out[2] = code & 0xff;
  out.set(text, 3);
  return out;
}

export class RtcFrameError extends Error {}

/** Reassembles chunks from one ordered, reliable channel. */
export class RtcFrameDecoder {
  private parts: Uint8Array[] = [];
  private size = 0;
  private binary = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxBytes = RTC_MAX_MESSAGE_BYTES) {}

  /** The finished message or close frame, or null while chunks remain. */
  push(chunk: Uint8Array): RtcDecoded | null {
    if (chunk.byteLength === 0) throw new RtcFrameError("empty chunk");
    const flags = chunk[0]!;
    if (flags & ~KNOWN_FLAGS) throw new RtcFrameError("unknown chunk flags");
    if (flags & FLAG_CLOSE) {
      if (chunk.byteLength < 3) throw new RtcFrameError("short close frame");
      this.reset();
      return {
        kind: "close",
        code: (chunk[1]! << 8) | chunk[2]!,
        reason: new TextDecoder().decode(chunk.subarray(3)),
      };
    }
    const binary = (flags & FLAG_BINARY) !== 0;
    if (this.parts.length > 0 && binary !== this.binary)
      throw new RtcFrameError("chunk type changed mid-message");
    this.binary = binary;
    this.size += chunk.byteLength - 1;
    if (this.size > this.maxBytes) {
      this.reset();
      throw new RtcFrameError("message too large");
    }
    this.parts.push(chunk.subarray(1));
    if (flags & FLAG_MORE) return null;
    const parts = this.parts;
    const size = this.size;
    this.reset();
    let bytes: Uint8Array;
    if (parts.length === 1) bytes = parts[0]!;
    else {
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
    }
    if (binary) return { kind: "message", data: bytes.slice() };
    try {
      return { kind: "message", data: this.decoder.decode(bytes) };
    } catch {
      throw new RtcFrameError("invalid UTF-8 text message");
    }
  }

  private reset() {
    this.parts = [];
    this.size = 0;
    this.binary = false;
  }
}
