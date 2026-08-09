// How much payload fits in a stream at a given frame size.
//
// The frame header numbers source blocks in a u16, so a large payload at a
// small bytes-per-frame runs out of block numbers long before it runs out of
// the file size limit: at 500 bytes per frame the real ceiling is about 30 MB,
// not 64. The sender has to catch that before it starts streaming, and tell
// you which setting fixes it.

import { HEADER_LEN } from "./protocol";

/** `k` is a u16 in the frame header. */
export const MAX_SOURCE_BLOCKS = 0xffff;

/** Payload bytes per frame, once the header has taken its cut. */
export function blockLength(frameBytes: number): number {
  return frameBytes - HEADER_LEN;
}

/** Source blocks a payload splits into at this frame size. */
export function sourceBlockCount(payloadBytes: number, frameBytes: number): number {
  return Math.ceil(payloadBytes / blockLength(frameBytes));
}

export function fitsInOneStream(payloadBytes: number, frameBytes: number): boolean {
  return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
}

/** The smallest bytes-per-frame that can carry this payload at all. */
export function minimumFrameBytes(payloadBytes: number): number {
  return Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) + HEADER_LEN;
}

/**
 * The smallest offered setting that works, so the sender can name a value that
 * is actually in the dropdown instead of the bare arithmetic minimum.
 *
 * Undefined when no option is large enough — unreachable while MAX_FILE_BYTES
 * holds, since the largest legal payload needs about 1045 bytes per frame, but
 * the caller should not have to know that.
 */
export function smallestSufficientFrameSize(
  payloadBytes: number,
  options: readonly number[],
): number | undefined {
  const minimum = minimumFrameBytes(payloadBytes);
  return options
    .filter((value) => value >= minimum)
    .sort((a, b) => a - b)[0];
}

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
