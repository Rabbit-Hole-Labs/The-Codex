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

// Far over the 8 KB per-item sync quota once Chrome re-escapes the JSON string.
const OVERSIZED_LINKS = Array.from({ length: 200 }, (_, i) => link(i));

async function flushAsyncWork() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Regression: SyncManager must not revert cloud data', () => {
    let fake;
    let syncManager;
    let saveLinks;
    let events;
    let SYNC_BACKUP_KEY;
    let SYNC_PREVIOUS_BACKUP_KEY;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        let SyncManager;
        ({ SyncManager, SYNC_BACKUP_KEY, SYNC_PREVIOUS_BACKUP_KEY } = await import('../../javascript/core-systems/syncManager.js'));
        ({ saveLinks } = await import('../../javascript/core-systems/storageManager.js'));
        syncManager = new SyncManager();
        events = [];
        syncManager.addSyncListener((event, data) => events.push({ event, data }));
        await flushAsyncWork();
    });

    afterEach(() => {
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

    describe('first sync on a device that has never synced', () => {
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
        expect(itemBytes('links', JSON.stringify(OVERSIZED_LINKS))).toBeGreaterThan(8192);

        const result = await syncManager.forcePushToRemote();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/kQuotaBytesPerItem/);
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
        expect(result.error).toMatch(/^Chrome sync storage quota exceeded\. \(Resource::kQuotaBytesPerItem/);
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
            // Cleared to explicit empty values (never an empty area), settings removed.
            expect(fake.dump('sync')).toEqual({
                links: '[]',
                categories: '["Default"]',
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
        safeUpdateState({ links: [link(1)] }, { validate: false, skipPersistence: true });
        // Simulate a tab that missed the storage events, e.g. mid-write.
        indicator.handleSyncEvent('syncCleared', { time: Date.now() });

        expect(getState().links).toEqual([]);
        expect(indicator.statusElement.textContent).toContain('Not synced');
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
        controller.handleStrategyChange(select);
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(select.value).toBe('remote');
        expect(syncManager.conflictResolutionStrategy).toBe('remote');

        confirmSpy.mockReturnValue(true);
        select.value = 'local';
        controller.handleStrategyChange(select);
        expect(syncManager.conflictResolutionStrategy).toBe('local');

        select.value = 'merge';
        controller.handleStrategyChange(select);
        expect(confirmSpy).toHaveBeenCalledTimes(2); // no confirm for merge
        expect(syncManager.conflictResolutionStrategy).toBe('merge');
    });

    test('Clear Sync Data warns that it affects every device', async () => {
        confirmSpy.mockReturnValue(false);
        await indicator.handleMenuAction('clear-sync');
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(confirmSpy.mock.calls[0][0]).toMatch(/all .*devices/i);
        expect(confirmSpy.mock.calls[0][0]).toMatch(/backup/i);
    });
});
