// color/palette.ts
// The color alphabet for the v3 physical layer, and the classifier that turns
// a measured cell color into a symbol (or an erasure flag).
//
// Classification space matters: the reliable 4-color set is hue-differentiated
// (green/cyan/yellow/magenta on RGB-cube faces), so it classifies in the
// brightness-invariant relative space (r-g, g-b, b-r) with per-sample min/max
// normalization — a dimmed green and a bright green are the same symbol.
// The 8-color set includes black AND white, which are distinguished ONLY by
// brightness; relative space collapses them to the same point, so the 8-color
// set classifies in plain calibrated RGB (the CCM in calibrate.ts has already
// removed the global shifts by then).

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const PALETTE_4: readonly RGB[] = [
  { r: 0, g: 255, b: 0 }, // green
  { r: 0, g: 255, b: 255 }, // cyan
  { r: 255, g: 255, b: 0 }, // yellow
  { r: 255, g: 0, b: 255 }, // magenta
];

export const PALETTE_8: readonly RGB[] = [
  { r: 0, g: 0, b: 0 }, // black
  { r: 0, g: 0, b: 255 }, // blue
  { r: 0, g: 255, b: 0 }, // green
  { r: 0, g: 255, b: 255 }, // cyan
  { r: 255, g: 0, b: 0 }, // red
  { r: 255, g: 0, b: 255 }, // magenta
  { r: 255, g: 255, b: 0 }, // yellow
  { r: 255, g: 255, b: 255 }, // white
];

/** 2 bits → 4 colors, 3 bits → 8 colors. Anything else is a config bug. */
export function paletteFor(bitsPerCell: number): readonly RGB[] {
  return bitsPerCell === 3 ? PALETTE_8 : PALETTE_4;
}

export function paletteColor(palette: readonly RGB[], symbol: number): RGB {
  return palette[symbol]!;
}

/** Brightness-invariant relative space: (r−g, g−b, b−r). Sum is always 0. */
export function relativeSpace(c: RGB): [number, number, number] {
  return [c.r - c.g, c.g - c.b, c.b - c.r];
}

/** Per-sample min/max normalization: stretch the sample's range to 0..255. */
export function normalize(c: RGB): RGB {
  const min = Math.min(c.r, c.g, c.b);
  const range = Math.max(Math.max(c.r, c.g, c.b) - min, 1);
  const s = 255 / range;
  return {
    r: (c.r - min) * s,
    g: (c.g - min) * s,
    b: (c.b - min) * s,
  };
}

export function clampByte(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x)));
}

export interface Classification {
  symbol: number;
  /** True when the sample sits in a blend region between two palette points —
   *  an erasure, not a value. The caller still submits `symbol` for the
   *  error-only RS pass, but must not trust it. */
  blend: boolean;
}

/** Minimum squared-distance gap between the two nearest palette points below
 *  which the sample counts as a blend. Tuned for relative-space units
 *  (palette points are ~130k apart; a midpoint sits ~32k from both). */
export const DEFAULT_BLEND_GAP = 20000;

export function classifySample(
  sample: RGB,
  palette: readonly RGB[],
  opts: { brightnessInvariant?: boolean; blendGap?: number } = {},
): Classification {
  const brightnessInvariant = opts.brightnessInvariant ?? palette.length === 4;
  const blendGap = opts.blendGap ?? DEFAULT_BLEND_GAP;
  const target = brightnessInvariant ? relativeSpace(normalize(sample)) : [sample.r, sample.g, sample.b];
  let best = -1;
  let bestD = Infinity;
  let second = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    const pt = brightnessInvariant ? relativeSpace(normalize(p)) : [p.r, p.g, p.b];
    const d = (target[0]! - pt[0]!) ** 2 + (target[1]! - pt[1]!) ** 2 + (target[2]! - pt[2]!) ** 2;
    if (d < bestD) {
      second = bestD;
      bestD = d;
      best = i;
    } else if (d < second) {
      second = d;
    }
  }
  return { symbol: best, blend: second - bestD < blendGap };
}

/** Max pairwise distance between palette points in the classification space —
 *  used to normalize EVM to a 0..1 scale. */
export function paletteDiameter(palette: readonly RGB[], brightnessInvariant: boolean): number {
  let max = 0;
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const a = brightnessInvariant ? relativeSpace(normalize(palette[i]!)) : [palette[i]!.r, palette[i]!.g, palette[i]!.b];
      const b = brightnessInvariant ? relativeSpace(normalize(palette[j]!)) : [palette[j]!.r, palette[j]!.g, palette[j]!.b];
      const d = (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
      max = Math.max(max, Math.sqrt(d));
    }
  }
  return max;
}
