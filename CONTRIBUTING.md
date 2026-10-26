# Contributing to NoHaram

Thanks for helping! Bug reports, accuracy reports, translations and code are all welcome.

## Ground rules

1. **Everything stays on the device.** No feature may send images, image addresses, page addresses or usage data anywhere. Network requests are only allowed for the images the page itself shows.
2. **Only existing, openly licensed models.** NoHaram uses published pre-trained models as they are. A new model must come with a license that allows redistribution in a free extension, such as MIT, Apache-2.0 or BSD. Research-only or non-commercial licenses don't qualify, for example Apple's AMLR, CC BY-NC, or InsightFace's research license. Add every new model to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and its license text to [`licenses/`](licenses).
3. **Fail safe.** An error, a timeout or a restart must never leave a picture unblurred that should be blurred.
4. **Keep pages fast.** The page's own thread only tracks images and applies CSS. Downloading, decoding and inference belong in the background engine.

## Getting started

```bash
npm install          # Node.js 22+; PUPPETEER_SKIP_DOWNLOAD=1 skips the test browser
npm run watch        # rebuilds dist/chrome on every change
```

Load `dist/chrome` as an unpacked extension (see the [README](README.md#install)), and reload it after each rebuild.

| Folder | What's in it |
|---|---|
| `src/content/` | Finds images on the page, keeps them blurred until checked, applies the verdicts |
| `src/background/` | Result cache, message routing, badge, and where the engine runs |
| `src/engine/` | Image loading, the two-stage model pipeline, the worker pool |
| `src/popup/` | The toolbar popup |
| `src/_locales/` | Translations |
| `scripts/` | Build script and model conversion and calibration tools |
| `test/` | End-to-end, lifecycle, flash and site-audit tests |

## Tests

The tests drive a real browser through Puppeteer. They need a folder of photos plus a `labels.json` that maps each file to `"female"`, `"male"`, `"both"` or `"none"`. No photos of people are included in this repository; `npm run models:evalset` downloads a suitable set.

Before opening a pull request, run:

```bash
npm run build:chrome
node test/e2e.mjs --images <dir>
node test/lifecycle.mjs --images <dir>
node test/flash.mjs --images <dir>
```

For changes to the content script or the engine, please also run the end-to-end test in Firefox: `node test/e2e.mjs --images <dir> --browser firefox`.

## Accuracy reports

If NoHaram blurs the wrong picture or misses one, open an issue with:
- the page address, if it's public
- whether it was a woman, a man, mixed or no person
- the sensitivity you use

**Please don't attach photos of people to issues.**

To change models, prompts or thresholds, follow the recalibration steps in the [README](README.md#development), and include the before and after numbers in your pull request.

## Translations

Strings live in `src/_locales/<lang>/messages.json`. To add a language:
1. Copy the English file.
2. Translate the `message` values.
3. Add the language code to:
   - `LANGUAGES` in `src/shared/i18n.js`
   - the allowed `language` values in `normalizeSettings` in `src/shared/settings.js`
   - the language switcher in `src/popup/popup.html`

## License

By contributing, you agree that your contributions are released under the project's [MIT License](LICENSE).
