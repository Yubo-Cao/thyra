import { describe, expect, test } from "bun:test";
import {
  decodeMarkdownText,
  lexMarkdownStream,
  repairStreamingMarkdown,
} from "./markdownStream";

const types = (text: string, streaming = true) =>
  lexMarkdownStream(text, streaming).blocks.map((block) => block.token.type);

describe("streaming Markdown repair", () => {
  test("complete text is left alone", () => {
    for (const text of [
      "Plain text.",
      "Some **bold** and `code` and [a link](https://example.com).",
      "```ts\nconst a = 1;\n```\nDone.",
      "a\n\n---\n\nb",
      "- one\n- two",
    ])
      expect(repairStreamingMarkdown(text)).toBe(text);
  });

  test("an unclosed code fence keeps its content as code", () => {
    const text = "Run this:\n\n```bash\nbun install\nbun run **build";
    expect(repairStreamingMarkdown(text)).toBe(text);
    expect(types(text)).toEqual(["paragraph", "code"]);
  });

  test("a closing fence still arriving is not shown as code", () => {
    expect(repairStreamingMarkdown("```ts\nconst a = 1;\n``")).toBe(
      "```ts\nconst a = 1;",
    );
    expect(repairStreamingMarkdown("~~~\ncode\n~")).toBe("~~~\ncode");
    // A shorter run in a longer fence waits for its line to end, then is content.
    expect(repairStreamingMarkdown("````md\n```")).toBe("````md");
    expect(repairStreamingMarkdown("````md\n```\n")).toBe("````md\n```\n");
    expect(repairStreamingMarkdown("```\n~~")).toBe("```\n~~");
  });

  test("an opening fence, heading or rule still arriving is held back", () => {
    expect(repairStreamingMarkdown("Text.\n\n``")).toBe("Text.\n");
    expect(repairStreamingMarkdown("Text.\n\n##")).toBe("Text.\n");
    // Would otherwise turn the line above into a heading for a moment.
    expect(repairStreamingMarkdown("Steps:\n-")).toBe("Steps:");
    expect(repairStreamingMarkdown("Title\n==")).toBe("Title");
    expect(types("Steps:\n-")).toEqual(["paragraph"]);
    // After a blank line it is a rule being typed.
    expect(repairStreamingMarkdown("a\n\n---")).toBe("a\n\n---");
  });

  test("a table waits for the rule under its header", () => {
    expect(repairStreamingMarkdown("Results:\n\n| Case | Bef")).toBe(
      "Results:\n",
    );
    expect(repairStreamingMarkdown("| Case | Before |\n")).toBe("");
    expect(repairStreamingMarkdown("| Case | Before |\n| --- |")).toBe("");
    // A line of pipes that turned out not to be a table.
    expect(repairStreamingMarkdown("| not a table |\n\n")).toBe(
      "| not a table |\n\n",
    );
    const formed = "| Case | Before |\n| --- | --- |";
    expect(repairStreamingMarkdown(formed)).toBe(formed);
    expect(types(formed)).toEqual(["table"]);
    // Rows of a formed table show as they arrive.
    expect(repairStreamingMarkdown(`${formed}\n| Burst | 2`)).toBe(
      `${formed}\n| Burst | 2`,
    );
    expect(types("Results:\n\n| Case | Bef")).toEqual(["paragraph"]);
  });

  test("inline code and bold are closed", () => {
    expect(repairStreamingMarkdown("Use `bun inst")).toBe("Use `bun inst`");
    expect(repairStreamingMarkdown("Use ``a ` b")).toBe("Use ``a ` b``");
    expect(repairStreamingMarkdown("This is **importa")).toBe(
      "This is **importa**",
    );
    expect(repairStreamingMarkdown("This is **bold ")).toBe("This is **bold**");
    expect(repairStreamingMarkdown("~~gone")).toBe("~~gone~~");
    // Markers inside code are text.
    expect(repairStreamingMarkdown("`a ** b` and **c")).toBe(
      "`a ** b` and **c**",
    );
    expect(repairStreamingMarkdown("`a ** b")).toBe("`a ** b`");
  });

  test("markers with nothing after them are held back", () => {
    expect(repairStreamingMarkdown("Use `")).toBe("Use ");
    expect(repairStreamingMarkdown("This is **")).toBe("This is ");
    expect(repairStreamingMarkdown("This is *")).toBe("This is ");
    expect(repairStreamingMarkdown("2 * 3 *")).toBe("2 * 3 ");
  });

  test("an unfinished link shows its text and an image waits", () => {
    expect(repairStreamingMarkdown("See [the docs](https://exam")).toBe(
      "See the docs",
    );
    expect(repairStreamingMarkdown("See [the do")).toBe("See the do");
    expect(repairStreamingMarkdown("Look ![shot](https://x")).toBe("Look ");
    expect(repairStreamingMarkdown("- [ ] task")).toBe("- [ ] task");
  });

  test("repairs stay in the last paragraph, after a closed fence", () => {
    expect(repairStreamingMarkdown("a **b\n\nnext `c")).toBe(
      "a **b\n\nnext `c`",
    );
    expect(repairStreamingMarkdown("```\na\n\nb\n```\nmore **bo")).toBe(
      "```\na\n\nb\n```\nmore **bo**",
    );
  });
});

