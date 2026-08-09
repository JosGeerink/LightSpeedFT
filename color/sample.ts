// color/sample.ts
// Read a raster back into per-cell RGB samples by averaging an inner window
// of each cell — the sim's stand-in for the camera+detection geometry, which
// Phase 2 replaces with the real tracked-sampling path.

import type { RGB } from "./palette";
import type { Raster } from "./raster";

export function sampleGrid(
  raster: Raster,
  cols: number,
  rows: number,
  cellPx: number,
  margin = 4,
): RGB[] {
  const inset = Math.max(1, Math.floor(cellPx * 0.25));
  const window = cellPx - 2 * inset;
  const samples: RGB[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const x0 = margin + x * cellPx + inset;
      const y0 = margin + y * cellPx + inset;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < window; dy++) {
        const row = (y0 + dy) * raster.width;
        for (let dx = 0; dx < window; dx++) {
          const p = raster.pixels[row + x0 + dx]!;
          r += p & 0xff;
          g += (p >>> 8) & 0xff;
          b += (p >>> 16) & 0xff;
          n++;
        }
      }
      samples.push({ r: r / n, g: g / n, b: b / n });
    }
  }
  return samples;
}
