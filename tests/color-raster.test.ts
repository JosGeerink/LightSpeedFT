// tests/color-raster.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { colorMaxFrameBytes } from "../shared/frame-capacity.ts";
import { calibrationColor, decodeFrame, encodeFrame } from "../color/format.ts";
import { PALETTE_4 } from "../color/palette.ts";
import { rasterizeGrid } from "../color/raster.ts";
import { sampleGrid } from "../color/sample.ts";

test("rasterizeGrid paints each cell's color in a cellPx block plus margin", () => {
  const grid = {
    cols: 2, rows: 2, bitsPerCell: 2, nsym: 26, frameBytes: 1,
    cells: [0, 1, null, 2],
    calibrationColors: [calibrationColor(PALETTE_4, 0), calibrationColor(PALETTE_4, 1)],
  };
  const r = rasterizeGrid(grid, PALETTE_4, 4, 2);
  assert.equal(r.width, 2 * 4 + 2 * 2);
  assert.equal(r.height, 2 * 4 + 2 * 2);
  const px = r.pixels;
  const at = (x: number, y: number) => px[y * r.width + x]!;
  // cell (0,0) = green, inside the 4x4 block
  assert.equal(at(2 + 1, 2 + 1) & 0xff, 0); // R=0
  assert.equal((at(2 + 1, 2 + 1) >>> 8) & 0xff, 255); // G=255
  // margin stays white
  assert.equal(at(0, 0), 0xffffffff);
});

test("sampleGrid recovers cell colors (inner window)", () => {
  const grid = {
    cols: 4, rows: 4, bitsPerCell: 2, nsym: 26, frameBytes: 1,
    cells: [0, 1, 2, null, 3, 0, 1, null, 2, 3, 0, null, 1, 2, 3, null],
    calibrationColors: [],
  };
  const cellPx = 8;
  const r = rasterizeGrid(grid, PALETTE_4, cellPx, 4);
  const samples = sampleGrid(r, 4, 4, cellPx, 4);
  assert.equal(samples.length, 16);
  const g = samples[0]!;
  assert.ok(Math.abs(g.r - 0) < 1 && Math.abs(g.g - 255) < 1 && Math.abs(g.b - 0) < 1, "green cell");
  const c = samples[1]!;
  assert.ok(Math.abs(c.g - 255) < 1 && Math.abs(c.b - 255) < 1, "cyan cell");
});

test("full round-trip: encode → rasterize → sample → decode recovers frameBytes", () => {
  // 36×36 at 2 bits holds one whole RS codeword (229 payload bytes).
  const frameBytes = new Uint8Array(colorMaxFrameBytes(36, 36, 2, 26));
  for (let i = 0; i < frameBytes.length; i++) frameBytes[i] = (i * 29) & 0xff;
  const opts = { cols: 36, rows: 36, bitsPerCell: 2 as const, nsym: 26 };
  const grid = encodeFrame(frameBytes, opts);
  const r = rasterizeGrid(grid, PALETTE_4, 8, 4);
  const samples = sampleGrid(r, 36, 36, 8, 4);
  const dec = decodeFrame(samples, frameBytes.length, opts);
  assert.ok(dec.frameBytes !== null);
  assert.deepEqual(dec.frameBytes, frameBytes);
});
