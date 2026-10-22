# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

The Codex is a Chrome Extension (Manifest V3) that transforms the new tab page into a customizable dashboard with drag-and-drop tile management, advanced sync capabilities, and intelligent icon loading.

> Conventions, patterns, code style, and security guidance live in [documentation/AGENTS.md](documentation/AGENTS.md).
> Subfolder-specific guidance (plans, impl notes, kits, designs, refs) lives in [context/AGENTS.md](context/AGENTS.md).

## Development Commands

```bash
# Run all tests (tests/unit + tests/integration)
npm test

# Run specific test suites
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests

# Run a single test file
npm test -- tests/unit/state-management.test.js

# Run tests matching a pattern
npm test -- --testNamePattern="should validate state"

# Development
npm run test:watch       # Watch mode for development
npm run test:coverage    # Generate coverage report
npm run lint             # Run ESLint (CI gate: must exit 0)
npm run lint:fix         # Auto-fix lint issues

# Package (store upload zip; CI builds it on every PR and push to main as an artifact)
npm run package          # -> dist/the-codex-<version>.zip (key kept)
npm run package -- --strip-key  # same, without the manifest key (-nokey.zip)

# Load extension in Chrome
# 1. Open chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked" and select project folder
```

## Architecture

```
javascript/
├── entry-points/        # Page-specific controllers
│   ├── script.js       # Main newtab page
│   ├── manageScript.js # Management dashboard
│   └── popup.js        # Browser action popup
├── core-systems/       # Business logic
│   ├── storageManager.js   # Chrome storage (sync + local fallback)
│   ├── syncStorage.js     # links split across sync items (8KB/item cap)
│   ├── stateManager.js    # Centralized state with validation
│   ├── syncManager.js     # Cross-device synchronization
│   ├── uiManager.js       # Rendering and UI updates
│   ├── linkManager.js     # Link CRUD operations
│   └── categoryManager.js # Category organization
└── features/           # Specialized modules
    ├── errorHandler.js     # CodexError class + handleError()
    ├── securityUtils.js    # sanitizeHTML(), validateAndSanitizeUrl()
    ├── iconCache.js       # Progressive icon loading
    └── consoleCommands.js  # CodexConsole for debugging
```

## Key Patterns

### State Management
- Use `safeUpdateState()` with validation for all state changes
- State schemas enforce types, enums, and constraints at runtime
- Immutable update patterns - always create new state objects
- State change listeners trigger automatic re-rendering
- State history maintained for rollback (max 50 entries)

### Error Handling
- Use `CodexError` class from `errorHandler.js` for all errors
- Wrap async operations with `safeAsync()` for automatic error handling
- Error types: SECURITY, VALIDATION, STORAGE, SYNC, NETWORK, DOM, STATE, EXTERNAL

