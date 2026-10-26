// Audits real websites: loads each URL in Chrome with the built extension, scrolls like a user,
// then records every image's state (blurred / clean / skipped / failed / still pending), its
// scores and a screenshot of the unblurred image for manual review.
//
//   node test/audit-sites.mjs --out <dir> [--select female|male|both] url1 url2 ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const OUT = path.resolve(opt('out', 'audit'));
const SELECT = opt('select', 'female');
const MAX_SHOTS = Number(opt('max-shots', '80'));
const urls = argv.filter((a) => /^https?:/.test(a));
const EXT = path.join(ROOT, 'dist', 'chrome');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--lang=en-US'],
  defaultViewport: { width: 1366, height: 900 },
});
const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const extBase = `chrome-extension://${new URL(sw.url()).host}`;
const control = await browser.newPage();
await control.goto(`${extBase}/popup.html`);
for (let i = 0; i < 50 && !(await control.evaluate(async () => !!(await chrome.storage.local.get('settings')).settings)); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
await control.evaluate(async (select) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, blurFemale: select !== 'male', blurMale: select !== 'female' } });
}, SELECT);

const report = [];
const SITE_BUDGET_MS = Number(opt('site-seconds', '150')) * 1000;
for (const [n, url] of urls.entries()) {
  const started = Date.now();
  const overBudget = () => Date.now() - started > SITE_BUDGET_MS;
  const tab = await browser.newPage();
  await tab.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  await tab.evaluateOnNewDocument(() => {
    document.addEventListener('readystatechange', () => document.documentElement?.setAttribute('data-nh-debug', ''), { once: true });
    if (document.documentElement) document.documentElement.setAttribute('data-nh-debug', '');
  });
  const site = `${String(n).padStart(2, '0')}-${new URL(url).hostname.replace(/^www\./, '')}`;
  try {
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3000));
    // Scroll like a user, letting each screen settle.
    const height = Math.min(await tab.evaluate(() => document.documentElement.scrollHeight), 9000);
    for (let y = 0; y <= height && !overBudget(); y += 600) {
      await tab.evaluate((yy) => window.scrollTo(0, yy), y);
      for (let i = 0; i < 20; i++) {
        const pending = await tab.evaluate(() => [...document.querySelectorAll('[data-nh="p"]')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight && r.width > 0;
        }).length);
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await tab.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 1500));
    const items = await tab.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-nh]').forEach((el, i) => {
        const r = el.getBoundingClientRect();
        el.setAttribute('data-audit', String(i));
        out.push({
          i,
          state: el.getAttribute('data-nh'),
          tag: el.tagName,
          w: Math.round(r.width),
          h: Math.round(r.height),
          src: el.tagName === 'IMG' ? (el.currentSrc || el.src).slice(0, 300) : getComputedStyle(el).backgroundImage.slice(0, 300),
          debug: el.getAttribute('data-nh-ms') ? JSON.parse(el.getAttribute('data-nh-ms')) : null,
        });
      });
      return out;
    });
    // Unblur everything and screenshot the scanned/failed/pending images for review.
    await tab.addStyleTag({ content: '[data-nh]{filter:none!important}' });
    const shotDir = path.join(OUT, site);
    fs.mkdirSync(shotDir, { recursive: true });
    let shots = 0;
    for (const it of items) {
      if (!['b', 'c', 'e', 'p'].includes(it.state) || it.w < 20 || it.h < 20 || shots >= MAX_SHOTS) continue;
      if (Date.now() - started > SITE_BUDGET_MS + 60000) break;
      const el = await tab.$(`[data-audit="${it.i}"]`);
      try {
        await el.scrollIntoView();
        await el.screenshot({ path: path.join(shotDir, `${it.i}.png`) });
        it.shot = `${site}/${it.i}.png`;
        shots++;
      } catch {}
    }
    const counts = items.reduce((m, it) => ((m[it.state] = (m[it.state] || 0) + 1), m), {});
    console.log(`${site}: ${items.length} images`, counts);
    report.push({ site, url, items });
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1)); // keep partial results
  } catch (err) {
    console.log(`${site}: failed - ${err.message}`);
  }
  await tab.close().catch(() => {});
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
await browser.close();
