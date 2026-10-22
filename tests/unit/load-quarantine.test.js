/**
 * Regression: one bad stored value must not blank the new tab.
 *
 * initializeState() used to commit the whole loaded state in one validated
 * update and, if anything failed, fall back to `links: []` — so a single
 * stale value (a pre-7.0.0.24 colorTheme like 'ocean', a 51-char category, one
 * link with an over-long data: icon) rendered an empty new tab on every device
 * while storage was intact. Now unknown settings are coerced field by field
 * and invalid links/categories are quarantined individually, in memory only.
 *
 * These tests boot the real newtab entry point (script.js) against a mocked
 * chrome.storage and the real stateManager, then assert on the rendered DOM —
 * and that the load never wrote to chrome.storage.sync. The drag tests check
 * that the first write after such a load (a drop) changes only the moved link
 * and never persists what the load cleaned up or hid for display — and, since
 * the mock's sync.set echoes through onChanged as Chrome does, that the echo
 * (or any other device's change) is cleaned like a load, not shown raw.
 */
import { jest } from '@jest/globals';

function storedGet(store) {
    return jest.fn((keys) => {
        if (keys == null) return Promise.resolve({ ...store });
        const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
        const out = {};
        list.forEach(key => { if (key in store) out[key] = store[key]; });
        return Promise.resolve(out);
    });
}

function installChromeMock(syncStore) {
    const changeListeners = [];
    const localStore = {};
    const stores = { sync: syncStore, local: localStore };
    // Simulate chrome.storage.onChanged for a write made elsewhere. As in
    // Chrome, the store already holds the change when listeners run (links
    // listeners re-read every chunk from storage).
    const fireChange = (changes, areaName = 'sync') => {
        const store = stores[areaName];
        for (const [key, change] of Object.entries(changes)) {
            if ('newValue' in change) store[key] = change.newValue;
            else delete store[key];
        }
        changeListeners.forEach(fn => fn(changes, areaName));
    };
    // Like Chrome: a write updates the store, then onChanged fires
    // asynchronously in every context — the writing page included.
    const write = (store, areaName) => jest.fn((items) => {
        const changes = {};
        for (const [key, newValue] of Object.entries(items)) {
            changes[key] = { oldValue: store[key], newValue };
            store[key] = newValue;
        }
        setTimeout(() => fireChange(changes, areaName), 0);
        return Promise.resolve();
    });
    const remove = (store, areaName) => jest.fn((keys) => {
        const changes = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(key => {
            if (key in store) changes[key] = { oldValue: store[key] };
            delete store[key];
        });
        setTimeout(() => fireChange(changes, areaName), 0);
        return Promise.resolve();
    });
    const sync = {
        get: storedGet(syncStore),
        set: write(syncStore, 'sync'),
        remove: remove(syncStore, 'sync'),
        getBytesInUse: jest.fn(() => Promise.resolve(0)),
    };
    const local = {
        get: storedGet(localStore),
        set: write(localStore, 'local'),
        remove: remove(localStore, 'local'),
    };
    global.chrome = {
        storage: {
            sync,
            local,
            onChanged: { addListener: jest.fn(fn => changeListeners.push(fn)), removeListener: jest.fn() },
        },
        runtime: {
            id: 'test',
            lastError: null,
            getURL: (p) => `chrome-extension://test/${p}`,
            sendMessage: jest.fn(),
            onMessage: { addListener: jest.fn() },
        },
    };
    return { sync, local, fireChange };
}

async function waitFor(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new tab to render');
        await new Promise(r => setTimeout(r, 10));
    }
}

const link = (name, category, extra = {}) => ({
    id: `id-${name}`,
    name,
    url: `https://${name.toLowerCase()}.example.com/`,
    category,
    ...extra,
});

function setUpNewTabDom() {
    document.body.innerHTML = `
        <div class="app-container">
            <input type="text" id="searchInput">
            <datalist id="searchSuggestions"></datalist>
            <div id="sync-status-container"></div>
            <main id="linksContainer"></main>
        </div>`;
}

/** chrome.storage.sync contents: links/categories JSON-encoded, as storageManager persists them. */
function syncStoreFor({ links, categories, ...settings }) {
    const store = { ...settings };
    if (links !== undefined) store.links = JSON.stringify(links);
    if (categories !== undefined) store.categories = JSON.stringify(categories);
    return store;
}

