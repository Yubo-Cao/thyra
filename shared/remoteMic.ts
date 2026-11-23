/**
 * The host-microphone stream (`/ws/mic`): a browser on another computer
 * speaks into a virtual PipeWire source on the Thyra host, which agents'
 * own voice input (Claude Code's `/voice`) records as the default mic.
 *
 * Browser to bridge: binary frames of 16 kHz mono signed 16-bit
 * little-endian PCM, any whole number of samples up to `MAX_FRAME_BYTES`.
 * Closing the socket ends the stream.
 *
 * Bridge to browser: JSON text frames (`RemoteMicServerMessage`). Audio is
 * dropped until `ready`, which the bridge sends once the virtual source is
 * the host's default; the browser presses the agent's voice key only then.
 */

export const REMOTE_MIC_PATH = "/ws/mic";
export const REMOTE_MIC_STATUS_PATH = "/api/remote-mic";
export const REMOTE_MIC_SAMPLE_RATE = 16_000;
/** 20 ms frames keep latency low without flooding the socket. */
export const REMOTE_MIC_FRAME_SAMPLES = 320;
/** One second of audio: a frame larger than this is a protocol error. */
export const REMOTE_MIC_MAX_FRAME_BYTES = REMOTE_MIC_SAMPLE_RATE * 2;

/** Close codes the bridge uses so the page can explain the end. */
export const REMOTE_MIC_CLOSE = {
  /** Another page took the host microphone (newest stream wins). */
  superseded: 4100,
  /** The virtual source could not be created or failed. */
  failed: 4101,
  /** No audio arrived for too long. */
  idle: 4102,
  /** The bridge is shutting down. */
  shutdown: 4103,
} as const;

export type RemoteMicServerMessage =
  | { type: "ready"; source: string }
  | { type: "error"; message: string };

export type RemoteMicStatus = {
  available: boolean;
  /** Why the host cannot offer it (no PipeWire tools, not Linux, disabled). */
  reason?: string;
  /** Connections whose panes run on this host; others cannot hear it. */
  connections: string[];
};

export function parseRemoteMicServerMessage(
  text: string,
): RemoteMicServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type === "ready" && typeof message.source === "string")
    return { type: "ready", source: message.source };
  if (message.type === "error" && typeof message.message === "string")
    return { type: "error", message: message.message };
  return null;
}

/** Whether a binary frame is well-formed PCM (whole samples, bounded). */
export function isRemoteMicFrame(byteLength: number): boolean {
  return (
    byteLength > 0 &&
    byteLength % 2 === 0 &&
    byteLength <= REMOTE_MIC_MAX_FRAME_BYTES
  );
}

/** Float samples in [-1, 1] to s16le bytes, clipping out-of-range input. */
export function floatToS16le(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(
      index * 2,
      Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff),
      true,
    );
  }
  return bytes;
}
