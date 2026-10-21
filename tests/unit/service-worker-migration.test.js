/**
 * The service worker rewrites a pre-7.0.0.24 colorTheme ('ocean', 'theme-*', …)
 * to 'default' once, on extension update. It must write ONLY that key, ONLY for
 * a known legacy value, and never when the value is absent or empty — an empty
 * read can mean sync hasn't downloaded yet, and writing then would clobber the
 * user's real setting on every device.
 */
import { jest } from '@jest/globals';

async function loadWorker(syncStore) {
    jest.resetModules();
    let onInstalled;
    const sync = {
        get: jest.fn((keys) => {
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            list.forEach(key => { if (key in syncStore) out[key] = syncStore[key]; });
            return Promise.resolve(out);
        }),
        set: jest.fn(() => Promise.resolve()),
    };
    global.chrome = {
        storage: {
            sync,
            local: { get: jest.fn(() => Promise.resolve({})), set: jest.fn(() => Promise.resolve()) },
            onChanged: { addListener: jest.fn() },
        },
        runtime: {
            onInstalled: { addListener: jest.fn(fn => { onInstalled = fn; }) },
            onStartup: { addListener: jest.fn() },
            onMessage: { addListener: jest.fn() },
            sendMessage: jest.fn(),
        },
    };
    await import('../../javascript/background/service-worker.js');
    const fire = async (details) => {
        onInstalled(details);
        await new Promise(r => setTimeout(r, 0));
    };
    return { sync, fire };
}

const colorThemeWrites = (sync) =>
    sync.set.mock.calls.filter(([arg]) => 'colorTheme' in arg).map(([arg]) => arg);

describe('service worker: legacy colorTheme migration', () => {
    afterEach(() => {
        delete global.chrome;
    });

    test.each(['ocean', 'aurora', 'theme-dark-sapphire'])('rewrites legacy "%s" to default on update', async (legacy) => {
        const { sync, fire } = await loadWorker({ colorTheme: legacy });
        await fire({ reason: 'update' });
        expect(colorThemeWrites(sync)).toEqual([{ colorTheme: 'default' }]);
    });

    test.each([
        ['absent', {}],
        ['empty', { colorTheme: '' }],
        ['a current accent', { colorTheme: 'teal' }],
        ['an unknown non-legacy value', { colorTheme: 'something-new' }],
    ])('never writes when the stored value is %s', async (_label, store) => {
        const { sync, fire } = await loadWorker(store);
        await fire({ reason: 'update' });
        expect(colorThemeWrites(sync)).toEqual([]);
    });

    test('does not run on a fresh install', async () => {
        const { sync, fire } = await loadWorker({ colorTheme: 'ocean' });
        await fire({ reason: 'install' });
        expect(colorThemeWrites(sync)).toEqual([]);
    });
});
