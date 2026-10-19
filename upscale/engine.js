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
const pending = new Map(); // id -> { resolve, reject, onMessage }

function failAll(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function call(msg, transfer, onMessage) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error("The AI upscaler is not running."));
    const id = nextId++;
    pending.set(id, { resolve, reject, onMessage });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "download") {
    for (const p of pending.values()) p.onMessage?.(m);
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.type === "error" ? p.reject(new Error(m.message)) : p.resolve(m);
}

export function stopWorker(reason) {
  worker?.terminate();
  worker = null; workerKey = "";
  failAll(reason || new AbortError());
}

/** Is WebGPU really usable here? Checked once. */
let gpuCheck = null;
export function hasWebGPU() {
  gpuCheck ??= (async () => {
    try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
  })();
  return gpuCheck;
}

/** Resolve with `promise`, or stop the worker and throw AbortError as soon as `signal` fires. */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => { stopWorker(); reject(new AbortError()); };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function ensureWorker(model, onStatus, signal) {
  if (worker && workerKey === model.id && worker.info) return worker.info;
  stopWorker();
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker = w;
  w.addEventListener("message", onWorkerMessage);
  // A crash inside the worker (for example running out of memory) must not leave us waiting forever.
  w.addEventListener("error", (e) => {
    e.preventDefault?.();
    if (worker === w) stopWorker(new Error("The AI upscaler stopped unexpectedly (your device may be low on memory)."));
  });
  workerKey = model.id;
  onStatus?.("Loading the AI upscaler (the first time downloads it, then it's saved)…", null);
  try {
    const info = await abortable(call(
      { type: "init", model, gpu: await hasWebGPU() }, null,
      (m) => onStatus?.(`Downloading the ${model.label} AI upscaler (${model.size})… ${Math.round(m.fraction * 100)}%`, m.fraction),
    ), signal);
    w.info = info;
    return info;
  } catch (e) {
    if (!(e instanceof AbortError)) stopWorker(e);
    throw e;
  }
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
  let opaque = true; // photos with no transparency skip the whole alpha pass
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }

  /** The transparency at the new size, as one value per pixel (in the R of each RGBA). */
  const bigAlpha = () => {
    const small = alphaCanvas(rgba, w, h);
    const big = classicResize(small, scale);
    small.width = small.height = 0;
    const a = big.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, big.width, big.height).data;
    big.width = big.height = 0;
    return a;
  };

  const colourSmall = colourCanvas(rgba, w, h);

  if (engine === "classic") {
    onStatus?.("Resizing…", null);
    const colourBig = classicResize(colourSmall, scale);
    colourSmall.width = colourSmall.height = 0;
    if (opaque) return colourBig;
    onStatus?.("Finishing the edges…", null);
    const ctx = colourBig.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, colourBig.width, colourBig.height);
    const a = bigAlpha();
    for (let i = 0; i < a.length; i += 4) img.data[i + 3] = a[i];
    ctx.putImageData(img, 0, 0);
    return colourBig;
  }

  const model = MODELS[engine];
  if (!model) throw new Error("Unknown upscaler.");
  if (model.needsGpu && !(await hasWebGPU())) {
    throw new Error(`${model.label} needs a browser with graphics acceleration (WebGPU). Use Fast instead.`);
  }
  const info = await ensureWorker(model, onStatus, signal);
  if (signal?.aborted) throw new AbortError();
  const src = colourSmall.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  colourSmall.width = colourSmall.height = 0;
  const out = await upscaleTiled({
    src, w, h, native: model.native, target: scale, tile: info.tile, pad: 12, signal,
    runTile: async (t) => {
      const r = await call({ type: "tile", data: t.data, width: t.width, height: t.height }, [t.data.buffer]);
      return r.rgba;
    },
    onProgress: ({ done, total, etaMs }) =>
      onStatus?.(`Upscaling… ${done} of ${total} tiles`, done / total, etaMs),
  });
  if (signal?.aborted) throw new AbortError();
  if (!opaque) {
    onStatus?.("Finishing the edges…", null);
    const a = bigAlpha(); // written straight into the result: no extra full-size copies
    for (let i = 3; i < a.length; i += 4) out[i] = a[i - 3];
  }
  const big = makeCanvas(w * scale, h * scale);
  big.getContext("2d").putImageData(new ImageData(out, w * scale, h * scale), 0, 0);
  return big;
}
