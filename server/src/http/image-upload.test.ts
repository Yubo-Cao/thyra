import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createImageUploadHandler,
  IMAGE_UPLOAD_MAX_BYTES,
  isUploadedImagePath,
} from "./image-upload";

const upload = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://x/api/upload-image", { method: "POST", body, headers });

test("stores a pasted image privately under an unguessable name", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thyra-image-"));
  try {
    const handle = createImageUploadHandler({
      sshHost: () => undefined,
      directory,
    });
    const paths: string[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await handle(
        upload(new Uint8Array([1, 2, 3]), { "x-image-ext": "../JPG" }),
      );
      expect(response.status).toBe(200);
      const { path, remote } = (await response.json()) as {
        path: string;
        remote: boolean;
      };
      expect(remote).toBe(false);
      expect(basename(path)).toMatch(/^herdr-img-\d+-[0-9a-f]{32}\.jpg$/);
      // What the handler gives out is what the predicate takes back.
      expect(isUploadedImagePath(path, directory)).toBe(true);
      expect(isUploadedImagePath(path)).toBe(false);
      expect([...readFileSync(path)]).toEqual([1, 2, 3]);
      if (process.platform !== "win32")
        expect(statSync(path).mode & 0o777).toBe(0o600);
      paths.push(path);
    }
    expect(paths[0]).not.toBe(paths[1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses empty and oversized images before buffering them", async () => {
  const handle = createImageUploadHandler({ sshHost: () => undefined });
  expect((await handle(upload(new Uint8Array(0)))).status).toBe(400);
  let pulled = 0;
  const declared = await handle(
    upload(
      new ReadableStream(
        {
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1));
          },
        },
        { highWaterMark: 0 },
      ),
      { "content-length": String(IMAGE_UPLOAD_MAX_BYTES + 1) },
    ),
  );
  expect(declared.status).toBe(413);
  expect(pulled).toBe(0);
});

test("only paths the handler makes count as uploaded images", () => {
  const name = `herdr-img-1794421797123-${"0123456789abcdef".repeat(2)}`;
  for (const path of [
    `/tmp/${name}.png`,
    `/tmp/${name}.jpeg`,
    `/tmp/${name}.x`,
  ])
    expect(isUploadedImagePath(path)).toBe(true);
  // Any other file of the host, however it is spelled.
  for (const path of [
    "/etc/passwd",
    "/home/user/.ssh/id_ed25519",
    "/tmp/notes.png",
    `/tmp/../etc/${name}.png`,
    `/tmp/sub/${name}.png`,
    `/tmp//${name}.png`,
    `/var/tmp/${name}.png`,
    `tmp/${name}.png`,
    `${name}.png`,
    `/tmp/${name}`,
    `/tmp/${name}.`,
    `/tmp/${name}.png/..`,
    `/tmp/${name}.PNG`,
    `/tmp/${name}.png\n`,
    `/tmp/${name.replace("0123", "012")}.png`,
    `/tmp/${name.replace("abcdef", "ABCDEF")}.png`,
    `/tmp/herdr-img--${"0".repeat(32)}.png`,
    "",
    undefined,
    null,
    7,
    { path: `/tmp/${name}.png` },
  ])
    expect(isUploadedImagePath(path)).toBe(false);
});
