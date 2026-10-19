/*
 * dkCutout — AI upscaler worker (keeps the page smooth while the AI runs)
 * Author: direk james
 */
import { ORT_BASE } from "./models.js";

let ort = null, session = null, inputName = "", outputName = "";
let model = null, backend = "";

const CACHE = "dkcutout-upscale-models-v1";

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Download one file with progress. */
async function download(url, onProgress) {
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
    if (total) onProgress(Math.min(1, got / total));
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return bytes;
}

/**
 * Get the model bytes: from the browser cache when we have them, otherwise
 * from the first host that works. Every file must match its SHA-256, so a
 * broken download or a changed file is never run.
 */
async function fetchModel(m, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* private mode: just download */ }
  const key = `https://dkcutout.local/models/${m.id}.onnx`; // same key whatever host it came from

  const hit = cache && (await cache.match(key));
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    const want = hit.headers.get("x-sha256");
    if (m.urls.some((u) => u.sha256 === want) && (await sha256(bytes)) === want) return bytes;
    await cache.delete(key); // damaged or outdated: fetch it again
  }

  let lastErr = null;
  for (const { url, sha256: want } of m.urls) {
    try {
      const bytes = await download(url, onProgress);
      if ((await sha256(bytes)) !== want) throw new Error("The upscaler model download was damaged. Please try again.");
      try {
        await cache?.put(key, new Response(bytes, {
          headers: { "content-type": "application/octet-stream", "x-sha256": want },
        }));
      } catch { /* storage full: still works, just downloads again next time */ }
      return bytes;
    } catch (e) { lastErr = e; }
  }
  throw lastErr?.message?.startsWith("The upscaler") ? lastErr
    : new Error("Could not download the AI upscaler. Check your connection and try again.");
}

async function createSession(bytes, ep) {
  session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: "all" });
  inputName = session.inputNames[0];
  outputName = session.outputNames[0];
  backend = ep;
}

let modelBytes = null;

async function init({ model: m, gpu }) {
  model = m;
  try {
    ort ??= await import(`${ORT_BASE}ort.webgpu.min.mjs`);
  } catch {
    throw new Error("Could not load the AI engine. Check your connection and try again.");
  }
  ort.env.wasm.wasmPaths = ORT_BASE;
  modelBytes = await fetchModel(m, (p) => postMessage({ type: "download", fraction: p }));

  const tries = gpu ? ["webgpu", "wasm"] : ["wasm"];
  let lastErr = null;
  for (const ep of tries) {
    if (ep === "wasm" && m.needsGpu) break;
    try {
      await createSession(modelBytes, ep);
      // Only Fast on WebGPU may need the bytes again (to switch to the CPU); free them otherwise.
      if (m.needsGpu || ep === "wasm") modelBytes = null;
      return { backend, tile: m.tile[backend] };
    } catch (e) { lastErr = e; console.warn(`dkCutout: ${ep} failed`, e); }
  }
  if (m.needsGpu) throw new Error(`${m.label} needs a browser with graphics acceleration (WebGPU). Use Fast instead.`);
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
  const tensor = new ort.Tensor("float32", input, [1, 3, height, width]);
  let results;
  try {
    results = await session.run({ [inputName]: tensor });
  } catch (e) {
    // Some graphics chips start fine and then fail on the first real run.
    // Switch to the CPU once and carry on, unless this model needs the GPU.
    if (backend !== "webgpu" || model.needsGpu) throw e;
    console.warn("dkCutout: WebGPU run failed, switching to CPU", e);
    await session.release?.();
    await createSession(modelBytes, "wasm");
    modelBytes = null;
    results = await session.run({ [inputName]: tensor });
  }
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
