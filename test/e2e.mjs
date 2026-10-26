// End-to-end test: loads dist/chrome into Chrome for Testing, serves a local page full of
// labelled photos and tricky cases, scrolls through it and checks what got blurred.
//
//   node test/e2e.mjs --images <dir> [--select female|male|both] [--browser chrome|firefox] [--headful]
//
// <dir> must contain image files plus labels.json: { "file.jpg": "female"|"male"|"both"|"none" }.
// (Test photos are not shipped with the repo; any labelled set works.)
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
const SELECT = arg('select', 'female');
const HEADFUL = argv.includes('--headful');
const BROWSER = arg('browser', 'chrome');
const EXT = path.join(ROOT, 'dist', BROWSER);
const FIREFOX = arg('firefox', 'C:/Program Files/Mozilla Firefox/firefox.exe');
if (!fs.existsSync(path.join(IMAGES, 'labels.json'))) throw new Error('pass --images <dir> containing labels.json');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`build first: npm run build:${BROWSER}`);

const labels = JSON.parse(fs.readFileSync(path.join(IMAGES, 'labels.json'), 'utf8'));
const files = Object.keys(labels);

// ---------------------------------------------------------------- test site
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR4AWP4z8DwnxLMMGoAw6gBDKMGMIwawDBqAMOoAQyjBoAAAJ8uH/G4mJ7RAAAAAElFTkSuQmCC', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="90" fill="teal"/></svg>';

