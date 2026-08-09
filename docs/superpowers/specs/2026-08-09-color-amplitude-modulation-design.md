# Color Amplitude Modulation — Design

**Date:** 2026-08-09
**Status:** Design approved in brainstorming; implementation plan pending.
**Scope:** Adds a multi-bit color physical layer to Decimen Optical Transfer, on top of the existing fountain-coded animated-QR channel. The current 1-bit-per-module monochrome QR becomes one of two physical layers; color becomes the primary mode, with B/W QR as a fallback.

## Goal

Raise sustained throughput by modulating more than 1 bit per cell — replacing the monochrome QR rasterizer/decoder with a color-cell physical layer (2–3 bits/cell), while keeping the fountain/protocol erasure-coding layers byte-identical. The success bar is validated in simulation, not committed up front:

- **Solid v1 target: 2–4×** the current records (418.5 KB/s desktop→phone, 199.2 KB/s phone→phone), at high reliability.
- **Stretch goal toward 8×:** 3 bits/cell color *plus* a purpose-built dense grid (libcimbar-style), enabled by the same grid-agnostic color core. Reached only if the simulation shows the density is worth the from-scratch detection build.

## Locked constraints (from brainstorming)

1. **Reverse feedback is reverse-optical only.** No network path between devices — the product's core identity is preserved. The receiver displays a low-rate telemetry code the sender's camera reads.
2. **Color is primary; B/W QR stays as a fallback.** Old standalone sender/receiver HTML files keep interoperating; classic QR mode remains available.
3. **Full-duplex capability, time-sliced in practice.** Both devices have a camera and a screen (symmetric architecture), but the reverse channel is shown during natural gaps in the forward stream. True simultaneous full-duplex has a measured ~3.2 kbps ceiling (2016, WoWMoM) from cross-illumination/exposure interference — not the goal.
4. **Simulation is TypeScript/Bun and imports the real codec code.** No parallel Python codebase. Synthetic channel hand-rolled over the same pixel model the app uses.
5. **The simulation is a closed loop**, not a static encode→corrupt→decode pipeline: the channel varies over time, and the reverse-channel feedback drives the sender's settings. See Phase 0.

## Research grounding (what the evidence says)

