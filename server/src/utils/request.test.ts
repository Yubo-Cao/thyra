import { describe, expect, test } from "bun:test";
import { sameDigest } from "./digest";
import { escapeHtml } from "./html";
import { parseCookie, readJsonObject, RequestError } from "./request";

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
