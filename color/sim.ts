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
