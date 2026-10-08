import {
  type FontFile,
  fontBuffers,
  fontData,
  styleWords,
  type TerminalFontData,
} from "./terminalFonts";
import { TERMINAL_FONT_PRESET_FILES } from "./terminalFontPresetFiles";

// Loaded only when a preset is selected, so the bundled font's first screen
// carries none of this.

/**
 * A self-hosted font preset (scripts/build-terminal-font-presets.py), or
 * null for the bundled font. Its faces come regular first, so the engine
 * takes the cell metrics from the preset; Thyra Mono and the coverage fonts
 * follow for the characters it lacks.
 */
export function terminalFontPreset(
  preset: string,
): { family: string; faces: FontFile[] } | null {
  if (!Object.prototype.hasOwnProperty.call(TERMINAL_FONT_PRESET_FILES, preset))
    return null;
  const [family = "", ...faces] = TERMINAL_FONT_PRESET_FILES[preset]!;
  return {
    family,
    faces: faces.map((face) => ({
      url: `/assets/fonts/presets/${preset}/${face}.woff2`,
      weight: face.startsWith("Bold") ? 700 : 400,
      italic: face.includes("Italic"),
    })),
  };
}

// Loaded preset faces; a pending download never holds up a first frame.
const presetData = new Map<string, TerminalFontData>();

const presetFaceName = (family: string, file: FontFile) =>
  `${family} ${styleWords(file)} (Thyra preset)`;

/**
 * A preset's faces. With `network` false only those already loaded or in
 * the service worker's cache come back, so a warm page draws its first frame
 * in the preset without waiting on the link.
 */
export async function terminalPresetFontData(
  preset: string,
  network: boolean,
): Promise<TerminalFontData[]> {
  const files = terminalFontPreset(preset);
  if (!files) return [];
  const faces = await Promise.all(
    files.faces.map((file) => {
      const name = presetFaceName(files.family, file);
      const ready = presetData.get(file.url);
      if (ready) return ready;
      let loaded = network ? fontBuffers.get(file.url) : undefined;
      if (!loaded) {
        if (!network && typeof caches === "undefined") return null;
        loaded = fontData(
          file,
          name,
          network
            ? fetch(file.url)
            : caches.match(file.url).catch(() => undefined),
        );
        if (network) fontBuffers.set(file.url, loaded);
      }
      return loaded.then((data) => {
        if (data) presetData.set(file.url, data);
        else if (fontBuffers.get(file.url) === loaded)
          fontBuffers.delete(file.url);
        return data;
      });
    }),
  );
  return faces.filter((face): face is TerminalFontData => face !== null);
}

const presetFaces = new Set<string>();

/**
 * Declares a preset's faces for DOM text that mirrors the terminal. The
 * browser downloads a face only once text uses it, and then shares the file
 * with the engine through the HTTP and service worker caches.
 */
export function addTerminalPresetFaces(preset: string) {
  const files = terminalFontPreset(preset);
  if (!files || presetFaces.has(preset) || typeof FontFace === "undefined")
    return;
  presetFaces.add(preset);
  for (const file of files.faces)
    document.fonts.add(
      new FontFace(files.family, `url("${file.url}") format("woff2")`, {
        weight: String(file.weight),
        style: file.italic ? "italic" : "normal",
        display: "swap",
      }),
    );
}
