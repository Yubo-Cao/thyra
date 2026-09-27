import { expect, test } from "bun:test";
import { previewText } from "./TerminalPreview";

test("text previews drop carriage returns and reject other replies", () => {
  expect(previewText({ text: "a\r\nb\r", truncated: false })).toBe("a\nb");
  expect(previewText({ text: 3 })).toBeNull();
  expect(previewText(null)).toBeNull();
});
