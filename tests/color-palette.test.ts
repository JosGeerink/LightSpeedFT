// tests/color-palette.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  PALETTE_4,
  PALETTE_8,
  classifySample,
  normalize,
  paletteColor,
  paletteDiameter,
  paletteFor,
  relativeSpace,
} from "../color/palette.ts";

test("paletteFor maps 2 bits to the 4-color set and 3 bits to the 8-color set", () => {
  assert.equal(paletteFor(2).length, 4);
  assert.equal(paletteFor(3).length, 8);
  assert.equal(paletteFor(2)[0]!.r, 0);
  assert.equal(paletteFor(2)[0]!.g, 255);
  assert.equal(paletteFor(3)[0]!.r, 0); // black
});

test("paletteColor is the inverse of the palette index", () => {
  assert.deepEqual(paletteColor(PALETTE_4, 2), PALETTE_4[2]);
  assert.deepEqual(paletteColor(PALETTE_8, 7), { r: 255, g: 255, b: 255 });
});

test("normalize makes a dimmed color classify identically to its full-brightness sibling", () => {
  const bright = { r: 0, g: 255, b: 0 };
  const dim = { r: 0, g: 128, b: 0 };
  assert.deepEqual(normalize(bright), { r: 0, g: 255, b: 0 });
  assert.deepEqual(normalize(dim), { r: 0, g: 255, b: 0 });
});

test("relativeSpace computes (r-g, g-b, b-r)", () => {
  assert.deepEqual(relativeSpace({ r: 0, g: 255, b: 0 }), [-255, 255, 0]);
  assert.deepEqual(relativeSpace({ r: 255, g: 255, b: 255 }), [0, 0, 0]);
});

test("clean palette colors classify to their own symbol", () => {
  for (let i = 0; i < PALETTE_4.length; i++) {
    const cls = classifySample(paletteColor(PALETTE_4, i), PALETTE_4, {});
    assert.equal(cls.symbol, i);
    assert.equal(cls.blend, false);
  }
});

test("a sample exactly between two palette colors is a blend, not a value", () => {
  const green = PALETTE_4[0]!;
  const cyan = PALETTE_4[1]!;
  const between = { r: (green.r + cyan.r) / 2, g: (green.g + cyan.g) / 2, b: (green.b + cyan.b) / 2 };
  const cls = classifySample(between, PALETTE_4, {});
  assert.equal(cls.blend, true);
});

test("black and white collapse in brightness-invariant space but are separable in RGB", () => {
  // The design refinement: relative space discards the black/white axis, so
  // the 8-color set must classify in calibrated RGB, not relative space.
  const blackCls = classifySample({ r: 0, g: 0, b: 0 }, PALETTE_8, { brightnessInvariant: true });
  const whiteCls = classifySample({ r: 255, g: 255, b: 255 }, PALETTE_8, { brightnessInvariant: true });
  assert.equal(blackCls.symbol, whiteCls.symbol, "relative space cannot tell black from white");
  const blackClsRgb = classifySample({ r: 0, g: 0, b: 0 }, PALETTE_8, { brightnessInvariant: false });
  const whiteClsRgb = classifySample({ r: 255, g: 255, b: 255 }, PALETTE_8, { brightnessInvariant: false });
  assert.notEqual(blackClsRgb.symbol, whiteClsRgb.symbol, "calibrated RGB keeps brightness");
});

test("paletteDiameter is positive and finite", () => {
  assert.ok(paletteDiameter(PALETTE_4, true) > 0);
  assert.ok(paletteDiameter(PALETTE_8, false) > 0);
});
