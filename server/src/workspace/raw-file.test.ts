import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { rawWorkspaceResponse } from "./raw-file";

for (const host of [undefined, "fixture"]) {
  test(`raw preview validates, refreshes and serves ranges (${host ? "SSH command" : "local"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "thyra-raw-preview-"));
    try {
      const name = "image.png";
      const request = (init?: RequestInit, path = name, grant = false) =>
        rawWorkspaceResponse({
          root,
          path,
          request: new Request("http://localhost", init),
          host,
          // Exercise the real shell without contacting a remote host.
          runProcessWithCodeTimeout: (argv, timeout) =>
            runProcessWithCodeTimeout(["sh", "-c", argv.at(-1)!], timeout),
          shQuote,
          grant,
        });
      await writeFile(join(root, name), "first");
      const image = await request();
      expect(await image.text()).toBe("first");
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(image.headers.get("cache-control")).toContain("no-cache");
      expect(image.headers.get("last-modified")).toBeTruthy();
      const etag = image.headers.get("etag")!;
      const same = await request({
        headers: { "If-None-Match": `"other", W/${etag}` },
      });
      expect(same.status).toBe(304);
      expect(await same.text()).toBe("");
      const head = await request({ method: "HEAD" });
      expect(head.headers.get("etag")).toBe(etag);
      expect(await head.text()).toBe("");
      await writeFile(join(root, name), "fresh!");
      const updated = await request({ headers: { "If-None-Match": etag } });
      expect(updated.status).toBe(200);
      expect(updated.headers.get("etag")).not.toBe(etag);
      expect(await updated.text()).toBe("fresh!");
      const range = await request({ headers: { Range: "bytes=1-3" } });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toBe("bytes 1-3/6");
      expect(await range.text()).toBe("res");
      await symlink("..", join(root, "escape"));
      expect((await request(undefined, "escape")).status).toBe(404);

      await writeFile(
        join(root, "index.html"),
        '<script src="app.js"></script>',
      );
      const html = await request(undefined, "index.html", true);
      expect(html.headers.get("content-security-policy")).toContain(
        "sandbox allow-scripts",
      );
      expect(html.headers.get("access-control-allow-origin")).toBe("*");
      expect(await html.text()).toContain('<script src="app.js"></script>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
