// tests/color-sim-channel.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLEAN,
  PROFILES,
  channelAt,
  corruptRaster,
  corruptSamples,
  dropMask,
  mulberry32,
  type Profile,
} from "../color/sim-channel.ts";
import { rasterizeGrid } from "../color/raster.ts";
import { colorMaxFrameBytes } from "../shared/frame-capacity.ts";
import { encodeFrame } from "../color/format.ts";
import { PALETTE_4 } from "../color/palette.ts";

test("mulberry32 is deterministic and uniform-ish", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next(), "same seed, same stream");
  const c = mulberry32(43);
  assert.notEqual(a.next(), c.next());
});

test("CLEAN corruptRaster is a no-op (same pixels, same order)", () => {
  const r = rasterizeGrid(makeGrid(), PALETTE_4, 8, 4);
  const out = corruptRaster(r, CLEAN, mulberry32(1));
  assert.deepEqual(Array.from(out.pixels), Array.from(r.pixels));
});

test("brightness dimming darkens every pixel", () => {
  const r = rasterizeGrid(makeGrid(), PALETTE_4, 8, 4);
  const out = corruptRaster(r, { ...CLEAN, brightness: 0.5 }, mulberry32(1));
  const src = r.pixels[5 * r.width + 5]!;
  const dst = out.pixels[5 * out.width + 5]!;
  assert.ok((dst & 0xff) <= (src & 0xff), "red dimmed");
  assert.ok(((dst >>> 8) & 0xff) <= ((src >>> 8) & 0xff), "green dimmed");
});

test("tint shifts channels additively", () => {
  const r = rasterizeGrid(makeGrid(), PALETTE_4, 8, 4);
  const out = corruptRaster(r, { ...CLEAN, tint: [30, 0, 0] }, mulberry32(1));
  assert.ok((out.pixels[5 * out.width + 5]! & 0xff) >= 30, "red boosted by tint");
});

test("noise perturbs but the channel stays seeded-deterministic", () => {
  const r = rasterizeGrid(makeGrid(), PALETTE_4, 8, 4);
  const a = corruptRaster(r, { ...CLEAN, noise: 20 }, mulberry32(7));
  const b = corruptRaster(r, { ...CLEAN, noise: 20 }, mulberry32(7));
  assert.deepEqual(Array.from(a.pixels), Array.from(b.pixels));
});

test("corruptSamples jitters cells and flags blend cells", () => {
  // blendFraction 0.25 over 4 cells forces nBlend = floor(4·0.25) = 1, so the
  // blend branch actually executes (0.1 would round to 0 and only the jitter
  // path would run — the blend→erasure mechanism would be untested).
  const opts = { ...CLEAN, cellJitter: 10, blendFraction: 0.25 };
  const samples = PALETTE_4.slice();
  const expected = PALETTE_4.slice();
  const { samples: out, blends } = corruptSamples(samples, expected, opts, mulberry32(3));
  assert.equal(out.length, 4);
  assert.equal(blends.length, 4);
  const blendIdx = blends.findIndex(Boolean);
  assert.ok(blendIdx >= 0, "blendFraction 0.25 over 4 cells must flag a blend cell");
  // The flagged cell sits at the midpoint of SOME palette pair (midpoint ±
  // jitter). Searching all pairs keeps the assertion seed-independent.
  let nearMidpoint = false;
  for (let a = 0; a < 4 && !nearMidpoint; a++) {
    for (let b = a + 1; b < 4 && !nearMidpoint; b++) {
      const mid = {
        r: (expected[a]!.r + expected[b]!.r) / 2,
        g: (expected[a]!.g + expected[b]!.g) / 2,
        b: (expected[a]!.b + expected[b]!.b) / 2,
      };
      nearMidpoint =
        Math.abs(out[blendIdx]!.r - mid.r) <= 12 &&
        Math.abs(out[blendIdx]!.g - mid.g) <= 12 &&
        Math.abs(out[blendIdx]!.b - mid.b) <= 12;
    }
  }
  assert.ok(nearMidpoint, "blend cell sits at a palette midpoint");
  for (let i = 0; i < out.length; i++) {
    if (blends[i]) continue;
    assert.ok(Math.abs(out[i]!.r - samples[i]!.r) <= 12, "jitter bounded");
  }
});

test("dropMask drops roughly dropRate frames, deterministically", () => {
  const rng = mulberry32(9);
  const mask = dropMask(100, 0.3, rng);
  const dropped = mask.filter(Boolean).length;
  assert.ok(dropped > 15 && dropped < 45, `dropped ${dropped}/100`);
});

test("channelAt interpolates between episodes", () => {
  const profile: Profile = {
    duration: 10, dropRate: 0,
    episodes: [
      { t: 0, opts: CLEAN },
      { t: 10, opts: { ...CLEAN, brightness: 0.5 } },
    ],
  };
  assert.equal(channelAt(profile, 0).brightness, 1);
  assert.equal(channelAt(profile, 10).brightness, 0.5);
  assert.equal(channelAt(profile, 5).brightness, 0.75);
});

test("PROFILES includes clean and degrading with sane ranges", () => {
  assert.ok(PROFILES.clean);
  assert.ok(PROFILES.degrading);
  for (const key of ["clean", "degrading"]) {
    for (const ep of PROFILES[key]!.episodes) {
      assert.ok(ep.opts.brightness > 0);
      assert.ok(ep.opts.blendFraction >= 0 && ep.opts.blendFraction <= 0.5);
    }
  }
});

function makeGrid() {
  const frameBytes = new Uint8Array(colorMaxFrameBytes(8, 8, 2, 26));
  const grid = encodeFrame(frameBytes, { cols: 8, rows: 8, bitsPerCell: 2, nsym: 26 });
  return grid;
}
