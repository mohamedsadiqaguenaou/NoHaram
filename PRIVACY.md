# Privacy policy

NoHaram is a browser extension that blurs pictures of women and/or men. It is built to work without sending anything anywhere.

## What NoHaram does not do

- It does not collect, store or share personal data.
- It does not send images, image addresses, page addresses or browsing history to any server. NoHaram has no server.
- It has no accounts, analytics, tracking, advertising or remote code.

## What happens on your device

- **Scanning:** to decide whether to blur an image, NoHaram downloads that image from the address the page already uses, directly from the website, the same way the page does. It then analyses it with AI models that ship inside the extension and run locally in your browser.
- **Settings:** your choices (who to blur, the nudity filter, sensitivity, language, sites you switched off) are saved in the browser's extension storage.
- **Result cache:** so the same image isn't analysed twice, NoHaram keeps a SHA-256 hash of each image address with its scores in the extension's local storage. The address itself is not stored. Removing the extension deletes this cache.
- **Badge counts:** the number of blurred and scanned images per open tab is kept in memory and in session storage while the browser runs.

## Permissions

NoHaram needs access to all websites to find and check images on every page you visit. The other permissions (`storage`, `contextMenus`, `scripting` and, in Chrome, `offscreen`) are explained in the [README](README.md#privacy).

## Changes

Any change to this policy will be published in this repository together with the code that needs it.
