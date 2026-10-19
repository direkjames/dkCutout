/*
 * dkCutout — tiled upscaling engine (pure JS, no DOM, easy to test)
 * Author: direk james
 *
 * Big photos can't go through an AI model in one piece (it would run out of
 * memory), so the image is cut into small tiles. Every tile is given a few
 * extra pixels of context around it (the "pad"), upscaled, and then the pad
 * is trimmed off again. That way the tile borders never show as seams.
 *
 * Models always upscale by a fixed factor (usually 4x). For a smaller target
 * (2x) each upscaled tile is shrunk with a box filter before it is stitched,
 * which is sharper than upscaling and then resizing the whole picture, and
 * keeps memory at the size of the final image.
 */

export class AbortError extends Error {
  constructor() { super("Upscale cancelled"); this.name = "AbortError"; }
}

/** Copy a (tw+2*pad) x (th+2*pad) window around a tile, repeating edge pixels. */
function extractTile(src, w, h, x0, y0, tw, th, pad) {
  const iw = tw + pad * 2, ih = th + pad * 2;
  const out = new Uint8ClampedArray(iw * ih * 4);
  for (let y = 0; y < ih; y++) {
    const sy = Math.min(h - 1, Math.max(0, y0 - pad + y));
    for (let x = 0; x < iw; x++) {
      const sx = Math.min(w - 1, Math.max(0, x0 - pad + x));
      const s = (sy * w + sx) * 4, d = (y * iw + x) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, width: iw, height: ih };
}

/** Write the useful middle of an upscaled tile into the output, shrinking by f. */
function placeTile(out, outW, up, upW, x0, y0, tw, th, pad, native, f) {
  const target = native / f;
  const skip = pad * native;               // pad, in upscaled pixels
  const area = f * f;
  for (let y = 0; y < th * target; y++) {
    for (let x = 0; x < tw * target; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (skip + y * f + dy) * upW;
        for (let dx = 0; dx < f; dx++) {
          const s = (row + skip + x * f + dx) * 4;
          r += up[s]; g += up[s + 1]; b += up[s + 2];
        }
      }
      const d = ((y0 * target + y) * outW + x0 * target + x) * 4;
      out[d] = Math.round(r / area); out[d + 1] = Math.round(g / area);
      out[d + 2] = Math.round(b / area); out[d + 3] = 255;
    }
  }
}

/**
 * @param {object} o
 * @param {Uint8ClampedArray} o.src  RGBA pixels, w*h*4 (alpha is ignored)
 * @param {number} o.native  the model's fixed scale (e.g. 4)
 * @param {number} o.target  the scale the user asked for; native must be a multiple
 * @param {(tile:{data,width,height}) => Promise<Uint8ClampedArray>} o.runTile
 *        returns RGBA of (width*native) x (height*native)
 * @returns {Promise<Uint8ClampedArray>} opaque RGBA, (w*target) x (h*target)
 */
export async function upscaleTiled({
  src, w, h, native = 4, target = 4, tile = 192, pad = 12, runTile, onProgress, signal,
}) {
  if (!Number.isInteger(native / target) || target < 1) throw new Error("Unsupported scale.");
  if (src.length !== w * h * 4) throw new Error("Image data does not match its size.");
  const f = native / target;
  const outW = w * target;
  const out = new Uint8ClampedArray(outW * h * target * 4);

  const cols = Math.ceil(w / tile), rows = Math.ceil(h / tile), total = cols * rows;
  const started = performance.now();
  let done = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (signal?.aborted) throw new AbortError();
      const x0 = tx * tile, y0 = ty * tile;
      const tw = Math.min(tile, w - x0), th = Math.min(tile, h - y0);
      const input = extractTile(src, w, h, x0, y0, tw, th, pad);
      const up = await runTile(input);
      if (up.length !== input.width * native * input.height * native * 4) {
        throw new Error("The AI returned an unexpected tile size.");
      }
      placeTile(out, outW, up, input.width * native, x0, y0, tw, th, pad, native, f);
      done++;
      const elapsed = performance.now() - started;
      onProgress?.({ done, total, etaMs: (elapsed / done) * (total - done) });
    }
  }
  if (signal?.aborted) throw new AbortError();
  return out;
}
