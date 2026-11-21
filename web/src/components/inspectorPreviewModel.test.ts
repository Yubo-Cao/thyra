import { expect, test } from "bun:test";
import type { FileExplorerEntry } from "../types";
import {
  previewKind,
  previewNeighbor,
  previewParent,
} from "./inspectorPreviewModel";

test("preview paths preserve the root and select the appropriate viewer", () => {
  expect(previewParent("photo.png")).toBe("");
  expect(previewParent("/photo.png")).toBe("/");
  expect(previewParent("/")).toBe("/");
  expect(previewParent("C:/photo.png")).toBe("C:/");
  expect(previewKind("photo.PNG")).toBe("image");
  expect(previewKind("notes.markdown")).toBe("markdown");
  expect(previewKind("thing.ts")).toBe("text");
});

test("horizontal image navigation skips directories and non-images", () => {
  const entries = ["first.png", "folder.png", "notes.md", "last.png"].map(
    (path, index): FileExplorerEntry => ({
      name: path,
      path,
      size: 0,
      mtime_ms: 0,
      hidden: false,
      type: index === 1 ? "directory" : "file",
    }),
  );
  expect(previewNeighbor(entries, "first.png", 1, true)?.path).toBe("last.png");
  expect(previewNeighbor(entries, "first.png", 1, false)?.path).toBe(
    "folder.png",
  );
  expect(previewNeighbor(entries, "last.png", 1, true)).toBeUndefined();
});