/** Boot the newtab page against the given chrome.storage.sync contents. */
async function bootNewTab(stored) {
    jest.resetModules();
    setUpNewTabDom();
    const chromeMock = installChromeMock(syncStoreFor(stored));

    await import('../../javascript/entry-points/script.js');
    const container = document.getElementById('linksContainer');
    await waitFor(() => container.querySelector('.category-section, .no-results'));
    // Let any fire-and-forget persistence run before callers assert on it.
    await new Promise(r => setTimeout(r, 20));

    const { getState } = await import('../../javascript/core-systems/stateManager.js');
    return { chromeMock, getState, container };
}

const tileNames = (container) =>
    [...container.querySelectorAll('.category-section h3')].map(h => h.textContent);
const sectionNames = (container) =>
    [...container.querySelectorAll('.links-grid')].map(g => g.dataset.category);

describe('new tab load: one bad stored value must not blank the page', () => {
    let warnSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        delete global.chrome;
    });

    test('a legacy colorTheme ("ocean") still renders every link, coerced to default in memory', async () => {
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Beta', 'Work')],
            categories: ['Default', 'Work'],
            theme: 'light',
            colorTheme: 'ocean',
        });

        expect(tileNames(container)).toEqual(['Alpha', 'Beta']);
        expect(getState().colorTheme).toBe('default');
        // Valid settings beside the bad one are kept, not reset.
        expect(getState().theme).toBe('light');
        expect(chromeMock.sync.set).not.toHaveBeenCalled();
    });

    test('each unknown setting falls back to its own default without touching the others', async () => {
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default')],
            categories: ['Default'],
            theme: 'sepia',
            colorTheme: 'teal',
            view: 'masonry',
            defaultTileSize: 'huge',
        });

        expect(tileNames(container)).toEqual(['Alpha']);
        expect(getState()).toMatchObject({
            theme: 'dark',
            colorTheme: 'teal',
            view: 'grid',
            defaultTileSize: 'medium',
        });
        expect(chromeMock.sync.set).not.toHaveBeenCalled();
    });

    test('a 51-char category name does not hide the other links (and keeps its section order)', async () => {
        const longName = 'C'.repeat(51);
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Long', longName), link('Gamma', 'Work')],
            categories: ['Default', longName, 'Work'],
        });

        expect(tileNames(container)).toEqual(['Alpha', 'Long', 'Gamma']);
        // Same truncation the salvage applies to link.category, so the order holds.
        expect(sectionNames(container)).toEqual(['Default', 'C'.repeat(50), 'Work']);
        expect(getState().categories).toEqual(['Default', 'C'.repeat(50), 'Work']);
        expect(chromeMock.sync.set).not.toHaveBeenCalled();
    });

    test('one link that fails validation is quarantined; the valid ones still render', async () => {
        // Parses as a URL (so it survives the salvage) but exceeds the 500-char
        // icon cap — the shape an imported data: icon arrives in.
        const hugeIcon = 'data:image/png;base64,' + 'A'.repeat(600);
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Broken', 'Default', { icon: hugeIcon }), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);
        expect(getState().links.map(l => l.name)).toEqual(['Alpha', 'Gamma']);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Hiding 1 stored link(s)'),
            [expect.objectContaining({ name: 'Broken' })]
        );
        expect(chromeMock.sync.set).not.toHaveBeenCalled();
    });

    test.each(['constructor', '__proto__', 'toString', 'valueOf'])(
        'a category named "%s" renders like any other',
        async (name) => {
            const { chromeMock, container } = await bootNewTab({
                links: [link('Alpha', 'Default'), link('Proto', name), link('Gamma', name)],
                categories: ['Default', name],
            });

            expect(sectionNames(container)).toEqual(['Default', name]);
            expect(tileNames(container)).toEqual(['Alpha', 'Proto', 'Gamma']);
            expect(chromeMock.sync.set).not.toHaveBeenCalled();
        }
    );

    test('a clean store loads unchanged and still never writes to sync', async () => {
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Beta', 'Work')],
            categories: ['Default', 'Work'],
            theme: 'light',
            colorTheme: 'violet',
            view: 'list',
            defaultTileSize: 'large',
        });

        expect(tileNames(container)).toEqual(['Alpha', 'Beta']);
        expect(getState()).toMatchObject({ theme: 'light', colorTheme: 'violet', view: 'list', defaultTileSize: 'large' });
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[The Codex]'), expect.anything());
        expect(chromeMock.sync.set).not.toHaveBeenCalled();
    });
});

