/*
 * dkCutout — AI upscaler worker (keeps the page smooth while the AI runs)
 * Author: direk james
 */
import { ORT_BASE } from "./models.js";

let ort = null, session = null, inputName = "", outputName = "";

const CACHE = "dkcutout-upscale-models-v1";

/** Download the model with progress, reusing the browser cache when possible. */
async function fetchModel(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* private mode: just download */ }
  const hit = cache && (await cache.match(url));
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the upscaler model (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  try { await cache?.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })); } catch { /* cache full */ }
  return bytes;
}

async function init({ url, device }) {
  ort = await import(`${ORT_BASE}ort.webgpu.min.mjs`);
  ort.env.wasm.wasmPaths = ORT_BASE;
  const bytes = await fetchModel(url, (p) => postMessage({ type: "download", fraction: p }));

  const tries = device === "gpu" ? ["webgpu", "wasm"] : ["wasm"];
  let lastErr = null;
  for (const ep of tries) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: "all" });
      inputName = session.inputNames[0];
      outputName = session.outputNames[0];
      // GPU can take bigger tiles; CPU gets small ones to stay responsive and light on memory.
      return { backend: ep, tile: ep === "webgpu" ? 256 : 128 };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Could not start the AI upscaler.");
}

async function runTile({ data, width, height }) {
  const n = width * height;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = data[i * 4] / 255;
    input[n + i] = data[i * 4 + 1] / 255;
    input[2 * n + i] = data[i * 4 + 2] / 255;
  }
  const feeds = { [inputName]: new ort.Tensor("float32", input, [1, 3, height, width]) };
  const results = await session.run(feeds);
  const out = results[outputName];
  const [, , oh, ow] = out.dims;
  const o = out.data, on = ow * oh;
  const rgba = new Uint8ClampedArray(on * 4);
  for (let i = 0; i < on; i++) {
    rgba[i * 4] = o[i] * 255 + 0.5;
    rgba[i * 4 + 1] = o[on + i] * 255 + 0.5;
    rgba[i * 4 + 2] = o[2 * on + i] * 255 + 0.5;
    rgba[i * 4 + 3] = 255;
  }
  out.dispose?.();
  return { rgba, width: ow, height: oh };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      postMessage({ id: m.id, type: "ready", ...(await init(m)) });
    } else if (m.type === "tile") {
      const r = await runTile(m);
      postMessage({ id: m.id, type: "tile", ...r }, [r.rgba.buffer]);
    }
  } catch (err) {
    postMessage({ id: m.id, type: "error", message: String(err?.message || err) });
  }
};
