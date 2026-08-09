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
