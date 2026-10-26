// Lifecycle test: an open page must keep working while parts of the extension stop, restart or
// get updated underneath it. Each scenario checks what is actually blurred on screen, that a new
// image still gets scanned, and that the settings still control the page.
//
//   node test/lifecycle.mjs --images <dir> [--from <older build dir>] [--headful]
//
// <dir> is the same labelled photo folder test/e2e.mjs uses. With --from, an older build is
// loaded first and then updated in place to dist/chrome, as when a user reloads the extension
// after an update; without it, dist/chrome is reloaded onto itself.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
const NEXT = path.join(ROOT, 'dist', 'chrome');
const FROM = arg('from', null) && path.resolve(arg('from'));
if (!fs.existsSync(path.join(IMAGES, 'labels.json'))) throw new Error('pass --images <dir> containing labels.json');
if (!fs.existsSync(path.join(NEXT, 'manifest.json'))) throw new Error('build first: npm run build:chrome');

const labels = JSON.parse(fs.readFileSync(path.join(IMAGES, 'labels.json'), 'utf8'));
const women = Object.keys(labels).filter((f) => labels[f] === 'female').slice(0, 6);

// ---------------------------------------------------------------- test site

const page = (tag) => `<!doctype html><html><head><meta charset="utf-8"><title>lifecycle</title>
<script>addEventListener('pageshow', (e) => { document.documentElement.dataset.persisted = e.persisted; });</script>
</head><body style="margin:0">
${women.map((f, i) => `<img src="/img/${encodeURIComponent(f)}?${tag}${i}" style="width:200px;height:150px;margin:4px">`).join('')}
<div id="later"></div></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/img/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page(u.pathname === '/' ? 'a' : 'o'));
  }
  const f = path.join(IMAGES, path.basename(decodeURIComponent(u.pathname.slice(5))));
  if (!fs.existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'image/jpeg' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, 'localhost', r));
const base = `http://localhost:${server.address().port}`;

// ---------------------------------------------------------------- browser

// The extension lives in a scratch folder so an update can replace its files in place.
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noharam-lifecycle-'));
fs.cpSync(FROM ?? NEXT, extDir, { recursive: true });
const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  pipe: true,
  enableExtensions: [extDir],
  defaultViewport: { width: 1280, height: 900 },
});
const browserCdp = await browser.target().createCDPSession();
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 20000 });
const extBase = `chrome-extension://${new URL(swTarget.url()).host}`;

// Settings are changed from an extension page opened as a background tab, so the test tab stays
// the visible one (Chrome does not run IntersectionObservers in hidden tabs).
let ctl = null;
async function control() {
  if (ctl && !ctl.isClosed() && (await ctl.evaluate(() => !!chrome.runtime?.id).catch(() => false))) return ctl;
  await ctl?.close().catch(() => {});
  const { targetId } = await browserCdp.send('Target.createTarget', { url: `${extBase}/popup.html`, background: true });
  ctl = await (await browser.waitForTarget((t) => t._targetId === targetId)).asPage();
  await ctl.waitForFunction(() => document.readyState === 'complete' && !!chrome.storage);
  return ctl;
}

async function setSettings(patch) {
  const c = await control();
  for (let i = 0; i < 50; i++) {
    if (await c.evaluate(async () => !!(await chrome.storage.local.get('settings')).settings)) break;
    await sleep(100); // onInstalled writes the defaults
  }
  await c.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);
}

async function popupCounts() {
  const c = await control();
  return c.evaluate(async (site) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(site));
    return (await chrome.runtime.sendMessage({ t: 'status', tabId: tab.id }))?.tab;
  }, base);
}

async function closeTargets(match) {
  for (const t of browser.targets()) {
    if (match(t)) await browserCdp.send('Target.closeTarget', { targetId: t._targetId }).catch(() => {});
  }
}

async function reloadExtension() {
  fs.cpSync(NEXT, extDir, { recursive: true, force: true });
  await browser.installExtension(extDir); // loading the same folder again = Reload in chrome://extensions
}

// ---------------------------------------------------------------- page probes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tab = await browser.newPage();
const states = () => tab.evaluate(() => [...document.images].map((i) => i.getAttribute('data-nh') ?? '-').join(''));
/** What the user sees: B = blurred, . = not blurred. */
const visual = () => tab.evaluate(() => [...document.images].map((i) => (getComputedStyle(i).filter.includes('blur') ? 'B' : '.')).join(''));

async function until(probe, ok, timeout = 30000) {
  const end = Date.now() + timeout;
  let v = await probe();
  while (!ok(v) && Date.now() < end) {
    await sleep(250);
    v = await probe();
  }
  return v;
}

