import { describe, expect, test } from "bun:test";
import { parseEmails } from "./emailList";

describe("email lists", () => {
  test("splits on commas, semicolons, spaces and newlines, once each", () => {
    expect(
      parseEmails(
        " Ada@Example.com, bea@corp.example;\ncy@x.io  ada@example.com",
      ),
    ).toEqual({
      emails: ["ada@example.com", "bea@corp.example", "cy@x.io"],
      invalid: [],
    });
    expect(parseEmails("ada@example.com")).toEqual({
      emails: ["ada@example.com"],
      invalid: [],
    });
    expect(parseEmails(" \n ")).toEqual({ emails: [], invalid: [] });
  });

  test("reports what is not an address as typed", () => {
    expect(
      parseEmails("ok@example.com Nope @example.com a@b a@b.c x@y.com>"),
    ).toEqual({
      emails: ["ok@example.com"],
      invalid: ["Nope", "@example.com", "a@b", "a@b.c", "x@y.com>"],
    });
  });
});
