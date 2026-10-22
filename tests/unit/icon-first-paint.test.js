/**
 * Icons in the new tab's first paint.
 *
 * Tiles used to render with empty <img>s and fill in afterwards: icons were
 * resolved 5 at a time with a 100 ms pause between batches (~3.7 s for 150
 * links even with every icon stored on the device), and automatic matches
 * re-probed the network on every new tab. Now what this device already has —
 * stored icon bytes, remembered matches, generated initials — goes into the
 * first paint, and each device fetches picked icons as soon as synced links
 * arrive. Runs against the quota-faithful chrome.storage fake.
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake } from '../helpers/chromeStorageFake.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 24 * 60 * 60 * 1000;
const iconUrl = (slug) => `https://cdn.jsdelivr.net/gh/selfhst/icons/webp/${slug}.webp`;
const storedIcon = (url, data = PNG) => ({ [`iconV1:${url}`]: { url, data, size: data.length, fetchedAt: Date.now(), lastUsed: Date.now() } });
const sourceKey = (link) => JSON.stringify([link.url, link.name, link.icon && link.icon !== 'default' ? link.icon : '']);

const link = (name, extra = {}) => ({
    id: `id-${name}`,
    name,
    url: `https://${name.toLowerCase()}.example.net/`,
    category: 'Default',
    icon: 'default',
    ...extra
});

const flushSources = () => new Promise((resolve) => setTimeout(resolve, 600)); // past the 500 ms batch

function mockFetch(okUrls) {
    return jest.fn(async (url) => (okUrls.includes(url)
        ? {
            ok: true,
            status: 200,
            headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
            blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
        }
        : { ok: false, status: 404, headers: { get: () => null } }));
}

describe('resolveCachedIcons: what the first paint can show without the network', () => {
    let fake;
    let icons;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        icons = await import('../../javascript/features/iconCache.js');
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
    });

    test('picked icons come from the byte store; unstored ones are left to the full load', async () => {
        const picked = link('Plex', { icon: iconUrl('plex') });
        const unstored = link('Sonarr', { icon: iconUrl('sonarr') });
        const inline = link('Inline', { icon: PNG });
        fake.seed('local', storedIcon(iconUrl('plex'), 'data:image/png;base64,UExFWA=='));

        const found = await icons.resolveCachedIcons([picked, unstored, inline]);

        expect(found.get(picked)).toEqual({ src: 'data:image/png;base64,UExFWA==', fresh: true, storedUrl: iconUrl('plex'), network: false });
        expect(found.has(unstored)).toBe(false);
        expect(found.get(inline)).toMatchObject({ src: PNG, fresh: true });
    });

    test('automatic matches are painted from what this device remembered', async () => {
        const selfhst = link('Jellyfin');
        const google = link('Wiki');
        const initials = link('Zqx App');
        const unknown = link('Never Seen');
        const googleUrl = 'https://www.google.com/s2/favicons?domain=wiki.example.net&sz=128';
        fake.seed('local', {
            ...storedIcon(iconUrl('jellyfin')),
            iconSourcesV1: {
                [sourceKey(selfhst)]: { src: iconUrl('jellyfin'), at: Date.now() },
                [sourceKey(google)]: { src: googleUrl, at: Date.now() },
                [sourceKey(initials)]: { src: 'generated', at: Date.now() }
            }
        });

        const found = await icons.resolveCachedIcons([selfhst, google, initials, unknown]);

        expect(found.get(selfhst)).toEqual({ src: PNG, fresh: true, storedUrl: iconUrl('jellyfin'), network: false });
        expect(found.get(google)).toEqual({ src: googleUrl, fresh: true, storedUrl: null, network: true });
        expect(found.get(initials).src).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(found.has(unknown)).toBe(false);
    });

    test('remembered matches go stale (re-matched in the background, still painted)', async () => {
        const week = link('Old Match');
        const initials = link('Offline Once');
        fake.seed('local', {
            ...storedIcon(iconUrl('old-match')),
            iconSourcesV1: {
                [sourceKey(week)]: { src: iconUrl('old-match'), at: Date.now() - 8 * DAY },
                [sourceKey(initials)]: { src: 'generated', at: Date.now() - 2 * DAY }
            }
        });

        const found = await icons.resolveCachedIcons([week, initials]);

        expect(found.get(week)).toMatchObject({ src: PNG, fresh: false });
        expect(found.get(initials)).toMatchObject({ fresh: false }); // initials retry daily
    });

    test('an icon this page already resolved keeps the fallback if it is a network URL', async () => {
        const { resolveCachedIcons } = await import('../../javascript/features/iconSources.js');
        const favicon = link('Wiki');
        const stored = link('Plex');
        const inMemory = (l) => (l === favicon ? 'https://www.google.com/s2/favicons?domain=wiki&sz=128' : PNG);

        const found = await resolveCachedIcons([favicon, stored], { inMemory, initialsFor: () => null });

        expect(found.get(favicon)).toMatchObject({ fresh: true, network: true });
        expect(found.get(stored)).toMatchObject({ fresh: true, network: false });
    });

    test('links whose url and name only join alike keep separate remembered sources', async () => {
        const { iconCacheKey } = await import('../../javascript/features/iconSources.js');
        const a = { url: 'https://host', name: '8080:Admin', icon: 'default' };
        const b = { url: 'https://host:8080', name: 'Admin', icon: null };
        expect(iconCacheKey(a)).not.toBe(iconCacheKey(b));
        expect(iconCacheKey({ ...a, icon: null })).toBe(iconCacheKey(a)); // no icon = 'default'
    });

    test('a remembered source on any other host is never painted', async () => {
        const odd = link('Odd');
        fake.seed('local', {
            ...storedIcon('https://evil.example.com/x.png'),
            iconSourcesV1: { [sourceKey(odd)]: { src: 'https://evil.example.com/x.png', at: Date.now() } }
        });

        expect((await icons.resolveCachedIcons([odd])).has(odd)).toBe(false);
    });

    test('an automatic match is remembered, so the next new tab paints it', async () => {
        const jellyfin = link('Jellyfin');
        globalThis.fetch = mockFetch([iconUrl('jellyfin')]);

        await icons.loadIconWithCache(jellyfin, { allowFavicon: false });
        await flushSources();
        expect(fake.dump('local').iconSourcesV1[sourceKey(jellyfin)]).toMatchObject({ src: iconUrl('jellyfin') });

        // A new tab: a fresh module (no in-memory cache), no network.
        jest.resetModules();
        globalThis.fetch = jest.fn(() => { throw new Error('no network in the first paint'); });
        const nextTab = await import('../../javascript/features/iconCache.js');
        const found = await nextTab.resolveCachedIcons([jellyfin]);
        expect(found.get(jellyfin).src).toMatch(/^data:image\/png;base64,/);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('a re-match that only reaches initials (e.g. offline) keeps the logo found before', async () => {
        const jellyfin = link('Jellyfin');
        const before = { src: iconUrl('jellyfin'), at: Date.now() - 8 * DAY };
        fake.seed('local', { iconSourcesV1: { [sourceKey(jellyfin)]: before } });

        await icons.loadIconWithCache(jellyfin, { allowSelfhst: false, allowFavicon: false });
        await flushSources();

        expect(fake.dump('local').iconSourcesV1[sourceKey(jellyfin)]).toEqual(before);
    });

    test('two tabs remembering sources at once keep both (the merge runs under a shared lock)', async () => {
        // A stand-in for the Web Locks API every extension context shares.
        const tails = new Map();
        globalThis.navigator.locks = {
            request: (name, task) => {
                const run = (tails.get(name) ?? Promise.resolve()).then(() => task());
                tails.set(name, run.catch(() => {}));
                return run;
            }
        };
        // Reads whose results take a moment to arrive, so both tabs read the
        // stored map before either writes.
        const realGet = chrome.storage.local.get;
        chrome.storage.local.get = (...args) => realGet(...args)
            .then((value) => new Promise((resolve) => setTimeout(() => resolve(value), 30)));
        try {
            const tabA = await import('../../javascript/features/iconSources.js');
            jest.resetModules();
            const tabB = await import('../../javascript/features/iconSources.js');
            const plex = link('Plex');
            const sonarr = link('Sonarr');

            tabA.rememberIconSource(plex, iconUrl('plex'));
            tabB.rememberIconSource(sonarr, iconUrl('sonarr'));
            await flushSources();

            await new Promise((resolve) => setTimeout(resolve, 200)); // both merges done

            expect(Object.keys(fake.dump('local').iconSourcesV1).sort()).toEqual([sourceKey(plex), sourceKey(sonarr)].sort());
        } finally {
            chrome.storage.local.get = realGet;
            delete globalThis.navigator.locks;
        }
    });

    test('sources of links not seen for two months are forgotten', async () => {
        const gone = link('Deleted Long Ago');
        const kept = link('Jellyfin');
        globalThis.fetch = mockFetch([iconUrl('jellyfin')]);
        fake.seed('local', { iconSourcesV1: { [sourceKey(gone)]: { src: 'generated', at: Date.now() - 61 * DAY } } });

        await icons.loadIconWithCache(kept, { allowFavicon: false });
        await flushSources();

        expect(Object.keys(fake.dump('local').iconSourcesV1)).toEqual([sourceKey(kept)]);
    });
});

describe('createTile with an icon already resolved', () => {
    test('paints it at once and hides the placeholder; without one the tile waits as before', async () => {
        const { createTile } = await import('../../javascript/core-systems/tileRenderer.js');

        const painted = createTile(link('Plex'), { iconSrc: PNG });
        expect(painted.querySelector('.tile-icon').getAttribute('src')).toBe(PNG);
        expect(painted.querySelector('.tile-placeholder').style.display).toBe('none');
        expect(painted.querySelector('.tile-icon').dataset.linkId).toBe('id-Plex'); // still upkept after paint

        const waiting = createTile(link('Sonarr'));
        expect(waiting.querySelector('.tile-icon').getAttribute('src')).toBe('');
        expect(waiting.querySelector('.tile-placeholder').style.display).toBe('');
    });
});

describe('warmIconStore: picked icons fetched before a new tab needs them', () => {
    let fake;

    beforeEach(() => {
        fake = installChromeStorageFake();
        jest.resetModules();
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
    });

    test('fetches only pinned-host icons this device lacks', async () => {
        const { warmIconStore } = await import('../../javascript/features/iconStore.js');
        fake.seed('local', storedIcon(iconUrl('plex')));
        globalThis.fetch = mockFetch([iconUrl('sonarr'), iconUrl('radarr')]);

        const fetched = await warmIconStore([
            iconUrl('plex'), iconUrl('sonarr'), iconUrl('radarr'), iconUrl('sonarr'),
            'default', null, PNG, 'https://www.google.com/s2/favicons?domain=x&sz=128'
        ]);

        expect(fetched).toBe(2);
        expect(globalThis.fetch.mock.calls.map(([url]) => url).sort()).toEqual([iconUrl('radarr'), iconUrl('sonarr')]);
        expect(fake.dump('local')[`iconV1:${iconUrl('sonarr')}`].data).toMatch(/^data:image\/png;base64,/);
    });

    test('returns only once the icons are stored, and counts only those stored', async () => {
        const { warmIconStore } = await import('../../javascript/features/iconStore.js');
        globalThis.fetch = mockFetch([iconUrl('sonarr'), iconUrl('radarr')]);
        // Writes that take a while; radarr's never succeeds (e.g. quota, even after pruning).
        const realSet = chrome.storage.local.set;
        chrome.storage.local.set = (items) => new Promise((resolve) => setTimeout(resolve, 30))
            .then(() => (Object.keys(items).some((key) => key.includes('radarr'))
                ? Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'))
                : realSet(items)));

        const fetched = await warmIconStore([iconUrl('sonarr'), iconUrl('radarr')]);

        expect(fetched).toBe(1);
        expect(fake.dump('local')[`iconV1:${iconUrl('sonarr')}`]).toBeDefined();
        expect(fake.dump('local')[`iconV1:${iconUrl('radarr')}`]).toBeUndefined();
    });
});

describe('the new tab', () => {
    let fake;

    beforeEach(() => {
        fake = installChromeStorageFake();
        Object.assign(fake.chrome.runtime, {
            getURL: (p) => `chrome-extension://test/${p}`,
            sendMessage: jest.fn(),
            onMessage: { addListener: jest.fn() },
            getManifest: () => ({ version: 'test' })
        });
        jest.resetModules();
        document.body.innerHTML = `
            <div class="app-container">
                <input type="text" id="searchInput">
                <datalist id="searchSuggestions"></datalist>
                <div id="sync-status-container"></div>
                <main id="linksContainer"></main>
            </div>`;
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
    });

    test('shows icons this device has in its first paint, with no network', async () => {
        const picked = link('Plex', { icon: iconUrl('plex') });
        const matched = link('Jellyfin');
        fake.seed('sync', { links: JSON.stringify([picked, matched]), categories: '["Default"]' });
        fake.seed('local', {
            ...storedIcon(iconUrl('plex')),
            ...storedIcon(iconUrl('jellyfin')),
            iconSourcesV1: { [sourceKey(matched)]: { src: iconUrl('jellyfin'), at: Date.now() } }
        });
        globalThis.fetch = jest.fn(() => { throw new Error('offline'); });
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const container = document.getElementById('linksContainer');
        let firstPaint;
        new MutationObserver(() => {
            const icons = container.querySelectorAll('.tile-icon');
            if (icons.length && !firstPaint) firstPaint = [...icons].map((img) => img.getAttribute('src'));
        }).observe(container, { childList: true, subtree: true });

        await import('../../javascript/entry-points/script.js');
        const start = Date.now();
        while (!firstPaint && Date.now() - start < 3000) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        // The moment tiles appear, every icon is already set.
        expect(firstPaint).toEqual([PNG, PNG]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('remembered favicons still loading (lazy, below the fold) do not hold up other tiles', async () => {
        // Seven remembered favicons, more than the six loaders, then a picked
        // icon this device hasn't stored yet.
        const favicons = Array.from({ length: 7 }, (_, i) => link(`Site${i}`));
        const picked = link('Plex', { icon: iconUrl('plex') });
        fake.seed('sync', { links: JSON.stringify([...favicons, picked]), categories: '["Default"]' });
        fake.seed('local', {
            iconSourcesV1: Object.fromEntries(favicons.map((l) => [sourceKey(l),
                { src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(l.url)}&sz=128`, at: Date.now() }]))
        });
        globalThis.fetch = mockFetch([iconUrl('plex')]);
        jest.spyOn(console, 'log').mockImplementation(() => {});
        // A lazy <img> below the fold hasn't started loading.
        const complete = jest.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
        try {
            const container = document.getElementById('linksContainer');
            let firstPaint;
            new MutationObserver(() => {
                const icons = container.querySelectorAll('.tile-icon');
                if (icons.length && !firstPaint) firstPaint = [...icons].map((img) => img.getAttribute('src'));
            }).observe(container, { childList: true, subtree: true });

            await import('../../javascript/entry-points/script.js');
            const start = Date.now();
            const pickedSrc = () => [...container.querySelectorAll('.tile-icon')].find((img) => img.dataset.linkId === 'id-Plex')?.getAttribute('src');
            while (!/^data:image\/png/.test(pickedSrc() ?? '') && Date.now() - start < 2000) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }

            // The favicons were painted from memory, and the picked icon still
            // resolved without waiting behind them.
            expect(firstPaint.slice(0, 7).every((src) => src.startsWith('https://www.google.com/s2/favicons?'))).toBe(true);
            expect(pickedSrc()).toMatch(/^data:image\/png;base64,/);
            expect(Date.now() - start).toBeLessThan(1500); // not behind 3 s favicon waits
        } finally {
            complete.mockRestore();
        }
    });

    test('a remembered favicon that fails to load (offline, not in the HTTP cache) falls back to initials', async () => {
        const wiki = link('Wiki', { url: 'http://192.168.1.5/' });
        const googleUrl = 'https://www.google.com/s2/favicons?domain=wiki.example.net&sz=128';
        fake.seed('sync', { links: JSON.stringify([wiki]), categories: '["Default"]' });
        fake.seed('local', { iconSourcesV1: { [sourceKey(wiki)]: { src: googleUrl, at: Date.now() } } });
        globalThis.fetch = mockFetch([]); // selfh.st has no match
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const container = document.getElementById('linksContainer');
        let firstPaintSrc;
        new MutationObserver(() => {
            firstPaintSrc ??= container.querySelector('.tile-icon')?.getAttribute('src');
        }).observe(container, { childList: true, subtree: true });

        await import('../../javascript/entry-points/script.js');
        const start = Date.now();
        let img;
        while (!(img = container.querySelector('.tile-icon')) && Date.now() - start < 5000) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // jsdom loads no images: fail the favicon as the browser would.
        img.dispatchEvent(new Event('error'));
        const failedAt = Date.now();
        while (!/^data:image\/svg/.test(img.getAttribute('src')) && Date.now() - failedAt < 5000) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        expect(firstPaintSrc).toBe(googleUrl); // painted from memory
        expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(img.style.display).toBe('block');
    }, 15000);
});
