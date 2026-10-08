import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunHostScript, parseHostTools, runHostScript } from "./file-host";
import {
  createThumbnailService,
  snapThumbnailSize,
  thumbnailKind,
  thumbnailTool,
} from "./file-thumbnails";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thyra-thumbs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const icon = join(import.meta.dir, "../../../web/public/thyra-icon-512.png");

test("kinds, sizes and tools", () => {
  expect(thumbnailKind("/a/B.JPG")).toBe("raster");
  expect(thumbnailKind("clip.webm")).toBe("video");
  expect(thumbnailKind("scan.tiff")).toBe("image");
  expect(thumbnailKind("doc.pdf")).toBe("pdf");
  expect(thumbnailKind("notes.svg")).toBeNull();
  expect(snapThumbnailSize("20")).toBe(64);
  expect(snapThumbnailSize("120")).toBe(128);
  expect(snapThumbnailSize("4000")).toBe(256);
  const { tools } = parseHostTools("TOOL\tffmpeg\nTOOL\tpdftoppm\n");
  expect(thumbnailTool("video", tools)).toBe("ffmpeg");
  expect(thumbnailTool("pdf", tools)).toBe("pdftoppm");
  expect(thumbnailTool("image", new Set())).toBeNull();
});

test("SSH thumbnails batch into one session and use host tools", async () => {
  const sessions: string[] = [];
  const run: RunHostScript = (host, script, options) => {
    sessions.push(host ?? "local");
    return runHostScript(undefined, script, options);
  };
  const has = (tool: string) => Bun.which(tool) !== null;
  const service = createThumbnailService({
    cacheDir: join(root, "cache"),
    run,
    probe: async () =>
      parseHostTools(
        ["ffmpeg", "pdftoppm"]
          .filter(has)
          .map((tool) => `TOOL\t${tool}`)
          .join("\n"),
      ),
  });
  await copyFile(icon, join(root, "a.png"));
  await writeFile(join(root, "broken.jpg"), "not an image");
  const requests = [
    { path: join(root, "a.png"), bytes: 1000 },
    { path: join(root, "broken.jpg"), bytes: 12 },
  ];
  if (has("ffmpeg")) {
    const video = Bun.spawn(
      [
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=320x240:rate=5",
        join(root, "clip.mp4"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await video.exited;
    requests.push({ path: join(root, "clip.mp4"), bytes: 5_000_000 });
  }
  const results = await Promise.all(
    requests.map((request) =>
      service.thumbnail({ host: "remote", mtimeMs: 1, size: 64, ...request }),
    ),
  );
  expect(sessions).toEqual(["remote"]);
  expect(results[0]?.length).toBeGreaterThan(0);
  expect(results[1]).toBeNull();
  if (results[2] !== undefined) {
    const meta = await new Bun.Image(results[2]!).metadata();
    expect(meta).toEqual({ width: 64, height: 48, format: "webp" });
  }
  // A failure is remembered instead of retried for every scroll.
  await service.thumbnail({
    host: "remote",
    mtimeMs: 1,
    size: 64,
    ...requests[1]!,
  });
  expect(sessions).toEqual(["remote"]);
});

test("without a cache directory thumbnails are still generated", async () => {
  const service = createThumbnailService({ cacheDir: null });
  const bytes = await service.thumbnail({
    host: undefined,
    path: icon,
    mtimeMs: 1,
    bytes: 1,
    size: 256,
  });
  expect((await new Bun.Image(bytes!).metadata()).width).toBe(256);
});
