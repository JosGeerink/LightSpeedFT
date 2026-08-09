// color/raster.ts
// Paint a FrameGrid into a pixel buffer. Same little-endian RGBA-u32
// convention as shared/qr-raster.ts so the sender can hand the result to
// ImageData at no copy.

import type { RGB } from "./palette";
import { clampByte, paletteColor } from "./palette";
import type { FrameGrid } from "./format";
import { calibrationColor } from "./format";

const WHITE = 0xffffffff;

export interface Raster {
  width: number;
  height: number;
  /** RGBA bytes viewed as one little-endian u32 per pixel (A in the high byte). */
  pixels: Uint32Array;
}

function opaque(rgb: RGB): number {
  return (0xff << 24) | (clampByte(rgb.b) << 16) | (clampByte(rgb.g) << 8) | clampByte(rgb.r);
}

export function rasterizeGrid(
  grid: FrameGrid,
  palette: readonly RGB[],
  cellPx: number,
  margin = 4,
): Raster {
  const width = grid.cols * cellPx + 2 * margin;
  const height = grid.rows * cellPx + 2 * margin;
  const pixels = new Uint32Array(width * height);
  pixels.fill(WHITE);
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const v = grid.cells[i];
      const rgb = v === null ? calibrationColor(palette, i) : paletteColor(palette, v);
      const color = opaque(rgb);
      const base = (margin + y * cellPx) * width + margin + x * cellPx;
      for (let dy = 0; dy < cellPx; dy++) {
        const row = base + dy * width;
        for (let dx = 0; dx < cellPx; dx++) pixels[row + dx] = color;
      }
    }
  }
  return { width, height, pixels };
}
