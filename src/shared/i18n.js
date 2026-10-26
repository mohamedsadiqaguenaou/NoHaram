// UI strings from _locales/<lang>/messages.json, with a user-chosen language (EN / ع) that can
// differ from the browser's. Used by the popup and the background (context menu titles).
import { api } from './browser.js';

export const LANGUAGES = ['en', 'ar'];
const cache = new Map();

/** 'auto' follows the browser; anything else must be one of LANGUAGES. */
export function resolveLanguage(setting) {
  if (LANGUAGES.includes(setting)) return setting;
  const ui = (api.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase();
  return LANGUAGES.find((l) => ui.startsWith(l)) ?? 'en';
}

async function loadMessages(lang) {
  if (!cache.has(lang)) {
    cache.set(
      lang,
      fetch(api.runtime.getURL(`_locales/${lang}/messages.json`))
        .then((r) => r.json())
        .catch(() => ({})),
    );
  }
  return cache.get(lang);
}

/** Returns t(key, ...substitutions) for the language; falls back to English, then the key. */
export async function translator(lang) {
  const [own, en] = await Promise.all([loadMessages(lang), lang === 'en' ? null : loadMessages('en')]);
  return (key, ...subs) => {
    const entry = own?.[key] ?? en?.[key];
    if (!entry) return key;
    return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name) => {
      const content = entry.placeholders?.[name.toLowerCase()]?.content;
      if (!content) return whole;
      return content.replace(/\$(\d)/g, (_, n) => String(subs[Number(n) - 1] ?? ''));
    });
  };
}
