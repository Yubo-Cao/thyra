import { afterEach, describe, expect, test } from "bun:test";
import {
  hasProthyraCapability,
  inProthyra,
  onProthyraResume,
  parseProthyra,
  PROTHYRA_RESUME_EVENT,
  resetProthyraForTests,
} from "./prothyra";

const realWindow = (globalThis as { window?: unknown }).window;

function installWindow(prothyra: unknown) {
  const target = new EventTarget() as EventTarget & { prothyra?: unknown };
  target.prothyra = prothyra;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  resetProthyraForTests();
  return target;
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: realWindow,
  });
  resetProthyraForTests();
});

describe("parseProthyra", () => {
  test("keeps the string capabilities and ignores the version", () => {
    const declared = parseProthyra(
      Object.freeze({
        version: 7,
        capabilities: Object.freeze(["clipboard.read", 3, "lifecycle.resume"]),
      }),
    );
    expect(declared && [...declared]).toEqual([
      "clipboard.read",
      "lifecycle.resume",
    ]);
    expect(parseProthyra({ capabilities: [] })?.size).toBe(0);
  });

  test("rejects anything without a capability list", () => {
    for (const value of [
      undefined,
      null,
      "prothyra",
      { version: "1.0" },
      { capabilities: "clipboard.read" },
    ])
      expect(parseProthyra(value)).toBeNull();
    const throwing = {
      get capabilities() {
        throw new Error("denied");
      },
    };
    expect(parseProthyra(throwing)).toBeNull();
  });
});

describe("Prothyra detection", () => {
  test("ordinary browsers have no capabilities", () => {
    installWindow(undefined);
    expect(inProthyra()).toBe(false);
    expect(hasProthyraCapability("clipboard.read")).toBe(false);
  });

  test("reads window.prothyra once", () => {
    const target = installWindow({ capabilities: ["keyboard.fullCapture"] });
    expect(inProthyra()).toBe(true);
    expect(hasProthyraCapability("keyboard.fullCapture")).toBe(true);
    expect(hasProthyraCapability("clipboard.read")).toBe(false);
    target.prothyra = { capabilities: ["clipboard.read"] };
    expect(hasProthyraCapability("clipboard.read")).toBe(false);
  });

  test("resume listeners need the lifecycle capability", () => {
    let resumes = 0;
    const plain = installWindow({ capabilities: [] });
    onProthyraResume(() => resumes++);
    plain.dispatchEvent(new Event(PROTHYRA_RESUME_EVENT));
    expect(resumes).toBe(0);

    const app = installWindow({ capabilities: ["lifecycle.resume"] });
    const listeners = new AbortController();
    onProthyraResume(() => resumes++, listeners.signal);
    app.dispatchEvent(new Event(PROTHYRA_RESUME_EVENT));
    expect(resumes).toBe(1);
    listeners.abort();
    app.dispatchEvent(new Event(PROTHYRA_RESUME_EVENT));
    expect(resumes).toBe(1);
  });
});
