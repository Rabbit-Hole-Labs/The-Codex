/**
 * iconCache.loadIconWithCache: pins the order sources are tried in (custom >
 * selfh.st match > Google favicon > initials), which options switch each one
 * off, the timeout each probe gets, what is remembered and announced for a
 * match, and the stats/logging of a miss or an error.
 *
 * The byte-store and remembered sources are replaced by recorders, and Image
 * by a fake that loads only the URLs a test allows, so every storage lookup,
 * probe and side effect lands in one ordered log.
 */
import { jest } from '@jest/globals';

const log = [];
const stored = new Map();   // url -> { data, notFound }
const loadable = new Set(); // URLs the fake Image loads

jest.unstable_mockModule('../../javascript/features/iconStore.js', () => ({
    loadStoredIcon: jest.fn(async (url, timeout) => {
        log.push(['store', url, timeout]);
        return stored.get(url) ?? { data: null, notFound: false };
    })
}));

jest.unstable_mockModule('../../javascript/features/iconSources.js', () => ({
    GENERATED_SOURCE: 'generated',
    iconCacheKey: (link) => {
        const icon = link.icon && link.icon !== 'default' ? link.icon : '';
        return JSON.stringify([link.url ?? '', link.name ?? '', icon]);
    },
    rememberIconSource: jest.fn((link, src) => { log.push(['remember', link.name, src]); }),
    resolveCachedIcons: jest.fn(),
    refreshCachedIcon: jest.fn()
}));

class FakeImage {
    set src(url) {
        if (!url) return;
        log.push(['probe', url]);
        queueMicrotask(() => (loadable.has(url) ? this.onload?.() : this.onerror?.()));
    }
}

const selfhst = (slug) => `https://cdn.jsdelivr.net/gh/selfhst/icons/webp/${slug}.webp`;
const google = (host) => `https://www.google.com/s2/favicons?domain=${host}&sz=128`;
const PNG_URI = 'data:image/png;base64,iVBORw0KGgo=';

