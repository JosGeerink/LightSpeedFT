// tests/color-png.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { colorMaxFrameBytes } from "../shared/frame-capacity.ts";
import { encodeFrame } from "../color/format.ts";
import { PALETTE_4 } from "../color/palette.ts";
import { rasterizeGrid } from "../color/raster.ts";
import { decodePng, encodePng } from "../color/png.ts";

test("encodePng produces a valid PNG signature and IHDR", () => {
  const r = { width: 8, height: 8, pixels: new Uint32Array(64).fill(0xffffffff) };
  const png = encodePng(r);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR chunk type at offset 12
  assert.equal(new TextDecoder().decode(png.subarray(12, 16)), "IHDR");
});

test("encodePng→decodePng round-trips pixels exactly", () => {
  const r = { width: 16, height: 16, pixels: new Uint32Array(16 * 16) };
  for (let i = 0; i < r.pixels.length; i++) r.pixels[i] = (i * 0x010101 + 0xff000000) >>> 0;
  const png = encodePng(r);
  const back = decodePng(png);
  assert.equal(back.width, 16);
  assert.equal(back.height, 16);
  assert.deepEqual(Array.from(back.pixels), Array.from(r.pixels));
});

test("a real color frame survives a PNG file round-trip", () => {
  // 34×34 → (34−2)² = 1024 data cells × 2 bits = 2048 bits ≥ one 255-byte
  // codeword's budget, so the frame is non-empty (a 12×12 grid would be
  // capacity 0 and encode nothing — the round-trip would not exercise RS).
  const frameBytes = new Uint8Array(colorMaxFrameBytes(34, 34, 2, 26));
  for (let i = 0; i < frameBytes.length; i++) frameBytes[i] = (i * 47) & 0xff;
  const grid = encodeFrame(frameBytes, { cols: 34, rows: 34, bitsPerCell: 2, nsym: 26 });
  const raster = rasterizeGrid(grid, PALETTE_4, 8, 4);
  const back = decodePng(encodePng(raster));
  assert.equal(back.width, raster.width);
  assert.equal(back.height, raster.height);
  assert.deepEqual(Array.from(back.pixels), Array.from(raster.pixels));
});
