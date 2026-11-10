import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// The terminal's text shaper decodes WOFF2 fonts with the browser's own
// Brotli (DecompressionStream) where it exists and its bundled JavaScript
// decoder elsewhere. That decoder needs Brotli's static dictionary, which
// the engine carries as a number array: about 464 KB of source (82 KB gzip)
// inside the engine chunk, downloaded and parsed by every browser.
//
// The build takes it out of the engine: the dictionary becomes its own lazy
// chunk, written as a string (a third of the size), that the decoder imports
// only when it actually runs. terminalEngine.ts starts that import alongside
// the engine in browsers without native Brotli, so it costs no extra hop.
export const DICTIONARY_MODULE_ID = "virtual:thyra-brotli-dictionary";
export const DICTIONARY_BYTES = 122784;
const BYTES = "__thyraBrotliDictionaryBytes";
const READ = "__thyraBrotliDictionary";
const LOAD = "__thyraLoadBrotliDictionary";

const LITERAL =
  /new Uint8Array\(\[((?:\s*\d{1,3},){100000,}\s*\d{1,3})\s*\]\)/g;
// The decoder's lazy initializer, flattened by the engine's bundler from a
// dynamic import into a resolved promise; it follows the native attempt.
const FALLBACK =
  /(new DecompressionStream\("brotli"\)[\s\S]{0,600}?=\s*await\s+)Promise\.resolve\(\)(\s*\.then\()/;

/** The dictionary's span in a module's code, and its bytes. */
export function inlinedBrotliDictionary(
  code: string,
): { start: number; end: number; bytes: Uint8Array } | null {
  for (const match of code.matchAll(LITERAL)) {
    const bytes = Uint8Array.from(match[1]!.split(","), Number);
    if (bytes.length === DICTIONARY_BYTES)
      return {
        start: match.index,
        end: match.index + match[0].length,
        bytes,
      };
  }
  return null;
}

/**
 * The module with its dictionary replaced by one loaded on demand, or null
 * when it holds none. Throws when the decoder's loading code is not the
 * shape this rewrite knows, rather than ship a decoder without a dictionary.
 */
export function lazyBrotliDictionary(code: string): string | null {
  const span = inlinedBrotliDictionary(code);
  if (!span) return null;
  const rewritten =
    code.slice(0, span.start) + `${READ}()` + code.slice(span.end);
  if (!FALLBACK.test(rewritten))
    throw new Error(
      "The engine's Brotli fallback changed shape; update web/vite.brotli.ts",
    );
  return (
    `let ${BYTES};\n` +
    `const ${READ} = () => {\n` +
    `  if (!${BYTES}) throw new Error("Brotli dictionary is not loaded");\n` +
    `  return ${BYTES};\n` +
    `};\n` +
    `const ${LOAD} = () =>\n` +
    `  import(${JSON.stringify(DICTIONARY_MODULE_ID)}).then((module) => {\n` +
    `    ${BYTES} = module.default;\n` +
    `  });\n` +
    rewritten.replace(FALLBACK, `$1${LOAD}()$2`)
  );
}

/** A module whose default export is the bytes, kept as a Latin-1 string. */
export function brotliDictionaryModule(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return (
    `const text = ${JSON.stringify(text)};\n` +
    `const bytes = new Uint8Array(text.length);\n` +
    `for (let index = 0; index < text.length; index++)\n` +
    `  bytes[index] = text.charCodeAt(index);\n` +
    `export default bytes;\n`
  );
}

function readDictionary(): Uint8Array {
  const dist = dirname(fileURLToPath(import.meta.resolve("restty")));
  for (const name of readdirSync(dist)) {
    if (!name.endsWith(".js")) continue;
    const found = inlinedBrotliDictionary(
      readFileSync(join(dist, name), "utf8"),
    );
    if (found) return found.bytes;
  }
  throw new Error("The engine's Brotli dictionary was not found");
}

export function brotliDictionaryPlugin(): Plugin {
  let build = false;
  let rewrites = 0;
  return {
    name: "thyra-brotli-dictionary",
    configResolved(config) {
      build = config.command === "build";
    },
    buildStart() {
      rewrites = 0;
    },
    resolveId(id) {
      return id === DICTIONARY_MODULE_ID ? `\0${DICTIONARY_MODULE_ID}` : null;
    },
    load(id) {
      if (id !== `\0${DICTIONARY_MODULE_ID}`) return null;
      return brotliDictionaryModule(readDictionary());
    },
    // The dev server prebundles the engine untouched, dictionary included.
    transform(code, id) {
      if (!build || !/restty|text-shaper/.test(id)) return null;
      const rewritten = lazyBrotliDictionary(code);
      if (rewritten === null) return null;
      rewrites++;
      return { code: rewritten, map: null };
    },
    buildEnd(error) {
      if (build && !error && !rewrites)
        this.error(
          "The engine's Brotli dictionary was not found; update web/vite.brotli.ts",
        );
    },
  };
}
