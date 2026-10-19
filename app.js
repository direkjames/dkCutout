/*
 * dkCutout — free, in-browser background remover
 * Author: direk james
 *
 * How it works:
 *  1. The photo is drawn to a canvas at its full original resolution
 *     (with phone EXIF rotation applied).
 *  2. The AI model (run locally via @imgly/background-removal) produces a
 *     cut-out MASK: how sure it is that each pixel is the subject (0–255).
 *  3. The mask is cleaned up:
 *       - "Solidity" pushes unsure-but-probably-subject pixels to fully solid,
 *         so faded clothing/skin comes back while edges stay soft.
 *       - Small transparent holes fully surrounded by the subject are filled.
 *       - The user's Restore/Erase brush strokes are added on top.
 *  4. The final mask becomes the alpha channel of the ORIGINAL pixels, so the
 *     download keeps every pixel and the exact original size.
 */

import * as BG from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";

import { upscaleImage, stopWorker, hasWebGPU, AbortError } from "./upscale/engine.js";
import { MODELS } from "./upscale/models.js";
import { allowedScales, checkScale, formatSize, formatEta } from "./upscale/limits.js";

const removeBackground = BG.removeBackground ?? BG.default;

const $ = (id) => document.getElementById(id);
const els = {
  hero: $("hero"), drop: $("drop"), file: $("file"), model: $("model"),
  work: $("work"), status: $("status"), statusText: $("statusText"), fill: $("fill"),
  toolbar: $("toolbar"), modes: $("modes"), brushTools: $("brushTools"),
  brushSize: $("brushSize"), undo: $("undo"), resetEdits: $("resetEdits"),
  compare: $("compare"), originalImg: $("originalImg"), ghostImg: $("ghostImg"),
  resultCanvas: $("resultCanvas"), upView: $("upView"), tagR: $("tagR"), beforeLayer: $("beforeLayer"), handle: $("handle"),
  brushCursor: $("brushCursor"),
  tune: $("tune"), solidity: $("solidity"), solidityVal: $("solidityVal"), fillHoles: $("fillHoles"),
  actions: $("actions"), meta: $("meta"), again: $("again"), download: $("download"),
  task: $("task"), qualityLabel: $("qualityLabel"),
  upscale: $("upscale"), upSub: $("upSub"), scaleChips: $("scaleChips"), upEngine: $("upEngine"),
  upSize: $("upSize"), upProgress: $("upProgress"), upStatus: $("upStatus"), upFill: $("upFill"),
  upGo: $("upGo"), upCancel: $("upCancel"), upUndo: $("upUndo"), upNote: $("upNote"),
};

const HOLE_MAX_FRACTION = 0.015; // holes up to 1.5% of the image get filled

/* ---------- state for the current image ---------- */
let W = 0, H = 0;
let origPixels = null;   // Uint8ClampedArray RGBA of the original
let rawAlpha = null;     // Uint8Array mask straight from the AI
let baseAlpha = null;    // rawAlpha after solidity + hole filling
let outImage = null;     // ImageData shown in resultCanvas / downloaded
let resultCtx = null;
let restoreCanvas = null, restoreCtx = null; // brush layers (full resolution)
let eraseCanvas = null, eraseCtx = null;
let strokes = [];        // for undo
let mode = "compare";
let originalUrl = null;
let downloadName = "image-nobg.png";
let busy = false;
let upscaleOnly = false;   // "Upscale only" task: no background removal
let upscaled = null;       // canvas with the upscaled result, or null
let upscaledScale = 1;
let upscaleScale = 4;      // scale chosen in the panel
let upscaleAbort = null;   // AbortController while an upscale is running

/* ---------- input: click, drag & drop, paste ---------- */

els.file.addEventListener("change", () => {
  if (els.file.files[0]) handleFile(els.file.files[0]);
  els.file.value = "";
});
["dragenter", "dragover"].forEach((t) =>
  els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add("over"); })
);
["dragleave", "drop"].forEach((t) =>
  els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.remove("over"); })
);
els.drop.addEventListener("drop", (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) handleFile(f);
});
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) handleFile(item.getAsFile());
});

els.again.addEventListener("click", reset);

