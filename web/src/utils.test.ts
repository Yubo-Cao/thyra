import { describe, expect, test } from "bun:test";
import { b64toText, formatMemoryLimit, frameCoalescer } from "./utils";

describe("formatMemoryLimit", () => {
  test("words a limit the way the server words the same one", () => {
    expect(formatMemoryLimit(12 * 1024 * 1024 * 1024)).toBe("12.0 GiB");
    expect(formatMemoryLimit(1536 * 1024 * 1024)).toBe("1.5 GiB");
    expect(formatMemoryLimit(512 * 1024 * 1024)).toBe("512 MiB");
  });
});

describe("b64toText", () => {
  test("decodes each call on its own with the shared decoder", () => {
    const encode = (text: string) =>
      btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    expect(b64toText(encode("héllo ✓"))).toBe("héllo ✓");
    // A truncated sequence must not leak into the next decode.
    expect(b64toText(btoa("\xe2\x9c"))).toBe("\ufffd");
    expect(b64toText(encode("plain"))).toBe("plain");
    expect(b64toText("not base64!")).toBeNull();
  });
});

describe("frameCoalescer", () => {
  function harness() {
    let runs = 0;
    const frames = new Map<number, () => void>();
    let nextHandle = 1;
    const coalescer = frameCoalescer(
      () => runs++,
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
    return { coalescer, frame, frames, runs: () => runs };
  }

  test("runs once per frame however often it is requested", () => {
    const { coalescer, frame, frames, runs } = harness();
    coalescer.request();
    coalescer.request();
    coalescer.request();
    expect(frames.size).toBe(1);
    expect(runs()).toBe(0);
    frame();
    expect(runs()).toBe(1);
    expect(coalescer.pending).toBe(false);
    frame();
    expect(runs()).toBe(1);
    coalescer.request();
    frame();
    expect(runs()).toBe(2);
  });

  test("flush runs a pending request now and cancel drops it", () => {
    const { coalescer, frame, frames, runs } = harness();
    coalescer.flush();
    expect(runs()).toBe(0);
    coalescer.request();
    coalescer.flush();
    expect(runs()).toBe(1);
    expect(frames.size).toBe(0);
    coalescer.request();
    coalescer.cancel();
    frame();
    expect(runs()).toBe(1);
  });
});
