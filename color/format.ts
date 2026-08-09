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
