// Background router: content scripts connect over a port and ask "what is in this image?".
// Answers come from the cache when possible, otherwise from the inference engine.
import { api } from '../shared/browser.js';
import { CONFIG, isIncomplete, stage2Parts } from '../shared/policy.js';
import { resolveLanguage, translator } from '../shared/i18n.js';
import { DEFAULT_SETTINGS, loadSettings, migrateSettings, onSettingsChanged, SETTINGS_KEY } from '../shared/settings.js';
import { ResultCache } from './cache.js';
import { createExecutor } from './executors.js';

const cache = new ResultCache(CONFIG.version);
const inflight = new Map(); // key -> Promise<result>
let executor = null;
const getExecutor = () => (executor ??= createExecutor());

// Load the models before the first page needs them (compiling WASM + models takes ~1-3 s).
function warmUp() {
  Promise.resolve(getExecutor().warmUp?.()).catch(() => {});
}

// ---------------------------------------------------------------- scanning

async function scan({ url, dataUrl, w, h, sel }) {
  const cacheable = !url.startsWith('blob:');
  const cached = cacheable ? await cache.get(url) : null;
  if (cached && !isIncomplete(cached, sel)) return { ...cached, cached: true };

  // Requests for the same image and the same missing parts share one analysis.
  const parts = cached ? stage2Parts(cached.s1, sel, cached.s2) : null;
  const key = `${url}|${cached ? `${parts?.gender ? 'g' : ''}${parts?.nsfw ? 'n' : ''}` : `all${sel.f || sel.m ? 'g' : ''}${sel.n ? 'n' : ''}`}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const r = await getExecutor().analyze({ url, dataUrl, w, h, sel, s1: cached?.s1 ?? null, s2: cached?.s2 ?? null });
      if (!r || r.skip || r.error) return r ?? { error: 'no result', code: 'engine' };
      // Stage 2 parts accumulate: a later selection only adds what it is missing.
      const value = { s1: r.s1, s2: r.s2 || cached?.s2 ? { ...cached?.s2, ...r.s2 } : null, aspect: r.aspect };
      if (cacheable) cache.set(url, value);
      return { ...value, ms: r.ms };
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'nh') return;
  warmUp();
  port.onMessage.addListener(async (msg) => {
    if (msg?.t === 'scan') {
      let res;
      try {
        res = await scan(msg);
      } catch (err) {
        res = { error: String(err?.message || err), code: 'engine' };
      }
      try {
        port.postMessage({ t: 'res', id: msg.id, ...res });
      } catch {
        // tab closed or navigated away
      }
    } else if (msg?.t === 'stats') {
      recordFrameStats(port.sender, msg);
    }
  });
  port.onDisconnect.addListener(() => {
    void api.runtime.lastError; // e.g. the page moved into the back/forward cache
    const tabId = port.sender?.tab?.id;
    if (tabId != null) editStats(() => tabStats.get(tabId)?.delete(port.sender.frameId ?? 0));
  });
});

// ---------------------------------------------------------------- badge

// tabId -> Map(frameId -> { blurred, scanned }). Chrome stops an idle service worker after 30 s,
// so the counts the popup shows are kept in session storage as well.
const tabStats = new Map();
const STATS_KEY = 'tabStats';
const statsReady = Promise.resolve(api.storage.session?.get(STATS_KEY))
  .then((got) => {
    for (const [tabId, frames] of Object.entries(got?.[STATS_KEY] ?? {})) {
      tabStats.set(Number(tabId), new Map(frames.map(([frameId, blurred, scanned]) => [frameId, { blurred, scanned }])));
    }
  })
  .catch(() => {});
let saveTimer = 0;

/** Change the counts once the saved ones are back, then save them. */
function editStats(change) {
  statsReady.then(() => {
    change();
    if (saveTimer || !api.storage.session) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      const out = {};
      for (const [tabId, frames] of tabStats) {
        if (frames.size) out[tabId] = [...frames].map(([frameId, s]) => [frameId, s.blurred, s.scanned]);
      }
      api.storage.session.set({ [STATS_KEY]: out }).catch(() => {});
    }, 500);
  });
}

function recordFrameStats(sender, { blurred, scanned }) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return;
  editStats(() => {
    let frames = tabStats.get(tabId);
    if (!frames) tabStats.set(tabId, (frames = new Map()));
    frames.set(sender.frameId ?? 0, { blurred, scanned });
    updateBadge(tabId);
  });
}

function totals(tabId) {
  let blurred = 0;
  let scanned = 0;
  for (const s of tabStats.get(tabId)?.values() ?? []) {
    blurred += s.blurred;
    scanned += s.scanned;
  }
  return { blurred, scanned };
}

function updateBadge(tabId) {
  const { blurred } = totals(tabId);
  const text = blurred ? (blurred > 999 ? '999+' : String(blurred)) : '';
  api.action.setBadgeText({ tabId, text }).catch?.(() => {});
  api.action.setBadgeBackgroundColor?.({ tabId, color: '#0f766e' })?.catch?.(() => {});
}

api.tabs.onRemoved.addListener((tabId) => editStats(() => tabStats.delete(tabId)));
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading' || !info.url) return;
  editStats(() => {
    tabStats.delete(tabId);
    updateBadge(tabId);
  });
});

// ---------------------------------------------------------------- popup / content requests

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'nh-offscreen') return false; // meant for the offscreen document
  if (msg?.t === 'hello') {
    let topHost = '';
    try {
      topHost = new URL(sender.tab?.url ?? '').hostname;
    } catch {}
    sendResponse({ topHost });
    return false;
  }
  if (msg?.t === 'status') {
    (async () => {
      let engine;
      try {
        engine = await getExecutor().status();
      } catch (err) {
        engine = { error: String(err?.message || err) };
      }
      await statsReady;
      sendResponse({ engine, cached: await cache.size(), tab: msg.tabId != null ? totals(msg.tabId) : null, modelVersion: CONFIG.version });
    })();
    return true;
  }
  if (msg?.t === 'peek' && sender.url?.startsWith(api.runtime.getURL(''))) {
    // Extension pages only (popup, tests): raw scores for one URL.
    cache.get(msg.url).then(sendResponse);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- context menu

async function createMenus() {
  if (!api.contextMenus) return;
  // Titles follow the language chosen in the popup (EN / ع), not only the browser's.
  const tr = await translator(resolveLanguage((await loadSettings()).language));
  try {
    await api.contextMenus.removeAll();
  } catch {}
  const ignore = () => void api.runtime.lastError;
  api.contextMenus.create({ id: 'nh-reveal', title: tr('menuReveal'), contexts: ['image'] }, ignore);
  api.contextMenus.create({ id: 'nh-blur', title: tr('menuBlur'), contexts: ['image'] }, ignore);
}

let menuLanguage = null;
onSettingsChanged((s) => {
  if (menuLanguage !== null && s.language !== menuLanguage) createMenus();
  menuLanguage = s.language;
});
loadSettings().then((s) => {
  menuLanguage = s.language;
});

api.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id || !info.srcUrl) return;
  const t = info.menuItemId === 'nh-reveal' ? 'reveal' : info.menuItemId === 'nh-blur' ? 'block' : null;
  if (!t) return;
  api.tabs.sendMessage(tab.id, { t, src: info.srcUrl }, { frameId: info.frameId ?? 0 }).catch?.(() => {});
});

// ---------------------------------------------------------------- install

api.runtime.onInstalled.addListener(async () => {
  createMenus();
  warmUp();
  const stored = (await api.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY];
  const next = stored ? migrateSettings(stored) : { ...DEFAULT_SETTINGS };
  if (next) await api.storage.local.set({ [SETTINGS_KEY]: next });
});

// ---------------------------------------------------------------- open tabs after a restart

/**
 * Content scripts in tabs that were open before this extension instance started (install,
 * update, reload, re-enable, crash recovery) can no longer talk to it. They keep their pages
 * blurred but cannot scan. Give each such tab a fresh content script, which takes over.
 */
async function adoptOpenTabs() {
  let tabs;
  try {
    tabs = await api.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch {
    return; // no host permission yet (Firefox asks the user)
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.discarded) return; // reloads (with a fresh content script) when the user returns
      try {
        if ((await api.tabs.sendMessage(tab.id, { t: 'ping' }))?.pong) return; // already ours
      } catch {
        // no live content script in this tab
      }
      await api.scripting
        ?.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
        .catch(() => {});
    }),
  );
}

// storage.session survives service-worker restarts but not extension restarts, so this runs
// once per extension lifetime.
api.storage.session
  ?.get('started')
  .then(async ({ started }) => {
    if (started) return;
    await api.storage.session.set({ started: Date.now() });
    adoptOpenTabs();
  })
  .catch(() => adoptOpenTabs());

api.runtime.onStartup?.addListener(() => {
  createMenus();
  warmUp();
});
