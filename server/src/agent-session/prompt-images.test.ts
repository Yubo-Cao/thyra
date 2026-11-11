import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PROMPT_IMAGE_LIMIT,
  AGENT_PROMPT_IMAGE_MAX_BYTES,
} from "../../../shared/agentSession";
import { AgentActionError } from "./adapter";
import {
  checkPromptImages,
  imageTypeOf,
  readPromptImage,
} from "./prompt-images";
import { tinyImage, uploadedImage } from "./test-support";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "thyra-pi-"));
  roots.push(root);
  return root;
}

test("an image's format is what its first bytes say", () => {
  expect(imageTypeOf(tinyImage("png"))).toBe("image/png");
  expect(imageTypeOf(tinyImage("jpeg"))).toBe("image/jpeg");
  expect(imageTypeOf(tinyImage("gif"))).toBe("image/gif");
  expect(imageTypeOf(tinyImage("webp"))).toBe("image/webp");
  expect(imageTypeOf(Buffer.from("GIF87a..."))).toBe("image/gif");
  for (const other of [
    "",
    "GIF",
    "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "%PDF-1.7 and more",
    "RIFF....WAVEfmt ",
    "BM a bitmap header",
    "\u0089PNG without the rest of the signature",
  ])
    expect(imageTypeOf(Buffer.from(other, "latin1"))).toBeNull();
  // A truncated signature is not one.
  expect(imageTypeOf(tinyImage("png").subarray(0, 7))).toBeNull();
});

test("checked images keep their order and take their type from their bytes", async () => {
  const dir = tempDir();
  // The names lie about the formats; the bytes decide.
  const images = [
    { path: uploadedImage(dir, tinyImage("jpeg"), "png") },
    { path: uploadedImage(dir, tinyImage("gif"), "webp") },
    { path: uploadedImage(dir, tinyImage("webp"), "jpg") },
    { path: uploadedImage(dir, tinyImage("png"), "gif") },
  ];
  const checked = await checkPromptImages(images);
  expect(checked).toEqual([
    { path: images[0]!.path, mediaType: "image/jpeg" },
    { path: images[1]!.path, mediaType: "image/gif" },
    { path: images[2]!.path, mediaType: "image/webp" },
    { path: images[3]!.path, mediaType: "image/png" },
  ]);
  expect(await readPromptImage(checked[3]!, 4)).toEqual(tinyImage("png"));
  expect(await checkPromptImages([])).toEqual([]);

  // A file exactly at the limit is taken; its bytes are read whole.
  const full = uploadedImage(dir);
  truncateSync(full, AGENT_PROMPT_IMAGE_MAX_BYTES);
  const [atLimit] = await checkPromptImages([{ path: full }]);
  expect(atLimit).toEqual({ path: full, mediaType: "image/png" });
  expect(await readPromptImage(atLimit!, 1)).toHaveLength(
    AGENT_PROMPT_IMAGE_MAX_BYTES,
  );
});

test("one bad image refuses the prompt, naming the image", async () => {
  const dir = tempDir();
  const good = { path: uploadedImage(dir) };
  const refusal = async (path: string) => {
    const failure = await checkPromptImages([good, { path }]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentActionError);
    return (failure as Error).message;
  };

  expect(await refusal(join(dir, "herdr-img-1-gone.png"))).toBe(
    "image 2 is no longer on the host",
  );
  expect(await refusal("")).toBe("image 2 is no longer on the host");
  expect(await refusal(join(good.path, "below-a-file.png"))).toBe(
    "image 2 is no longer on the host",
  );

  const text = uploadedImage(dir, Buffer.from("just some text, not an image"));
  expect(await refusal(text)).toBe(
    "image 2 is not a PNG, JPEG, GIF or WebP file",
  );
  expect(await refusal(uploadedImage(dir, new Uint8Array(0)))).toBe(
    "image 2 is not a PNG, JPEG, GIF or WebP file",
  );
  const svg = uploadedImage(dir, Buffer.from("<svg/>"), "svg");
  expect(await refusal(svg)).toBe(
    "image 2 is not a PNG, JPEG, GIF or WebP file",
  );

  const large = uploadedImage(dir);
  truncateSync(large, AGENT_PROMPT_IMAGE_MAX_BYTES + 1);
  expect(await refusal(large)).toBe("image 2 is larger than 3.5 MB");

  // Never through a link, even to a real image of the user's own, and
  // never a directory or a pipe put where a file is expected.
  const link = join(dir, "herdr-img-2-link.png");
  symlinkSync(good.path, link);
  expect(await refusal(link)).toBe("image 2 is not a regular file");
  const folder = join(dir, "herdr-img-3-folder.png");
  mkdirSync(folder);
  expect(await refusal(folder)).toBe("image 2 is not a regular file");
  const pipe = join(dir, "herdr-img-4-pipe.png");
  if (Bun.spawnSync(["mkfifo", pipe]).exitCode === 0)
    expect(await refusal(pipe)).toBe("image 2 is not a regular file");

  // A file of another user's, whatever it holds.
  if (process.getuid?.() !== 0)
    expect(await refusal("/etc/hostname")).toBe(
      "image 2 does not belong to the session's user",
    );
  const unreadable = uploadedImage(dir);
  chmodSync(unreadable, 0o000);
  if (process.getuid?.() !== 0)
    expect(await refusal(unreadable)).toBe(
      "image 2 cannot be read on the host",
    );

  // The first failure is the one reported.
  expect(
    await checkPromptImages([{ path: text }, { path: large }]).catch(
      (error: Error) => error.message,
    ),
  ).toBe("image 1 is not a PNG, JPEG, GIF or WebP file");
  await expect(
    checkPromptImages(
      Array.from({ length: AGENT_PROMPT_IMAGE_LIMIT + 1 }, () => good),
    ),
  ).rejects.toThrow("a prompt takes at most 10 images");

  // A file that changed after it was checked is checked again when read.
  const [checked] = await checkPromptImages([good]);
  writeFileSync(good.path, Buffer.alloc(AGENT_PROMPT_IMAGE_MAX_BYTES + 1));
  await expect(readPromptImage(checked!, 1)).rejects.toThrow(
    "image 1 is larger than 3.5 MB",
  );
  rmSync(good.path);
  await expect(readPromptImage(checked!, 3)).rejects.toThrow(
    "image 3 is no longer on the host",
  );
});
