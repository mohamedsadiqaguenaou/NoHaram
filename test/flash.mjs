// Flash test: no picture may ever be painted unblurred before it has been scanned.
// Serves the common ways sites show images, streams every picture slowly (so the browser paints it
// progressively, like a real page on a normal connection), and records each animation frame from
// the very start of the page: an image that has pixels on screen and no blur while it is still
// unscanned counts as a flash.
//
//   node test/flash.mjs --images <dir> [--headful]
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
const EXT = path.join(ROOT, 'dist', 'chrome');
if (!fs.existsSync(path.join(IMAGES, 'labels.json'))) throw new Error('pass --images <dir> containing labels.json');
const labels = JSON.parse(fs.readFileSync(path.join(IMAGES, 'labels.json'), 'utf8'));
const women = Object.keys(labels).filter((f) => labels[f] === 'female');
const nobody = Object.keys(labels).filter((f) => labels[f] === 'none');
const OFFSET = Number(arg('offset', 0)); // use other photos if the model happens to miss one
const pic = (i) => `/img/${encodeURIComponent(women[(i + OFFSET) % women.length])}`;
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

// Each case: a label and the markup (plus optional script) that shows one picture of a woman.
const cases = [
  ['plain <img src>', `<img data-case src="${pic(0)}?a">`],
  ['srcset only', `<img data-case srcset="${pic(1)}?b 1x">`],
  ['placeholder src + srcset', `<img data-case src="${GIF}" srcset="${pic(2)}?c 1x">`],
  ['<picture> with <source>', `<picture><source srcset="${pic(3)}?d"><img data-case src="${GIF}"></picture>`],
  ['lazy loader swaps src', `<img data-case class="swap" src="${GIF}" data-real="${pic(4)}?e">`],
  ['lazy loader swaps srcset', `<img data-case class="swapset" src="${GIF}" data-real="${pic(5)}?f">`],
  ['carousel swaps a real src', `<img data-case class="carousel" src="/img/${encodeURIComponent(nobody[0])}?g1" data-next="${pic(7)}?g2">`],
  ['inline background-image', `<div data-case style="background-image:url('${pic(8)}?h')"></div>`],
  ['stylesheet background-image', `<div data-case class="sheetbg"></div>`],
  ['image added by script', `<div id="later"></div>`],
];

const page = `<!doctype html><html><head><meta charset="utf-8"><title>flash</title><style>
 body{margin:0;display:grid;grid-template-columns:repeat(5,220px);gap:8px;padding:8px}
 [data-case]{width:220px;height:165px;object-fit:cover;background-size:cover;display:block}
 .sheetbg{background-image:url('${pic(9)}?i')}
</style></head><body>
${cases.map(([, html], i) => html.replace('data-case', `data-case="${i}"`)).join('\n')}
<script>
 setTimeout(() => { for (const i of document.querySelectorAll('.swap')) i.src = i.dataset.real; }, 200);
 setTimeout(() => { for (const i of document.querySelectorAll('.swapset')) i.srcset = i.dataset.real + ' 1x'; }, 200);
 setTimeout(() => { const l = document.getElementById('later'); const i = new Image(); i.dataset.case = '${cases.length - 1}'; i.src = '${pic(10)}?j'; l.replaceWith(i); }, 200);
 // the carousel moves to its next picture once the first one has been judged
 const c = document.querySelector('.carousel');
 const next = () => { if (c.getAttribute('data-nh') === 'b' || c.getAttribute('data-nh') === 'c') c.src = c.dataset.next; else setTimeout(next, 50); };
 next();
</script></body></html>`;

// Stream each picture in small chunks over ~1.2 s so the browser paints it progressively.
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page);
  }
  const f = path.join(IMAGES, path.basename(decodeURIComponent(u.pathname.replace('/img/', ''))));
  if (!fs.existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  const data = fs.readFileSync(f);
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': data.length, 'cache-control': 'no-store' });
  const step = Math.ceil(data.length / 12);
  for (let i = 0; i < data.length; i += step) {
    if (res.destroyed) return;
    res.write(data.subarray(i, i + step));
    await new Promise((r) => setTimeout(r, 100));
  }
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP flash.example 127.0.0.1'],
  defaultViewport: { width: 1200, height: 900 },
});
await browser.waitForTarget((t) => t.type() === 'service_worker');
const tab = await browser.newPage();

// Recorder: from the first frame on, note every case element that is painted, unscanned and unblurred.
await tab.evaluateOnNewDocument(() => {
  const flashes = new Map();
  window.__flashes = flashes;
  const painted = (el) => {
    if (el.tagName === 'IMG') return el.naturalWidth > 0; // dimensions known = pixels are arriving
    const bg = getComputedStyle(el).backgroundImage;
    return bg && bg !== 'none';
  };
  // Every frame: which picture each case element shows unblurred. Judged at the end against the
  // final verdict: a picture that ends up blurred must never have been on screen unblurred.
  // Sampled right after the frame is painted (a task queued from the frame callback), so other
  // frame callbacks of that frame, like the extension's own, have already run.
  window.__first = {};
  const sample = () => {
    for (const el of document.querySelectorAll('[data-case]')) {
      if (!painted(el) || getComputedStyle(el).filter.includes('blur')) continue;
      const shows = el.tagName === 'IMG' ? el.currentSrc : getComputedStyle(el).backgroundImage;
      const key = `${el.dataset.case}|${shows}`;
      flashes.set(key, (flashes.get(key) ?? 0) + 1);
      window.__first[key] ??= `${Math.round(performance.now())} ms, data-nh=${el.getAttribute('data-nh') ?? 'none'}`;
    }
  };
  const frame = () => {
    setTimeout(sample, 0);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});

let failed = 0;
for (let run = 0; run < 2; run++) {
  // run 0: first visit; run 1: everything is in NoHaram's cache, the page itself is fresh
  await tab.goto(`http://flash.example:${server.address().port}/?run=${run}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 6000));
  const flashes = new Map(await tab.evaluate(() => [...window.__flashes.entries()]));
  const first = await tab.evaluate(() => window.__first);
  const finals = await tab.evaluate(() =>
    [...document.querySelectorAll('[data-case]')].map((el) => ({
      i: el.dataset.case,
      state: el.getAttribute('data-nh') ?? '-',
      shows: el.tagName === 'IMG' ? el.currentSrc : getComputedStyle(el).backgroundImage,
    })),
  );
  console.log(`\n${run === 0 ? 'first visit' : 'second visit (cached)'}: final states ${finals.map((f) => f.state).join('')}`);
  for (const [i, [label]] of cases.entries()) {
    const f = finals.find((x) => x.i === String(i));
    if (f?.state !== 'b') {
      console.log(`  n/a    ${label}  (final verdict ${f?.state}: the model does not blur this picture)`);
      continue;
    }
    const key = `${i}|${f.shows}`;
    const frames = flashes.get(key) ?? 0;
    if (frames) failed++;
    console.log(`  ${frames ? 'FLASH' : 'ok   '}  ${label}${frames ? `  (${frames} frames unblurred; first at ${first[key]})` : ''}`);
  }
}
await browser.close();
server.close();
console.log(failed ? `\n${failed} flashing case(s)` : '\nno flashes');
process.exit(failed ? 1 : 0);
