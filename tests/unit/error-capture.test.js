/**
 * Tests for the global error-capture feature (errorCapture.js).
 */
import {
    formatCapturedErrors,
    getCapturedErrors,
    clearCapturedErrors,
    initErrorCapture
} from '../../javascript/features/errorCapture.js';

describe('formatCapturedErrors', () => {
    it('reports when there is nothing captured', () => {
        expect(formatCapturedErrors([])).toContain('No errors captured');
    });

    it('formats an entry with context, type, count, and source', () => {
        const out = formatCapturedErrors([{
            context: 'newtab',
            type: 'csp-violation',
            message: 'Blocked by CSP (img-src): https://evil.example.com',
            count: 3,
            ts: 0,
            source: 'index.html:1'
        }]);
        expect(out).toContain('[newtab]');
        expect(out).toContain('csp-violation');
        expect(out).toContain('https://evil.example.com');
        expect(out).toContain('×3');
        expect(out).toContain('at index.html:1');
    });
});

describe('capture round-trip (mocked chrome.storage)', () => {
    let store;

    beforeEach(() => {
        store = {};
        global.chrome = {
            storage: {
                local: {
                    get: (key) => Promise.resolve(
                        typeof key === 'string' ? { [key]: store[key] } : { ...store }
                    ),
                    set: (obj) => { Object.assign(store, obj); return Promise.resolve(); }
                }
            },
            runtime: { getManifest: () => ({ version: 'test' }) }
        };
    });

    afterEach(() => {
        delete global.chrome;
    });

    it('returns an empty list when nothing is stored', async () => {
        expect(await getCapturedErrors()).toEqual([]);
    });

    it('captures console.error and collapses repeats into one entry with a count', async () => {
        initErrorCapture('test');
        console.error('CAPTURE_TEST boom');
        console.error('CAPTURE_TEST boom');
        // Allow the serialized write chain to flush.
        await new Promise((r) => setTimeout(r, 25));

        const list = await getCapturedErrors();
        const entry = list.find((e) => e.message.includes('CAPTURE_TEST boom'));
        expect(entry).toBeTruthy();
        expect(entry.type).toBe('console.error');
        expect(entry.count).toBe(2);
    });

    it('clears the log', async () => {
        store.codexErrorLog = [{ type: 'x', message: 'y', ts: 0 }];
        await clearCapturedErrors();
        expect(await getCapturedErrors()).toEqual([]);
    });
});