/* ---------- help popup ---------- */
const help = $("help");
$("helpBtn").addEventListener("click", () => help.showModal());
$("helpClose").addEventListener("click", () => help.close());
help.addEventListener("click", (e) => { // click outside the box to close
  const r = help.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) help.close();
});
els.download.addEventListener("click", async () => {
  if (!outImage) return;
  els.download.disabled = true;
  let blob;
  try {
    blob = await canvasToBlob(upscaled || els.resultCanvas);
  } catch (err) {
    alert(err?.message || "Could not save the image.");
    return;
  } finally {
    els.download.disabled = false;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = upscaled ? downloadName.replace(/\.png$/, `-${upscaledScale}x.png`) : downloadName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

/* ---------- main flow ---------- */

async function handleFile(file) {
  if (busy) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    alert("Please use a PNG, JPG or WEBP image.");
    return;
  }
  busy = true;
  cleanupUrls();
  upscaleOnly = els.task.value === "upscale";
  downloadName = (file.name || "image").replace(/\.[^.]+$/, "") + (upscaleOnly ? "-upscaled.png" : "-nobg.png");
  clearUpscale();

  els.hero.classList.add("hidden");
  els.work.classList.remove("hidden");
  els.status.classList.remove("hidden");
  [els.compare, els.actions, els.toolbar, els.tune, els.upscale].forEach((e) => e.classList.add("hidden"));

  try {
    setStatus("Reading image…", null);
    const original = await loadOriginal(file);

    let maskBlob = null;
    if (!upscaleOnly) {
      setStatus("Loading AI model (first time takes a moment, then it's cached)…", null);
      maskBlob = await getMask(original.blob);
    }

    setStatus("Applying cut-out at full resolution…", null);
    await setupEditor(original.canvas, maskBlob);

    originalUrl = URL.createObjectURL(original.blob);
    els.originalImg.src = originalUrl;
    els.ghostImg.src = originalUrl;
    els.status.classList.add("hidden");
    const shown = upscaleOnly ? [els.compare, els.actions, els.upscale] : [els.compare, els.actions, els.toolbar, els.tune, els.upscale];
    shown.forEach((e) => e.classList.remove("hidden"));
    setupUpscalePanel();
    updateMeta();
    setMode("compare");
    layout();
    setSlider(50);
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong: " + (err?.message || err) + " — try another image or the Fast model.", 0);
    els.actions.classList.remove("hidden");
    els.meta.textContent = "";
    W = H = 0;
  } finally {
    busy = false;
  }
}

/** Draw the file onto a canvas at full size, applying EXIF rotation. */
async function loadOriginal(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = makeCanvas(bmp.width, bmp.height);
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await canvasToBlob(canvas);
  return { canvas, blob };
}

/** Run the AI locally and get a mask. Tries the GPU first, falls back to CPU. */
async function getMask(imageBlob) {
  const base = {
    model: els.model.value,
    output: { type: "mask", format: "image/png" },
    progress: (key, current, total) => {
      if (String(key).startsWith("fetch") && total) {
        setStatus(`Downloading AI model… ${Math.round((current / total) * 100)}%`, current / total);
      } else if (String(key).includes("compute")) {
        setStatus("Removing background…", null);
      }
    },
  };
  if ("gpu" in navigator) {
    try {
      return await removeBackground(imageBlob, { ...base, device: "gpu" });
    } catch (e) {
      console.warn("GPU failed, falling back to CPU:", e);
    }
  }
  return await removeBackground(imageBlob, { ...base, device: "cpu" });
}

/** Prepare all the full-resolution buffers and draw the first result. */
async function setupEditor(originalCanvas, maskBlob) { // maskBlob is null for "Upscale only"
  W = originalCanvas.width;
  H = originalCanvas.height;
  origPixels = originalCanvas.getContext("2d").getImageData(0, 0, W, H).data;

  rawAlpha = new Uint8Array(W * H);
  if (!maskBlob) {
    rawAlpha.fill(255); // keep everything
  } else {
    // The library's mask is white with the cut-out stored in the alpha channel.
    const maskBmp = await createImageBitmap(maskBlob);
    const maskCanvas = makeCanvas(W, H);
    const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    mctx.drawImage(maskBmp, 0, 0, W, H);
    maskBmp.close?.();
    const m = mctx.getImageData(0, 0, W, H).data;
    for (let i = 0, j = 3; i < rawAlpha.length; i++, j += 4) rawAlpha[i] = m[j];
  }

  els.resultCanvas.width = W;
  els.resultCanvas.height = H;
  resultCtx = els.resultCanvas.getContext("2d");
  outImage = new ImageData(W, H);

  restoreCanvas = makeCanvas(W, H);
  restoreCtx = restoreCanvas.getContext("2d", { willReadFrequently: true });
  eraseCanvas = makeCanvas(W, H);
  eraseCtx = eraseCanvas.getContext("2d", { willReadFrequently: true });
  strokes = [];

  rebuildBase();
}

/* ---------- mask cleanup ---------- */

els.solidity.addEventListener("input", () => {
  els.solidityVal.textContent = els.solidity.value;
  scheduleRebuild();
});
els.fillHoles.addEventListener("change", scheduleRebuild);

let rebuildQueued = false;
function scheduleRebuild() {
  if (rebuildQueued || !rawAlpha) return;
  rebuildQueued = true;
  requestAnimationFrame(() => { rebuildQueued = false; rebuildBase(); });
}

/** Apply solidity + hole filling to the raw mask, then redraw everything. */
function rebuildBase() {
  const s = Number(els.solidity.value); // 0 = AI's mask as-is, 100 = almost hard cut
  const lo = s * 1.0;                   // below this → fully transparent
  const hi = 255 - s * 1.45;            // above this → fully solid
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = v <= lo ? 0 : v >= hi ? 255 : Math.round(((v - lo) / (hi - lo)) * 255);
  }
  baseAlpha = new Uint8Array(rawAlpha.length);
  for (let i = 0; i < rawAlpha.length; i++) baseAlpha[i] = lut[rawAlpha[i]];

  if (els.fillHoles.checked) fillSmallHoles(baseAlpha);
  renderRegion(0, 0, W, H);
}

/**
 * Transparent areas that can't be reached from the image border are holes
 * inside the subject. Fill the small ones (big ones, like the gap between an
 * arm and the body, are usually real background and are left alone).
 */
function fillSmallHoles(alpha) {
  const N = W * H;
  const visited = new Uint8Array(N);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  const push = (i) => {
    if (!visited[i] && alpha[i] < 128) { visited[i] = 1; q[tail++] = i; }
  };
  const flood = () => {
    while (head < tail) {
      const i = q[head++];
      const x = i % W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < N - W) push(i + W);
    }
  };

  // 1) everything connected to the border is real background
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  flood();

  // 2) whatever transparent area is left is enclosed: fill it if it's small
  const maxHole = N * HOLE_MAX_FRACTION;
  for (let i = 0; i < N; i++) {
    if (visited[i] || alpha[i] >= 128) continue;
    head = tail = 0;
    push(i);
    flood();
    if (tail <= maxHole) for (let k = 0; k < tail; k++) alpha[q[k]] = 255;
  }
}