let added = 0;
async function addImage() {
  const file = women[blurredIndex[added % blurredIndex.length]];
  added++;
  await tab.evaluate((src) => {
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'width:200px;height:150px;margin:4px';
    document.getElementById('later').appendChild(img);
  }, `/img/${encodeURIComponent(file)}?late${added}`); // new URL: scanned by the engine, not the cache
}

// ---------------------------------------------------------------- checks

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

let blurredIndex = [];
const shouldBlur = (v) => blurredIndex.every((i) => v[i] === 'B');

async function newImageGetsScanned(label) {
  await addImage();
  const s = await until(states, (v) => v.at(-1) !== 'p' && v.at(-1) !== '-');
  const vis = await tab.evaluate(() => document.visibilityState);
  check(`${label}: a new image is scanned`, s.at(-1) === 'b', `${s} ${vis}`);
}

async function settingsControlPage(label) {
  await setSettings({ enabled: false });
  const off = await until(visual, (v) => !v.includes('B'), 8000);
  check(`${label}: turning the filter off unblurs the page`, !off.includes('B'), off);
  await setSettings({ enabled: true });
  const on = await until(visual, shouldBlur, 15000);
  check(`${label}: turning it back on blurs again`, shouldBlur(on), on);
}

// ---------------------------------------------------------------- scenarios

await setSettings({ enabled: true, blurFemale: true, blurMale: false, sensitivity: 'balanced', blurWhileScanning: true, failClosed: true });
await tab.goto(`${base}/`);
await tab.bringToFront();
const first = await until(states, (v) => !v.includes('p') && !v.includes('-'), 60000);
blurredIndex = [...first].flatMap((c, i) => (c === 'b' ? [i] : []));
if (!blurredIndex.length) throw new Error(`no test photo was blurred (${first}): use a labelled set with clear photos of women`);
console.log(`start: states ${first}, visual ${await visual()}${FROM ? `, build ${FROM}` : ''}`);

// 1) The user reloads the extension (or it updates, or restarts after a crash) with tabs open.
async function restart(label) {
  await reloadExtension();
  await sleep(500);
  const kept = await visual();
  check(`${label}: blurred images stay blurred`, shouldBlur(kept), kept);
  await newImageGetsScanned(label);
  await settingsControlPage(label);
  const counts = await popupCounts();
  check(`${label}: popup counts the page`, counts?.blurred > 0, JSON.stringify(counts));
}
await restart(FROM ? 'update from older build' : 'extension reload');

// 2) Chrome stops the idle service worker (after 30 s without events).
await closeTargets((t) => t.type() === 'service_worker' && t.url().startsWith(extBase));
await sleep(1000);
const counts = await popupCounts();
check('service worker stopped: popup still counts the page', counts?.blurred > 0, JSON.stringify(counts));
await newImageGetsScanned('service worker stopped');
await settingsControlPage('service worker stopped');

// 3) The engine's offscreen document goes away.
await closeTargets((t) => t.url().startsWith(`${extBase}/offscreen.html`));
await sleep(1000);
await newImageGetsScanned('engine closed');

// 4) The user switches to another tab, Chrome freezes this one in the background, the user comes back.
const other = await browser.newPage();
const pageCdp = await tab.createCDPSession();
await pageCdp.send('Page.setWebLifecycleState', { state: 'frozen' });
await sleep(1500);
await pageCdp.send('Page.setWebLifecycleState', { state: 'active' });
await tab.bringToFront();
await other.close();
await newImageGetsScanned('frozen and resumed');
await settingsControlPage('frozen and resumed');

// 5) Back/forward cache: settings change while the page is cached, then the user goes back.
await tab.goto(`${base}/other`);
await until(states, (v) => !v.includes('p'), 30000);
await setSettings({ enabled: false });
await sleep(500);
await tab.goBack();
const persisted = await tab.evaluate(() => document.documentElement.dataset.persisted);
const back = await until(visual, (v) => !v.includes('B'), 8000);
check(`back/forward cache (restored from cache: ${persisted}): change made while away applies`, !back.includes('B'), back);
await setSettings({ enabled: true });
const backOn = await until(visual, shouldBlur, 15000);
check('back/forward cache: turning it back on blurs again', shouldBlur(backOn), backOn);
await newImageGetsScanned('back/forward cache');

// 6) A second restart: now the page's script is this build, so the hand-over protocol is used.
await restart('second reload');

await browser.close();
server.close();
fs.rmSync(extDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
