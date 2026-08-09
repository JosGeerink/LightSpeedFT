# Color Amplitude Modulation — Phase 0 + 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-bit color physical layer to Decimen by building, first, a closed-loop simulation rig and a grid-agnostic color-frame codec — while keeping `protocol.ts` and `fountain.ts` byte-identical.

**Architecture:** A pure TypeScript codec core (`color/`) replaces only the carrier: `frameBytes → RS(255,k) → bits → color cells → raster`, decoded through calibration → classification → RS → `frameBytes`, feeding the SAME fountain decoder as today. A seeded, deterministic simulator runs this codec through a time-varying synthetic channel (ISP color processing, noise, blur, per-cell jitter, blend cells, frame drops) with an honest ~1 Hz reverse-channel model driving an adaptive policy that is itself a pure, testable function. Everything is exercised via `bun sim encode` (writes PNG frame files) and `bun sim run` (closed loop → report).

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run sim`), `node:test`/`assert` (existing test style), `Bun.zlib` (PNG I/O only). No new npm dependencies. The codec reuses the real `shared/protocol.ts` (packFile/unpackFile/packFrame/parseFrame/verifyFile) and `shared/fountain.ts` (LTEncoder/LTDecoder) — unchanged.

## Global Constraints

- **Fountain/protocol layers are untouched.** Never modify `shared/protocol.ts` or `shared/fountain.ts`. Their golden vectors (`tests/fountain.test.ts`, `tests/protocol.test.ts`) must keep passing.
- **Reverse feedback is reverse-optical only** in the product; in this plan the sim models that channel honestly (rate-limited, delayed, lossy, majority-averaged) — never idealizes it.
- **Simulation is TypeScript/Bun and imports the real codec code** — no parallel implementation, no mocked fountain.
- **Simulation is a closed loop**: channel varies over time, telemetry drives the sender's settings.
- **Determinism**: seeded PRNGs (`mulberry32`), golden-vector tests. A given (payload, profile, seed) reproduces exactly.
- **GF(256) Reed–Solomon uses the QR field** — primitive polynomial `0x11D`. Systematic RS(255, k).
- **4 colors / 2 bits per cell is the reliable default; 8 colors / 3 bits per cell only behind per-frame calibration + RS.**
- **Classification space**: brightness-invariant `(r−g, g−b, b−r)` with min/max normalization for the 4-color set; plain calibrated RGB for the 8-color set (black and white collapse in relative space — see Task 1).
- **Blend cells → erasures, not misclassifications.** Flagged, submitted as nearest-point, corrected by RS. Error-only RS for now; erasure-locator decoding is a documented future step.
- **No JPEG in the default channel model.** The model covers phone-ISP distortions (white balance tint, gamma, brightness/auto-exposure), lens blur, sensor noise, per-cell jitter, blend/transition cells, and frame drops. Off-angle is modeled as a vignette brightness falloff (a full geometric warp is the real receiver's detection job in Phase 2). JPEG is an explicit non-goal of this plan.
- **TypeScript is strict**, with `noUncheckedIndexedAccess` — every index read on a `Uint8Array`/`number[]`/`RGB[]` needs a `!` (the existing code does this, e.g. `blocks[off + w]!`). `noUnusedLocals` is on.
- **Run tests with Bun** (`bun test tests/color-*.test.ts`). The existing `npm test` (node/tsx) also works; the user prefers Bun.
- **Grid geometry for the sim**: cells are abstract (cols×rows), NOT QR modules. QR-shell mapping is Phase 2.

---

### Task 1: Palette & classification

The color alphabet and the classifier. This is the "constellation" and the "brightness-invariant relative space" from the spec.

**Files:**
- Create: `color/palette.ts`
- Test: `tests/color-palette.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface RGB { r: number; g: number; b: number }`
  - `PALETTE_4: readonly RGB[]` (green, cyan, yellow, magenta), `PALETTE_8: readonly RGB[]` (RGB-cube vertices: black, blue, green, cyan, red, magenta, yellow, white)
  - `paletteFor(bitsPerCell: number): readonly RGB[]` — 2 → PALETTE_4, 3 → PALETTE_8
  - `paletteColor(palette: readonly RGB[], symbol: number): RGB`
  - `relativeSpace(c: RGB): [number, number, number]` — `(r−g, g−b, b−r)`
  - `normalize(c: RGB): RGB` — per-sample min/max normalization
  - `clampByte(x: number): number` — clamp+round to 0..255
  - `classifySample(sample: RGB, palette: readonly RGB[], opts?: { brightnessInvariant?: boolean; blendGap?: number }): Classification` where `interface Classification { symbol: number; blend: boolean }`
  - `paletteDiameter(palette: readonly RGB[], brightnessInvariant: boolean): number` — max pairwise distance in the classification space (for EVM normalization in Task 4)
  - `DEFAULT_BLEND_GAP = 20000`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-palette.test.ts`
Expected: FAIL — `Cannot find module '../color/palette.ts'` (or `paletteFor is not defined`).

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-palette.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add color/palette.ts tests/color-palette.test.ts
git commit -m "feat(color): palette and brightness-aware classification"
```

---

### Task 2: Reed–Solomon codec

Error-only RS(255,k) over GF(256) with the QR field. Error-only because the sim quantifies whether blend-cell erasures need erasure-locator decoding (documented future step); for now blend cells are submitted and corrected as errors. Hand-rolled to match the project's deterministic-math culture (like `dlog()`), with zero dependencies.

**Files:**
- Create: `color/rs.ts`
- Test: `tests/color-rs.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `RS_CODEWORD_LEN = 255`
  - `rsEncode(data: Uint8Array, nsym: number): Uint8Array` — exactly `255 - nsym` data bytes → 255-byte systematic codeword
  - `rsDecode(cw: Uint8Array, nsym: number): { data: Uint8Array; corrected: number } | null` — null = uncorrectable (caller treats as frame erasure); `corrected` = count of corrected bytes (telemetry input)
  - `gfMul(a, b)`, `gfInv(a)`, `gfPow(i)` — exported for golden tests

- [ ] **Step 1: Write the failing test**

```ts
// tests/color-rs.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { RS_CODEWORD_LEN, gfPow, rsDecode, rsEncode } from "../color/rs.ts";

test("GF(256) exp table matches the QR field (primitive poly 0x11D)", () => {
  // α^i for the standard field, pinned to hand-computed values.
  const golden: [number, number][] = [
    [0, 1],
    [1, 2],
    [8, 0x1d],
    [9, 0x3a],
    [10, 0x74],
    [40, 0x6a],
    [99, 0x86],
    [100, 0x11],
  ];
  for (const [i, expected] of golden) {
    assert.equal(gfPow(i), expected, `α^${i}`);
  }
});

test("RS(255,254) parity is the XOR of the data bytes (hand-verifiable)", () => {
  const data = new Uint8Array(254);
  data[0] = 1;
  data[1] = 2;
  data[2] = 3;
  data[253] = 254;
  const cw = rsEncode(data, 1);
  assert.equal(cw.length, RS_CODEWORD_LEN);
  // 1 ^ 2 ^ 3 ^ 254 = 254
  assert.equal(cw[254], 254, "parity byte is the XOR of all data bytes");
  assert.deepEqual(cw.slice(0, 254), data);
});

test("a clean codeword decodes to the original data with zero corrections", () => {
  const data = new Uint8Array(255 - 30);
  for (let i = 0; i < data.length; i++) data[i] = i * 7;
  const cw = rsEncode(data, 30);
  const dec = rsDecode(cw, 30);
  assert.ok(dec !== null);
  assert.deepEqual(dec.data, data);
  assert.equal(dec.corrected, 0);
});

test("rsDecode corrects exactly floor(nsym/2) errors", () => {
  const nsym = 30;
  const k = 255 - nsym;
  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = (i * 31) & 0xff;
  const cw = rsEncode(data, nsym);
  const corrupted = new Uint8Array(cw);
  // Corrupt 15 distinct bytes (the correction bound).
  for (let e = 0; e < 15; e++) corrupted[e * 17] = corrupted[e * 17]! ^ (e + 5);
  const dec = rsDecode(corrupted, nsym);
  assert.ok(dec !== null, "15 errors on parity 30 must be correctable");
  assert.deepEqual(dec.data, data);
  assert.equal(dec.corrected, 15);
});

test("rsDecode never returns the original data when errors exceed the bound", () => {
  const nsym = 30;
  const k = 255 - nsym;
  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = (i * 13) & 0xff;
  const cw = rsEncode(data, nsym);
  const corrupted = new Uint8Array(cw);
  for (let e = 0; e < 16; e++) corrupted[e * 11] = corrupted[e * 11]! ^ (e + 1);
  const dec = rsDecode(corrupted, nsym);
  if (dec !== null) {
    assert.notDeepEqual(dec.data, data, "16 errors exceed the correction bound");
  }
});

test("a shattered codeword (every byte wrong) is uncorrectable", () => {
  const data = new Uint8Array(255 - 10);
  const cw = rsEncode(data, 10);
  const corrupted = new Uint8Array(cw);
  for (let i = 0; i < corrupted.length; i++) corrupted[i] = corrupted[i]! ^ 0xa5;
  assert.equal(rsDecode(corrupted, 10), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-rs.test.ts`
