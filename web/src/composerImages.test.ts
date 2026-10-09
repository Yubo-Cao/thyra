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
  composerImageToken,
  expandComposerImageTokens,
  writeTerminalComposerDraft,
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
    (target, path) => insertIntoTerminalComposerDraft(target, path),
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
    (target, path) => insertIntoTerminalComposerDraft(target, path),
  );
  clearTerminalComposerDraft(key);
  complete("/tmp/photo.png");
  await uploading;
  expect(readComposerImages(key)).toHaveLength(0);
  expect(readTerminalComposerDraft(key)).toBe("");
});

test("a pasted image's placeholder sends as its path and survives undo", async () => {
  activateTerminalComposerDraftScope("images", 3);
  const key = terminalComposerDraftKey("images", 3, "pane");
  writeTerminalComposerDraft(key, "look: ");
  await uploadTerminalComposerImages(
    key,
    [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ],
    async (file) => `/tmp/up/${file.name}`,
    (target, _path, image) =>
      insertIntoTerminalComposerDraft(target, composerImageToken(image.ref)),
  );
  expect(readTerminalComposerDraft(key)).toBe("look: [Image #1] [Image #2] ");
  expect(readComposerImages(key).map((image) => image.ref)).toEqual([1, 2]);
  // Deleting a placeholder keeps its image, so undo brings it back whole.
  writeTerminalComposerDraft(key, "look: [Image #2]");
  writeTerminalComposerDraft(key, "look: [Image #1] and [image 2 PNG]");
  let sent = "";
  await submitTerminalComposerDraft(
    key,
    readTerminalComposerDraft(key),
    async (text) => {
      sent = text;
    },
  );
  expect(sent).toBe("look: /tmp/up/a.png and /tmp/up/b.png");
  expect(readComposerImages(key)).toHaveLength(0);
  // A placeholder with no image of its own is sent as written.
  expect(expandComposerImageTokens("[Image #9]", [])).toBe("[Image #9]");
});
