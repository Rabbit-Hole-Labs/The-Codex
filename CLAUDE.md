# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The Codex is a Chrome Extension (Manifest V3) that transforms the new tab page into a customizable dashboard with drag-and-drop tile management, advanced sync capabilities, and intelligent icon loading.

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

### Error Handling
- Use `CodexError` class from `errorHandler.js` for all errors
- Wrap async operations with `safeAsync()` for automatic error handling
- Error types: SECURITY, VALIDATION, STORAGE, SYNC, NETWORK, DOM, STATE, EXTERNAL

### Storage Strategy
- Primary: `chrome.storage.sync` for cross-device sync (100KB limit, 8KB/item)
- Fallback: `chrome.storage.local` for offline access
- Always handle quota exceeded errors gracefully

### Theme System
- CSS custom properties with `!important` for theme overrides
- Themes: dark/light mode + 7 color themes (default, ocean, cosmic, sunset, forest, fire, aurora)
- Tile sizes: compact, small, medium, large, square, wide, tall, giant

### Icon Loading
- Progressive enhancement: custom > Clearbit logos > high-res favicons > text fallbacks
- Use `loadIconWithCache()` for efficient loading

## Data Schemas

### Link Object
```javascript
{
  id: string,        // Auto-generated unique ID
  name: string,      // Site name (1-100 chars)
  url: string,       // Full URL (validated)
  category: string,  // Category name (1-50 chars)
  icon: string|null, // Icon URL or 'default'
  size: string|null  // Tile size override
}
```

### State Object
```javascript
{
  links: Link[],
  theme: 'dark' | 'light',
  colorTheme: 'default' | 'ocean' | 'cosmic' | 'sunset' | 'forest' | 'fire' | 'aurora',
  view: 'grid' | 'list',
  searchTerm: string,
  defaultTileSize: string,
  categories: string[],
  filteredLinks: Link[],
  // ... drag state
}
```

## Chrome Extension Specifics

- **Manifest V3** with service worker background scripts
- **Permissions**: storage, bookmarks, activeTab, tabs
- **CSP**: script-src 'self'; object-src 'self'; img-src 'self' data: https:
- **Overrides**: newtab (index.html), browser_action (popup.html)

## Debugging

Access console commands in Chrome DevTools:
```javascript
CodexConsole.help()    // Show all commands
CodexConsole.compare() // Compare local vs cloud data
CodexConsole.sync('local') // Force sync with local wins
```

## Testing

- Jest with jsdom environment for unit/integration tests
- Mock Chrome APIs in tests/setup.js
- Test files follow `*.test.js` naming
- Run real Chrome tests: `tests/real-chrome-tests/`
