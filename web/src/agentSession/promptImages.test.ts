import { describe, expect, test } from "bun:test";
import {
  promptForSend,
  splitPromptImages,
  unplacedPromptImages,
} from "./promptImages";

const attached = [
  { ref: 1, path: "/tmp/herdr-img-a.png" },
  { ref: 2, path: "/tmp/herdr-img-b.jpg" },
  { ref: 5, path: "/tmp/herdr-img-c.png" },
];

describe("a prompt's images on send", () => {
  test("text without placeholders goes as typed, without images", () => {
    expect(promptForSend("fix the tests", attached)).toEqual({
      text: "fix the tests",
      images: [],
    });
  });

  test("images go in the order their placeholders appear, numbered from 1", () => {
    expect(
      promptForSend("compare [Image #5] with [Image #1] please", attached),
    ).toEqual({
      text: "compare [Image #1] with [Image #2] please",
      images: [
        { path: "/tmp/herdr-img-c.png" },
        { path: "/tmp/herdr-img-a.png" },
      ],
    });
  });

  test("an image whose placeholder was deleted is left out", () => {
    const { text, images } = promptForSend("only [Image #2] ", attached);
    expect(text).toBe("only [Image #1] ");
    expect(images).toEqual([{ path: "/tmp/herdr-img-b.jpg" }]);
  });

  test("a placeholder written twice names one image", () => {
    expect(promptForSend("[Image #2] and again [Image #2]", attached)).toEqual({
      text: "[Image #1] and again [Image #1]",
      images: [{ path: "/tmp/herdr-img-b.jpg" }],
    });
  });

  test("a placeholder without an uploaded image stays as written", () => {
    expect(
      promptForSend("[Image #9] [Image #3] [Image #1]", [
        ...attached,
        { ref: 3, path: null },
      ]),
    ).toEqual({
      text: "[Image #9] [Image #3] [Image #1]",
      images: [{ path: "/tmp/herdr-img-a.png" }],
    });
  });

  test("a draft that is only images keeps its placeholders as the text", () => {
    expect(promptForSend("[Image #2] ", attached)).toEqual({
      text: "[Image #1] ",
      images: [{ path: "/tmp/herdr-img-b.jpg" }],
    });
  });

  test("the result is the same when sent again", () => {
    // The pattern is shared and global: no state may carry between calls.
    const first = promptForSend("[Image #1] x [Image #2]", attached);
    expect(promptForSend("[Image #1] x [Image #2]", attached)).toEqual(first);
  });
});

describe("a user item's images in its text", () => {
  test("text is cut at the placeholders of images the item has", () => {
    expect(splitPromptImages("see [Image #2] and [Image #1].", 2)).toEqual([
      "see ",
      1,
      " and ",
      0,
      ".",
    ]);
    expect(splitPromptImages("[Image #1]", 1)).toEqual([0]);
  });

  test("a number without an image, and other brackets, stay text", () => {
    expect(splitPromptImages("[Image #3] [Image #0] [image 1]", 2)).toEqual([
      "[Image #3] [Image #0] [image 1]",
    ]);
    expect(splitPromptImages("plain", 0)).toEqual(["plain"]);
    expect(splitPromptImages("", 2)).toEqual([]);
  });

  test("images nothing shows in the text are listed", () => {
    expect(unplacedPromptImages("see [Image #2]", 3)).toEqual([0, 2]);
    expect(unplacedPromptImages("[Image #1] [Image #2]", 2)).toEqual([]);
    expect(unplacedPromptImages("", 1)).toEqual([0]);
  });

  test("a placeholder written as code does not show its image", () => {
    expect(unplacedPromptImages("the token `[Image #1]` here", 1)).toEqual([0]);
    expect(
      unplacedPromptImages("```\n[Image #1]\n```\nand [Image #2]", 2),
    ).toEqual([0]);
    // An unclosed fence runs to the end, as it renders.
    expect(unplacedPromptImages("~~~\n[Image #1]", 1)).toEqual([0]);
  });
});