/** Combine original pixels + cleaned mask + brush layers for one rectangle. */
function renderRegion(x, y, w, h) {
  if (upscaled) {
    clearUpscale(); // the picture changed, so the old upscale no longer matches
    setupUpscalePanel();
    updateMeta();
    els.upNote.textContent = "You changed the cut-out, so the upscale was reset. Upscale again when you're happy.";
  }
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.min(W - x, Math.ceil(w)); h = Math.min(H - y, Math.ceil(h));
  if (w <= 0 || h <= 0) return;

  const R = restoreCtx.getImageData(x, y, w, h).data;
  const E = eraseCtx.getImageData(x, y, w, h).data;
  const out = outImage.data;

  for (let row = 0; row < h; row++) {
    let p = (y + row) * W + x; // pixel index in full image
    let j = row * w * 4 + 3;   // alpha index in the region
    for (let col = 0; col < w; col++, p++, j += 4) {
      let a = baseAlpha[p] + R[j] - E[j];
      a = a < 0 ? 0 : a > 255 ? 255 : a;
      const o = p * 4;
      out[o] = origPixels[o];
      out[o + 1] = origPixels[o + 1];
      out[o + 2] = origPixels[o + 2];
      out[o + 3] = Math.min(a, origPixels[o + 3]);
    }
  }
  resultCtx.putImageData(outImage, 0, 0, x, y, w, h);
}

