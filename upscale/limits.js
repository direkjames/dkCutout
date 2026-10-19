/*
 * dkCutout — how big can the upscaled picture be?
 * Author: direk james
 *
 * Browsers refuse (or crash on) canvases that are too large, and iPhones are
 * the strictest. We stay safely under each limit and tell the user up front.
 */

const MAX_SIDE = 16384;
const MAX_PIXELS_DESKTOP = 48 * 1024 * 1024; // ≈192 MB of RGBA
const MAX_PIXELS_SAFARI = 16 * 1024 * 1024;  // iOS/Safari canvas limit is ≈16.7 MP

export function isSafari() {
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua));
}

export function maxOutputPixels() {
  return isSafari() ? MAX_PIXELS_SAFARI : MAX_PIXELS_DESKTOP;
}

/** Can a w x h image be upscaled by `scale`? */
export function checkScale(w, h, scale) {
  const ow = w * scale, oh = h * scale;
  const ok = ow <= MAX_SIDE && oh <= MAX_SIDE && ow * oh <= maxOutputPixels();
  return { ok, width: ow, height: oh };
}

/** The scales (2, 4) that fit for this image. */
export function allowedScales(w, h) {
  return [2, 4].filter((s) => checkScale(w, h, s).ok);
}

export function formatSize(w, h) {
  return `${w.toLocaleString("en-US")} × ${h.toLocaleString("en-US")}px`;
}

export function formatEta(ms) {
  if (!isFinite(ms) || ms < 1500) return "a few seconds";
  const s = Math.round(ms / 1000);
  return s < 90 ? `about ${s}s` : `about ${Math.round(s / 60)} min`;
}
