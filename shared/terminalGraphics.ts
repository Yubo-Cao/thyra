/** Complete placements; frame deltas may omit assets already sent to that viewer. */
export interface TerminalImageAsset {
  id: string;
  width: number;
  height: number;
  format: number;
  data: string;
}
export interface TerminalImagePlacement {
  asset: string;
  id: number;
  x: number;
  y: number;
  cols: number;
  rows: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  offsetX: number;
  offsetY: number;
  z: number;
}
export interface TerminalGraphics {
  assets: TerminalImageAsset[];
  placements: TerminalImagePlacement[];
}

/** Rehydrate on receipt, before presentation can coalesce intermediate frames. */
export class TerminalGraphicsStore {
  private assets = new Map<string, TerminalImageAsset>();
  update(scene?: TerminalGraphics): TerminalGraphics | undefined {
    if (!scene) {
      this.assets.clear();
      return;
    }
    const live = new Set(scene.placements.map((p) => p.asset));
    for (const id of this.assets.keys())
      if (!live.has(id)) this.assets.delete(id);
    for (const asset of scene.assets)
      if (live.has(asset.id)) this.assets.set(asset.id, asset);
    return { placements: scene.placements, assets: [...this.assets.values()] };
  }
}
