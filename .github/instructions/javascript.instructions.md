---
description: "Use when writing or modifying any JavaScript module under javascript/ — covers state validation, error handling, tracked event listeners, safe async wrappers, immutable updates, and the security/storage/icon conventions enforced across the extension."
applyTo: "javascript/**/*.js"
---

# JavaScript Module Conventions

> Project-wide context lives in [CLAUDE.md](../../CLAUDE.md) and [documentation/AGENTS.md](../../documentation/AGENTS.md). This file is the implementation playbook for the `javascript/` tree.

## Module map

| Folder | Role | Key exports |
|---|---|---|
| `javascript/entry-points/` | Page controllers (newtab, manage, popup) | `script.js`, `manageScript.js`, `popup.js` — also define `addTrackedEventListener` / `removeTrackedEventListener` / `cleanupAllEventListeners` for the page. |
| `javascript/core-systems/` | Business logic — the spine of the app | `stateManager.js`, `storageManager.js`, `syncManager.js`, `uiManager.js`, `linkManager.js`, `categoryManager.js`, `debug.js` |
| `javascript/features/` | Specialized, swappable modules | `errorHandler.js`, `securityUtils.js`, `iconCache.js`, `utils.js`, `domOptimizer.js`, `consoleCommands.js`, `dataVerification.js`, `syncStatusIndicator.js`, `syncSettingsController.js` |
| `javascript/background/` | Manifest V3 service worker | `service-worker.js` (ESM — `type: "module"` in manifest) |

All modules are ESM. **Every import must include the `.js` extension** (e.g. `import { x } from './foo.js'`, never `'./foo'`).

## State changes — always go through `safeUpdateState`

Never mutate state directly. Use `safeUpdateState(updates, options)` from [`javascript/core-systems/stateManager.js`](../../javascript/core-systems/stateManager.js). It runs `validateStateChanges()` against `stateSchemas` and rolls back on error.

Schemas enforce (see `stateManager.js:10-70`):

- `links` — array of objects; each link has `name` (1-100 chars), `url` (valid URI), `category` (1-50 chars), `icon` (≤500 chars or null), `size` (enum or null).
- `theme` — `'dark' | 'light'`
- `colorTheme` — enum: `default`, `ocean`, `cosmic`, `sunset`, `forest`, `fire`, `aurora`, `theme-purple`, `theme-pink`, `theme-green`, `theme-orange`, `theme-teal`, `theme-focus`, `theme-dark-orange`, `theme-dark-purple`, `theme-dark-emerald`, `theme-dark-crimson`, `theme-dark-sapphire`
- `view` — `'grid' | 'list'`
- `defaultTileSize` — enum: `compact`, `small`, `medium`, `large`, `square`, `wide`, `tall`, `giant`
- `categories` — array of strings (1-50 chars each)
- `searchTerm` — string (≤200 chars)

When adding a new state field, **add a schema entry first** — validation is the contract.

## Errors — use `CodexError` + `handleError` + `safeAsync`

From [`javascript/features/errorHandler.js`](../../javascript/features/errorHandler.js):

- Throw `new CodexError(message, type, severity, details)` — error types live in `ERROR_TYPES` (`SECURITY`, `VALIDATION`, `AUTHENTICATION`, `STORAGE`, `SYNC`, `QUOTA`, `NETWORK`, `TIMEOUT`, `DOM`, `STATE`, `EXTERNAL`, `UNKNOWN`).
- Call `handleError(error, { context, showNotifications, allowRecovery, logToConsole })` at the top of catch blocks; it logs, normalizes, and routes to user notifications.
- Wrap async functions with `safeAsync(fn, { context, fallbackValue, retryAttempts, retryDelay, onError })` so failures never throw out of event handlers.
- The synchronous sibling `safeSync(fn, { context, fallbackValue })` exists for the same purpose.

Pattern:

```javascript
// javascript/features/<module>.js
import { CodexError, ERROR_TYPES, safeAsync } from './errorHandler.js';

export const doRiskyThing = safeAsync(async (input) => {
  if (!isValid(input)) {
    throw new CodexError(`Bad input: ${input}`, ERROR_TYPES.VALIDATION);
  }
  return await chrome.storage.sync.set({ key: input });
}, { context: 'doRiskyThing', fallbackValue: null });
```

## Event listeners — tracked, not raw

Entry-point files (`script.js`, `manageScript.js`, `popup.js`) define `addTrackedEventListener` / `removeTrackedEventListener` / `cleanupAllEventListeners`. **Always use the tracked variants** for listeners you may need to clean up — they push to a registry that `cleanupAllEventListeners` drains on teardown (see `script.js:31-53`).

Never call raw `addEventListener` on long-lived elements; raw listeners leak across hot-reloads and re-initializations.

## Storage — sync primary, local fallback, quota-aware

`storageManager.js` is the only module that should call `chrome.storage.*` directly from business logic.

- Primary: `chrome.storage.sync` (100KB total, 8KB/item).
- Fallback: `chrome.storage.local` for offline access and overflow.
- Watch for the **8KB per-item limit** (`storageManager.js:160-178`); when a payload would exceed it, throw a `CodexError` with `ERROR_TYPES.QUOTA` and `ERROR_SEVERITY.HIGH`.
- Always handle quota-exceeded errors gracefully — the user may not be at fault (it's a per-origin, per-profile cap).

## Security — sanitize every input

From [`javascript/features/securityUtils.js`](../../javascript/features/securityUtils.js):

- `sanitizeHTML(input)` before any `innerHTML` assignment.
- `validateAndSanitizeUrl(url)` before storing a user-supplied URL or assigning it to `href` / `src`.
- `utils.js` also exports `debounce` and `throttle` — use them for search and scroll handlers.
- The CSP in [manifest.json](../../manifest.json) is the hard boundary; never reference origins outside the `script-src` / `connect-src` / `img-src` allowlists.

## Icon loading — progressive enhancement

Use `loadIconWithCache(url, options)` from [`javascript/features/iconCache.js`](../../javascript/features/iconCache.js). It cascades:

1. User-supplied `icon` (custom URL or `'default'`)
2. Clearbit logo (`https://logo.clearbit.com/<host>`)
3. High-res favicon
4. Text fallback (first letter of `name` on a colored tile)

Do not reinvent this cascade inline — the cache is shared across tiles and re-rolling it loses deduping and retry logic.

## Code style

- JSDoc on every exported function (params, return type, throws).
- Small files: 200-400 lines typical, 800 max. Split before that.
- Pure functions where possible; side effects in entry-points only.
- No `console.log` left in production code — wrap with the `debug` helpers in [`javascript/core-systems/debug.js`](../../javascript/core-systems/debug.js).
- Imports use `.js` extension. Sort: stdlib → external → internal alphabetical.
