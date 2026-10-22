/**
 * The Sync tab's "Compare data" report (dataVerification.js).
 *
 * It used to call the two areas in sync only when the whole of
 * chrome.storage.local equalled the whole of chrome.storage.sync — never
 * true, since local also holds this device's own data (the icon cache, the
 * error log, backups, sync status). Identical links, categories and sync
 * versions still read "In Sync: No" with a ~400 KB "size difference".
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake } from '../helpers/chromeStorageFake.js';

const link = (i) => ({ id: `link_${i}`, name: `Site ${i}`, url: `https://site${i}.example.net/`, category: 'Default' });
const LINKS = JSON.stringify([link(1), link(2)]);
const CATEGORIES = JSON.stringify(['Default', 'Work']);
const METADATA = { version: 1792704069862, lastModified: 1792704069862, deviceId: 'device_a' };
const BIG_ICON = 'data:image/webp;base64,' + 'A'.repeat(6000);

describe('Compare data', () => {
    let fake;
    let dataVerification;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        ({ dataVerification } = await import('../../javascript/features/dataVerification.js'));
        fake.seed('sync', { links: LINKS, categories: CATEGORIES, theme: 'dark', syncMetadata: METADATA });
        // This device's copy from its last Sync now, plus data that never syncs.
        const iconCache = Object.fromEntries(Array.from({ length: 50 }, (_, i) =>
            [`iconV1:https://cdn.jsdelivr.net/gh/selfhst/icons/webp/app-${i}.webp`, { data: BIG_ICON, size: BIG_ICON.length }]));
        fake.seed('local', {
            links: LINKS,
            categories: CATEGORIES,
            syncMetadata: METADATA,
            deviceId: 'device_a',
            lastSyncTime: 1792704069862,
            codexErrorLog: [{ type: 'console.warn', message: 'x' }],
            iconSourcesV1: {},
            ...iconCache
        });
    });

    afterEach(() => {
        delete globalThis.chrome;
    });

    test('identical synced data reads In Sync, whatever this device keeps for itself', async () => {
        const comparison = await dataVerification.compareData();

        expect(comparison.summary.isInSync).toBe(true);
        expect(comparison.summary.differences).toEqual([]);
        // Sizes compare what syncs; the ~300 KB icon cache is reported apart.
        expect(Math.abs(comparison.summary.sizeDifference)).toBeLessThan(100);
        expect(comparison.summary.deviceOnly.iconCacheEntries).toBe(50);
        expect(comparison.summary.deviceOnly.size).toBeGreaterThan(50 * 6000);

        const html = dataVerification.renderComparison(comparison);
        expect(html).toMatch(/In Sync:<\/strong>\s*<span[^>]*>Yes<\/span>/);
        expect(html).toContain('icon cache: 50 icons');
        expect(html).not.toContain('Why not in sync');
    });

    test('a links copy that differs from the cloud is reported, and why', async () => {
        fake.seed('local', { links: JSON.stringify([link(1)]) });

        const { summary } = await dataVerification.compareData();

        expect(summary.isInSync).toBe(false);
        expect(summary.differences).toEqual([expect.stringMatching(/^The links differ/)]);
        expect(dataVerification.renderComparison(await dataVerification.compareData())).toContain('Why not in sync');
    });

    test('a reorder counts, and says so; a re-serialization (key order) does not', async () => {
        fake.seed('local', { links: JSON.stringify([link(2), link(1)]) });
        const comparison = await dataVerification.compareData();
        expect(comparison.summary.differences).toEqual([expect.stringMatching(/^The links are the same, in a different order/)]);
        // The details name the reorder, not just three zero counts.
        expect(comparison.differences.links).toMatchObject({ onlyLocal: [], onlyCloud: [], modified: [], reordered: true });
        expect(dataVerification.renderComparison(comparison)).toContain('Same links, in a different order');

        const reordered = [link(1), link(2)].map(({ url, id, name, category }) => ({ url, id, category, name }));
        fake.seed('local', { links: JSON.stringify(reordered) });
        expect((await dataVerification.compareData()).summary.isInSync).toBe(true);
    });

    test('categories in a different order are reported as a reorder, in the reason and the details', async () => {
        fake.seed('local', { categories: JSON.stringify(['Work', 'Default']) });

        const comparison = await dataVerification.compareData();

        expect(comparison.summary.isInSync).toBe(false);
        expect(comparison.summary.differences).toEqual(['The categories are the same, in a different order.']);
        expect(comparison.differences.categories).toMatchObject({ onlyLocal: [], onlyCloud: [], reordered: true });
        const html = dataVerification.renderComparison(comparison);
        expect(html).toContain('Same categories, in a different order');
        expect(html).not.toContain('Same links, in a different order');

        // Different categories are not a reorder.
        fake.seed('local', { categories: JSON.stringify(['Default', 'Home']) });
        const changed = await dataVerification.compareData();
        expect(changed.summary.differences).toEqual(['The categories differ.']);
        expect(changed.differences.categories.reordered).toBe(false);
    });

    test('another device having synced since, or a change waiting for Sync now, is reported', async () => {
        fake.seed('sync', { syncMetadata: { ...METADATA, version: METADATA.version + 1 } });
        fake.seed('local', { 'pendingSyncSince.theme': { id: 'x', since: 1 }, theme: 'light' });

        const { summary } = await dataVerification.compareData();

        expect(summary.isInSync).toBe(false);
        expect(summary.differences).toEqual([
            expect.stringMatching(/^The sync versions differ/),
            '1 change saved only on this device, waiting for Sync now.'
        ]);
    });

    test('lists stored as raw arrays (older builds) are read, not compared as empty', async () => {
        fake.seed('sync', { links: [link(1), link(2)], categories: ['Default', 'Work'] });
        fake.seed('local', { links: [link(1)], categories: ['Default', 'Work'] });

        const { summary, local, cloud } = await dataVerification.compareData();

        expect([local.summary.linkCount, cloud.summary.linkCount]).toEqual([1, 2]);
        expect(summary.isInSync).toBe(false);
        expect(summary.differences).toEqual([expect.stringMatching(/^The links differ/)]);
    });

    test('a cloud save still arriving from another device is not judged', async () => {
        const { encodeLinksForSync } = await import('../../javascript/core-systems/syncStorage.js');
        // The manifest of a newer save arrived; its chunks haven't yet.
        const { items } = encodeLinksForSync(JSON.stringify([link(1), link(2), link(3)]));
        fake.seed('sync', { linksManifest: items.linksManifest });

        const { summary } = await dataVerification.compareData();

        expect(summary.isInSync).toBe(false);
        expect(summary.differences[0]).toMatch(/still arriving in Chrome sync; compare again in a moment/);
    });

    test('links that differ only in key order are neither out of sync nor "modified"', async () => {
        const reordered = [link(1), link(2)].map(({ url, id, name, category }) => ({ url, id, category, name }));
        fake.seed('local', { links: JSON.stringify(reordered) });

        const comparison = await dataVerification.compareData();

        expect(comparison.summary.isInSync).toBe(true);
        expect(comparison.differences.links.modified).toEqual([]);
    });

    test('a device that never synced is not in sync with a cloud that holds links', async () => {
        fake.seed('local', { links: undefined });
        await chrome.storage.local.remove(['links', 'categories', 'syncMetadata']);

        const { summary } = await dataVerification.compareData();

        expect(summary.isInSync).toBe(false);
        expect(summary.differences).toHaveLength(3);
    });
});