// --- Drops after a load-time cleanup --------------------------------------

function dragEvent(type) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { setData() {}, effectAllowed: '', dropEffect: '' } });
    return ev;
}

const tileNamed = (container, name) =>
    [...container.querySelectorAll('.link-tile')].find(t => t.querySelector('h3').textContent === name);
const gridFor = (container, category) =>
    [...container.querySelectorAll('.links-grid')].find(g => g.dataset.category === category);

async function settle() {
    await new Promise(r => setTimeout(r, 20));
}

/** Drag the named tile and drop it on a category grid (handleGridDrop). */
async function dropOnGrid(container, name, category) {
    tileNamed(container, name).dispatchEvent(dragEvent('dragstart'));
    gridFor(container, category).dispatchEvent(dragEvent('drop'));
    await settle();
}

/** Drag the named tile and drop it on another tile (handleDrop). */
async function dropOnTile(container, name, targetName) {
    tileNamed(container, name).dispatchEvent(dragEvent('dragstart'));
    tileNamed(container, targetName).dispatchEvent(dragEvent('drop'));
    await settle();
}

const linkWrites = (sync) =>
    sync.set.mock.calls.filter(([arg]) => 'links' in arg).map(([arg]) => JSON.parse(arg.links));

describe('a drop after a load-time cleanup changes only the moved link', () => {
    let warnSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        delete global.chrome;
    });

    test('a quarantined link survives a grid drop, unchanged, in one sync write', async () => {
        const broken = link('Broken', 'Default', { icon: 'data:image/png;base64,' + 'A'.repeat(600) });
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), broken, link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        await dropOnGrid(container, 'Alpha', 'Work');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([broken, link('Gamma', 'Work'), link('Alpha', 'Work')]);
        expect(tileNames(container)).toEqual(['Gamma', 'Alpha']);
    });

    test('a quarantined link survives a tile drop too', async () => {
        const broken = link('Broken', 'Work', { icon: 'data:image/png;base64,' + 'A'.repeat(600) });
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Beta', 'Work'), broken, link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        // Drop Alpha on Gamma. handleDrop lands a link moved down AFTER its
        // target; the stored order matches the rendered one, and Broken keeps
        // its slot.
        await dropOnTile(container, 'Alpha', 'Gamma');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([link('Beta', 'Work'), broken, link('Gamma', 'Work'), link('Alpha', 'Work')]);
        expect(tileNames(container)).toEqual(['Beta', 'Gamma', 'Alpha']);
    });

    test('a drop into an over-long category stores its original name; other links keep theirs', async () => {
        const longName = 'C'.repeat(51);
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Long', longName), link('Gamma', 'Work')],
            categories: ['Default', longName, 'Work'],
        });

        // The grid renders under the truncated name.
        await dropOnGrid(container, 'Alpha', 'C'.repeat(50));

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([link('Long', longName), link('Alpha', longName), link('Gamma', 'Work')]);
    });

    test('a reorder inside an over-long category keeps the stored name on every link', async () => {
        const longName = 'C'.repeat(51);
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', longName), link('Beta', longName)],
            categories: ['Default', longName],
        });

        await dropOnTile(container, 'Beta', 'Alpha');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([link('Beta', longName), link('Alpha', longName)]);
        expect(chromeMock.sync.set.mock.calls.some(([arg]) => 'categories' in arg)).toBe(false);
    });

    test('stored links without ids are written back with only an id added', async () => {
        const bare = ({ id, ...rest }) => rest;
        const alpha = bare(link('Alpha', 'Default'));
        const gamma = bare(link('Gamma', 'Work'));
        const { chromeMock, container } = await bootNewTab({
            links: [alpha, gamma],
            categories: ['Default', 'Work'],
        });

        await dropOnGrid(container, 'Alpha', 'Work');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([
            { ...gamma, id: expect.any(String) },
            { ...alpha, category: 'Work', id: expect.any(String) },
        ]);
    });

    test('with two stored links sharing an id, the dragged one moves and the other stays byte-identical', async () => {
        // importLinks keeps supplied ids without checking uniqueness.
        const first = link('First', 'Default', { id: 'dup' });
        const second = link('Second', 'Default', { id: 'dup' });
        const { chromeMock, container } = await bootNewTab({
            links: [first, second, link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });
        // Telling them apart happens in memory only: the load writes nothing.
        expect(chromeMock.sync.set).not.toHaveBeenCalled();

        await dropOnGrid(container, 'Second', 'Work');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0][0]).toEqual(first);
        expect(writes[0][1]).toEqual(link('Gamma', 'Work'));
        // The moved link is saved with a de-duplicated id (a user-initiated save).
        expect(writes[0][2]).toEqual({ ...second, category: 'Work', id: expect.any(String) });
        expect(writes[0][2].id).not.toBe('dup');
        expect(tileNames(container)).toEqual(['First', 'Gamma', 'Second']);
    });

    test("a drop after another device's edit keeps that edit", async () => {
        const stored = [link('Alpha', 'Default'), link('Gamma', 'Work')];
        const { chromeMock, container } = await bootNewTab({ links: stored, categories: ['Default', 'Work'] });

        // Another device adds Delta; both stateManager and the new tab hear it.
        const delta = link('Delta', 'Work');
        chromeMock.fireChange({ links: { newValue: JSON.stringify([...stored, delta]) } });
        await settle();

        await dropOnGrid(container, 'Alpha', 'Work');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([link('Gamma', 'Work'), delta, link('Alpha', 'Work')]);
    });

    test('nothing is written when the stored links became unreadable', async () => {
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        // Another context wrote something that isn't a links array; the tab
        // keeps showing the old tiles, but must not save them back over it.
        chromeMock.fireChange({ links: { newValue: '{"not":"an array"}' } });
        await settle();
        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);

        await dropOnGrid(container, 'Alpha', 'Work');

        expect(linkWrites(chromeMock.sync)).toHaveLength(0);
    });

    test('links removed from sync (e.g. cleared) empty the page instead of lingering', async () => {
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        chromeMock.fireChange({ links: { oldValue: '[]' }, categories: { oldValue: '[]' } });
        await settle();

        expect(tileNames(container)).toEqual([]);
        expect(getState().links).toEqual([]);
        expect(getState().categories).toEqual(['Default']);
        expect(chromeMock.sync.set).not.toHaveBeenCalled();
    });
});

