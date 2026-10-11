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

const removeBackground = BG.removeBackground ?? BG.default;

const $ = (id) => document.getElementById(id);
const els = {
  hero: $("hero"), drop: $("drop"), file: $("file"), model: $("model"),
  work: $("work"), status: $("status"), statusText: $("statusText"), fill: $("fill"),
  toolbar: $("toolbar"), modes: $("modes"), brushTools: $("brushTools"),
  brushSize: $("brushSize"), undo: $("undo"), resetEdits: $("resetEdits"),
  compare: $("compare"), originalImg: $("originalImg"), ghostImg: $("ghostImg"),
  resultCanvas: $("resultCanvas"), beforeLayer: $("beforeLayer"), handle: $("handle"),
  brushCursor: $("brushCursor"),
  tune: $("tune"), solidity: $("solidity"), solidityVal: $("solidityVal"), fillHoles: $("fillHoles"),
  actions: $("actions"), meta: $("meta"), again: $("again"), download: $("download"),
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
els.download.addEventListener("click", async () => {
  if (!outImage) return;
  const blob = await canvasToBlob(els.resultCanvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
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
  downloadName = (file.name || "image").replace(/\.[^.]+$/, "") + "-nobg.png";

  els.hero.classList.add("hidden");
  els.work.classList.remove("hidden");
  els.status.classList.remove("hidden");
  [els.compare, els.actions, els.toolbar, els.tune].forEach((e) => e.classList.add("hidden"));

  try {
    setStatus("Reading image…", null);
    const original = await loadOriginal(file);

    setStatus("Loading AI model (first time takes a moment, then it's cached)…", null);
    const maskBlob = await getMask(original.blob);

    setStatus("Applying cut-out at full resolution…", null);
    await setupEditor(original.canvas, maskBlob);

    originalUrl = URL.createObjectURL(original.blob);
    els.originalImg.src = originalUrl;
    els.ghostImg.src = originalUrl;
    els.meta.textContent = `${W} × ${H}px · transparent PNG`;

    els.status.classList.add("hidden");
    [els.compare, els.actions, els.toolbar, els.tune].forEach((e) => e.classList.remove("hidden"));
    setMode("compare");
    layout();
    setSlider(50);
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong: " + (err?.message || err) + " — try another image or the Fast model.", 0);
    els.actions.classList.remove("hidden");
    els.meta.textContent = "";
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
async function setupEditor(originalCanvas, maskBlob) {
  W = originalCanvas.width;
  H = originalCanvas.height;
  origPixels = originalCanvas.getContext("2d").getImageData(0, 0, W, H).data;

  // The library's mask is white with the cut-out stored in the alpha channel.
  const maskBmp = await createImageBitmap(maskBlob);
  const maskCanvas = makeCanvas(W, H);
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(maskBmp, 0, 0, W, H);
  maskBmp.close?.();
  const m = mctx.getImageData(0, 0, W, H).data;
  rawAlpha = new Uint8Array(W * H);
  for (let i = 0, j = 3; i < rawAlpha.length; i++, j += 4) rawAlpha[i] = m[j];

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
  cleanupUrls();
  W = H = 0;
  origPixels = rawAlpha = baseAlpha = outImage = null;
  restoreCanvas = eraseCanvas = restoreCtx = eraseCtx = null;
  strokes = [];
  els.work.classList.add("hidden");
  els.hero.classList.remove("hidden");
}
