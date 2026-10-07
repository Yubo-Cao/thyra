import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// restty inlines its WASM core in its JS as a byte string, which costs about a
// third more on the wire than the binary and cannot compile while it streams.
// The build ships it as its own fingerprinted .wasm asset instead and drops
// the inlined copy; the engine compiles it with compileStreaming.
const MODULE_ID = "virtual:restty-wasm";
const DEV_URL = "/@restty/restty.wasm";
const DECLARATION = "var WASM_BINARY = `";

/** Where the inlined template literal's body starts and ends, if present. */
function inlineSpan(code: string): [number, number] | null {
  const start = code.indexOf(DECLARATION);
  if (start < 0) return null;
  let end = start + DECLARATION.length;
  while (end < code.length && code[end] !== "`")
    end += code[end] === "\\" ? 2 : 1;
  return [start + DECLARATION.length, end];
}

/** The inlined WASM bytes from restty's dist chunk that declares them. */
export function inlinedResttyWasm(code: string): Uint8Array | null {
  const span = inlineSpan(code);
  if (!span) return null;
  const literal = code.slice(...span);
  // The literal is restty's own build output: a template string of escapes.
  const text = new Function(`return \`${literal}\`;`)() as string;
  const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
  return bytes[0] === 0 && text.startsWith("\0asm") ? bytes : null;
}

function readResttyWasm(): Uint8Array {
  const dist = dirname(fileURLToPath(import.meta.resolve("restty")));
  for (const name of readdirSync(dist)) {
    if (!name.endsWith(".js")) continue;
    const bytes = inlinedResttyWasm(readFileSync(join(dist, name), "utf8"));
    if (bytes) return bytes;
  }
  throw new Error("restty's inlined WASM core was not found");
}

export function resttyWasmPlugin(): Plugin {
  let build = false;
  let bytes: Uint8Array | null = null;
  const wasm = () => (bytes ??= readResttyWasm());
  return {
    name: "thyra-restty-wasm",
    configResolved(config) {
      build = config.command === "build";
    },
    resolveId(id) {
      return id === MODULE_ID ? `\0${MODULE_ID}` : null;
    },
    load(id) {
      if (id !== `\0${MODULE_ID}`) return null;
      if (!build) return `export default ${JSON.stringify(DEV_URL)};`;
      const ref = this.emitFile({
        type: "asset",
        name: "restty.wasm",
        source: wasm(),
      });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
    transform(code, id) {
      const span = build && id.includes("restty") ? inlineSpan(code) : null;
      if (!span) return null;
      return { code: code.slice(0, span[0]) + code.slice(span[1]), map: null };
    },
    configureServer(server) {
      server.middlewares.use(DEV_URL, (_request, response) => {
        response.setHeader("content-type", "application/wasm");
        response.end(wasm());
      });
    },
  };
}