/* ---------- modes: compare slider vs. brushes ---------- */

els.modes.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (b) setMode(b.dataset.mode);
});

function setMode(m) {
  mode = m;
  [...els.modes.children].forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  const painting = m !== "compare";
  els.compare.classList.toggle("painting", painting);
  els.brushTools.classList.toggle("hidden", !painting);
  els.brushCursor.classList.toggle("erase", m === "erase");
  if (!painting) els.brushCursor.classList.add("hidden");
}

/** Size the stage to the photo's shape so screen ↔ image mapping is exact. */
function layout() {
  if (!W) return;
  const maxW = els.work.clientWidth;
  const maxH = window.innerHeight * 0.68;
  const scale = Math.min(maxW / W, maxH / H);
  els.compare.style.width = Math.round(W * scale) + "px";
  els.compare.style.height = Math.round(H * scale) + "px";
  drawUpView();
}
window.addEventListener("resize", layout);

/* ---------- pointer handling ---------- */

let dragging = false;
let currentStroke = null;

els.compare.addEventListener("pointerdown", (e) => {
  els.compare.setPointerCapture(e.pointerId);
  dragging = true;
  if (mode === "compare") {
    moveSlider(e);
  } else {
    const p = toImage(e);
    currentStroke = { mode, r: brushRadiusImage(), pts: [p] };
    paintSegment(currentStroke, p, p);
  }
});

els.compare.addEventListener("pointermove", (e) => {
  if (mode !== "compare") moveCursor(e);
  if (!dragging) return;
  if (mode === "compare") {
    moveSlider(e);
  } else if (currentStroke) {
    const p = toImage(e);
    const prev = currentStroke.pts[currentStroke.pts.length - 1];
    currentStroke.pts.push(p);
    paintSegment(currentStroke, prev, p);
  }
});

const endPointer = () => {
  dragging = false;
  if (currentStroke) { strokes.push(currentStroke); currentStroke = null; }
};
els.compare.addEventListener("pointerup", endPointer);
els.compare.addEventListener("pointercancel", endPointer);
els.compare.addEventListener("pointerleave", () => els.brushCursor.classList.add("hidden"));

function toImage(e) {
  const r = els.compare.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}
function brushRadiusImage() {
  const r = els.compare.getBoundingClientRect();
  return Number(els.brushSize.value) * (W / r.width);
}
function moveCursor(e) {
  const r = els.compare.getBoundingClientRect();
  const d = Number(els.brushSize.value) * 2;
  Object.assign(els.brushCursor.style, {
    left: e.clientX - r.left + "px", top: e.clientY - r.top + "px", width: d + "px", height: d + "px",
  });
  els.brushCursor.classList.remove("hidden");
}

/* ---------- brushes ---------- */

/** Paint soft dabs from a to b. Restore also wipes erase there, and vice versa. */
function paintSegment(stroke, a, b, deferRender = false) {
  const target = stroke.mode === "restore" ? restoreCtx : eraseCtx;
  const other = stroke.mode === "restore" ? eraseCtx : restoreCtx;
  const r = stroke.r;
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / (r * 0.25)));
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    dab(target, x, y, r, "source-over");
    dab(other, x, y, r, "destination-out");
  }
  if (!deferRender) {
    queueDirty(Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r,
               Math.abs(b.x - a.x) + 2 * r, Math.abs(b.y - a.y) + 2 * r);
  }
}

