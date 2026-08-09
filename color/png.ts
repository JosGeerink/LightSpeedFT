// color/png.ts
// Minimal PNG writer/reader (8-bit RGBA, no interlacing, filter 0) so the sim
// can write color frames to real image files and read them back. PNG is only a
// file format for the encode CLI and for file-based tests — the live optical
// path never touches it (that is why the channel model has no JPEG either).

import { deflateSync, inflateSync } from "bun";
import type { Raster } from "./raster";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcIn = new Uint8Array(4 + data.length);
  crcIn.set(typeBytes, 0);
  crcIn.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcIn));
  return out;
}

export function encodePng(raster: Raster): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, raster.width);
  dv.setUint32(4, raster.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = raster.width * 4;
  const raw = new Uint8Array((stride + 1) * raster.height);
  for (let y = 0; y < raster.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < raster.width; x++) {
      const p = raster.pixels[y * raster.width + x]!;
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = p & 0xff;
      raw[o + 1] = (p >>> 8) & 0xff;
      raw[o + 2] = (p >>> 16) & 0xff;
      raw[o + 3] = (p >>> 24) & 0xff;
    }
  }

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const out: Uint8Array[] = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  let total = 0;
  for (const part of out) total += part.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const part of out) {
    merged.set(part, off);
    off += part.length;
  }
  return merged;
}

export function decodePng(bytes: Uint8Array): Raster {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    throw new Error("not a PNG");
  }
  let width = 0;
  let height = 0;
  let idat: Uint8Array | null = null;
  let off = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + 12 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = new TextDecoder().decode(bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      if (data[8] !== 8 || data[9] !== 6) throw new Error("only 8-bit RGBA PNGs supported");
    } else if (type === "IDAT") {
      idat = idat === null ? data : new Uint8Array([...idat, ...data]);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (width === 0 || height === 0 || idat === null) throw new Error("incomplete PNG");

  const raw = inflateSync(idat);
  const stride = width * 4;
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 4;
      const r = raw[o]!;
      const g = raw[o + 1]!;
      const b = raw[o + 2]!;
      const a = raw[o + 3]!;
      pixels[y * width + x] = (a << 24) | (b << 16) | (g << 8) | r;
    }
  }
  return { width, height, pixels };
}