function page(v = '') {
  const pick = (kind, n) => files.filter((f) => labels[f] === kind).slice(0, n);
  const special = {
    background: pick('female', 1)[0],
    lazy: pick('male', 1)[0],
    protected: pick('female', 2)[1],
    blob: pick('female', 3)[2],
    shadow: pick('male', 2)[1],
    frame: pick('female', 4)[3],
  };
  const q = v ? `?v=${v}` : '';
  // Search-chip style thumbnails: small (40px) but they still show people.
  const chips = [...pick('female', 4), ...pick('male', 4)]
    .map((f) => `<img class="chip" src="/img/${encodeURIComponent(f)}?chip${q}" data-test="chip:${f}" data-kind="${labels[f]}">`)
    .join('');
  const grid = files.map((f, i) => `<figure><img src="/img/${encodeURIComponent(f)}${q}" data-test="${f}" data-kind="${labels[f]}" alt="${i}"></figure>`).join('\n');
  return `<!doctype html><html data-nh-debug><head><meta charset="utf-8"><title>NoHaram e2e</title>
<style>
 body{font:14px sans-serif;margin:16px} figure{display:inline-block;margin:6px}
 figure img{width:260px;height:200px;object-fit:cover}
 .bg{width:260px;height:200px;background:url('/img/${encodeURIComponent(special.background)}') center/cover}
 .icon{width:16px;height:16px}
 .chip{width:40px;height:40px;object-fit:cover;border-radius:8px;margin:2px}
</style></head><body>
<h1>NoHaram e2e</h1>
<p><img class="icon" src="/icon.png" data-test="icon" data-kind="skip"> tiny icon
   <img src="/logo.svg" width="120" height="120" data-test="svg" data-kind="skip"></p>
<p>${chips}</p>
<div class="bg" data-test="background:${special.background}" data-kind="${labels[special.background]}"></div>
<figure><img id="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/${encodeURIComponent(special.lazy)}" data-test="lazy:${special.lazy}" data-kind="${labels[special.lazy]}" style="width:260px;height:200px"></figure>
<figure><img src="/protected/${encodeURIComponent(special.protected)}" data-test="protected:${special.protected}" data-kind="${labels[special.protected]}" style="width:260px;height:200px"></figure>
<figure><img id="blob" data-test="blob:${special.blob}" data-kind="${labels[special.blob]}" style="width:260px;height:200px"></figure>
<div id="host" data-test-host="shadow:${special.shadow}" data-kind="${labels[special.shadow]}"></div>
<iframe src="/frame?f=${encodeURIComponent(special.frame)}" width="300" height="240" data-test="frame:${special.frame}" data-kind="${labels[special.frame]}"></iframe>
<div id="grid">${grid}</div>
<script>
 setTimeout(() => { const l = document.getElementById('lazy'); l.src = l.dataset.src; }, 300);
 fetch('/img/${encodeURIComponent(special.blob)}').then(r => r.blob()).then(b => { document.getElementById('blob').src = URL.createObjectURL(b); });
 const root = document.getElementById('host').attachShadow({ mode: 'open' });
 root.innerHTML = '<img src="/img/${encodeURIComponent(special.shadow)}" style="width:260px;height:200px">';
</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'max-age=3600' });
    res.end(body);
  };
  if (url.pathname === '/') return send(200, 'text/html', page(url.searchParams.get('v') || ''));
  if (url.pathname === '/frame') {
    return send(200, 'text/html', `<!doctype html><body style="margin:0"><img src="/img/${encodeURIComponent(url.searchParams.get('f'))}" style="width:280px;height:220px" data-test="in-frame"></body>`);
  }
  if (url.pathname === '/icon.png') return send(200, 'image/png', ICON);
  if (url.pathname === '/logo.svg') return send(200, 'image/svg+xml', SVG);
  const m = /^\/(img|protected)\/(.+)$/.exec(url.pathname);
  if (m) {
    // "Hotlink protection": only serve when the page's Referer is present.
    if (m[1] === 'protected' && !(req.headers.referer || '').includes(`localhost:${server.address().port}`)) return send(403, 'text/plain', 'forbidden');
    const file = path.join(IMAGES, decodeURIComponent(m[2]));
    if (!file.startsWith(IMAGES) || !fs.existsSync(file)) return send(404, 'text/plain', 'missing');
    return send(200, 'image/jpeg', fs.readFileSync(file));
  }
  send(404, 'text/plain', 'not found');
});
await new Promise((r) => server.listen(0, 'localhost', r));
const BASE = `http://localhost:${server.address().port}`;

// ---------------------------------------------------------------- browser
const logs = [];
let browser;
let extBase;
if (BROWSER === 'firefox') {
  // Fix the moz-extension:// UUID so the test can open the extension's own pages.
  const geckoId = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
  const uuid = '4f9d2a1e-7c3b-4e5f-9a6d-1b2c3d4e5f60';
  browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: !HEADFUL,
    defaultViewport: { width: 1280, height: 900 },
    extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ [geckoId]: uuid }) },
  });
  await browser.installExtension(EXT);
  extBase = `moz-extension://${uuid}`;
} else {
  browser = await puppeteer.launch({
    headless: !HEADFUL,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 20000 });
  extBase = `chrome-extension://${new URL(swTarget.url()).host}`;
  const sw = await swTarget.worker();
  sw.on('console', (m) => logs.push(`[sw] ${m.type()} ${m.text()}`));
  browser.on('targetcreated', async (t) => {
    if (t.url().includes('offscreen.html')) {
      const p = await t.asPage().catch(() => null);
      p?.on('console', (m) => logs.push(`[offscreen] ${m.type()} ${m.text()}`));
    }
  });
}
// Firefox's WebDriver BiDi cannot open moz-extension:// pages: there the defaults are used.
const control = BROWSER === 'chrome' ? await browser.newPage() : null;
if (control) await control.goto(`${extBase}/popup.html`);
if (!control && SELECT !== 'female') throw new Error('Firefox runs use the default settings: --select female');

const settings = {
  enabled: true,
  blurFemale: SELECT === 'female' || SELECT === 'both',
  blurMale: SELECT === 'male' || SELECT === 'both',
  sensitivity: 'balanced',
  blurUnknown: true,
  blurWhileScanning: true,
  failClosed: true,
  blurAmount: 24,
  minSize: 24,
  disabledSites: [],
};
// onInstalled writes the defaults asynchronously: wait for them, then override and verify.
for (let i = 0; control && i < 50; i++) {
  if (await control.evaluate(async () => !!(await chrome.storage.local.get('settings')).settings)) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (control) await control.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
const applied = control ? await control.evaluate(async () => (await chrome.storage.local.get('settings')).settings) : settings;
if (applied.blurMale !== settings.blurMale || applied.blurFemale !== settings.blurFemale) throw new Error('settings were not applied');

const tab = await browser.newPage();
tab.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) logs.push(`[page] ${m.text()}`);
});
const passes = [];
async function pass(name, v) {
  const t0 = Date.now();
  await tab.goto(`${BASE}/?v=${v}`, { waitUntil: 'domcontentloaded' });
  const first = await settleVisible(60000);
  const firstMs = Date.now() - t0;
  const height = await tab.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 700) {
    await tab.evaluate((yy) => window.scrollTo(0, yy), y);
    await settleVisible(60000);
  }
  // Back to the top: late lazy-loads there are scanned once they are near the viewport again.
  await tab.evaluate(() => window.scrollTo(0, 0));
  await settleVisible(60000);
  const timings = await tab.evaluate(() => [...document.querySelectorAll('[data-nh-ms]')].map((el) => JSON.parse(el.getAttribute('data-nh-ms'))));
  const med = (k) => {
    const v = timings.map((t) => t[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    return v.length ? Math.round(v[v.length >> 1]) : null;
  };
  passes.push({ name, firstScreenMs: first < 0 ? 'timeout' : firstMs, allMs: Date.now() - t0, medianMs: { total: med('total'), load: med('load'), queue: med('queue'), s1: med('s1'), s2: med('s2') } });
}

// Scroll through the page like a user, waiting for the visible images to settle.
const states = () =>
  tab.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-test]')) out.push({ test: el.dataset.test, kind: el.dataset.kind, state: el.getAttribute('data-nh'), tag: el.tagName });
    const host = document.getElementById('host');
    const simg = host.shadowRoot?.querySelector('img');
    out.push({ test: host.dataset.testHost, kind: host.dataset.kind, state: simg?.getAttribute('data-nh') ?? null, tag: 'SHADOW-IMG' });
    return out;
  });