Expected: FAIL — `Cannot find module '../color/rs.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// color/rs.ts
// Reed–Solomon(255, k) over GF(256) with the QR field (primitive polynomial
// x^8+x^4+x^3+x^2+1, 0x11D). Systematic: a codeword is [k data bytes][nsym
// parity bytes]. Corrects up to floor(nsym/2) errors.
//
// Error-only, deliberately: blend-cell erasures are submitted as nearest-point
// symbols and corrected as errors. Erasure-locator decoding (Forney with known
// positions) would exploit the erasure flag for the same correction with less
// parity — the sim quantifies whether that's worth building (see the plan).
//
// Hand-rolled for the same reason dlog() is: deterministic, golden-testable,
// and the sim's RS only ever talks to itself, so a self-consistent codec is
// all that's required. The GF table below is pinned by tests to the standard
// QR field values, so the field cannot drift.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

export function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

export function gfInv(a: number): number {
  if (a === 0) throw new Error("gfInv(0) is undefined");
  return GF_EXP[255 - GF_LOG[a]!]!;
}

/** α^i (exponents wrap mod 255) — exported for tests and the Chien loop. */
export function gfPow(i: number): number {
  return GF_EXP[i % 255]!;
}

export const RS_CODEWORD_LEN = 255;

/** Generator polynomial ∏_{i=0..nsym-1} (x − α^i), coefficients low-order-first
 *  (index 0 = constant term; the leading coefficient is gen[nsym] = 1). */
function generator(nsym: number): Uint8Array {
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let k = 0; k < g.length; k++) {
      // × (−α^i) — the same as ×α^i in GF(2^8)
      next[k] = next[k]! ^ gfMul(g[k]!, gfPow(i));
      next[k + 1] = next[k + 1]! ^ g[k]!;
    }
    g = next;
  }
  return g;
}

/** Systematic RS encode of exactly `255 - nsym` data bytes. */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (nsym < 1 || nsym >= RS_CODEWORD_LEN) throw new Error(`nsym out of range: ${nsym}`);
  const k = RS_CODEWORD_LEN - nsym;
  if (data.length !== k) throw new Error(`rsEncode expects ${k} bytes, got ${data.length}`);
  const g = generator(nsym);
  const out = new Uint8Array(RS_CODEWORD_LEN);
  out.set(data);
  // LFSR division of data(x)·x^nsym by g(x). gen[nsym-j] for j=1..nsym are the
  // non-leading generator coefficients (constant term = gen[0]).
  for (let i = 0; i < k; i++) {
    const coef = out[i]!;
    if (coef === 0) continue;
    for (let j = 1; j <= nsym; j++) {
      out[i + j] = out[i + j]! ^ gfMul(g[nsym - j]!, coef);
    }
  }
  // The LFSR division passes through the data region, clobbering the leading
  // bytes; restore them so the codeword is systematic ([k data][nsym parity]).
  out.set(data);
  return out;
}

function syndromes(cw: Uint8Array, nsym: number): Uint8Array {
  const s = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let v = 0;
    for (let j = 0; j < RS_CODEWORD_LEN; j++) v = gfMul(v, gfPow(i)) ^ cw[j]!;
    s[i] = v;
  }
  return s;
}

/** Berlekamp–Massey: returns the error locator σ (low-order-first, σ(0)=1)
 *  with degree L. */
function berlekampMassey(s: Uint8Array): { loc: Uint8Array; degree: number } {
  const nsym = s.length;
  const C = new Uint8Array(nsym + 1);
  C[0] = 1;
  let B = new Uint8Array(nsym + 1);
  B[0] = 1;
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < nsym; n++) {
    let d = s[n]!;
    for (let j = 1; j <= L; j++) d = d ^ gfMul(C[j]!, s[n - j]!);
    if (d === 0) {
      m++;
      continue;
    }
    const T = C.slice();
    const coef = gfMul(d, gfInv(b));
    for (let j = 0; j + m < C.length; j++) C[j + m] = C[j + m]! ^ gfMul(B[j]!, coef);
    if (2 * L <= n) {
      L = n + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  return { loc: C.slice(0, L + 1), degree: L };
}

/** Decode a 255-byte codeword. Returns corrected data, or null when the word
 *  is uncorrectable (or corrects to a word whose syndromes are still nonzero —
 *  a safety net that turns miscorrection into a clean null). */
export function rsDecode(cw: Uint8Array, nsym: number): { data: Uint8Array; corrected: number } | null {
  if (cw.length !== RS_CODEWORD_LEN) throw new Error(`rsDecode expects 255 bytes, got ${cw.length}`);
  const rec = new Uint8Array(cw);
  const s = syndromes(rec, nsym);
  if (s.every((v) => v === 0)) return { data: rec.slice(0, RS_CODEWORD_LEN - nsym), corrected: 0 };

  const { loc, degree } = berlekampMassey(s);
  if (2 * degree > nsym) return null;

  // Chien search: σ(x) has roots at x = α^{-j} for error exponents j; the
  // exponent j maps to byte index e = 254 − j (byte e holds the coefficient
  // of x^{254-e}).
  const errors: number[] = [];
  for (let i = 0; i < RS_CODEWORD_LEN; i++) {
    let v = 0;
    for (let d = 0; d <= degree; d++) v = v ^ gfMul(loc[d]!, gfPow((255 - i) * d));
    if (v === 0) errors.push(254 - i);
  }
  if (errors.length !== degree) return null;

  // Forney: Ω(x) = σ(x)·S(x) mod x^nsym, with S(x) = Σ S_i·x^i.
  // Error value at exponent j: Y = X·Ω(X⁻¹)/σ′(X⁻¹), X = α^j.
  const omega = new Uint8Array(nsym);
  for (let a = 0; a <= degree && a < nsym; a++) {
    if (loc[a] === 0) continue;
    for (let b = 0; b + a < nsym; b++) omega[b + a] = omega[b + a]! ^ gfMul(loc[a]!, s[b]!);
  }
  let corrected = 0;
  for (const e of errors) {
    const j = 254 - e;
    const X = gfPow(j);
    let om = 0;
    for (let d = 0; d < nsym; d++) om = om ^ gfMul(omega[d]!, gfPow((255 - j) * d));
    // formal derivative: only odd-degree terms survive in characteristic 2
    let sprime = 0;
    for (let d = 1; d <= degree; d += 2) sprime = sprime ^ gfMul(loc[d]!, gfPow((255 - j) * (d - 1)));
    if (sprime === 0) return null;
    const magnitude = gfMul(X, gfMul(om, gfInv(sprime)));
    if (magnitude !== 0) corrected++;
    rec[e] = rec[e]! ^ magnitude;
  }

  // Safety net: the corrected word must be a valid codeword.
  if (syndromes(rec, nsym).some((v) => v !== 0)) return null;
  return { data: rec.slice(0, RS_CODEWORD_LEN - nsym), corrected };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-rs.test.ts`
Expected: PASS (all 6 tests). If the error-boundary test is flaky (miscorrection that happens to be a valid-but-wrong codeword), the assertion `notDeepEqual` still holds — the RS safety net guarantees we never return the *original* data past the bound.

- [ ] **Step 5: Commit**

```bash
git add color/rs.ts tests/color-rs.test.ts
git commit -m "feat(color): hand-rolled RS(255,k) over GF(256) with the QR field"
```

---

### Task 3: Color-correction calibration (CCM)

The per-frame 3×3 color-correction matrix fitted by Moore–Penrose least squares — what makes 3 bits/cell viable.

**Files:**
- Create: `color/calibrate.ts`
- Test: `tests/color-calibrate.test.ts`

**Interfaces:**
- Consumes: `RGB` from `color/palette.ts`.
- Produces:
  - `type Matrix3` — row-major `[number, number, number, number, number, number, number, number, number]`
  - `neutralCcm(): Matrix3` — identity
  - `applyCcm(c: RGB, m: Matrix3): RGB`
  - `fitCcm(observed: RGB[], expected: RGB[]): Matrix3 | null` — null when fewer than 3 points (underdetermined)

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-calibrate.test.ts`
Expected: FAIL — `Cannot find module '../color/calibrate.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// color/calibrate.ts
// Per-frame color-correction matrix: a 3×3 least-squares fit that maps
// observed swatch colors back to the palette. The phone ISP's white balance,
// gamma and tone mapping are smooth and global, so one matrix per frame
// absorbs them; classification then happens on corrected colors.

import type { RGB } from "./palette";

/** Row-major 3×3. `applyCcm(c, m)` = m · (r, g, b)^T. */
export type Matrix3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export function neutralCcm(): Matrix3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function applyCcm(c: RGB, m: Matrix3): RGB {
  return {
    r: m[0]! * c.r + m[1]! * c.g + m[2]! * c.b,
    g: m[3]! * c.r + m[4]! * c.g + m[5]! * c.b,
    b: m[6]! * c.r + m[7]! * c.g + m[8]! * c.b,
  };
}

function mul3(x: Matrix3, y: Matrix3): Matrix3 {
  const o = new Array<number>(9).fill(0) as Matrix3;
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 3; k++) {
      const xk = x[r * 3 + k]!;
      if (xk === 0) continue;
      for (let c = 0; c < 3; c++) o[r * 3 + c]! += xk * y[k * 3 + c]!;
    }
  }
  return o;
}

function invert3(m: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  return [
    (e! * i! - f! * h!) * inv, (c! * h! - b! * i!) * inv, (b! * f! - c! * e!) * inv,
    (f! * g! - d! * i!) * inv, (a! * i! - c! * g!) * inv, (c! * d! - a! * f!) * inv,
    (d! * h! - e! * g!) * inv, (b! * g! - a! * h!) * inv, (a! * e! - b! * d!) * inv,
  ];
}

/** Moore–Penrose least-squares fit: minimize Σ‖M·oᵢ − eᵢ‖² over M.
 *  Normal equations: A = Σ oᵢoᵢᵀ, B = Σ eᵢoᵢᵀ, M = B·A⁻¹.
 *  Returns null when underdetermined (< 3 swatches) or singular. */
export function fitCcm(observed: RGB[], expected: RGB[]): Matrix3 | null {
  if (observed.length < 3 || observed.length !== expected.length) return null;
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < observed.length; i++) {
    const o = observed[i]!;
    const e = expected[i]!;
    a[0]! += o.r * o.r; a[1]! += o.r * o.g; a[2]! += o.r * o.b;
    a[3]! += o.g * o.r; a[4]! += o.g * o.g; a[5]! += o.g * o.b;
    a[6]! += o.b * o.r; a[7]! += o.b * o.g; a[8]! += o.b * o.b;
    b[0]! += e.r * o.r; b[1]! += e.r * o.g; b[2]! += e.r * o.b;
    b[3]! += e.g * o.r; b[4]! += e.g * o.g; b[5]! += e.g * o.b;
    b[6]! += e.b * o.r; b[7]! += e.b * o.g; b[8]! += e.b * o.b;
  }
  const inv = invert3(a as Matrix3);
  if (inv === null) return null;
  return mul3(b as Matrix3, inv);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-calibrate.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add color/calibrate.ts tests/color-calibrate.test.ts
