// color/sim-channel.ts
// The synthetic channel the closed loop runs against. Two stages, because the
// real camera path splits that way too:
//   1. corruptRaster  — global, image-space ISP + sensor effects (tint, gamma,
//                       brightness/auto-exposure, blur, sensor noise, off-angle
//                       vignette). Operates on the pixel buffer.
//   2. corruptSamples — per-cell effects that happen between sampling and
//                       classification: random color jitter ("deliberately
//                       mess things up") and blend/transition cells caught
//                       mid-flip, which decode as erasures.
// Frame drops model the camera missing a full frame.
//
// No JPEG: the live path never recompresses (getUserMedia → drawImage →
// getImageData is raw RGBA). The real distortions are the phone ISP's, and
// they are the smooth/global kinds a per-frame CCM absorbs.

import type { RGB } from "./palette";
import { clampByte } from "./palette";
import type { Raster } from "./raster";

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
}

/** mulberry32 — small, fast, deterministic. */
export function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Standard normal via Box–Muller. */
export function gaussian(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface ChannelOpts {
  /** Global brightness multiplier (1 = none). */
  brightness: number;
  /** Additive per-channel tint, 0..255 (0,0,0 = none). */
  tint: [number, number, number];
  /** Per-channel gamma exponent on [0,1] (1 = none; <1 brightens shadows). */
  gamma: number;
  /** Gaussian lens-blur radius in pixels (0 = none). */
  blurRadius: number;
  /** Gaussian sensor noise, sigma per channel (0 = none). */
  noise: number;
  /** Max per-cell RGB perturbation, uniform (0 = none). */
  cellJitter: number;
  /** Fraction of cells forced into blend regions (0..1). */
  blendFraction: number;
  /** Off-angle falloff: brightness × (1 − vignette·r²), r = normalized radius. */
  vignette: number;
}

export const CLEAN: ChannelOpts = {
  brightness: 1,
  tint: [0, 0, 0],
  gamma: 1,
  blurRadius: 0,
  noise: 0,
  cellJitter: 0,
  blendFraction: 0,
  vignette: 0,
};

export function corruptRaster(raster: Raster, opts: ChannelOpts, rng: Rng): Raster {
  const n = raster.pixels.length;
  if (
    opts.brightness === 1 && opts.tint[0] === 0 && opts.tint[1] === 0 && opts.tint[2] === 0 &&
    opts.gamma === 1 && opts.noise === 0 && opts.blurRadius === 0 && opts.vignette === 0
  ) {
    return raster;
  }
  let src = raster.pixels;
  if (opts.blurRadius > 0) src = gaussianBlur(src, raster.width, raster.height, opts.blurRadius);
  const cx = (raster.width - 1) / 2;
  const cy = (raster.height - 1) / 2;
  const rMax = Math.hypot(cx, cy) || 1;
  const out = new Uint32Array(n);
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const i = y * raster.width + x;
      const v = src[i]!;
      let mult = opts.brightness;
      if (opts.vignette > 0) {
        const r = Math.hypot(x - cx, y - cy) / rMax;
        mult *= 1 - opts.vignette * r * r;
      }
      let r = (v & 0xff) * mult + opts.tint[0];
      let g = ((v >>> 8) & 0xff) * mult + opts.tint[1];
      let b = ((v >>> 16) & 0xff) * mult + opts.tint[2];
      if (opts.gamma !== 1) {
        r = Math.pow(Math.max(0, Math.min(1, r / 255)), opts.gamma) * 255;
        g = Math.pow(Math.max(0, Math.min(1, g / 255)), opts.gamma) * 255;
        b = Math.pow(Math.max(0, Math.min(1, b / 255)), opts.gamma) * 255;
      }
      if (opts.noise > 0) {
        r += gaussian(rng) * opts.noise;
        g += gaussian(rng) * opts.noise;
        b += gaussian(rng) * opts.noise;
      }
      out[i] = 0xff000000 | (clampByte(b) << 16) | (clampByte(g) << 8) | clampByte(r);
    }
  }
  return { width: raster.width, height: raster.height, pixels: out };
}

function gaussianBlur(src: Uint32Array, w: number, h: number, radius: number): Uint32Array {
  const n = w * h;
  const R = new Float64Array(n);
  const G = new Float64Array(n);
  const B = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    R[i] = v & 0xff;
    G[i] = (v >>> 8) & 0xff;
    B[i] = (v >>> 16) & 0xff;
  }
  const sigma = Math.max(1, radius / 2);
  const size = 2 * radius + 1;
  const kernel = new Float64Array(size);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const wgt = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = wgt;
    sum += wgt;
  }
  for (let i = 0; i < size; i++) kernel[i] = kernel[i]! / sum;
  const blur = (plane: Float64Array): Float64Array => {
    const tmp = new Float64Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          acc += plane[y * w + xx]! * kernel[i + radius]!;
        }
        tmp[y * w + x] = acc;
      }
    }
    const out = new Float64Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          acc += tmp[yy * w + x]! * kernel[i + radius]!;
        }
        out[y * w + x] = acc;
      }
    }
    return out;
  };
  const bR = blur(R);
  const bG = blur(G);
  const bB = blur(B);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0xff000000 | (clampByte(bB[i]!) << 16) | (clampByte(bG[i]!) << 8) | clampByte(bR[i]!);
  }
  return out;
}

