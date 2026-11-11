import { afterEach, expect, test } from "bun:test";
import { installCatalog } from "../../i18n";
import zhCN from "../../locales/zh-CN";
import { agentModeText } from "./agentModes";

afterEach(() => installCatalog("en", {}));

test("modes say whether the agent is sandboxed, in the interface language", () => {
  expect(agentModeText("codex", { id: "never", label: "x" }).label).toBe(
    "Never ask (sandboxed)",
  );
  expect(
    agentModeText("codex", { id: "full-access", label: "x" }).description,
  ).toContain("--yolo");
  expect(
    agentModeText("claude", { id: "bypassPermissions", label: "x" }).label,
  ).toBe("Full access (bypass permissions)");
  // A Codex pair of no named mode, and modes this page does not know.
  expect(
    agentModeText("codex", { id: "on-request+danger-full-access", label: "x" })
      .label,
  ).toBe("Custom: asks when needed, no sandbox");
  expect(
    agentModeText("claude", { id: "dontAsk", label: "Don't ask" }),
  ).toEqual({ label: "Don't ask" });
  installCatalog("zh-CN", zhCN);
  expect(agentModeText("codex", { id: "full-access", label: "x" }).label).toBe(
    "完全访问（无沙箱，从不询问）",
  );
  expect(
    agentModeText("codex", { id: "untrusted+read-only", label: "x" }).label,
  ).toBe("自定义：命令前询问，只读沙箱");
});
