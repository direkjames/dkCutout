/*
 * dkCutout — AI upscaler model list
 * Author: direk james
 *
 * Both models are Real-ESRGAN (BSD-3-Clause) exported to ONNX and run in the
 * browser with onnxruntime-web. They are downloaded once, then cached.
 *
 * `url` must point at a CORS-enabled .onnx file that takes a float32 NCHW RGB
 * image in 0..1 and returns the same layout at 4x size. While `url` is null the
 * option is shown as "coming soon" and the app uses Classic resizing only.
 */
export const ORT_VERSION = "1.20.1";
export const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

export const MODELS = {
  fast: { label: "Fast", detail: "≈5 MB · quick on phones", native: 4, url: null },
  best: { label: "Best", detail: "≈33 MB · sharpest detail", native: 4, url: null },
};
