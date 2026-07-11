/**
 * Tests for the persistent icon byte-store — the fix for icons re-fetching
 * from the CDN on every new tab (pop-in, and broken tiles offline).
 */
import {
    isCacheableIconUrl,
    selectEvictions,
    fetchIconAsDataUri,
    loadStoredIcon,
    pruneIconStore
} from '../../javascript/features/iconStore.js';

// Minimal in-memory chrome.storage.local with the MV3 promise API.
function installChromeStorageMock() {
    const data = {};
    global.chrome = {
        storage: {
            local: {
                get: jest.fn(async (keys) => {
                    if (keys == null) return { ...data };
                    const list = Array.isArray(keys) ? keys : [keys];
                    const out = {};
                    for (const k of list) if (k in data) out[k] = data[k];
                    return out;
                }),
                set: jest.fn(async (items) => { Object.assign(data, items); }),
                remove: jest.fn(async (keys) => {
                    (Array.isArray(keys) ? keys : [keys]).forEach(k => delete data[k]);
                })
            }
        }
    };
    return data;
}

function mockFetchImage(bytes = [137, 80, 78, 71], type = 'image/png') {
    return jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
        blob: async () => new Blob([new Uint8Array(bytes)], { type })
    }));
}

describe('isCacheableIconUrl', () => {
    it('accepts the pinned icon hosts over https', () => {
        expect(isCacheableIconUrl('https://cdn.jsdelivr.net/gh/selfhst/icons/webp/plex.webp')).toBe(true);
        expect(isCacheableIconUrl('https://cdn.selfh.st/icons/webp/plex.webp')).toBe(true);
        expect(isCacheableIconUrl('https://www.google.com/s2/favicons?domain=x.com&sz=128')).toBe(true);
    });

    it('rejects other hosts, schemes, and non-URLs', () => {
        expect(isCacheableIconUrl('https://example.com/icon.png')).toBe(false);
        expect(isCacheableIconUrl('http://cdn.jsdelivr.net/icon.png')).toBe(false);
        expect(isCacheableIconUrl('data:image/png;base64,AAAA')).toBe(false);
        expect(isCacheableIconUrl('not a url')).toBe(false);
    });
});

describe('selectEvictions', () => {
    it('evicts oldest-used entries until the total fits the budget', () => {
        const entries = [
            { key: 'a', size: 40, lastUsed: 3 },
            { key: 'b', size: 40, lastUsed: 1 }, // oldest
            { key: 'c', size: 40, lastUsed: 2 }
        ];
        expect(selectEvictions(entries, 90)).toEqual(['b']);
        expect(selectEvictions(entries, 50)).toEqual(['b', 'c']);
    });

    it('evicts nothing when already under budget', () => {
        expect(selectEvictions([{ key: 'a', size: 10, lastUsed: 1 }], 100)).toEqual([]);
    });
});

describe('loadStoredIcon', () => {
    const URL_OK = 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/plex.webp';

    beforeEach(() => {
        jest.resetModules();
        installChromeStorageMock();
    });

    it('fetches once, persists, and serves from the store afterwards', async () => {
        global.fetch = mockFetchImage();

        const first = await loadStoredIcon(URL_OK);
        expect(first.data).toMatch(/^data:image\/png;base64,/);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        // Persist is fire-and-forget; let it settle.
        await new Promise(r => setTimeout(r, 0));

        const second = await loadStoredIcon(URL_OK);
        expect(second.data).toBe(first.data);
        expect(global.fetch).toHaveBeenCalledTimes(1); // no re-fetch
    });

    it('reports a definite upstream 404 so callers can skip probing', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } }));
        const result = await loadStoredIcon(URL_OK);
        expect(result).toEqual({ data: null, notFound: true });
    });

    it('reports indeterminate failures (CORS/offline) without notFound', async () => {
        global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
        const result = await loadStoredIcon(URL_OK);
        expect(result).toEqual({ data: null, notFound: false });
    });

    it('ignores non-cacheable URLs without touching the network', async () => {
        global.fetch = jest.fn();
        const result = await loadStoredIcon('https://example.com/icon.png');
        expect(result).toEqual({ data: null, notFound: false });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects non-image responses as definite misses', async () => {
        global.fetch = mockFetchImage([60, 104, 116, 109, 108, 62], 'text/html');
        const result = await loadStoredIcon(URL_OK);
        expect(result.data).toBeNull();
        expect(result.notFound).toBe(true);
    });
});

describe('fetchIconAsDataUri', () => {
    it('encodes fetched image bytes as a data URI', async () => {
        global.fetch = mockFetchImage();
        const { data, notFound } = await fetchIconAsDataUri('https://cdn.jsdelivr.net/x.webp');
        expect(notFound).toBe(false);
        expect(data).toMatch(/^data:image\/png;base64,/);
    });
});

describe('pruneIconStore', () => {
    it('removes least-recently-used entries beyond the byte budget', async () => {
        const data = installChromeStorageMock();
        // Two entries: one huge and stale, one small and fresh.
        data['iconV1:https://cdn.jsdelivr.net/old.webp'] =
            { url: 'old', data: 'x', size: 7 * 1024 * 1024, lastUsed: 1, fetchedAt: 1 };
        data['iconV1:https://cdn.jsdelivr.net/new.webp'] =
            { url: 'new', data: 'y', size: 1024, lastUsed: 2, fetchedAt: 2 };
        data['unrelatedKey'] = { keep: true };

        await pruneIconStore();

        expect(data['iconV1:https://cdn.jsdelivr.net/old.webp']).toBeUndefined();
        expect(data['iconV1:https://cdn.jsdelivr.net/new.webp']).toBeDefined();
        expect(data['unrelatedKey']).toBeDefined();
    });
});
