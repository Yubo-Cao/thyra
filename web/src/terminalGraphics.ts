import type { TerminalEngine } from "./terminalEngine";
import type {
  TerminalGraphics,
  TerminalImageAsset,
} from "../../shared/terminalGraphics";

async function decode(asset: TerminalImageAsset): Promise<ImageBitmap> {
  if (
    !Number.isSafeInteger(asset.width * asset.height) ||
    asset.width <= 0 ||
    asset.height <= 0 ||
    asset.width * asset.height > 16_777_216 ||
    asset.data.length > 45_000_000
  )
    throw new Error("Image exceeds terminal budget");
  const bytes = Uint8Array.from(atob(asset.data), (char) => char.charCodeAt(0));
  if (asset.format === 2) {
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    if (bitmap.width !== asset.width || bitmap.height !== asset.height) {
      bitmap.close();
      throw new Error("Image dimensions differ from terminal metadata");
    }
    return bitmap;
  }
  const channels = asset.format === 0 ? 3 : 4;
  if (bytes.length !== asset.width * asset.height * channels)
    throw new Error("Invalid image data");
  const rgba = new Uint8ClampedArray(asset.width * asset.height * 4);
  for (let i = 0, j = 0; i < bytes.length; i += channels, j += 4) {
    rgba[j] = bytes[i];
    rgba[j + 1] = bytes[i + 1];
    rgba[j + 2] = bytes[i + 2];
    rgba[j + 3] = channels === 4 ? bytes[i + 3] : 255;
  }
  return createImageBitmap(new ImageData(rgba, asset.width, asset.height));
}

/** Herdr has already decoded Kitty commands, scrolled and clipped placements. */
export function attachTerminalGraphics(term: TerminalEngine) {
  const canvas = document.createElement("canvas");
  canvas.className = "terminal-graphics";
  Object.assign(canvas.style, {
    position: "absolute",
    pointerEvents: "none",
    zIndex: "1",
  });
  term.element.append(canvas);
  let disposed = false;
  let revision = 0;
  let scene: TerminalGraphics | undefined;
  let sceneKey = "";
  const cache = new Map<string, Promise<ImageBitmap>>();
  const clearAsset = (id: string) => {
    void cache.get(id)?.then(
      (bitmap) => bitmap.close(),
      () => {},
    );
    cache.delete(id);
  };
  const draw = async () => {
    const current = ++revision;
    const placements = [...(scene?.placements ?? [])].sort((a, b) => a.z - b.z);
    const bitmaps = await Promise.all(
      placements.map((p) => cache.get(p.asset)?.catch(() => null)),
    );
    if (disposed || current !== revision) return;
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = term.screenSize();
    Object.assign(canvas.style, {
      left: `${term.screen.offsetLeft}px`,
      top: `${term.screen.offsetTop}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    placements.forEach((p, i) => {
      const bitmap = bitmaps[i];
      if (!bitmap || !p.cols || !p.rows) return;
      const cw = width / term.cols,
        ch = height / term.rows;
      ctx.drawImage(
        bitmap,
        p.sourceX,
        p.sourceY,
        p.sourceWidth || bitmap.width,
        p.sourceHeight || bitmap.height,
        p.x * cw + (p.offsetX * cw) / 8,
        p.y * ch + (p.offsetY * ch) / 16,
        p.cols * cw - (p.offsetX * cw) / 8,
        p.rows * ch - (p.offsetY * ch) / 16,
      );
    });
  };
  const observer = new ResizeObserver(() => void draw());
  observer.observe(term.element);
  const resized = term.onResize(() => void draw());
  return {
    update(next?: TerminalGraphics) {
      const key = JSON.stringify([
        next?.placements,
        next?.assets.map((a) => a.id),
      ]);
      if (key === sceneKey) return;
      sceneKey = key;
      scene = next;
      let pixels = 0;
      const live = new Set<string>();
      for (const asset of next?.assets ?? []) {
        pixels += asset.width * asset.height;
        if (pixels > 33_554_432) break;
        live.add(asset.id);
        if (!cache.has(asset.id)) cache.set(asset.id, decode(asset));
      }
      for (const id of cache.keys()) if (!live.has(id)) clearAsset(id);
      void draw();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      resized.dispose();
      canvas.remove();
      for (const id of cache.keys()) clearAsset(id);
    },
  };
}