/** Per-cell jitter + blend cells. `expected` is the true per-cell color — the
 *  channel is the environment, so it is allowed to know it. Blend cells get a
 *  color halfway between two cells' true colors, which classification sees as
 *  an erasure. */
export function corruptSamples(
  samples: RGB[],
  expected: RGB[],
  opts: ChannelOpts,
  rng: Rng,
): { samples: RGB[]; blends: boolean[] } {
  const out = samples.map((c) => ({
    r: c.r + (rng.next() * 2 - 1) * opts.cellJitter,
    g: c.g + (rng.next() * 2 - 1) * opts.cellJitter,
    b: c.b + (rng.next() * 2 - 1) * opts.cellJitter,
  }));
  const blends = new Array<boolean>(samples.length).fill(false);
  const nBlend = Math.floor(samples.length * opts.blendFraction);
  if (nBlend > 0) {
    const order = samples.map((_, i) => i);
    // deterministic shuffle
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = order[i]!;
      order[i] = order[j]!;
      order[j] = t;
    }
    const other = Math.floor(samples.length / 2);
    for (let i = 0; i < nBlend; i++) {
      const idx = order[i]!;
      const j = order[(i + other) % order.length]!;
      const a = expected[idx]!;
      const b = expected[j]!;
      out[idx] = {
        r: (a.r + b.r) / 2 + (rng.next() * 2 - 1) * opts.cellJitter,
        g: (a.g + b.g) / 2 + (rng.next() * 2 - 1) * opts.cellJitter,
        b: (a.b + b.b) / 2 + (rng.next() * 2 - 1) * opts.cellJitter,
      };
      blends[idx] = true;
    }
  }
  return { samples: out, blends };
}

/** Which frames the camera drops: true = missed. */
export function dropMask(count: number, dropRate: number, rng: Rng): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < count; i++) out.push(rng.next() < dropRate);
  return out;
}

export interface Episode {
  /** Seconds since run start. */
  t: number;
  opts: ChannelOpts;
}

export interface Profile {
  duration: number;
  dropRate: number;
  episodes: Episode[];
}

/** Piecewise-linear channel over time. */
export function channelAt(profile: Profile, t: number): ChannelOpts {
  const eps = profile.episodes;
  if (eps.length === 0) return CLEAN;
  let lo = eps[0]!;
  for (let i = 1; i < eps.length; i++) {
    const hi = eps[i]!;
    if (t <= hi.t) {
      const span = hi.t - lo.t;
      const f = span <= 0 ? 0 : Math.max(0, Math.min(1, (t - lo.t) / span));
      return lerpOpts(lo.opts, hi.opts, f);
    }
    lo = hi;
  }
  return lo.opts;
}

function lerpOpts(a: ChannelOpts, b: ChannelOpts, f: number): ChannelOpts {
  const L = (x: number, y: number) => x + (y - x) * f;
  return {
    brightness: L(a.brightness, b.brightness),
    tint: [L(a.tint[0], b.tint[0]), L(a.tint[1], b.tint[1]), L(a.tint[2], b.tint[2])],
    gamma: L(a.gamma, b.gamma),
    blurRadius: L(a.blurRadius, b.blurRadius),
    noise: L(a.noise, b.noise),
    cellJitter: L(a.cellJitter, b.cellJitter),
    blendFraction: L(a.blendFraction, b.blendFraction),
    vignette: L(a.vignette, b.vignette),
  };
}

export const PROFILES: Record<string, Profile> = {
  clean: {
    duration: 60,
    dropRate: 0,
    episodes: [{ t: 0, opts: CLEAN }],
  },
  degrading: {
    // Compressed to a ~20-second arc so a sim run of a few thousand frames
    // traverses the whole story (clean → camera-move → dim → glare → recovery).
    // Episodes are scripted in profile-seconds; the sim advances time by
    // 1/fps per frame.
    duration: 22,
    dropRate: 0.05,
    episodes: [
      { t: 0, opts: CLEAN },
      // camera moves: misalignment → jitter + blends
      { t: 4, opts: { ...CLEAN, cellJitter: 30, blendFraction: 0.08, noise: 15 } },
      // dim lighting: auto-exposure struggles — strong enough to push
      // telemetry past the policy's down thresholds (EVM / drop rate)
      { t: 8, opts: { ...CLEAN, brightness: 0.35, cellJitter: 50, blendFraction: 0.18, noise: 28 } },
      // glare: blown-out highlights
      { t: 12, opts: { ...CLEAN, brightness: 1.7, tint: [50, 25, 0], blurRadius: 2, cellJitter: 40, blendFraction: 0.2 } },
      // recovery ramp
      { t: 16, opts: { ...CLEAN, cellJitter: 10, noise: 6 } },
    ],
  },
};
