# Project Documentation Rules (Non-Obvious Only)

- "javascript/entry-points/script.js" contains the main application logic for the new tab page
- "javascript/core-systems/storageManager.js" handles all Chrome storage operations with corruption protection
- "javascript/core-systems/stateManager.js" provides immutable state management with validation and rollback
- "javascript/features/errorHandler.js" implements comprehensive error handling with user notifications
- "javascript/features/iconCache.js" manages icon loading with caching and fallback strategies
- Critical bug tests in `tests/real-chrome-tests/critical-bug-tests.js` verify storage corruption fixes
- Theme system uses CSS custom properties with `!important` for theme overrides
- Tile sizes: compact, small, medium, large, square, wide, tall, giant
- View modes: grid (default) and list
- Storage strategy: sync (primary) with local (fallback) for offline access
- Error handling patterns: Try-catch blocks around all async operations with CodexError class
- Event management: Proper cleanup with removeEventListener via tracked listeners
- State updates: Always save to storage after state mutations using safeUpdateState()
- Console commands available: CodexConsole.help(), CodexConsole.compare(), CodexConsole.sync()
- Icon system uses progressive enhancement: custom icons → Clearbit → favicons → text fallbacks