git commit -m "feat(color): per-frame 3x3 color-correction matrix via least squares"
```

---

### Task 4: v3 frame format (grid-agnostic core)

The format that maps `frameBytes` ↔ color cells: the perimeter band is calibration swatches, the interior is RS-coded data cells. This is the spec's "grid cells + mask → calibrate → classify → RS → frameBytes" core, plus the color capacity math.

**Files:**
- Modify: `shared/frame-capacity.ts` (append color helpers — this file is not `protocol.ts`/`fountain.ts`, so it may change)
- Create: `color/format.ts`
- Test: `tests/color-format.test.ts`

**Interfaces:**
- Consumes: `rsEncode`/`rsDecode`/`RS_CODEWORD_LEN` from `color/rs.ts`; palette functions from `color/palette.ts`; `fitCcm`/`applyCcm`/`neutralCcm` from `color/calibrate.ts`.
- Produces:
  - From `shared/frame-capacity.ts`:
    - `colorDataCells(cols: number, rows: number): number` — `(cols-2)·(rows-2)`
    - `colorMaxFrameBytes(cols, rows, bitsPerCell, nsym): number` — largest payload that fits
    - `colorGridSize(frameBytes: number, bitsPerCell: number, nsym: number): number` — smallest square side whose capacity fits `frameBytes`
  - From `color/format.ts`:
    - `interface FrameOpts { cols: number; rows: number; bitsPerCell: 2 | 3; nsym: number }`
    - `interface FrameGrid { cols: number; rows: number; bitsPerCell: number; nsym: number; frameBytes: number; cells: (number | null)[]; calibrationColors: RGB[] }` — `cells` row-major, `null` = calibration cell, number = symbol
    - `isCalibration(cols, rows, index): boolean`
    - `calibrationColor(palette: readonly RGB[], index: number): RGB` — palette cycled by cell index
    - `encodeFrame(frameBytes: Uint8Array, opts: FrameOpts): FrameGrid`
    - `interface FrameDecode { frameBytes: Uint8Array | null; evm: number; blends: number; rsCorrectedBytes: number; calibrationOk: boolean }`
    - `decodeFrame(samples: RGB[], frameBytes: number, opts: FrameOpts): FrameDecode` — `frameBytes` is known by the caller (the sim); `evm` is mean normalized distance to the assigned palette point

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-format.test.ts`
Expected: FAIL — `Cannot find module '../color/format.ts'` / missing color helpers in frame-capacity.ts.

- [ ] **Step 3a: Append the color capacity helpers to `shared/frame-capacity.ts`**

```ts
// --- color physical layer (v3): cell-count capacity math ---
// Same shape as the QR helpers above: how much fits at a given cell budget.
// `bitsPerCell` is the color depth (2 or 3), `nsym` the RS(255,k) parity bytes
// per codeword. The interior (cols-2)×(rows-2) is data; the perimeter is
// calibration swatches.

export function colorDataCells(cols: number, rows: number): number {
  return (cols - 2) * (rows - 2);
}

/** Largest frameBytes that fits: ceil(f/k)·255 codeword bytes must fit in the
 *  cell bit budget, where k = 255 − nsym. */
export function colorMaxFrameBytes(
  cols: number,
  rows: number,
  bitsPerCell: number,
  nsym: number,
): number {
  const k = 255 - nsym;
  const bits = colorDataCells(cols, rows) * bitsPerCell;
  const codewords = Math.floor(bits / (255 * 8));
  return Math.max(0, codewords * k);
}

/** Smallest square grid whose capacity fits `frameBytes` at the given
 *  (bitsPerCell, nsym). Used by the sim to pick a grid that stays feasible
 *  across the whole adaptive ladder (call with the worst setting). */
export function colorGridSize(
  frameBytes: number,
  bitsPerCell: number,
  nsym: number,
): number {
  for (let n = 8; n <= 512; n++) {
    if (colorMaxFrameBytes(n, n, bitsPerCell, nsym) >= frameBytes) return n;
  }
  throw new Error(`no square grid fits ${frameBytes} bytes at ${bitsPerCell} bits, nsym ${nsym}`);
}
```

- [ ] **Step 3b: Write `color/format.ts`**

```ts
// color/format.ts
// The v3 frame format: a rectangular grid of color cells where the perimeter
// band is calibration swatches and the interior is RS-coded payload bits.
// This is the grid-agnostic core from the spec — "cells + mask → calibrate →
// classify → RS → frameBytes" — with no knowledge of QR or any particular
// grid shape. Phase 2 supplies QR-shaped cells; Phase 4 supplies dense-grid
// cells; nothing above the sampling front-end changes.

import { RS_CODEWORD_LEN, rsDecode, rsEncode } from "./rs";
import {
  DEFAULT_BLEND_GAP,
  classifySample,
  normalize,
  paletteColor,
  paletteDiameter,
  paletteFor,
  relativeSpace,
  type RGB,
} from "./palette";
import { applyCcm, fitCcm, neutralCcm } from "./calibrate";
import { colorDataCells, colorMaxFrameBytes } from "../shared/frame-capacity";

export interface FrameOpts {
  cols: number;
  rows: number;
  bitsPerCell: 2 | 3;
  nsym: number;
}

export interface FrameGrid {
  cols: number;
  rows: number;
  bitsPerCell: number;
  nsym: number;
  frameBytes: number;
  /** Row-major. null = calibration cell; otherwise a palette symbol. */
  cells: (number | null)[];
  /** Expected palette colors of the calibration cells, in cell order. */
  calibrationColors: RGB[];
}

export function isCalibration(cols: number, rows: number, index: number): boolean {
  const x = index % cols;
  const y = Math.floor(index / cols);
  return x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
}

/** Calibration swatch color for a cell index: the palette cycled in cell
 *  order, so every palette color appears on the band several times. */
export function calibrationColor(palette: readonly RGB[], index: number): RGB {
  return paletteColor(palette, index % palette.length);
}

/** RS-encode + interleave across codewords so localized cell damage spreads
 *  across every codeword instead of destroying one. */
function rsInterleave(data: Uint8Array, nsym: number): Uint8Array {
  const k = RS_CODEWORD_LEN - nsym;
  const nCodewords = Math.ceil(data.length / k);
  const padded = new Uint8Array(nCodewords * k);
  padded.set(data);
  const out = new Uint8Array(nCodewords * RS_CODEWORD_LEN);
  for (let c = 0; c < nCodewords; c++) {
    const cw = rsEncode(padded.subarray(c * k, (c + 1) * k), nsym);
    for (let j = 0; j < RS_CODEWORD_LEN; j++) out[j * nCodewords + c] = cw[j]!;
  }
  return out;
}

function rsDeinterleave(
  stream: Uint8Array,
  nsym: number,
): { data: Uint8Array; corrected: number } | null {
  const nCodewords = stream.length / RS_CODEWORD_LEN;
  if (!Number.isInteger(nCodewords) || nCodewords === 0) return null;
  const k = RS_CODEWORD_LEN - nsym;
  const data = new Uint8Array(nCodewords * k);
  let corrected = 0;
  for (let c = 0; c < nCodewords; c++) {
    const cw = new Uint8Array(RS_CODEWORD_LEN);
    for (let j = 0; j < RS_CODEWORD_LEN; j++) cw[j] = stream[j * nCodewords + c]!;
    const dec = rsDecode(cw, nsym);
    if (dec === null) return null;
    data.set(dec.data, c * k);
    corrected += dec.corrected;
  }
  return { data, corrected };
}

export function encodeFrame(frameBytes: Uint8Array, opts: FrameOpts): FrameGrid {
  const { cols, rows, bitsPerCell, nsym } = opts;
  const palette = paletteFor(bitsPerCell);
  const dataCells = colorDataCells(cols, rows);
  const dataBits = dataCells * bitsPerCell;
  const dataBytes = Math.floor(dataBits / 8);
  // Capacity is quantized to whole codewords: a partial codeword's 255-byte
  // frame would not fit the bit budget, so check against colorMaxFrameBytes.
  const maxBytes = colorMaxFrameBytes(cols, rows, bitsPerCell, nsym);
  if (frameBytes.length > maxBytes) {
    throw new Error(`frameBytes ${frameBytes.length} exceeds capacity ${maxBytes}`);
  }
  const k = RS_CODEWORD_LEN - nsym;
  // rsInterleave computes its own codeword count internally from
  // data.length/k; do not shadow it here (noUnusedLocals).
  const stream = rsInterleave(frameBytes, nsym);
  const padded = new Uint8Array(dataBytes);
  padded.set(stream);

  const cells: (number | null)[] = new Array(cols * rows).fill(null);
  let bit = 0;
  for (let i = 0; i < cols * rows && bit < dataBits; i++) {
    if (isCalibration(cols, rows, i)) continue;
    let sym = 0;
    for (let b = 0; b < bitsPerCell; b++) {
      sym = (sym << 1) | ((padded[Math.floor(bit / 8)]! >> (7 - (bit % 8))) & 1);
      bit++;
    }
    cells[i] = sym;
  }
  const calibrationColors: RGB[] = [];
  for (let i = 0; i < cols * rows; i++) {
    if (isCalibration(cols, rows, i)) calibrationColors.push(calibrationColor(palette, i));
  }
  return { cols, rows, bitsPerCell, nsym, frameBytes: frameBytes.length, cells, calibrationColors };
}

export interface FrameDecode {
  frameBytes: Uint8Array | null;
  /** Mean distance of corrected samples to their assigned palette point,
   *  normalized by the palette diameter — the receiver's self-measured
   *  channel quality (EVM). 0 = perfect, ~1 = random. */
  evm: number;
  blends: number;
  rsCorrectedBytes: number;
  calibrationOk: boolean;
}

export function decodeFrame(samples: RGB[], frameBytes: number, opts: FrameOpts): FrameDecode {
  const { cols, rows, bitsPerCell, nsym } = opts;
  const palette = paletteFor(bitsPerCell);
  const brightnessInvariant = palette.length === 4; // 8 colors need brightness (black/white)
  const dataCells = colorDataCells(cols, rows);
  const dataBits = dataCells * bitsPerCell;
  const dataBytes = Math.floor(dataBits / 8);
  const diameter = paletteDiameter(palette, brightnessInvariant);

  // 1. Calibrate from the perimeter swatches.
  const observed: RGB[] = [];
  const expected: RGB[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (isCalibration(cols, rows, i)) {
      observed.push(samples[i]!);
      expected.push(calibrationColor(palette, i));
    }
  }
  const fitted = fitCcm(observed, expected);
  const ccm = fitted ?? neutralCcm();
  const calibrationOk = fitted !== null;

  // 2. Classify data cells into a bitstream, collecting EVM + blend counts.
  const bits = new Uint8Array(dataBytes);
  let bit = 0;
  let blends = 0;
  let evmSum = 0;
  let evmN = 0;
  for (let i = 0; i < cols * rows && bit < dataBits; i++) {
    if (isCalibration(cols, rows, i)) continue;
    const corrected = applyCcm(samples[i]!, ccm);
    const cls = classifySample(corrected, palette, { brightnessInvariant, blendGap: DEFAULT_BLEND_GAP });
    if (cls.blend) blends++;
    const point = paletteColor(palette, cls.symbol);
    const cspace = brightnessInvariant ? relativeSpace(normalize(corrected)) : [corrected.r, corrected.g, corrected.b];
    const pspace = brightnessInvariant ? relativeSpace(normalize(point)) : [point.r, point.g, point.b];
    evmSum += Math.hypot(cspace[0]! - pspace[0]!, cspace[1]! - pspace[1]!, cspace[2]! - pspace[2]!);
    evmN++;
    for (let b = 0; b < bitsPerCell; b++) {
      if ((cls.symbol >> (bitsPerCell - 1 - b)) & 1) {
        bits[Math.floor(bit / 8)] = bits[Math.floor(bit / 8)]! | (1 << (7 - (bit % 8)));
      }
      bit++;
    }
  }
  const evm = evmN > 0 && diameter > 0 ? evmSum / evmN / diameter : 1;

  // 3. Deinterleave + RS; frameBytes is the caller-known payload length.
  const k = RS_CODEWORD_LEN - nsym;
  const nCodewords = Math.ceil(frameBytes / k);
  const streamLen = nCodewords * RS_CODEWORD_LEN;
  if (streamLen > bits.length) {
    return { frameBytes: null, evm, blends, rsCorrectedBytes: 0, calibrationOk };
  }
  const recovered = rsDeinterleave(bits.subarray(0, streamLen), nsym);
  if (recovered === null) {
    return { frameBytes: null, evm, blends, rsCorrectedBytes: 0, calibrationOk };
  }
  return {
    frameBytes: recovered.data.slice(0, frameBytes),
    evm,
    blends,
    rsCorrectedBytes: recovered.corrected,
    calibrationOk,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-format.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/frame-capacity.ts color/format.ts tests/color-format.test.ts
git commit -m "feat(color): grid-agnostic v3 frame format with RS interleave + capacity math"
```

