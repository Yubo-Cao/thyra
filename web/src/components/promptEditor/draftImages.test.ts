import { beforeEach, describe, expect, test } from "bun:test";
import {
  agentComposerDraftKey,
  activateTerminalComposerDraftScope,
  clearTerminalComposerDraft,
  composerImageUrl,
  pastedImageHistory,
  readComposerImages,
  readTerminalComposerDraft,
  resetPastedImageHistory,
  resetTerminalComposerForTest,
  terminalComposerDraftKey,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../../terminalComposer";
import {
  attachDraftImages,
  draftImageStrip,
  draftPromptImages,
} from "./draftImages";

const png = (name: string) => new File(["image"], name, { type: "image/png" });

// The draft store is module state shared with other test files in a run.
beforeEach(() => {
  resetTerminalComposerForTest();
  resetPastedImageHistory();
});

describe("a draft's images", () => {
  test("an uploaded image becomes a placeholder at the editor's selection", async () => {
    const key = terminalComposerDraftKey("drafts", 1, "pane");
    writeTerminalComposerDraft(key, "before after");
    await attachDraftImages(
      key,
      [png("a.png")],
      async () => "/tmp/herdr-img-a.png",
      () => ({ start: 7, end: 7 }),
    );
    expect(readTerminalComposerDraft(key)).toBe("before [Image #1] after");
    expect(readComposerImages(key)).toMatchObject([
      { ref: 1, path: "/tmp/herdr-img-a.png" },
    ]);
    expect(terminalComposerUploadCount(key)).toBe(0);
  });

  test("without a selection the placeholder goes where the draft's caret was", async () => {
    const key = terminalComposerDraftKey("drafts", 1, "stored");
    writeTerminalComposerDraft(key, "ab");
    writeTerminalComposerSelection(key, 1, 1);
    await attachDraftImages(
      key,
      [png("a.png")],
      async () => "/tmp/a.png",
      () => null,
    );
    expect(readTerminalComposerDraft(key)).toBe("a [Image #1] b");
  });

  test("images number on from the pane's history, or within the draft alone", async () => {
    const key = terminalComposerDraftKey("drafts", 1, "history");
    const attach = (name: string, paneHistory?: boolean) =>
      attachDraftImages(
        key,
        [png(name)],
        async () => `/tmp/${name}`,
        () => null,
        paneHistory,
      );
    await attach("a.png");
    expect(pastedImageHistory(key)).toMatchObject([{ ref: 1 }]);
    // The draft is sent or cleared; the pane's agent counts on.
    clearTerminalComposerDraft(key);
    await attach("b.png");
    expect(readTerminalComposerDraft(key)).toBe("[Image #2] ");
    clearTerminalComposerDraft(key);
    await attach("c.png", false);
    expect(readTerminalComposerDraft(key)).toBe("[Image #1] ");
    // And leaves the history as it was.
    expect(pastedImageHistory(key).map((image) => image.ref)).toEqual([1, 2]);
  });

  test("a failed upload leaves the draft without the image and rejects", async () => {
    const key = terminalComposerDraftKey("drafts", 1, "failed");
    writeTerminalComposerDraft(key, "text");
    await expect(
      attachDraftImages(
        key,
        [png("a.png"), png("b.png")],
        async () => {
          throw new Error("offline");
        },
        () => null,
      ),
    ).rejects.toThrow("offline");
    expect(readTerminalComposerDraft(key)).toBe("text");
    expect(readComposerImages(key)).toEqual([]);
    expect(terminalComposerUploadCount(key)).toBe(0);
  });

  test("pasted images load from their files and named ones through the resolver", async () => {
    const key = terminalComposerDraftKey("drafts", 1, "sources");
    const file = png("a.png");
    await attachDraftImages(
      key,
      [file],
      async () => "/tmp/herdr-img-a.png",
      () => null,
    );
    const images = draftPromptImages(key, (source) => `/file?path=${source}`);
    const local = composerImageUrl({ file });
    expect(images.pasted(1, "[Image #1]")).toBe(local);
    expect(images.url("/tmp/herdr-img-a.png")).toBe(local);
    expect(images.url("./shot.png")).toBe("/file?path=./shot.png");
    // A number the draft does not have is the pane's latest paste.
    expect(images.pasted(4, "[Image #4]")).toBe(local);
    expect(images.atoms).toBe(false);
    expect(draftPromptImages(key).url("./shot.png")).toBeNull();
    expect(draftPromptImages(key, undefined, true).atoms).toBe(true);
  });

  test("the strip holds uploading images, or all the draft names under the plain surface", () => {
    const image = (ref: number, path: string | null) => ({
      id: String(ref),
      file: png(`${ref}.png`),
      path,
      ref,
    });
    const images = [
      image(1, "/tmp/1.png"),
      image(2, null),
      image(3, "/tmp/3.png"),
    ];
    const text = "see [Image #1]";
    expect(draftImageStrip(images, true, text).map((item) => item.ref)).toEqual(
      [2],
    );
    // An image whose placeholder was deleted is out of the strip too.
    expect(
      draftImageStrip(images, false, text).map((item) => item.ref),
    ).toEqual([1, 2]);
  });
});

describe("an agent prompt's draft", () => {
  test("its key is apart from the pane's terminal draft", () => {
    const key = agentComposerDraftKey("local", "w1:p1");
    expect(key).not.toBe(terminalComposerDraftKey("local", 1, "w1:p1"));
    expect(agentComposerDraftKey("local", "w1:p2")).not.toBe(key);
    expect(agentComposerDraftKey("other", "w1:p1")).not.toBe(key);
  });

  test("it stays, with its images, through reconnects and connection switches", async () => {
    activateTerminalComposerDraftScope("local", 1);
    const key = agentComposerDraftKey("local", "w1:p1");
    const terminal = terminalComposerDraftKey("local", 1, "w1:p1");
    writeTerminalComposerDraft(key, "look: ");
    writeTerminalComposerDraft(terminal, "typed into the terminal");
    await attachDraftImages(
      key,
      [png("a.png")],
      async () => "/tmp/herdr-img-a.png",
      () => null,
      false,
    );
    activateTerminalComposerDraftScope("local", 2);
    activateTerminalComposerDraftScope("other", 3);
    expect(readTerminalComposerDraft(terminal)).toBe("");
    expect(readTerminalComposerDraft(key)).toBe("look: [Image #1] ");
    expect(readComposerImages(key)).toHaveLength(1);
    // Kept out of the pane history, a number it does not have names nothing.
    const images = draftPromptImages(key);
    expect(images.pasted(1, "[Image #1]")).not.toBeNull();
    expect(images.pasted(4, "[Image #4]")).toBeNull();
    // Still writable outside the scope it was started in.
    writeTerminalComposerDraft(key, "look: [Image #1] again");
    expect(readTerminalComposerDraft(key)).toBe("look: [Image #1] again");
    clearTerminalComposerDraft(key);
    expect(readComposerImages(key)).toEqual([]);
  });
});