### Storage Strategy
- Primary: `chrome.storage.sync` for cross-device sync (100KB total, 8KB per item — key + value as Chromium's JSON writer serializes it, so the quotes inside the JSON-string `links` count twice)
- `links` is split across sync items by `core-systems/syncStorage.js`: `links` holds the whole list when it fits one item, else its first chunk, then `links.1`…`links.N`, plus `linksManifest` (`{ chunks, hashes }`). All of it is written in ONE `set()`; readers verify each chunk against the manifest, so change listeners skip another device's half-arrived save and Sync now refuses to decide from one. Every sync read or write that involves `links` MUST go through `syncGet`/`syncSet`/`readSyncLinks` — a raw `chrome.storage.sync.set({ links })` leaves a stale manifest and the list reads as inconsistent
- Fallback: `chrome.storage.local` for offline access
- The Sync tab's conflict strategy is per device: `syncConflictStrategy` in `chrome.storage.local`, read by `syncData()` on every run (`getConflictResolutionStrategy()` / `setConflictResolutionStrategy()`)
- Always handle quota exceeded errors gracefully

### Theme System
- Flat, calm design; dark/light only (the multi–color-theme system was removed).
- Design tokens live in each stylesheet's `:root` (surfaces, borders, one muted accent). Flattening a token flattens every surface at once — no glass, gradients, glow, or hover-lift.
- Base themes: `dark`, `light` (`body.dark` / `body.light`).
- Shared content width: both the new tab and the manage page use `--content-max: 1600px` (defined in `stylesheets/base.css`; the design kit mirrors it) so the two surfaces line up.
- Tile sizes: `compact`, `small`, `medium`, `large`, `square`, `wide`, `tall`, `giant`

### Icon Loading
- Progressive enhancement: custom (`data:` or selfh.st/jsDelivr only) > [selfh.st/icons](https://selfh.st/icons) match by app name (via jsDelivr) > Google favicon proxy (public sites) > generated text initials
- Icons resolve to known hosts only (jsDelivr, selfh.st, Google), so the CSP needs no `img-src` wildcard; homelab/internal apps get logos by name without contacting the internal host
- Use `loadIconWithCache()` for efficient loading
- **Icon Picker** (`features/iconPicker.js`): search the selfh.st library with probe-verified previews — only icons that actually loaded can be chosen; the custom-URL path is gated on host validation plus a live image load
- **Icon catalog index** (`features/iconIndex.js`): fetched at runtime from pinned hosts (cdn.selfh.st / jsDelivr, see CSP `connect-src`), cached in `chrome.storage.local` for a week — enables ranked substring search ("vmware" → `vmware-esxi`, …); when unreachable the picker falls back to exact-slug probe matching
- **Offline icon store** (`features/iconStore.js`): resolved icons are byte-cached in `chrome.storage.local` as `data:` URIs (6MB LRU budget, weekly stale-while-revalidate) so tiles render instantly and offline instead of re-fetching per new tab. Google favicons are deliberately NOT byte-fetched (network-only `<img>` path): the service sends no CORS headers, and a blocked cross-origin `fetch()` prints an uncatchable browser CORS error to the console per tile per tab
- **First paint, no pop-in** (`features/iconSources.js`): before building tiles, the new tab asks `resolveCachedIcons()` (waits at most 300 ms) for what this device already has — stored bytes of picked icons, remembered automatic matches (`iconSourcesV1` in `chrome.storage.local`: the selfh.st URL, Google favicon URL or `generated` each link matched last time; re-matched in the background after a week, initials after a day; a re-match that only reaches initials never replaces a remembered logo) — and paints those icons with the tiles (a remembered Google favicon that then fails to load falls back to a fresh match, down to initials). The rest resolve right after, `ICON_LOAD_CONCURRENCY` at a time (never the old 5-per-batch + 100 ms pauses)
- **Icon bytes don't sync** (`chrome.storage.sync` is 100KB for everything): each device fetches them. The service worker runs `warmIconStore()` for the picked icons of the synced links on startup/update and whenever synced links change, so a new tab finds them locally
- **Icons render verbatim**: the stored `link.icon` is exactly what displays — NEVER auto-substitute a different image for it (a theme-recolor auto-swap was shipped in 7.0.0.31 and rejected by the user in 7.0.0.32). selfh.st's `-light`/`-dark` recolors appear as ordinary picker results (ranked after the base icon) for users to choose deliberately. Never apply `border-radius` to `.tile-icon` — it masks/clips logo artwork
- **Save-time validation**: `validateIconValue()` in `iconPolicy.js` (dependency-free, re-exported by `iconCache.js`, shared with `design-kit/`) is the single source of truth for what may be persisted as `link.icon` (`'default'`, `data:image` URIs, or https on selfh.st/jsDelivr). `addLink`/`editLink` throw on anything else; imports coerce invalid icons to `'default'`

## Data Schemas

### Link Object
```javascript
{
  id: string,        // Auto-generated unique ID
  name: string,      // Site name (1-100 chars)
  url: string,       // Full URL (validated)
  category: string,   // Category name (1-50 chars)
  icon: string|null, // Icon URL or 'default'
  size: string|null  // Tile size override
}
```

### State Object
```javascript
{
  links: Link[],
  theme: 'dark' | 'light',
  colorTheme: string, // See theme system above
  view: 'grid' | 'list',
  searchTerm: string,
  defaultTileSize: string,
  categories: string[],
  filteredLinks: Link[],
  // ... drag state
}
```

## Chrome Extension Specifics

- **Manifest V3** with service worker background scripts ([manifest.json](manifest.json))
- **`key`**: manifest `key` pins the extension ID to the published Web Store ID (`dimphibhkgnildpnlapckpgnonmaiddj`). Do NOT remove or change it — a stable ID is what lets an unpacked/dev build share the same `chrome.storage.sync` data as the published extension (and across devices). Without it, an unpacked build gets a per-machine ID and its data is isolated. `npm run package` keeps `key` in the zip by default for the same reason (an unpacked load of the CI artifact shares the published ID); `--strip-key` builds a copy without it if the store ever rejects the field.
- **Versioning**: bump the `manifest.json` `version` build component (the 4th number in `7.0.0.X`) in **every PR**, so a tester can tell from `edge://extensions` which build they're running.
- **Permissions**: storage, bookmarks, activeTab
- **CSP**: `script-src 'self'; object-src 'none'; base-uri 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://cdn.jsdelivr.net https://selfh.st https://*.selfh.st https://www.google.com https://*.gstatic.com; connect-src 'self' https://cdn.jsdelivr.net https://*.selfh.st https://data.jsdelivr.com;` — no `img-src` wildcard: tile icons come from the [selfh.st/icons](https://selfh.st/icons) library (via jsDelivr) matched by app name, with the Google favicon proxy as fallback (served from `*.gstatic.com`); custom icons must be `data:` URIs or selfh.st/jsDelivr URLs (`*.selfh.st` covers `cdn.selfh.st`, which the code allowlist accepted but the CSP previously blocked)
- **Overrides**: newtab ([index.html](index.html)), browser_action ([popup.html](popup.html))
- **ES6 Modules**: Uses `"type": "module"` in [package.json](package.json); all imports must include `.js` extension
- Storage strategy: sync (primary) with local (fallback)

## Debugging

Access console commands in Chrome DevTools:
```javascript
CodexConsole.help()    // Show all commands
CodexConsole.compare() // Compare local vs cloud data
CodexConsole.sync('local') // Force sync with local wins
CodexConsole.validate() // Validate data integrity
CodexConsole.cloudData() // View raw cloud data
CodexConsole.localData() // View raw local data
```

## Testing

- Jest with jsdom environment; suites live in `tests/unit/` and `tests/integration/` (the two scripts together cover everything `npm test` runs)
- [tests/setup.js](tests/setup.js) only exposes `jest` as a global — it does not mock Chrome APIs; each suite stubs `global.chrome` itself
- Test files follow `*.test.js` naming
- Real Chrome tests in [tests/real-chrome-tests/](tests/real-chrome-tests/) directory (manual harness; not run by npm scripts or CI)
- ESLint ([eslint.config.mjs](eslint.config.mjs)) uses per-directory globals — extension pages: browser + `chrome`; service worker: serviceworker + `chrome`; tests: jest + browser + node; root tooling: node — and ignores `.claude/**` so nested worktrees are never linted
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `npm ci`, `npm run lint` and `npm test -- --ci --coverage` on every PR and push to `main`, and fails a PR whose `manifest.json` version is not greater than the base branch's. A separate job runs `npm run package` (manifest, reference and CSP checks), tests the zip with `unzip -t` and uploads `the-codex-<version>.zip` as the run's artifact