---

### Task 5: Rasterize & sample

Turn a `FrameGrid` into a pixel buffer (encode side) and back into per-cell RGB samples (decode side). Pure functions in the style of `shared/qr-raster.ts`.

**Files:**
- Create: `color/raster.ts`
- Create: `color/sample.ts`
- Test: `tests/color-raster.test.ts`

**Interfaces:**
- Consumes: `FrameGrid` + `calibrationColor` from `color/format.ts`; `RGB`/`clampByte`/`paletteColor` from `color/palette.ts`.
- Produces:
  - `interface Raster { width: number; height: number; pixels: Uint32Array }` — RGBA as little-endian u32 (alpha in the high byte), same convention as `qr-raster.ts`
  - `rasterizeGrid(grid: FrameGrid, palette: readonly RGB[], cellPx: number, margin?: number): Raster`
  - `sampleGrid(raster: Raster, cols: number, rows: number, cellPx: number, margin?: number): RGB[]` — row-major, inner-window average per cell

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-raster.test.ts`
Expected: FAIL — `Cannot find module '../color/raster.ts'`.

- [ ] **Step 3: Write the implementations**

```ts
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
      const v = grid.cells[i]!;
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
```

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-raster.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add color/raster.ts color/sample.ts tests/color-raster.test.ts
git commit -m "feat(color): rasterize color grids and sample them back to RGB"
```

---

### Task 6: Synthetic channel

The time-varying channel the closed loop runs against. Two stages: global raster corruption (ISP: brightness/tint/gamma, sensor noise, lens blur, off-angle vignette) and per-cell corruption (jitter + blend/transition cells), plus frame drops and scripted profiles.

**Files:**
- Create: `color/sim-channel.ts`
- Test: `tests/color-sim-channel.test.ts`

**Interfaces:**
- Consumes: `Raster` from `color/raster.ts`; `RGB`/`clampByte` from `color/palette.ts`.
- Produces:
  - `interface Rng { next(): number }` — uniform [0,1)
  - `mulberry32(seed: number): Rng`
  - `gaussian(rng: Rng): number` — Box–Muller, standard normal
  - `interface ChannelOpts { brightness: number; tint: [number, number, number]; gamma: number; blurRadius: number; noise: number; cellJitter: number; blendFraction: number; vignette: number }`
  - `CLEAN: ChannelOpts` — the identity channel
  - `corruptRaster(raster: Raster, opts: ChannelOpts, rng: Rng): Raster` — returns a new raster (never mutates input)
  - `corruptSamples(samples: RGB[], expected: RGB[], opts: ChannelOpts, rng: Rng): { samples: RGB[]; blends: boolean[] }` — per-cell jitter + blend cells; `expected` is the true per-cell color (ground truth — the channel is the environment, it may know it)
  - `dropMask(count: number, dropRate: number, rng: Rng): boolean[]`
  - `interface Episode { t: number; opts: ChannelOpts }` — `t` in seconds
  - `interface Profile { duration: number; dropRate: number; episodes: Episode[] }`
  - `channelAt(profile: Profile, t: number): ChannelOpts` — piecewise-linear interpolation between episodes
  - `PROFILES: Record<string, Profile>` — `clean`, `degrading` (camera-move → dim → glare → recovery)

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-sim-channel.test.ts`
Expected: FAIL — `Cannot find module '../color/sim-channel.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-sim-channel.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add color/sim-channel.ts tests/color-sim-channel.test.ts
git commit -m "feat(color): deterministic synthetic channel (ISP, noise, blur, jitter, blends, drops)"
```

---

### Task 7: Adaptive policy

The ACM policy — a pure function from telemetry to transmit settings, with hysteresis. The exact same function the browser will run in Phase 3.

**Files:**
- Create: `color/adaptive.ts`
- Test: `tests/color-adaptive.test.ts`

**Interfaces:**
- Consumes: nothing from other color modules (settings are plain data).
- Produces:
  - `interface TxSettings { bitsPerCell: 2 | 3; nsym: number; fps: number; cols: number; rows: number }`
  - `interface Telemetry { evm: number; rsCorrectedBytes: number; blends: number; calibrationOk: boolean; frameDropRate: number }`
  - `interface AdaptiveParams { holdFrames: number; upEVM: number; upCorrected: number; downEVM: number; downDropRate: number }`
  - `LADDER: readonly TxSettings[]` — five settings, best→worst (3b/10% → 2b/40%)
  - `policyDecision(telemetry: Telemetry, params: AdaptiveParams): "up" | "down" | "hold"`
  - `adaptiveSettings(telemetry: Telemetry, current: TxSettings, params: AdaptiveParams, heldFor: number, grid: { cols: number; rows: number }): TxSettings` — pure; up requires `heldFor >= holdFrames`

- [ ] **Step 1: Write the failing test**

```ts
// tests/color-adaptive.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { LADDER, adaptiveSettings, policyDecision, type Telemetry } from "../color/adaptive.ts";

const CLEAN_T: Telemetry = {
  evm: 0.02, rsCorrectedBytes: 0, blends: 0, calibrationOk: true, frameDropRate: 0,
};

test("LADDER is strictly degrading and starts at 3 bits / ~10% FEC", () => {
  assert.equal(LADDER[0]!.bitsPerCell, 3);
  assert.equal(LADDER[0]!.nsym, 26);
  assert.equal(LADDER[4]!.bitsPerCell, 2);
  assert.ok(LADDER[4]!.nsym >= 100);
  for (let i = 1; i < LADDER.length; i++) {
    const prev = LADDER[i - 1]!;
    const cur = LADDER[i]!;
    const prevScore = prev.bitsPerCell * (255 - prev.nsym) * prev.fps;
    const curScore = cur.bitsPerCell * (255 - cur.nsym) * cur.fps;
    assert.ok(curScore < prevScore, `ladder ${i} must be lower-throughput than ${i - 1}`);
  }
});

test("clean telemetry drives the policy up (after the hold elapses)", () => {
  const params = { holdFrames: 100, upEVM: 0.1, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 };
  const current = LADDER[1]!;
  assert.equal(policyDecision(CLEAN_T, params), "up");
  // heldFor below the threshold → stay put
  const mid = adaptiveSettings(CLEAN_T, current, params, 50, { cols: 20, rows: 20 });
  assert.equal(mid.nsym, current.nsym);
  // after the hold → climb
  const climbed = adaptiveSettings(CLEAN_T, current, params, 100, { cols: 20, rows: 20 });
  assert.equal(climbed.nsym, LADDER[0]!.nsym);
  assert.equal(climbed.bitsPerCell, 3);
});

