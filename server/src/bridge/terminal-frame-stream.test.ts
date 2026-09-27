import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  FRAME_STREAM_ACK_TIMEOUT_MS,
  FRAME_STREAM_MAX_INFLIGHT,
  FRAME_STREAM_MAX_MIN_INTERVAL_MS,
  TerminalFrameStream,
  frameIntervalFromParams,
} from "./terminal-frame-stream";

const meta = { width: 4, height: 3, full: true, mouse_reporting: false };
const parts = (rows: string[], tail = "\x1b[?7h\x1b[?25l") => ({ rows, tail });

function stream() {
  const sent: Record<string, unknown>[] = [];
  const frames = new TerminalFrameStream((terminal) => {
    sent.push(terminal);
    return JSON.stringify(terminal).length;
  });
  return { frames, sent };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("TerminalFrameStream", () => {
  test("sends the first frame in full and later frames as changed rows", () => {
    const { frames, sent } = stream();
    frames.offer(parts(["a", "b", "c"]), meta);
    expect(sent[0]).toMatchObject({ rows: ["a", "b", "c"], width: 4 });
    frames.ack(sent[0].frame_seq as number);
    frames.offer(parts(["a", "B", "c"]), meta);
    expect(sent[1]).toMatchObject({
      base_seq: sent[0].frame_seq,
      changed: [[1, "B"]],
    });
    expect(sent[1]).not.toHaveProperty("rows");
    expect(sent[1]).not.toHaveProperty("tail");
  });

  test("skips frames identical to the last one sent", () => {
    const { frames, sent } = stream();
    frames.offer(parts(["a", "b", "c"]), meta);
    frames.ack(sent[0].frame_seq as number);
    frames.offer(parts(["a", "b", "c"]), meta);
    expect(sent).toHaveLength(1);
    frames.offer(parts(["a", "b", "c"]), { ...meta, link_frame: "next" });
    expect(sent[1]).toMatchObject({ changed: [], link_frame: "next" });
  });

  test("holds only the newest frame while the window is full", () => {
    const { frames, sent } = stream();
    for (let i = 0; i < FRAME_STREAM_MAX_INFLIGHT + 3; i++)
      frames.offer(parts([`${i}`, "b", "c"]), meta);
    expect(sent).toHaveLength(FRAME_STREAM_MAX_INFLIGHT);
    frames.ack(sent[FRAME_STREAM_MAX_INFLIGHT - 1].frame_seq as number);
    expect(sent).toHaveLength(FRAME_STREAM_MAX_INFLIGHT + 1);
    expect(sent.at(-1)).toMatchObject({
      base_seq: sent[FRAME_STREAM_MAX_INFLIGHT - 1].frame_seq,
      changed: [[0, `${FRAME_STREAM_MAX_INFLIGHT + 2}`]],
    });
  });

  test("resends in full after a reset, a resync, or a resize", () => {
    const { frames, sent } = stream();
    frames.offer(parts(["a", "b", "c"]), meta);
    frames.ack(sent[0].frame_seq as number);
    frames.resync();
    expect(sent[1]).toMatchObject({ rows: ["a", "b", "c"] });
    frames.ack(sent[1].frame_seq as number);
    frames.reset();
    frames.offer(parts(["a", "b", "c"]), meta);
    expect(sent[2]).toHaveProperty("rows");
    frames.ack(sent[2].frame_seq as number);
    frames.offer(parts(["a", "b"]), { ...meta, height: 2 });
    expect(sent[3]).toMatchObject({ rows: ["a", "b"] });
  });

  test("releases the window when acknowledgements stop", () => {
    jest.useFakeTimers();
    const { frames, sent } = stream();
    for (let i = 0; i <= FRAME_STREAM_MAX_INFLIGHT; i++)
      frames.offer(parts([`${i}`, "b", "c"]), meta);
    expect(sent).toHaveLength(FRAME_STREAM_MAX_INFLIGHT);
    jest.advanceTimersByTime(FRAME_STREAM_ACK_TIMEOUT_MS);
    expect(sent).toHaveLength(FRAME_STREAM_MAX_INFLIGHT + 1);
    frames.dispose();
  });

  test("sends at most one frame per minimum interval, the newest", () => {
    jest.useFakeTimers();
    try {
      const { frames, sent } = stream();
      frames.configure({ minIntervalMs: 1000 });
      frames.offer(parts(["0", "b", "c"]), meta);
      expect(sent).toHaveLength(1);
      for (let i = 1; i <= 5; i++) {
        frames.ack(sent.at(-1)!.frame_seq as number);
        jest.advanceTimersByTime(100);
        frames.offer(parts([`${i}`, "b", "c"]), meta);
      }
      expect(sent).toHaveLength(1);
      jest.advanceTimersByTime(500);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ changed: [[0, "5"]] });
      // Over ten seconds of output at 20 frames per second: ten frames.
      for (let i = 0; i < 200; i++) {
        frames.ack(sent.at(-1)!.frame_seq as number);
        jest.advanceTimersByTime(50);
        frames.offer(parts([`n${i}`, "b", "c"]), meta);
      }
      expect(sent.length).toBeGreaterThanOrEqual(11);
      expect(sent.length).toBeLessThanOrEqual(12);
      frames.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  test("never holds back a full repaint", () => {
    jest.useFakeTimers();
    try {
      const { frames, sent } = stream();
      frames.configure({ minIntervalMs: 5000 });
      frames.offer(parts(["a", "b", "c"]), meta);
      frames.ack(sent[0].frame_seq as number);
      frames.resync();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toHaveProperty("rows");
      frames.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  test("pauses a viewer and repaints in full when it resumes", () => {
    const { frames, sent } = stream();
    frames.offer(parts(["a", "b", "c"]), meta);
    frames.ack(sent[0].frame_seq as number);
    frames.configure({ paused: true });
    frames.offer(parts(["x", "b", "c"]), meta);
    frames.offer(parts(["y", "b", "c"]), meta);
    expect(sent).toHaveLength(1);
    frames.configure({ paused: false });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ rows: ["y", "b", "c"] });
    expect(frames.settings).toEqual({ minIntervalMs: 0, paused: false });
  });

  test("validates requested intervals", () => {
    expect(frameIntervalFromParams(0)).toBe(0);
    expect(frameIntervalFromParams(750)).toBe(750);
    expect(frameIntervalFromParams(FRAME_STREAM_MAX_MIN_INTERVAL_MS + 1)).toBe(
      null,
    );
    expect(frameIntervalFromParams(-1)).toBe(null);
    expect(frameIntervalFromParams(1.5)).toBe(null);
    expect(frameIntervalFromParams("100")).toBe(null);
  });
});
