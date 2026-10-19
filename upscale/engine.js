/*
 * dkCutout — upscale engine (main thread side)
 * Author: direk james
 *
 * upscaleImage() takes the finished cut-out (RGBA, transparency included) and
 * returns a bigger canvas. Colour and transparency are scaled separately:
 *   - colour: AI (tiled, in a worker) or Classic resizing
 *   - transparency: smooth resizing, so cut-out edges stay clean
 * and then put back together. Doing it this way means transparent areas never
 * smear their colour into the subject.
 */
import { upscaleTiled, AbortError } from "./tiling.js";
import { MODELS } from "./models.js";

export { AbortError };

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** Smooth resize in steps of at most 2x, which looks much better than one big jump. */
function classicResize(canvas, scale) {
  let cur = canvas;
  let factor = scale;
  while (factor > 1) {
    const step = Math.min(2, factor);
    const next = makeCanvas(Math.round(cur.width * step), Math.round(cur.height * step));
    const ctx = next.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    if (cur !== canvas) { cur.width = cur.height = 0; } // free memory right away
    cur = next;
    factor /= step;
  }
  return cur;
}

/** One opaque canvas holding just the colours (transparent pixels keep their real colours). */
function colourCanvas(rgba, w, h) {
  const px = new Uint8ClampedArray(rgba); // copy, then force opaque
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const c = makeCanvas(w, h);
  c.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}

/** A greyscale canvas holding just the transparency. */
function alphaCanvas(rgba, w, h) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = a;
    px[i * 4 + 3] = 255;
  }
  const c = makeCanvas(w, h);
  c.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}

let worker = null, workerKey = "", nextId = 1;

function call(msg, transfer, onMessage) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const handler = (e) => {
      const m = e.data;
      if (m.type === "download") { onMessage?.(m); return; }
      if (m.id !== id) return;
      worker.removeEventListener("message", handler);
      m.type === "error" ? reject(new Error(m.message)) : resolve(m);
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

export function stopWorker() {
  worker?.terminate();
  worker = null; workerKey = "";
}

async function ensureWorker(model, onStatus) {
  const key = model.url;
  if (worker && workerKey === key) return worker.info;
  stopWorker();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  workerKey = key;
  onStatus?.("Loading the AI upscaler (first time downloads it, then it's cached)…", null);
  worker.info = await call(
    { type: "init", url: model.url, device: "gpu" in navigator ? "gpu" : "cpu" }, null,
    (m) => onStatus?.(`Downloading the AI upscaler… ${Math.round(m.fraction * 100)}%`, m.fraction),
  );
  return worker.info;
}

/**
 * @param {object} o
 * @param {Uint8ClampedArray} o.rgba  the finished cut-out
 * @param {"fast"|"best"|"classic"} o.engine
 * @param {2|4} o.scale
 * @param {(text:string, fraction:number|null, etaMs?:number)=>void} o.onStatus
 * @param {AbortSignal} o.signal
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function upscaleImage({ rgba, w, h, engine, scale, onStatus, signal }) {
  const alphaSmall = alphaCanvas(rgba, w, h);
  const colourSmall = colourCanvas(rgba, w, h);
  let colourBig;

  if (engine === "classic") {
    onStatus?.("Resizing…", null);
    colourBig = classicResize(colourSmall, scale);
  } else {
    const model = MODELS[engine];
    if (!model?.url) throw new Error("This AI upscaler isn't available yet. Use Classic for now.");
    const info = await ensureWorker(model, onStatus);
    if (signal?.aborted) throw new AbortError();
    const src = colourSmall.getContext("2d").getImageData(0, 0, w, h).data;
    const out = await upscaleTiled({
      src, w, h, native: model.native, target: scale, tile: info.tile, pad: 12, signal,
      runTile: async (t) => {
        const r = await call({ type: "tile", data: t.data, width: t.width, height: t.height }, [t.data.buffer]);
        return r.rgba;
      },
      onProgress: ({ done, total, etaMs }) =>
        onStatus?.(`Upscaling… ${done} of ${total} tiles`, done / total, etaMs),
    });
    colourBig = makeCanvas(w * scale, h * scale);
    colourBig.getContext("2d").putImageData(new ImageData(out, w * scale, h * scale), 0, 0);
  }
  colourSmall.width = colourSmall.height = 0;

  if (signal?.aborted) throw new AbortError();
  onStatus?.("Finishing the edges…", null);
  const alphaBig = classicResize(alphaSmall, scale);
  alphaSmall.width = alphaSmall.height = 0;

  const ctx = colourBig.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, colourBig.width, colourBig.height);
  const a = alphaBig.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, alphaBig.width, alphaBig.height).data;
  for (let i = 0; i < a.length; i += 4) img.data[i + 3] = a[i];
  alphaBig.width = alphaBig.height = 0;
  ctx.putImageData(img, 0, 0);
  return colourBig;
}
