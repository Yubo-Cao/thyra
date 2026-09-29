import type {
  TerminalGraphics,
  TerminalImageAsset,
  TerminalImagePlacement,
} from "../../../shared/terminalGraphics";
import type { SurfaceReader } from "./endpoint-surface";
import { BinWriter } from "./bincode";

type AssetKey = Omit<TerminalImageAsset, "data"> & {
  pane: string | null;
  length: number;
};
export type EndpointGraphics = {
  assets: (TerminalImageAsset & { pane: string | null })[];
  placements: (TerminalImagePlacement & { pane: string | null })[];
  retained: string[];
};

function fingerprint(r: SurfaceReader): string {
  const first = r.u8();
  if (first < 251) return String(first);
  const count = first === 251 ? 2 : first === 252 ? 4 : first === 253 ? 8 : 0;
  if (!count) throw new Error("Invalid graphics fingerprint");
  let value = 0n;
  for (let i = 0; i < count; i++) value |= BigInt(r.u8()) << BigInt(i * 8);
  return String(value);
}
function readKey(r: SurfaceReader): AssetKey {
  const source = r.number(1);
  const target = source === 0 ? r.number(1) : 0;
  const name = r.string();
  const image = source === 0 ? r.number(0xffffffff) : r.string();
  const width = r.number(0xffffffff);
  const height = r.number(0xffffffff);
  const format = r.number(2);
  const length = r.number();
  const hash = fingerprint(r);
  return {
    id: JSON.stringify([
      source,
      target,
      name,
      image,
      width,
      height,
      format,
      length,
      hash,
    ]),
    pane: target === 0 ? name : null,
    width,
    height,
    format,
    length,
  };
}
export function readGraphics(r: SurfaceReader): EndpointGraphics {
  const assets = Array.from({ length: r.count(4096) }, () => {
    const key = readKey(r);
    const data = r.bytes();
    if (data.length !== key.length)
      throw new Error("Invalid graphics asset length");
    return { ...key, data: data.toString("base64") };
  });
  const placements = Array.from({ length: r.count(65536) }, () => {
    const key = readKey(r);
    const values = Array.from({ length: 13 }, () => r.number(0xffffffff));
    const [
      id,
      x,
      y,
      cols,
      rows,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      offsetX,
      offsetY,
      zigzag,
    ] = values;
    return {
      asset: key.id,
      pane: key.pane,
      id,
      x,
      y,
      cols,
      rows,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      offsetX,
      offsetY,
      z: zigzag % 2 ? -(zigzag + 1) / 2 : zigzag / 2,
    };
  });
  const retained = Array.from({ length: r.count(65536) }, () => readKey(r).id);
  return { assets, placements, retained };
}

export class PaneGraphicsCache {
  private assets = new Map<string, TerminalImageAsset>();
  update(scene: EndpointGraphics | undefined) {
    if (!scene) {
      this.assets.clear();
      return;
    }
    const live = new Set([
      ...scene.placements.map((p) => p.asset),
      ...scene.retained,
    ]);
    for (const id of this.assets.keys())
      if (!live.has(id)) this.assets.delete(id);
    for (const asset of scene.assets)
      if (live.has(asset.id)) this.assets.set(asset.id, asset);
  }
  pane(
    scene: EndpointGraphics | undefined,
    pane: string,
    rect: { x: number; y: number },
  ): TerminalGraphics {
    const placements = (scene?.placements ?? [])
      .filter((p) => p.pane === pane && this.assets.has(p.asset))
      .map((p) => ({
        ...p,
        x: p.x - rect.x,
        y: p.y - rect.y,
      }));
    const ids = new Set(placements.map((p) => p.asset));
    return { placements, assets: [...ids].map((id) => this.assets.get(id)!) };
  }
}

/** Reuse's JSON codec has the same scene, including opaque u64 keys. */
export function graphicsJsonBytes(value: unknown): Buffer {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new Error("Invalid graphics object");
    return v as Record<string, unknown>;
  };
  const array = (v: unknown, max: number): unknown[] => {
    if (!Array.isArray(v) || v.length > max)
      throw new Error("Invalid graphics collection");
    return v;
  };
  const number = (v: unknown, max = 0xffffffff): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max)
      throw new Error("Invalid graphics number");
    return v;
  };
  const string = (v: unknown): string => {
    if (typeof v !== "string") throw new Error("Invalid graphics string");
    return v;
  };
  const w = new BinWriter();
  const key = (value: unknown) => {
    const k = object(value),
      source = object(k.source);
    if (source.Terminal) {
      const terminal = object(source.Terminal),
        target = object(terminal.target);
      w.varint(0);
      w.varint(target.Pane ? 0 : 1);
      w.string(
        target.Pane
          ? string(object(target.Pane).pane_id)
          : string(object(target.Popup).terminal_id),
      );
      w.varint(number(terminal.image_id));
    } else {
      const layer = object(source.PaneLayer);
      w.varint(1);
      w.string(string(layer.pane_id));
      w.string(string(layer.layer_id));
    }
    w.varint(number(k.image_width));
    w.varint(number(k.image_height));
    const format = ["Rgb", "Rgba", "Png"].indexOf(string(k.format));
    if (format < 0) throw new Error("Invalid graphics format");
    w.varint(format);
    w.varint(number(k.data_len, Number.MAX_SAFE_INTEGER));
    const hash = BigInt(string(k.data_fingerprint));
    if (hash < 0n || hash > 0xffffffffffffffffn)
      throw new Error("Invalid graphics hash");
    w.varint(hash);
  };
  const scene = object(value);
  const assets = array(scene.assets, 4096);
  w.varint(assets.length);
  for (const raw of assets) {
    const a = object(raw);
    key(a.key);
    w.bytes(
      Uint8Array.from(
        array(a.data, 2 * 1024 * 1024).map((v) => number(v, 255)),
      ),
    );
  }
  const placements = array(scene.placements, 65536);
  w.varint(placements.length);
  for (const raw of placements) {
    const p = object(raw);
    key(p.asset);
    for (const name of [
      "logical_placement_id",
      "x",
      "y",
      "cols",
      "rows",
      "source_x",
      "source_y",
      "source_width",
      "source_height",
      "x_offset",
      "y_offset",
    ])
      w.varint(number(p[name]));
    const z = p.z;
    if (
      typeof z !== "number" ||
      !Number.isInteger(z) ||
      z < -2147483648 ||
      z > 2147483647
    )
      throw new Error("Invalid graphics z");
    w.varint(z < 0 ? -z * 2 - 1 : z * 2);
    w.varint(number(p.scrollback_offset));
  }
  const retained = array(scene.retained_assets, 65536);
  w.varint(retained.length);
  for (const asset of retained) key(asset);
  return w.toBuffer();
}
