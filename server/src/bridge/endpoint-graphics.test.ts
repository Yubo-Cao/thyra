import { expect, test } from "bun:test";
import { BinWriter } from "./bincode";
import { SurfaceReader } from "./endpoint-surface";
import { PaneGraphicsCache, readGraphics } from "./endpoint-graphics";

function scene(withData = true, placed = true, hash = 2n ** 63n) {
  const w = new BinWriter();
  const key = () => {
    for (const n of [0, 0]) w.varint(n);
    w.string("w1:p1");
    for (const n of [1, 1, 1, 1, 4]) w.varint(n);
    w.varint(hash);
  };
  w.varint(withData ? 1 : 0);
  if (withData) {
    key();
    w.bytes(Buffer.from([255, 0, 0, 255]));
  }
  w.varint(placed ? 1 : 0);
  if (placed) {
    key();
    for (const n of [7, 10, 12, 2, 3, 0, 0, 1, 1, 0, 0, 3, 0]) w.varint(n);
  }
  w.varint(0);
  return readGraphics(new SurfaceReader(w.toBuffer()));
}
test("retains exact u64 identities and decodes placement coordinates and z", () => {
  const first = scene();
  expect(first.assets[0].id).not.toBe(
    scene(true, true, 2n ** 63n + 1n).assets[0].id,
  );
  expect(first.placements[0]).toMatchObject({ x: 10, y: 12, z: -2 });
});
test("pane scenes survive deltas, crop to content and release deleted assets", () => {
  const cache = new PaneGraphicsCache();
  cache.update(scene());
  const delta = scene(false);
  cache.update(delta);
  const cropped = cache.pane(delta, "w1:p1", { x: 2, y: 4 });
  expect(cropped.assets).toHaveLength(1);
  expect(cropped.placements[0]).toMatchObject({ x: 8, y: 8 });
  expect(cache.pane(delta, "w1:p2", { x: 0, y: 0 }).placements).toHaveLength(0);
  cache.update(scene(false, false));
  expect(cache.pane(delta, "w1:p1", { x: 0, y: 0 }).assets).toHaveLength(0);
});