These findings shaped the design; sources in [References](#references).

- **Reliable color ceiling is 2–3 bits/cell.** 4 colors (2 bits/cell) is the robust default every serious system converged on (libcimbar shipping mode, MAMBA, TETRIS). 8 colors (3 bits/cell) is marginal — it needs per-frame calibration + intra-frame FEC, and libcimbar *deprecated* its 8-color mode. 16+ colors is research territory requiring joint/subspace decoding.
- **Decimen's monochrome QR is already ~4× faster than the best color-code prior art** (3.34 Mbit/s vs libcimbar's 850 kbit/s). Bits/cell is not the binding constraint in this architecture; decode throughput and camera coverage are. Color only wins if it does not sacrifice the fast tracked-decode / multi-code-grid architecture.
- **Calibration is solved practice:** a per-frame 3×3 color-correction matrix fitted by least squares from known-color reference swatches, classification in a brightness-invariant relative space `(r−g, g−b, b−r)` with min/max normalization (libcimbar's mechanism).
- **FEC is two layers:** fountain for frame erasures (unchanged) + Reed–Solomon(255,k) over GF(256) intra-frame (~19% overhead) for cell errors within a decodable frame. Fountain cannot correct errors, only erasures; color misclassification produces errors.
- **No JPEG in the live receive path.** `getUserMedia → drawImage/createImageBitmap → getImageData` yields raw RGBA; the sender renders raw canvas pixels. The print/photo JPEG-quantization limiter from the color-barcode literature does not bind this channel. The real distortions are the phone ISP's white balance, auto-exposure, gamma/tone mapping, lens blur, rolling shutter, and sensor noise — the smooth/global kinds a per-frame CCM absorbs. (Implication: 8 colors is *more* viable here than the literature suggests.)
- **Reverse telemetry at a few bits/sec is ~1000× below demonstrated capability** over the identical phone-screen→phone-camera geometry. Recipe: a tiny symbol held ≥1 s, repeated across ~15–30 frames, majority-voted, with 100–300 ms black gaps between symbols.

## Architecture principle: replace only the physical layer

The fountain and container layers are **untouched** — `protocol.ts` and `fountain.ts` keep their golden vectors, byte-for-byte. Color work replaces only the carrier:

```
v2 today:   frameBytes → QRCode.create() → B/W modules
v3 color:   frameBytes → RS(255,k) codewords → bits → color cells → raster

(decoder runs the same path in reverse, delivering frameBytes to the SAME
 fountain decoder)
```

The 20-byte header (magic `0x0D`, session id, seq, k, blockLen, totalLen, payload FNV) rides inside the RS-protected payload. Mode routing happens at the physical layer (did this frame decode via QR or via color?), not in the fountain layer. This is what keeps B/W fallback and old standalone files working: a v3 color frame and a v2 QR frame carry the same fountain payload.

## Phase 0 — Closed-loop simulation rig

The first deliverable. A headless CLI that tests encoding/decoding via files and, critically, tests **real-time adaptive scaling driven by reverse-channel information**.

### Architecture

```
        ┌─────────────── sender (adaptive controller) ───────────────┐
        │   bits/cell · FEC overhead · fps · grid  ◄── policy ───────│─┐
        └───────────────┬────────────────────────────────────────────┘ │
                        │ color frames @ current settings               │
                        ▼                                               │
              ┌──────────────────┐        ┌─────────────────────┐      │
              │ time-varying     │        │ decoder measures    │      │
              │ channel profile  │        │ EVM · cell-err ·     │      │
              │ (movement, dim,  │        │ frame-drop           │      │
              │ glare, …)        │        └──────────┬──────────┘      │
              └──────────────────┘                   │ telemetry        │
                                                     ▼                  │
                ┌──────────────────────────────────────────────┐       │
                │ reverse channel model                         │       │
                │ ~1 Hz, latency, majority-vote, loss           │───────┘
                └──────────────────────────────────────────────┘
```

### CLI surface

```
bun sim encode <payload> → frames       # real fountain + protocol + color raster
bun sim run <payload> <profile> → report # closed-loop run over a channel profile
```

### Key properties

- **Seeded, deterministic** (matches the project's golden-vector culture): a given channel profile reproduces exactly.
- **Channel profile is time-varying**, scripted or random-walk episodes (clean → camera moves → dim → glare → recovery). The noise/corruption is the *input* to the adaptive loop, not a static stress test.
- **Decoder is a live channel estimator**: every frame contributes EVM (measured cell colors vs. constellation points), cell-error rate, and frame-drop rate. The receiver doesn't just decode — it measures.
- **Reverse channel modeled honestly, not idealized**: ~1 Hz updates, latency, majority-voting, occasional missed symbols. The adaptive loop is tested under the real feedback quality the time-sliced channel gives.
- **The adaptive policy is a first-class, testable artifact**: a pure function `(telemetry window) → (bits/cell, FEC overhead, fps, grid count)` with hysteresis. Golden-tested and benchmarked in the sim; the exact same function runs in the browser later.
- **Run output is a timeline**: channel condition → sender's chosen settings → realized throughput → survival (did the transfer complete; did it keep making progress during bad episodes). Headline metric is *aggregate goodput across a time-varying run*.

### Synthetic channel model (default profile)

The real channel has no JPEG; the default model covers the actual distortions:

- **ISP color processing**: white-balance tint, gamma, brightness/contrast (models the phone ISP, not JPEG).
- **Auto-exposure swings**: global brightness drift.
- **Spatial**: perspective transform (off-angle), Gaussian lens blur, motion blur, glare/specularity overlay.
- **Sensor**: Gaussian/Poisson noise; rolling-shutter tearing (half-old/half-new frames).
- **Per-cell jitter**: random small color changes — the "deliberately mess things up" injection.
- **Frame drops**: random erasures.

JPEG (q50–80) is an **optional stress scenario**, not the default — reserved for a plausible future "read a screenshot of the sender" ingest path.

## Phase 1 — Color-frame codec (grid-agnostic core)

### Constellation

- **Base: 4 colors / 2 bits per cell** — green/cyan/yellow/magenta (libcimbar's hue-differentiated set, on RGB-cube faces). Robust with nearest-point classification. The reliable default.
- **Advanced: 8 colors / 3 bits per cell** — RGB-cube vertices (black/blue/green/cyan/red/magenta/yellow/white, JAB-Code's set). Enabled only behind per-frame calibration + RS. The 4↔8 switch is exactly what the reverse channel negotiates (ACM).
- **Classification is brightness-invariant**: after calibration, classify in `(r−g, g−b, b−r)` relative space with per-sample min/max normalization. A measured color in a *blend region* between constellation points is flagged **erasure**, not misclassified.

### Per-frame calibration

A **3×3 color-correction matrix** fitted by Moore–Penrose least squares from known-color reference swatches embedded in the frame (observed RGB → expected palette RGB), applied to every data cell before classification. This is what makes 3 bits/cell viable. On calibration failure (e.g., glare on swatches): fall back to a neutral matrix + normalization rather than dropping the frame, and emit the failure as a channel-quality signal.

### Intra-frame FEC

- **Reed–Solomon(255, k) over GF(256)**, ~19% overhead (libcimbar's proven 30/155 ≈ 19.4%), interleaved so local damage spreads across codewords.
- **Adaptive overhead (10%→40%)** is a sender setting driven by reverse-channel telemetry.
- In-browser: `reedsolomon.es` (ZXing RS port, Apache-2.0) for correctness first; compile `libcorrect` to WASM if decode speed demands.

### v3 wire format & the grid-agnostic core

- The format spec defines, per grid: which positions are **structural** (B/W finders/timing — needed for detection), which are **calibration swatches** (a perimeter band), and which are **data cells** (RS-coded payload bits, 2 or 3 per cell).
- **Grid-agnostic core interface**: `grid cells + mask → calibrate → classify → RS → frameBytes`. Phase 2 supplies QR-shaped cells (zxing detection + `trackedSamples`); Phase 4 supplies dense-grid cells (custom detection). Nothing above the sampling front-end changes between them.
- Capacity math gets a color variant (`frame-capacity.ts`): V40 at 2 bits/cell ≈ ~2× today's 2953-byte payload; 3 bits/cell ≈ ~3×. Realized goodput (after calibration overhead and cell geometry) is measured in the sim.

## Phase 2 — Real sender/receiver integration

**Sender.** A new color rasterizer replaces `QRCode.create` in color mode (`qrcode` + B/W raster stay for fallback). Grid tiling, fps/stagger logic, `packFrame`, diagnostics, fullscreen stage are untouched — all above the physical layer. Mode switch (B/W ↔ color) is a UI choice plus an ACM setting.

**Receiver.** Two changes:
1. **Fork decimen-codec** to add `trackedSamples(ptr, w, h, dim, quad…) → per-cell RGBA`: reuse the existing perspective-transform/grid-sampling machinery (the codebase already exposes `trackedMatrix()`/`projectPoint()`), skip binarization, return raw cell colors. A small C++ addition.
2. **A color-decode path in the worker**: QR detection (which already succeeds for color-filled data modules via the sightings path) → `trackedSamples` → TS color core → `frameBytes` → the **same fountain decoder**. Worker output shape is unchanged (`{id, symbols, bytes, quad, modules}`), so region tracking, crop seeding, and the worker pool are untouched.

Mode routing lives in the worker: standard-QR decode → existing path; detected-but-undecodable-then-color-decode → color path. Either way the fountain layer sees valid `frameBytes`.

**B/W fallback stays**: if the camera or calibration rejects color (probed via existing `platform.ts` capability checks), fall back to B/W QR.

## Phase 3 — Reverse telemetry channel & ACM

- **Reverse channel**: the receiver shows a **telemetry surface** during natural gaps in the forward stream — a QR v1 or small binary grid, held ≥1 s, repeated across ~15–30 frames, majority-voted, with 100–300 ms black gaps between symbols. Tens of bps at near-100% reliability. Time-sliced, so no simultaneous-interference penalty.
- **Telemetry content**: EVM, per-frame cell-error rate, frame-drop rate, calibration success — the same metrics the sim computes.
- **Locked optics**: for a facing-screen link, lock exposure/WB/focus (probing already exists in `platform.ts`); otherwise each camera's auto-gain fights the other screen's brightness.
- **ACM policy**: pure function `(telemetry window) → (bits/cell, FEC overhead, fps, grid count)` with hysteresis — same function in sim and browser. Example: clean → 8 colors / 10% FEC / high fps; degrading → 4 colors / 30–40% FEC / lower fps; recovery → ramp back with a hold time.

## Phase 4 — Dense custom grid (stretch)

Slots into the same color core: corner anchors + guide lines, ~5–8 px cells, ~10–15k cells/frame, 4–8 colors, RS + fountain. The one genuinely new build is **detection from scratch in TS** (perspective quad from custom anchors — zxing won't find a non-QR grid). The sim measures whether the density is worth that build before committing. This is the only path toward the 8× stretch.

## Testing & error handling

- **Golden vectors** for the new format: palette mapping, CCM fit, RS, cell→bit→frame round-trips.
- **Sim suites**: closed-loop adaptive runs over scripted channel profiles; corruption injection at every layer (per-cell jitter, dropped frames, blend cells, calibration failure).
- **Error model**: blend cells → erasure → RS; RS failure or header-hash mismatch → frame dropped → fountain; calibration failure → neutral CCM fallback + telemetry signal.
- **Diagnostics**: extend the existing `/__diagnostics` rig with color-mode metrics (EVM, per-cell error, calibration health) so sim and field runs stay comparable.
- **Capability gating**: `platform.ts` probes decide whether color is usable on a given device; B/W fallback otherwise.

## Future directions (not in scope now)

**Rolling-shutter line-scan OCC** — a complementary high-rate *temporal* mode: exploit the camera's row-by-row readout to sample screen content that changes within a frame, encoding data as spatial stripes. Real and research-proven, but: (a) the display refresh rate (not the sensor's line rate) bounds the symbol rate for a screen transmitter; (b) it is a different modulation axis (1-D temporal) than the 2-D spatial color cells designed here, so it would be its own physical layer; (c) the orientation problem (sensor sweep axis) needs a preamble calibration or orientation-agnostic patterns. The two tearing-related techniques in the line-scan literature — guard/strobe blanking frames and erasure-based blend-cell decoding — are already reflected in this design (Phase 0 channel model and the error model). Keep the color physical layer's interfaces clean enough that a stripe mode could be added later.

## References

- libcimbar (closest prior art): [repo](https://github.com/sz3/libcimbar) · [PERFORMANCE.md](https://github.com/sz3/libcimbar/blob/master/PERFORMANCE.md) · [DETAILS.md](https://github.com/sz3/libcimbar/blob/master/DETAILS.md) · [DeepWiki core concepts](https://deepwiki.com/sz3/libcimbar/1.1-core-concepts)
- Microsoft HCCB: [Wikipedia](https://en.wikipedia.org/wiki/High_Capacity_Color_Barcode)
- JAB Code (ISO/IEC 23634:2022): [ISO catalog](https://www.iteh.eu:443/catalog/standards/iso/196b22f3-f557-416d-b2b5-f65f3207aed5/iso-iec-23634-2022) · [BSI TR-03137 Part 2](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/Publications/TechGuidelines/TR03137/BSI-TR-03137_Part2.pdf)
- MAMBA (bidirectional, 4-color choice): [AaltoDoc](https://aaltodoc.aalto.fi/items/70f03bfb-2b31-4f53-92f6-b3a1119dd1e7/full)
- TETRIS (phone→phone color, 4 colors, rolling-shutter as primary error source): [IEEE](https://ieeexplore.ieee.org/document/8108801)
- Streaming QR survey (throughput landscape): [IEEE Access 2024](https://ieeexplore.ieee.org/abstract/document/10681075)
- Freire & Di Francesco, bidirectional smartphones, WoWMoM 2016 (~3.2 kbps full-duplex): [IEEE](https://ieeexplore.ieee.org/document/7523499)
- Reed-Solomon in-browser: [`reedsolomon.es` (ZXing port)](https://www.npmjs.com/package/reedsolomon.es) · [`libcorrect` (vendored in libcimbar)](https://github.com/quiet/libcorrect)
- Decimen current measured records: `README.md` (this repo)