function dab(ctx, x, y, r, op) {
  const g = ctx.createRadialGradient(x, y, r * 0.55, x, y, r);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = op;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

let dirty = null;
function queueDirty(x, y, w, h) {
  if (!dirty) {
    dirty = { x1: x, y1: y, x2: x + w, y2: y + h };
    requestAnimationFrame(() => {
      const d = dirty; dirty = null;
      renderRegion(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
    });
  } else {
    dirty.x1 = Math.min(dirty.x1, x); dirty.y1 = Math.min(dirty.y1, y);
    dirty.x2 = Math.max(dirty.x2, x + w); dirty.y2 = Math.max(dirty.y2, y + h);
  }
}

els.undo.addEventListener("click", () => {
  if (!strokes.length) return;
  strokes.pop();
  replayStrokes();
});
els.resetEdits.addEventListener("click", () => {
  strokes = [];
  replayStrokes();
});

function replayStrokes() {
  restoreCtx.clearRect(0, 0, W, H);
  eraseCtx.clearRect(0, 0, W, H);
  for (const s of strokes) {
    for (let i = 0; i < s.pts.length; i++) {
      paintSegment(s, s.pts[Math.max(0, i - 1)], s.pts[i], true);
    }
  }
  renderRegion(0, 0, W, H);
}

/* ---------- before/after slider ---------- */

function setSlider(pct) {
  pct = Math.max(0, Math.min(100, pct));
  els.beforeLayer.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  els.handle.style.left = pct + "%";
}
function moveSlider(e) {
  const r = els.compare.getBoundingClientRect();
  setSlider(((e.clientX - r.left) / r.width) * 100);
}

/* ---------- helpers ---------- */

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function setStatus(text, fraction) {
  els.statusText.textContent = text;
  if (fraction == null) {
    els.fill.classList.add("indeterminate");
    els.fill.style.width = "";
  } else {
    els.fill.classList.remove("indeterminate");
    els.fill.style.width = Math.round(fraction * 100) + "%";
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image is too large for this browser."))), "image/png")
  );
}

function cleanupUrls() {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  originalUrl = null;
}

function reset() {
  if (busy) return;
  upscaleAbort?.abort();
  stopWorker();
  clearUpscale();
  cleanupUrls();
  W = H = 0;
  origPixels = rawAlpha = baseAlpha = outImage = null;
  restoreCanvas = eraseCanvas = restoreCtx = eraseCtx = null;
  strokes = [];
  els.work.classList.add("hidden");
  els.hero.classList.remove("hidden");
}

/* ---------- upscaling ---------- */

function clearUpscale() {
  if (upscaled) upscaled.width = upscaled.height = 0; // free memory right away
  upscaled = null;
  upscaledScale = 1;
  drawUpView();
}

/**
 * Show the upscaled result on the "After" side, so the extra detail is visible.
 * Only a screen-sized copy is drawn, never a second full-size picture.
 */
function drawUpView() {
  const v = els.upView;
  if (!upscaled) {
    v.classList.add("hidden");
    v.width = v.height = 0;
    els.tagR.textContent = "After";
    return;
  }
  const box = els.compare.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const s = Math.min(1, (box.width * dpr) / upscaled.width);
  v.width = Math.max(1, Math.round(upscaled.width * s));
  v.height = Math.max(1, Math.round(upscaled.height * s));
  const ctx = v.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(upscaled, 0, 0, v.width, v.height);
  v.classList.remove("hidden");
  els.tagR.textContent = `After · ${upscaledScale}×`;
}

function updateMeta() {
  const kind = upscaleOnly ? "PNG" : "transparent PNG";
  els.meta.textContent = upscaled
    ? `${formatSize(upscaled.width, upscaled.height)} · ${upscaledScale}× upscaled · ${kind}`
    : `${formatSize(W, H)} · ${kind}`;
}

const ENGINE_KEY = "dkcutout.upscaleEngine";

/** Fill in the engine list once: download sizes, and Best only where a graphics chip can run it. */
async function setupEngines() {
  const gpu = await hasWebGPU();
  for (const o of els.upEngine.options) {
    const m = MODELS[o.value];
    if (!m) continue;
    const off = m.needsGpu && !gpu;
    o.disabled = off;
    o.textContent = off
      ? `${m.label} — AI, needs a GPU browser (not available here)`
      : `${m.label} — AI, ${o.value === "best" ? "sharpest detail" : "quicker"} · ${m.size} download, once`;
  }
  let saved = null;
  try { saved = localStorage.getItem(ENGINE_KEY); } catch { /* storage blocked */ }
  const pick = [saved, gpu ? "best" : "fast", "classic"]
    .find((v) => v && [...els.upEngine.options].some((o) => o.value === v && !o.disabled));
  if (!upscaleAbort) els.upEngine.value = pick;
}
setupEngines();

els.upEngine.addEventListener("change", () => {
  try { localStorage.setItem(ENGINE_KEY, els.upEngine.value); } catch { /* storage blocked */ }
});

/** Build the scale chips and engine list for the current image. */
function setupUpscalePanel() {
  els.upNote.textContent = "";
  els.upProgress.classList.add("hidden");
  els.upGo.classList.remove("hidden");
  els.upCancel.classList.add("hidden");
  els.upUndo.classList.toggle("hidden", !upscaled);
  els.upGo.textContent = upscaled ? "Upscale again" : "Upscale";
  els.upSub.textContent = upscaleOnly
    ? "Make your photo bigger and sharper."
    : "Make the finished cut-out bigger and sharper.";


  const ok = allowedScales(W, H);
  els.scaleChips.replaceChildren();
  for (const s of [2, 4]) {
    const b = document.createElement("button");
    b.textContent = `${s}×`;
    b.dataset.scale = s;
    b.disabled = !ok.includes(s);
    b.title = b.disabled ? "Too big for this device" : "";
    els.scaleChips.append(b);
  }
  if (!ok.length) {
    els.upGo.disabled = true;
    els.upSize.textContent = "This image is already too large to upscale on this device.";
    return;
  }
  els.upGo.disabled = false;
  upscaleScale = ok.includes(upscaleScale) ? upscaleScale : ok[ok.length - 1];
  selectScale(upscaleScale);
}

function selectScale(s) {
  upscaleScale = s;
  [...els.scaleChips.children].forEach((b) => b.classList.toggle("on", Number(b.dataset.scale) === s));
  const r = checkScale(W, H, s);
  els.upSize.innerHTML = `${formatSize(W, H)} → <b>${formatSize(r.width, r.height)}</b>`;
}

els.scaleChips.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scale]");
  if (b && !b.disabled && !upscaleAbort) selectScale(Number(b.dataset.scale));
});

