import { describe, expect, test } from "bun:test";
import { healthMatchesUpdateVersion } from "./updates";

describe("update restart verification", () => {
  test("matches only the expected running server version", () => {
    expect(healthMatchesUpdateVersion({ version: "0.3.0" }, "0.3.0")).toBe(
      true,
    );
    expect(healthMatchesUpdateVersion({ version: "0.2.9" }, "0.3.0")).toBe(
      false,
    );
    expect(healthMatchesUpdateVersion({ ok: true }, "0.3.0")).toBe(false);
  });
});
