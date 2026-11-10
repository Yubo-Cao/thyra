import { describe, expect, test } from "bun:test";
import {
  createWheelScrollBatcher,
  terminalPageScroll,
  terminalWheelScroll,
  type TerminalWheelRequest,
} from "./terminalScroll";

describe("terminal wheel scrolling", () => {
  test("uses wheel routing instead of keyboard page navigation", () => {
    expect(terminalWheelScroll(-80, 0, 30)).toEqual({
      direction: "up",
      lines: 2,
      source: "wheel",
    });
    expect(terminalWheelScroll(80, 0, 30)).toEqual({
      direction: "down",
      lines: 2,
      source: "wheel",
    });
  });

  test("normalizes line and page deltas", () => {
    expect(terminalWheelScroll(-2.2, 1, 30)?.lines).toBe(3);
    expect(terminalWheelScroll(1, 2, 30)?.lines).toBe(30);
    expect(terminalWheelScroll(0, 0, 30)).toBeNull();
  });

  test("routes full Page Up and Page Down for application-aware page-key handling", () => {
    expect(terminalPageScroll("up", 30)).toEqual({
      direction: "up",
      lines: 28,
      source: "page-key",
    });
    expect(terminalPageScroll("down", 1)).toEqual({
      direction: "down",
      lines: 1,
      source: "page-key",
    });
  });

  test("supports half-page scrollback with a readable overlap", () => {
    const up = terminalPageScroll("up", 30, "half");
    const down = terminalPageScroll("down", 2, "half");
    expect(up.lines).toBe(14);
    expect(down.lines).toBe(1);
    expect(String(up.source)).toBe("history");
    expect(String(down.source)).toBe("history");
  });
});

describe("wheel scroll batching", () => {
  function harness() {
    const sent: TerminalWheelRequest[] = [];
    const frames = new Map<number, () => void>();
    let measured = 0;
    let nextHandle = 1;
    const batcher = createWheelScrollBatcher(
      (request) => sent.push(request),
      (point) => {
        measured++;
        return { column: point.x, row: point.y };
      },
      (callback) => {
        frames.set(nextHandle, callback);
        return nextHandle++;
      },
      (handle) => frames.delete(handle),
    );
    const frame = () => {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback();
    };
    const wheel = (deltaY: number, x = 3, y = 4, terminal = "t1") =>
      batcher.push(terminal, terminalWheelScroll(deltaY, 0, 30)!, { x, y });
    return { batcher, frame, frames, sent, wheel, measured: () => measured };
  }

  test("sends the first scroll at once and one request per frame after", () => {
    const { frame, frames, sent, wheel, measured } = harness();
    wheel(40);
    expect(sent).toEqual([
      {
        terminal_id: "t1",
        direction: "down",
        lines: 1,
        source: "wheel",
        column: 3,
        row: 4,
      },
    ]);
    for (let event = 0; event < 50; event++) wheel(4);
    wheel(120);
    expect(sent).toHaveLength(1);
    frame();
    expect(sent).toHaveLength(2);
    // Every event rounds up to a line of its own, as unbatched requests did.
    expect(sent[1]).toMatchObject({ direction: "down", lines: 53 });
    expect(measured()).toBe(2);
    // The loop stops once a frame passes without scrolling.
    wheel(40);
    frame();
    expect(sent).toHaveLength(3);
    frame();
    expect(frames.size).toBe(0);
    wheel(40);
    expect(sent).toHaveLength(4);
  });

  test("keeps direction changes in order with exact totals", () => {
    const { frame, sent, wheel } = harness();
    wheel(40);
    wheel(80);
    wheel(-40);
    wheel(-40);
    wheel(120);
    frame();
    expect(sent.map((request) => [request.direction, request.lines])).toEqual([
      ["down", 1],
      ["down", 2],
      ["up", 2],
      ["down", 3],
    ]);
  });

  test("does not merge scrolls for another terminal or pointer position", () => {
    const { frame, sent, wheel } = harness();
    wheel(40);
    wheel(40);
    wheel(40, 9, 4);
    wheel(40, 9, 4, "t2");
    frame();
    expect(
      sent.map((request) => [request.terminal_id, request.column]),
    ).toEqual([
      ["t1", 3],
      ["t1", 3],
      ["t1", 9],
      ["t2", 9],
    ]);
  });

  test("dispose sends what is pending and stops the loop", () => {
    const { batcher, frame, frames, sent, wheel } = harness();
    wheel(40);
    wheel(40);
    wheel(40);
    batcher.dispose();
    expect(sent.map((request) => request.lines)).toEqual([1, 2]);
    expect(frames.size).toBe(0);
    frame();
    expect(sent).toHaveLength(2);
  });
});
