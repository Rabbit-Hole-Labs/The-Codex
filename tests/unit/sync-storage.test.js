/**
 * links in chrome.storage.sync, split across several items (syncStorage.js).
 *
 * Chrome caps each sync item at 8192 bytes, and links is a JSON string whose
 * quotes Chrome escapes again, so ~40 links with icon URLs filled it: every
 * later save fell back to local storage (or was refused) and vanished on
 * reload. Runs the real modules against the quota-faithful chrome.storage
 * fake, which rejects exactly what Chrome rejects.
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake, itemBytes, SYNC_QUOTAS } from '../helpers/chromeStorageFake.js';

// A link as the icon picker leaves it: a selfh.st icon URL on every tile.
const link = (i) => ({
    id: `link_1729512345678_${i}_abc123`,
    name: `Service ${i}`,
    url: `https://service${i}.home.example.net:8443/`,
    category: i % 2 ? 'Homelab' : 'Work',
    icon: `https://cdn.jsdelivr.net/gh/selfhst/icons/webp/service-${i}.webp`,
    size: 'medium'
});
const links = (n, from = 0) => Array.from({ length: n }, (_, i) => link(from + i));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('links split across sync items', () => {
    let fake;
    let storage;
    let saveLinks;
    let loadLinks;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        storage = await import('../../javascript/core-systems/syncStorage.js');
        ({ saveLinks, loadLinks } = await import('../../javascript/core-systems/storageManager.js'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete globalThis.chrome;
    });

    const syncKeys = () => Object.keys(fake.dump('sync')).sort();

    test('a list that fits one item is stored exactly as before, with a one-chunk manifest', async () => {
        const list = links(5);
        expect(await saveLinks(list)).toBe(true);

        const sync = fake.dump('sync');
        expect(sync.links).toBe(JSON.stringify(list));
        expect(sync.linksManifest).toEqual({ chunks: 1, hashes: [expect.any(String)] });
        expect(syncKeys()).toEqual(['links', 'linksManifest']);
        expect((await loadLinks()).links).toEqual(list);
    });

    test('a list over 8 KB saves to sync (not local) and loads back whole, in order', async () => {
        const list = links(150);
        expect(itemBytes('links', JSON.stringify(list))).toBeGreaterThan(SYNC_QUOTAS.QUOTA_BYTES_PER_ITEM);

        expect(await saveLinks(list)).toBe(true);

        // The fake enforces Chrome's per-item quota, so every item is within it.
        const sync = fake.dump('sync');
        expect(sync.linksManifest.chunks).toBeGreaterThan(1);
        for (const [key, value] of Object.entries(sync)) {
            expect(itemBytes(key, value)).toBeLessThanOrEqual(SYNC_QUOTAS.QUOTA_BYTES_PER_ITEM);
        }
        // Every chunk is itself a plain links array.
        expect(JSON.parse(sync.links)).toEqual(list.slice(0, JSON.parse(sync.links).length));
        // Nothing fell back to this device only.
        expect(fake.dump('local').links).toBeUndefined();
        expect(fake.dump('local')['pendingSyncSince.links']).toBeUndefined();

        expect((await loadLinks()).links).toEqual(list);
    });

    test('an icon change on a large list persists (the reported bug)', async () => {
        const list = links(120);
        await saveLinks(list);

        const edited = list.map((l, i) => (i === 100
            ? { ...l, icon: 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/home-assistant-light.webp' }
            : l));
        expect(await saveLinks(edited)).toBe(true);

        expect((await loadLinks()).links[100].icon).toMatch(/home-assistant-light/);
    });

    test('a shrinking list blanks the chunks it no longer uses, in the same write', async () => {
        await saveLinks(links(300));
        const before = fake.dump('sync').linksManifest.chunks;
        const bytesBefore = fake.bytesInUse('sync');

        const setSpy = jest.spyOn(chrome.storage.sync, 'set');
        await saveLinks(links(3));

        const sync = fake.dump('sync');
        expect(before).toBeGreaterThan(2);
        expect(sync.linksManifest.chunks).toBe(1);
        // One write carried the new list, its manifest and the blanks.
        expect(setSpy).toHaveBeenCalledTimes(1);
        for (let i = 1; i < before; i++) expect(sync[`links.${i}`]).toBe('');
        expect(fake.bytesInUse('sync')).toBeLessThan(bytesBefore / 10);
        expect((await loadLinks()).links).toEqual(links(3));
    });

    test('characters Chrome escapes extra (<, U+2028) and multi-byte text still fit each item', async () => {
        const list = links(200).map((l, i) => ({ ...l, name: `<b>Ünïcödé ${i}</b>\u2028😀` }));
        expect(await saveLinks(list)).toBe(true); // the fake would reject an over-quota item
        expect((await loadLinks()).links).toEqual(list);
    });

    test('a list too big even split falls back to this device and says so', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await saveLinks(links(2));

        expect(await saveLinks(links(900))).toBe(true);

        expect(JSON.parse(fake.dump('sync').links)).toEqual(links(2)); // cloud untouched
        expect(JSON.parse(fake.dump('local').links)).toHaveLength(900);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/don't fit in Chrome sync storage/), expect.stringMatching(/QUOTA_BYTES|kQuotaBytes/));
    });

    test('data written before chunking (no manifest) reads as before', async () => {
        const list = links(4);
        fake.seed('sync', { links: JSON.stringify(list), theme: 'light' });

        expect(await storage.syncGet(['links', 'theme'])).toEqual({ links: JSON.stringify(list), theme: 'light' });
        await expect(storage.readSyncLinks()).resolves.toEqual({ value: JSON.stringify(list), consistent: true });
    });

    test('syncGet(null) hides chunk and manifest keys', async () => {
        await storage.syncSet({ links: JSON.stringify(links(150)), theme: 'dark' });

        const all = await storage.syncGet(null);
        expect(Object.keys(all).sort()).toEqual(['links', 'theme']);
        expect(JSON.parse(all.links)).toEqual(links(150));
    });

    describe('a save from another device that has only partly arrived', () => {
        // The other device's write, split into what arrives first and the rest.
        function tornWrite(list) {
            const { items } = storage.encodeLinksForSync(JSON.stringify(list));
            const { linksManifest, ...chunks } = items;
            return { manifest: { linksManifest }, chunks };
        }

        test('is detected, and loads use what is there', async () => {
            await saveLinks(links(150));
            const { manifest } = tornWrite(links(160));
            fake.seed('sync', manifest); // manifest arrived, chunks not yet

            const read = await storage.readSyncLinks();
            expect(read.consistent).toBe(false);
            expect(JSON.parse(read.value)).toEqual(links(150)); // the chunks still hold the old list
        });

        test('open pages wait for the rest instead of showing half a list', async () => {
            const { getState, safeUpdateState } = await import('../../javascript/core-systems/stateManager.js');
            await saveLinks(links(150));
            safeUpdateState({ links: links(150) }, { validate: false, skipPersistence: true });

            const next = [...links(150), ...links(30, 500)];
            const { manifest, chunks } = tornWrite(next);
            // The chunks land first (one onChanged), then the manifest (another).
            await chrome.storage.sync.set(chunks);
            await flush();
            expect(getState().links).toEqual(links(150)); // mixed state not applied

            await chrome.storage.sync.set(manifest);
            await flush();
            expect(getState().links).toEqual(next);
        });

        test('Sync now refuses to decide from it, and says why', async () => {
            const { SyncManager } = await import('../../javascript/core-systems/syncManager.js');
            const syncManager = new SyncManager();
            const events = [];
            syncManager.addSyncListener((event, data) => events.push({ event, data }));
            await saveLinks(links(150));
            fake.seed('sync', tornWrite(links(160)).manifest);

            const result = await syncManager.syncData();

            expect(result.success).toBe(false);
            expect(events.find((e) => e.event === 'syncError').data.type).toBe('sync_incomplete');
            // Nothing was written over the cloud.
            expect(fake.dump('sync').syncMetadata).toBeUndefined();
        });
    });

    test('Sync now pushes a large list that had fallen back to this device', async () => {
        const { SyncManager } = await import('../../javascript/core-systems/syncManager.js');
        const syncManager = new SyncManager();
        // e.g. saved by 7.0.0.42, which fell back to local over the item quota.
        const list = links(150);
        fake.seed('local', { links: JSON.stringify(list), categories: '["Default","Homelab","Work"]' });

        const result = await syncManager.syncData();

        expect(result.success).toBe(true);
        expect((await loadLinks()).links).toEqual(list);
        expect(fake.dump('sync').linksManifest.chunks).toBeGreaterThan(1);
    });

    test('Clear sync data empties a chunked list everywhere and backs it up whole', async () => {
        const { SyncManager, SYNC_BACKUP_KEY } = await import('../../javascript/core-systems/syncManager.js');
        const syncManager = new SyncManager();
        URL.createObjectURL = jest.fn(() => 'blob:backup');
        URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        await saveLinks(links(150));

        expect((await syncManager.clearSyncData()).success).toBe(true);

        expect((await loadLinks()).links).toEqual([]);
        await expect(storage.readSyncLinks()).resolves.toEqual({ value: '[]', consistent: true });
        expect(fake.dump('local')[SYNC_BACKUP_KEY].links).toEqual(links(150));
    });
});

describe('encodeLinksForSync / decodeLinksFromSync', () => {
    let storage;

    beforeEach(async () => {
        jest.resetModules();
        storage = await import('../../javascript/core-systems/syncStorage.js');
    });

    test('round-trips lists of every size, chunk by chunk within the limit', () => {
        for (const n of [0, 1, 39, 40, 41, 150, 400]) {
            const value = JSON.stringify(links(n));
            const { items, chunkCount } = storage.encodeLinksForSync(value);
            for (const [key, item] of Object.entries(items)) {
                expect(itemBytes(key, item)).toBeLessThanOrEqual(SYNC_QUOTAS.QUOTA_BYTES_PER_ITEM);
            }
            expect(items.linksManifest.chunks).toBe(chunkCount);
            const decoded = storage.decodeLinksFromSync(items);
            expect(decoded.consistent).toBe(true);
            expect(JSON.parse(decoded.value)).toEqual(links(n));
        }
    });

    test('a stale chunk past the manifest\'s count is ignored', () => {
        const { items } = storage.encodeLinksForSync(JSON.stringify(links(2)));
        const decoded = storage.decodeLinksFromSync({ ...items, 'links.1': JSON.stringify(links(5, 50)) });
        expect(decoded).toMatchObject({ consistent: true });
        expect(JSON.parse(decoded.value)).toEqual(links(2));
    });

    test('a `links` replaced by a writer that ignores the manifest reads as inconsistent', () => {
        const { items } = storage.encodeLinksForSync(JSON.stringify(links(2)));
        const decoded = storage.decodeLinksFromSync({ ...items, links: JSON.stringify(links(1)) });
        expect(decoded.consistent).toBe(false);
        expect(JSON.parse(decoded.value)).toEqual(links(1));
    });

    test('a list needing more items than sync can hold is refused as a quota error', () => {
        expect(() => storage.encodeLinksForSync(JSON.stringify(links(1500))))
            .toThrow(/QUOTA_BYTES quota exceeded/);
    });

    test('isLinkStorageKey covers links, its chunks and manifest only', () => {
        expect(['links', 'links.1', 'links.15', 'linksManifest'].every(storage.isLinkStorageKey)).toBe(true);
        expect(['linksView', 'categories', 'links.x', 'mylinks.1'].some(storage.isLinkStorageKey)).toBe(false);
    });
});
