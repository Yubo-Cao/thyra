import { describe, expect, test } from "bun:test";
import { AGENT_PROMPT_IMAGE_MAX_BYTES } from "../../../shared/agentSession";
import {
  fitPromptImage,
  promptImageEdges,
  promptImageFits,
  redrawnImageName,
} from "./promptImageFile";

describe("preparing an image for a prompt", () => {
  test("an accepted format within the size limit uploads as it is", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      expect(promptImageFits({ type, size: 200_000 })).toBe(true);
    expect(
      promptImageFits({
        type: "image/png",
        size: AGENT_PROMPT_IMAGE_MAX_BYTES,
      }),
    ).toBe(true);
  });

  test("a larger file or another format is redrawn", () => {
    expect(
      promptImageFits({
        type: "image/jpeg",
        size: AGENT_PROMPT_IMAGE_MAX_BYTES + 1,
      }),
    ).toBe(false);
    for (const type of [
      "image/heic",
      "image/bmp",
      "image/avif",
      "image/svg+xml",
      "image/tiff",
      "",
    ])
      expect(promptImageFits({ type, size: 1000 })).toBe(false);
  });

  test("a redraw keeps the shape with the long edge at the limit", () => {
    expect(fitPromptImage(6000, 4000, 2000)).toEqual({
      width: 2000,
      height: 1333,
    });
    expect(fitPromptImage(1200, 4800, 2000)).toEqual({
      width: 500,
      height: 2000,
    });
    // Never enlarged, and never without a pixel.
    expect(fitPromptImage(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    expect(fitPromptImage(10_000, 2, 2000)).toEqual({ width: 2000, height: 1 });
  });

  test("tries start at 2000 pixels or the image's own size and shrink", () => {
    expect(promptImageEdges(6000)).toEqual([
      2000, 1500, 1125, 844, 633, 475, 356,
    ]);
    expect(promptImageEdges(1000)).toEqual([1000, 750, 563, 422]);
    // A small image in another format still gets its one redraw.
    expect(promptImageEdges(64)).toEqual([64]);
  });

  test("a redrawn file is named for its new format", () => {
    expect(redrawnImageName("Screenshot 2026-11-11.heic", "image/jpeg")).toBe(
      "Screenshot 2026-11-11.jpg",
    );
    expect(redrawnImageName("diagram.v2.bmp", "image/png")).toBe(
      "diagram.v2.png",
    );
    expect(redrawnImageName("photo", "image/jpeg")).toBe("photo.jpg");
    expect(redrawnImageName("", "image/png")).toBe("image.png");
  });
});
