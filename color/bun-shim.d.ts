// color/bun-shim.d.ts
// Minimal ambient types for the two Bun.zlib functions the PNG module uses.
// Real @types/bun would drag in the whole runtime surface; this is enough.
declare module "bun" {
  export function deflateSync(data: Uint8Array): Uint8Array;
  export function inflateSync(data: Uint8Array): Uint8Array;
}
