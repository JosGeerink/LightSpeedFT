// tests/color-rs.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { RS_CODEWORD_LEN, gfPow, rsDecode, rsEncode } from "../color/rs.ts";

test("GF(256) exp table matches the QR field (primitive poly 0x11D)", () => {
  // α^i for the standard field, pinned to hand-computed values.
  const golden: [number, number][] = [
    [0, 1],
    [1, 2],
    [8, 0x1d],
    [9, 0x3a],
    [10, 0x74],
    [40, 0x6a],
    [99, 0x86],
    [100, 0x11],
  ];
  for (const [i, expected] of golden) {
    assert.equal(gfPow(i), expected, `α^${i}`);
  }
});

test("RS(255,254) parity is the XOR of the data bytes (hand-verifiable)", () => {
  const data = new Uint8Array(254);
  data[0] = 1;
  data[1] = 2;
  data[2] = 3;
  data[253] = 254;
  const cw = rsEncode(data, 1);
  assert.equal(cw.length, RS_CODEWORD_LEN);
  // 1 ^ 2 ^ 3 ^ 254 = 254
  assert.equal(cw[254], 254, "parity byte is the XOR of all data bytes");
  assert.deepEqual(cw.slice(0, 254), data);
});

test("a clean codeword decodes to the original data with zero corrections", () => {
  const data = new Uint8Array(255 - 30);
  for (let i = 0; i < data.length; i++) data[i] = i * 7;
  const cw = rsEncode(data, 30);
  const dec = rsDecode(cw, 30);
  assert.ok(dec !== null);
  assert.deepEqual(dec.data, data);
  assert.equal(dec.corrected, 0);
});

test("rsDecode corrects exactly floor(nsym/2) errors", () => {
  const nsym = 30;
  const k = 255 - nsym;
  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = (i * 31) & 0xff;
  const cw = rsEncode(data, nsym);
  const corrupted = new Uint8Array(cw);
  // Corrupt 15 distinct bytes (the correction bound).
  for (let e = 0; e < 15; e++) corrupted[e * 17] = corrupted[e * 17]! ^ (e + 5);
  const dec = rsDecode(corrupted, nsym);
  assert.ok(dec !== null, "15 errors on parity 30 must be correctable");
  assert.deepEqual(dec.data, data);
  assert.equal(dec.corrected, 15);
});

test("rsDecode never returns the original data when errors exceed the bound", () => {
  const nsym = 30;
  const k = 255 - nsym;
  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = (i * 13) & 0xff;
  const cw = rsEncode(data, nsym);
  const corrupted = new Uint8Array(cw);
  for (let e = 0; e < 16; e++) corrupted[e * 11] = corrupted[e * 11]! ^ (e + 1);
  const dec = rsDecode(corrupted, nsym);
  if (dec !== null) {
    assert.notDeepEqual(dec.data, data, "16 errors exceed the correction bound");
  }
});

test("a shattered codeword (every byte wrong) is uncorrectable", () => {
  const data = new Uint8Array(255 - 10);
  const cw = rsEncode(data, 10);
  const corrupted = new Uint8Array(cw);
  for (let i = 0; i < corrupted.length; i++) corrupted[i] = corrupted[i]! ^ 0xa5;
  assert.equal(rsDecode(corrupted, 10), null);
});
