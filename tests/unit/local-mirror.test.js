/**
 * A successful save also updates this device's local copy of the list.
 *
 * Saves write chrome.storage.sync; chrome.storage.local used to keep the lists
 * as of the last manual sync. Links deleted on this device then still showed
 * as "Local Data" in Compare, while the cloud showed the deletion — and a
 * Force push or a merge would have restored them from that stale copy.
 *
 * Runs the real modules against the quota-faithful chrome.storage fake.
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake } from '../helpers/chromeStorageFake.js';

const link = (i) => ({ id: `link_${i}`, name: `Site ${i}`, url: `https://site${i}.example.com/`, category: 'Default' });
const links = (...ids) => ids.map(link);
const meta = { version: 100, lastModified: 100, deviceId: 'device_a' };

describe('successful saves keep the local copy current', () => {
    let fake;
    let sm;
    let syncManager;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        sm = await import('../../javascript/core-systems/storageManager.js');
        const { SyncManager } = await import('../../javascript/core-systems/syncManager.js');
        syncManager = new SyncManager();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    afterEach(() => {
        delete globalThis.chrome;
    });

    const local = (key) => {
        const value = fake.dump('local')[key];
        return value === undefined ? undefined : JSON.parse(value);
    };
    const cloudLinks = async () => JSON.parse((await import('../../javascript/core-systems/syncStorage.js'))
        .decodeLinksFromSync(fake.dump('sync')).value);

    function seedSynced(list) {
        const lists = { links: JSON.stringify(list), categories: '["Default","Work"]' };
        fake.seed('sync', { ...lists, syncMetadata: meta });
        fake.seed('local', { ...lists, syncMetadata: meta });
    }

    test('links deleted here leave the local copy too (the reported case)', async () => {
        seedSynced(links(1, 2, 3, 4));
        expect(await sm.saveLinks(links(1, 3))).toBe(true);

        expect(local('links')).toEqual(links(1, 3));
        const comparison = await (await import('../../javascript/features/dataVerification.js')).dataVerification.compareData();
        expect(comparison.differences.links.onlyLocal).toEqual([]);
        expect(comparison.summary.isInSync).toBe(true);
    });

    test('Force push and a merge no longer bring deleted links back', async () => {
        seedSynced(links(1, 2, 3));
        await sm.saveLinks(links(1, 3));

        expect((await syncManager.forcePushToRemote()).success).toBe(true);
        expect(await cloudLinks()).toEqual(links(1, 3));
        expect((await syncManager.syncData('merge')).success).toBe(true);
        expect((await cloudLinks()).map((l) => l.id).sort()).toEqual(['link_1', 'link_3']);
    });

    test('categories saved here are mirrored too', async () => {
        seedSynced(links(1));
        await sm.saveCategories(['Default', 'Lab']);
        expect(local('categories')).toEqual(['Default', 'Lab']);
    });

    test('another page\'s pending edit in the local copy is left alone', async () => {
        seedSynced(links(1));
        const pending = JSON.stringify(links(1, 9));
        const marker = { id: 'other-page', since: 1, cloud: JSON.stringify(JSON.stringify(links(1))), clearedAt: null };
        fake.seed('local', { links: pending, 'pendingSyncSince.links': marker });

        expect(await sm.saveLinks(links(1, 2))).toBe(true);
        expect(fake.dump('local').links).toBe(pending);
        expect(fake.dump('local')['pendingSyncSince.links']).toEqual(marker);
    });

    test('a device that never synced gets no local copy (its first Sync now would merge it in)', async () => {
        fake.seed('sync', { links: JSON.stringify(links(1, 2)), categories: '["Default"]' });
        expect(await sm.saveLinks(links(1))).toBe(true);
        expect(fake.dump('local').links).toBeUndefined();
    });

    test('a save that falls back to this device still marks itself pending', async () => {
        seedSynced(links(1));
        const realSet = chrome.storage.sync.set;
        chrome.storage.sync.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
        try {
            expect(await sm.saveLinks(links(1, 2))).toBe(true);
        } finally {
            chrome.storage.sync.set = realSet;
        }
        expect(local('links')).toEqual(links(1, 2));
        expect(fake.dump('local')['pendingSyncSince.links']).toBeDefined();
        expect(await cloudLinks()).toEqual(links(1));
    });
});
