import { describe, expect, test } from "bun:test";
import {
  type CssUsageOptions,
  findUnusedCssClasses,
  fixUnusedCssClasses,
} from "./css-usage";

function fixture(
  css: string,
  usage = "",
  overrides: CssUsageOptions = {},
): CssUsageOptions {
  return {
    cssFiles: [{ file: "fixture.css", content: css }],
    usageFiles: [{ file: "fixture.tsx", content: usage }],
    allowlist: [],
    ...overrides,
  };
}

async function unused(options: CssUsageOptions) {
  return (await findUnusedCssClasses(options)).map((entry) => entry.className);
}

describe("CSS usage analyzer", () => {
  test("parses nested rules, pseudo-class arguments, and conditional layers", async () => {
    const css = `.host {
  &:is(.live, .gone) { color: red; }
  @media (width > 10px) {
    @supports (display: grid) {
      @container card (width > 20px) {
        @layer test {
          &:where(.where):not(.not):has(.has) { color: blue; }
        }
      }
    }
  }
}`;
    const result = await findUnusedCssClasses(
      fixture(css, '<div className="host live" />'),
    );
    expect(result).toEqual([
      {
        className: "gone",
        file: "fixture.css",
        line: 2,
        selector: "&:is(.live, .gone)",
      },
      ...["has", "not", "where"].map((className) => ({
        className,
        file: "fixture.css",
        line: 7,
        selector: "&:where(.where):not(.not):has(.has)",
      })),
    ]);
  });

  test("collects literals, escaped selectors, and templates without substitutions", async () => {
    expect(
      await unused(
        fixture(
          ".one {} .two {} .three {} .hover\\:active {} .absent {}",
          'const x = "one\\ttwo"; const y = `three hover:active`; // "absent"',
        ),
      ),
    ).toEqual(["absent"]);
  });

  test("tracks template prefixes and suffixes only at substitution boundaries", async () => {
    expect(
      await unused(
        fixture(
          ".status-ok {} .large-icon {} .state-ok {} .small-tail {} .plain {} .fixed {} .plain-extra {} .extra-fixed {} .unrelated {}",
          "const a = `plain status-${x}-icon fixed`; const b = `${x}-tail state-${y}`;",
        ),
      ),
    ).toEqual(["extra-fixed", "plain-extra", "unrelated"]);
  });

  test("does not turn whitespace or empty template fragments into wildcards", async () => {
    expect(
      await unused(
        fixture(
          ".prefix {} .suffix {} .prefix-extra {} .extra-suffix {} .other {}",
          "const a = `prefix ${x} suffix`; const b = `${x}${y}`;",
        ),
      ),
    ).toEqual(["extra-suffix", "other", "prefix-extra"]);
  });

  test("tracks both sides of concatenations, parentheses, and chains", async () => {
    expect(
      await unused(
        fixture(
          ".tone-red {} .red-icon {} .-middle-blue {} .red-middle- {} .standalone {} .standalone-extra {} .other {}",
          'const a = ("tone-") + color; const b = size + "-icon"; const c = x + "-middle-" + y; const d = "standalone " + x;',
        ),
      ),
    ).toEqual(["other", "standalone-extra"]);
  });

  test("allows only documented library prefixes", async () => {
    expect(
      await unused(
        fixture(".vendor-widget {} .other {}", "", {
          allowlist: [
            {
              prefix: "vendor-",
              reason: "Fixture renderer creates these classes.",
            },
          ],
        }),
      ),
    ).toEqual(["other"]);
    await expect(
      findUnusedCssClasses(
        fixture(".other {}", "", {
          allowlist: [{ prefix: "", reason: "Invalid wildcard" }],
        }),
      ),
    ).rejects.toThrow("nonempty prefix and reason");
  });

  test("collects HTML class attributes and parses inline scripts", async () => {
    expect(
      await unused(
        fixture(
          ".html {} .decoded {} .inline {} .state-on {} .ignored {}",
          "",
          {
            usageFiles: [
              {
                file: "fixture.html",
                content: `
        <!-- <div class="ignored"></div> -->
        <div class='html&#32;decoded'></div>
        <script>const a = "inline"; const b = "state-" + state;</script>
      `,
              },
            ],
          },
        ),
      ),
    ).toEqual(["ignored"]);
  });

  test("--fix removes just the dead selector in a list, preserving declarations", async () => {
    const options = fixture(
      '.live,\n.dead { color: red; --label: ".dead"; }',
      '"live"',
    );
    const { changedFiles } = await fixUnusedCssClasses(options);
    expect(changedFiles).toEqual([
      {
        file: "fixture.css",
        content: '.live { color: red; --label: ".dead"; }',
      },
    ]);
    expect(
      await findUnusedCssClasses({ ...options, cssFiles: changedFiles }),
    ).toEqual([]);
    expect(
      (await fixUnusedCssClasses({ ...options, cssFiles: changedFiles }))
        .changedFiles,
    ).toEqual([]);
  });

  test("--fix retains live pseudo-class branches and negations", async () => {
    const { changedFiles } = await fixUnusedCssClasses(
      fixture(
        ".host:is(.live, .dead):not(.absent) { color: red; }\n.host:has(.missing) { color: blue; }\n:not(.absent) { color: green; }",
        '"host live"',
      ),
    );
    expect(changedFiles[0].content).toBe(
      ".host:is(.live) { color: red; }\n* { color: green; }",
    );
  });

  test("--fix removes empty nested at-rule blocks but preserves statements", async () => {
    const { changedFiles } = await fixUnusedCssClasses(
      fixture(
        "@layer keep;\n@media (width > 1px) { @supports (display: grid) { /* obsolete */ .dead {} } }\n.live { &.dead { color: red; } color: blue; }",
        '"live"',
      ),
    );
    expect(changedFiles[0].content).toBe(
      "@layer keep;\n.live { color: blue; }",
    );
  });

  test("--fix preserves universal subjects and ancestor depth around negations", async () => {
    const { changedFiles } = await fixUnusedCssClasses(
      fixture(
        ".host > :not(.dead) > .child, :not(.dead) .child { color: red; }",
        '"host child"',
      ),
    );
    expect(changedFiles[0].content).toBe(
      ".host > * > .child, * .child { color: red; }",
    );
  });

  test("preserves short dynamic prefixes, including those in test files", async () => {
    expect(
      await unused(
        fixture(".c-anything {} .other {}", "", {
          usageFiles: [
            { file: "fixture.test.ts", content: "const id = `c${index}`;" },
          ],
        }),
      ),
    ).toEqual(["other"]);
  });

  test("--fix does not rewrite untouched CSS comments", async () => {
    const result = await fixUnusedCssClasses(
      fixture(
        ".live { /* a renderer injects a <style> element */ color: red; }",
        '"live"',
      ),
    );
    expect(result.changedFiles).toEqual([]);
  });
});

test("repository CSS classes have usage candidates or documented library prefixes", async () => {
  const result = await findUnusedCssClasses();
  expect(
    result,
    "Unused CSS found. Run bun scripts/css-usage.ts --fix and review the removals.",
  ).toEqual([]);
}, 60_000);
