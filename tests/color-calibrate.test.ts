// tests/color-calibrate.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { PALETTE_4 } from "../color/palette.ts";
import { applyCcm, fitCcm, neutralCcm } from "../color/calibrate.ts";

test("neutralCcm is the identity", () => {
  const m = neutralCcm();
  assert.deepEqual(applyCcm({ r: 10, g: 20, b: 30 }, m), { r: 10, g: 20, b: 30 });
});

test("fitCcm on unperturbed swatches recovers the identity", () => {
  const m = fitCcm([...PALETTE_4], [...PALETTE_4]);
  assert.ok(m !== null);
  for (let i = 0; i < PALETTE_4.length; i++) {
    const r = applyCcm(PALETTE_4[i]!, m);
    assert.ok(Math.abs(r.r - PALETTE_4[i]!.r) < 1e-6);
    assert.ok(Math.abs(r.g - PALETTE_4[i]!.g) < 1e-6);
    assert.ok(Math.abs(r.b - PALETTE_4[i]!.b) < 1e-6);
  }
});

test("fitCcm inverts a known global transform", () => {
  // A real-world-ish ISP shift: red scaled 1.25, green dimmed, blue tinted.
  // Linear only — a 3×3 CCM has no translation term, so an affine offset
  // cannot be inverted exactly (a +10/+5/+20 offset leaves a ~5-unit residual,
  // not <0.5). Offsets are absorbed downstream by the brightness-invariant
  // relative-space classifier (Task 1), not by the CCM.
  const observed = PALETTE_4.map((c) => ({
    r: c.r * 1.25,
    g: c.g * 0.8,
    b: c.b * 1.1,
  }));
  const m = fitCcm(observed, [...PALETTE_4]);
  assert.ok(m !== null);
  for (let i = 0; i < PALETTE_4.length; i++) {
    const r = applyCcm(observed[i]!, m);
    const p = PALETTE_4[i]!;
    assert.ok(Math.abs(r.r - p.r) < 0.5, `r: got ${r.r}, want ${p.r}`);
    assert.ok(Math.abs(r.g - p.g) < 0.5, `g: got ${r.g}, want ${p.g}`);
    assert.ok(Math.abs(r.b - p.b) < 0.5, `b: got ${r.b}, want ${p.b}`);
  }
});

test("fitCcm tolerates small measurement noise", () => {
  const noise = (c: { r: number; g: number; b: number }) => ({
    r: c.r + 2,
    g: c.g - 1,
    b: c.b + 3,
  });
  const observed = PALETTE_4.map(noise);
  const m = fitCcm(observed, [...PALETTE_4]);
  assert.ok(m !== null);
  const r = applyCcm(observed[0]!, m);
  assert.ok(Math.abs(r.r - PALETTE_4[0]!.r) < 5);
});

test("fitCcm returns null with fewer than 3 swatches", () => {
  assert.equal(fitCcm([{ r: 1, g: 2, b: 3 }], [{ r: 0, g: 255, b: 0 }]), null);
});