describe("incremental Markdown blocks", () => {
  test("finished blocks keep their identity while the last one grows", () => {
    const first = lexMarkdownStream("# Title\n\nFirst para.\n\nSecond", true);
    expect(first.blocks.map((block) => block.token.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
    ]);
    const second = lexMarkdownStream(
      `${first.text} paragraph grows.\n\n- item`,
      true,
      first,
    );
    expect(second.blocks.map((block) => block.token.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "list",
    ]);
    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(second.blocks[1]).toBe(first.blocks[1]);
    expect(second.blocks[2]).not.toBe(first.blocks[2]);
    expect(second.blocks[2].start).toBe(first.blocks[2].start);
    expect(second.blocks[2].token.raw).toContain("paragraph grows.");
  });

  test("incremental and full parses agree at every prefix", () => {
    const text = [
      "Intro with **bold** and `code`.",
      "",
      "1. First",
      "   ```sh",
      "   bun test",
      "   ```",
      "2. Second",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const answer = 42;",
      "",
      "export default answer;",
      "```",
      "",
      "> quoted",
      "> more",
      "",
      "> another",
      "",
      "- a",
      "  - nested",
      "",
      "- b",
      "",
      "Title",
      "---",
      "",
      "<details>",
      "x",
      "</details>",
      "",
      "Done.",
    ].join("\n");
    let stream = lexMarkdownStream("", true);
    // Which block a blank line is counted with does not matter.
    const shape = (blocks: ReturnType<typeof lexMarkdownStream>["blocks"]) =>
      blocks.map((block) => [block.start, block.token.raw.trimEnd()]);
    for (let end = 1; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      stream = lexMarkdownStream(prefix, true, stream);
      expect(shape(stream.blocks)).toEqual(
        shape(lexMarkdownStream(prefix, true).blocks),
      );
    }
    const done = lexMarkdownStream(text, false, stream);
    expect(done.blocks.map((block) => block.token.type)).toEqual([
      "paragraph",
      "list",
      "table",
      "code",
      "blockquote",
      "blockquote",
      "list",
      "heading",
      "html",
      "paragraph",
    ]);
  });

  test("replaced text and carriage returns fall back to a full parse", () => {
    const first = lexMarkdownStream("One.\n\nTwo.\n\nThree.", true);
    const replaced = lexMarkdownStream(
      "Other.\n\nTwo.\n\nThree.",
      false,
      first,
    );
    expect(replaced.blocks[0]).not.toBe(first.blocks[0]);
    expect(replaced.blocks[0].token.raw).toContain("Other.");
    const windows = lexMarkdownStream("One.\r\n\r\nTwo.", true);
    expect(windows.exact).toBe(false);
    const grown = lexMarkdownStream("One.\r\n\r\nTwo. Three.", true, windows);
    expect(grown.blocks.map((block) => block.token.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    // The whole text was parsed again; an unchanged block is still reused.
    expect(grown.blocks[0]).toBe(windows.blocks[0]);
    expect(grown.blocks[1].token.raw).toBe("Two. Three.");
  });

  test("the final parse drops the repairs", () => {
    const streaming = lexMarkdownStream("A lone ` backtick", true);
    expect(streaming.blocks[0].token.raw).toBe("A lone ` backtick`");
    const final = lexMarkdownStream("A lone ` backtick", false, streaming);
    expect(final.blocks[0].token.raw).toBe("A lone ` backtick");
  });
});

test("Markdown text entities decode to characters", () => {
  expect(decodeMarkdownText("AT&amp;T &lt;b&gt; &#39;x&#x27; &copy;")).toBe(
    "AT&T <b> 'x' &copy;",
  );
  expect(decodeMarkdownText("a & b")).toBe("a & b");
});
