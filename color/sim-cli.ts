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
  const stablePayload = Uint8Array.from(payload);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stablePayload));
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
      else if (args[i] === "--out") outDir = args[i + 1] ?? null;
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
