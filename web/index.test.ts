import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(
  (match) => match[1]?.includes("storedTheme"),
)?.[1];
if (!bootstrap) throw new Error("First-paint appearance bootstrap is missing");

function firstPaint(values: Record<string, string>, systemLight = false) {
  const element = {
    dataset: { theme: "" },
    style: { colorScheme: "", zoom: "" },
  };
  const writeStorage = mock(() => undefined);
  runInNewContext(bootstrap as string, {
    document: { documentElement: element },
    window: { matchMedia: () => ({ matches: systemLight }) },
    localStorage: {
      getItem: (key: string) => values[key] ?? null,
      setItem: writeStorage,
      removeItem: writeStorage,
      clear: writeStorage,
    },
  });
  expect(writeStorage).not.toHaveBeenCalled();
  return element;
}

test("index first paint uses defaults when no appearance preferences exist", () => {
  expect(firstPaint({})).toEqual({
    dataset: { theme: "dark" },
    style: { colorScheme: "dark", zoom: "" },
  });
});

test("index first paint ignores unprefixed appearance preferences", () => {
  expect(firstPaint({ theme: "light", uiScale: "125" })).toEqual({
    dataset: { theme: "dark" },
    style: { colorScheme: "dark", zoom: "" },
  });
});

test("index first paint uses Thyra appearance preferences", () => {
  expect(
    firstPaint({ "thyra:theme": "light", "thyra:uiScale": "120" }),
  ).toEqual({
    dataset: { theme: "light" },
    style: { colorScheme: "light", zoom: "1.2" },
  });
});

test("index first paint resolves the system theme and default scale", () => {
  expect(
    firstPaint({ "thyra:theme": "system", "thyra:uiScale": "100" }, true),
  ).toEqual({
    dataset: { theme: "light" },
    style: { colorScheme: "light", zoom: "" },
  });
});
