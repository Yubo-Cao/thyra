import { expect, test } from "bun:test";
import {
  floatToS16le,
  isRemoteMicFrame,
  parseRemoteMicServerMessage,
  REMOTE_MIC_CLOSE,
  REMOTE_MIC_FRAME_SAMPLES,
  REMOTE_MIC_SAMPLE_RATE,
} from "../../../shared/remoteMic";
import { parseTerminalKeys } from "../../../shared/terminalKey";
import {
  REMOTE_MIC_VOICE_KEY,
  remoteMicCloseMessage,
  remoteMicUrl,
} from "./remoteMicProtocol";
import { RemoteMicFramer } from "./remoteMicFramer";
import { VoiceResampler } from "./voiceSegmenter";

test("encodes float samples as clipped s16le", () => {
  const bytes = floatToS16le(new Float32Array([0, 1, -1, 0.5, 2, -2]));
  const view = new DataView(bytes.buffer);
  expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(i * 2, true))).toEqual([
    0, 32767, -32768, 16384, 32767, -32768,
  ]);
});

test("frames whole 20 ms chunks and keeps the remainder", () => {
  const framer = new RemoteMicFramer(REMOTE_MIC_FRAME_SAMPLES);
  const input = Float32Array.from({ length: 700 }, (_, i) => i);
  const frames = framer.push(input);
  expect(frames.map((f) => f.length)).toEqual([320, 320]);
  expect(frames[1]![0]).toBe(320);
  expect(framer.push(new Float32Array(10))).toEqual([]);
  expect(framer.flush()?.length).toBe(70);
  expect(framer.flush()).toBeNull();
  expect(REMOTE_MIC_FRAME_SAMPLES / REMOTE_MIC_SAMPLE_RATE).toBe(0.02);
});

test("48 kHz capture becomes a clean 16 kHz tone", () => {
  const resampler = new VoiceResampler(48_000);
  const framer = new RemoteMicFramer(REMOTE_MIC_FRAME_SAMPLES);
  const frames: Float32Array[] = [];
  // One second of 440 Hz in 128-sample render quanta.
  for (let start = 0; start < 48_000; start += 128) {
    const quantum = Float32Array.from(
      { length: 128 },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (start + i)) / 48_000),
    );
    frames.push(...framer.push(resampler.process(quantum)));
  }
  const samples = frames.length * REMOTE_MIC_FRAME_SAMPLES;
  expect(Math.abs(samples - 16_000)).toBeLessThanOrEqual(
    REMOTE_MIC_FRAME_SAMPLES,
  );
  // Past the filter's warm-up, the RMS of a 0.5 sine is about 0.354.
  const tail = frames.slice(10).flatMap((frame) => [...frame]);
  const rms = Math.sqrt(tail.reduce((sum, x) => sum + x * x, 0) / tail.length);
  expect(rms).toBeGreaterThan(0.33);
  expect(rms).toBeLessThan(0.37);
});

test("validates frames and server messages", () => {
  expect(isRemoteMicFrame(640)).toBe(true);
  expect(isRemoteMicFrame(0)).toBe(false);
  expect(isRemoteMicFrame(641)).toBe(false);
  expect(isRemoteMicFrame(REMOTE_MIC_SAMPLE_RATE * 2 + 2)).toBe(false);
  expect(parseRemoteMicServerMessage('{"type":"ready","source":"x"}')).toEqual({
    type: "ready",
    source: "x",
  });
  expect(parseRemoteMicServerMessage('{"type":"error","message":"m"}')).toEqual(
    { type: "error", message: "m" },
  );
  expect(parseRemoteMicServerMessage('{"type":"ready"}')).toBeNull();
  expect(parseRemoteMicServerMessage("nope")).toBeNull();
});

test("streams to the pane's connection over the page's own origin", () => {
  expect(
    remoteMicUrl({ protocol: "https:", host: "thyra.test" }, "local", "t 1"),
  ).toBe("wss://thyra.test/ws/mic?connection_id=local&terminal_id=t+1");
  expect(
    remoteMicUrl({ protocol: "http:", host: "127.0.0.1:1" }, "c", "t"),
  ).toBe("ws://127.0.0.1:1/ws/mic?connection_id=c&terminal_id=t");
});

test("the voice key is a plain F12 the bridge accepts", () => {
  expect(parseTerminalKeys([REMOTE_MIC_VOICE_KEY])).toEqual([
    { key: "F", fn: 12, mods: 0, kind: "press" },
  ]);
});

test("explains why the stream ended", () => {
  expect(remoteMicCloseMessage(REMOTE_MIC_CLOSE.superseded, "")).toContain(
    "Another page",
  );
  expect(remoteMicCloseMessage(4101, "boom")).toBe("boom");
  expect(remoteMicCloseMessage(1006, "")).toContain("lost");
});
