---
description: "Use when writing or modifying tests under tests/ — covers Jest with ESM (`jest.unstable_mockModule`), jsdom, the per-file Chrome API mock pattern (tests/setup.js is intentionally minimal), and AAA structure."
applyTo: "tests/**/*.test.js"
---

# Test Conventions

> Project-wide test commands and Chrome extension context live in [CLAUDE.md](../../CLAUDE.md). This file is the test-author playbook.

## Test environment

| Environment | Where it runs | How it's invoked | Use it for |
|---|---|---|---|
| **Jest + jsdom** (default) | `tests/unit/*.test.js`, `tests/integration/*.test.js` | `npm test`, `npm run test:unit`, `npm run test:integration` | Unit, integration, regression. The everyday workhorse. |

Jest's `testMatch` (see [package.json](../../package.json)) is `["<rootDir>/tests/**/*.test.js", "<rootDir>/javascript/**/*.test.js"]`, so any `*.test.js` file under either tree is picked up automatically.

## Test layout — unit vs integration

```
tests/
├── setup.js                  # 3 lines: just exposes `jest` globally
├── helpers/
│   └── chromeStorageFake.js  # Quota-faithful chrome.storage fake (sync/local, async onChanged)
├── unit/                     # Single-module tests with mocked deps (npm run test:unit)
│   ├── category-manager.test.js
│   ├── chrome-storage-fake.test.js       # The chrome.storage fake itself
│   ├── debug.test.js
│   ├── domOptimizer.test.js
│   ├── error-capture-funnel.test.js
│   ├── error-capture.test.js
│   ├── error-handler.test.js
│   ├── icon-cache.test.js
│   ├── icon-index.test.js
│   ├── icon-matching.test.js
│   ├── icon-store.test.js
│   ├── icon-validation.test.js
│   ├── link-management.test.js
│   ├── link-mutations.test.js
│   ├── load-no-clobber.test.js
│   ├── load-quarantine.test.js           # New tab: bad stored values are coerced/hidden, never blank the page or get saved back
│   ├── package-extension.test.js         # scripts/package-extension.js (store zip build + reference check)
│   ├── security-fixes.test.js
│   ├── security-utils.test.js
│   ├── service-worker-migration.test.js  # One-time legacy colorTheme rewrite on extension update
│   ├── state-management.test.js
│   ├── storage-format.test.js
│   ├── sync-manager-data-loss.test.js    # Manual sync never reverts or loses cloud data
│   ├── sync-manager.test.js
│   ├── syncSettingsController.test.js
│   ├── syncStatusIndicator.test.js
│   ├── uiManager.test.js
│   └── utils.test.js
├── integration/              # Multi-module / cross-system tests (npm run test:integration)
│   ├── chrome-storage-fixes.test.js
│   └── critical-bug-fixes.test.js
└── e2e/                      # Playwright helpers only; no specs yet, not run by npm scripts or CI
```

When adding a new test, decide first whether it's **unit** (tests a single module, mocks its deps) or **integration** (exercises multiple real modules together). Put it in the matching folder so the right `npm run` script picks it up.

## `tests/setup.js` is intentionally minimal

The global setup file is **three lines**:

```javascript
import { jest } from '@jest/globals';
global.jest = jest;
console.log('Jest setup complete');
```

It does **not** mock Chrome APIs globally. Each test file declares the Chrome API surface it needs in its own `beforeEach` / top-level `global.chrome = {…}`. Follow the same pattern — don't add Chrome API mocks to `setup.js` "for convenience." See `tests/unit/category-manager.test.js` for the canonical pattern.

## ESM module mocking with `jest.unstable_mockModule`

The extension is `"type": "module"`, so tests use ESM. **Hoisted `jest.mock()` does not work for ESM imports.** Use `jest.unstable_mockModule()` from `@jest/globals` and `await import()` the module under test inside the test body.

### Path-resolution gotcha (the easy-to-miss one)

`jest.unstable_mockModule()` resolves module paths **relative to `tests/setup.js`**, NOT relative to the test file. Dynamic `import()` calls resolve relative to the test file. So the two have different "bases" even though they look similar:

```javascript
// tests/unit/category-manager.test.js
import { jest } from '@jest/globals';

// Mock path is relative to tests/setup.js, not this file.
// tests/setup.js lives at <root>/tests/setup.js, so ../javascript/... → <root>/javascript/...
jest.unstable_mockModule('../javascript/core-systems/storageManager.js', () => ({
  loadLinks: jest.fn(),
  saveLinks: jest.fn(),
}));

test('uses mocked storage', async () => {
  // Dynamic import is relative to THIS test file.
  // tests/unit/foo.test.js → ../../javascript/... → <root>/javascript/...
  const { doThing } = await import('../../javascript/features/foo.js');
  // ...
});
```

Include the `.js` extension in the mock path. The `moduleNameMapper` in [package.json](../../package.json) (`"^(\\.{1,2}/.*)\\.js$": "$1"`) only matches paths starting with `./` or `../`, so it processes the mock path and strips `.js` before resolution.

## Chrome API mocks — per-file, not global

Mock only what the test uses. The common pattern (from `category-manager.test.js`):

```javascript
const mockStorage = { get: jest.fn(), set: jest.fn() };

global.chrome = {
  storage: { local: mockStorage, sync: mockStorage },
  // add tabs/bookmarks/etc. as needed
};

// Mock window.confirm, global.confirm, etc., if the module calls them
global.confirm = jest.fn(() => true);
```

Reset between tests with `jest.resetModules()` in `beforeEach` so module-level state doesn't bleed across cases (see `state-management.test.js`).

## Test structure — AAA, but adapt to ESM

Prefer Arrange-Act-Assert:

```javascript
test('returns empty array when no markets match query', async () => {
  // Arrange
  const { filterLinks } = await import('../../javascript/core-systems/uiManager.js');

  // Act
  const result = filterLinks([], { searchTerm: 'nope' });

  // Assert
  expect(result).toEqual([]);
});
```

There are two established ways to get the module under test — pick by whether the test needs per-test mocks:

- **No module mocks or pre-import globals** → one static top-level `import { … } from '../../javascript/…';` (see `tests/unit/error-handler.test.js`). Module state is shared across the file, so reset it explicitly in each test (e.g. `clearErrorLog()`).
- **Mocks or globals must exist before the module loads** → set up `jest.unstable_mockModule(…)` and/or `global.chrome` / `global.document` first, then `await import()` the module inside each test (see `tests/unit/category-manager.test.js` and `tests/unit/security-utils.test.js`).

## Regression tests

Write a regression test in `tests/unit/` or `tests/integration/` so it runs in CI. Storage-corruption regressions live there already: `storage-format.test.js` (parsing a corrupted stored value), `state-management.test.js` (validation rejects it) and `load-quarantine.test.js` (the real new tab boots against it). A regression test is **designed to FAIL if the bug is not fixed** — don't weaken assertions to make it pass.

## Coverage

`collectCoverageFrom` is set in [package.json](../../package.json):

```
"javascript/**/*.js",
"!javascript/**/*.test.js",
"!javascript/entry-points/**",
"!javascript/features/consoleCommands.js"
```

So entry-points and the dev console are excluded. Aim for 80%+ on everything else. `npm run test:coverage` produces the report.

## Test naming

Use descriptive sentences that explain the behavior:

- ✅ `should reject non-array links in state update`
- ✅ `falls back to substring search when Redis is unavailable`
- ❌ `works` / `test1` / `handles input`
