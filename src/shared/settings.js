import { api } from './browser.js';

export const SETTINGS_KEY = 'settings';

// Bump when a default changes in a way existing installs should pick up (see migrateSettings).
export const SETTINGS_SCHEMA = 4;

export const DEFAULT_SETTINGS = Object.freeze({
  schema: SETTINGS_SCHEMA,
  enabled: true,
  blurFemale: true,
  blurMale: false,
  /** Blur nudity and explicit images, whoever is in them. */
  blurNudity: true,
  /** 'relaxed' | 'balanced' | 'strict' */
  sensitivity: 'balanced',
  /** Blur when a person is visible but the model cannot tell the gender (back view, tiny, cropped). */
  blurUnknown: true,
  /** Keep images blurred until they have been scanned, so nothing flashes unfiltered. */
  blurWhileScanning: true,
  /** Keep images blurred when they cannot be downloaded/decoded for scanning. */
  failClosed: true,
  /** Blur radius in CSS pixels (60% of the old 48 px maximum). Not in the popup. */
  blurAmount: 28.8,
  /** Images smaller than this (rendered or natural, either side) are ignored as icons. Not in the popup. */
  minSize: 24,
  /** Hostnames where the extension is switched off. */
  disabledSites: [],
  /** Interface language: 'auto' (browser language), 'en' or 'ar'. */
  language: 'auto',
});

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!['relaxed', 'balanced', 'strict'].includes(s.sensitivity)) s.sensitivity = DEFAULT_SETTINGS.sensitivity;
  if (!['auto', 'en', 'ar'].includes(s.language)) s.language = DEFAULT_SETTINGS.language;
  s.blurAmount = clampNumber(s.blurAmount, 4, 60, DEFAULT_SETTINGS.blurAmount);
  s.minSize = clampNumber(s.minSize, 16, 256, DEFAULT_SETTINGS.minSize);
  if (!Array.isArray(s.disabledSites)) s.disabledSites = [];
  return s;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export async function loadSettings() {
  try {
    const got = await api.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(got?.[SETTINGS_KEY]);
  } catch {
    return normalizeSettings(null);
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await api.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Upgrade settings saved by an older version. Returns the upgraded object, or null if unchanged. */
export function migrateSettings(raw) {
  if (!raw || raw.schema >= SETTINGS_SCHEMA) return null;
  // Options that left the popup go back to their defaults: "ignore images smaller than" in schema 3
  // (v1 also skipped everything under 48px, which left search-result thumbnails unfiltered) and
  // "blur strength" in schema 4.
  return { ...raw, schema: SETTINGS_SCHEMA, minSize: DEFAULT_SETTINGS.minSize, blurAmount: DEFAULT_SETTINGS.blurAmount };
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) callback(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}

export function isSiteDisabled(settings, hostname) {
  if (!hostname) return false;
  const host = hostname.replace(/^www\./, '');
  return settings.disabledSites.some((d) => host === d || host.endsWith('.' + d));
}
