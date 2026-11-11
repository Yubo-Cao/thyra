import { afterEach, expect, test } from "bun:test";
import {
  agentComposerDraftKey,
  readComposerImages,
  readTerminalComposerDraft,
  resetTerminalComposerForTest,
} from "../terminalComposer";
import {
  promptActionBlock,
  promptImageFiles,
  putPromptInDraft,
  type UserItem,
} from "./editPrompt";
import { promptForSend } from "./promptImages";

afterEach(() => resetTerminalComposerForTest());

const prompt: UserItem = {
  id: "u1",
  type: "user",
  text: "compare [Image #1] with [Image #2]",
  images: [{ path: "/tmp/a.png" }, { path: "/tmp/gone.png" }],
  ref: "uuid-1",
  at: 1,
};

test("prompt actions wait for an idle session, and need a host that offers them", () => {
  const info = { status: "idle", can_rewind: true };
  expect(promptActionBlock(info, true)).toBeNull();
  expect(promptActionBlock({ ...info, status: "running" }, true)).toBe("busy");
  expect(promptActionBlock({ ...info, status: "starting" }, true)).toBe("busy");
  expect(promptActionBlock({ ...info, status: "exited" }, true)).toBe(
    "unsupported",
  );
  expect(promptActionBlock(info, false)).toBe("unsupported");
  expect(promptActionBlock({ status: "idle" }, true)).toBe("unsupported");
});

test("a prompt's images come back as files; one that does not load keeps its path", async () => {
  const files = await promptImageFiles(
    prompt,
    (path) => (path.includes("gone") ? `/missing${path}` : `/img${path}`),
    async (url) => {
      if (url.startsWith("/missing")) throw new Error("404");
      return new Blob(["png"], { type: "image/png" });
    },
  );
  expect(
    files.map(({ path, file }) => [path, file.name, file.type, file.size]),
  ).toEqual([
    ["/tmp/a.png", "a.png", "image/png", 3],
    ["/tmp/gone.png", "gone.png", "", 0],
  ]);
  expect(
    await promptImageFiles({ ...prompt, images: undefined }, undefined),
  ).toEqual([]);
});

test("an edited prompt fills the draft and sends as it was", async () => {
  const key = agentComposerDraftKey("c1", "w1:p1");
  await putPromptInDraft(key, prompt, () => null);
  expect(readTerminalComposerDraft(key)).toBe(prompt.text);
  const images = readComposerImages(key);
  expect(images.map(({ ref, path }) => ({ ref, path }))).toEqual([
    { ref: 1, path: "/tmp/a.png" },
    { ref: 2, path: "/tmp/gone.png" },
  ]);
  // Sent again unchanged, it is the same prompt.
  expect(promptForSend(readTerminalComposerDraft(key), images)).toEqual({
    text: prompt.text,
    images: prompt.images!,
  });
  // What the box held before is replaced.
  await putPromptInDraft(
    key,
    { ...prompt, text: "plain", images: [] },
    () => null,
  );
  expect(readTerminalComposerDraft(key)).toBe("plain");
  expect(readComposerImages(key)).toEqual([]);
});
