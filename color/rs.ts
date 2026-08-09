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