// --- Sync changes (a drop's own echo, another device) are cleaned too ------

async function search(term) {
    const input = document.getElementById('searchInput');
    input.value = term;
    input.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 350)); // search input is debounced 300ms
}

describe('sync changes are cleaned like a load, never applied raw', () => {
    let warnSpy;
    let errorSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error');
    });

    afterEach(() => {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        delete global.chrome;
    });

    test('after a drop echoes back, the quarantined link stays hidden', async () => {
        const broken = link('Broken', 'Default', { icon: 'data:image/png;base64,' + 'A'.repeat(600) });
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), broken, link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        await dropOnGrid(container, 'Alpha', 'Work');

        // The echo carried the full stored array (Broken included)...
        expect(JSON.parse(chromeMock.sync.set.mock.calls[0][0].links).map(l => l.name))
            .toEqual(['Broken', 'Gamma', 'Alpha']);
        // ...and the page still shows and holds only the valid links.
        expect(tileNames(container)).toEqual(['Gamma', 'Alpha']);
        expect(getState().links.map(l => l.name)).toEqual(['Gamma', 'Alpha']);
    });

    test('junk stored entries (null, 42, nameless) survive a drop and never break rendering', async () => {
        const nameless = { id: 'id-nameless', url: 'https://nameless.example.com/', category: 'Default' };
        const { chromeMock, container } = await bootNewTab({
            links: [null, 42, nameless, link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });
        // The salvage names the nameless link after its host, for display only.
        expect(tileNames(container)).toEqual(['nameless.example.com', 'Alpha', 'Gamma']);

        await dropOnGrid(container, 'Alpha', 'Work');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([null, 42, nameless, link('Gamma', 'Work'), link('Alpha', 'Work')]);
        expect(tileNames(container)).toEqual(['nameless.example.com', 'Gamma', 'Alpha']);

        // Rendering still works after the echo: search filters...
        await search('gam');
        expect(tileNames(container)).toEqual(['Gamma']);
        await search('');

        // ...and another drag still starts and saves.
        await dropOnGrid(container, 'Gamma', 'Default');
        expect(linkWrites(chromeMock.sync)).toHaveLength(2);
        expect(linkWrites(chromeMock.sync)[1].slice(0, 3)).toEqual([null, 42, nameless]);
        expect(errorSpy).not.toHaveBeenCalledWith('State update failed:', expect.anything());
    });

    test('an over-long category stays one section after a drop echoes back', async () => {
        const longName = 'C'.repeat(51);
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Long', longName), link('Gamma', 'Work')],
            categories: ['Default', longName, 'Work'],
        });

        await dropOnGrid(container, 'Gamma', 'C'.repeat(50));

        expect(linkWrites(chromeMock.sync)[0]).toEqual([link('Alpha', 'Default'), link('Long', longName), link('Gamma', longName)]);
        // One section under the display name — not a raw-name section beside it.
        expect(sectionNames(container)).toEqual(['Default', 'C'.repeat(50)]);
        expect(tileNames(container)).toEqual(['Alpha', 'Long', 'Gamma']);
        expect(getState().categories).toEqual(['Default', 'C'.repeat(50), 'Work']);
    });

    test("another device's change is cleaned before it renders", async () => {
        const longName = 'D'.repeat(60);
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        chromeMock.fireChange({
            links: { newValue: JSON.stringify([
                link('Alpha', 'Default'),
                null,
                link('Broken', 'Work', { icon: 'data:image/png;base64,' + 'A'.repeat(600) }),
                link('Gamma', 'Work'),
                link('Delta', longName),
            ]) },
            categories: { newValue: JSON.stringify(['Default', 'Work', longName]) },
        });
        await settle();

        expect(tileNames(container)).toEqual(['Alpha', 'Gamma', 'Delta']);
        expect(sectionNames(container)).toEqual(['Default', 'Work', 'D'.repeat(50)]);
        expect(getState().categories).toEqual(['Default', 'Work', 'D'.repeat(50)]);
        // Applying someone else's write must never write back.
        expect(chromeMock.sync.set).not.toHaveBeenCalled();
    });

    test('a change that arrives while the page is still loading is not lost', async () => {
        jest.resetModules();
        setUpNewTabDom();
        const chromeMock = installChromeMock(syncStoreFor({
            links: [link('Alpha', 'Default')],
            categories: ['Default'],
        }));
        // Hold the load's read: it sees the old value, the change lands meanwhile.
        let release;
        const gate = new Promise(r => { release = r; });
        const readNow = chromeMock.sync.get;
        chromeMock.sync.get = jest.fn(async (keys) => {
            const snapshot = await readNow(keys);
            await gate;
            return snapshot;
        });

        await import('../../javascript/entry-points/script.js');
        await new Promise(r => setTimeout(r, 0));
        chromeMock.fireChange({
            links: { newValue: JSON.stringify([link('Alpha', 'Default'), link('Beta', 'Default')]) },
        });
        release();

        const container = document.getElementById('linksContainer');
        await waitFor(() => container.querySelector('.category-section'));
        await settle();
        expect(tileNames(container)).toEqual(['Alpha', 'Beta']);
    });
});

