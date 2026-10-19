// Run with: node tests/tiling.test.mjs
import assert from "node:assert/strict";
import { upscaleTiled, AbortError } from "../upscale/tiling.js";

// A stand-in "model": repeats every pixel native x native times.
const fakeModel = (native) => async ({ data, width, height }) => {
  const ow = width * native, out = new Uint8ClampedArray(ow * height * native * 4);
  for (let y = 0; y < height * native; y++) for (let x = 0; x < ow; x++) {
    const s = ((y / native | 0) * width + (x / native | 0)) * 4, d = (y * ow + x) * 4;
    out.set(data.subarray(s, s + 4), d);
  }
  return out;
};
const image = (w, h) => {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { a[i*4] = i * 7; a[i*4+1] = i * 13; a[i*4+2] = i * 31; a[i*4+3] = 255; }
  return a;
};
const nearest = (src, w, h, s) => {
  const o = new Uint8ClampedArray(w*s*h*s*4);
  for (let y = 0; y < h*s; y++) for (let x = 0; x < w*s; x++)
    o.set(src.subarray(((y/s|0)*w + (x/s|0))*4, ((y/s|0)*w + (x/s|0))*4 + 4), (y*w*s + x)*4);
  return o;
};

for (const [w, h, native, target, tile] of [[37, 23, 4, 4, 16], [50, 50, 4, 2, 32], [5, 5, 4, 1, 64], [1, 1, 4, 4, 8], [64, 3, 4, 2, 16]]) {
  const src = image(w, h);
  const got = await upscaleTiled({ src, w, h, native, target, tile, pad: 4, runTile: fakeModel(native) });
  assert.deepEqual(got, nearest(src, w, h, target), `${w}x${h} ${native}->${target} tile ${tile}`);
}

const ac = new AbortController();
await assert.rejects(
  upscaleTiled({ src: image(64, 64), w: 64, h: 64, tile: 16, runTile: async (t) => { ac.abort(); return fakeModel(4)(t); }, signal: ac.signal }),
  AbortError,
);
await assert.rejects(upscaleTiled({ src: image(4, 4), w: 4, h: 4, native: 4, target: 3, runTile: fakeModel(4) }), /Unsupported/);
await assert.rejects(upscaleTiled({ src: image(4, 4), w: 4, h: 4, runTile: async () => new Uint8ClampedArray(3) }), /unexpected tile size/);
console.log("tiling: all tests passed");
