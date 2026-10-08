import type { BinReader } from "./bincode";

/** One rendered cell of Herdr's wire `FrameData`, shared by endpoint surfaces. */
export interface CellData {
  symbol: string;
  fg: number;
  bg: number;
  modifier: number;
  skip: boolean;
  hyperlink: number | null;
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  shape: number;
}

export interface FrameData {
  cells: CellData[];
  width: number;
  height: number;
  cursor: CursorState | null;
  hyperlinks: string[];
}

export function readCellData(r: BinReader): CellData {
  return {
    symbol: r.string(),
    fg: r.varint(),
    bg: r.varint(),
    modifier: r.varint(),
    skip: r.bool(),
    hyperlink: r.option(() => r.varint()),
  };
}