// --- Reloads after a manual sync or clear are cleaned too -----------------
// After Sync now / force pull / force push / clear, every open page re-reads
// storage (stateManager.reloadFromStorage, signalled by syncResolvedAt in
// chrome.storage.local) — with no sync write when the cloud won. Claimed
// links/categories must still go through the new tab's cleanup, and refresh
// the stored copy its drops save onto.

/** What every open page sees after a manual sync or clear. */
async function announceSyncResolved(chromeMock) {
    await chromeMock.local.set({ syncResolvedAt: Date.now() });
    await settle();
}

describe('a reload after a manual sync or clear is cleaned like a load', () => {
    let warnSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        delete global.chrome;
    });

    test('a quarantined link stays hidden after the reload, and the next drop saves it back unchanged', async () => {
        const broken = link('Broken', 'Default', { icon: 'data:image/png;base64,' + 'A'.repeat(600) });
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), broken, link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        await announceSyncResolved(chromeMock);
        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);
        expect(getState().links.map(l => l.name)).toEqual(['Alpha', 'Gamma']);

        await dropOnGrid(container, 'Alpha', 'Work');
        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([broken, link('Gamma', 'Work'), link('Alpha', 'Work')]);
    });

    test('two stored links sharing an id stay distinct after the reload', async () => {
        const first = link('First', 'Default', { id: 'dup' });
        const second = link('Second', 'Default', { id: 'dup' });
        const { chromeMock, container } = await bootNewTab({
            links: [first, second, link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        await announceSyncResolved(chromeMock);
        await dropOnGrid(container, 'Second', 'Work');

        const writes = linkWrites(chromeMock.sync);
        expect(writes).toHaveLength(1);
        expect(writes[0][0]).toEqual(first);
        expect(writes[0][2]).toEqual({ ...second, category: 'Work', id: expect.any(String) });
        expect(writes[0][2].id).not.toBe('dup');
    });

    test('a stored object icon never blanks the page on reload', async () => {
        const objectIcon = {
            id: 'id-Obj', name: 'Obj', url: 'https://obj.example.com/', category: 'Default',
            icon: { url: 'https://cdn.jsdelivr.net/gh/selfhst/icons/png/obj.png' },
        };
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), objectIcon, link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });
        expect(tileNames(container)).toEqual(['Alpha', 'Obj', 'Gamma']);

        // Raw, this icon would throw in getIconUrl (link.icon.trim).
        await announceSyncResolved(chromeMock);
        expect(tileNames(container)).toEqual(['Alpha', 'Obj', 'Gamma']);
    });

    test('an over-long category stays one sanitized section after the reload', async () => {
        const longName = 'C'.repeat(51);
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Long', longName)],
            categories: ['Default', longName],
        });

        await announceSyncResolved(chromeMock);
        expect(sectionNames(container)).toEqual(['Default', 'C'.repeat(50)]);
        expect(getState().categories).toEqual(['Default', 'C'.repeat(50)]);
    });

    test("another device's write and a later reload both arrive cleaned", async () => {
        const { chromeMock, getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });
        const broken = link('Broken', 'Work', { icon: 'data:image/png;base64,' + 'A'.repeat(600) });

        // Another device writes (store updated, onChanged fires), then a sync resolves.
        await chromeMock.sync.set({ links: JSON.stringify([link('Alpha', 'Default'), null, broken, link('Gamma', 'Work')]) });
        await settle();
        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);

        await announceSyncResolved(chromeMock);
        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);
        expect(getState().links.map(l => l.name)).toEqual(['Alpha', 'Gamma']);
    });

    test('after the reload, a drop starts from what storage holds, not an edit the sync discarded', async () => {
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });

        // A drop whose sync write fails is kept locally (pending)...
        chromeMock.sync.set.mockImplementationOnce(() => Promise.reject(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE')));
        await dropOnGrid(container, 'Alpha', 'Work');
        // ...then a sync keeps the cloud's copy, and every page reloads it.
        await announceSyncResolved(chromeMock);
        expect(sectionNames(container)).toEqual(['Default', 'Work']);
        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);

        await dropOnGrid(container, 'Gamma', 'Default');
        const writes = linkWrites(chromeMock.sync);
        expect(writes.at(-1)).toEqual([link('Alpha', 'Default'), link('Gamma', 'Default')]);
    });

    test('a reload re-renders the new tab once, settings and lists together', async () => {
        const { chromeMock, container } = await bootNewTab({
            links: [link('Alpha', 'Default')],
            categories: ['Default'],
        });
        const { addStateChangeListener } = await import('../../javascript/core-systems/stateManager.js');
        const changes = [];
        addStateChangeListener(info => changes.push(Object.keys(info.changes).sort()));

        await announceSyncResolved(chromeMock);

        expect(changes).toEqual([['categories', 'colorTheme', 'defaultTileSize', 'links', 'theme', 'view']]);
        expect(tileNames(container)).toEqual(['Alpha']);
    });
});

