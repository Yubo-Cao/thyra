import { describe, expect, test } from "bun:test";
import { parseFragment } from "parse5";
import { domToMarkdown, type MarkdownSourceNode } from "./domMarkdown";

type Parse5Node = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Parse5Node[];
  content?: Parse5Node;
};

/** parse5's tree through the part of the DOM the converter reads. */
function adapt(node: Parse5Node): MarkdownSourceNode {
  const text = node.nodeName === "#text";
  const element = !node.nodeName.startsWith("#");
  return {
    nodeType: text ? 3 : element ? 1 : 11,
    nodeName: node.nodeName,
    nodeValue: text ? (node.value ?? "") : null,
    childNodes: (node.content?.childNodes ?? node.childNodes ?? []).map(adapt),
    getAttribute: (name) =>
      node.attrs?.find((attr) => attr.name === name)?.value ?? null,
  };
}

const markdown = (html: string) =>
  domToMarkdown(adapt(parseFragment(html) as unknown as Parse5Node));

describe("transcript HTML as Markdown", () => {
  test("headings, paragraphs and inline marks", () => {
    expect(
      markdown(
        '<h2>Title <em>here</em></h2><p>Some <strong>bold</strong>, <em>it</em>, <del>old</del>, <code>x`y</code> and <a href="https://a.test/p (1)">a link</a>.<br>Next line</p>',
      ),
    ).toBe(
      "## Title *here*\n\nSome **bold**, *it*, ~~old~~, ``x`y`` and [a link](https://a.test/p%20%281%29).  \nNext line",
    );
  });

  test("marks keep their spaces outside", () => {
    expect(markdown("<p>a<strong> b </strong>c</p>")).toBe("a **b** c");
  });

  test("nested and ordered lists, task items", () => {
    expect(
      markdown(
        '<ul><li>one<ul><li>inner</li></ul></li><li class="agent-md-task"><svg data-md-task="x"></svg>done</li></ul><ol start="3"><li><p>three</p><p>more</p></li><li>four</li></ol>',
      ),
    ).toBe("- one\n  - inner\n- [x] done\n\n3. three\n\n   more\n4. four");
  });

  test("fenced code carries its language; tools are skipped", () => {
    expect(
      markdown(
        '<div class="agent-code"><pre data-lang="ts"><code><span class="agent-hl-keyword">const</span> a = 1;\n```\n</code></pre><div data-md-skip=""><span>ts</span><button aria-label="Copy code"></button></div></div><pre class="agent-output">plain\n</pre>',
      ),
    ).toBe("````ts\nconst a = 1;\n```\n````\n\n```\nplain\n```");
  });

  test("tables become GFM tables with alignment", () => {
    expect(
      markdown(
        '<table><thead><tr><th style="text-align: left">A</th><th style="text-align: right">B</th></tr></thead><tbody><tr><td>x | y</td><td><strong>2</strong></td></tr></tbody></table>',
      ),
    ).toBe("| A | B |\n| :--- | ---: |\n| x \\| y | **2** |");
  });

  test("quotes, rules and diffs", () => {
    expect(
      markdown(
        '<blockquote><p>quoted</p><p>twice</p></blockquote><hr><div data-md-code="diff"><div><span data-md-skip="">12</span><span>+</span><span>added</span></div><div><span data-md-skip=""></span><span>-</span><span>removed</span></div></div>',
      ),
    ).toBe("> quoted\n>\n> twice\n\n---\n\n```diff\n+added\n-removed\n```");
  });

  test("icons and hidden chrome leave no text", () => {
    expect(
      markdown(
        '<div><button><svg aria-hidden="true"></svg><span>Read file</span></button><p>after</p></div>',
      ),
    ).toBe("Read file\n\nafter");
  });
});
