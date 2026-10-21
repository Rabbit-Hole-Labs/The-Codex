/**
 * Tests for the quota-faithful chrome.storage fake (tests/helpers/chromeStorageFake.js).
 * The fake is only useful if its quotas match Chrome's, so pin them here.
 */

import {
    createChromeStorageFake,
    installChromeStorageFake,
    itemBytes,
    utf8ByteLength,
    SYNC_QUOTAS
} from '../helpers/chromeStorageFake.js';

// A string value whose stored item (key + JSON.stringify(value)) is exactly `bytes`.
function valueForItemSize(key, bytes) {
    return 'x'.repeat(bytes - key.length - 2); // JSON.stringify adds 2 quotes
}

describe('chrome.storage fake', () => {
    let clock;
    let fake;

    beforeEach(() => {
        clock = 1_000_000;
        fake = createChromeStorageFake({ now: () => clock });
    });

    describe('size accounting', () => {
        test('counts UTF-8 bytes, not UTF-16 code units', () => {
            expect(utf8ByteLength('abc')).toBe(3);
            expect(utf8ByteLength('é')).toBe(2);
            expect(utf8ByteLength('€')).toBe(3);
            expect(utf8ByteLength('😀')).toBe(4);
        });

        test('item size is key bytes plus JSON.stringify(value) bytes', () => {
            expect(itemBytes('k', 'ab')).toBe(1 + 4);
            // A JSON-string value (how links are stored) is escaped again.
            const linksString = JSON.stringify([{ name: 'a' }]); // [{"name":"a"}]
            expect(itemBytes('links', linksString)).toBe(5 + JSON.stringify(linksString).length);
            expect(JSON.stringify(linksString).length).toBeGreaterThan(linksString.length + 2);
        });

        test('counts the extra escaping Chromium\'s JSON writer applies to <, U+2028 and U+2029', () => {
            expect(itemBytes('k', '<')).toBe(1 + '"\\u003C"'.length);
            expect(itemBytes('k', '\u2028')).toBe(1 + '"\\u2028"'.length);
            expect(itemBytes('k', '>')).toBe(1 + 3);
        });

        test('getBytesInUse matches the item measure in both calling forms', async () => {
            await fake.sync.set({ a: 'hello', links: '[{"x":1}]' });
            const expected = itemBytes('a', 'hello') + itemBytes('links', '[{"x":1}]');
            await expect(fake.sync.getBytesInUse(null)).resolves.toBe(expected);
            await expect(fake.sync.getBytesInUse('a')).resolves.toBe(itemBytes('a', 'hello'));
            await expect(fake.sync.getBytesInUse(['a', 'missing'])).resolves.toBe(itemBytes('a', 'hello'));
            const viaCallback = await new Promise((resolve) => fake.sync.getBytesInUse(null, resolve));
            expect(viaCallback).toBe(expected);
        });
    });

    describe('get / set / remove / clear', () => {
        test('get supports null, string, array and defaults-object forms and omits missing keys', async () => {
            await fake.local.set({ a: 1, b: 'two' });
            await expect(fake.local.get(null)).resolves.toEqual({ a: 1, b: 'two' });
            await expect(fake.local.get('a')).resolves.toEqual({ a: 1 });
            const missing = await fake.local.get(['a', 'nope']);
            expect(missing).toEqual({ a: 1 });
            expect(Object.prototype.hasOwnProperty.call(missing, 'nope')).toBe(false);
            await expect(fake.local.get({ b: 'x', c: 'fallback' })).resolves.toEqual({ b: 'two', c: 'fallback' });
        });

        test('stores serialized copies and skips undefined values', async () => {
            const value = { nested: [1, 2] };
            await fake.local.set({ value, gone: undefined });
            value.nested.push(3);
            const read = await fake.local.get(null);
            expect(read).toEqual({ value: { nested: [1, 2] } });
            read.value.nested.push(99);
            await expect(fake.local.get('value')).resolves.toEqual({ value: { nested: [1, 2] } });
        });

        test('remove and clear delete keys', async () => {
            await fake.sync.set({ a: 1, b: 2, c: 3 });
            await fake.sync.remove('a');
            await fake.sync.remove(['b']);
            expect(fake.dump('sync')).toEqual({ c: 3 });
            await fake.sync.clear();
            expect(fake.dump('sync')).toEqual({});
        });

        test('callback form reports failures through chrome.runtime.lastError', async () => {
            const { chrome } = fake;
            const seen = await new Promise((resolve) => {
                const result = chrome.storage.sync.set(
                    { big: valueForItemSize('big', SYNC_QUOTAS.QUOTA_BYTES_PER_ITEM + 1) },
                    () => resolve(chrome.runtime.lastError)
                );
                expect(result).toBeUndefined();
            });
            expect(seen).toEqual({ message: 'Resource::kQuotaBytesPerItem quota exceeded' });
            expect(chrome.runtime.lastError).toBeUndefined();
        });

        test('install() sets globalThis.chrome', () => {
            const installed = installChromeStorageFake();
            expect(globalThis.chrome).toBe(installed.chrome);
            expect(globalThis.chrome.storage.sync.QUOTA_BYTES).toBe(102400);
        });
    });

    describe('sync quotas', () => {
        test('exposes Chrome quota constants on the sync area', () => {
            expect(fake.sync.QUOTA_BYTES).toBe(102400);
            expect(fake.sync.QUOTA_BYTES_PER_ITEM).toBe(8192);
            expect(fake.sync.MAX_ITEMS).toBe(512);
            expect(fake.sync.MAX_WRITE_OPERATIONS_PER_MINUTE).toBe(120);
            expect(fake.sync.MAX_WRITE_OPERATIONS_PER_HOUR).toBe(1800);
        });

        test('QUOTA_BYTES_PER_ITEM: 8192 bytes fits, 8193 is rejected', async () => {
            await expect(fake.sync.set({ k: valueForItemSize('k', 8192) })).resolves.toBeUndefined();
            await expect(fake.sync.set({ k: valueForItemSize('k', 8193) }))
                .rejects.toThrow('Resource::kQuotaBytesPerItem quota exceeded');
        });

        test('QUOTA_BYTES_PER_ITEM counts escaping of an already-JSON-encoded string', async () => {
            // Under 8000 characters as a raw string (what saveLinks checks), but
            // every quote is escaped again when Chrome serializes the value,
            // pushing the item past 8192 bytes.
            const links = [];
            while (JSON.stringify(links).length < 7500) {
                links.push({ name: `L${links.length}`, url: `https://e.com/${links.length}` });
            }
            const linksString = JSON.stringify(links);
            expect(linksString.length).toBeLessThan(8000);
            expect(itemBytes('links', linksString)).toBeGreaterThan(8192);
            await expect(fake.sync.set({ links: linksString }))
                .rejects.toThrow('Resource::kQuotaBytesPerItem quota exceeded');
        });

        test('QUOTA_BYTES: total over 102400 is rejected, replacements count net', async () => {
            const keys = Array.from({ length: 12 }, (_, i) => `key${String(i).padStart(2, '0')}`);
            for (const key of keys) {
                await fake.sync.set({ [key]: valueForItemSize(key, 8192) }); // 12 * 8192 = 98304
            }
            await expect(fake.sync.set({ extra: valueForItemSize('extra', 5000) }))
                .rejects.toThrow('Resource::kQuotaBytes quota exceeded');
            // Replacing an existing item frees its old bytes first.
            await expect(fake.sync.set({ key00: valueForItemSize('key00', 4000) })).resolves.toBeUndefined();
            await expect(fake.sync.set({ extra: valueForItemSize('extra', 5000) })).resolves.toBeUndefined();
            expect(fake.bytesInUse('sync')).toBeLessThanOrEqual(102400);
        });

        test('MAX_ITEMS: 512 items fit, the 513th is rejected', async () => {
            const items = {};
            for (let i = 0; i < 512; i++) items[`k${i}`] = i;
            await fake.sync.set(items);
            await expect(fake.sync.set({ k0: 'replace is fine' })).resolves.toBeUndefined();
            await expect(fake.sync.set({ one_more: 1 })).rejects.toThrow('Resource::kMaxItems quota exceeded');
        });

        test('a rejected write stores nothing (all-or-nothing)', async () => {
            await fake.sync.set({ keep: 'old' });
            await expect(fake.sync.set({ keep: 'new', big: valueForItemSize('big', 9000) }))
                .rejects.toThrow('kQuotaBytesPerItem');
            expect(fake.dump('sync')).toEqual({ keep: 'old' });
        });

        test('MAX_WRITE_OPERATIONS_PER_MINUTE: 120 writes per minute, then rejected until the window passes', async () => {
            for (let i = 0; i < 120; i++) await fake.sync.set({ n: i });
            await expect(fake.sync.set({ n: 'over' })).rejects.toThrow('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
            await expect(fake.sync.remove('n')).rejects.toThrow('MAX_WRITE_OPERATIONS_PER_MINUTE');
            await expect(fake.sync.clear()).rejects.toThrow('MAX_WRITE_OPERATIONS_PER_MINUTE');
            // Reads are not write operations.
            await expect(fake.sync.get('n')).resolves.toEqual({ n: 119 });
            clock += 60_000;
            await expect(fake.sync.set({ n: 'later' })).resolves.toBeUndefined();
        });

        test('MAX_WRITE_OPERATIONS_PER_HOUR: 1800 writes per hour', async () => {
            for (let batch = 0; batch < 15; batch++) {
                for (let i = 0; i < 120; i++) await fake.sync.set({ n: i });
                clock += 60_001;
            }
            await expect(fake.sync.set({ n: 'over' })).rejects.toThrow('This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.');
            clock += 60 * 60_000;
            await expect(fake.sync.set({ n: 'later' })).resolves.toBeUndefined();
        });
    });

    describe('local area', () => {
        test('has no per-item, item-count or write-rate limits', async () => {
            await expect(fake.local.set({ big: 'x'.repeat(50_000) })).resolves.toBeUndefined();
            for (let i = 0; i < 200; i++) await fake.local.set({ n: i });
            expect(fake.local.QUOTA_BYTES).toBe(10485760);
            expect(fake.local.QUOTA_BYTES_PER_ITEM).toBeUndefined();
        });

        test('still enforces its 10 MB total', async () => {
            await expect(fake.local.set({ huge: 'x'.repeat(10485760) })).rejects.toThrow('Resource::kQuotaBytes quota exceeded');
        });
    });

    describe('onChanged', () => {
        test('fires chrome.storage.onChanged with (changes, areaName) before the write resolves', async () => {
            const events = [];
            fake.chrome.storage.onChanged.addListener((changes, areaName) => events.push({ changes, areaName }));
            await fake.sync.set({ a: 1 });
            expect(events).toEqual([{ changes: { a: { newValue: 1 } }, areaName: 'sync' }]);
            await fake.sync.set({ a: 2 });
            expect(events[1]).toEqual({ changes: { a: { oldValue: 1, newValue: 2 } }, areaName: 'sync' });
            await fake.local.set({ b: true });
            expect(events[2].areaName).toBe('local');
        });

        test('reports only keys whose value changed, and nothing for a no-op write', async () => {
            const events = [];
            fake.chrome.storage.onChanged.addListener((changes) => events.push(changes));
            await fake.sync.set({ a: 1, b: 1 });
            await fake.sync.set({ a: 1, b: 2 });
            await fake.sync.set({ a: 1 });
            expect(events).toEqual([
                { a: { newValue: 1 }, b: { newValue: 1 } },
                { b: { oldValue: 1, newValue: 2 } }
            ]);
        });

        test('remove and clear report oldValue only', async () => {
            await fake.sync.set({ a: 1, b: 2 });
            const events = [];
            fake.chrome.storage.onChanged.addListener((changes) => events.push(changes));
            await fake.sync.remove(['a', 'missing']);
            await fake.sync.clear();
            expect(events).toEqual([{ a: { oldValue: 1 } }, { b: { oldValue: 2 } }]);
        });

        test('rejected writes and seeding fire no events', async () => {
            const listener = jest.fn();
            fake.chrome.storage.onChanged.addListener(listener);
            await expect(fake.sync.set({ big: valueForItemSize('big', 9000) })).rejects.toThrow();
            fake.seed('sync', { seeded: 1 });
            expect(listener).not.toHaveBeenCalled();
            expect(fake.dump('sync')).toEqual({ seeded: 1 });
        });

        test('per-area onChanged receives changes only for its area; removeListener works', async () => {
            const syncListener = jest.fn();
            fake.sync.onChanged.addListener(syncListener);
            await fake.local.set({ a: 1 });
            await fake.sync.set({ a: 1 });
            expect(syncListener).toHaveBeenCalledTimes(1);
            expect(syncListener).toHaveBeenCalledWith({ a: { newValue: 1 } });
            expect(fake.sync.onChanged.hasListener(syncListener)).toBe(true);
            fake.sync.onChanged.removeListener(syncListener);
            await fake.sync.set({ a: 2 });
            expect(syncListener).toHaveBeenCalledTimes(1);
        });
    });
});
