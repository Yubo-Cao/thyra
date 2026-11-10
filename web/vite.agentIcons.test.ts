import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentIconMarkup } from "./vite.agentIcons";

describe("agent icon markup", () => {
  test("drops what an inline icon does not need", () => {
    expect(
      agentIconMarkup(
        '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>opencode</title><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"></path></svg>',
      ),
    ).toBe(
      '<svg fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24"><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/></svg>',
    );
  });

  test("keeps colours, references and sizes that are not the root's", () => {
    const svg =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">\n  <!-- note -->\n  <mask height="23" id="m" width="24"><path d="M0 0h24v24H0z" fill="#fff"></path></mask>\n  <g mask="url(#m)"><rect width="1em" height="2" style="opacity:.5"></rect></g>\n</svg>\n';
    expect(agentIconMarkup(svg)).toBe(
      '<svg viewBox="0 0 24 24"><mask height="23" id="m" width="24"><path d="M0 0h24v24H0z" fill="#fff"/></mask><g mask="url(#m)"><rect width="1em" height="2" style="opacity:.5"/></g></svg>',
    );
  });

  test("leaves the geometry and paint of the shipped icons untouched", () => {
    const icons = fileURLToPath(
      new URL(
        "./node_modules/@lobehub/icons-static-svg/icons/",
        import.meta.url,
      ),
    );
    /** Everything that draws: all attributes but the root's box. */
    const drawn = (markup: string) =>
      [...markup.matchAll(/\s([\w:-]+)="([^"]*)"/g)]
        .map(([, name, value]) => `${name}=${value}`)
        .filter(
          (attribute) =>
            !/^(?:xmlns=http:\/\/www\.w3\.org\/2000\/svg|(?:width|height)=1em|style=flex:none;line-height:1)$/.test(
              attribute,
            ),
        );
    const files = readdirSync(icons).filter((name) =>
      /^(?:amp|antigravity|claudecode|cline|codex|cursor|devin|geminicli|githubcopilot|grok|kilocode|kimi|kiro|opencode|qoder)(?:-color)?\.svg$/.test(
        name,
      ),
    );
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const name of files) {
      const svg = readFileSync(`${icons}${name}`, "utf8");
      const markup = agentIconMarkup(svg);
      expect(markup.length).toBeLessThan(svg.length);
      expect(markup).toMatch(/^<svg [^>]*viewBox="0 0 24 24"[^>]*>.*<\/svg>$/);
      expect(drawn(markup)).toEqual(drawn(svg));
    }
  });
});
