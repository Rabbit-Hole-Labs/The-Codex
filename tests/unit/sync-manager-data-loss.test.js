/**
 * Regression: SyncManager's manual sync paths must not revert cloud data.
 *
 * Normal edits (storageManager.saveLinks) write chrome.storage.sync only, so
 * chrome.storage.local holds a snapshot frozen at the last manual sync. After
 * any manual sync both metadata versions are equal, and syncData() used to pick
 * that stale local snapshot whenever it had links — ignoring forceStrategy — and
 * write it back over sync, which Chrome then propagated to every device.
 *
 * Runs against the real modules with the quota-faithful chrome.storage fake.
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake, itemBytes } from '../helpers/chromeStorageFake.js';
import { encodeLinksForSync } from '../../javascript/core-systems/syncStorage.js';

const link = (i) => ({
    id: `link_${i}`,
    name: `Site ${i}`,
    url: `https://site${i}.example.com/`,
    category: 'Default'
});

const stored = (fake, area, key) => {
    const value = fake.dump(area)[key];
    return value === undefined ? undefined : JSON.parse(value);
};

// Over the 100 KB sync total even split across items (~110 KB in 14 items),
// so Chrome rejects the write and saves fall back to local.
const OVERSIZED_LINKS = Array.from({ length: 1000 }, (_, i) => link(i));

// Bytes the sync items storing these links take (chunks plus manifest).
const chunkedBytes = (links) => Object.entries(encodeLinksForSync(JSON.stringify(links)).items)
    .reduce((sum, [key, value]) => sum + itemBytes(key, value), 0);

async function flushAsyncWork() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

// Run `fn` while every chrome.storage.sync write is rejected (e.g. over quota),
// so storageManager's saves fall back to chrome.storage.local.
async function withSyncWritesFailing(fn, message = 'Resource::kQuotaBytesPerItem quota exceeded') {
    const realSet = chrome.storage.sync.set;
    chrome.storage.sync.set = () => Promise.reject(new Error(message));
    try {
        return await fn();
    } finally {
        chrome.storage.sync.set = realSet;
    }
}

describe('Regression: SyncManager must not revert cloud data', () => {
    let fake;
    let syncManager;
    let saveLinks;
    let events;
    let SYNC_BACKUP_KEY;
    let SYNC_PREVIOUS_BACKUP_KEY;
    let SYNC_SET_ASIDE_KEY;
    let realCreateObjectURL;
    let realRevokeObjectURL;
    let downloadClicks;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        let SyncManager;
        ({ SyncManager, SYNC_BACKUP_KEY, SYNC_PREVIOUS_BACKUP_KEY, SYNC_SET_ASIDE_KEY } = await import('../../javascript/core-systems/syncManager.js'));
        // Backup files are "downloaded" through a blob URL and an <a> click.
        realCreateObjectURL = URL.createObjectURL;
        realRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:backup');
        URL.revokeObjectURL = jest.fn();
        downloadClicks = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        ({ saveLinks } = await import('../../javascript/core-systems/storageManager.js'));
        syncManager = new SyncManager();
        events = [];
        syncManager.addSyncListener((event, data) => events.push({ event, data }));
        await flushAsyncWork();
    });

    afterEach(() => {
        URL.createObjectURL = realCreateObjectURL;
        URL.revokeObjectURL = realRevokeObjectURL;
        downloadClicks.mockRestore();
        delete globalThis.chrome;
    });

    test('A: Sync now → sync-only edit → Sync now leaves the edit intact', async () => {
        const original = [link(1), link(2)];
        fake.seed('sync', { links: JSON.stringify(original), categories: JSON.stringify(['Default']) });

        expect((await syncManager.syncData()).success).toBe(true);

        const edited = [...original, link(3)];
        expect(await saveLinks(edited)).toBe(true);
        // The edit reached sync only; local still holds the snapshot.
        expect(stored(fake, 'local', 'links')).toEqual(original);

        const second = await syncManager.syncData();
        expect(second.success).toBe(true);
        expect(stored(fake, 'sync', 'links')).toEqual(edited);
        expect(stored(fake, 'local', 'links')).toEqual(edited);
    });

    test('A (deletion): a link deleted after Sync now stays deleted on the next Sync now', async () => {
        const original = [link(1), link(2), link(3)];
        fake.seed('sync', { links: JSON.stringify(original), categories: JSON.stringify(['Default']) });
        await syncManager.syncData();

        const afterDelete = [link(1), link(3)];
        await saveLinks(afterDelete);
        await syncManager.syncData();

        expect(stored(fake, 'sync', 'links')).toEqual(afterDelete);
    });

    test('B: Force pull with equal versions keeps the cloud data', async () => {
        const original = [link(1)];
        fake.seed('sync', { links: JSON.stringify(original), categories: JSON.stringify(['Default']) });
        await syncManager.syncData();

        const cloudEdit = [link(1), link(2)];
        await saveLinks(cloudEdit);
        const metadata = await syncManager.getSyncMetadata();
        expect(metadata.local.version).toBe(metadata.remote.version);

        const result = await syncManager.forcePullFromRemote();
        expect(result.success).toBe(true);
        expect(stored(fake, 'sync', 'links')).toEqual(cloudEdit);
        expect(stored(fake, 'local', 'links')).toEqual(cloudEdit);
    });

    test('Force push with equal versions uploads this device\'s local copy', async () => {
        const original = [link(1)];
        fake.seed('sync', { links: JSON.stringify(original), categories: JSON.stringify(['Default']) });
        await syncManager.syncData();
        await saveLinks([link(1), link(2)]);

        const result = await syncManager.forcePushToRemote();
        expect(result.success).toBe(true);
        expect(stored(fake, 'sync', 'links')).toEqual(original);
    });

    test('C: first run with empty sync and populated local still migrates local to sync', async () => {
        const legacy = [link(1), link(2)];
        fake.seed('local', { links: JSON.stringify(legacy), categories: JSON.stringify(['Default', 'Work']) });

        const result = await syncManager.syncData();
        expect(result.success).toBe(true);
        expect(stored(fake, 'sync', 'links')).toEqual(legacy);
        expect(stored(fake, 'sync', 'categories')).toEqual(['Default', 'Work']);
    });

    test('a deliberately emptied cloud is not refilled from a stale local snapshot', async () => {
        const meta = { version: 100, lastModified: 100, deviceId: 'device_a' };
        fake.seed('sync', { links: '[]', categories: JSON.stringify(['Default']), syncMetadata: meta });
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']), syncMetadata: meta });

        expect((await syncManager.syncData()).success).toBe(true);
        expect(stored(fake, 'sync', 'links')).toEqual([]);
        expect(stored(fake, 'local', 'links')).toEqual([]);
    });

    describe('unequal versions (another device synced since this one did)', () => {
        beforeEach(() => {
            // This device's snapshot still has link 2, which was deleted in the
            // cloud after another device's manual sync bumped the version.
            fake.seed('sync', {
                links: JSON.stringify([link(1), link(3)]),
                categories: JSON.stringify(['Default']),
                syncMetadata: { version: 200, lastModified: 200, deviceId: 'device_b' }
            });
            fake.seed('local', {
                links: JSON.stringify([link(1), link(2), link(3)]),
                categories: JSON.stringify(['Default']),
                syncMetadata: { version: 100, lastModified: 100, deviceId: 'device_a' }
            });
        });

        test('Sync now keeps the cloud and does not resurrect deleted links', async () => {
            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1), link(3)]);
            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(3)]);
        });

        test('an explicitly chosen merge still merges', async () => {
            expect((await syncManager.syncData('merge')).success).toBe(true);
            expect(stored(fake, 'sync', 'links').map((l) => l.id).sort())
                .toEqual(['link_1', 'link_2', 'link_3']);
        });
    });

    describe('mergeData', () => {
        const meta = { local: { lastModified: 0 }, remote: { lastModified: 1 } };

        test('two distinct cloud links sharing an id or URL both survive', () => {
            const local = { links: JSON.stringify([{ id: 'x', name: 'A', url: 'https://a.example/', category: 'Default' }]) };
            const cloud = { links: JSON.stringify([
                { id: 'x', name: 'A', url: 'https://a.example/', category: 'Default' },
                { id: 'x', name: 'B', url: 'https://b.example/', category: 'Default' },
                { id: 'y', name: 'A again', url: 'https://a.example/', category: 'Default' }
            ]) };

            const merged = JSON.parse(syncManager.mergeData(local, cloud, meta).links);

            expect(merged.map((l) => l.name).sort()).toEqual(['A', 'A again', 'B']);
        });

        test('does not throw on entries that are not objects', () => {
            const local = { links: JSON.stringify([null, link(1)]) };
            const cloud = { links: JSON.stringify([link(1), null]) };

            expect(() => syncManager.mergeData(local, cloud, meta)).not.toThrow();
            expect(JSON.parse(syncManager.mergeData(local, cloud, meta).links)).toEqual([null, link(1), null]);
        });
    });

    describe('first sync on a device that has never synced', () => {
        test('does not bring back links deleted after a save that fell back', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]' });
            await withSyncWritesFailing(() => saveLinks([link(1), link(2), link(3)]));
            // Another device deletes link 2.
            await chrome.storage.sync.set({ links: JSON.stringify([link(1)]) });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
            expect(stored(fake, 'local', 'links')).toEqual([link(1)]);
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([link(1), link(2), link(3)]);
        });

        test('does not undo another device\'s clear with a save that fell back', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]' });
            await withSyncWritesFailing(() => saveLinks([link(1), link(2), link(3)]));
            await chrome.storage.sync.set({ links: '[]', categories: '["Default"]', syncClearedAt: Date.now() + 1 });

            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([]);
        });

        test('merges its local-only links into a non-empty cloud instead of dropping them', async () => {
            fake.seed('sync', {
                links: JSON.stringify([link(1), link(2)]),
                categories: JSON.stringify(['Default']),
                syncMetadata: { version: 200, lastModified: 200, deviceId: 'device_b' }
            });
            // Pre-sync data on this device: link 1 is shared, link 9 exists only here.
            fake.seed('local', {
                links: JSON.stringify([{ ...link(1), name: 'Old name' }, link(9)]),
                categories: JSON.stringify(['Default', 'Local only'])
            });

            expect((await syncManager.syncData()).success).toBe(true);

            const cloud = stored(fake, 'sync', 'links');
            expect(cloud.map((l) => l.id).sort()).toEqual(['link_1', 'link_2', 'link_9']);
            expect(cloud.find((l) => l.id === 'link_1').name).toBe('Site 1'); // cloud version wins
            expect(stored(fake, 'sync', 'categories')).toEqual(['Default', 'Local only']);
            expect(stored(fake, 'local', 'links')).toEqual(cloud);
        });

        test('leaves local data untouched when the merged result cannot be written to sync', async () => {
            // e.g. saves that fell back to local because sync was over quota.
            fake.seed('sync', { links: JSON.stringify([{ ...link(1), name: 'Cloud name' }]), categories: '["Default"]' });
            fake.seed('local', { links: JSON.stringify(OVERSIZED_LINKS), categories: '["Default"]' });

            const result = await syncManager.syncData();

            expect(result.success).toBe(false);
            expect(stored(fake, 'local', 'links')).toEqual(OVERSIZED_LINKS);
            expect(fake.dump('local').syncMetadata).toBeUndefined();
        });

        test('migrates local links into a cloud that has categories but no links', async () => {
            fake.seed('sync', { links: '[]', categories: JSON.stringify(['Default', 'Work']) });
            fake.seed('local', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });

            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
            expect(stored(fake, 'sync', 'categories')).toEqual(['Default', 'Work']);
        });

        test('migrates local data stored as raw arrays by an older build', async () => {
            fake.seed('local', { links: [link(1)], categories: ['Default', 'Work'] });

            expect((await syncManager.syncData()).success).toBe(true);
            expect(fake.dump('sync').links).toBe(JSON.stringify([link(1)])); // JSON-string encoding
            expect(stored(fake, 'sync', 'categories')).toEqual(['Default', 'Work']);
        });
    });

    test('a device that has synced before does not re-seed an emptied cloud', async () => {
        // e.g. Clear sync data ran on another device: the cloud is empty, but
        // this device still has its snapshot and sync history.
        fake.seed('local', {
            links: JSON.stringify([link(1)]),
            categories: JSON.stringify(['Default']),
            syncMetadata: { version: 100, lastModified: 100, deviceId: 'device_a' }
        });

        expect((await syncManager.syncData()).success).toBe(true);
        expect(fake.dump('sync').links).toBeUndefined();
    });

    test('D: force push over the per-item quota returns success:false and does not end on syncComplete', async () => {
        const cloud = [link(1)];
        fake.seed('sync', { links: JSON.stringify(cloud), categories: JSON.stringify(['Default']) });
        fake.seed('local', { links: JSON.stringify(OVERSIZED_LINKS), categories: JSON.stringify(['Default']) });
        expect(chunkedBytes(OVERSIZED_LINKS)).toBeGreaterThan(102400);

        const result = await syncManager.forcePushToRemote();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/kQuotaBytes quota exceeded/);
        const names = events.map((e) => e.event);
        expect(names).toContain('syncError');
        expect(names).not.toContain('syncComplete');
        // Nothing was half-applied: the cloud and its metadata are untouched.
        expect(stored(fake, 'sync', 'links')).toEqual(cloud);
        expect(fake.dump('sync').syncMetadata).toBeUndefined();
    });

    test('a failure is reported once, with a readable message', async () => {
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
        fake.seed('local', { links: JSON.stringify(OVERSIZED_LINKS), categories: JSON.stringify(['Default']) });

        const result = await syncManager.forcePushToRemote();

        const errors = events.filter((e) => e.event === 'syncError');
        expect(errors).toHaveLength(1);
        expect(errors[0].data.type).toBe('quota_exceeded');
        expect(result.error).toMatch(/^Chrome sync storage quota exceeded\. \(Resource::kQuotaBytes quota/);
    });

    test('a write-rate rejection says to wait and retry', async () => {
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
        chrome.storage.sync.set = jest.fn(() => Promise.reject(
            new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.')));

        const result = await syncManager.forcePushToRemote();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/limiting how often/);
        const errors = events.filter((e) => e.event === 'syncError');
        expect(errors).toHaveLength(1);
        expect(errors[0].data).toMatchObject({ type: 'rate_limited', recommendation: expect.stringMatching(/Wait a minute/) });
    });

    test('force pull fails instead of wiping local when the cloud has no data', async () => {
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });

        const result = await syncManager.forcePullFromRemote();
        expect(result.success).toBe(false);
        expect(stored(fake, 'local', 'links')).toEqual([link(1)]);
    });

    test('force push fails when this device has no local copy to push', async () => {
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });

        const result = await syncManager.forcePushToRemote();
        expect(result.success).toBe(false);
        expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
    });

    test('a failed sync read aborts instead of writing synthesized empty data', async () => {
        const cloud = [link(1)];
        fake.seed('sync', { links: JSON.stringify(cloud), categories: JSON.stringify(['Default']) });
        const realGet = chrome.storage.sync.get;
        chrome.storage.sync.get = jest.fn((keys) => (
            Array.isArray(keys) && keys.includes('links')
                ? Promise.reject(new Error('Sync backend unavailable'))
                : realGet(keys)
        ));

        const result = await syncManager.syncData();
        expect(result.success).toBe(false);
        expect(stored(fake, 'sync', 'links')).toEqual(cloud);
        expect(fake.dump('local').links).toBeUndefined();
    });

    test('a snapshot left by the previous release\'s clear is not merged back (backed up instead)', async () => {
        // Old clearSyncData: sync.clear() + remove local syncMetadata/lastSyncTime,
        // leaving the local snapshot. deviceId shows this device synced before.
        fake.seed('local', {
            links: JSON.stringify([link(1), link(2)]),
            categories: JSON.stringify(['Default']),
            deviceId: 'device_old'
        });

        const createObjectURL = URL.createObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:set-aside');
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        try {
            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            // No clear stamp: the cloud may never have been cleared, so the reason is neutral.
            expect(result.warning).toMatch(/^2 links saved only on this device were not uploaded because the cloud is empty and may have been cleared by an older version\./);
            expect(events.find((e) => e.event === 'syncComplete').data.warning).toBe(result.warning);
            expect(click).toHaveBeenCalledTimes(1); // downloaded as a backup file
        } finally {
            URL.createObjectURL = createObjectURL;
            click.mockRestore();
        }
        expect(fake.dump('sync').links).toBeUndefined();
        expect(stored(fake, 'local', 'links')).toEqual([]);
        expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([link(1), link(2)]);
    });

    test('a deviceId created by the Sync tab does not stop a first sync from merging local links', async () => {
        const local = [10, 11, 12, 13, 14].map(link);
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
        fake.seed('local', { links: JSON.stringify(local), categories: '["Default"]' });
        // Opening the Sync tab runs updateDiagnostics(), which creates a deviceId.
        const { SyncSettingsController } = await import('../../javascript/features/syncSettingsController.js');
        await new SyncSettingsController().updateDiagnostics();
        expect(fake.dump('local').deviceId).toBeDefined();

        const result = await syncManager.syncData();

        expect(result.success).toBe(true);
        expect(result.warning).toBeUndefined();
        const ids = stored(fake, 'sync', 'links').map((l) => l.id).sort();
        expect(ids).toEqual(['link_1', 'link_10', 'link_11', 'link_12', 'link_13', 'link_14']);
        expect(stored(fake, 'local', 'links')).toHaveLength(6);
    });

    test('a never-synced device sets its local links aside when the cloud was cleared', async () => {
        fake.seed('sync', { links: '[]', categories: '["Default"]', syncMetadata: { version: 0, lastModified: 0 }, syncClearedAt: 500 });
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]' });

        const result = await syncManager.syncData();

        expect(result.success).toBe(true);
        expect(result.warning).toMatch(/cloud was cleared/);
        expect(stored(fake, 'sync', 'links')).toEqual([]);
        expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([link(1)]);
    });

    test('force pull empties a local field the cloud does not have', async () => {
        const meta = { version: 100, lastModified: 100 };
        fake.seed('sync', { categories: JSON.stringify(['Default', 'Work']), syncMetadata: meta });
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });

        expect((await syncManager.forcePullFromRemote()).success).toBe(true);
        expect(stored(fake, 'local', 'links')).toEqual([]);
        expect(stored(fake, 'local', 'categories')).toEqual(['Default', 'Work']);
    });

    describe('saves that fell back to local storage', () => {
        beforeEach(async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            expect((await syncManager.syncData()).success).toBe(true); // versions now equal
        });

        test('are pushed by the next Sync now, and stop being pending', async () => {
            expect(await withSyncWritesFailing(() => saveLinks([link(1), link(2)]))).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);

            expect((await syncManager.syncData()).success).toBe(true);

            expect(stored(fake, 'sync', 'links')).toEqual([link(1), link(2)]);
            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(2)]);
            expect(fake.dump('local')['pendingSyncSince.links']).toBeUndefined();
        });

        test('push a deliberate delete-everything save too', async () => {
            await withSyncWritesFailing(() => saveLinks([]));
            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([]);
        });

        test('push settings that fell back', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            await withSyncWritesFailing(() => saveSettings({ theme: 'light' }));

            expect((await syncManager.syncData()).success).toBe(true);
            expect(fake.dump('sync').theme).toBe('light');
            expect(fake.dump('local')['pendingSyncSince.theme']).toBeUndefined();
        });

        test('lose to a newer cloud value written after them, and are set aside', async () => {
            await withSyncWritesFailing(() => saveLinks([link(1), link(2)]));
            // Another device (or a later save here) writes the cloud afterwards.
            await chrome.storage.sync.set({ links: JSON.stringify([link(3)]) });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(result.warning).toMatch(/^2 links saved only on this device were replaced by newer changes in the cloud\./);
            expect(stored(fake, 'sync', 'links')).toEqual([link(3)]);
            expect(stored(fake, 'local', 'links')).toEqual([link(3)]);
            // The copy is the union, so nothing from either side is lost.
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([link(1), link(2), link(3)]);
            expect(fake.dump('local')['pendingSyncSince.links']).toBeUndefined();
        });

        // Links stored without an id get a new random one on every load until
        // a save keeps it: a save that fell back (e.g. under 7.0.0.42's 8 KB
        // limit) and a later save to the cloud carry different ids for the
        // same, unchanged links. That alone must not read as lost changes.
        const withId = (links, prefix) => links.map((l, i) => ({ ...l, id: `link_${prefix}_${i}` }));

        test('that differ from the newer cloud only in generated ids are not set aside', async () => {
            await withSyncWritesFailing(() => saveLinks(withId([link(1), link(2)], 'local')));
            const cloud = withId([link(1), link(2)], 'cloud');
            await chrome.storage.sync.set({ links: JSON.stringify(cloud) });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(result.warning).toBeUndefined();
            expect(downloadClicks).not.toHaveBeenCalled();
            expect(stored(fake, 'sync', 'links')).toEqual(cloud);
            expect(fake.dump('local')['pendingSyncSince.links']).toBeUndefined();
        });

        test('a duplicate the newer cloud holds only once still counts', async () => {
            await withSyncWritesFailing(() => saveLinks(withId([link(1), link(1)], 'local')));
            await chrome.storage.sync.set({ links: JSON.stringify(withId([link(1)], 'cloud')) });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(result.warning).toMatch(/^1 link saved only on this device was replaced by newer changes in the cloud\./);
        });

        test('same-URL links listed in another order are not counted', async () => {
            const a = { ...link(1), name: 'Admin' };
            const b = { ...link(1), name: 'Dashboard' }; // same URL
            await withSyncWritesFailing(() => saveLinks(withId([a, b], 'local')));
            await chrome.storage.sync.set({ links: JSON.stringify(withId([b, a], 'cloud')) });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(result.warning).toBeUndefined();
        });

        test('count only real changes when ids also differ', async () => {
            const local = withId([link(1), { ...link(2), icon: 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/plex.webp' }], 'local');
            await withSyncWritesFailing(() => saveLinks(local));
            await chrome.storage.sync.set({ links: JSON.stringify(withId([link(1), link(2)], 'cloud')) });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(result.warning).toMatch(/^1 link saved only on this device was replaced by newer changes in the cloud\./);
        });

        test('are still pushed when the cloud value was only re-serialized', async () => {
            await withSyncWritesFailing(() => saveLinks([link(1), link(2)]));
            // Same links, different key order.
            const reordered = [link(1)].map(({ url, id, category, name }) => ({ url, id, category, name }));
            await chrome.storage.sync.set({ links: JSON.stringify(reordered) });

            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1), link(2)]);
        });

        test('with no recorded cloud value are treated as superseded and set aside', async () => {
            fake.seed('local', { links: JSON.stringify([link(1), link(9)]), 'pendingSyncSince.links': { since: 1 } });

            const result = await syncManager.syncData();

            expect(result.warning).toBeDefined();
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([link(1), link(9)]);
        });

        test('are set aside, not discarded, by a force pull', async () => {
            await withSyncWritesFailing(() => saveLinks([link(1), link(2)]));

            const result = await syncManager.forcePullFromRemote();

            expect(result.success).toBe(true);
            expect(result.warning).toMatch(/^1 link saved only on this device was replaced by Force pull\./);
            expect(stored(fake, 'local', 'links')).toEqual([link(1)]);
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([link(1), link(2)]);
        });

        test('are not uploaded over a clear from another device', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            await chrome.storage.sync.set({ theme: 'dark' });
            await withSyncWritesFailing(() => saveSettings({ theme: 'light' }));
            // The other device's clear: theme is reset to 'dark', i.e. unchanged here.
            await chrome.storage.sync.set({ links: '[]', categories: '["Default"]', theme: 'dark', syncClearedAt: Date.now() + 1 });
            await flushAsyncWork();

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(fake.dump('sync').theme).toBe('dark');
            expect(result.warning).toBeDefined();
        });

        test('stay pending when the push is over quota, and the failure is reported', async () => {
            const links = OVERSIZED_LINKS;
            expect(await saveLinks(links)).toBe(true); // the real quota makes it fall back

            const result = await syncManager.syncData();

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/quota exceeded/);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
            expect(stored(fake, 'local', 'links')).toEqual(links);
            expect(fake.dump('local')['pendingSyncSince.links']).toBeDefined();
        });
    });

    test('a clear on another device resets this device\'s status and emits syncCleared', async () => {
        fake.seed('local', { lastSyncTime: 123, syncStatus: 'synced' });
        syncManager.lastSyncTime = 123;

        // What clearSyncData writes on the other device, arriving via Chrome sync.
        await chrome.storage.sync.set({ links: '[]', categories: '["Default"]', syncClearedAt: Date.now() });
        await flushAsyncWork();

        expect(events.filter((e) => e.event === 'syncCleared')).toEqual([
            { event: 'syncCleared', data: expect.objectContaining({ remote: true }) }
        ]);
        expect(syncManager.lastSyncTime).toBeNull();
        expect(fake.dump('local').lastSyncTime).toBeUndefined();
    });

    describe('round 6', () => {
        test('force pull also replaces a pending setting, so the next Sync now keeps the cloud value', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'dark' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveSettings({ theme: 'light' }));

            expect((await syncManager.forcePullFromRemote()).success).toBe(true);
            expect((await syncManager.syncData()).success).toBe(true);

            expect(fake.dump('sync').theme).toBe('dark');
            expect(fake.dump('local').theme).toBeUndefined();
            expect(fake.dump('local')['pendingSyncSince.theme']).toBeUndefined();
        });

        test('a clear is detected by its stamp, not by comparing device clocks', async () => {
            // This device's clock runs ahead: its fallback save looks "newer"
            // than the clear. The clear left theme unchanged, and this device
            // missed the storage event (seeded, so no onChanged).
            fake.seed('sync', { links: '[]', categories: '["Default"]', theme: 'dark', syncClearedAt: 1000 });
            fake.seed('local', {
                theme: 'light',
                'pendingSyncSince.theme': { since: Date.now() + 1e9, cloud: '"dark"', clearedAt: null }
            });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(fake.dump('sync').theme).toBe('dark');
            expect(result.warning).toMatch(/theme setting/);
        });

        test('a failed backup download stops the replacement', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            fake.seed('local', { links: JSON.stringify([link(1), link(9)]), 'pendingSyncSince.links': { since: 1 } });
            URL.createObjectURL = jest.fn(() => { throw new Error('download blocked'); });

            const result = await syncManager.syncData();

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Could not download a backup/);
            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(9)]);
        });

        test('a failed metadata read aborts instead of looking like a first sync', async () => {
            // A synced device with a stale snapshot (link 2 was deleted since).
            fake.seed('sync', { links: JSON.stringify([link(1), link(3)]), categories: '["Default"]', syncMetadata: { version: 200, lastModified: 200 } });
            fake.seed('local', { links: JSON.stringify([link(1), link(2), link(3)]), categories: '["Default"]', syncMetadata: { version: 100, lastModified: 100 } });
            const realGet = chrome.storage.local.get;
            chrome.storage.local.get = jest.fn((keys) => (
                [].concat(keys ?? []).includes('syncMetadata')
                    ? Promise.reject(new Error('local read failed'))
                    : realGet(keys)
            ));

            const result = await syncManager.syncData();

            expect(result.success).toBe(false);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1), link(3)]);
        });

        test('a pending setting does not make a first sync drop local-only links', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            fake.seed('sync', { links: JSON.stringify([link(9)]), categories: '["Default"]' });
            fake.seed('local', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]' });
            await withSyncWritesFailing(() => saveSettings({ theme: 'light' }));

            expect((await syncManager.syncData()).success).toBe(true);

            expect(stored(fake, 'sync', 'links').map((l) => l.id).sort()).toEqual(['link_1', 'link_2', 'link_9']);
            expect(fake.dump('sync').theme).toBe('light');
            expect(stored(fake, 'local', 'links')).toHaveLength(3);
        });

        test('a first sync sets local links aside after a clear even once the cloud has new links', async () => {
            // Cleared, then another device added link 5.
            fake.seed('sync', { links: JSON.stringify([link(5)]), categories: '["Default"]', syncClearedAt: 1000 });
            fake.seed('local', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]' });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(result.warning).toMatch(/^2 links saved only on this device were not uploaded because the cloud was cleared\./);
            expect(stored(fake, 'sync', 'links')).toEqual([link(5)]);
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links.map((l) => l.id).sort()).toEqual(['link_1', 'link_2', 'link_5']);
        });

        test('only entries the cloud lacks are set aside, and the reason names them', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncClearedAt: 1000 });
            fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default","Work"]' });

            const result = await syncManager.syncData();

            expect(result.warning).toMatch(/^1 category saved only on this device was not uploaded because the cloud was cleared\./);
            const copy = fake.dump('local')[SYNC_SET_ASIDE_KEY];
            expect(copy.links).toEqual([link(1)]);
            expect(copy.categories).toEqual(['Default', 'Work']);
        });

        test('a set-aside copy does not displace the backup taken by a clear', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            fake.seed('local', {
                links: JSON.stringify([link(1), link(9)]),
                'pendingSyncSince.links': { since: 1 },
                [SYNC_BACKUP_KEY]: { links: [link(7)], categories: ['Default'] }
            });

            expect((await syncManager.syncData()).warning).toBeDefined();

            expect(fake.dump('local')[SYNC_BACKUP_KEY].links).toEqual([link(7)]);
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([link(1), link(9)]);
        });

        test('a superseded change to an existing link is set aside and reported', async () => {
            await chrome.storage.sync.set({ links: JSON.stringify([link(1)]), categories: '["Default","Work"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveLinks([{ ...link(1), category: 'Work' }]));
            await chrome.storage.sync.set({ links: JSON.stringify([link(1), link(3)]) }); // another device

            const result = await syncManager.syncData();

            expect(result.warning).toMatch(/^1 link saved only on this device was replaced by newer changes in the cloud\./);
            const copy = fake.dump('local')[SYNC_SET_ASIDE_KEY];
            expect(copy.links.find((l) => l.id === 'link_1').category).toBe('Work'); // this device's version survives
            expect(copy.links.map((l) => l.id).sort()).toEqual(['link_1', 'link_3']);
        });

        test('a retried sync does not download the same set-aside copy again', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            fake.seed('local', {
                links: JSON.stringify([link(1), link(9)]),
                'pendingSyncSince.links': { since: 1 }, // superseded: set aside
                theme: 'light',
                'pendingSyncSince.theme': { since: 1, cloud: 'null', clearedAt: null } // pending: pushed
            });

            const rateLimited = 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.';
            expect((await withSyncWritesFailing(() => syncManager.syncData(), rateLimited)).success).toBe(false);
            expect((await withSyncWritesFailing(() => syncManager.syncData(), rateLimited)).success).toBe(false);
            expect(downloadClicks).toHaveBeenCalledTimes(1);

            expect((await syncManager.syncData()).success).toBe(true);
            expect(downloadClicks).toHaveBeenCalledTimes(1);
            expect(fake.dump('sync').theme).toBe('light');
        });

        test('a local edit to a link the cloud also changed is kept in the set-aside copy (thread 1)', async () => {
            await chrome.storage.sync.set({ links: JSON.stringify([link(1)]), categories: '["Default"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveLinks([{ ...link(1), name: 'Mine' }]));
            await chrome.storage.sync.set({ links: JSON.stringify([{ ...link(1), name: 'Theirs' }]) }); // same link

            const result = await syncManager.syncData();

            expect(result.warning).toMatch(/^1 link saved only on this device was replaced/);
            expect(stored(fake, 'sync', 'links')[0].name).toBe('Theirs');
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].links).toEqual([{ ...link(1), name: 'Mine' }]);
        });

        test('force push includes settings saved only on this device, and settles them (thread 3)', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            await chrome.storage.sync.set({ links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'dark' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveSettings({ theme: 'light' }));

            expect((await syncManager.forcePushToRemote()).success).toBe(true);

            expect(fake.dump('sync').theme).toBe('light');
            expect(fake.dump('local')['pendingSyncSince.theme']).toBeUndefined();
        });

        test('force push works for a device whose only local data is a setting (thread 3)', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'dark' });
            fake.seed('local', { view: 'list', 'pendingSyncSince.view': { since: 1, cloud: 'null', clearedAt: null } });

            expect((await syncManager.forcePushToRemote()).success).toBe(true);

            expect(fake.dump('sync').view).toBe('list');
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]); // lists untouched
        });

        test('a rejected metadata write fails the sync and leaves the versions as they were (thread 4)', async () => {
            const meta = { version: 100, lastModified: 100 };
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
            fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
            const realSet = chrome.storage.sync.set;
            chrome.storage.sync.set = (items) => ('syncMetadata' in items
                ? Promise.reject(new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.'))
                : realSet(items));

            const result = await syncManager.syncData();

            expect(result.success).toBe(false);
            expect(events.map((e) => e.event)).not.toContain('syncComplete');
            expect(fake.dump('local').syncMetadata).toEqual(meta);
            expect(fake.dump('sync').syncMetadata).toEqual(meta);
        });

        test('a first sync with one write left is applied whole, data and version together', async () => {
            fake.seed('sync', { links: JSON.stringify([link(9)]), categories: '["Default"]' });
            fake.seed('local', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]' });
            for (let i = 0; i < 119; i++) await chrome.storage.sync.set({ theme: 'dark' }); // 1 of 120 left

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            const local = fake.dump('local');
            expect(local.syncMetadata.version).toBe(fake.dump('sync').syncMetadata.version);
            expect(stored(fake, 'sync', 'links').map((l) => l.id).sort()).toEqual(['link_1', 'link_2', 'link_9']);
        });

        test('a first sync whose write is rejected changes nothing, local or cloud', async () => {
            fake.seed('sync', { links: JSON.stringify([link(9)]), categories: '["Default"]' });
            fake.seed('local', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]' });
            for (let i = 0; i < 120; i++) await chrome.storage.sync.set({ theme: 'dark' }); // none left

            const result = await syncManager.syncData();

            expect(result.success).toBe(false);
            const errors = events.filter((e) => e.event === 'syncError');
            expect(errors).toHaveLength(1);
            expect(errors[0].data.type).toBe('rate_limited');
            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(2)]);
            expect(fake.dump('local').syncMetadata).toBeUndefined();
            expect(fake.dump('local').deviceId).toBeUndefined();
            expect(stored(fake, 'sync', 'links')).toEqual([link(9)]);
            expect(fake.dump('sync').syncMetadata).toBeUndefined();
        });

        test('a force pull whose sync write is rejected leaves the pending edit in place', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveLinks([link(1), link(2)]));
            const stampBefore = fake.dump('local').syncResolvedAt;

            const result = await withSyncWritesFailing(
                () => syncManager.forcePullFromRemote(),
                'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.'
            );

            expect(result.success).toBe(false);
            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(2)]);
            expect(fake.dump('local')['pendingSyncSince.links']).toBeDefined();
            expect(fake.dump('local').syncResolvedAt).toBe(stampBefore); // open pages aren't told to reload
        });

        test('force push does not upload a stale, unmarked local setting', async () => {
            // e.g. written by an older build's fallback, with no pending marker
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'dark' });
            fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'light' });

            expect((await syncManager.forcePushToRemote()).success).toBe(true);
            expect(fake.dump('sync').theme).toBe('dark');
        });

        test('a settings save that reaches sync drops the stale local copy of that setting', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            await withSyncWritesFailing(() => saveSettings({ theme: 'light' }));
            expect(fake.dump('local').theme).toBe('light');

            await saveSettings({ theme: 'dark' });

            expect(fake.dump('local').theme).toBeUndefined();
            expect(fake.dump('local')['pendingSyncSince.theme']).toBeUndefined();
        });

        test('a save that falls back while a sync runs is not overwritten by it', async () => {
            const meta = { version: 100, lastModified: 100 };
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
            fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
            const realGet = chrome.storage.sync.get;
            let injected = false;
            chrome.storage.sync.get = async (keys) => {
                const result = await realGet(keys);
                if (!injected && [].concat(keys ?? []).includes('syncMetadata')) {
                    injected = true;
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    await withSyncWritesFailing(() => saveLinks([link(1), link(2)]));
                }
                return result;
            };

            expect((await syncManager.syncData()).success).toBe(true);

            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(2)]);
            expect(fake.dump('local')['pendingSyncSince.links']).toBeDefined();
        });

        test('force pull works when the cloud holds only settings (thread: setting-only cloud)', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            fake.seed('sync', { theme: 'light' });
            await withSyncWritesFailing(() => saveSettings({ theme: 'dark' }));

            const result = await syncManager.forcePullFromRemote();

            expect(result.success).toBe(true);
            expect(fake.dump('local').theme).toBeUndefined();
            expect(fake.dump('local')['pendingSyncSince.theme']).toBeUndefined();
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].theme).toBe('dark');
        });

        test('a save that fails while another device writes certifies the value it was based on (thread: snapshot)', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            await syncManager.syncData();
            // Our write is rejected, and another device's write lands in between.
            const realSet = chrome.storage.sync.set;
            chrome.storage.sync.set = async () => {
                await realSet({ links: JSON.stringify([link(1), link(3)]) });
                throw new Error('Resource::kQuotaBytesPerItem quota exceeded');
            };
            await saveLinks([link(1), link(2)]);
            chrome.storage.sync.set = realSet;

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1), link(3)]); // the other device's change survives
            expect(result.warning).toMatch(/replaced by newer changes in the cloud/);
        });

        test('a superseded category reorder is set aside and reported (thread: category order)', async () => {
            const { saveCategories } = await import('../../javascript/core-systems/storageManager.js');
            fake.seed('sync', { links: '[]', categories: '["Default","A","B"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveCategories(['Default', 'B', 'A']));
            await chrome.storage.sync.set({ categories: '["Default","A","B","C"]' }); // another device adds C

            const result = await syncManager.syncData();

            expect(result.warning).toMatch(/^The category order saved only on this device was replaced by newer changes in the cloud\./);
            expect(fake.dump('local')[SYNC_SET_ASIDE_KEY].categories).toEqual(['Default', 'B', 'A', 'C']);
        });

        test('force pull sets aside a pending category reorder (thread: category order)', async () => {
            const { saveCategories } = await import('../../javascript/core-systems/storageManager.js');
            fake.seed('sync', { links: '[]', categories: '["Default","A","B"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveCategories(['Default', 'B', 'A']));

            const result = await syncManager.forcePullFromRemote();

            expect(result.warning).toMatch(/category order/);
            expect(stored(fake, 'local', 'categories')).toEqual(['Default', 'A', 'B']);
        });

        test('a save that falls back while the sync writes its local copy keeps its value and marker', async () => {
            const meta = { version: 100, lastModified: 100 };
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
            fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
            const realGet = chrome.storage.local.get;
            const realLocalSet = chrome.storage.local.set;
            const realSyncSet = chrome.storage.sync.set;
            let concurrentSave = null;
            let fallbackLanded;
            const fallbackWritten = new Promise((resolve) => { fallbackLanded = resolve; });
            chrome.storage.local.get = async (keys) => {
                const result = await realGet(keys);
                const markerRead = Array.isArray(keys) && keys.length > 0 && keys.every((key) => key.startsWith('pendingSyncSince.'));
                if (!concurrentSave && markerRead) {
                    // The sync has made its cloud write and is in its local phase;
                    // a concurrent edit's sync write is rate-limited, so it falls
                    // back to local. Not awaited: it runs alongside the sync.
                    chrome.storage.sync.set = () => Promise.reject(new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.'));
                    concurrentSave = saveLinks([link(1), link(2)]);
                }
                return result;
            };
            chrome.storage.local.set = async (items) => {
                if (concurrentSave && 'syncMetadata' in items) {
                    // Hold the sync's local write until the fallback has landed
                    // (the race window), unless something keeps it out (50 ms).
                    await Promise.race([fallbackWritten, new Promise((resolve) => setTimeout(resolve, 50))]);
                }
                const result = await realLocalSet(items);
                if ('pendingSyncSince.links' in items) fallbackLanded();
                return result;
            };

            try {
                expect((await syncManager.syncData()).success).toBe(true);
                expect(await concurrentSave).toBe(true);
            } finally {
                Object.assign(chrome.storage.local, { get: realGet, set: realLocalSet });
                chrome.storage.sync.set = realSyncSet;
            }

            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(2)]);
            expect(fake.dump('local')['pendingSyncSince.links']).toBeDefined();
        });

        test('the pending-sync lock uses Web Locks when the browser has them', async () => {
            const { withPendingSyncLock } = await import('../../javascript/core-systems/storageLock.js');
            const request = jest.fn((name, task) => task());
            const hadNavigatorLocks = 'locks' in navigator;
            Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
            try {
                await expect(withPendingSyncLock(async () => 'ran')).resolves.toBe('ran');
            } finally {
                if (!hadNavigatorLocks) delete navigator.locks;
            }
            expect(request).toHaveBeenCalledWith('codex-pending-sync', expect.any(Function));
        });

        test('a settings-only set-aside backup restores through Import', async () => {
            const { importLinks } = await import('../../javascript/core-systems/storageManager.js');
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            fake.seed('sync', { theme: 'light' }); // no links or categories in the cloud
            await withSyncWritesFailing(() => saveSettings({ theme: 'dark' }));
            expect((await syncManager.forcePullFromRemote()).success).toBe(true);
            const backup = fake.dump('local')[SYNC_SET_ASIDE_KEY]; // what was downloaded
            expect(backup.links).toEqual([]);
            expect(backup.theme).toBe('dark');

            const state = { links: [], categories: ['Default'] };
            const file = new Blob([JSON.stringify(backup)], { type: 'application/json' });
            await expect(importLinks(state, file)).resolves.toBe(true);

            expect(state.theme).toBe('dark');
            expect(fake.dump('sync').theme).toBe('dark');
        });

        test('a local failure after the cloud took a first sync does not make the next sync merge again (P1f)', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            // Never-synced device with an unmarked link, plus a superseded setting (so there is a set-aside).
            fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            fake.seed('sync', { links: JSON.stringify([link(2), link(3)]), categories: '["Default"]', syncMetadata: { version: 9, lastModified: 9 } });
            await withSyncWritesFailing(() => saveSettings({ view: 'list' }));
            await chrome.storage.sync.set({ view: 'grid' });
            const realLocalSet = chrome.storage.local.set;
            chrome.storage.local.set = (items) => (SYNC_SET_ASIDE_KEY in items
                ? Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'))
                : realLocalSet(items));

            const first = await syncManager.syncData();
            chrome.storage.local.set = realLocalSet;

            expect(first.success).toBe(true); // the cloud took it; keeping the extra copy is best effort
            expect(fake.dump('local').syncMetadata.version).toBe(fake.dump('sync').syncMetadata.version);
            // Another device deletes link 1 and records its sync (writing the
            // links with their manifest, as every save does).
            fake.seed('sync', {
                ...encodeLinksForSync(JSON.stringify([link(2), link(3)])).items,
                syncMetadata: { version: 10, lastModified: 10 }
            });

            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'sync', 'links').map((l) => l.id)).not.toContain('link_1');
        });

        test('force pull from a cloud holding only settings keeps this device\'s lists (X1)', async () => {
            const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
            fake.seed('sync', { theme: 'light' });
            fake.seed('local', { links: JSON.stringify([link(1), link(3)]), categories: '["Default","Work"]' });
            safeUpdateState({ links: [link(1), link(3)] }, { validate: false, skipPersistence: true });

            const result = await syncManager.forcePullFromRemote();
            await flushAsyncWork();

            expect(result.success).toBe(true);
            expect(stored(fake, 'local', 'links')).toEqual([link(1), link(3)]);
            expect(stored(fake, 'local', 'categories')).toEqual(['Default', 'Work']);
            expect(getState().links).toEqual([link(1), link(3)]); // the open page doesn't empty
            expect(getState().theme).toBe('light');
        });

        test('a copy parked by a failed attempt is dropped by the next successful sync and by a clear', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            await syncManager.syncData();
            const rateLimited = 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.';
            await withSyncWritesFailing(async () => {
                await saveLinks([link(1), link(2)]);
                expect((await syncManager.forcePullFromRemote()).success).toBe(false);
            }, rateLimited);
            expect(fake.dump('local').syncSetAsideInProgress).toBeDefined();

            expect((await syncManager.syncData()).success).toBe(true); // pushes the pending links: no set-aside
            expect(fake.dump('local').syncSetAsideInProgress).toBeUndefined();

            await withSyncWritesFailing(() => syncManager.forcePullFromRemote(), rateLimited);
            await saveLinks([link(1)]); // so the clear has something to back up
            fake.seed('local', { syncSetAsideInProgress: { links: [link(9)], downloaded: true } });
            expect((await syncManager.clearSyncData()).success).toBe(true);
            expect(fake.dump('local').syncSetAsideInProgress).toBeUndefined();
        });

        test('a reorder together with a missing category is named in the reason (Pc4)', async () => {
            const { saveCategories } = await import('../../javascript/core-systems/storageManager.js');
            fake.seed('sync', { links: '[]', categories: '["Default","A","B"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveCategories(['Default', 'B', 'A', 'X']));
            await chrome.storage.sync.set({ categories: '["Default","A","B","C"]' }); // another device

            const result = await syncManager.syncData();

            expect(result.warning).toMatch(/^1 category and the category order saved only on this device were replaced by newer changes in the cloud\./);
        });

        test('unmarked categories that differ only in order are not set aside on a first sync after a clear', async () => {
            fake.seed('sync', { links: JSON.stringify([link(5)]), categories: '["Default","A","B"]', syncClearedAt: 1000 });
            fake.seed('local', { links: JSON.stringify([link(5)]), categories: '["Default","B","A"]' });

            const result = await syncManager.syncData();

            expect(result.success).toBe(true);
            expect(result.warning).toBeUndefined();
            expect(downloadClicks).not.toHaveBeenCalled();
        });

        test('a junk entry in the cloud links does not fail every Sync now', async () => {
            const meta = { version: 100, lastModified: 100 };
            fake.seed('sync', { links: JSON.stringify([null, link(1)]), categories: '["Default"]', syncMetadata: meta });
            fake.seed('local', { syncMetadata: meta });

            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'local', 'links')).toEqual([link(1)]);
        });
    });

    describe('clearSyncData', () => {
        let originalCreate;
        let originalRevoke;
        let clickSpy;

        beforeEach(() => {
            originalCreate = URL.createObjectURL;
            originalRevoke = URL.revokeObjectURL;
            URL.revokeObjectURL = jest.fn();
            clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        });

        afterEach(() => {
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
            clickSpy.mockRestore();
        });

        const readBlob = (blob) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsText(blob);
        });

        test('downloads an importable backup of the cloud data before clearing it', async () => {
            const cloud = [link(1), link(2)];
            fake.seed('sync', {
                links: JSON.stringify(cloud),
                categories: JSON.stringify(['Default', 'Work']),
                theme: 'light'
            });
            let backupBlob = null;
            let syncAtBackupTime = null;
            URL.createObjectURL = jest.fn((blob) => {
                backupBlob = blob;
                syncAtBackupTime = fake.dump('sync');
                return 'blob:backup';
            });

            const result = await syncManager.clearSyncData();

            expect(result.success).toBe(true);
            expect(clickSpy).toHaveBeenCalledTimes(1);
            expect(syncAtBackupTime.links).toBeDefined(); // backup happened before the clear
            const backup = JSON.parse(await readBlob(backupBlob));
            expect(backup.links).toEqual(cloud); // arrays, so importLinks accepts the file
            expect(backup.categories).toEqual(['Default', 'Work']);
            expect(backup.theme).toBe('light');
            // Cleared to explicit empty/default values in one write (never an empty area).
            expect(fake.dump('sync')).toEqual({
                links: '[]',
                linksManifest: { chunks: 1, hashes: [expect.any(String)] },
                categories: '["Default"]',
                theme: 'dark',
                view: 'grid',
                colorTheme: 'default',
                defaultTileSize: 'medium',
                syncMetadata: { version: 0, lastModified: 0 },
                syncClearedAt: expect.any(Number)
            });
        });

        test('keeps a backup in chrome.storage.local and removes this device\'s snapshot', async () => {
            const cloud = [link(1), link(2)];
            fake.seed('sync', { links: JSON.stringify(cloud), categories: JSON.stringify(['Default']) });
            fake.seed('local', {
                links: JSON.stringify([link(1)]),
                categories: JSON.stringify(['Default']),
                syncMetadata: { version: 100, lastModified: 100 }
            });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            expect((await syncManager.clearSyncData()).success).toBe(true);

            const local = fake.dump('local');
            expect(local[SYNC_BACKUP_KEY].links).toEqual(cloud);
            expect(local[SYNC_BACKUP_KEY].deviceLocalCopy.links).toEqual([link(1)]);
            expect(local.links).toBeUndefined();
            expect(local.categories).toBeUndefined();
            expect(local.syncMetadata).toBeUndefined();
        });

        test('the next Sync now does not undo the clear', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
            await syncManager.syncData(); // this device now has a snapshot
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            expect((await syncManager.clearSyncData()).success).toBe(true);
            expect((await syncManager.syncData()).success).toBe(true);

            expect(stored(fake, 'sync', 'links')).toEqual([]);
        });

        test('another device with a snapshot does not show it after the clear', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
            URL.createObjectURL = jest.fn(() => 'blob:backup');
            expect((await syncManager.clearSyncData()).success).toBe(true);

            // Another device: still holds its manual-sync snapshot locally.
            fake.seed('local', {
                links: JSON.stringify([link(1)]),
                categories: JSON.stringify(['Default']),
                syncMetadata: { version: 100, lastModified: 100 }
            });
            const { loadLinks } = await import('../../javascript/core-systems/storageManager.js');
            expect((await loadLinks()).links).toEqual([]);
            expect((await syncManager.syncData()).success).toBe(true);
            expect(stored(fake, 'sync', 'links')).toEqual([]);
        });

        test('open tabs drop their in-memory links when sync is cleared', async () => {
            const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default', 'Work']) });
            safeUpdateState({ links: [link(1)], categories: ['Default', 'Work'] }, { validate: false, skipPersistence: true });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            await syncManager.clearSyncData();

            expect(getState().links).toEqual([]);
            expect(getState().categories).toEqual(['Default']);
        });

        test('a removal of links from sync resets open tabs too', async () => {
            const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
            fake.seed('sync', { links: JSON.stringify([link(1)]) });
            safeUpdateState({ links: [link(1)] }, { validate: false, skipPersistence: true });

            await chrome.storage.sync.remove('links');
            await flushAsyncWork(); // a links change re-reads every chunk first

            expect(getState().links).toEqual([]);
        });

        test('a second clear keeps the first backup', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1), link(2)]), categories: JSON.stringify(['Default']) });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            await syncManager.clearSyncData();
            await syncManager.clearSyncData();

            expect(fake.dump('local')[SYNC_BACKUP_KEY].links).toEqual([link(1), link(2)]);
            expect(URL.createObjectURL).toHaveBeenCalledTimes(1); // nothing new to download
        });

        test('a clear after new links keeps the earlier backup as the previous one', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1), link(2)]), categories: JSON.stringify(['Default']) });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            await syncManager.clearSyncData();
            await saveLinks([link(5)]);
            await syncManager.clearSyncData();

            const local = fake.dump('local');
            expect(local[SYNC_BACKUP_KEY].links).toEqual([link(5)]);
            expect(local[SYNC_PREVIOUS_BACKUP_KEY].links).toEqual([link(1), link(2)]);
        });

        test('backs up categories and settings even when there are no links', async () => {
            fake.seed('sync', { links: '[]', categories: JSON.stringify(['Default', 'Work']), theme: 'light' });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            expect((await syncManager.clearSyncData()).success).toBe(true);

            const backup = fake.dump('local')[SYNC_BACKUP_KEY];
            expect(backup.categories).toEqual(['Default', 'Work']);
            expect(backup.theme).toBe('light');
            expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        });

        test('backs up settings alone', async () => {
            fake.seed('sync', { view: 'list' });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            expect((await syncManager.clearSyncData()).success).toBe(true);
            expect(fake.dump('local')[SYNC_BACKUP_KEY].view).toBe('list');
        });

        test('a rate-limited clear reports a readable error and leaves the cloud as it was', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
            URL.createObjectURL = jest.fn(() => 'blob:backup');
            chrome.storage.sync.set = jest.fn(() => Promise.reject(
                new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.')));

            const result = await syncManager.clearSyncData();

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/^Chrome sync is limiting how often changes can be saved\. \(This request exceeds/);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
        });

        test('is applied in one write, so a rate limit cannot leave it half done', async () => {
            fake.seed('sync', {
                links: JSON.stringify([link(1)]),
                categories: '["Default"]',
                theme: 'light',
                linksView: 'list' // a key the clear can only remove, not reset
            });
            URL.createObjectURL = jest.fn(() => 'blob:backup');
            // Use up all but one of Chrome's 120 sync writes per minute.
            for (let i = 0; i < 119; i++) await chrome.storage.sync.set({ theme: 'light' });

            const result = await syncManager.clearSyncData();

            expect(result.success).toBe(true);
            const cloud = fake.dump('sync');
            expect(cloud.links).toBe('[]');
            expect(cloud.theme).toBe('dark'); // reset in the same write as the links
            expect(cloud.linksView).toBe('list'); // best-effort removal was rate-limited
        });

        test('puts unsynced local links at the top level of the downloaded backup', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveLinks([link(1), link(2)]));
            let backupBlob = null;
            URL.createObjectURL = jest.fn((blob) => { backupBlob = blob; return 'blob:backup'; });

            expect((await syncManager.clearSyncData()).success).toBe(true);

            const backup = JSON.parse(await readBlob(backupBlob));
            expect(backup.links).toEqual([link(1), link(2)]); // what Import restores
            expect(backup.cloudCopy.links).toEqual([link(1)]); // both copies are in the file
            expect(backup.deviceLocalCopy.links).toEqual([link(1), link(2)]);
            const stored = fake.dump('local')[SYNC_BACKUP_KEY];
            expect(stored.cloudCopy.links).toEqual([link(1)]);
            expect(stored.deviceLocalCopy.links).toEqual([link(1), link(2)]);
        });

        test('the backup\'s top level also holds what Sync now would set aside', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            await syncManager.syncData();
            await withSyncWritesFailing(() => saveLinks([link(1), link(2)]));
            await chrome.storage.sync.set({ links: JSON.stringify([link(1), link(3)]) }); // supersedes link 2's save
            let backupBlob = null;
            URL.createObjectURL = jest.fn((blob) => { backupBlob = blob; return 'blob:backup'; });

            expect((await syncManager.clearSyncData()).success).toBe(true);

            const backup = JSON.parse(await readBlob(backupBlob));
            expect(backup.links.map((l) => l.id).sort()).toEqual(['link_1', 'link_2', 'link_3']);
        });

        test('local links set aside by a clear are in the importable top level (thread 2)', async () => {
            // Never synced, and the cloud was cleared by another device since.
            fake.seed('sync', { links: JSON.stringify([link(5)]), categories: '["Default"]', syncClearedAt: 1000 });
            fake.seed('local', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]' });
            let backupBlob = null;
            URL.createObjectURL = jest.fn((blob) => { backupBlob = blob; return 'blob:backup'; });

            expect((await syncManager.clearSyncData()).success).toBe(true);

            const backup = JSON.parse(await readBlob(backupBlob));
            expect(backup.links.map((l) => l.id).sort()).toEqual(['link_1', 'link_2', 'link_5']);
        });

        test('backs up and removes settings that fell back to local storage', async () => {
            const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
            await withSyncWritesFailing(() => saveSettings({ theme: 'light' }));
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            expect((await syncManager.clearSyncData()).success).toBe(true);

            const backup = fake.dump('local')[SYNC_BACKUP_KEY];
            expect(backup.deviceLocalCopy.theme).toBe('light');
            expect(backup.theme).toBe('light'); // pending, so it's the newest value
            expect(fake.dump('local').theme).toBeUndefined();
            expect(fake.dump('local')['pendingSyncSince.theme']).toBeUndefined();
        });

        test('emits syncCleared once on the device that cleared', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            await syncManager.clearSyncData();
            await flushAsyncWork();

            expect(events.filter((e) => e.event === 'syncCleared')).toHaveLength(1);
        });

        test('retried failed clears do not rotate the earlier backup out', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
            URL.createObjectURL = jest.fn(() => 'blob:backup');
            await syncManager.clearSyncData();
            await saveLinks([link(2)]);

            const failing = { message: 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.' };
            await withSyncWritesFailing(() => syncManager.clearSyncData(), failing.message);
            await withSyncWritesFailing(() => syncManager.clearSyncData(), failing.message);

            const local = fake.dump('local');
            expect(local[SYNC_BACKUP_KEY].links).toEqual([link(2)]);
            expect(local[SYNC_PREVIOUS_BACKUP_KEY].links).toEqual([link(1)]);
        });

        test('aborts when the backup cannot be saved to chrome.storage.local', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
            URL.createObjectURL = jest.fn(() => 'blob:backup');
            const realSet = chrome.storage.local.set;
            chrome.storage.local.set = jest.fn((items) => (
                SYNC_BACKUP_KEY in items
                    ? Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'))
                    : realSet(items)
            ));

            const result = await syncManager.clearSyncData();

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Could not save a backup on this device/);
            expect(clickSpy).not.toHaveBeenCalled();
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
        });

        test('the clear itself is not reported as a sync', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
            URL.createObjectURL = jest.fn(() => 'blob:backup');

            await syncManager.clearSyncData();
            await flushAsyncWork();

            expect(events.map((e) => e.event)).not.toContain('syncComplete');
        });

        test('does not clear anything when the backup cannot be written', async () => {
            fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
            URL.createObjectURL = jest.fn(() => { throw new Error('download blocked'); });

            const result = await syncManager.clearSyncData();

            expect(result.success).toBe(false);
            expect(stored(fake, 'sync', 'links')).toEqual([link(1)]);
        });
    });
});

describe('Regression: sync pill reflects manual sync failures', () => {
    let fake;
    let confirmSpy;
    let indicator;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        document.body.innerHTML = '<div id="sync-status-container"></div>';
        const { SyncStatusIndicator } = await import('../../javascript/features/syncStatusIndicator.js');
        indicator = new SyncStatusIndicator();
        indicator.init('sync-status-container');
        await flushAsyncWork(); // let the initial status render settle
        confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        indicator.destroy();
        jest.restoreAllMocks();
        delete globalThis.chrome;
    });

    test('force push over quota leaves the pill in the error state', async () => {
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: JSON.stringify(['Default']) });
        fake.seed('local', { links: JSON.stringify(OVERSIZED_LINKS), categories: JSON.stringify(['Default']) });

        await indicator.handleMenuAction('force-push');
        await flushAsyncWork();

        expect(indicator.statusElement.className).toContain('sync-error');
        expect(indicator.statusElement.textContent).toContain('Sync Error');
    });

    test('a successful clear resets this page\'s links and shows Not synced', async () => {
        const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
        const { syncManager } = await import('../../javascript/core-systems/syncManager.js');
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
        safeUpdateState({ links: [link(1)] }, { validate: false, skipPersistence: true });
        const { createObjectURL, revokeObjectURL } = URL;
        Object.assign(URL, { createObjectURL: jest.fn(() => 'blob:backup'), revokeObjectURL: jest.fn() });
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        try {
            expect((await syncManager.clearSyncData()).success).toBe(true);
        } finally {
            Object.assign(URL, { createObjectURL, revokeObjectURL });
        }
        await flushAsyncWork(); // stateManager reloads after the clear's stamp

        expect(getState().links).toEqual([]);
        expect(indicator.statusElement.textContent).toContain('Not synced');
    });

    test('a change that lands during a sync is not overwritten by the sync\'s snapshot', async () => {
        const { getState } = await import('../../javascript/core-systems/stateManager.js');
        const { syncManager } = await import('../../javascript/core-systems/syncManager.js');
        const meta = { version: 100, lastModified: 100 };
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
        // Another device's write arrives right after the sync read the cloud.
        const realGet = chrome.storage.sync.get;
        let injected = false;
        chrome.storage.sync.get = async (keys) => {
            const result = await realGet(keys);
            if (!injected && [].concat(keys ?? []).includes('syncMetadata')) {
                injected = true;
                await chrome.storage.sync.set({ links: JSON.stringify([link(1), link(7)]) });
            }
            return result;
        };

        expect((await syncManager.syncData()).success).toBe(true);
        await flushAsyncWork();

        expect(getState().links).toEqual([link(1), link(7)]);
    });

    test('force pull applies the cloud\'s settings to the open page (thread 5)', async () => {
        const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
        const { syncManager } = await import('../../javascript/core-systems/syncManager.js');
        const { saveSettings } = await import('../../javascript/core-systems/storageManager.js');
        // The cloud has links but never stored a view; this page switched to
        // 'list' and the save fell back to local.
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'dark' });
        await syncManager.syncData();
        const realSet = chrome.storage.sync.set;
        chrome.storage.sync.set = () => Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'));
        await saveSettings({ theme: 'light', view: 'list' });
        chrome.storage.sync.set = realSet;
        safeUpdateState({ theme: 'light', view: 'list' }, { validate: false, skipPersistence: true });
        const { createObjectURL, revokeObjectURL } = URL;
        Object.assign(URL, { createObjectURL: jest.fn(() => 'blob:backup'), revokeObjectURL: jest.fn() });
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        try {
            expect((await syncManager.forcePullFromRemote()).success).toBe(true);
        } finally {
            Object.assign(URL, { createObjectURL, revokeObjectURL });
        }
        await flushAsyncWork();

        expect(getState().theme).toBe('dark');
        expect(getState().view).toBe('grid'); // the default, as a fresh load would show
    });

    test('destroy() stops listening to sync events', async () => {
        const { syncManager } = await import('../../javascript/core-systems/syncManager.js');
        const before = syncManager.syncListeners.length;

        indicator.destroy();

        expect(syncManager.syncListeners.length).toBe(before - 1);
        indicator.init('sync-status-container'); // afterEach destroys it again
    });

    test('a stamp from another tab\'s sync makes this page reload what storage holds', async () => {
        const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'dark' });
        // This page still holds a discarded local edit and setting.
        safeUpdateState({ links: [link(1), link(9)], theme: 'light' }, { validate: false, skipPersistence: true });

        // Another tab ran Force pull: the cloud won, so nothing was written to sync.
        await chrome.storage.local.set({ syncResolvedAt: Date.now() });
        await flushAsyncWork();

        expect(getState().links).toEqual([link(1)]);
        expect(getState().theme).toBe('dark');
    });

    test('a remote clear arriving with a newer edit keeps that edit', async () => {
        const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
        safeUpdateState({ links: [link(1)], filteredLinks: [link(1)] }, { validate: false, skipPersistence: true });

        // This device was asleep: the other device's clear and its next edit
        // arrive in one batch.
        await chrome.storage.sync.set({
            links: JSON.stringify([link(5)]),
            categories: '["Default"]',
            syncClearedAt: Date.now()
        });
        await flushAsyncWork();

        expect(getState().links).toEqual([link(5)]);
        expect(indicator.statusElement.textContent).toContain('Not synced');

        document.body.innerHTML += `
            <div id="linksContainer"></div>
            <span id="pageInfo"></span><button id="prevPage"></button><button id="nextPage"></button>`;
        const { handleSyncCleared } = await import('../../javascript/entry-points/manageScript.js');
        handleSyncCleared({ remote: true });
        expect(getState().filteredLinks).toEqual([link(5)]);
        expect(document.getElementById('linksContainer').children).toHaveLength(1);
    });

    test('a sync where the cloud wins replaces the links this page still holds', async () => {
        const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
        const { syncManager } = await import('../../javascript/core-systems/syncManager.js');
        // This page loaded links that only this device has (a superseded save).
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
        fake.seed('local', { links: JSON.stringify([link(1), link(9)]), 'pendingSyncSince.links': { since: 1 } });
        safeUpdateState({ links: [link(1), link(9)] }, { validate: false, skipPersistence: true });
        const { createObjectURL, revokeObjectURL } = URL;
        URL.createObjectURL = jest.fn(() => 'blob:backup');
        URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        let result;
        try {
            result = await syncManager.syncData();
        } finally {
            Object.assign(URL, { createObjectURL, revokeObjectURL });
        }

        expect(result.success).toBe(true);
        expect(getState().links).toEqual([link(1)]);

        document.body.innerHTML += `
            <div id="linksContainer"></div>
            <span id="pageInfo"></span><button id="prevPage"></button><button id="nextPage"></button>`;
        const { refreshLinkList } = await import('../../javascript/entry-points/manageScript.js');
        refreshLinkList({ links: [link(1)], categories: ['Default'] });
        expect(getState().filteredLinks).toEqual([link(1)]);
        expect(document.getElementById('linksContainer').children).toHaveLength(1);
    });

    test('the Sync tab sets up its listeners once, however often it is shown', async () => {
        document.body.innerHTML += `
            <select id="sync-strategy-select">
                <option value="remote">Cloud</option><option value="merge">Merge</option><option value="local">Local</option>
            </select>`;
        const { SyncSettingsController } = await import('../../javascript/features/syncSettingsController.js');
        const controller = new SyncSettingsController();
        controller.init();
        controller.init();
        controller.init();

        const select = document.getElementById('sync-strategy-select');
        select.value = 'local';
        select.dispatchEvent(new Event('change'));
        controller.destroy();

        expect(confirmSpy).toHaveBeenCalledTimes(1);
    });

    test('a sync that set local data aside says so on the pill', () => {
        indicator.handleSyncEvent('syncComplete', { time: Date.now(), warning: 'Local links were set aside.' });

        expect(indicator.statusElement.textContent).toContain('see backup');
        expect(indicator.statusElement.title).toBe('Local links were set aside.');
    });

    test('the manage page drops the cleared rows from its list', async () => {
        document.body.innerHTML += `
            <div id="linksContainer"><div class="link-item">old row</div></div>
            <span id="pageInfo"></span><button id="prevPage"></button><button id="nextPage"></button>`;
        const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
        // The clear has reached state.links; the rendered list is still stale.
        safeUpdateState({ links: [], filteredLinks: [link(1)], currentPage: 1 }, { validate: false, skipPersistence: true });
        const { handleSyncCleared } = await import('../../javascript/entry-points/manageScript.js');

        handleSyncCleared();

        expect(getState().filteredLinks).toEqual([]);
        expect(document.getElementById('linksContainer').children).toHaveLength(0);
    });

    test('a routine sync keeps the manage list on its current page', async () => {
        document.body.innerHTML += `
            <div id="linksContainer"></div>
            <span id="pageInfo"></span><button id="prevPage"></button><button id="nextPage"></button>`;
        const { safeUpdateState, getState } = await import('../../javascript/core-systems/stateManager.js');
        const links = Array.from({ length: 45 }, (_, i) => link(i));
        safeUpdateState({ links, filteredLinks: [...links], currentPage: 3 }, { validate: false, skipPersistence: true });
        const { refreshLinkList } = await import('../../javascript/entry-points/manageScript.js');

        refreshLinkList({ keepPage: true });
        expect(getState().currentPage).toBe(3);
        expect(document.getElementById('linksContainer').children).toHaveLength(0); // unchanged: not re-rendered

        safeUpdateState({ links: links.slice(0, 41) }, { validate: false, skipPersistence: true });
        refreshLinkList({ keepPage: true });
        expect(getState().currentPage).toBe(3);
        expect(getState().filteredLinks).toHaveLength(41);
    });

    test('choosing "This device\'s last sync wins" asks first and reverts if declined', async () => {
        const { syncManager } = await import('../../javascript/core-systems/syncManager.js');
        const { SyncSettingsController } = await import('../../javascript/features/syncSettingsController.js');
        const controller = new SyncSettingsController();
        controller.addLogEntry = () => {};
        const select = document.createElement('select');
        for (const value of ['remote', 'merge', 'local']) select.add(new Option(value, value));

        confirmSpy.mockReturnValue(false);
        select.value = 'local';
        await controller.handleStrategyChange(select);
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(select.value).toBe('remote');
        expect(syncManager.conflictResolutionStrategy).toBe('remote');
        expect(fake.dump('local').syncConflictStrategy).toBeUndefined();

        confirmSpy.mockReturnValue(true);
        select.value = 'local';
        await controller.handleStrategyChange(select);
        expect(syncManager.conflictResolutionStrategy).toBe('local');
        expect(fake.dump('local').syncConflictStrategy).toBe('local');

        select.value = 'merge';
        await controller.handleStrategyChange(select);
        expect(confirmSpy).toHaveBeenCalledTimes(2); // no confirm for merge
        expect(syncManager.conflictResolutionStrategy).toBe('merge');
        expect(fake.dump('local').syncConflictStrategy).toBe('merge');
    });

    test('the chosen conflict strategy survives a reload: shown on the Sync tab and used by Sync now', async () => {
        fake.seed('local', { syncConflictStrategy: 'merge' });
        jest.resetModules();
        const { SyncManager } = await import('../../javascript/core-systems/syncManager.js');
        const fresh = new SyncManager(); // a page loaded after the choice
        await expect(fresh.getConflictResolutionStrategy()).resolves.toBe('merge');

        const { SyncSettingsController } = await import('../../javascript/features/syncSettingsController.js');
        const controller = new SyncSettingsController();
        const select = document.createElement('select');
        for (const value of ['remote', 'merge', 'local']) select.add(new Option(value, value));
        controller.elements = { syncStrategySelect: select };
        await controller.showSavedStrategy();
        expect(select.value).toBe('merge');

        // Unequal versions: with the default ("Cloud wins") a local-only link
        // would be dropped; the saved "Merge" keeps it.
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: { version: 20, lastModified: 20 } });
        fake.seed('local', { links: JSON.stringify([link(1), link(2)]), categories: '["Default"]', syncMetadata: { version: 10, lastModified: 10 } });
        expect((await fresh.syncData()).success).toBe(true);
        expect(stored(fake, 'sync', 'links').map((l) => l.id)).toEqual(['link_1', 'link_2']);
    });

    test('Clear Sync Data warns that it affects every device', async () => {
        confirmSpy.mockReturnValue(false);
        await indicator.handleMenuAction('clear-sync');
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy.mock.calls[0][0]).toMatch(/all .*devices/i);
        expect(confirmSpy.mock.calls[0][0]).toMatch(/backup/i);
    });
});

// Several extension pages (separate module instances, via jest.resetModules)
// on one chrome.storage fake, with an exclusive FIFO Web Locks polyfill shared
// by all of them, as in Chrome. Gates on chrome.storage calls force the
// interleavings. (Harness from the #48 review's v99 probes.)
describe('Regression: pages, locks and the sync\'s local phase', () => {
    const RATE = 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.';
    const ids = (list) => (list ?? []).map((l) => (l && typeof l === 'object' ? l.id : l));
    const parse = (v) => (v === undefined ? undefined : (typeof v === 'string' ? JSON.parse(v) : v));
    const settle = async (n = 8) => { for (let i = 0; i < n; i++) await flushAsyncWork(); };
    const keysOf = (k) => (Array.isArray(k) ? k : (typeof k === 'string' ? [k] : Object.keys(k ?? {})));
    let fake;
    let blobs;

    const L = (key) => parse(fake.dump('local')[key]);
    const C = (key) => parse(fake.dump('sync')[key]);
    const markers = () => Object.fromEntries(Object.entries(fake.dump('local')).filter(([k]) => k.startsWith('pendingSyncSince.')));
    const readBlob = (blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(blob);
    });
    const downloads = async () => Promise.all(blobs.map(async (b) => ids(JSON.parse(await readBlob(b)).links)));
    const keptSomewhere = async (id) => ids(C('links')).includes(id) || ids(L('links')).includes(id)
        || (await downloads()).some((d) => d.includes(id))
        || ids(fake.dump('local').syncSetAside?.links).includes(id);

    function installWebLocks() {
        const tails = new Map();
        const locks = {
            request(name, ...rest) {
                const callback = rest[rest.length - 1];
                const prev = tails.get(name) ?? Promise.resolve();
                let release;
                const mine = new Promise((r) => { release = r; });
                tails.set(name, prev.then(() => mine));
                return prev.then(async () => {
                    try {
                        return await callback({ name, mode: 'exclusive' });
                    } finally {
                        release();
                    }
                });
            }
        };
        Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
    }

    // Pause the first call of chrome.storage[area][op] matching pred: 'before'
    // the real call, or 'after' it completed.
    function gate(area, op, pred, when = 'before') {
        const real = chrome.storage[area][op];
        let hit;
        let open;
        const reached = new Promise((r) => { hit = r; });
        const opened = new Promise((r) => { open = r; });
        let used = false;
        chrome.storage[area][op] = async (...args) => {
            if (!used && pred(...args)) {
                used = true;
                if (when === 'before') {
                    hit(args);
                    await opened;
                    return real(...args);
                }
                const result = await real(...args);
                hit(args);
                await opened;
                return result;
            }
            return real(...args);
        };
        return { reached, release: () => open() };
    }

    // Reject chrome.storage.sync.set while pred(items) holds: a save's own
    // write ('links' without syncMetadata) is rate-limited, a sync's isn't.
    function failSaveWrites(pred = (items) => !('syncMetadata' in items) && !('syncClearedAt' in items)) {
        const real = chrome.storage.sync.set;
        let on = true;
        chrome.storage.sync.set = (items, ...rest) => (on && pred(items) ? Promise.reject(new Error(RATE)) : real(items, ...rest));
        return () => { on = false; };
    }

    const isSyncInputsLocalRead = (k) => keysOf(k).includes('deviceId') && keysOf(k).includes('syncMetadata');

    async function loadPage() {
        jest.resetModules();
        const sm = await import('../../javascript/core-systems/storageManager.js');
        const syncMod = await import('../../javascript/core-systems/syncManager.js');
        const st = await import('../../javascript/core-systems/stateManager.js');
        const mgr = syncMod.syncManager;
        const events = [];
        mgr.addSyncListener((event, data) => events.push({ event, data }));
        return { sm, st, mgr, events };
    }

    const meta = { version: 100, lastModified: 100 };
    const seedSynced = (links) => {
        fake.seed('sync', { links: JSON.stringify(links), categories: '["Default"]', syncMetadata: meta });
        fake.seed('local', { links: JSON.stringify(links), categories: '["Default"]', syncMetadata: meta });
    };

    beforeEach(() => {
        blobs = [];
        URL.createObjectURL = jest.fn((b) => { blobs.push(b); return 'blob:x'; });
        URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        fake = installChromeStorageFake();
        installWebLocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete globalThis.chrome;
        delete globalThis.navigator.locks;
        document.body.innerHTML = '';
    });

    test('another page\'s successful save does not discard this page\'s pending edit (HP4b)', async () => {
        const A = await loadPage();
        seedSynced([link(1)]);
        const stop = failSaveWrites();
        await A.sm.saveLinks([link(1), link(2)]); // falls back: local value + marker
        stop();
        const B = await loadPage(); // a tab opened later shows the cloud
        const loaded = await B.sm.loadLinks();
        await B.sm.saveLinks([...loaded.links, link(3)]); // succeeds

        expect(markers()['pendingSyncSince.links']).toBeDefined();
        const result = await B.mgr.syncData();

        expect(result.warning).toMatch(/replaced by newer changes in the cloud/);
        expect(await keptSomewhere('link_2')).toBe(true);
        expect(ids(C('links'))).toEqual(['link_1', 'link_3']);
    });

    test('a page\'s successful save does not drop the marker another page just wrote (HP5)', async () => {
        const A = await loadPage();
        const Cp = await loadPage();
        seedSynced([link(1)]);
        // A's save succeeds; hold it before it clears the links marker.
        const g = gate('local', 'get', (k) => keysOf(k).length === 1 && keysOf(k)[0] === 'pendingSyncSince.links', 'before');
        const saveA = A.sm.saveLinks([link(1), link(2)]);
        await g.reached;
        // C's save is rate-limited and falls back meanwhile.
        const stop = failSaveWrites();
        const saveC = Cp.sm.saveLinks([link(1), link(2), link(3)]);
        await settle(3);
        stop();
        g.release();
        await saveA;
        await saveC;

        expect(markers()['pendingSyncSince.links']).toBeDefined();
        await A.mgr.syncData();
        expect(await keptSomewhere('link_3')).toBe(true);
    });

    test('a page\'s later successful save supersedes its own fallback (an exact revert is not pushed back)', async () => {
        const A = await loadPage();
        fake.seed('sync', { links: JSON.stringify([link(1)]), categories: '["Default"]', theme: 'dark', syncMetadata: meta });
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]', syncMetadata: meta });
        const stop = failSaveWrites();
        await A.sm.saveSettings({ theme: 'light' }); // falls back
        stop();
        await A.sm.saveSettings({ theme: 'dark' }); // reverted, reaches sync

        expect(markers()['pendingSyncSince.theme']).toBeUndefined();
        expect(fake.dump('local').theme).toBeUndefined();
        expect((await A.mgr.syncData()).success).toBe(true);
        expect(fake.dump('sync').theme).toBe('dark');
    });

    test('a fallback save in the same millisecond the sync read local storage keeps its value and marker (HP3)', async () => {
        const A = await loadPage();
        const B = await loadPage();
        seedSynced([link(1)]);
        jest.spyOn(Date, 'now').mockReturnValue(Date.now());
        const stop = failSaveWrites();
        const g = gate('local', 'get', isSyncInputsLocalRead, 'after');
        const sync = B.mgr.syncData();
        await g.reached;
        const saved = A.sm.saveLinks([link(1), link(2)]); // falls back while B's sync runs
        await settle(3);
        g.release();
        const result = await sync;
        expect(await saved).toBe(true);
        stop();

        expect(result.success).toBe(true);
        expect(ids(L('links'))).toEqual(['link_1', 'link_2']);
        expect(markers()['pendingSyncSince.links']).toBeDefined();
    });

    test('a fallback that lands while the sync pushes an older pending value is pushed next time (N2)', async () => {
        const A = await loadPage();
        const B = await loadPage();
        seedSynced([link(1)]);
        const stop = failSaveWrites();
        await A.sm.saveLinks([link(1), link(2)]); // pending: L1
        const g = gate('local', 'get', isSyncInputsLocalRead, 'after');
        const sync = B.mgr.syncData(); // will push L1
        await g.reached;
        await new Promise((r) => setTimeout(r, 3));
        await A.sm.saveLinks([link(1), link(2), link(4)]); // falls back: L2, based on the cloud before the push
        g.release();
        expect((await sync).success).toBe(true);
        stop();
        expect(ids(C('links'))).toEqual(['link_1', 'link_2']);

        const next = await B.mgr.syncData();

        expect(next.warning).toBeUndefined();
        expect(ids(C('links'))).toEqual(['link_1', 'link_2', 'link_4']);
    });

    test('a failed local lists write after the cloud took a first sync does not make the next sync merge again (HP12)', async () => {
        const A = await loadPage();
        fake.seed('local', { links: JSON.stringify([link(1)]), categories: '["Default"]' });
        fake.seed('sync', { links: JSON.stringify([link(2), link(3)]), categories: '["Default"]', syncMetadata: { version: 9, lastModified: 9 } });
        const realLocalSet = chrome.storage.local.set;
        let failed = false;
        chrome.storage.local.set = (items, ...rest) => {
            if (!failed && 'links' in items && !Object.keys(items).some((k) => k.startsWith('pendingSyncSince.'))) {
                failed = true;
                return Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'));
            }
            return realLocalSet(items, ...rest);
        };
        await A.mgr.syncData();
        chrome.storage.local.set = realLocalSet;
        // Another device deletes link 1 (a normal edit).
        await chrome.storage.sync.set({ links: JSON.stringify([link(2), link(3)]) });

        await A.mgr.syncData();

        expect(ids(C('links'))).not.toContain('link_1');
    });

    test('after a sync sets lists aside, the open page matches storage (HP2d)', async () => {
        const A = await loadPage();
        fake.seed('sync', { theme: 'light' });
        fake.seed('local', { links: JSON.stringify([link(1), link(3)]), categories: '["Default","Work"]', deviceId: 'device_x' });
        A.st.safeUpdateState({ links: [link(1), link(3)], categories: ['Default', 'Work'] }, { validate: false, skipPersistence: true });

        const result = await A.mgr.syncData();
        await settle();

        expect(result.warning).toBeDefined();
        expect(ids(A.st.getState().links)).toEqual(ids((await A.sm.loadLinks()).links));
        expect(A.st.getState().links).toEqual([]);
    });

    test('two syncs in the same millisecond both make the page reload', async () => {
        const A = await loadPage();
        seedSynced([link(1)]);
        jest.spyOn(Date, 'now').mockReturnValue(Date.now());
        expect((await A.mgr.syncData()).success).toBe(true);
        await settle();
        // The page then holds a link storage doesn't have.
        A.st.safeUpdateState({ links: [link(1), link(9)] }, { validate: false, skipPersistence: true });

        expect((await A.mgr.syncData()).success).toBe(true);
        await settle();

        expect(A.st.getState().links).toEqual([link(1)]);
    });

    test('after a settings-only Force pull, the next Sync now still merges this device\'s lists (X1)', async () => {
        const A = await loadPage();
        fake.seed('sync', { theme: 'light' });
        fake.seed('local', { links: JSON.stringify([link(1), link(3)]), categories: '["Default"]' });

        expect((await A.mgr.forcePullFromRemote()).success).toBe(true);
        expect(fake.dump('local').syncMetadata).toBeUndefined();
        expect((await A.mgr.syncData()).success).toBe(true);

        expect(ids(C('links'))).toEqual(['link_1', 'link_3']);
        expect(ids(L('links'))).toEqual(['link_1', 'link_3']);
    });

    test('a set-aside copy that could not be kept after the cloud write is kept later, and the warning says only what happened', async () => {
        const A = await loadPage();
        seedSynced([link(1)]);
        fake.seed('local', { links: JSON.stringify([link(1), link(9)]), 'pendingSyncSince.links': { since: 1 } });
        const realLocalSet = chrome.storage.local.set;
        let failed = false;
        chrome.storage.local.set = (items, ...rest) => {
            if (!failed && 'syncSetAside' in items) {
                failed = true;
                return Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'));
            }
            return realLocalSet(items, ...rest);
        };
        const first = await A.mgr.syncData();
        chrome.storage.local.set = realLocalSet;

        expect(first.success).toBe(true);
        expect(first.warning).toMatch(/A copy was downloaded as a backup file/);
        expect(first.warning).not.toMatch(/saved on this device/);
        expect(fake.dump('local').syncSetAsideInProgress.afterCloud).toBe(true);

        expect((await A.mgr.syncData()).success).toBe(true); // nothing to set aside this time
        expect(ids(fake.dump('local').syncSetAside?.links)).toEqual(['link_1', 'link_9']);
        expect(fake.dump('local').syncSetAsideInProgress).toBeUndefined();
    });
});
