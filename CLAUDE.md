# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The Codex is a Chrome Extension (Manifest V3) that transforms the new tab page into a customizable dashboard with drag-and-drop tile management, advanced sync capabilities, and intelligent icon loading.

> Conventions, patterns, code style, and security guidance live in [documentation/AGENTS.md](documentation/AGENTS.md).
> Subfolder-specific guidance (plans, impl notes, kits, designs, refs) lives in [context/CLAUDE.md](context/CLAUDE.md).

## Development Commands

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests
npm run test:e2e         # End-to-end tests
npm run test:critical-bugs # Critical bug regression tests
npm run test:regression  # Regression tests

# Run a single test file
npm test -- tests/unit/state-management.test.js

# Run tests matching a pattern
npm test -- --testNamePattern="should validate state"

# Development
npm run test:watch       # Watch mode for development
npm run test:coverage    # Generate coverage report
npm run lint             # Run ESLint
npm run lint:fix         # Auto-fix lint issues

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
- Primary: `chrome.storage.sync` for cross-device sync (100KB limit, 8KB/item)
- Fallback: `chrome.storage.local` for offline access
- Always handle quota exceeded errors gracefully

### Theme System
- Flat, calm design; dark/light only (the multi–color-theme system was removed).
- Design tokens live in each stylesheet's `:root` (surfaces, borders, one muted accent). Flattening a token flattens every surface at once — no glass, gradients, glow, or hover-lift.
- Base themes: `dark`, `light` (`body.dark` / `body.light`).
- Shared content width: both the new tab and the manage page use `--content-max: 1080px` so the two surfaces line up.
- Tile sizes: `compact`, `small`, `medium`, `large`, `square`, `wide`, `tall`, `giant`

### Icon Loading
- Progressive enhancement: custom (`data:` or selfh.st/jsDelivr only) > [selfh.st/icons](https://selfh.st/icons) match by app name (via jsDelivr) > Google favicon proxy (public sites) > generated text initials
- Icons resolve to known hosts only (jsDelivr, selfh.st, Google), so the CSP needs no `img-src` wildcard; homelab/internal apps get logos by name without contacting the internal host
- Use `loadIconWithCache()` for efficient loading
- **Icon Picker** (`features/iconPicker.js`): search the selfh.st library with probe-verified previews — only icons that actually loaded can be chosen; the custom-URL path is gated on host validation plus a live image load
- **Icon catalog index** (`features/iconIndex.js`): fetched at runtime from pinned hosts (cdn.selfh.st / jsDelivr, see CSP `connect-src`), cached in `chrome.storage.local` for a week — enables ranked substring search ("vmware" → `vmware-esxi`, …); when unreachable the picker falls back to exact-slug probe matching
- **Offline icon store** (`features/iconStore.js`): resolved icons are byte-cached in `chrome.storage.local` as `data:` URIs (6MB LRU budget, weekly stale-while-revalidate) so tiles render instantly and offline instead of re-fetching per new tab; hosts that refuse CORS byte-fetches (e.g. Google favicons) gracefully fall back to the network-only probe path
- **Icons render verbatim**: the stored `link.icon` is exactly what displays — NEVER auto-substitute a different image for it (a theme-recolor auto-swap was shipped in 7.0.0.31 and rejected by the user in 7.0.0.32). selfh.st's `-light`/`-dark` recolors appear as ordinary picker results (ranked after the base icon) for users to choose deliberately. Never apply `border-radius` to `.tile-icon` — it masks/clips logo artwork
- **Save-time validation**: `validateIconValue()` in `iconCache.js` is the single source of truth for what may be persisted as `link.icon` (`'default'`, `data:image` URIs, or https on selfh.st/jsDelivr). `addLink`/`editLink` throw on anything else; imports coerce invalid icons to `'default'`

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
- **`key`**: manifest `key` pins the extension ID to the published Web Store ID (`dimphibhkgnildpnlapckpgnonmaiddj`). Do NOT remove or change it — a stable ID is what lets an unpacked/dev build share the same `chrome.storage.sync` data as the published extension (and across devices). Without it, an unpacked build gets a per-machine ID and its data is isolated.
- **Versioning**: bump the `manifest.json` `version` build component (the 4th number in `7.0.0.X`) in **every PR**, so a tester can tell from `edge://extensions` which build they're running.
- **Permissions**: storage, bookmarks, activeTab
- **CSP**: `script-src 'self'; object-src 'none'; base-uri 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://cdn.jsdelivr.net https://selfh.st https://*.selfh.st https://www.google.com https://*.gstatic.com; connect-src 'self' https://cdn.jsdelivr.net https://*.selfh.st https://data.jsdelivr.com https://www.google.com https://*.gstatic.com;` — no `img-src` wildcard: tile icons come from the [selfh.st/icons](https://selfh.st/icons) library (via jsDelivr) matched by app name, with the Google favicon proxy as fallback (served from `*.gstatic.com`); custom icons must be `data:` URIs or selfh.st/jsDelivr URLs (`*.selfh.st` covers `cdn.selfh.st`, which the code allowlist accepted but the CSP previously blocked)
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

- Jest with jsdom environment for unit/integration tests
- Mock Chrome APIs in [tests/setup.js](tests/setup.js)
- Test files follow `*.test.js` naming
- Real Chrome tests in [tests/real-chrome-tests/](tests/real-chrome-tests/) directory
- ESLint configured with browser and Chrome extension globals