describe('loadIconWithCache', () => {
    let icons;
    let warn;
    let error;

    beforeEach(async () => {
        log.length = 0;
        stored.clear();
        loadable.clear();
        global.Image = FakeImage;
        jest.resetModules();
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        error = jest.spyOn(console, 'error').mockImplementation(() => {});
        icons = await import('../../javascript/features/iconCache.js');
        icons.setSelfhstMatchListener((link, url) => log.push(['matched', link.name, url]));
    });

    afterEach(() => {
        icons.stopCacheCleanup();
        jest.restoreAllMocks();
    });

    test('a null link returns null without counting a request', async () => {
        expect(await icons.loadIconWithCache(null)).toBeNull();
        expect(icons.getCacheStats().totalRequests).toBe(0);
    });

    test('a valid data: custom icon is returned and cached, with nothing else tried', async () => {
        const link = { name: 'Plex', url: 'https://plex.tv', icon: PNG_URI };
        expect(await icons.loadIconWithCache(link)).toBe(PNG_URI);
        expect(await icons.loadIconWithCache(link)).toBe(PNG_URI);
        expect(log).toEqual([]);
        const stats = icons.getCacheStats();
        expect([stats.totalRequests, stats.hits, stats.misses, stats.failures, stats.cacheSize]).toEqual([2, 1, 1, 0, 1]);
    });

    test('a picked selfh.st icon renders from the byte-store, with the CSP-capped timeout', async () => {
        const picked = selfhst('plex-light');
        stored.set(picked, { data: PNG_URI, notFound: false });
        const link = { name: 'Plex', url: 'https://plex.tv', icon: picked };
        expect(await icons.loadIconWithCache(link, { timeout: 9000 })).toBe(PNG_URI);
        expect(log).toEqual([['store', picked, 3000]]);
    });

    test('a picked icon the store cannot fetch is probed and renders verbatim', async () => {
        const picked = selfhst('plex-light');
        loadable.add(picked);
        const link = { name: 'Plex', url: 'https://plex.tv', icon: picked };
        expect(await icons.loadIconWithCache(link)).toBe(picked);
        expect(log).toEqual([['store', picked, 3000], ['probe', picked]]);
    });

    test('a custom icon on a disallowed host falls through to the selfh.st match', async () => {
        loadable.add(selfhst('plex'));
        const link = { name: 'Plex', url: 'https://plex.tv', icon: 'https://evil.example/x.png' };
        expect(await icons.loadIconWithCache(link)).toBe(selfhst('plex'));
        expect(log).toEqual([
            ['store', selfhst('plex'), 3000],
            ['probe', selfhst('plex')],
            ['remember', 'Plex', selfhst('plex')],
            ['matched', 'Plex', selfhst('plex')]
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Custom icon rejected'), 'evil.example');
    });

    test('preferCustom: false skips a valid custom icon', async () => {
        const link = { name: 'Plex', url: 'https://plex.tv', icon: PNG_URI };
        const result = await icons.loadIconWithCache(link, { preferCustom: false, respectCSP: false });
        expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(log[0]).toEqual(['store', selfhst('plex'), 5000]);
    });

    test('selfh.st: a stored 404 skips the probe; a stored hit is rendered from bytes but remembered by URL', async () => {
        stored.set(selfhst('my-app'), { data: null, notFound: true });
        stored.set(selfhst('sonarr'), { data: PNG_URI, notFound: false });
        const link = { name: 'My App', url: 'https://sonarr.lan:8989/' };
        expect(await icons.loadIconWithCache(link)).toBe(PNG_URI);
        expect(log).toEqual([
            ['store', selfhst('my-app'), 3000],
            ['store', selfhst('sonarr'), 3000],
            ['remember', 'My App', selfhst('sonarr')],
            ['matched', 'My App', selfhst('sonarr')]
        ]);
    });

    test('with respectCSP (the default) and no allowFavicon/allowGenerated, a miss returns null and counts a failure', async () => {
        const link = { name: 'Nothing', url: 'https://nothing.example' };
        expect(await icons.loadIconWithCache(link)).toBeNull();
        expect(log).toEqual([
            ['store', selfhst('nothing'), 3000], ['probe', selfhst('nothing')]
        ]);
        expect(warn).toHaveBeenCalledWith('Failed to load icon for: Nothing');
        const stats = icons.getCacheStats();
        expect([stats.misses, stats.failures, stats.cacheSize]).toEqual([1, 1, 0]);
    });

    test('respectCSP: false enables the Google favicon (by default) with the uncapped timeout', async () => {
        loadable.add(google('github.com'));
        const link = { name: 'Code', url: 'https://github.com/x' };
        expect(await icons.loadIconWithCache(link, { respectCSP: false, timeout: 7000 })).toBe(google('github.com'));
        expect(log).toEqual([
            ['store', selfhst('code'), 7000], ['probe', selfhst('code')],
            ['store', selfhst('github'), 7000], ['probe', selfhst('github')],
            ['probe', google('github.com')],
            ['remember', 'Code', google('github.com')]
        ]);
    });

    test('with respectCSP, allowFavicon: true enables Google; allowSelfhst: false skips the match', async () => {
        loadable.add(google('github.com'));
        const link = { name: 'Code', url: 'https://github.com/x' };
        expect(await icons.loadIconWithCache(link, { allowFavicon: true, allowSelfhst: false })).toBe(google('github.com'));
        expect(log).toEqual([['probe', google('github.com')], ['remember', 'Code', google('github.com')]]);
    });

    test('local hosts skip Google and end in remembered initials', async () => {
        const link = { name: 'Router', url: 'http://192.168.1.1/' };
        const result = await icons.loadIconWithCache(link, { respectCSP: false });
        expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(log).toEqual([
            ['store', selfhst('router'), 5000], ['probe', selfhst('router')],
            ['remember', 'Router', 'generated']
        ]);
        expect(await icons.loadIconWithCache(link, { respectCSP: false })).toBe(result);
        expect(log).toHaveLength(3);
    });

    test('respectCSP: false honours allowSelfhst/allowFavicon/allowGenerated: false', async () => {
        const link = { name: 'Code', url: 'https://github.com/x' };
        const off = { respectCSP: false, allowSelfhst: false, allowFavicon: false, allowGenerated: false };
        expect(await icons.loadIconWithCache(link, off)).toBeNull();
        expect(log).toEqual([]);
        expect(icons.getCacheStats().failures).toBe(1);
    });

    test('an error while matching is logged, counted and returns null', async () => {
        loadable.add(selfhst('plex'));
        icons.setSelfhstMatchListener(() => { throw new Error('boom'); });
        const link = { name: 'Plex', url: 'https://plex.tv' };
        expect(await icons.loadIconWithCache(link)).toBeNull();
        expect(error).toHaveBeenCalledWith('Error loading icon for Plex:', expect.any(Error));
        const stats = icons.getCacheStats();
        expect([stats.misses, stats.failures, stats.cacheSize]).toEqual([1, 1, 0]);
    });

    test("an unnamed link's miss is logged as unknown", async () => {
        expect(await icons.loadIconWithCache({ url: '' }, { allowSelfhst: false })).toBeNull();
        expect(warn).toHaveBeenCalledWith('Failed to load icon for: unknown');
    });
});
