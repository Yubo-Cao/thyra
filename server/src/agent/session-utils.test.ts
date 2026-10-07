import { describe, expect, test } from "bun:test";
import { normalizeAgentName } from "./session-utils";

describe("agent session utility helpers", () => {
  test("normalizes agent names", () => {
    expect(normalizeAgentName("Claude-Code")).toBe("claude");
    expect(normalizeAgentName("Kimi Code")).toBe("kimi");
    expect(normalizeAgentName("Grok Build")).toBe("grok");
    expect(normalizeAgentName("Antigravity")).toBe("agy");
    expect(normalizeAgentName("antigravity-cli")).toBe("agy");
  });
});
