import { expect, test } from "bun:test";
import { agentIconInstance } from "./AgentIcon";

test("an icon instance gets its own gradient IDs", () => {
  const svg =
    '<svg viewBox="0 0 24 24"><path fill="url(#lobe-icons-codex-_R_0_)"/><defs><linearGradient id="lobe-icons-codex-_R_0_"/></defs></svg>';
  const first = agentIconInstance(svg, ":r1:");
  const second = agentIconInstance(svg, ":r2:");
  expect(first).toContain('fill="url(#lobe-icons-codex-_R_0_-r1)"');
  expect(first).toContain('<linearGradient id="lobe-icons-codex-_R_0_-r1"/>');
  expect(second).toContain('id="lobe-icons-codex-_R_0_-r2"');
  expect(first).not.toBe(second);
});

test("an icon without IDs is left as it is", () => {
  const svg = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
  expect(agentIconInstance(svg, ":r1:")).toBe(svg);
});