test("degraded telemetry drives the policy down immediately", () => {
  const params = { holdFrames: 100, upEVM: 0.1, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 };
  const bad: Telemetry = { ...CLEAN_T, evm: 0.5, frameDropRate: 0.15 };
  const current = LADDER[1]!;
  assert.equal(policyDecision(bad, params), "down");
  const degraded = adaptiveSettings(bad, current, params, 0, { cols: 20, rows: 20 });
  assert.equal(degraded.nsym, LADDER[2]!.nsym);
  assert.equal(degraded.bitsPerCell, 2);
});

test("calibration failure is an immediate down-signal", () => {
  const params = { holdFrames: 100, upEVM: 0.1, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 };
  const bad: Telemetry = { ...CLEAN_T, calibrationOk: false };
  assert.equal(policyDecision(bad, params), "down");
});

test("policy holds steady in a stable middle region (no thrash)", () => {
  const params = { holdFrames: 100, upEVM: 0.1, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 };
  const mid: Telemetry = { ...CLEAN_T, evm: 0.2 };
  assert.equal(policyDecision(mid, params), "hold");
});

test("at the top of the ladder, up stays put", () => {
  const params = { holdFrames: 100, upEVM: 0.1, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 };
  const atTop = adaptiveSettings(CLEAN_T, LADDER[0]!, params, 1000, { cols: 20, rows: 20 });
  assert.equal(atTop.nsym, LADDER[0]!.nsym);
});

