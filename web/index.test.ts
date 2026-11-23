import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(
  (match) => match[1]?.includes("storedTheme"),
)?.[1];
if (!bootstrap) throw new Error("First-paint appearance bootstrap is missing");

function firstPaint(values: Record<string, string>, systemLight = false) {
  const properties: Record<string, string> = {};
  const style = {
    colorScheme: "",
    setProperty: (name: string, value: string) => {
      properties[name] = value;
    },
  };
  const element = { dataset: { theme: "" }, style };
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
  return {
    theme: element.dataset.theme,
    colorScheme: style.colorScheme,
    properties,
  };
}

test("index first paint uses defaults when no appearance preferences exist", () => {
  expect(firstPaint({})).toEqual({
    theme: "dark",
    colorScheme: "dark",
    properties: {},
  });
});

test("index first paint ignores unprefixed appearance preferences", () => {
  expect(firstPaint({ theme: "light", uiScale: "125" })).toEqual({
    theme: "dark",
    colorScheme: "dark",
    properties: {},
  });
});

test("index first paint uses Thyra appearance preferences", () => {
  expect(
    firstPaint({ "thyra:theme": "light", "thyra:uiScale": "120" }),
  ).toEqual({
    theme: "light",
    colorScheme: "light",
    properties: { "--ui-scale": "1.2" },
  });
});

test("index first paint resolves the system theme and default scale", () => {
  expect(
    firstPaint({ "thyra:theme": "system", "thyra:uiScale": "100" }, true),
  ).toEqual({
    theme: "light",
    colorScheme: "light",
    properties: {},
  });
});
