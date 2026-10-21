# Test Coverage Documentation

## Overview

This document provides comprehensive documentation of the test suite for The Codex Chrome Extension.

## Test Layout

Suites live in `tests/unit/` (`npm run test:unit`) and `tests/integration/` (`npm run test:integration`); together they are everything `npm test` runs. Counts change with every PR, so none are recorded here — `npm test` prints the current totals, and CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the full suite plus `npm run lint` on every PR.

## Test Suite Breakdown

Selected suites (not exhaustive — see `tests/unit/` and `tests/integration/` for the full list).

### 1. category-manager.test.js
Tests category CRUD operations and management:
- `populateCategories` - Category population from storage
- `createCategory` - Category creation with validation
- `renameCategory` - Category renaming
- `deleteCategory` - Category deletion
- `reorderCategories` - Category reordering

### 2. chrome-storage-fixes.test.js
Tests Chrome storage corruption fixes:
- Object corruption handling
- Array corruption handling
- Type coercion corruption handling
- Missing field corruption handling

### 3. critical-bug-fixes.test.js
Tests general application functionality:
- State management
- Link operations (add, delete, validate)
- Category management
- UI interactions
- Data validation
- User input sanitization

### 4. debug.test.js
Tests debug logging utility:
- Debug toggle (enable/disable)
- `debug()` function
- `debugWarn()` function
- `debugError()` function
- State persistence
- Error handling

### 5. error-handler.test.js
Tests error handling system:
- CodexError class creation
- Error normalization
- Recovery strategies
- User message generation
- Error logging
- Safe async/sync wrappers
- Error boundaries
- Error handler registration

### 6. icon-cache.test.js
Tests icon loading and caching:
- Exported function tests
- Cache statistics
- loadIconWithCache functionality
- Batch operations
- Edge cases (long names, special characters, Unicode, emoji)

### 7. link-management.test.js
Tests link CRUD operations:
- Adding valid links
- Invalid URL handling
- Required field validation
- Deleting links
- Bulk operations (delete, move, resize)
- Editing links

### 8. security-utils.test.js
Tests security utilities:
- HTML purification (sanitizeHTML)
- Schema validation (validateSchema)
- Link validation (validateLink)
- User input sanitization
- URL validation (validateAndSanitizeUrl, isValidUrlFormat)
- XSS prevention

### 9. sync-manager.test.js
Tests sync manager functionality:
- Initialization
- Device ID management
- Sync metadata
- Conflict resolution
- Data validation
- Sync status
- Sync listeners

### 10. state-management.test.js
Tests state management system:
- State initialization
- State updates
- State validation
- Filter updates
- Category management
- Theme changes

### 11. sync-manager.test.js
Tests sync manager functionality:
- Initialization
- Device ID management
- Sync metadata
- Conflict resolution
- Data validation
- Sync status
- Sync listeners

### 12. utils.test.js
Tests utility functions:
- `debounce()` - Function debouncing
- `throttle()` - Function throttling
- `sanitizeHTML()` - HTML sanitization
- `validateAndSanitizeUrl()` - URL validation and sanitization
- `isValidUrlFormat()` - URL format validation
- `extractDomain()` - Domain extraction from URLs

## Code Coverage by Module

### Core Systems
| Module | Test File | Coverage |
|--------|-----------|----------|
| storageManager.js | chrome-storage-fixes.test.js | High |
| stateManager.js | state-management.test.js | High |
| syncManager.js | sync-manager.test.js | High |
| uiManager.js | N/A | Low (requires complex DOM mocking) |
| linkManager.js | link-management.test.js | High |
| categoryManager.js | category-manager.test.js | High |
| debug.js | debug.test.js | Complete |

### Features
| Module | Test File | Coverage |
|--------|-----------|----------|
| errorHandler.js | error-handler.test.js | Complete |
| securityUtils.js | security-utils.test.js | Complete |
| iconCache.js | icon-cache.test.js | High |
| consoleCommands.js | N/A | Low (developer tool) |
| utils.js | utils.test.js | Complete |
| dataVerification.js | N/A | Low (requires storage API) |

## Known Limitations

1. **uiManager.js** - Requires complex DOM mocking for integration testing
   - Functions like `getElements()`, `renderLinks()`, `setupModalListeners()` depend on browser DOM
   - Would require extensive DOM setup or browser automation testing

2. **Entry points** (script.js, popup.js, manageScript.js)
   - Not directly tested as they're integration points
   - Functionality covered through module-level tests

3. **Developer tools** (consoleCommands.js, dataVerification.js)
   - Designed for interactive debugging use
   - Would require storage API mocking for comprehensive testing

## Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- tests/unit/category-manager.test.js

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch

# Run linting
npm run lint
```

## Test Coverage Summary

The test suite provides comprehensive coverage of:
- **Business Logic**: All core business logic modules have extensive tests
- **Error Handling**: Complete coverage of error handling system
- **Security**: Comprehensive security validation tests
- **Sync Functionality**: Full coverage of sync operations including conflict resolution
- **State Management**: Complete coverage of state validation and updates
- **Utilities**: Complete coverage of utility functions

The only untested areas are:
- UI rendering and DOM manipulation (requires complex mocking)
- Entry point integration (covered indirectly through module tests)
- Developer console commands (interactive tools)

This represents excellent coverage for a Chrome Extension where:
- Core business logic is fully tested
- Security-critical operations are validated
- Error handling is comprehensive
- Data integrity is verified

## Continuous Improvement

To maintain and improve test coverage:
1. Add tests for new features as they're developed
2. Update tests when fixing bugs
3. Add edge case tests for security-critical operations
4. Monitor test coverage metrics
5. Regular code reviews of test quality