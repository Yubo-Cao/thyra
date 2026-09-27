import { describe, expect, test } from "bun:test";
import { createCollaborationService } from "../bridge/collaboration";
import {
  optionalNumber,
  optionalString,
  requireNumber,
  requireString,
  RpcParamError,
} from "./rpc-params";

describe("RPC param readers", () => {
  test("return values of the declared type", () => {
    const params = { name: "alpha", empty: "", count: 3, zero: 0 };
    expect(requireString(params, "name")).toBe("alpha");
    expect(optionalString(params, "empty")).toBe("");
    expect(requireNumber(params, "count")).toBe(3);
    expect(optionalNumber(params, "zero")).toBe(0);
  });

  test("treat missing and null as absent", () => {
    for (const params of [undefined, null, {}, { name: null, count: null }]) {
      expect(optionalString(params, "name")).toBeUndefined();
      expect(optionalNumber(params, "count")).toBeUndefined();
    }
    expect(() => requireString({}, "name")).toThrow(
      "invalid params: name is required",
    );
    expect(() => requireNumber({ count: null }, "count")).toThrow(
      "invalid params: count is required",
    );
  });

  test("reject wrong types instead of coercing them", () => {
    for (const value of [{}, [], 1, true]) {
      expect(() => optionalString({ name: value }, "name")).toThrow(
        new RpcParamError("invalid params: name must be a string"),
      );
    }
    for (const value of ["3", {}, true, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => optionalNumber({ count: value }, "count")).toThrow(
        "invalid params: count must be a finite number",
      );
    }
    for (const params of ["text", 1, []]) {
      expect(() => optionalString(params, "name")).toThrow(
        "invalid params: expected an object",
      );
    }
  });

  test("an object id is an RPC error, not a participant named [object Object]", async () => {
    const service = createCollaborationService({
      herdrCall: async () => {
        throw new Error("invalid response envelope from Herdr");
      },
    });
    await expect(
      service.call("collaboration.update", { participant_id: { id: "x" } }),
    ).rejects.toThrow("invalid params: participant_id must be a string");
    await expect(
      service.call("collaboration.update", {
        participant_id: "alice",
        display_name: ["Alice"],
      }),
    ).rejects.toThrow("invalid params: display_name must be a string");
    const listed = await service.call("collaboration.list", {});
    expect(JSON.stringify(listed)).not.toContain("[object Object]");
  });
});
