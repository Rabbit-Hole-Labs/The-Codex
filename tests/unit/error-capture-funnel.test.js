/**
 * Tests for the single-owner write funnel in errorCapture.js.
 *
 * The service worker is the sole writer of codexErrorLog; page contexts
 * (newtab/manage/popup) forward their entries to it via chrome.runtime
 * .sendMessage, so concurrent read-modify-writes from independent execution
 * contexts can't clobber each other. These tests use fresh module instances
 * (jest.resetModules + dynamic import) so a single test file can stand up both
 * an owner and a non-owner context. They deliberately trigger capture via
 * console.error / direct message dispatch rather than window events, so stale
 * listeners left on the shared jsdom window by earlier tests never fire.
 */

const MODULE_PATH = '../../javascript/features/errorCapture.js';
const MESSAGE_TYPE = 'codex:error-capture';

// Pristine console captured before any instance wraps it (fresh jsdom realm).
const ORIG_ERROR = console.error;
const ORIG_WARN = console.warn;

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function restoreConsole() {
    console.error = ORIG_ERROR;
    console.warn = ORIG_WARN;
}

function storageMock(store) {
    return {
        local: {
            get: (key) => Promise.resolve(
                typeof key === 'string' ? { [key]: store[key] } : { ...store }
            ),
            set: (obj) => { Object.assign(store, obj); return Promise.resolve(); }
        }
    };
}

afterEach(() => {
    delete global.chrome;
    restoreConsole();
});

describe('single-owner write funnel', () => {
    it('a page context forwards a record to the owner and never writes storage itself', async () => {
        const store = {};
        const sent = [];
        global.chrome = {
            storage: storageMock(store),
            runtime: {
                getManifest: () => ({ version: 'test' }),
                sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); }
            }
        };
        restoreConsole();
        jest.resetModules();
        const mod = await import(MODULE_PATH);
        mod.initErrorCapture('newtab'); // non-owner; wraps a pristine console

        console.error('FUNNEL_SEND boom');
        await flush();

        const rec = sent.find((m) => m.type === MESSAGE_TYPE && m.kind === 'record');
        expect(rec).toBeTruthy();
        expect(rec.entry.type).toBe('console.error');
        expect(rec.entry.message).toContain('FUNNEL_SEND boom');
        expect(rec.entry.context).toBe('newtab');
        // The page must not touch storage directly — that's the whole point.
        expect(store.codexErrorLog).toBeUndefined();
    });

    it('the owner applies a forwarded record message to storage and acks asynchronously', async () => {
        const store = {};
        const listeners = [];
        global.chrome = {
            storage: storageMock(store),
            runtime: {
                getManifest: () => ({ version: 'test' }),
                onMessage: { addListener: (fn) => listeners.push(fn) }
            }
        };
        restoreConsole();
        jest.resetModules();
        const mod = await import(MODULE_PATH);
        mod.initErrorCapture('service-worker'); // owner; registers onMessage
        expect(listeners).toHaveLength(1);

        const entry = { context: 'newtab', type: 'console.error', message: 'FWD_APPLY hi', ts: 1 };
        let ack;
        const keptOpen = listeners[0](
            { type: MESSAGE_TYPE, kind: 'record', entry },
            {},
            (resp) => { ack = resp; }
        );
        // Must keep the message channel open for the async ack after the write.
        expect(keptOpen).toBe(true);
        await flush();

        const got = (await mod.getCapturedErrors()).find((e) => e.message === 'FWD_APPLY hi');
        expect(got).toBeTruthy();
        expect(got.context).toBe('newtab');
        expect(got.count).toBe(1);
        expect(ack).toEqual({ ok: true });
    });

    it('ignores messages that are not ours', async () => {
        const store = {};
        const listeners = [];
        global.chrome = {
            storage: storageMock(store),
            runtime: {
                getManifest: () => ({ version: 'test' }),
                onMessage: { addListener: (fn) => listeners.push(fn) }
            }
        };
        restoreConsole();
        jest.resetModules();
        const mod = await import(MODULE_PATH);
        mod.initErrorCapture('service-worker');

        const ret = listeners[0]({ type: 'something-else', foo: 1 }, {}, () => {});
        expect(ret).toBeUndefined(); // not handled, channel not held open
        await flush();
        expect(await mod.getCapturedErrors()).toEqual([]);
    });

    it('a page clear routes through the owner instead of racing a direct write', async () => {
        const store = { codexErrorLog: [{ type: 'x', message: 'y', ts: 0, count: 1 }] };
        const listeners = [];
        global.chrome = {
            storage: storageMock(store),
            runtime: {
                getManifest: () => ({ version: 'test' }),
                onMessage: { addListener: (fn) => listeners.push(fn) },
                // Model MV3 sendMessage: dispatch to listeners; resolve when a
                // listener returns true and later calls sendResponse.
                sendMessage: (msg) => new Promise((resolve) => {
                    let keptOpen = false;
                    let settled = false;
                    const sendResponse = (resp) => { settled = true; resolve(resp); };
                    for (const listener of listeners) {
                        if (listener(msg, {}, sendResponse) === true) keptOpen = true;
                    }
                    if (!keptOpen && !settled) resolve(undefined);
                })
            }
        };
        restoreConsole();

        jest.resetModules();
        const owner = await import(MODULE_PATH);
        owner.initErrorCapture('service-worker'); // registers onMessage on the shared mock

        jest.resetModules();
        const page = await import(MODULE_PATH);
        page.initErrorCapture('newtab'); // non-owner, shares global.chrome

        await page.clearCapturedErrors();
        expect(store.codexErrorLog).toEqual([]);
    });

    it('falls back to a direct clear when messaging is unavailable', async () => {
        const store = { codexErrorLog: [{ type: 'x', message: 'y', ts: 0, count: 1 }] };
        global.chrome = {
            storage: storageMock(store),
            runtime: { getManifest: () => ({ version: 'test' }) } // no sendMessage
        };
        restoreConsole();
        jest.resetModules();
        const page = await import(MODULE_PATH);
        page.initErrorCapture('newtab');

        await page.clearCapturedErrors();
        expect(store.codexErrorLog).toEqual([]);
    });
});
