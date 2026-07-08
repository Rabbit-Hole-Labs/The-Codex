# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

> Commands, architecture tree, data schemas, and Chrome extension specifics live in [CLAUDE.md](../CLAUDE.md).
> Subfolder-specific guidance (plans, impl notes, kits, designs, refs) lives in [context/CLAUDE.md](../context/CLAUDE.md).

## Modular Architecture

The Codex Chrome extension follows a modular architecture with clearly defined components that interact through well-defined interfaces:

### Core Systems
The core systems provide the foundational functionality:
- **Storage Manager**: Handles data persistence using Chrome's storage APIs with sync (primary) and local (fallback) strategies
- **State Manager**: Manages application state with validation and immutable update patterns
- **Sync Manager**: Coordinates data synchronization across devices
- **UI Manager**: Handles user interface rendering and updates
- **Link Manager**: Manages link data structures and operations
- **Category Manager**: Organizes links into categories for better organization

### Entry Points
Entry points serve as the initialization points for different parts of the extension:
- **script.js**: Main page entry point that initializes the core systems
- **popup.js**: Chrome extension popup entry point
- **manageScript.js**: Management page entry point

### Feature Modules
Feature modules provide specialized functionality:
- **Error Handler**: Centralized error handling with the CodexError class
- **Security Utils**: Input sanitization and URL validation
- **Icon Cache**: Efficient icon loading and caching system
- **Utils**: General utility functions
- **DOM Optimizer**: Performance optimizations for DOM operations
- **Console Commands**: Development and debugging utilities
- **Data Verification**: Data integrity checking tools
- **Sync Status Indicator**: Visual feedback for sync operations
- **Sync Settings Controller**: UI controller for sync configuration

## Critical Patterns

- **State management**: Use `safeUpdateState()` with validation for all state changes
- **Error handling**: Use `CodexError` class with `handleError()` for all errors
- **Event listeners**: Use `addTrackedEventListener()` for proper cleanup
- **Async operations**: Wrap with `safeAsync()` for automatic error handling
- **Icon loading**: Uses progressive enhancement with caching via `loadIconWithCache()`
- **State updates**: Trigger automatic re-rendering through state change listeners
- **Link validation**: Happens at multiple levels (input, state update, and rendering)
- **Drag and drop**: Uses tracked event listeners with proper cleanup
- **Theme system**: Applies CSS custom properties with `!important` to override default styles
- **Performance optimization**: Uses debouncing for search and batch loading for icons
- **Data integrity**: Maintained through validation schemas in state manager
- **Extension initialization**: Has multiple fallback layers for robust startup

## Code Style

- ES6 modules with import/export (all imports must include `.js` extension)
- JSDoc comments for all functions
- Console logs for debugging (removed in production)
- Strict validation of all user inputs and data
- Defensive programming — never assume data structure
- Prefer small focused files: 200-400 lines typical, 800 max
- Use immutable update patterns; never mutate state in place

## Security

- Sanitize all user inputs with `sanitizeHTML()`
- Validate all URLs with `validateAndSanitizeUrl()`
- Use CSP-compliant external resources only (see CSP in [CLAUDE.md](../CLAUDE.md))
- Never store credentials in source code
- All file paths and external resources must respect the manifest's CSP

## Test Conventions

- Test files use `*.test.js` naming and live under [tests/](../tests/) (Jest picks up `tests/**/*.test.js`; the `test:unit` / `test:integration` / `test:e2e` scripts reference `tests/unit`, `tests/integration`, `tests/e2e` folders per [package.json](../package.json))
- Critical bug tests in [tests/real-chrome-tests/critical-bug-tests.js](../tests/real-chrome-tests/critical-bug-tests.js)
- Jest with jsdom test environment; Chrome APIs are mocked in [tests/setup.js](../tests/setup.js)
- See [TESTING.md](../TESTING.md) for the full testing guide
