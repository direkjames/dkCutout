# Developing WalangBackground

Notes for running, testing and publishing the project (the repository is called dkCutout). For what it does, see the [README](../README.md).

## Files

- `index.html`: the page and the help popup
- `style.css`: the look
- `app.js`: loads the photo, runs the AI mask, cleans it up (solidity, hole filling, brushes), runs the upscaler and exports the PNG
- `upscale/`: the upscaling code: `engine.js`, `worker.js` (background worker), `tiling.js`, `limits.js` (per-device size limits) and `models.js` (model files, SHA-256 checks and the backup host)
- `tests/`: Node tests
- `docs/screenshots/`: the README images

## Run it locally (VS Code)

ES modules don't load from `file://`, so open it through a local server:

1. Install the **Live Server** extension in VS Code.
2. Open this folder, right-click `index.html` and choose **Open with Live Server**.

## Tests

- `node tests/version.test.mjs` checks every local file uses the same `?v=`. Bump it on every release so browsers never mix old cached files with new ones.
- `node tests/tiling.test.mjs` checks that tiled upscaling matches a direct upscale exactly (no seams), cancelling, and bad input.

## Deploy for free (GitHub Pages)

1. Push this folder to a GitHub repo.
2. Repo, **Settings**, **Pages**, Source: *Deploy from a branch*, then `main` and `/ (root)`, then Save.
3. Your site will be live at `https://<username>.github.io/<repo>/`.

## License note

`@imgly/background-removal` is AGPL-3.0. Recheck what that means for this repo's license before changing it or adding paid features.
