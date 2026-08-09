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
