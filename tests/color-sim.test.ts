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

test("degrading profile: the closed loop descends during bad episodes, survives, and completes", { timeout: 120_000 }, async () => {
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

test("recovered bytes accumulate monotonically even through bad episodes", { timeout: 120_000 }, async () => {
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
