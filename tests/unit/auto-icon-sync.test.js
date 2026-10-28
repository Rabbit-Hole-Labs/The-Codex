/**
 * Automatic logo matches are saved to their links, so they sync
 * (autoIconSync.js). Before, a match stayed on the device that made it, and
 * every other device had to match the icon again.
 *
 * Runs the real modules against the quota-faithful chrome.storage fake.
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake } from '../helpers/chromeStorageFake.js';

const iconUrl = (slug) => `https://cdn.jsdelivr.net/gh/selfhst/icons/webp/${slug}.webp`;
const link = (name, extra = {}) => ({
    id: `id-${name}`,
    name,
    url: `http://192.168.1.10/${name.toLowerCase()}/`,
    category: 'Lab Tools',
    ...extra
});
const meta = { version: 100, lastModified: 100, deviceId: 'device_a' };

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

describe('automatic icon matches are saved to their links', () => {
    let fake;
    let auto;
    let syncStorage;

    beforeEach(async () => {
        fake = installChromeStorageFake();
        jest.resetModules();
        auto = await import('../../javascript/features/autoIconSync.js');
        syncStorage = await import('../../javascript/core-systems/syncStorage.js');
    });

    afterEach(() => {
        delete globalThis.chrome;
        delete globalThis.fetch;
    });

    const cloudLinks = () => JSON.parse(syncStorage.decodeLinksFromSync(fake.dump('sync')).value);
    const seedCloud = (links) => fake.seed('sync', { links: JSON.stringify(links), categories: '["Default","Lab Tools"]', syncMetadata: meta });

    test('a selfh.st match made by the new tab ends up on the synced link', async () => {
        const icons = await import('../../javascript/features/iconCache.js');
        const sonarr = link('Sonarr', { icon: 'default' });
        seedCloud([sonarr, link('Radarr')]);
        icons.setSelfhstMatchListener(auto.queueAutoIcon);
        globalThis.fetch = mockFetch([iconUrl('sonarr')]);

        await icons.loadIconWithCache(sonarr, { allowFavicon: false });
        expect(await auto.flushAutoIcons()).toBe(1);

        expect(cloudLinks()).toEqual([{ ...sonarr, icon: iconUrl('sonarr') }, link('Radarr')]);
    });

    test('several matches are saved in one write', async () => {
        seedCloud([link('Sonarr'), link('Radarr')]);
        const setSpy = jest.spyOn(chrome.storage.sync, 'set');
        auto.queueAutoIcon(link('Sonarr'), iconUrl('sonarr'));
        auto.queueAutoIcon(link('Radarr'), iconUrl('radarr'));

        expect(await auto.flushAutoIcons()).toBe(2);
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(cloudLinks().map((l) => l.icon)).toEqual([iconUrl('sonarr'), iconUrl('radarr')]);
    });

    test('a link renamed, re-pointed or given a picked icon since the match is left alone', async () => {
        const picked = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light.svg';
        seedCloud([link('Sonarr', { name: 'Sonarr 4K' }), link('Radarr', { icon: picked }), link('Lidarr', { url: 'http://other/' })]);
        auto.queueAutoIcon(link('Sonarr'), iconUrl('sonarr'));
        auto.queueAutoIcon(link('Radarr'), iconUrl('radarr'));
        auto.queueAutoIcon(link('Lidarr'), iconUrl('lidarr'));

        expect(await auto.flushAutoIcons()).toBe(0);
        expect(cloudLinks().map((l) => l.icon)).toEqual([undefined, picked, undefined]);
    });

    test('only selfh.st/jsDelivr URLs are saved, never favicons or initials', async () => {
        seedCloud([link('Sonarr'), link('Radarr')]);
        auto.queueAutoIcon(link('Sonarr'), 'https://www.google.com/s2/favicons?domain=sonarr.tv&sz=128');
        auto.queueAutoIcon(link('Radarr'), 'data:image/png;base64,iVBORw0KGgo=');

        expect(await auto.flushAutoIcons()).toBe(0);
        expect(fake.dump('sync').links).toBe(JSON.stringify([link('Sonarr'), link('Radarr')]));
    });

    test('nothing is written while a links save is waiting for Sync now', async () => {
        seedCloud([link('Sonarr')]);
        const marker = { id: 'x', since: 1, cloud: 'null', clearedAt: null };
        fake.seed('local', { links: JSON.stringify([link('Sonarr'), link('New')]), 'pendingSyncSince.links': marker });
        auto.queueAutoIcon(link('Sonarr'), iconUrl('sonarr'));

        expect(await auto.flushAutoIcons()).toBe(0);
        expect(cloudLinks()).toEqual([link('Sonarr')]);
        expect(fake.dump('local')['pendingSyncSince.links']).toEqual(marker);
    });

    test('a rejected sync write leaves this device untouched (no fallback, no marker)', async () => {
        seedCloud([link('Sonarr')]);
        fake.seed('local', { links: JSON.stringify([link('Sonarr')]), syncMetadata: meta });
        chrome.storage.sync.set = () => Promise.reject(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded'));
        auto.queueAutoIcon(link('Sonarr'), iconUrl('sonarr'));

        expect(await auto.flushAutoIcons()).toBe(0);
        expect(fake.dump('local').links).toBe(JSON.stringify([link('Sonarr')]));
        expect(fake.dump('local')['pendingSyncSince.links']).toBeUndefined();
    });

    test('a match for a link that already has a picked icon is not queued', () => {
        expect(auto.hasAutomaticIcon(link('A', { icon: iconUrl('a') }))).toBe(false);
        expect(auto.hasAutomaticIcon(link('A', { icon: 'default' }))).toBe(true);
        expect(auto.hasAutomaticIcon(link('A', { icon: null }))).toBe(true);
        expect(auto.hasAutomaticIcon(link('A'))).toBe(true);
    });
});
