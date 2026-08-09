// tests/color-format.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { colorGridSize, colorMaxFrameBytes, colorDataCells } from "../shared/frame-capacity.ts";
import { encodeFrame, decodeFrame, calibrationColor, isCalibration } from "../color/format.ts";
import { PALETTE_4, PALETTE_8, paletteColor } from "../color/palette.ts";

test("capacity math: perimeter is calibration, interior is data", () => {
  assert.equal(colorDataCells(10, 10), 64);
  // 48×48: (46×46) interior × 2 bits = 4232 bits → 2 whole RS codewords
  // (floor(4232/2040) = 2) × 229 data bytes each. Capacity is quantized to
  // whole codewords: a partial codeword would not fit its 255-byte frame.
  assert.equal(colorMaxFrameBytes(48, 48, 2, 26), 458);
});

test("colorGridSize returns the smallest square grid that fits frameBytes", () => {
  // frameBytes 100, 2 bits, nsym 102 (the worst case): k=153, codewords=ceil(100/153)=1,
  // needs 1*255*8=2040 bits = 1020 data cells → (s-2)^2 >= 1020 → s = 34.
  assert.equal(colorGridSize(100, 2, 102), 34);
});

test("calibration cells are the perimeter; calibrationColor cycles the palette", () => {
  assert.equal(isCalibration(5, 5, 0), true);
  assert.equal(isCalibration(5, 5, 12), false);
  assert.deepEqual(calibrationColor(PALETTE_4, 0), PALETTE_4[0]);
  assert.deepEqual(calibrationColor(PALETTE_4, 4), PALETTE_4[0]);
});

test("encode→decode round-trips frameBytes cleanly (2 bits)", () => {
  // 48×48 at 2 bits holds 2 whole RS codewords — enough to exercise interleave.
  const frameBytes = new Uint8Array(colorMaxFrameBytes(48, 48, 2, 26));
  for (let i = 0; i < frameBytes.length; i++) frameBytes[i] = (i * 37) & 0xff;
  const grid = encodeFrame(frameBytes, { cols: 48, rows: 48, bitsPerCell: 2, nsym: 26 });
  const samples = grid.cells.map((v, i) =>
    v === null ? calibrationColor(PALETTE_4, i) : paletteColor(PALETTE_4, v),
  );
  const dec = decodeFrame(samples, frameBytes.length, { cols: 48, rows: 48, bitsPerCell: 2, nsym: 26 });
  assert.ok(dec.frameBytes !== null);
  assert.deepEqual(dec.frameBytes, frameBytes);
  assert.equal(dec.blends, 0);
  assert.equal(dec.rsCorrectedBytes, 0);
  assert.equal(dec.calibrationOk, true);
});

test("encode→decode round-trips frameBytes cleanly (3 bits)", () => {
  // 40×40 at 3 bits: (38×38) interior × 3 = 4332 bits → 2 whole codewords.
  const frameBytes = new Uint8Array(colorMaxFrameBytes(40, 40, 3, 26));
  for (let i = 0; i < frameBytes.length; i++) frameBytes[i] = (i * 53) & 0xff;
  const grid = encodeFrame(frameBytes, { cols: 40, rows: 40, bitsPerCell: 3, nsym: 26 });
  const samples = grid.cells.map((v, i) =>
    v === null ? calibrationColor(PALETTE_8, i) : paletteColor(PALETTE_8, v),
  );
  const dec = decodeFrame(samples, frameBytes.length, { cols: 40, rows: 40, bitsPerCell: 3, nsym: 26 });
  assert.ok(dec.frameBytes !== null);
  assert.deepEqual(dec.frameBytes, frameBytes);
});

test("a few corrupted data samples are repaired by RS", () => {
  const frameBytes = new Uint8Array(colorMaxFrameBytes(48, 48, 2, 51));
  for (let i = 0; i < frameBytes.length; i++) frameBytes[i] = (i * 71) & 0xff;
  const grid = encodeFrame(frameBytes, { cols: 48, rows: 48, bitsPerCell: 2, nsym: 51 });
  const samples = grid.cells.map((v, i) =>
    v === null ? calibrationColor(PALETTE_4, i) : paletteColor(PALETTE_4, v),
  );
  // Corrupt 10 data cells by explicitly cycling each to the next palette
  // symbol — a guaranteed symbol flip. (A small additive shift like +40 on r
  // does NOT flip any 2-bit symbol: the palette channels are 255 apart, and
  // classifySample still lands on the true symbol in relative space, so RS
  // would report zero corrections and the `rsCorrectedBytes > 0` assertion
  // would fail. Verified against the Task 1 classifier.)
  let corrupted = 0;
  for (let i = 0; i < samples.length && corrupted < 10; i++) {
    if (isCalibration(48, 48, i)) continue;
    const v = grid.cells[i]!;
    samples[i] = paletteColor(PALETTE_4, (v + 1) % PALETTE_4.length);
    corrupted++;
  }
  const dec = decodeFrame(samples, frameBytes.length, { cols: 48, rows: 48, bitsPerCell: 2, nsym: 51 });
  assert.ok(dec.frameBytes !== null);
  assert.deepEqual(dec.frameBytes, frameBytes);
  assert.ok(dec.rsCorrectedBytes > 0, "RS must report corrected bytes");
});

test("encodeFrame rejects an oversized payload", () => {
  assert.throws(() => {
    encodeFrame(new Uint8Array(colorMaxFrameBytes(8, 8, 2, 26) + 1), {
      cols: 8, rows: 8, bitsPerCell: 2, nsym: 26,
    });
  });
});
