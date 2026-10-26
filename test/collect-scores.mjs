// Runs the *built* inference worker (dist/chrome/engine-worker.js) in Chrome over a folder of
// labelled photos and writes the raw scores, so thresholds are calibrated on exactly what the
// extension computes (same canvas resampling, same quantized models).
//
//   node test/collect-scores.mjs --images <dir with labels.json> --out scores.json
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const IMAGES = path.resolve(arg('images', ''));
const OUT = path.resolve(arg('out', 'scores.json'));
const WORKERS = Number(arg('workers', '3'));
const QUALITY = arg('quality', 'high');
const BROWSER = arg('browser', 'chrome');
const LIMIT = Number(arg('limit', '0'));
const MAX_SIDE = Number(arg('max-side', '0')); // simulate small thumbnails
const labels = JSON.parse(fs.readFileSync(path.join(IMAGES, 'labels.json'), 'utf8'));

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.html': 'text/html', '.jpg': 'image/jpeg', '.json': 'application/json' };
const MOUNTS = { '/ext/': path.join(ROOT, 'dist', 'chrome'), '/src/': path.join(ROOT, 'src'), '/img/': IMAGES };

const HARNESS = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { loadBitmap } from '/src/engine/image-loader.js';
const files = ${JSON.stringify(LIMIT ? Object.keys(labels).slice(0, LIMIT) : Object.keys(labels))};
const workers = [];
for (let i = 0; i < ${WORKERS}; i++) {
  const w = new Worker('/ext/engine-worker.js', { type: 'module' });
  w.pending = new Map();
  w.ready = new Promise((res, rej) => {
    w.onmessage = ({ data }) => {
      if (data.type === 'ready') return data.error ? rej(new Error(data.error)) : res();
      const p = w.pending.get(data.id); w.pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
  });
  workers.push(w);
}
await Promise.all(workers.map((w) => w.ready)).catch((e) => { window.__done = { __error: String(e.message || e) }; throw e; });
const out = {};
let next = 0;
const sel = { f: true, m: true, u: true, level: 'balanced' };
await Promise.all(workers.map(async (w) => {
  while (next < files.length) {
    const f = files[next++];
    try {
      let img = await loadBitmap({ url: '/img/' + encodeURIComponent(f) });
      if (${MAX_SIDE}) {
        // Shrink to a thumbnail first, like a small <img> whose file is that small.
        const s = ${MAX_SIDE} / Math.max(img.bitmap.width, img.bitmap.height);
        const small = await createImageBitmap(img.bitmap, { resizeWidth: Math.max(1, Math.round(img.bitmap.width * s)), resizeHeight: Math.max(1, Math.round(img.bitmap.height * s)), resizeQuality: 'high' });
        img.bitmap.close();
        img = { bitmap: small, w: small.width, h: small.height };
      }
      out[f] = await new Promise((resolve, reject) => {
        const id = f;
        w.pending.set(id, { resolve, reject });
        w.postMessage({ id, bitmap: img.bitmap, opts: { sel, aspect: img.w / img.h, debug: true, quality: '${QUALITY}' } }, [img.bitmap]);
      });
    } catch (e) { out[f] = { error: String(e.message || e) }; }
  }
}));
window.__done = out;
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HARNESS);
  }
  for (const [prefix, dir] of Object.entries(MOUNTS)) {
    if (!url.pathname.startsWith(prefix)) continue;
    const file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
    if (!file.startsWith(dir) || !fs.existsSync(file)) break;
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, 'localhost', r));

const browser = await puppeteer.launch({ ...(BROWSER === 'firefox' ? { browser: 'firefox', executablePath: 'C:/Program Files/Mozilla Firefox/firefox.exe' } : {}), headless: true, protocolTimeout: 0 });
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page]', e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(() => window.__done, { timeout: 0, polling: 1000 });
const scores = await page.evaluate(() => window.__done);
fs.writeFileSync(OUT, JSON.stringify(scores));
console.log(`scored ${Object.keys(scores).length} images in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${OUT}`);
await browser.close();
server.close();