describe('rendering never blanks the page', () => {
    let warnSpy;
    let errorSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        delete global.chrome;
    });

    // Both push raw links into the state directly (validate:false), bypassing
    // the cleanup — the shape of state a bug elsewhere could leave behind.

    test('a link whose tile throws hides only itself', async () => {
        const { getState, container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });
        const { safeUpdateState } = await import('../../javascript/core-systems/stateManager.js');

        safeUpdateState({ links: [
            link('Alpha', 'Default'),
            link('Broken', 'Default', { icon: { url: 'https://cdn.jsdelivr.net/x.png' } }), // icon.trim throws
            link('Gamma', 'Work'),
        ] }, { validate: false, skipPersistence: true });
        await settle();

        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);
        expect(getState().links).toHaveLength(3);
        expect(errorSpy).toHaveBeenCalledWith('[The Codex] Skipping a tile that failed to render:', 'Broken', expect.any(TypeError));
    });

    test('a failure part-way through rendering keeps the previous view', async () => {
        const { container } = await bootNewTab({
            links: [link('Alpha', 'Default'), link('Gamma', 'Work')],
            categories: ['Default', 'Work'],
        });
        const { safeUpdateState } = await import('../../javascript/core-systems/stateManager.js');

        safeUpdateState({ links: [link('Alpha', 'Default'), { id: 'n', name: 42, url: 'https://n.example.com/', category: 'Default' }] },
            { validate: false, skipPersistence: true });
        await settle();

        expect(tileNames(container)).toEqual(['Alpha', 'Gamma']);
        expect(errorSpy).toHaveBeenCalledWith('[The Codex] Rendering links failed; keeping the previous view:', expect.any(TypeError));
    });
});

