# The Codex — Foundational Extension Review

**Review date:** 2026-10-19  
**Scope:** repository structure, Manifest V3 configuration, state/storage/sync architecture, security boundaries, rendering paths, tests, and developer workflow.

## Executive assessment

The Codex has a solid set of primitives: Manifest V3, a centralized state manager, URL/icon validation, a storage abstraction, a service worker, a shared tile renderer, and a meaningful Jest suite. The main problem is not missing capability; it is **inconsistent adoption**. Several surfaces still maintain their own state and persistence paths, while older and newer approaches coexist.

The most valuable foundational change is to make one application core authoritative:

> **One link model, one state store, one persistence seam, one renderer, and one sync contract.**

Until that is done, new features will continue to create cross-surface drift and correctness regressions.

## Baseline verified

- `npm test -- --runInBand`: **25 suites, 380 tests passed**.
- `npm run test:coverage -- --runInBand`: **49.38% statements, 46.97% branches, 53.9% functions**.
- `npm run lint`: **fails** with **1,432 errors and 89 warnings**. The most visible cluster is undefined helper references in `tests/unit/error-handler.test.js`; lint is not currently a trustworthy release gate.
- No GitHub Actions workflow is present under `.github/workflows/`.
- `script.js` is about **1,200 lines**, `manageScript.js` about **700 lines**, `storageManager.js` about **775 lines**, and `syncManager.js` about **725 lines**. These are high-risk coordination points.
- `TESTING.md` is stale: it reports 234 tests and 11 suites, while the current suite reports 380 tests and 25 suites. Version notes also still describe 7.0.0.2 while `manifest.json` is 7.0.0.36.

## Priority 0 — make the quality gate real

### 1. Repair lint and add CI

**Why:** A green test suite can coexist with a completely broken lint command. The current ESLint configuration includes test files, but at least one test suite references imported helpers through undeclared variables. The command also attempts to write npm logs outside the workspace, which makes local automation brittle under restricted execution.

**Actions:**

1. Fix all `no-undef` errors in tests by declaring imported bindings normally.
2. Ignore generated output (`coverage/`, reports, design-kit build output where appropriate) and intentionally separate extension source, tests, and browser harnesses in ESLint config.
3. Reduce unused-variable warnings rather than suppressing them globally.
4. Add `.github/workflows/ci.yml` to run `npm ci`, `npm run lint`, and `npm test -- --coverage` on pull requests and pushes.
5. Add a measured, ratcheting `coverageThreshold`; start with the security/storage/state modules, then increase it.

**Acceptance criteria:** `npm run lint` exits 0; CI runs on every PR; coverage cannot regress silently.

### 2. Delete or isolate dead test infrastructure

The repository contains Jest tests, loose Node runners, and a second `tests/real-chrome-tests` extension. The latter is not invoked by the main npm scripts and overlaps the canonical tests. Keep one canonical test strategy, or explicitly wire the browser harness into CI with a documented command.

## Priority 1 — consolidate the application core

### 3. Make `stateManager` the only mutable application store

Current managers accept a mutable `state` object and directly mutate it. Examples include `linkManager.js` pushing/splicing `state.links`, `categoryManager.js` replacing `state.categories`, and `storageManager.importLinks()` assigning directly to state. This bypasses validation, change listeners, rollback history, and automatic persistence.

`stateManager` also stores both `links` and `filteredLinks`. That creates a second array that must remain synchronized and has already caused aliasing/index bugs in the past.

**Recommended target:**

- `links`, `categories`, and settings are canonical state.
- `filteredLinks` is a selector derived from canonical state, not persisted or independently mutated.
- Managers expose pure commands or return immutable updates.
- Commands call `safeUpdateState()` once, after validation.
- Persistence is triggered from one store boundary, not from every manager.

**Acceptance criteria:** no production code outside the store mutates canonical arrays; every mutation emits one state change; filtered results are never persisted.

### 4. Introduce a single `linkFactory` / normalizer

Link creation currently has multiple paths: manage form, popup, imports, bookmark import, link manager, and startup salvage logic. That guarantees drift in URL, icon, category, size, ID, and text normalization.

Create one `createLink(input, source)` that:

- normalizes and length-limits name/category;
- validates `http`/`https` URLs through the canonical validator;
- validates icon values through `validateIconValue()`;
- normalizes size and category defaults;
- assigns a stable ID;
- returns either a valid link or structured validation errors.

Use it for every add/import path, then remove the large startup salvage block in `script.js`.

## Priority 1 — make persistence lossless and predictable

### 5. Use one storage encoding and one storage seam

`storageManager` serializes links/categories as JSON strings, while other paths write raw values directly to `chrome.storage.sync`. The service worker also has its own storage-healing rules. `manageScript.js`, `popup.js`, `stateManager.js`, and `syncManager.js` all access Chrome storage independently.

This makes fallback behavior and migrations difficult to reason about.

**Actions:**

- Route every read/write through `storageManager`.
- Define a versioned storage envelope, for example `{ schemaVersion, links, categories, settings }`.
- Centralize migration and corruption recovery.
- Decide whether arrays are stored as native arrays or JSON strings; do not support both indefinitely.
- Use `chrome.storage.sync.getBytesInUse()` rather than a hard-coded character-length approximation.
- Treat sync quota failure as a first-class result. Do not return `false`/defaults in a way callers can mistake for success.
- Make mutations transactional from the UI perspective: update state only after the durable write succeeds, or mark the state as unsaved and show recovery UI.

A particularly risky pattern is `saveLinks()` catching failures and returning `false`, while callers such as drag/drop do not check the result. That can present a successful reorder while the old data remains persisted.

