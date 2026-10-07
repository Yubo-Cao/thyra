import { expect, test } from "bun:test";
import { inlinedResttyWasm } from "./vite.restty";

test("reads the WASM bytes restty inlines as an escaped template literal", () => {
  const code =
    "var other = 1;\nvar WASM_BINARY = `\\x00asm\\x01\\x00\\x00\\x00\\`ÿ`;\nexport {};";
  expect([...(inlinedResttyWasm(code) ?? [])]).toEqual([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x60, 0xff,
  ]);
  expect(inlinedResttyWasm("var WASM_BINARY = `text`;")).toBeNull();
  expect(inlinedResttyWasm("export {};")).toBeNull();
});
