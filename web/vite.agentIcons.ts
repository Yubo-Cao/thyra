import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

// Agent icons are inlined as SVG markup (components/AgentIcon.tsx), some of
// them in the app entry. An `*.svg?agent-icon` import is that file's markup
// with what an inline icon does not need removed: comments, the title, the
// root's namespace and `1em` box (AgentIcon.css sizes it), and the closing
// tags of empty elements. Geometry is left alone, so the icon renders exactly
// as the file does: rounding path data moves edges across the rasterizer's
// subpixel samples, which changes edge pixels by up to a third at icon sizes.

const QUERY = "?agent-icon";
const ROOT_ATTRIBUTES =
  /\s(?:xmlns="http:\/\/www\.w3\.org\/2000\/svg"|(?:width|height)="1em"|style="flex:none;line-height:1")/g;

/** An icon's SVG file as the markup AgentIcon inlines. */
export function agentIconMarkup(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>|<!--[\s\S]*?-->|<title>[^<]*<\/title>/g, "")
    .replace(/>\s+</g, "><")
    .trim()
    .replace(/^<svg\b[^>]*>/, (root) => root.replace(ROOT_ATTRIBUTES, ""))
    .replace(/<([\w-]+)((?:\s[^<>]*)?)><\/\1>/g, "<$1$2/>");
}

export function agentIconsPlugin(): Plugin {
  return {
    name: "thyra-agent-icons",
    // Ahead of Vite's own handling of `.svg` as an asset URL.
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(QUERY)) return null;
      const file = id.slice(0, -QUERY.length);
      this.addWatchFile(file);
      return `export default ${JSON.stringify(agentIconMarkup(await readFile(file, "utf8")))};`;
    },
  };
}
