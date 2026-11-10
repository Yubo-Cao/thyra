import { describe, expect, test } from "bun:test";
import { sameDigest } from "./digest";
import { escapeHtml } from "./html";
import {
  parseCookie,
  readBodyBytes,
  readJsonObject,
  RequestError,
} from "./request";

const post = (body: string, type = "application/json; charset=utf-8") =>
  new Request("http://x/", {
    method: "POST",
    body,
    headers: { "content-type": type },
  });

describe("readJsonObject", () => {
  test("parses objects and treats an empty body as {}", async () => {
    expect(await readJsonObject(post('{"a":1}'), 100)).toEqual({ a: 1 });
    expect(await readJsonObject(post(""), 100)).toEqual({});
  });

  test("rejects wrong type, size, and shape", async () => {
    const status = async (req: Request) =>
      readJsonObject(req, 10).catch((e: RequestError) => e.status);
    expect(await status(post("{}", "text/plain"))).toBe(415);
    expect(await status(post(`{"a":"${"x".repeat(20)}"}`))).toBe(413);
    expect(await status(post("{"))).toBe(400);
    expect(await status(post("[]"))).toBe(400);
  });
});

describe("readBodyBytes", () => {
  test("returns the body up to the limit", async () => {
    const body = await readBodyBytes(post("hello"), 5);
    expect(new TextDecoder().decode(body)).toBe("hello");
    expect(
      (await readBodyBytes(new Request("http://x/", { method: "POST" }), 5))
        .byteLength,
    ).toBe(0);
  });

  test("refuses a larger Content-Length without reading the body", async () => {
    let pulled = 0;
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-length": "11" },
      body: new ReadableStream(
        {
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1));
          },
        },
        { highWaterMark: 0 },
      ),
    });
    const error = await readBodyBytes(req, 10).catch((e: RequestError) => e);
    expect((error as RequestError).status).toBe(413);
    expect(pulled).toBe(0);
  });

  test("stops reading a stream that passes the limit", async () => {
    let pulled = 0;
    let cancelled = false;
    const req = new Request("http://x/", {
      method: "POST",
      body: new ReadableStream(
        {
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(4));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    });
    const error = await readBodyBytes(req, 10).catch((e: RequestError) => e);
    expect((error as RequestError).status).toBe(413);
    expect(pulled).toBe(3);
    expect(cancelled).toBe(true);
  });

  test("counts bytes, not characters", async () => {
    const status = (req: Request) =>
      readJsonObject(req, 12).catch((e: RequestError) => e.status);
    expect(await status(post('{"a":"\u00e9\u00e9\u00e9"}'))).toBe(413);
  });
});

test("parseCookie decodes values and tolerates malformed ones", () => {
  expect(parseCookie("a=1; b=x%20y", "b")).toBe("x y");
  expect(parseCookie("a=%E0%A4%A", "a")).toBeNull();
  expect(parseCookie(null, "a")).toBeNull();
  expect(parseCookie("a=1", "b")).toBeNull();
});

test("sameDigest compares hex digests in constant time", () => {
  expect(sameDigest("abcd", "abcd")).toBe(true);
  expect(sameDigest("abcd", "abce")).toBe(false);
  expect(sameDigest("abcd", "ab")).toBe(false);
  expect(sameDigest(null, "ab")).toBe(false);
});

test("escapeHtml escapes markup and quotes", () => {
  expect(escapeHtml(`<a href="x">&</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
  );
});