describe('stateManager.claimStorageFields', () => {
    async function loadStateManager() {
        jest.resetModules();
        const { fireChange } = installChromeMock({});
        const stateManager = await import('../../javascript/core-systems/stateManager.js');
        return { ...stateManager, fireChange };
    }

    afterEach(() => {
        delete global.chrome;
    });

    test('unclaimed (e.g. the manage page): a sync change applies the raw stored links', async () => {
        const { getState, fireChange } = await loadStateManager();
        fireChange({ links: { newValue: JSON.stringify([link('Alpha', 'Default')]) } });
        await new Promise(r => setTimeout(r, 0)); // a links change re-reads every chunk first
        expect(getState().links.map(l => l.name)).toEqual(['Alpha']);
    });

    test('claimed fields are left to the page; other fields still apply', async () => {
        const { getState, fireChange, claimStorageFields } = await loadStateManager();
        claimStorageFields(['links', 'categories']);
        fireChange({
            links: { newValue: JSON.stringify([link('Alpha', 'Default')]) },
            categories: { newValue: JSON.stringify(['Default', 'Work']) },
            theme: { newValue: 'light' },
        });
        await new Promise(r => setTimeout(r, 0)); // applied together, after the links re-read
        expect(getState().links).toEqual([]);
        expect(getState().categories).toEqual(['Default']);
        expect(getState().theme).toBe('light');
    });

    test("claimed fields reach the page's handler exactly as stored, from sync changes and reloads; only what it returns enters the state", async () => {
        jest.resetModules();
        const stored = JSON.stringify([link('Alpha', 'Default')]);
        const { fireChange } = installChromeMock({ links: stored, theme: 'light' });
        const { getState, claimStorageFields, reloadFromStorage } = await import('../../javascript/core-systems/stateManager.js');
        const seen = [];
        claimStorageFields(['links', 'categories'], (values, source) => {
            seen.push([source, values]);
            return { links: [link('Cleaned', 'Default')] };
        });

        fireChange({ links: { newValue: stored } });
        // A reload passes every persistent key; categories isn't stored, so it
        // arrives as an own key holding undefined (absent → reset).
        await reloadFromStorage();

        expect(seen).toHaveLength(2);
        expect(seen[0][0]).toBe('sync');
        expect(seen[0][1]).toStrictEqual({ links: stored });
        expect(seen[1][0]).toBe('reload');
        expect(Object.keys(seen[1][1]).sort()).toEqual(['categories', 'links']);
        expect(seen[1][1]).toStrictEqual({ links: stored, categories: undefined });
        expect(getState().links.map(l => l.name)).toEqual(['Cleaned']);
        expect(getState().theme).toBe('light');
    });
});
