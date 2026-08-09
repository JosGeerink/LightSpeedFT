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
