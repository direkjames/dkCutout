/*
 * dkCutout — AI upscaler model list
 * Author: direk james
 *
 * Both models are Real-ESRGAN by Xintao Wang et al. (BSD-3-Clause), exported
 * to ONNX and run in the browser with onnxruntime-web. They are downloaded
 * once, then cached.
 *
 * Every file takes a float32 NCHW RGB image in 0..1 and returns the same
 * layout at 4x size. Each URL is pinned to a commit, so the file can never
 * change under us. The weights in every file were checked against the
 * official Real-ESRGAN release (.pth) before they were added here.
 * The download is checked against its SHA-256, so a changed or broken file is
 * never run. If the first host is down, the next one is tried.
 */
export const ORT_VERSION = "1.20.1";
export const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

const HF = "https://huggingface.co/";

export const MODELS = {
  // realesr-general-x4v3: the small "compact" Real-ESRGAN model (≈1.2M parameters).
  fast: {
    id: "realesr-general-x4v3",
    label: "Fast",
    size: "5 MB",
    native: 4,
    // Biggest tile per backend. It is cheap, so tiles can be large.
    tile: { webgpu: 256, wasm: 128 },
    needsGpu: false,
    urls: [
      {
        url: HF + "CoderViking/realesr-general-x4v3-onnx/resolve/c6a971706797c7502945a2b4c4274fce4900d4ab/realesr-general-x4v3.onnx",
        sha256: "1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112",
      },
      {
        url: HF + "Saimon8420/realesr-general-x4v3-web/resolve/a09f86b0a5f8e3c2f2c9a0e40a65564bfc9214c1/realesr-general-x4v3.onnx",
        sha256: "09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4",
      },
    ],
  },
  // RealESRGAN_x4plus: the full model (≈16.7M parameters), sharpest detail.
  best: {
    id: "RealESRGAN_x4plus",
    label: "Best",
    size: "67 MB",
    native: 4,
    // Its last layers run at 4x size with 64 channels, so tiles stay small to
    // keep graphics memory well under 1 GB (phones included).
    tile: { webgpu: 160, wasm: 96 },
    // Without a graphics chip it is roughly 15x slower than Fast: too slow to offer.
    needsGpu: true,
    urls: [
      {
        url: HF + "liangmu261004/real-esrgan-onnx/resolve/633fd2a123b24a99c0b1e146340fa26e0d6ed8e2/RealESRGAN_x4plus.onnx",
        sha256: "3767c17388381cfca3d7196a4a517737fefc22b57c9fd98d3bae78e98e2bebc9",
      },
      {
        url: HF + "SceneWorks/real-esrgan-onnx/resolve/09f741bac80a246b407da3ee902bf5f3291b602f/real_esrgan_x4.onnx",
        sha256: "5c586662929cbc686c1a5c38d9c060dbdb4ea5863a1f7672b8c0761e6b89c033",
      },
    ],
  },
};
