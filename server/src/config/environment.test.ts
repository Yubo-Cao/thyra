import { describe, expect, test } from "bun:test";
import { thyraEnv } from "./environment";
import { isSupervisorManagedEnvironment } from "../http/update";

describe("Thyra environment compatibility", () => {
  test("new names override legacy names without mutating the environment", () => {
    const environment = {
      THYRA_PASSWORD: "new-secret",
      HERDR_GUI_PASSWORD: "old-secret",
    };
    expect(thyraEnv("PASSWORD", environment)).toBe("new-secret");
    expect(environment.HERDR_GUI_PASSWORD).toBe("old-secret");
    expect(thyraEnv("PASSWORD", { HERDR_GUI_PASSWORD: "old-secret" })).toBe(
      "old-secret",
    );
    expect(
      thyraEnv("PASSWORD", {
        THYRA_PASSWORD: "",
        HERDR_GUI_PASSWORD: "old-secret",
      }),
    ).toBe("");
    expect(thyraEnv("PASSWORD", {})).toBeUndefined();
  });

  test("Roamgate names sit between Thyra and herdr-gui names", () => {
    expect(
      thyraEnv("PORT", { ROAMGATE_PORT: "8787", HERDR_GUI_PORT: "3000" }),
    ).toBe("8787");
    expect(
      thyraEnv("PORT", { THYRA_PORT: "9000", ROAMGATE_PORT: "8787" }),
    ).toBe("9000");
  });

  test("new supervisor override takes precedence over legacy settings and detection", () => {
    expect(
      isSupervisorManagedEnvironment({
        THYRA_RESTART_SUPERVISOR: "0",
        HERDR_GUI_RESTART_SUPERVISOR: "1",
        INVOCATION_ID: "service",
      }),
    ).toBe(false);
    expect(
      isSupervisorManagedEnvironment({
        THYRA_RESTART_SUPERVISOR: "1",
        HERDR_GUI_RESTART_SUPERVISOR: "0",
      }),
    ).toBe(true);
  });
});
