import { describe, expect, test } from "bun:test";
import { columnName, crc32, storedZip, xlsxWorkbook } from "./xlsx";

type Entry = { name: string; crc: number; data: Uint8Array };

/** Reads a stored zip back through its central directory. */
function readZip(zip: Uint8Array): Entry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  expect(at + size).toBe(end);
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 10, true)).toBe(0); // stored
    const crc = view.getUint32(at + 16, true);
    const length = view.getUint32(at + 20, true);
    expect(view.getUint32(at + 24, true)).toBe(length);
    const nameLength = view.getUint16(at + 28, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const local = view.getUint32(at + 42, true);
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    const localName = view.getUint16(local + 26, true);
    const start = local + 30 + localName + view.getUint16(local + 28, true);
    entries.push({ name, crc, data: zip.subarray(start, start + length) });
    at += 46 + nameLength;
  }
  return entries;
}

describe("xlsx writer", () => {
  test("CRC-32 matches the standard check values", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    expect(crc32(bytes(""))).toBe(0);
    expect(crc32(bytes("The quick brown fox jumps over the lazy dog"))).toBe(
      0x414fa339,
    );
  });

  test("a stored zip lists every file with its CRC", () => {
    const files: [string, Uint8Array][] = [
      ["a.txt", new TextEncoder().encode("hello")],
      ["dir/b.bin", new Uint8Array([0, 1, 2, 255])],
    ];
    const entries = readZip(storedZip(files));
    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "dir/b.bin"]);
    for (const [index, entry] of entries.entries()) {
      expect(entry.data).toEqual(files[index][1]);
      expect(entry.crc).toBe(crc32(files[index][1]));
    }
  });

  test("column names run A..Z, AA..", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
  });

  test("the workbook holds the parts Excel needs and the cells", () => {
    const entries = readZip(
      xlsxWorkbook([
        ["Name", "Count"],
        ["<a & b>", "42"],
        ["007", "-1.5"],
        [" padded", "\u0001bell"],
      ]),
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    for (const entry of entries) expect(entry.crc).toBe(crc32(entry.data));
    const sheet = new TextDecoder().decode(entries[entries.length - 1].data);
    expect(sheet).toContain(
      '<c r="A1" t="inlineStr" s="1"><is><t>Name</t></is></c>',
    );
    expect(sheet).toContain("<t>&lt;a &amp; b&gt;</t>");
    expect(sheet).toContain('<c r="B2"><v>42</v></c>');
    // Leading zeros stay text; plain decimals become numbers.
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t>007</t></is></c>');
    expect(sheet).toContain('<c r="B3"><v>-1.5</v></c>');
    expect(sheet).toContain('<t xml:space="preserve"> padded</t>');
    // Characters XML cannot hold are dropped.
    expect(sheet).toContain("<t>bell</t>");
  });
});
