import { expect, test } from "bun:test";
import {
  brotliDictionaryModule,
  DICTIONARY_BYTES,
  DICTIONARY_MODULE_ID,
  inlinedBrotliDictionary,
  lazyBrotliDictionary,
} from "./vite.brotli";

const bytes = Uint8Array.from(
  { length: DICTIONARY_BYTES },
  (_, index) => (index * 7 + (index >> 8)) & 0xff,
);
// The shape of the engine's bundle: lookup tables, the dictionary behind a
// lazy initializer, and the decoder loaded after the native attempt fails.
const engine = (dictionary: string) =>
  `var table = new Uint8Array([1, 2, 3]);\n` +
  `var dict;\nvar initDict = lazy(() => {\n  dict = ${dictionary};\n});\n` +
  `async function decode(x) {\n` +
  `  if (typeof DecompressionStream < "u")\n    try {\n` +
  `      let Q = new DecompressionStream("brotli");\n      return native(x, Q);\n    } catch {}\n` +
  `  let { decompress: A } = await Promise.resolve().then(() => (init(), decoder));\n` +
  `  return A(x);\n}\n` +
  `const other = await Promise.resolve().then(() => 1);\n`;

test("the engine's Brotli dictionary becomes a lazily imported module", () => {
  const code = engine(`new Uint8Array([${bytes.join(", ")}])`);
  expect(inlinedBrotliDictionary(code)?.bytes).toEqual(bytes);
  const rewritten = lazyBrotliDictionary(code)!;
  expect(rewritten.length).toBeLessThan(2000);
  expect(rewritten).toContain("dict = __thyraBrotliDictionary();");
  expect(rewritten).toContain(`import("${DICTIONARY_MODULE_ID}")`);
  // The decoder waits for the dictionary; nothing else changed.
  expect(rewritten).toContain(
    "await __thyraLoadBrotliDictionary().then(() => (init(), decoder));",
  );
  expect(rewritten).toContain("var table = new Uint8Array([1, 2, 3]);");
  expect(rewritten).toContain(
    "const other = await Promise.resolve().then(() => 1);",
  );
  // The minified form of the same code.
  expect(
    lazyBrotliDictionary(
      `var d,i=l(()=>{d=new Uint8Array([${bytes.join(",")}])});async function f(x){try{let Q=new DecompressionStream("brotli");return n(x,Q)}catch{}let{decompress:A}=await Promise.resolve().then(()=>(g(),o));return A(x)}`,
    ),
  ).toContain("=await __thyraLoadBrotliDictionary().then(()=>(g(),o))");
});

test("modules without the dictionary are left alone, and an unknown decoder fails the build", () => {
  expect(lazyBrotliDictionary("export const a = new Uint8Array([1,2]);")).toBe(
    null,
  );
  const short = `new Uint8Array([${bytes.subarray(0, 120000).join(",")}])`;
  expect(lazyBrotliDictionary(engine(short))).toBe(null);
  expect(() =>
    lazyBrotliDictionary(`var d = new Uint8Array([${bytes.join(",")}]);`),
  ).toThrow("Brotli fallback changed shape");
});

test("the dictionary module decodes to the same bytes", () => {
  const code = brotliDictionaryModule(bytes);
  // Stored as text: about a byte each, not a decimal number and a comma.
  expect(code.length).toBeLessThan(DICTIONARY_BYTES * 1.6);
  const decoded = new Function(
    code.replace("export default bytes;", "return bytes;"),
  )() as Uint8Array;
  expect(decoded).toEqual(bytes);
});
