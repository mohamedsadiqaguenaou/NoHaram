// Content script: finds images, decides what to scan first, and applies the blur.
// The page's main thread only does DOM bookkeeping; downloading, decoding and inference
// happen in the extension's background engine.
import { api, contextAlive, IS_MOBILE } from '../shared/browser.js';
import { BLUR, decide, isIncomplete, selectionOf } from '../shared/policy.js';
import { DEFAULT_SETTINGS, isSiteDisabled, loadSettings, normalizeSettings, onSettingsChanged } from '../shared/settings.js';

const INSTANCE_KEY = '__noharam__';
// After an extension restart the fresh copy of this script runs in a new isolated world: it cannot
// see the old copy's globals, so it announces itself with this event on the shared DOM.
const TAKEOVER = 'noharam:takeover';

// Per-element state lives in this attribute so a single stylesheet does all the blurring.
const ATTR = 'data-nh';
const PENDING = 'p'; // waiting to be scanned (blurred when "blur while scanning" is on)
const BLOCKED = 'b'; // blurred
const CLEAN = 'c';
const SKIPPED = 's'; // icon, SVG, tiny placeholder...
const REVEALED = 'r'; // user chose "Show this image"
const FAILED = 'e'; // could not be downloaded/decoded (blurred when "fail closed" is on)
// Set on images a previous copy of this script had blurred: they stay blurred until re-checked.
const HOLD = 'data-nh-hold';

const NEAR_MARGIN = '300px 0px 300px 0px'; // scan just below/above the fold before it scrolls in
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'BR', 'OPTION', 'PATH', 'svg']);

// A copy of this script injected after an extension restart (update, crash recovery, re-enable)
// replaces the previous one, which can no longer reach the engine. The page stays blurred while
// the new copy re-scans (results come back from the cache). A copy injected twice into the same
// world finds its predecessor here; one from before a restart hears TAKEOVER instead.
const previous = globalThis[INSTANCE_KEY];
if (previous) (previous.handOver ?? previous.shutdown)?.call(previous);
start();

