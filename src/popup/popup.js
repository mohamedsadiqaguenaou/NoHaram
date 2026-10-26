import { api, IS_MOBILE } from '../shared/browser.js';
import { resolveLanguage, translator } from '../shared/i18n.js';
import { isSiteDisabled, loadSettings, saveSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const HINTS = { relaxed: 'hintRelaxed', balanced: 'hintBalanced', strict: 'hintStrict' };

let settings;
let t = (key) => key;
let lang = 'en';
let host = '';
let tabId = null;
let lastCounts = '';

// ---------------------------------------------------------------- language

async function applyLanguage() {
  lang = resolveLanguage(settings.language);
  t = await translator(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  lastCounts = ''; // re-render stats labels
}

// ---------------------------------------------------------------- current tab

async function readTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  try {
    const url = new URL(tab?.url ?? '');
    if (url.protocol === 'http:' || url.protocol === 'https:') host = url.hostname.replace(/^www\./, '');
  } catch {}
  if (tab?.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) {
    $('tabFavicon').src = tab.favIconUrl;
    $('tabFavicon').hidden = false;
    $('tabIcon').setAttribute('hidden', ''); // SVG elements have no .hidden property
  }
  if (tab?.title) $('tabTitle').title = tab.title;
}

// ---------------------------------------------------------------- render

function setChecked(el, on) {
  el.setAttribute(el.getAttribute('role') === 'switch' ? 'aria-checked' : 'aria-pressed', String(!!on));
}

function render() {
  const siteOn = !host || !isSiteDisabled(settings, host);
  // Nothing to blur at all: no gender chosen and the nudity filter off.
  const noneSelected = !settings.blurFemale && !settings.blurMale && !settings.blurNudity;
  const active = settings.enabled && siteOn && !noneSelected;

  $('tabTitle').textContent = host || t('notAWebsite');
  setChecked($('siteToggle'), !!host && siteOn);
  $('siteToggle').disabled = !host;

  $('powerBtn').classList.toggle('active', settings.enabled);
  $('powerLabel').textContent = t(settings.enabled ? 'powerTurnOff' : 'powerTurnOn');

  setChecked($('blurFemale'), settings.blurFemale);
  setChecked($('blurMale'), settings.blurMale);
  $('noneHint').hidden = !noneSelected;

  for (const b of $('sensitivity').querySelectorAll('[data-value]')) {
    b.setAttribute('aria-checked', String(b.dataset.value === settings.sensitivity));
    b.title = t(HINTS[b.dataset.value]);
  }

  $('statsPanel').classList.toggle('active', active);
  $('stateLabel').textContent = !settings.enabled
    ? t('stateOff')
    : noneSelected
      ? t('stateChoose')
      : !siteOn
        ? t('stateSiteOff')
        : t('stateActive');

  // settings sheet
  setChecked($('blurNudity'), settings.blurNudity);
  setChecked($('blurWhileScanning'), settings.blurWhileScanning);
  setChecked($('blurUnknown'), settings.blurUnknown);
  setChecked($('failClosed'), settings.failClosed);
  for (const b of $('langSwitcher').querySelectorAll('button')) b.classList.toggle('active', b.dataset.lang === lang);
}

function renderCounts(blurred, scanned) {
  const key = `${blurred}/${scanned}`;
  if (key === lastCounts) return;
  lastCounts = key;
  $('statBlurred').textContent = blurred.toLocaleString(lang);
  $('statScanned').textContent = scanned.toLocaleString(lang);
}

// ---------------------------------------------------------------- actions

async function update(patch) {
  settings = await saveSettings(patch);
  render();
}

function toggleSetting(id) {
  $(id).addEventListener('click', () => update({ [id]: !settings[id] }));
}

function openSettings(open) {
  $('settingsOverlay').hidden = !open;
  if (open) {
    refreshStatus();
    $('settingsClose').focus();
  } else {
    $('gearBtn').focus();
  }
}

function bind() {
  $('powerBtn').addEventListener('click', () => update({ enabled: !settings.enabled }));
  toggleSetting('blurFemale');
  toggleSetting('blurMale');
  toggleSetting('blurNudity');
  toggleSetting('blurWhileScanning');
  toggleSetting('blurUnknown');
  toggleSetting('failClosed');

  for (const b of $('sensitivity').querySelectorAll('[data-value]')) {
    b.addEventListener('click', () => update({ sensitivity: b.dataset.value }));
  }

  $('siteToggle').addEventListener('click', () => {
    if (!host) return;
    const sites = new Set(settings.disabledSites);
    if (isSiteDisabled(settings, host)) {
      for (const d of [...sites]) if (host === d || host.endsWith(`.${d}`)) sites.delete(d);
    } else {
      sites.add(host);
    }
    update({ disabledSites: [...sites] });
  });

  for (const b of $('langSwitcher').querySelectorAll('button')) {
    b.addEventListener('click', async () => {
      settings = await saveSettings({ language: b.dataset.lang });
      await applyLanguage();
      render();
      refreshStatus();
    });
  }

  $('gearBtn').addEventListener('click', () => openSettings(true));
  $('settingsClose').addEventListener('click', () => openSettings(false));
  $('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('settingsOverlay')) openSettings(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settingsOverlay').hidden) openSettings(false);
  });

  $('grant').addEventListener('click', async () => {
    const granted = await api.permissions.request({ origins: ['<all_urls>'] });
    if (granted) $('permission').hidden = true;
  });
}

// ---------------------------------------------------------------- status polling

async function refreshStatus() {
  let status;
  try {
    status = await api.runtime.sendMessage({ t: 'status', tabId });
  } catch {
    return;
  }
  if (!status) return;
  renderCounts(status.tab?.blurred ?? 0, status.tab?.scanned ?? 0);
}

async function checkPermission() {
  try {
    $('permission').hidden = await api.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    $('permission').hidden = true;
  }
}

document.documentElement.classList.toggle('mobile', IS_MOBILE);

(async () => {
  settings = await loadSettings();
  await Promise.all([applyLanguage(), readTab()]);
  render();
  bind();
  checkPermission();
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
