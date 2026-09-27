import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../site/tutorial.js", import.meta.url),
  "utf8",
);
const storageKey = "thyra-tutorial-checklist-v1";

function render(values: Map<string, string>) {
  const check = {
    checked: false,
    disabled: true,
    closest: () => null,
    addEventListener: () => undefined,
  };
  const article = {
    querySelectorAll: (selector: string) =>
      selector === 'input[type="checkbox"]' ? [check] : [],
  };
  runInNewContext(source, {
    document: {
      querySelector: (selector: string) =>
        selector === ".tutorial-prose" ? article : null,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  return check.checked;
}

test("tutorial restores saved progress from its own key", () => {
  expect(render(new Map([[storageKey, "[true]"]]))).toBeTrue();
  expect(render(new Map([[storageKey, "[false]"]]))).toBeFalse();
  expect(render(new Map())).toBeFalse();
});

test("tutorial ignores other checklist keys", () => {
  const values = new Map([["other-tutorial-checklist-v1", "[true]"]]);
  expect(render(values)).toBeFalse();
  expect(values.has(storageKey)).toBeFalse();
});