els.upUndo.addEventListener("click", () => {
  if (upscaleAbort) return;
  clearUpscale();
  setupUpscalePanel();
  updateMeta();
});

els.upCancel.addEventListener("click", () => {
  upscaleAbort?.abort();
  els.upCancel.disabled = true;
  els.upStatus.textContent = "Cancelling…";
});

els.upGo.addEventListener("click", async () => {
  if (!outImage || upscaleAbort || busy) return;
  const scale = upscaleScale;
  if (!checkScale(W, H, scale).ok) return;

  const engine = els.upEngine.value;
  upscaleAbort = new AbortController();
  busy = true;
  els.upNote.textContent = "";
  els.upGo.classList.add("hidden");
  els.upUndo.classList.add("hidden");
  els.upCancel.classList.toggle("hidden", engine === "classic");
  els.upCancel.disabled = false;
  els.upProgress.classList.remove("hidden");
  els.download.disabled = true;
  els.again.disabled = true;
  els.upEngine.disabled = true;
  els.work.classList.add("working");

  const setUp = (text, fraction, etaMs) => {
    els.upStatus.textContent = etaMs != null ? `${text} · ${formatEta(etaMs)} left` : text;
    if (fraction == null) {
      els.upFill.classList.add("indeterminate");
      els.upFill.style.width = "";
    } else {
      els.upFill.classList.remove("indeterminate");
      els.upFill.style.width = Math.round(fraction * 100) + "%";
    }
  };

  try {
    const canvas = await upscaleImage({
      rgba: outImage.data, w: W, h: H, engine, scale,
      onStatus: setUp, signal: upscaleAbort.signal,
    });
    clearUpscale();
    upscaled = canvas;
    upscaledScale = scale;
    drawUpView();
    els.upNote.textContent = `Done. Your download is now ${formatSize(canvas.width, canvas.height)}.`;
  } catch (err) {
    if (err instanceof AbortError) {
      els.upNote.textContent = "Upscale cancelled.";
    } else {
      console.error(err);
      els.upNote.textContent = "Couldn't upscale: " + (err?.message || err) +
        (err instanceof RangeError || /memory|allocation/i.test(String(err?.message))
          ? " Try 2× or the Classic engine." : "");
    }
  } finally {
    upscaleAbort = null;
    busy = false;
    els.download.disabled = false;
    els.again.disabled = false;
    els.upEngine.disabled = false;
    els.work.classList.remove("working");
    const note = els.upNote.textContent;
    setupUpscalePanel();
    els.upNote.textContent = note;
    updateMeta();
  }
});

els.task.addEventListener("change", () => {
  els.qualityLabel.classList.toggle("hidden", els.task.value === "upscale");
});