function start() {
  let settings = normalizeSettings(DEFAULT_SETTINGS);
  let sel = selectionOf(settings);
  let topHost = location.hostname;
  let active = true; // assume on until settings load, so nothing flashes unfiltered
  let settingsLoaded = false; // requests carry the user's selection: hold them until it is known
  let stopped = false;
  let orphaned = false; // lost the extension (restart/removal): keep blurring, stop scanning

  const records = new WeakMap(); // element -> record
  const roots = new Set(); // document + open shadow roots we observe
  const styles = new Set(); // our <style> elements
  const queue = new Set(); // records near the viewport waiting for a scan
  const results = new Map(); // url -> { s1, s2, aspect } for this page
  const waiting = new Map(); // url -> Set(records) waiting for an answer
  const requests = new Map(); // id -> { url, msg, rec, triedPixels }
  let seq = 0;
  let docStyle = null;

  const instance = { handOver };
  globalThis[INSTANCE_KEY] = instance;

  // Only a copy whose extension is gone steps aside, so a page cannot switch the filter off.
  const onTakeover = () => {
    if (!contextAlive()) handOver();
  };
  document.addEventListener(TAKEOVER, onTakeover);

  // ------------------------------------------------------------------ styles

  function cssText() {
    if (!active) return '';
    const states = [BLOCKED];
    if (settings.blurWhileScanning || orphaned) states.push(PENDING);
    if (settings.failClosed || orphaned) states.push(FAILED);
    const selectors = states.map((s) => `[${ATTR}="${s}"]`);
    selectors.push(`[${HOLD}]`);
    // No transition: a site that animates filter changes would otherwise fade the blur in slowly.
    return `${selectors.join(',')}{filter:blur(${settings.blurAmount}px) !important;transition:none !important;}`;
  }

  function addStyle(root) {
    const style = document.createElement('style');
    style.setAttribute('data-noharam', '');
    style.textContent = cssText();
    (root === document ? document.head || document.documentElement : root).appendChild(style);
    styles.add(style);
    return style;
  }

  function refreshStyles() {
    const text = cssText();
    for (const style of styles) style.textContent = text;
  }

  /** Stylesheets of a copy from before an extension restart: switch them off for good. */
  function retireForeignStyles(root) {
    for (const old of root.querySelectorAll('style[data-noharam]')) {
      if (styles.has(old)) continue;
      old.media = 'not all'; // survives that copy rewriting or re-attaching it
      old.textContent = '';
    }
  }

  // ------------------------------------------------------------------ element records

  function setState(rec, state) {
    if (state !== PENDING) rec.el.removeAttribute(HOLD);
    if (rec.state === state) return;
    rec.state = state;
    rec.el.setAttribute(ATTR, state);
    statsChanged();
  }

  function track(el, kind, bgUrl) {
    if (stopped) return null;
    let rec = records.get(el);
    if (!rec) {
      rec = { el, kind, url: '', bgUrl: '', state: '', result: null, near: false, visible: false, w: 0, h: 0, inflight: false, manual: false, observed: false };
      records.set(el, rec);
      const inherited = el.getAttribute(ATTR);
      if (inherited === BLOCKED || inherited === FAILED) el.setAttribute(HOLD, '');
    }
    if (!rec.observed) {
      rec.observed = true;
      nearIO.observe(el);
      viewIO.observe(el);
    }
    if (bgUrl !== undefined) rec.bgUrl = bgUrl;
    refresh(rec);
    return rec;
  }

  function forget(node) {
    const els = node.tagName === 'IMG' ? [node] : [node, ...node.getElementsByTagName('img')];
    for (const el of els) {
      const rec = records.get(el);
      if (!rec || el.isConnected) continue;
      rec.observed = false;
      nearIO.unobserve(el);
      viewIO.unobserve(el);
      queue.delete(rec);
    }
  }

  function currentUrl(rec) {
    return rec.kind === 'img' ? rec.el.currentSrc || rec.el.src || '' : rec.bgUrl;
  }

  /**
   * The <img> is still fetching its picture. The browser paints it as soon as the first bytes
   * arrive, but currentSrc and the load event only catch up later, so until then nobody knows which
   * picture it is (a srcset pick, a lazy-loader swap, the next carousel slide...).
   */
  function stillLoading(img) {
    return !img.complete && (img.hasAttribute('src') || img.hasAttribute('srcset') || img.parentElement?.tagName === 'PICTURE');
  }

  function ignorable(url) {
    if (!url) return true;
    if (/^(about|javascript|chrome|chrome-extension|moz-extension|edge):/i.test(url)) return true;
    if (/^data:image\/svg/i.test(url) || /\.svgz?(?:[?#]|$)/i.test(url)) return true;
    return url.startsWith('data:') && url.length < 600; // inline placeholders and tracking pixels
  }

  /** Re-check an element after it appeared or its URL may have changed. */
  function refresh(rec) {
    const url = currentUrl(rec);
    const loading = rec.kind === 'img' && stillLoading(rec.el);
    if (url === rec.url && rec.state && !(loading && rec.state !== PENDING)) return;
    queue.delete(rec);
    rec.url = url;
    rec.result = null;
    rec.manual = false;
    if (loading) {
      // Unscanned (blurred) until its load event says what it shows; onLoad() refreshes it then.
      rec.url = '';
      return setState(rec, PENDING);
    }
    if (ignorable(url)) return setState(rec, SKIPPED);
    const img = rec.el;
    if (rec.kind === 'img' && img.complete && img.naturalWidth && tooSmall(img.naturalWidth, img.naturalHeight)) {
      return setState(rec, SKIPPED);
    }
    const known = results.get(url);
    if (known) {
      rec.result = known;
      return apply(rec);
    }
    setState(rec, PENDING);
    enqueue(rec);
  }

  function tooSmall(w, h) {
    return w < settings.minSize || h < settings.minSize;
  }

  function apply(rec) {
    if (rec.state === REVEALED || rec.manual) return;
    if (isIncomplete(rec.result, sel)) {
      setState(rec, PENDING); // the face stage still has to look at it for this selection
      enqueue(rec);
      return;
    }
    setState(rec, decide(rec.result, sel) === BLUR ? BLOCKED : CLEAN);
  }

  function allTracked() {
    const out = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll(`[${ATTR}]`)) {
        const rec = records.get(el);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ discovery

  const mo = new MutationObserver(onMutations);

  function observeRoot(root) {
    if (roots.has(root) || stopped) return;
    roots.add(root);
    retireForeignStyles(root);
    if (root === document) {
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style'] });
      docStyle = addStyle(document);
    } else {
      mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style'] });
      addStyle(root);
      // load/error do not cross shadow boundaries
      root.addEventListener('load', onLoad, true);
      root.addEventListener('error', onError, true);
    }
    for (const img of root.querySelectorAll('img')) track(img, 'img');
    for (const el of root.querySelectorAll('[style*="background"]')) checkInlineBackground(el);
    bgQueue.push(root);
    scheduleIdle();
  }

  // New or changed <img>s are looked at one microtask later, after the browser's own image-loading
  // microtask has run, so img.complete already tells whether a new picture is on its way. Nothing
  // is painted in between.
  const imgsToCheck = new Set();
  let imgCheckQueued = false;
  function checkSoon(img) {
    imgsToCheck.add(img);
    if (imgCheckQueued) return;
    imgCheckQueued = true;
    queueMicrotask(() => {
      imgCheckQueued = false;
      const list = [...imgsToCheck];
      imgsToCheck.clear();
      for (const el of list) if (el.isConnected) track(el, 'img');
    });
  }

  function onMutations(list) {
    if (stopped) return;
    for (const m of list) {
      if (m.type === 'attributes') {
        const el = m.target;
        if (el.tagName === 'IMG') checkSoon(el);
        else if (m.attributeName === 'style') checkInlineBackground(el);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') {
          checkSoon(n);
        } else {
          for (const img of n.getElementsByTagName('img')) checkSoon(img);
          checkInlineBackground(n);
          if (n.firstElementChild) for (const el of n.querySelectorAll('[style*="background"]')) checkInlineBackground(el);
          bgQueue.push(n);
        }
        if (n.shadowRoot) observeRoot(n.shadowRoot);
      }
      for (const n of m.removedNodes) if (n.nodeType === 1) forget(n);
    }
    if (bgQueue.length) scheduleIdle();
    // Some sites rebuild <head>; keep our stylesheet attached.
    if (docStyle && !docStyle.isConnected && document.documentElement) {
      (document.head || document.documentElement).appendChild(docStyle);
    }
  }

  function cssUrl(value) {
    const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
    if (!m || !m[2]) return '';
    try {
      return new URL(m[2], document.baseURI).href;
    } catch {
      return '';
    }
  }

  function checkInlineBackground(el) {
    const v = el.style?.backgroundImage;
    if (!v || !v.includes('url(') || el === document.documentElement || el === document.body) return;
    const url = cssUrl(v);
    if (url) track(el, 'bg', url);
  }

  // Backgrounds set by stylesheets need getComputedStyle. New elements are walked right before the
  // next frame is painted (a few milliseconds' worth), so a cached background picture is not shown
  // even once; whatever is left continues in idle time.
  const bgQueue = [];
  let walker = null;
  let idleScheduled = false;
  const requestIdle = globalThis.requestIdleCallback?.bind(globalThis) ?? ((cb) => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 50));

  function scheduleIdle() {
    if (idleScheduled || stopped) return;
    idleScheduled = true;
    requestAnimationFrame(() => idleScan(6));
  }

  function idleScan(budgetMs) {
    idleScheduled = false;
    if (stopped) return;
    const end = performance.now() + budgetMs;
    while (performance.now() < end) {
      if (!walker) {
        const root = bgQueue.shift();
        if (!root) break;
        if (!root.isConnected && root !== document) continue;
        walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      }
      const el = walker.nextNode();
      if (!el) {
        walker = null;
        continue;
      }
      if (el.shadowRoot) observeRoot(el.shadowRoot);
      if (el.tagName === 'IMG' || SKIP_TAGS.has(el.tagName) || records.has(el)) continue;
      if (el === document.documentElement || el === document.body) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) {
        const url = cssUrl(bg);
        if (url) track(el, 'bg', url);
      }
    }
    if ((walker || bgQueue.length) && !idleScheduled) {
      // The rest in idle time; a page that never idles still gets a slice every 200 ms.
      idleScheduled = true;
      requestIdle((d) => idleScan(d.didTimeout ? 6 : Math.max(1, d.timeRemaining() - 1)), { timeout: 200 });
    }
  }

  function onLoad(e) {
    const img = e.target;
    if (img?.tagName !== 'IMG' || stopped) return;
    const rec = records.get(img) ?? track(img, 'img');
    if (!rec) return;
    const r = img.getBoundingClientRect();
    rec.w = r.width;
    rec.h = r.height;
    refresh(rec); // currentSrc may have changed (srcset / lazy loading)
    if (rec.state !== PENDING || rec.inflight) return;
    if (readiness(rec) === 'skip') setState(rec, SKIPPED);
    else enqueue(rec);
  }

  function onError(e) {
    if (stopped) return;
    const rec = e.target?.tagName === 'IMG' ? records.get(e.target) : null;
    if (rec && rec.state === PENDING && !rec.inflight) {
      queue.delete(rec);
      setState(rec, SKIPPED); // broken image: nothing to show anyway
    }
  }

  // ------------------------------------------------------------------ visibility

  const nearIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const rec = records.get(e.target);
        if (!rec) continue;
        rec.near = e.isIntersecting;
        rec.w = e.boundingClientRect.width;
        rec.h = e.boundingClientRect.height;
        if (rec.state === PENDING && !rec.inflight && readiness(rec) === 'skip') {
          queue.delete(rec);
          setState(rec, SKIPPED); // icon-sized: un-blur right away instead of waiting in the queue
          continue;
        }
        if (rec.near) enqueue(rec);
        else queue.delete(rec);
      }
    },
    { rootMargin: NEAR_MARGIN },
  );

  const viewIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const rec = records.get(e.target);
      if (!rec) continue;
      rec.visible = e.isIntersecting;
      if (e.isIntersecting) {
        rec.w = e.boundingClientRect.width;
        rec.h = e.boundingClientRect.height;
      }
    }
    schedulePump();
  });

  // ------------------------------------------------------------------ scheduling

  // While a finger is dragging the page, the compositor needs the CPU: one request at a time,
  // then burst through the visible images as soon as scrolling settles.
  let touching = false;
  let scrolling = false;
  let scrollTimer = 0;
  const passive = { passive: true, capture: true };
  addEventListener('touchstart', () => (touching = true), passive);
  addEventListener('touchend', settle, passive);
  addEventListener('touchcancel', settle, passive);
  addEventListener('scroll', () => {
    scrolling = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(settle, 100);
  }, passive);
  addEventListener('scrollend', settle, passive);
  document.addEventListener('visibilitychange', () => schedulePump());

  function settle(e) {
    if (e?.type?.startsWith('touch')) touching = false;
    scrolling = false;
    clearTimeout(scrollTimer);
    schedulePump();
  }

  function maxInflight() {
    if (document.hidden) return 1;
    if (touching || (scrolling && IS_MOBILE)) return 1;
    return IS_MOBILE ? 2 : 4;
  }

  function enqueue(rec) {
    if (rec.near && rec.state === PENDING && !rec.inflight) {
      queue.add(rec);
      schedulePump();
    }
  }

  let pumpQueued = false;
  function schedulePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      pump();
    });
  }

  function pump() {
    if (!active || stopped || orphaned || !settingsLoaded) return;
    while (requests.size < maxInflight()) {
      const rec = pickNext();
      if (!rec) break;
      send(rec);
    }
  }

  /** Visible images first, then the ones within the look-ahead margin. */
  function pickNext() {
    let fallback = null;
    for (const rec of queue) {
      if (!rec.el.isConnected || rec.state !== PENDING || rec.inflight) {
        queue.delete(rec);
        continue;
      }
      const ready = readiness(rec);
      if (ready === 'skip') {
        queue.delete(rec);
        setState(rec, SKIPPED);
        continue;
      }
      if (ready !== 'ok') continue;
      if (rec.visible) return rec;
      fallback ??= rec;
    }
    return fallback;
  }

  function readiness(rec) {
    if (rec.kind === 'img') {
      const img = rec.el;
      if (!img.complete) return 'wait'; // its load event will bring it back
      if (!img.naturalWidth) return 'skip'; // broken
      if (tooSmall(img.naturalWidth, img.naturalHeight)) return 'skip';
    }
    if (!rec.w && !rec.h) return 'wait'; // not laid out yet
    if (tooSmall(rec.w, rec.h)) return 'skip'; // rendered as an icon
    return 'ok';
  }

  function send(rec) {
    queue.delete(rec);
    rec.inflight = true;
    const url = rec.url;
    const group = waiting.get(url);
    if (group) {
      group.add(rec); // same URL already on its way
      return;
    }
    waiting.set(url, new Set([rec]));
    const id = ++seq;
    const img = rec.kind === 'img' ? rec.el : null;
    const req = { url, rec, triedPixels: false, sentAt: performance.now(), msg: { t: 'scan', id, url, sel, w: img?.naturalWidth || 0, h: img?.naturalHeight || 0 } };
    requests.set(id, req);
    if (url.startsWith('blob:')) {
      // blob: URLs only exist inside this page, so the background cannot download them.
      req.triedPixels = true;
      attachPixels(req).then((ok) => (ok ? post(req.msg) : finish(req, { error: 'blob', code: 'fetch' })));
    } else {
      post(req.msg);
    }
  }

  function onResponse(msg) {
    if (msg?.t !== 'res') return;
    const req = requests.get(msg.id);
    if (!req) return;
    if (msg.error && msg.code === 'fetch' && !req.triedPixels) {
      // Hotlink-protected or cookie-only image: read the pixels from the page instead.
      req.triedPixels = true;
      attachPixels(req).then((ok) => (ok ? post(req.msg) : finish(req, msg)));
      return;
    }
    finish(req, msg);
  }

  function finish(req, msg) {
    requests.delete(req.msg.id);
    const group = waiting.get(req.url) ?? new Set();
    waiting.delete(req.url);
    let result = null;
    if (!msg.error && !msg.skip && msg.s1) {
      result = { s1: msg.s1, s2: msg.s2 ?? null, aspect: msg.aspect ?? 1 };
      results.set(req.url, result);
    }
    // Test pages can opt in to timing diagnostics with <html data-nh-debug>.
    const debug = document.documentElement.hasAttribute('data-nh-debug');
    const timing = debug
      ? JSON.stringify({ ...msg.ms, total: Math.round(performance.now() - req.sentAt), scores1: msg.s1, scores2: msg.s2, err: msg.error ? `${msg.code}: ${msg.error}` : undefined, skip: msg.skip })
      : null;
    for (const rec of group) {
      rec.inflight = false;
      if (rec.url !== req.url) {
        enqueue(rec); // its URL changed while this answer was on the way: scan the new one
        continue;
      }
      if (rec.state === REVEALED || rec.manual) continue;
      if (timing) rec.el.setAttribute('data-nh-ms', timing);
      if (msg.skip) setState(rec, SKIPPED);
      else if (!result) setState(rec, FAILED);
      else {
        rec.result = result;
        apply(rec);
      }
    }
    schedulePump();
  }

  async function attachPixels(req) {
    const dataUrl = await extractPixels(req.rec, req.url);
    if (!dataUrl) return false;
    req.msg = { ...req.msg, dataUrl };
    return true;
  }

  async function extractPixels(rec, url) {
    // Read from the element itself only while it still shows this URL.
    if (rec.kind === 'img' && currentUrl(rec) === url && rec.el.complete && rec.el.naturalWidth) {
      try {
        return toDataUrl(rec.el, rec.el.naturalWidth, rec.el.naturalHeight); // same-origin / CORS-clean
      } catch {
        // tainted canvas: try a CORS request below
      }
    }
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = reject;
        setTimeout(() => reject(new Error('timeout')), 10000);
        i.src = url;
      });
      return toDataUrl(img, img.naturalWidth, img.naturalHeight);
    } catch {
      return null;
    }
  }

  function toDataUrl(img, w, h) {
    const scale = Math.min(1, 512 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9); // throws SecurityError if tainted
  }

  // ------------------------------------------------------------------ messaging

  let port = null;

  function post(msg) {
    if (stopped || orphaned) return;
    if (!contextAlive()) return orphan();
    if (!port) {
      try {
        port = connect();
      } catch {
        return orphan();
      }
    }
    try {
      port.postMessage(msg);
    } catch {
      port = null;
      setTimeout(() => post(msg), 100);
    }
  }

  function dropPort() {
    const p = port;
    port = null;
    try {
      p?.disconnect();
    } catch {}
  }

  function connect() {
    const p = api.runtime.connect({ name: 'nh' });
    p.onMessage.addListener(onResponse);
    p.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      if (port !== p) return; // an older port closing late
      port = null;
      if (!contextAlive()) return orphan();
      // The service worker restarted, or the page went into the back/forward cache: ask again
      // for everything still unanswered.
      setTimeout(() => {
        for (const req of requests.values()) post(req.msg);
      }, 100);
    });
    return p;
  }

  let statsTimer = 0;
  let lastStats = '';
  function statsChanged() {
    if (!statsTimer && !stopped) statsTimer = setTimeout(sendStats, 800);
  }

  function sendStats() {
    statsTimer = 0;
    let blurred = 0;
    let scanned = 0;
    for (const rec of allTracked()) {
      if (rec.state === BLOCKED) blurred++;
      if (rec.state === BLOCKED || rec.state === CLEAN || rec.state === REVEALED) scanned++;
    }
    const key = `${blurred}/${scanned}`;
    if (key === lastStats) return;
    lastStats = key;
    post({ t: 'stats', blurred, scanned });
  }

  // Context menu: "Show this image" / "Blur this image"
  const onRuntimeMessage = (msg, _sender, sendResponse) => {
    if (msg?.t === 'ping') {
      sendResponse({ pong: true });
      return;
    }
    if (msg?.t !== 'reveal' && msg?.t !== 'block') return;
    for (const rec of allTracked()) {
      if (rec.url !== msg.src) continue;
      rec.manual = msg.t === 'block';
      setState(rec, msg.t === 'reveal' ? REVEALED : BLOCKED);
    }
  };
  api.runtime.onMessage.addListener(onRuntimeMessage);

  // ------------------------------------------------------------------ settings

  function evaluateActive() {
    const want = settings.enabled && (settings.blurFemale || settings.blurMale || settings.blurNudity) && !isSiteDisabled(settings, topHost);
    if (want === active) return;
    active = want;
    if (active) reapplyAll(false);
  }

  function reapplyAll(sizeChanged) {
    for (const rec of allTracked()) {
      if (rec.state === REVEALED || rec.manual) continue;
      if (rec.state === SKIPPED && sizeChanged && !ignorable(rec.url)) {
        rec.state = '';
        refresh(rec);
      } else if (rec.result) {
        apply(rec);
      } else if (rec.state === PENDING) {
        enqueue(rec);
      }
    }
    schedulePump();
  }

  function applySettings(next) {
    const sizeChanged = next.minSize !== settings.minSize;
    settings = next;
    sel = selectionOf(settings);
    evaluateActive();
    refreshStyles();
    if (active) reapplyAll(sizeChanged);
  }

  const unsubscribeSettings = onSettingsChanged((next) => {
    if (!stopped && !orphaned) applySettings(next);
  });

  // Back/forward cache: Chrome closes the port of a cached page without telling it, and the page
  // misses settings changes while it is there. Let go of the port on the way in, and catch up on
  // the way back.
  addEventListener('pagehide', (e) => {
    if (e.persisted) dropPort();
  });
  addEventListener('pageshow', (e) => {
    if (!e.persisted || stopped || orphaned || !settingsLoaded) return;
    if (!contextAlive()) return orphan();
    dropPort();
    for (const req of requests.values()) post(req.msg);
    lastStats = '';
    statsChanged();
    loadSettings().then((next) => {
      if (stopped || orphaned) return;
      if (JSON.stringify(next) !== JSON.stringify(settings)) applySettings(next);
      schedulePump();
    });
  });

  async function resolveTopHost() {
    if (window.top === window) return location.hostname;
    const origins = location.ancestorOrigins;
    if (origins?.length) {
      try {
        return new URL(origins[origins.length - 1]).hostname;
      } catch {}
    }
    try {
      const r = await api.runtime.sendMessage({ t: 'hello' });
      return r?.topHost || location.hostname;
    } catch {
      return location.hostname;
    }
  }

  // ------------------------------------------------------------------ lifecycle

  function stopListening() {
    try {
      unsubscribeSettings();
      api.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // the extension context is already gone
    }
  }

  /** A fresh copy of this script took over: stop and leave the page (and its blur) to it. */
  function handOver() {
    if (stopped) return;
    stopped = true;
    mo.disconnect();
    nearIO.disconnect();
    viewIO.disconnect();
    stopListening();
    document.removeEventListener(TAKEOVER, onTakeover);
    document.removeEventListener('load', onLoad, true);
    document.removeEventListener('error', onError, true);
    clearTimeout(statsTimer);
    for (const style of styles) style.remove();
    queue.clear();
    requests.clear();
    waiting.clear();
    dropPort();
    if (globalThis[INSTANCE_KEY] === instance) delete globalThis[INSTANCE_KEY];
  }

  /**
   * The extension restarted (update, crash recovery) or was removed, so nothing can be scanned.
   * Fail closed: keep blurred images blurred and blur new images until a fresh copy of this
   * script takes over or the page is reloaded.
   */
  function orphan() {
    if (orphaned || stopped) return;
    orphaned = true;
    port = null;
    stopListening();
    nearIO.disconnect();
    viewIO.disconnect();
    queue.clear();
    requests.clear();
    waiting.clear();
    active = true;
    refreshStyles();
  }

  function boot() {
    if (stopped) return;
    observeRoot(document);
    // Our stylesheet is in place and inherited blur is held: an older copy can let go now.
    document.dispatchEvent(new CustomEvent(TAKEOVER));
    document.addEventListener('load', onLoad, true);
    document.addEventListener('error', onError, true);
    Promise.all([loadSettings(), resolveTopHost()]).then(([s, host]) => {
      if (stopped) return;
      settings = s;
      sel = selectionOf(settings);
      topHost = host;
      settingsLoaded = true;
      const wasActive = active;
      evaluateActive();
      refreshStyles();
      if (active && wasActive) reapplyAll(settings.minSize !== DEFAULT_SETTINGS.minSize);
      schedulePump();
    });
  }

  if (document.documentElement) {
    boot();
  } else {
    // document_start can run before <html> exists
    const wait = new MutationObserver(() => {
      if (!document.documentElement) return;
      wait.disconnect();
      boot();
    });
    wait.observe(document, { childList: true });
  }
}