test("grid is carried through from the caller", () => {
  const params = { holdFrames: 0, upEVM: 0.1, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 };
  const out = adaptiveSettings(CLEAN_T, LADDER[1]!, params, 0, { cols: 34, rows: 40 });
  assert.equal(out.cols, 34);
  assert.equal(out.rows, 40);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-adaptive.test.ts`
Expected: FAIL — `Cannot find module '../color/adaptive.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// color/adaptive.ts
// The ACM (adaptive coding and modulation) policy. A pure function from a
// telemetry window to transmit settings, with hysteresis so it does not thrash
// around a boundary. The sim runs this exact function; Phase 3 ships the same
// one to the browser.
//
// The ladder moves on three levers at once: bits per cell, RS parity, and fps.
// Grid size is carried through unchanged — dense-grid adaptation is Phase 3/4.

export interface TxSettings {
  bitsPerCell: 2 | 3;
  nsym: number;
  fps: number;
  cols: number;
  rows: number;
}

export interface Telemetry {
  /** Mean normalized distance to the assigned palette point (0 = perfect). */
  evm: number;
  /** Total bytes RS corrected in this frame (proxy for cell errors). */
  rsCorrectedBytes: number;
  blends: number;
  calibrationOk: boolean;
  /** Fraction of frames in the window that failed to decode at all. */
  frameDropRate: number;
}

export interface AdaptiveParams {
  /** Frames an "up" decision must be held before it takes effect. */
  holdFrames: number;
  upEVM: number;
  upCorrected: number;
  downEVM: number;
  downDropRate: number;
}

/** Best → worst. Throughput ≈ bitsPerCell × (255−nsym) × fps.
 *  nsym 26 ≈ 10% parity, 51 ≈ 20%, 102 ≈ 40%. */
export const LADDER: readonly TxSettings[] = [
  { bitsPerCell: 3, nsym: 26, fps: 60, cols: 0, rows: 0 },
  { bitsPerCell: 3, nsym: 51, fps: 60, cols: 0, rows: 0 },
  { bitsPerCell: 2, nsym: 26, fps: 60, cols: 0, rows: 0 },
  { bitsPerCell: 2, nsym: 51, fps: 45, cols: 0, rows: 0 },
  { bitsPerCell: 2, nsym: 102, fps: 30, cols: 0, rows: 0 },
];

export function policyDecision(t: Telemetry, p: AdaptiveParams): "up" | "down" | "hold" {
  if (!t.calibrationOk || t.evm > p.downEVM || t.frameDropRate > p.downDropRate) return "down";
  if (t.evm < p.upEVM && t.rsCorrectedBytes < p.upCorrected && t.frameDropRate === 0) return "up";
  return "hold";
}

/** The ladder index of `current`, or −1 if it is not on the ladder. */
function ladderIndex(current: TxSettings): number {
  return LADDER.findIndex(
    (s) => s.bitsPerCell === current.bitsPerCell && s.nsym === current.nsym && s.fps === current.fps,
  );
}

export function adaptiveSettings(
  telemetry: Telemetry,
  current: TxSettings,
  params: AdaptiveParams,
  heldFor: number,
  grid: { cols: number; rows: number },
): TxSettings {
  const idx = ladderIndex(current);
  const decision = policyDecision(telemetry, params);
  if (decision === "down") {
    // Degrade: one step worse, toward LADDER[last]. Settings not on the
    // ladder fall to the most robust step.
    const next = LADDER[idx === -1 ? LADDER.length - 1 : Math.min(LADDER.length - 1, idx + 1)]!;
    return { ...next, cols: grid.cols, rows: grid.rows };
  }
  if (decision === "up" && heldFor >= params.holdFrames) {
    // Climb: one step better, toward LADDER[0], only after the hysteresis hold.
    const next = LADDER[idx === -1 ? 0 : Math.max(0, idx - 1)]!;
    return { ...next, cols: grid.cols, rows: grid.rows };
  }
  return { ...current, cols: grid.cols, rows: grid.rows };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-adaptive.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add color/adaptive.ts tests/color-adaptive.test.ts
git commit -m "feat(color): pure ACM policy with hysteresis"
```

---

### Task 8: Closed-loop simulator core

The heart of Phase 0. Drives the real fountain + protocol + color codec through a time-varying channel, runs the honest reverse-channel model, adapts settings, and reports aggregate goodput + survival. Includes the simulator metrics (EVM, cell errors, drops, goodput).

**Files:**
- Create: `color/sim.ts`
- Test: `tests/color-sim.test.ts`

**Interfaces:**
- Consumes: `packFile`, `unpackFile`, `verifyFile`, `packFrame`, `parseFrame`, `streamIdentity`, `fnv1a`, `HEADER_LEN`, types `FrameHeader` from `shared/protocol.ts`; `LTEncoder`, `LTDecoder`, `cycleLength` from `shared/fountain.ts`; `encodeFrame`/`decodeFrame`/`calibrationColor`/`FrameOpts` from `color/format.ts`; `rasterizeGrid` from `color/raster.ts`; `sampleGrid` from `color/sample.ts`; `corruptRaster`/`corruptSamples`/`dropMask`/`channelAt`/`mulberry32`/`Profile`/`ChannelOpts` from `color/sim-channel.ts`; `adaptiveSettings`/`LADDER`/`TxSettings`/`AdaptiveParams`/`Telemetry` from `color/adaptive.ts`; `paletteFor`/`paletteColor`/`RGB` from `color/palette.ts`; `colorGridSize` from `shared/frame-capacity.ts`.
- Produces:
  - `interface ReverseOpts { updateEvery: number; latencyFrames: number; lossRate: number }`
  - `interface SimConfig { frameBytes: number; cellPx: number; gridMargin: number; sessionId: number; seed: number; maxFrames: number; adaptive: AdaptiveParams; reverse: ReverseOpts }`
  - `interface TimelineEntry { t: number; seconds: number; channel: ChannelOpts; tx: TxSettings; telemetry: Telemetry; dropped: boolean; decodedBytes: number }`
  - `interface RunReport { payloadName: string; payloadBytes: number; containerBytes: number; grid: { cols: number; rows: number }; framesSent: number; framesDropped: number; blocksSolved: number; blocksTotal: number; complete: boolean; wallSeconds: number; goodputBps: number; verify: "ok" | "fail" | "not-complete"; timeline: TimelineEntry[] }`
  - `reverseTelemetry(local: (Telemetry & { dropped: boolean })[], frameIndex: number, opts: ReverseOpts, rng: Rng): Telemetry | null`
  - `async runTransfer(payloadName: string, payload: Uint8Array, profile: Profile, cfg: SimConfig): Promise<RunReport>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/color-sim.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { PROFILES, mulberry32 } from "../color/sim-channel.ts";
import { colorGridSize } from "../shared/frame-capacity.ts";
import { LADDER, type Telemetry } from "../color/adaptive.ts";
import { reverseTelemetry, runTransfer, type SimConfig } from "../color/sim.ts";

const PAYLOAD = new TextEncoder().encode(
  "Decimen color-modulation closed-loop simulation payload. ".repeat(12),
);

// ~200 KiB of incompressible pseudo-random payload (deterministic via
// mulberry32): large enough that the transfer is still in flight when the bad
// episodes of the `degrading` profile hit — so the loop has something to adapt
// — and completes only after the recovery ramp.
const BIG_PAYLOAD = (() => {
  const out = new Uint8Array(200_000);
  const rng = mulberry32(99);
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(rng.next() * 256);
  return out;
})();

function cfg(overrides: Partial<SimConfig> = {}): SimConfig {
  const frameBytes = 300;
  const side = colorGridSize(frameBytes, 2, 102); // feasible at the worst ladder setting
  return {
    frameBytes,
    cellPx: 4,
    gridMargin: 4,
    sessionId: 0x1234,
    seed: 20260809,
    maxFrames: 400,
    adaptive: { holdFrames: 60, upEVM: 0.12, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 },
    reverse: { updateEvery: 60, latencyFrames: 90, lossRate: 0.1 },
    ...overrides,
  };
}

test("reverseTelemetry only delivers on the update cadence, with latency and loss", () => {
  const rng = mulberry32(1);
  const local: (Telemetry & { dropped: boolean })[] = [];
  for (let i = 0; i < 200; i++) {
    local.push({ evm: 0.05, rsCorrectedBytes: 0, blends: 0, calibrationOk: true, frameDropRate: 0, dropped: i % 50 === 0 });
  }
  const opts = { updateEvery: 60, latencyFrames: 90, lossRate: 0.5 };
  let deliveries = 0;
  for (let t = 0; t < 200; t++) {
    if (reverseTelemetry(local, t, opts, rng) !== null) deliveries++;
  }
  // 200 frames / 60 ≈ 3 cadences, minus ~50% loss → 1-3 deliveries.
  assert.ok(deliveries >= 0 && deliveries <= 3, `got ${deliveries}`);
});

test("clean channel: a small payload transfers fully and verifies (SHA-256)", async () => {
  const report = await runTransfer("sim.bin", PAYLOAD, PROFILES.clean!, cfg({ maxFrames: 200 }));
  assert.equal(report.complete, true, "clean channel must complete");
  assert.equal(report.verify, "ok", "SHA-256 must verify");
  assert.ok(report.goodputBps > 0);
  assert.ok(report.framesSent <= 200);
});

test("determinism: same payload + profile + seed reproduces the same run", async () => {
  const a = await runTransfer("sim.bin", PAYLOAD, PROFILES.degrading!, cfg());
  const b = await runTransfer("sim.bin", PAYLOAD, PROFILES.degrading!, cfg());
  assert.equal(a.goodputBps, b.goodputBps);
  assert.equal(a.timeline.length, b.timeline.length);
  assert.equal(a.blocksSolved, b.blocksSolved);
});

test("degrading profile: the closed loop descends during bad episodes, survives, and completes", async () => {
  const report = await runTransfer(
    "sim.bin",
    BIG_PAYLOAD,
    PROFILES.degrading!,
    cfg({ frameBytes: 300, cellPx: 4, maxFrames: 2200 }),
  );
  // The transfer is far from complete when the dim episode hits (k ≈ 715, and
  // the dim episode starts around frame 480 @60fps), so the loop has to adapt;
  // after the recovery ramp the remaining frames finish the payload.
  assert.ok(report.complete, "survives the degrading profile and finishes");
  assert.equal(report.verify, "ok");
  // The timeline must show the ladder descending below the clean step during
  // the dim/glare episodes (the closed loop doing its job).
  const nsymOverTime = report.timeline.map((e) => e.tx.nsym);
  assert.ok(
    Math.max(...nsymOverTime) > LADDER[0]!.nsym,
    "settings must have descended below the clean ladder step during bad episodes",
  );
  assert.ok(report.framesDropped > 0, "the stress episodes must drop some frames");
});

test("recovered bytes accumulate monotonically even through bad episodes", async () => {
  const report = await runTransfer(
    "sim.bin",
    BIG_PAYLOAD,
    PROFILES.degrading!,
    cfg({ frameBytes: 300, cellPx: 4, maxFrames: 800 }),
  );
  assert.ok(!report.complete, "an 800-frame slice of a 200 KiB payload must not complete");
  let prev = 0;
  for (const e of report.timeline) {
    assert.ok(e.decodedBytes >= prev, "decoded bytes never decrease");
    prev = e.decodedBytes;
  }
  assert.ok(prev > 0, "progress is made even mid-stress");
});
```

(The test's import block above already includes `mulberry32` and `type Telemetry` — no additional imports are needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-sim.test.ts`
Expected: FAIL — `Cannot find module '../color/sim.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// color/sim.ts
// Phase 0: the closed-loop simulator. The REAL fountain + protocol + color
// codec run through a time-varying synthetic channel; the decoder measures
// itself (EVM, RS-corrected bytes, blends, drops); an honest reverse channel
// model (~1 Hz, delayed, lossy, averaged) feeds the adaptive policy; the
// policy changes settings; aggregate goodput and survival come out.

// Implementation files import WITHOUT .ts extensions (repo convention; the
// tsconfig has moduleResolution "bundler" and no allowImportingTsExtensions,
// so .ts-extension imports would fail TS5097 once Task 10 adds color/ to the
// include set). Test files keep .ts extensions.
import { HEADER_LEN, fnv1a, packFile, packFrame, parseFrame, streamIdentity, unpackFile, verifyFile } from "../shared/protocol";
import { LTDecoder, LTEncoder } from "../shared/fountain";
import { calibrationColor, decodeFrame, encodeFrame } from "./format";
import { rasterizeGrid } from "./raster";
import { sampleGrid } from "./sample";
import { channelAt, corruptRaster, corruptSamples, dropMask, mulberry32, type ChannelOpts, type Profile, type Rng } from "./sim-channel";
import { LADDER, adaptiveSettings, type AdaptiveParams, type Telemetry, type TxSettings } from "./adaptive";
import { paletteColor, paletteFor, type RGB } from "./palette";
import { colorGridSize } from "../shared/frame-capacity";

export interface ReverseOpts {
  /** Frames between reverse-channel updates (60 @60fps ≈ 1 Hz). */
  updateEvery: number;
  /** How far back in the local window the delivered vote looks. */
  latencyFrames: number;
  /** Probability a scheduled update is lost entirely. */
  lossRate: number;
}

export interface SimConfig {
  frameBytes: number;
  cellPx: number;
  gridMargin: number;
  sessionId: number;
  seed: number;
  maxFrames: number;
  adaptive: AdaptiveParams;
  reverse: ReverseOpts;
}

export interface TimelineEntry {
  t: number;
  seconds: number;
  channel: ChannelOpts;
  tx: TxSettings;
  telemetry: Telemetry;
  dropped: boolean;
  decodedBytes: number;
}

export interface RunReport {
  payloadName: string;
  payloadBytes: number;
  containerBytes: number;
  grid: { cols: number; rows: number };
  framesSent: number;
  framesDropped: number;
  blocksSolved: number;
  blocksTotal: number;
  complete: boolean;
  wallSeconds: number;
  goodputBps: number;
  verify: "ok" | "fail" | "not-complete";
  timeline: TimelineEntry[];
}

type LocalTelemetry = Telemetry & { dropped: boolean };

/** The reverse-optical channel, modeled honestly: it only delivers on the
 *  update cadence, it looks `latencyFrames` into the past, it averages (the
 *  majority-vote analogue for numeric telemetry), and it drops ~lossRate of
 *  its updates. Returns null when nothing was delivered this frame. */
export function reverseTelemetry(
  local: LocalTelemetry[],
  frameIndex: number,
  opts: ReverseOpts,
  rng: Rng,
): Telemetry | null {
  if (frameIndex % opts.updateEvery !== 0) return null;
  if (rng.next() < opts.lossRate) return null;
  const start = Math.max(0, local.length - opts.latencyFrames);
  const win = local.slice(start);
  if (win.length === 0) return null;
  const mean = (key: "evm" | "rsCorrectedBytes" | "blends") =>
    win.reduce((acc, v) => acc + v[key], 0) / win.length;
  return {
    evm: mean("evm"),
    rsCorrectedBytes: mean("rsCorrectedBytes"),
    blends: mean("blends"),
    calibrationOk: win.every((v) => v.calibrationOk),
    frameDropRate: win.filter((v) => v.dropped).length / win.length,
  };
}

export async function runTransfer(
  payloadName: string,
  payload: Uint8Array,
  profile: Profile,
  cfg: SimConfig,
): Promise<RunReport> {
  const packed = await packFile(payloadName, "application/octet-stream", payload);
  const container = packed.container;
  const blockLen = cfg.frameBytes - HEADER_LEN;
  const encoder = new LTEncoder(container, blockLen, cfg.sessionId);
  const decoder = new LTDecoder(encoder.k, blockLen, cfg.sessionId, container.length);
  const header = {
    sessionId: cfg.sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: container.length,
    payloadFnv: fnv1a(container),
  };

  const side = colorGridSize(cfg.frameBytes, 2, 102);
  const grid = { cols: side, rows: side };
  let settings: TxSettings = { ...LADDER[0]!, cols: side, rows: side };

  const rng = mulberry32(cfg.seed);
  const rngFrame = mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0);
  const window: LocalTelemetry[] = [];
  const timeline: TimelineEntry[] = [];
  let heldFor = 0;
  let framesDropped = 0;
  let seconds = 0;
  let lastDecodedBytes = 0;

  for (let t = 0; t < cfg.maxFrames && !decoder.isComplete; t++) {
    const opts = channelAt(profile, seconds);
    const frameBytes = packFrame({ ...header, seq: t }, encoder.encode(t));
    const gridOpts = { cols: grid.cols, rows: grid.rows, bitsPerCell: settings.bitsPerCell, nsym: settings.nsym };
    const colorGrid = encodeFrame(frameBytes, gridOpts);
    const palette = paletteFor(settings.bitsPerCell);
    const raster = rasterizeGrid(colorGrid, palette, cfg.cellPx, cfg.gridMargin);
    const corrupted = corruptRaster(raster, opts, rng);
    let samples = sampleGrid(corrupted, grid.cols, grid.rows, cfg.cellPx, cfg.gridMargin);
    const expected: RGB[] = colorGrid.cells.map((v, i) =>
      v === null ? calibrationColor(palette, i) : paletteColor(palette, v),
    );
    const corruptedSamples = corruptSamples(samples, expected, opts, rng);
    samples = corruptedSamples.samples;

    const frameDropped = dropMask(1, profile.dropRate, rngFrame)[0]!;
    let decoded: ReturnType<typeof decodeFrame>;
    if (frameDropped) {
      decoded = { frameBytes: null, evm: 0, blends: 0, rsCorrectedBytes: 0, calibrationOk: true };
    } else {
      decoded = decodeFrame(samples, cfg.frameBytes, gridOpts);
    }

    if (decoded.frameBytes) {
      const parsed = parseFrame(decoded.frameBytes);
      if (
        parsed &&
        streamIdentity(parsed.header) === streamIdentity(header) &&
        parsed.header.seq === t
      ) {
        decoder.addFrame(t, parsed.block);
      }
    }

    const local: LocalTelemetry = {
      evm: decoded.evm,
      rsCorrectedBytes: decoded.rsCorrectedBytes,
      blends: decoded.blends,
      calibrationOk: decoded.calibrationOk,
      frameDropRate: 0, // filled on delivery
      dropped: decoded.frameBytes === null,
    };
    window.push(local);
    if (window.length > 3 * cfg.reverse.latencyFrames) window.shift();

    const delivered = reverseTelemetry(window, t, cfg.reverse, rng);
    if (delivered) {
      const next = adaptiveSettings(delivered, settings, cfg.adaptive, heldFor, grid);
      if (next.nsym !== settings.nsym || next.bitsPerCell !== settings.bitsPerCell || next.fps !== settings.fps) {
        heldFor = 0;
      } else {
        heldFor++;
      }
      settings = next;
    } else {
      heldFor++;
    }

    if (decoded.frameBytes === null) framesDropped++;
    lastDecodedBytes = decoder.solvedCount * blockLen;
    timeline.push({
      t,
      seconds,
      channel: opts,
      tx: settings,
      telemetry: { ...local, frameDropRate: window.filter((w) => w.dropped).length / window.length },
      dropped: decoded.frameBytes === null,
      decodedBytes: lastDecodedBytes,
    });
    seconds += 1 / settings.fps;
  }

  const assembled = decoder.assemble();
  let verify: RunReport["verify"] = "not-complete";
  let payloadBytes = 0;
  if (assembled) {
    try {
      const file = await unpackFile(assembled);
      verify = (await verifyFile(file)) ? "ok" : "fail";
      payloadBytes = file.bytes.length;
    } catch {
      verify = "fail";
    }
  }

  return {
    payloadName,
    payloadBytes,
    containerBytes: container.length,
    grid,
    framesSent: timeline.length,
    framesDropped,
    blocksSolved: decoder.solvedCount,
    blocksTotal: encoder.k,
    complete: decoder.isComplete,
    wallSeconds: seconds,
    goodputBps: seconds > 0 ? lastDecodedBytes / seconds : 0,
    verify,
    timeline,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-sim.test.ts`
Expected: PASS (all 5 tests). If the degrading-profile test fails to complete, the thresholds (`holdFrames`, `upEVM`, `downEVM`, the `degrading` episode strengths, or `maxFrames`) need tuning — this is the moment the sim's honest feedback is earning its keep. Raise `maxFrames` first (the recovery ramp at t=16 needs frames to climb back and finish). If the descent assertion fails, strengthen the dim episode (brightness lower, `cellJitter`/`blendFraction` higher) so telemetry crosses `downEVM`/`downDropRate`.

- [ ] **Step 5: Commit**

```bash
git add color/sim.ts tests/color-sim.test.ts
git commit -m "feat(color): closed-loop simulator core with honest reverse-channel model"
```

---

### Task 9: PNG I/O

Write color frames to real image files (and read them back) — the "test by writing to files" requirement. Uses `Bun.zlib` (deflate/inflate), the standard PNG chunk structure, RGBA color type.

**Files:**
- Create: `color/png.ts`
- Create: `color/bun-shim.d.ts` (tiny ambient type for the `"bun"` module so `tsc` is happy)
- Test: `tests/color-png.test.ts`

**Interfaces:**
- Consumes: `Raster` from `color/raster.ts`.
- Produces:
  - `encodePng(raster: Raster): Uint8Array`
  - `decodePng(bytes: Uint8Array): Raster`

- [ ] **Step 1: Write the failing test**

```ts
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
  const frameBytes = new Uint8Array(colorMaxFrameBytes(12, 12, 2, 26));
  for (let i = 0; i < frameBytes.length; i++) frameBytes[i] = (i * 47) & 0xff;
  const grid = encodeFrame(frameBytes, { cols: 12, rows: 12, bitsPerCell: 2, nsym: 26 });
  const raster = rasterizeGrid(grid, PALETTE_4, 8, 4);
  const back = decodePng(encodePng(raster));
  assert.equal(back.width, raster.width);
  assert.equal(back.height, raster.height);
  assert.deepEqual(Array.from(back.pixels), Array.from(raster.pixels));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-png.test.ts`
Expected: FAIL — `Cannot find module '../color/png.ts'`.

- [ ] **Step 3: Write the implementations**

```ts
// color/bun-shim.d.ts
// Minimal ambient types for the two Bun.zlib functions the PNG module uses.
// Real @types/bun would drag in the whole runtime surface; this is enough.
declare module "bun" {
  export function deflateSync(data: Uint8Array): Uint8Array;
  export function inflateSync(data: Uint8Array): Uint8Array;
}
```

```ts
// color/png.ts
// Minimal PNG writer/reader (8-bit RGBA, no interlacing, filter 0) so the sim
// can write color frames to real image files and read them back. PNG is only a
// file format for the encode CLI and for file-based tests — the live optical
// path never touches it (that is why the channel model has no JPEG either).

import { deflateSync, inflateSync } from "bun";
import type { Raster } from "./raster";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcIn = new Uint8Array(4 + data.length);
  crcIn.set(typeBytes, 0);
  crcIn.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcIn));
  return out;
}

export function encodePng(raster: Raster): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, raster.width);
  dv.setUint32(4, raster.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = raster.width * 4;
  const raw = new Uint8Array((stride + 1) * raster.height);
  for (let y = 0; y < raster.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < raster.width; x++) {
      const p = raster.pixels[y * raster.width + x]!;
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = p & 0xff;
      raw[o + 1] = (p >>> 8) & 0xff;
      raw[o + 2] = (p >>> 16) & 0xff;
      raw[o + 3] = (p >>> 24) & 0xff;
    }
  }

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const out: Uint8Array[] = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  let total = 0;
  for (const part of out) total += part.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const part of out) {
    merged.set(part, off);
    off += part.length;
  }
  return merged;
}

export function decodePng(bytes: Uint8Array): Raster {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let idat: Uint8Array | null = null;
  let off = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + 12 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = new TextDecoder().decode(bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      if (data[8] !== 8 || data[9] !== 6) throw new Error("only 8-bit RGBA PNGs supported");
    } else if (type === "IDAT") {
      idat = idat === null ? data : new Uint8Array([...idat, ...data]);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (width === 0 || height === 0 || idat === null) throw new Error("incomplete PNG");

  const raw = inflateSync(idat);
  const stride = width * 4;
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 4;
      const r = raw[o]!;
      const g = raw[o + 1]!;
      const b = raw[o + 2]!;
      const a = raw[o + 3]!;
      pixels[y * width + x] = (a << 24) | (b << 16) | (g << 8) | r;
    }
  }
  return { width, height, pixels };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/color-png.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add color/png.ts color/bun-shim.d.ts tests/color-png.test.ts
git commit -m "feat(color): PNG frame I/O via Bun.zlib"
```

---

### Task 10: Sim CLI & wiring

The `bun sim` CLI and the wiring that makes the whole thing runnable and type-checked.

**Files:**
- Create: `color/sim-cli.ts`
- Modify: `package.json` (add `"sim"` script and `"bin"`)
- Modify: `tsconfig.json` (add `color` to `include`)
- Test: extend `tests/color-sim.test.ts` (CLI integration is covered through the sim functions; this task adds a smoke test for `sim-cli.ts` argument parsing via direct invocation)

**Interfaces:**
- Consumes: `runTransfer`/`RunReport` from `color/sim.ts`; `encodeFrame` from `color/format.ts`; `rasterizeGrid` from `color/raster.ts`; `encodePng` from `color/png.ts`; `PROFILES` from `color/sim-channel.ts`; `colorGridSize` from `shared/frame-capacity.ts`; protocol/fountain for the encode path.
- Produces:
  - CLI:
    - `bun run sim -- encode <payloadPath> [outDir]` → writes `frame-000000.png …`, `manifest.json` (one carousel cycle of clean frames)
    - `bun run sim -- run <payloadPath> <profile> [--seed N] [--out dir]` → prints a summary, writes `report.json` and (with `--out`) sampled corrupted PNGs
  - package.json: `"sim": "bun color/sim-cli.ts"`, `"bin": { "sim": "color/sim-cli.ts" }`

- [ ] **Step 1: Write the failing test (appended to `tests/color-sim.test.ts`)**

```ts
test("sim-cli encode writes PNG frames plus a manifest", async () => {
  const { writeSimEncode } = await import("../color/sim-cli.ts");
  const dir = `${process.cwd()}/.sim-tmp-${Date.now()}`;
  try {
    await writeSimEncode("sim.bin", PAYLOAD, dir, { frameBytes: 300, cellPx: 8, sessionId: 0xab, seed: 7, gridMargin: 4 });
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files = readdirSync(dir).sort();
    assert.ok(files.some((f) => /^frame-\d{6}\.png$/.test(f)), `PNG frames: ${files.join(",")}`);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      sha256: string; frameCount: number; frameBytes: number; cols: number; rows: number;
    };
    assert.ok(typeof manifest.sha256 === "string" && manifest.sha256.length === 64);
    assert.ok(manifest.frameCount > 0);
    assert.ok(manifest.cols > 0 && manifest.rows > 0);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});
```

(Add to the imports at the top of `tests/color-sim.test.ts`: nothing — this test uses dynamic `import()` and `process.cwd()`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/color-sim.test.ts`
Expected: FAIL — `Cannot find module '../color/sim-cli.ts'`.

- [ ] **Step 3a: Write `color/sim-cli.ts`**

```ts
// color/sim-cli.ts
// `bun sim` — headless entry to the closed-loop simulation.
//   encode:  write one carousel cycle of clean color frames as PNG files
//   run:     closed-loop transfer over a channel profile → summary + report.json
// Invocation: `bun run sim -- encode <payload> [out]`, `bun run sim -- run <payload> <profile>`

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { LTEncoder, cycleLength } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFile, packFrame } from "../shared/protocol";
import { colorGridSize } from "../shared/frame-capacity";
import { LADDER } from "./adaptive";
import { encodeFrame } from "./format";
import { paletteFor } from "./palette";
import { rasterizeGrid } from "./raster";
import { encodePng } from "./png";
import { PROFILES } from "./sim-channel";
import { runTransfer, type RunReport, type SimConfig } from "./sim";

function usage(): never {
  console.error(
    [
      "usage:",
      "  sim encode <payloadPath> [outDir]                 write clean color frames as PNGs",
      "  sim run <payloadPath> <profile> [--seed N] [--out dir]",
      "                                                  closed-loop transfer over a profile",
      "profiles: " + Object.keys(PROFILES).join(", "),
    ].join("\n"),
  );
  process.exit(2);
}

export interface EncodeOptions {
  frameBytes: number;
  cellPx: number;
  gridMargin: number;
  sessionId: number;
  seed: number;
}

export async function writeSimEncode(
  payloadName: string,
  payload: Uint8Array,
  outDir: string,
  opts: EncodeOptions,
): Promise<void> {
  const packed = await packFile(payloadName, "application/octet-stream", payload);
  const container = packed.container;
  const blockLen = opts.frameBytes - HEADER_LEN;
  const encoder = new LTEncoder(container, blockLen, opts.sessionId);
  const side = colorGridSize(opts.frameBytes, 2, 102);
  const header = {
    sessionId: opts.sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: container.length,
    payloadFnv: fnv1a(container),
  };
  mkdirSync(outDir, { recursive: true });
  const palette = paletteFor(2);
  const nFrames = cycleLength(encoder.k);
  for (let t = 0; t < nFrames; t++) {
    const bytes = packFrame({ ...header, seq: t }, encoder.encode(t));
    const grid = encodeFrame(bytes, { cols: side, rows: side, bitsPerCell: 2, nsym: LADDER[0]!.nsym });
    const raster = rasterizeGrid(grid, palette, opts.cellPx, opts.gridMargin);
    const name = `frame-${String(t).padStart(6, "0")}.png`;
    writeFileSync(join(outDir, name), encodePng(raster));
  }
  // SHA-256 of the payload for the manifest (receiver-side verification anchor).
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  const sha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      { payloadName, sha256, frameCount: nFrames, frameBytes: opts.frameBytes, cols: side, rows: side, cellPx: opts.cellPx, sessionId: opts.sessionId, seed: opts.seed },
      null,
      2,
    ),
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function printReport(r: RunReport): void {
  console.log(`payload:     ${r.payloadName} (${r.payloadBytes} bytes, container ${r.containerBytes})`);
  console.log(`grid:        ${r.grid.cols}×${r.grid.rows} cells`);
  console.log(`frames:      ${r.framesSent} sent, ${r.framesDropped} dropped`);
  console.log(`blocks:      ${r.blocksSolved}/${r.blocksTotal} solved`);
  console.log(`complete:    ${r.complete ? "yes" : "no"}`);
  console.log(`verify:      ${r.verify}`);
  console.log(`wall time:   ${r.wallSeconds.toFixed(2)} s`);
  console.log(`goodput:     ${(r.goodputBps / 1024).toFixed(1)} KiB/s (${r.goodputBps.toFixed(0)} B/s)`);
  // Settings ladder actually used, for the report.
  const used = new Map<string, number>();
  for (const e of r.timeline) {
    const key = `${e.tx.bitsPerCell}b/nsym${e.tx.nsym}/fps${e.tx.fps}`;
    used.set(key, (used.get(key) ?? 0) + 1);
  }
  if (used.size > 0) {
    console.log(`settings:    ${[...used.entries()].map(([k, n]) => `${k}×${n}`).join(", ")}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "encode") {
    const payloadPath = args[1];
    const outDir = args[2] ?? "sim-frames";
    if (!payloadPath) usage();
    const payload = readFileSync(resolve(payloadPath));
    void writeSimEncode(basename(payloadPath), payload, resolve(outDir), {
      frameBytes: 600,
      cellPx: 8,
      gridMargin: 4,
      sessionId: 0x1234,
      seed: 20260809,
    }).then(() => console.log(`wrote ${cycleLength(Math.ceil(payload.length / (600 - HEADER_LEN)))} frames to ${outDir}`));
  } else if (cmd === "run") {
    const payloadPath = args[1];
    const profileName = args[2];
    if (!payloadPath || !profileName) usage();
    const profile = PROFILES[profileName];
    if (!profile) usage();
    let seed = 20260809;
    let outDir: string | null = null;
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--seed") seed = Number(args[i + 1]);
      else if (args[i] === "--out") outDir = args[i + 1];
    }
    const payload = readFileSync(resolve(payloadPath));
    const cfg: SimConfig = {
      frameBytes: 600,
      cellPx: 8,
      gridMargin: 4,
      sessionId: 0x1234,
      seed,
      maxFrames: 800,
      adaptive: { holdFrames: 60, upEVM: 0.12, upCorrected: 2, downEVM: 0.3, downDropRate: 0.1 },
      reverse: { updateEvery: 60, latencyFrames: 90, lossRate: 0.1 },
    };
    void (async () => {
      const report = await runTransfer(basename(payloadPath), payload, profile, cfg);
      printReport(report);
      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(resolve(outDir), "report.json"), JSON.stringify(report, null, 2));
      }
    })();
  } else {
    usage();
  }
}

// Only run the CLI when invoked directly: the Task 10 test imports
// writeSimEncode from this module, and running main() there would hit
// usage() → process.exit(2) and kill the test runner.
if ((import.meta as { main?: boolean }).main) {
  main();
}
```

- [ ] **Step 3b: Wire `package.json` and `tsconfig.json`**

In `package.json`, add two entries under `"scripts"` and a top-level `"bin"`:

```json
    "sim": "bun color/sim-cli.ts",
    "sim:help": "bun color/sim-cli.ts",
```

and (top level, after `"type": "module"`):

```json
  "bin": {
    "sim": "color/sim-cli.ts"
  },
```

(`bun link` once makes the spec's literal `bun sim …` spellings work; `bun run sim -- …` works without it.)

In `tsconfig.json`, change the include line to add `"color"`:

```json
  "include": ["shared", "send", "receive", "home", "color", "src-env.d.ts"]
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `bun test tests/color-sim.test.ts`
Expected: PASS (now 6 tests in this file).

Run: `bun test` — the full suite (existing 89 + the new color tests) must be green.

Run: `npm run build` — `tsc` must type-check the new `color/` modules under strict + `noUncheckedIndexedAccess` (the `bun-shim.d.ts` keeps `import … from "bun"` legal), and the vite build must still pass (color/ isn't referenced by pages yet — that's Phase 2).
Expected: build succeeds.

- [ ] **Step 5: Manual smoke of both CLI surfaces**

Run: `bun run sim -- encode <(echo "hello from the sim") /tmp/sim-frames` (or any small file), then list `/tmp/sim-frames` — PNG frames + `manifest.json` must appear.
Run: `bun run sim -- run <(echo "hello from the sim") clean --seed 1` — a summary line must print; then the same with `degrading`.
Expected: encode writes files; run prints a report; `clean` completes with `verify: ok`.

- [ ] **Step 6: Commit**

```bash
git add color/sim-cli.ts package.json tsconfig.json tests/color-sim.test.ts
git commit -m "feat(color): bun sim CLI (encode frames to PNG, closed-loop run) + wiring"
```

---

## Self-Review

**Spec coverage (Phases 0 + 1):**
- Phase 0 closed-loop sim → Tasks 6–10. CLI `encode`/`run` → Task 10. Seeded/deterministic → mulberry32 everywhere + determinism test (Task 8). Time-varying profiles → Task 6 `PROFILES.degrading`, `channelAt`. Live channel estimator → `FrameDecode` (EVM, rsCorrectedBytes, blends, calibrationOk) Task 4 + telemetry Task 8. Honest reverse channel → `reverseTelemetry` (Task 8). Policy as pure testable function → Task 7, used by Task 8. Aggregate goodput → `RunReport.goodputBps` + timeline. Synthetic channel (ISP tint/gamma/brightness, AE swings, blur, glare/vignette, sensor noise, jitter, blends, frame drops) → Task 6. JPEG optional stress → explicitly out of scope (spec marks it optional).
- Phase 1 codec → Tasks 1–5. 4-color base + 8-color advanced → Task 1. Per-frame 3×3 CCM least squares → Task 3. RS(255,k) GF(256) ~19% + interleave, adaptive 10–40% → Tasks 2, 4, 7. Blend → erasure flag → Task 1 + format. Grid-agnostic core → Task 4 (`encodeFrame`/`decodeFrame`). Capacity math color variant → Task 4 (shared/frame-capacity.ts). Golden vectors → RS GF table, RS(255,254) XOR vector, palette mapping (Tasks 1–2); round-trips everywhere.
- "Import the real codec code" → runTransfer uses `packFile/unpackFile/verifyFile/packFrame/parseFrame/LTEncoder/LTDecoder` unchanged (Task 8).
- Header rides inside RS-protected payload → frameBytes = header+block, RS-protected (Task 4, Task 8 parseFrame).

**Placeholder scan:** No TBD/TODO; every step has concrete code. The only open knobs are numeric thresholds in the sim/policy, which the tests themselves tune (noted inline in Task 8 Step 4).

**Type consistency:** `decodeFrame(samples, frameBytes, opts)` — `frameBytes` first is passed by the sim and tests consistently. `classifySample(sample, palette, opts?)` matches across Tasks 1, 4. `rsDecode` returns `{data, corrected}` used by `rsDeinterleave` in Task 4. `FrameOpts`/`FrameGrid`/`FrameDecode` names are consistent across Tasks 4, 5, 8. `Rng` is from sim-channel (Task 6) and used by `reverseTelemetry` (Task 8). `colorGridSize` from frame-capacity (Task 4) used by sim + CLI. One fix already applied during review: the Task 6 test imported a non-existent `channelOptsAt` — the final test imports only `CLEAN, PROFILES, channelAt, corruptRaster, corruptSamples, dropMask, mulberry32`.

**Design deviations surfaced (deliberate, documented in the plan):**
1. RS is hand-rolled, not `reedsolomon.es` — that library's actual API is a ratio-based block-splitting facade with no erasure support and no types; it cannot express the design's exact interleaved RS(255,k). Hand-rolled matches the `dlog()` culture; the GF table is pinned to QR-field values.
2. Black and white collapse in pure relative space — the 8-color set classifies in calibrated RGB (Task 1 test pins this).
3. Perspective is modeled as vignette + blur rather than a full geometric warp — the real receiver's detection pass (Phase 2) is where the warp belongs.

**Execution handoff** follows: subagent-driven (recommended) or inline.
