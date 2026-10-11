/*
 * dkCutout — free, in-browser background remover
 * Author: direk james
 *
 * How it works:
 *  1. The photo is drawn to a canvas at its full original resolution
 *     (with phone EXIF rotation applied).
 *  2. The AI model (run locally via @imgly/background-removal) produces a
 *     cut-out MASK — it works at a smaller internal size.
 *  3. We scale that mask up to the original size and use it as the alpha
 *     channel of the ORIGINAL pixels, so the download keeps every pixel
 *     and the exact original dimensions.
 */

import * as BG from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";

const removeBackground = BG.removeBackground ?? BG.default;

const $ = (id) => document.getElementById(id);
const els = {
  hero: $("hero"), drop: $("drop"), file: $("file"), model: $("model"),
  work: $("work"), status: $("status"), statusText: $("statusText"), fill: $("fill"),
  compare: $("compare"), originalImg: $("originalImg"), resultImg: $("resultImg"),
  beforeLayer: $("beforeLayer"), handle: $("handle"),
  actions: $("actions"), meta: $("meta"), again: $("again"), download: $("download"),
};

let resultUrl = null;
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
els.download.addEventListener("click", () => {
  if (!resultUrl) return;
  const a = document.createElement("a");
  a.href = resultUrl;
  a.download = downloadName;
  a.click();
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
  els.compare.classList.add("hidden");
  els.actions.classList.add("hidden");

  try {
    setStatus("Reading image…", null);
    const original = await loadOriginal(file);

    setStatus("Loading AI model (first time takes a moment, then it's cached)…", null);
    const maskBlob = await getMask(original.blob);

    setStatus("Applying cut-out at full resolution…", null);
    const outBlob = await applyMask(original.canvas, maskBlob);

    resultUrl = URL.createObjectURL(outBlob);
    originalUrl = URL.createObjectURL(original.blob);
    els.originalImg.src = originalUrl;
    els.resultImg.src = resultUrl;

    els.meta.textContent =
      `${original.canvas.width} × ${original.canvas.height}px · PNG · ${formatBytes(outBlob.size)}`;
    els.status.classList.add("hidden");
    els.compare.classList.remove("hidden");
    els.actions.classList.remove("hidden");
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
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
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

/** Scale the mask to the original size and use it as the alpha channel. */
async function applyMask(originalCanvas, maskBlob) {
  const w = originalCanvas.width;
  const h = originalCanvas.height;

  const maskBmp = await createImageBitmap(maskBlob);
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext("2d");
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(maskBmp, 0, 0, w, h);
  maskBmp.close?.();

  const octx = originalCanvas.getContext("2d");
  const img = octx.getImageData(0, 0, w, h);
  const m = mctx.getImageData(0, 0, w, h).data;
  const d = img.data;

  // Works whether the mask stores the cut-out in its brightness or its alpha.
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = Math.min(d[i + 3], m[i], m[i + 3]);
  }

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").putImageData(img, 0, 0);
  return canvasToBlob(out);
}

/* ---------- before/after slider ---------- */

function setSlider(pct) {
  pct = Math.max(0, Math.min(100, pct));
  els.beforeLayer.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  els.handle.style.left = pct + "%";
}

let dragging = false;
els.compare.addEventListener("pointerdown", (e) => {
  dragging = true;
  els.compare.setPointerCapture(e.pointerId);
  moveSlider(e);
});
els.compare.addEventListener("pointermove", (e) => dragging && moveSlider(e));
els.compare.addEventListener("pointerup", () => (dragging = false));
els.compare.addEventListener("pointercancel", () => (dragging = false));

function moveSlider(e) {
  const r = els.compare.getBoundingClientRect();
  setSlider(((e.clientX - r.left) / r.width) * 100);
}

/* ---------- helpers ---------- */

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

function formatBytes(n) {
  return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}

function cleanupUrls() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  resultUrl = originalUrl = null;
}

function reset() {
  if (busy) return;
  cleanupUrls();
  els.work.classList.add("hidden");
  els.hero.classList.remove("hidden");
}
