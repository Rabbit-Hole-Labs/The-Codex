/**
 * Regression: a LOAD must never persist to chrome.storage.sync.
 *
 * On a fresh install the account's synced storage may not have downloaded yet,
 * so loadLinks() returns empty app-defaults. The newtab's initializeState()
 * used to commit those defaults with safeUpdateState(updates, { validate: true })
 * WITHOUT skipPersistence — which wrote links:[] straight back to
 * chrome.storage.sync and, via sync's last-writer-wins, clobbered the user's
 * real links on every device.
 *
 * These tests lock in the contract initializeState now relies on:
 *   - safeUpdateState(..., { skipPersistence: true }) must NOT touch storage.
 *   - safeUpdateState(...) (the default, used for real edits) MUST persist.
 */
import { jest } from '@jest/globals';

function installChromeMock() {
    const setMock = jest.fn(() => Promise.resolve());
    global.chrome = {
        storage: {
            sync: {
                set: setMock,
                get: jest.fn(() => Promise.resolve({})),
            },
            onChanged: { addListener: jest.fn(), removeListener: jest.fn() },
        },
    };
    return setMock;
}

describe('load must not clobber sync storage', () => {
    let setMock;

    beforeEach(() => {
        jest.resetModules();
        setMock = installChromeMock();
    });

    afterEach(() => {
        delete global.chrome;
    });

    test('loading state with skipPersistence does NOT write to chrome.storage.sync', async () => {
        const { safeUpdateState } = await import('../../javascript/core-systems/stateManager.js');

        // Simulate the fresh-install race: loadLinks() returned empty defaults.
        const result = safeUpdateState(
            { links: [], categories: ['Default'], theme: 'dark', colorTheme: 'default' },
            { validate: true, skipPersistence: true }
        );

        expect(result.success).toBe(true);
        // Give any fire-and-forget persistence a chance to run.
        await new Promise((r) => setTimeout(r, 0));
        expect(setMock).not.toHaveBeenCalled();
    });

    test('a real edit (no skipPersistence) DOES write links to chrome.storage.sync', async () => {
        const { safeUpdateState } = await import('../../javascript/core-systems/stateManager.js');

        const links = [{ id: 'a', name: 'Site', url: 'https://example.com/', category: 'Default' }];
        const result = safeUpdateState({ links }, { validate: false });

        expect(result.success).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        expect(setMock).toHaveBeenCalledTimes(1);
        // links persist JSON-encoded, and must carry the real data (never empty).
        const written = setMock.mock.calls[0][0];
        expect(typeof written.links).toBe('string');
        expect(JSON.parse(written.links)).toHaveLength(1);
    });
});
