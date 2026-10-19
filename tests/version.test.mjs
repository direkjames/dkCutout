// Run with: node tests/version.test.mjs
// Every local file is loaded with the same "?v=" so a browser never mixes an
// old cached file with new ones after a release. This checks none was missed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const html = read("index.html");
const v = html.match(/src="app\.js\?v=([\w.-]+)"/)?.[1];
assert.ok(v, "index.html must load app.js?v=…");

const refs = [
  ...html.matchAll(/(?:src|href)="(?!https?:|#|data:)([^"]+\.(?:js|css)[^"]*)"/g),
  ...["app.js", "upscale/engine.js", "upscale/worker.js", "upscale/tiling.js", "upscale/limits.js", "upscale/models.js"]
    .flatMap((f) => [...read(f).matchAll(/(?:from\s+|import\(|new URL\()\s*["'](\.{1,2}\/[^"']+)["']/g)]),
].map((m) => m[1]);

assert.ok(refs.length >= 8, "found the local imports");
for (const r of refs) assert.equal(r.split("?v=")[1], v, `${r} must end in ?v=${v}`);
console.log(`version: all ${refs.length} local files use ?v=${v}`);
