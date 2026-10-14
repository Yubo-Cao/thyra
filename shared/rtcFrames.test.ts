import { describe, expect, test } from "bun:test";
import {
  encodeRtcClose,
  encodeRtcMessage,
  RTC_CHUNK_BYTES,
  RtcFrameDecoder,
  RtcFrameError,
} from "./rtcFrames";

function roundTrip(data: string | Uint8Array, chunkBytes?: number) {
  const decoder = new RtcFrameDecoder();
  const chunks = encodeRtcMessage(data, chunkBytes);
  const results = chunks.map((chunk) => decoder.push(chunk));
  return { chunks, results };
}

describe("rtc frames", () => {
  test("a small text message is one chunk", () => {
    const { chunks, results } = roundTrip('{"id":"c1","method":"bridge.ping"}');
    expect(chunks).toHaveLength(1);
    expect(results).toEqual([
      { kind: "message", data: '{"id":"c1","method":"bridge.ping"}' },
    ]);
  });

  test("large text is chunked and reassembled, multi-byte characters intact", () => {
    // Multi-byte characters straddle chunk boundaries at this size.
    const text = "终端🦜".repeat(20_000);
    const { chunks, results } = roundTrip(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(chunk.byteLength).toBeLessThanOrEqual(RTC_CHUNK_BYTES + 1);
    expect(results.slice(0, -1).every((result) => result === null)).toBe(true);
    expect(results.at(-1)).toEqual({ kind: "message", data: text });
  });

  test("an exact multiple of the chunk size ends with a last chunk", () => {
    const text = "x".repeat(RTC_CHUNK_BYTES * 3);
    const { chunks, results } = roundTrip(text);
    expect(chunks).toHaveLength(3);
    expect(results.at(-1)).toEqual({ kind: "message", data: text });
  });

  test("the empty string survives", () => {
    expect(roundTrip("").results).toEqual([{ kind: "message", data: "" }]);
  });

  test("binary stays binary", () => {
    const bytes = new Uint8Array(40_000).map((_, index) => index % 251);
    const { results } = roundTrip(bytes, 1000);
    const last = results.at(-1);
    expect(last?.kind).toBe("message");
    expect(last && last.kind === "message" && last.data).toEqual(bytes);
  });

  test("consecutive messages decode independently", () => {
    const decoder = new RtcFrameDecoder();
    const out = [
      ...encodeRtcMessage("a".repeat(50), 16),
      ...encodeRtcMessage("b"),
    ].map((chunk) => decoder.push(chunk));
    expect(out.filter(Boolean)).toEqual([
      { kind: "message", data: "a".repeat(50) },
      { kind: "message", data: "b" },
    ]);
  });

  test("close frames carry the code and reason", () => {
    const decoder = new RtcFrameDecoder();
    expect(decoder.push(encodeRtcClose(4001, "Session ended"))).toEqual({
      kind: "close",
      code: 4001,
      reason: "Session ended",
    });
  });

  test("rejects oversized, malformed and mixed messages", () => {
    const small = new RtcFrameDecoder(100);
    expect(() =>
      encodeRtcMessage("x".repeat(200), 50).forEach((chunk) =>
        small.push(chunk),
      ),
    ).toThrow(RtcFrameError);
    const decoder = new RtcFrameDecoder();
    expect(() => decoder.push(new Uint8Array())).toThrow(RtcFrameError);
    expect(() => decoder.push(new Uint8Array([0x80]))).toThrow(RtcFrameError);
    expect(() => decoder.push(new Uint8Array([0x00, 0xff]))).toThrow(
      RtcFrameError,
    );
    decoder.push(new Uint8Array([0x01, 0x41]));
    expect(() => decoder.push(new Uint8Array([0x02, 0x41]))).toThrow(
      RtcFrameError,
    );
  });
});
