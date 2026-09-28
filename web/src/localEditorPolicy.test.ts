import { expect, test } from "bun:test";
import {
  coarsePrimaryPointer,
  editorMayTakeFocus,
  localEditorsAvailable,
  programmaticFocusAllowed,
} from "./localEditorPolicy";

test("the local editors follow the layout, not the pointer", () => {
  // A tablet in the desktop layout gets them; the mobile layout keeps its composer.
  expect(localEditorsAvailable(false)).toBe(true);
  expect(localEditorsAvailable(true)).toBe(false);
});

test("the primary pointer is read from the media query", () => {
  const media = (coarse: boolean) => ({
    matchMedia: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
    }),
  });
  expect(coarsePrimaryPointer(media(true))).toBe(true);
  expect(coarsePrimaryPointer(media(false))).toBe(false);
  expect(coarsePrimaryPointer({})).toBe(false);
  expect(coarsePrimaryPointer(undefined)).toBe(false);
});

test("touch devices move focus for the user only with a hardware keyboard", () => {
  expect(programmaticFocusAllowed(false, "unknown")).toBe(true);
  expect(programmaticFocusAllowed(false, "software")).toBe(true);
  expect(programmaticFocusAllowed(true, "hardware")).toBe(true);
  expect(programmaticFocusAllowed(true, "unknown")).toBe(false);
  expect(programmaticFocusAllowed(true, "software")).toBe(false);
});

test("an editor takes focus only from nothing, the page, or its terminal", () => {
  const body = { name: "body" };
  const xtermInput = { name: "xterm textarea" };
  const otherField = { name: "search field" };
  const terminal = { contains: (node: unknown) => node === xtermInput };

  expect(editorMayTakeFocus(null, body, terminal, true)).toBe(true);
  expect(editorMayTakeFocus(body, body, terminal, true)).toBe(true);
  expect(editorMayTakeFocus(xtermInput, body, terminal, true)).toBe(true);
  expect(editorMayTakeFocus(otherField, body, terminal, true)).toBe(false);
  expect(editorMayTakeFocus(body, body, null, true)).toBe(true);

  // Without programmatic focus (touch, no hardware keyboard): never.
  expect(editorMayTakeFocus(null, body, terminal, false)).toBe(false);
  expect(editorMayTakeFocus(body, body, terminal, false)).toBe(false);
  expect(editorMayTakeFocus(xtermInput, body, terminal, false)).toBe(false);
});