const settleVisible = async (limitMs) => {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    const pending = await tab.evaluate(() => {
      const vh = innerHeight;
      return [...document.querySelectorAll('[data-nh="p"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < vh && r.width > 0;
      }).length;
    });
    if (!pending) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 100));
  }
  return -1;
};
await pass('cold (engine starting)', 'a');
await pass('warm (new URLs)', 'b');
await pass('cached (same URLs)', 'b');
await new Promise((r) => setTimeout(r, 500));
const final = await states();
const frameState = await (async () => {
  const f = tab.frames().find((fr) => fr.url().includes('/frame'));
  return f ? f.evaluate(() => document.querySelector('img')?.getAttribute('data-nh')) : null;
})();
final.push({ test: final.find((x) => x.test.startsWith('frame:'))?.test.replace('frame:', 'in-frame:'), kind: final.find((x) => x.test.startsWith('frame:'))?.kind, state: frameState, tag: 'IFRAME-IMG' });

// engine status straight from the extension
const popup = control;
const status = popup ? await popup.evaluate(() => chrome.runtime.sendMessage({ t: 'status' })) : null;
// Raw scores per image (for comparing against the Python reference pipeline).
const scoresOut = arg('scores', '');
if (scoresOut && popup) {
  const scores = {};
  for (const f of files) {
    scores[f] = await popup.evaluate((u) => chrome.runtime.sendMessage({ t: 'peek', url: u }), `${BASE}/img/${encodeURIComponent(f)}?v=b`);
  }
  fs.writeFileSync(scoresOut, JSON.stringify(scores, null, 1));
}

// ---------------------------------------------------------------- score
const shouldBlur = (kind) => (kind === 'skip' ? false : SELECT === 'both' ? kind !== 'none' : kind === SELECT || kind === 'both');
let correct = 0;
let scored = 0;
const wrong = [];
const byKind = {};
for (const s of final.filter((x) => x.tag !== 'IFRAME')) {
  if (!s.test) continue;
  const blurred = s.state === 'b' || s.state === 'e';
  const expect = shouldBlur(s.kind);
  const ok = s.kind === 'skip' ? s.state === 's' : blurred === expect;
  scored++;
  if (ok) correct++;
  else wrong.push(`${s.test} (${s.kind}) -> ${s.state}`);
  const k = (byKind[s.kind] ??= { n: 0, blurred: 0, pending: 0, failed: 0 });
  k.n++;
  if (s.state === 'b') k.blurred++;
  if (s.state === 'p' || s.state === null) k.pending++;
  if (s.state === 'e') k.failed++;
}
const special = final.filter((x) => /^(background|lazy|protected|blob|shadow|in-frame):|^(icon|svg)$/.test(x.test || ''));
console.log(JSON.stringify({ select: SELECT, passes, accuracy: `${correct}/${scored}`, byKind, special: special.map((s) => `${s.test} -> ${s.state}`), wrong, engine: status?.engine, cached: status?.cached }, null, 2));
if (logs.length) console.log('--- extension logs ---\n' + logs.slice(0, 40).join('\n'));
await browser.close();
server.close();
