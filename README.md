# dkCutout

**Author:** direk james

A free background remover that runs entirely in the visitor's browser. No server, no API keys, no uploads. Photos never leave the user's device.

## Features
- Drag & drop, click to choose, or paste (Ctrl+V) an image
- AI cut-out runs locally (WebGPU when available, CPU otherwise)
- Download is a transparent PNG at the **exact original size**
- Before/after comparison slider
- **Upscale 2× / 4×**, on the cut-out or on its own ("Upscale only"), with three engines:
  - **Best**: Real-ESRGAN x4plus (67 MB, downloaded once). Needs WebGPU (recent Chrome/Edge, Safari 26+); hidden where it would be far too slow
  - **Fast**: Real-ESRGAN general-x4v3 (5 MB, downloaded once). Uses the GPU when it can, otherwise the CPU
  - **Classic**: plain smooth resize, no download
- Models are checked against a SHA-256 before they run, saved in the browser cache, and fetched from a backup host if the first is down (`upscale/models.js`)
- Big photos are upscaled in small tiles in a background worker, with Cancel and per-device size limits
- Two quality modes: Best (~80 MB model) and Fast (~40 MB model), downloaded once and then cached

## Run it locally (VS Code)
ES modules don't load from `file://`, so open it through a local server:
1. Install the **Live Server** extension in VS Code.
2. Open this folder, right-click `index.html` → **Open with Live Server**.

## Deploy for free (GitHub Pages)
1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / root → Save.
3. Your site will be live at `https://<username>.github.io/<repo>/`.

## Credits
Upscaling uses [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) by Xintao Wang et al. (BSD-3-Clause), run with [ONNX Runtime Web](https://onnxruntime.ai/) (MIT).

## License
This project uses [`@imgly/background-removal`](https://github.com/imgly/background-removal-js), which is AGPL-3.0. Keep this repo public and licensed under AGPL-3.0 (on GitHub: **Add file → Create new file → name it `LICENSE` → Choose a license template → GNU AGPLv3**). Don't add paid features without rechecking the license.


## Tests
`node tests/tiling.test.mjs` checks that tiled upscaling matches a direct upscale exactly (no seams), cancelling, and bad input.
