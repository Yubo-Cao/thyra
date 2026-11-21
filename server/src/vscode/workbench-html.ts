import {
  TERMINAL_FONT_CORE_STYLESHEET,
  TERMINAL_FONT_STYLESHEET,
} from "../../../shared/terminalFontStylesheet";

/**
 * VS Code Web draws with the browser's fonts, so an editor font that is not
 * installed on the viewing device falls back to its default monospace (SimSun
 * for Chinese on Windows). The workbench page therefore loads Thyra's sliced
 * terminal font, whose unicode-range chunks download only for the characters
 * on screen, and takes it as the default editor (and so terminal) font. A
 * font set in VS Code's own settings still wins.
 */
export const EDITOR_FONT_FAMILY =
  "'Thyra Mono', Menlo, Monaco, Consolas, 'Courier New', 'Droid Sans Mono', monospace";

const CONFIGURATION =
  /(<meta\s+id="vscode-workbench-web-configuration"\s+data-settings=")([^"]*)(")/;

const STARTUP_BACKGROUND = `<style>
html { background-color: var(--thyra-startup-background, #f8f8f8); }
@media (prefers-color-scheme: dark) {
  html { background-color: var(--thyra-startup-background, #1f1f1f); }
}
</style>`;

function startupBackground(html: string) {
  const nonce = html.match(/<script\s+nonce="([\w+/=-]+)"/)?.[1];
  if (!nonce) return STARTUP_BACKGROUND;
  // VS Code saves its last theme's splash color in this origin's storage.
  return `${STARTUP_BACKGROUND}<script nonce="${nonce}">
try {
  const color = JSON.parse(localStorage.getItem("monaco-parts-splash"))?.colorInfo?.background;
  if (typeof color === "string" && /^#[a-f0-9]{6}$/i.test(color)) {
    document.documentElement.style.setProperty("--thyra-startup-background", color);
  }
} catch {}
</script>`;
}

const ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
};

function decodeAttribute(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
    const code =
      name[1].toLowerCase() === "x"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function encodeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The regular-weight chunks that cover printable ASCII. Preloading them puts
 * the font in place before the editor first measures a character.
 */
export function asciiFontChunks(coreStylesheet: string): string[] {
  const urls: string[] = [];
  for (const [rule] of coreStylesheet.matchAll(/@font-face\{[^}]*\}/g)) {
    if (!/font-weight:400\b/.test(rule) || !/font-style:normal\b/.test(rule))
      continue;
    const url = rule.match(/url\("([^"]+\.woff2)"\)/)?.[1];
    const ranges = rule.match(/unicode-range:([^;}]*)/)?.[1] ?? "";
    const ascii = ranges.split(",").some((range) => {
      const [from, to = from] = range.trim().replace(/^U\+/i, "").split("-");
      const start = Number.parseInt(from ?? "", 16);
      const end = Number.parseInt(to ?? "", 16);
      return start <= 0x7e && end >= 0x21;
    });
    if (url && ascii) urls.push(url);
  }
  return urls;
}

/**
 * Adds the startup background, font stylesheets and default editor font to
 * a workbench page with a readable configuration.
 */
export function withWorkbenchAppearance(
  html: string,
  preloads: string[] = [],
): string {
  const settings = html.match(CONFIGURATION)?.[2];
  const head = html.indexOf("</head>");
  if (settings === undefined || head < 0) return html;
  let configuration: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(decodeAttribute(settings));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return html;
    configuration = parsed as Record<string, unknown>;
  } catch {
    return html;
  }
  const defaults = configuration.configurationDefaults;
  configuration.configurationDefaults = {
    "editor.fontFamily": EDITOR_FONT_FAMILY,
    ...(defaults && typeof defaults === "object" ? defaults : {}),
  };
  const links = [
    ...preloads.map(
      (url) =>
        `<link rel="preload" as="font" type="font/woff2" crossorigin href="${encodeAttribute(url)}" />`,
    ),
    `<link rel="stylesheet" href="${TERMINAL_FONT_CORE_STYLESHEET}" />`,
    `<link rel="stylesheet" href="${TERMINAL_FONT_STYLESHEET}" />`,
  ].join("");
  return (html.slice(0, head) + links + html.slice(head))
    .replace(/<head\b[^>]*>/i, (tag) => tag + startupBackground(html))
    .replace(
      CONFIGURATION,
      (_match, open: string, _settings: string, close: string) =>
        `${open}${encodeAttribute(JSON.stringify(configuration))}${close}`,
    );
}
