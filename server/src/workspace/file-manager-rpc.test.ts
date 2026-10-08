import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "../bridge/herdr-client";
import { shQuote } from "../utils/process-utils";
import { createFileHandlers } from "./files";
import { createThumbnailService } from "./file-thumbnails";

let root = "";
let workspace = "";
let outside = "";
const previousData = process.env.XDG_DATA_HOME;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "thyra-file-rpc-")));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, "src/a.txt"), "a");
  await writeFile(join(outside, "secret.txt"), "secret");
  process.env.XDG_DATA_HOME = join(root, "data");
});

afterEach(async () => {
  if (previousData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousData;
  await rm(root, { recursive: true, force: true });
});

function handlers() {
  return createFileHandlers({
    herdr: {
      call: async (_method: string, params: { workspace_id: string }) => ({
        workspace: {
          workspace_id: params.workspace_id,
          label: "Workspace",
          cwd: workspace,
        },
      }),
    } as unknown as HerdrClient,
    sshHost: () => undefined,
    runProcessWithCodeTimeout: async () => {
      throw new Error("Unexpected remote call");
    },
    shQuote,
    thumbnails: createThumbnailService({ cacheDir: join(root, "thumbs") }),
  });
}

const traversals = [
  "../outside/secret.txt",
  "src/../../outside",
  "..",
  "a/../..",
];

test("workspace-scope file-manager calls cannot leave the checkout", async () => {
  const { fileRpc } = handlers();
  const call = (method: string, params: Record<string, unknown>) =>
    fileRpc[method]!({ workspace_id: "w1", ...params });
  for (const path of traversals) {
    for (const [method, params] of [
      ["file.rename", { path, name: "x" }],
      ["file.transfer", { paths: [path], destination: "src", mode: "copy" }],
      [
        "file.transfer",
        { paths: ["src/a.txt"], destination: path, mode: "move" },
      ],
    ] as const) {
      await expect(call(method, params)).rejects.toThrow(
        "invalid file explorer path",
      );
    }
  }
  // Leading slashes stay checkout-relative in workspace scope.
  const copied = (await call("file.transfer", {
    paths: ["/src/a.txt"],
    destination: "/",
    mode: "copy",
  })) as { items: Array<{ path: string }> };
  expect(copied.items[0]?.path).toBe("a.txt");
  expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("a");
  // The checkout root itself is never renamed, moved or trashed.
  await expect(call("file.rename", { path: "", name: "x" })).rejects.toThrow();
  await expect(
    call("file.transfer", { paths: [""], destination: "src", mode: "move" }),
  ).rejects.toThrow();
  await expect(
    call("file.rename", { path: "src/a.txt", name: "../../escape" }),
  ).rejects.toThrow("invalid file name");
  expect(await readdir(outside)).toEqual(["secret.txt"]);
});

test("thumbnail paths cannot leave the checkout", async () => {
  const { thumbnailWorkspaceFile } = handlers();
  for (const path of traversals) {
    await expect(
      thumbnailWorkspaceFile({ workspace_id: "w1", path: `${path}/a.png` }),
    ).rejects.toThrow("invalid file explorer path");
  }
});

test("thumbnails come from the bridge codec and the disk cache", async () => {
  const { thumbnailWorkspaceFile } = handlers();
  // A 300x200 PNG made with the same codec.
  const source = await new Bun.Image(
    await new Bun.Image(
      join(import.meta.dir, "../../../web/public/thyra-icon-192.png"),
    )
      .resize(300, 200)
      .png()
      .bytes(),
  ).bytes();
  await writeFile(join(workspace, "src/photo.png"), source);
  const params = {
    workspace_id: "w1",
    path: "src/photo.png",
    size: "100",
    mtime: "1",
    bytes: String(source.length),
  };
  const response = await thumbnailWorkspaceFile(params);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/webp");
  const meta = await new Bun.Image(
    new Uint8Array(await response.arrayBuffer()),
  ).metadata();
  expect(meta).toEqual({ width: 128, height: 85, format: "webp" });
  // Cached by path, mtime and size: deleting the source keeps serving it.
  await rm(join(workspace, "src/photo.png"));
  expect((await thumbnailWorkspaceFile(params)).status).toBe(200);
  expect((await thumbnailWorkspaceFile({ ...params, mtime: "2" })).status).toBe(
    204,
  );
  expect(
    (await thumbnailWorkspaceFile({ ...params, path: "src/a.txt" })).status,
  ).toBe(204);
});