### 6. Choose one sync model

The repository currently has two models:

1. Chrome `storage.sync` as the automatic transport, observed via `storage.onChanged`.
2. A separate `SyncManager` with local/remote metadata, merge strategies, force-push/pull, and conflict resolution.

These models can disagree about which store is authoritative. The timestamp-based metadata is also not a robust conflict protocol: both local and remote metadata are written together, and link-level modification times do not exist, so the advertised merge strategy cannot reliably resolve concurrent edits.

**Recommendation:** prefer Chrome sync as the transport and simplify `SyncManager` into status, diagnostics, and explicit recovery. If true merge/conflict resolution is required, add per-record revisions and a last-known-remote revision; do not infer conflicts from `Date.now()` alone.

## Priority 1 — security and rendering hardening

### 7. Eliminate dynamic `innerHTML` for data-bearing markup

The repository now contains a safe DOM-based renderer in `tileRenderer.js`, but other paths still build HTML strings. Examples include category rendering in `manageScript.js`, UI rendering in `uiManager.js`, and legacy rendering helpers in `domOptimizer.js`.

`escapeHtml()` is appropriate for HTML encoding, while `sanitizeHTML` is an alias for `extractTextContent()` and is explicitly documented as a text extractor. It should not be used as a general HTML sanitizer or as a substitute for safe DOM construction.

**Actions:**

- Use `textContent`, `setAttribute`, and `dataset` for all user-controlled values.
- Keep `innerHTML` only for static, developer-authored SVG/templates, or remove it entirely from data-bearing renderers.
- Validate icon URLs before assigning `img.src`; keep the allowlist aligned with `iconPolicy.js` and CSP.
- Add regression tests for malicious names, categories, URLs, icon values, and imported JSON in every active rendering path.

### 8. Tighten the manifest and external-resource policy

The extension currently allows remote fonts and Font Awesome CSS in HTML, uses `style-src 'unsafe-inline'`, and declares broad/optional behavior that should be reviewed. Reduce the external surface:

- self-host fonts/icons where practical;
- remove the popup Font Awesome CDN dependency by using inline or local SVGs;
- remove unused CSP sources and permissions;
- eliminate inline styles where feasible, then remove `unsafe-inline`;
- keep `img-src` limited to the actual icon allowlist;
- add `frame-ancestors 'none'` if compatible with the extension pages.

## Priority 2 — reliability and UX architecture

### 9. Extract pure reorder and command modules

Drag/drop logic is embedded in `script.js` and category management. Extract pure functions such as:

- `moveLink(links, linkId, targetCategory, targetIndex)`;
- `reorderCategories(categories, from, to)`;
- `bulkUpdateLinks(links, ids, patch)`.

These functions can be exhaustively unit-tested without DOM or Chrome mocks. The UI layer should only translate events into commands.

### 10. Make lifecycle and rendering event-delegated

The new-tab page repeatedly attaches listeners to every tile after renders, while maintaining a custom tracking array. This increases complexity and makes cleanup easy to miss. Prefer one delegated listener on the stable container for tile actions and drag events where browser behavior permits. Render should be idempotent and should not require a cleanup pass for every tile.

Also avoid repeated deep-cloning through `getState()` inside loops. Take one snapshot per render and pass it down.

### 11. Complete accessibility fundamentals

The HTML has some good labels, but the foundational interaction model still relies heavily on drag/drop and custom tabs/modals. Add:

- ARIA tab semantics and keyboard tab switching;
- keyboard-accessible link/category reorder controls;
- `role="dialog"`, focus management, Escape handling, and focus return for modals;
- `aria-live` announcements for save, import, delete, sync, and error outcomes;
- visible focus states and consistent button semantics.

## Recommended implementation sequence

### Phase A — safety net, 1–2 days

- Fix lint errors and stale test setup.
- Add CI.
- Update `TESTING.md` and version documentation.
- Add tests for save failure propagation, storage fallback, import normalization, and malicious render input.

### Phase B — data integrity, 1–2 weeks

- Introduce `linkFactory` and storage schema versioning.
- Route all persistence through `storageManager`.
- Remove direct manager mutation and make `filteredLinks` derived.
- Define and test a single sync contract.

### Phase C — security/rendering, 1 week

- Convert active dynamic HTML sinks to DOM construction.
- Remove `sanitizeHTML` misuse.
- Tighten CSP and external dependencies.
- Add browser-level XSS and cross-surface tests.

### Phase D — maintainability, 2–4 weeks

- Extract pure reorder commands and delegated event controllers.
- Reduce `script.js`, `manageScript.js`, and `syncManager.js` to orchestration layers.
- Add accessibility behavior and performance regression tests.

## What is already working well

- MV3 service-worker architecture and stable manifest key are appropriate.
- URL scheme validation is centralized in `validateAndSanitizeUrl()` and intentionally supports local homelab URLs.
- Icon persistence has a dedicated policy and CSP-aware renderer.
- `tileRenderer.js` demonstrates the desired safe DOM construction approach.
- Storage corruption handling and cross-context `storage.onChanged` work show good awareness of real extension failure modes.
- The current Jest suite provides useful coverage of core validation, link operations, icon policy, and sync behavior; it needs to become representative of active entry-point behavior and enforceable in CI.

## Bottom line

Do not start with a rewrite or more feature work. First make the existing good primitives authoritative. The highest-leverage investment is the combination of **CI/lint repair, a single link factory, a single state store, a single storage contract, and one sync model**. Those changes will reduce security risk, prevent silent data loss, simplify testing, and make future UI improvements substantially cheaper.
