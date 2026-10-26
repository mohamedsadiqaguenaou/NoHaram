// Firefox exposes `browser` (promise based); Chromium exposes `chrome` (promise based in MV3).
export const api = globalThis.browser ?? globalThis.chrome;

export const IS_FIREFOX = typeof globalThis.browser !== 'undefined' && /firefox/i.test(navigator.userAgent);

export const IS_MOBILE =
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPadOS reports as Mac

/** True while this script can still talk to the extension (false after an update/uninstall). */
export function contextAlive() {
  try {
    return !!api?.runtime?.id;
  } catch {
    return false;
  }
}
