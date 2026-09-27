import { describe, expect, test } from "bun:test";
import { thyraEnv } from "./environment";
import { isSupervisorManagedEnvironment } from "../http/update";

describe("Thyra environment", () => {
  test("reads only THYRA_* names without mutating the environment", () => {
    const environment = { THYRA_PASSWORD: "secret" };
    expect(thyraEnv("PASSWORD", environment)).toBe("secret");
    expect(environment).toEqual({ THYRA_PASSWORD: "secret" });
    expect(thyraEnv("PASSWORD", { THYRA_PASSWORD: "" })).toBe("");
    expect(thyraEnv("PASSWORD", {})).toBeUndefined();
    expect(
      thyraEnv("PORT", { ROAMGATE_PORT: "8787", HERDR_GUI_PORT: "3000" }),
    ).toBeUndefined();
  });

  test("supervisor override takes precedence over detection", () => {
    expect(
      isSupervisorManagedEnvironment({
        THYRA_RESTART_SUPERVISOR: "0",
        INVOCATION_ID: "service",
      }),
    ).toBe(false);
    expect(
      isSupervisorManagedEnvironment({ THYRA_RESTART_SUPERVISOR: "1" }),
    ).toBe(true);
  });
});
