import { expect, test } from "bun:test";
import {
  activateTerminalComposerDraftScope,
  terminalComposerDraftKey,
  readComposerImages,
  readTerminalComposerDraft,
  uploadTerminalComposerImages,
  insertIntoTerminalComposerDraft,
  clearTerminalComposerDraft,
  submitTerminalComposerDraft,
} from "./terminalComposer";

test("thumbnail exists during upload, survives failed send and clears on success", async () => {
  activateTerminalComposerDraftScope("images", 1);
  const key = terminalComposerDraftKey("images", 1, "pane");
  let complete!: (path: string) => void;
  const file = new File(["image"], "photo.png", { type: "image/png" });
  const uploading = uploadTerminalComposerImages(
    key,
    [file],
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    insertIntoTerminalComposerDraft,
  );
  expect(readComposerImages(key)[0].file).toBe(file);
  expect(readComposerImages(key)[0].path).toBeNull();
  complete("/tmp/photo.png");
  await uploading;
  expect(readComposerImages(key)[0].path).toBe("/tmp/photo.png");
  await expect(
    submitTerminalComposerDraft(
      key,
      readTerminalComposerDraft(key),
      async () => {
        throw new Error("offline");
      },
    ),
  ).rejects.toThrow("offline");
  expect(readComposerImages(key)).toHaveLength(1);
  await submitTerminalComposerDraft(
    key,
    readTerminalComposerDraft(key),
    async () => {},
  );
  expect(readComposerImages(key)).toHaveLength(0);
});
test("clearing a pending upload prevents it from restoring the attachment or path", async () => {
  activateTerminalComposerDraftScope("images", 2);
  const key = terminalComposerDraftKey("images", 2, "pane");
  let complete!: (path: string) => void;
  const uploading = uploadTerminalComposerImages(
    key,
    [new File(["image"], "photo.png")],
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    insertIntoTerminalComposerDraft,
  );
  clearTerminalComposerDraft(key);
  complete("/tmp/photo.png");
  await uploading;
  expect(readComposerImages(key)).toHaveLength(0);
  expect(readTerminalComposerDraft(key)).toBe("");
});
