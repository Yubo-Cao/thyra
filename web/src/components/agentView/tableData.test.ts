import { describe, expect, test } from "bun:test";
import { marked, type Tokens } from "marked";
import {
  escapeHtml,
  inlineText,
  tableData,
  toCsv,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
} from "./tableData";

const lexTable = (source: string) =>
  marked.lexer(source).find((token) => token.type === "table") as Tokens.Table;

describe("table export", () => {
  const table = lexTable(
    [
      "| Name | **Size** | Note |",
      "| :--- | ---: | :---: |",
      "| `a\\|b` | 1.5 | [docs](https://x.test) and *more* |",
      "| x \\| y | 2 | 5 &lt; 6 |",
    ].join("\n"),
  );

  test("reads cells as plain text, keeping each cell's Markdown", () => {
    const data = tableData(table);
    expect(data.rows).toEqual([
      ["Name", "Size", "Note"],
      ["a|b", "1.5", "docs and more"],
      ["x | y", "2", "5 < 6"],
    ]);
    expect(data.align).toEqual(["left", "right", "center"]);
    expect(data.markdown[0][1]).toBe("**Size**");
    expect(data.markdown[2][0]).toBe("x \\| y");
  });

  test("Markdown keeps alignment and escaped pipes", () => {
    const data = tableData(table);
    expect(toMarkdownTable(data.markdown, data.align)).toBe(
      [
        "| Name | **Size** | Note |",
        "| :--- | ---: | :---: |",
        "| `a\\|b` | 1.5 | [docs](https://x.test) and *more* |",
        "| x \\| y | 2 | 5 &lt; 6 |",
      ].join("\n"),
    );
    expect(toMarkdownTable([["a", "b"], ["1"]])).toBe(
      "| a | b |\n| --- | --- |\n| 1 |  |",
    );
  });

  test("TSV quotes only cells with tabs, breaks or quotes", () => {
    expect(
      toTsv([
        ["plain", "with\ttab", 'say "hi"'],
        ["two\nlines", "", "x,y"],
      ]),
    ).toBe('plain\t"with\ttab"\t"say ""hi"""\n"two\nlines"\t\tx,y');
  });

  test("CSV follows RFC 4180", () => {
    expect(
      toCsv([
        ["a", "b,c", 'q"uote'],
        ["line\nbreak", " padded", ""],
      ]),
    ).toBe('a,"b,c","q""uote"\r\n"line\nbreak"," padded",\r\n');
  });

  test("HTML escapes every cell", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    expect(toHtmlTable([["<b>"], ["a\nb"]])).toBe(
      "<table><thead><tr><th>&lt;b&gt;</th></tr></thead><tbody><tr><td>a<br>b</td></tr></tbody></table>",
    );
  });

  test("inline text drops markers and keeps code as written", () => {
    const [paragraph] = marked.lexer(
      "**bold** `<code>` ~~gone~~ ![alt](x.png)",
    );
    expect(inlineText((paragraph as Tokens.Paragraph).tokens)).toBe(
      "bold <code> gone alt",
    );
  });
});
