---
description: "Use when writing or modifying tests under tests/ — covers Jest with ESM (`jest.unstable_mockModule`), jsdom, the per-file Chrome API mock pattern (tests/setup.js is intentionally minimal), AAA structure, and the dedicated real-Chrome harness in tests/real-chrome-tests/."
applyTo: "tests/**/*.test.js, tests/real-chrome-tests/**"
---

# Test Conventions

> Project-wide test commands and Chrome extension context live in [CLAUDE.md](../../CLAUDE.md). This file is the test-author playbook.

## Two test environments

| Environment | Where it runs | How it's invoked | Use it for |
|---|---|---|---|
| **Jest + jsdom** (default) | `tests/*.test.js`, `javascript/**/*.test.js` | `npm test`, `npm run test:unit`, etc. | Unit, integration, regression. The everyday workhorse. |
| **Real Chrome harness** | `tests/real-chrome-tests/*` (own `manifest.json` + `package.json`) | Loaded as an unpacked extension in Chrome; `run-tests.js` is the entry | Critical-bug regression tests that need real Chrome APIs. |

Jest's `testMatch` (see [package.json](../../package.json)) is `["<rootDir>/tests/**/*.test.js", "<rootDir>/javascript/**/*.test.js"]`, so any `*.test.js` file under either tree is picked up automatically.

## Test layout — unit vs integration

```
tests/
├── setup.js                  # 3 lines: just exposes `jest` globally
├── unit/                     # Single-module tests with mocked deps (npm run test:unit)
│   ├── category-manager.test.js
│   ├── debug.test.js
│   ├── error-handler.test.js
│   ├── icon-cache.test.js
│   ├── link-management.test.js
│   ├── security-utils.test.js
│   ├── state-management.test.js
│   ├── sync-manager.test.js
│   └── utils.test.js
├── integration/              # Multi-module / cross-system tests (npm run test:integration)
│   ├── chrome-storage-fixes.test.js
│   └── critical-bug-fixes.test.js
├── real-chrome-tests/        # Real-Chrome harness (load as unpacked extension; not via npm)
└── root-test-files/          # Standalone runners (not picked up by Jest)
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

`tests/error-handler.test.js` and `tests/security-utils.test.js` use module-scoped `let` variables assigned in `beforeEach` to grab exports — that's the established style for code-under-test exports. Match it instead of inventing a new pattern.

## Critical-bug tests — bug IDs and the real-Chrome harness

Critical regressions get a stable ID and live in `tests/real-chrome-tests/critical-bug-tests.js` as entries on a `CriticalBugTester` instance:

```javascript
this.bugTests = [
  { id: 'CORRUPTION-001', name: 'Chrome Storage Object Corruption', test: this.testObjectCorruption },
  { id: 'STORAGE-001',   name: 'Storage Manager Corruption Recovery', test: this.testStorageRecovery },
  // ...
];
```

These tests are **designed to FAIL if the bug is not fixed** — don't weaken assertions to make them pass. The `runAllCriticalTests` method tracks `passed` / `failed` counts and exits non-zero on any failure.

The harness's `run-tests.js` is itself a Node script that:

1. Mocks `global.window` with `addEventListener`, `removeEventListener`, `location.origin: 'http://localhost'`, `isSecureContext: true`.
2. Constructs a `CriticalBugTester` and calls `runAllCriticalTests()`.
3. Calls `process.exit(0 | 1)` based on the result.

To run it: load `tests/real-chrome-tests/` as an unpacked extension in Chrome and follow [TESTING.md](../../TESTING.md). For day-to-day work, **write the unit/integration test in `tests/*.test.js` first**; only escalate to the real-Chrome harness if a bug can only be reproduced in real Chrome.

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
