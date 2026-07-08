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

// Init as the 'service-worker' context so this suite exercises the OWNER path:
// the owner writes to chrome.storage.local directly (page contexts instead
// forward to it — that funnel is covered in error-capture-funnel.test.js).
describe('owner-context capture (mocked chrome.storage)', () => {
    let store;

    // The serialized write chain and all storage operations resolve on the
    // microtask queue, so a single macrotask tick drains every pending write.
    const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

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
            runtime: {
                getManifest: () => ({ version: 'test' }),
                onMessage: { addListener: () => {} }
            }
        };
    });

    afterEach(() => {
        delete global.chrome;
    });

    it('returns an empty list when nothing is stored', async () => {
        expect(await getCapturedErrors()).toEqual([]);
    });

    it('captures console.error and collapses repeats into one entry with a count', async () => {
        initErrorCapture('service-worker');
        console.error('CAPTURE_TEST boom');
        console.error('CAPTURE_TEST boom');
        await flush();

        const list = await getCapturedErrors();
        const entry = list.find((e) => e.message.includes('CAPTURE_TEST boom'));
        expect(entry).toBeTruthy();
        expect(entry.type).toBe('console.error');
        expect(entry.count).toBe(2);
    });

    it('captures an uncaught error event with source and stack', async () => {
        initErrorCapture('service-worker');
        window.dispatchEvent(new ErrorEvent('error', {
            message: 'UNCAUGHT_TEST kaboom',
            filename: 'chrome-extension://abc/script.js',
            lineno: 42,
            colno: 7,
            error: new Error('UNCAUGHT_TEST kaboom')
        }));
        await flush();

        const entry = (await getCapturedErrors())
            .find((e) => e.type === 'uncaught-error' && e.message.includes('UNCAUGHT_TEST'));
        expect(entry).toBeTruthy();
        expect(entry.source).toContain('script.js:42:7');
        expect(entry.stack).toContain('UNCAUGHT_TEST');
    });

    it('captures an unhandled promise rejection', async () => {
        initErrorCapture('service-worker');
        window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
            reason: new Error('REJECT_TEST nope')
        }));
        await flush();

        const entry = (await getCapturedErrors()).find((e) => e.type === 'unhandled-rejection');
        expect(entry).toBeTruthy();
        expect(entry.message).toContain('REJECT_TEST nope');
    });

    it('captures a CSP (securitypolicyviolation) event', async () => {
        initErrorCapture('service-worker');
        document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), {
            violatedDirective: 'img-src',
            blockedURI: 'https://evil.example.com/tracker.gif',
            sourceFile: 'index.html',
            lineNumber: 5
        }));
        await flush();

        const entry = (await getCapturedErrors()).find((e) => e.type === 'csp-violation');
        expect(entry).toBeTruthy();
        expect(entry.directive).toBe('img-src');
        expect(entry.blockedURI).toContain('evil.example.com');
        expect(entry.message).toContain('Blocked by CSP (img-src)');
    });

    it('collapses CSP violations that differ only by query/fragment into one entry', async () => {
        initErrorCapture('service-worker');
        const fire = (uri) => document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), {
            violatedDirective: 'img-src',
            blockedURI: uri,
            sourceFile: 'index.html',
            lineNumber: 5
        }));
        // Same origin + path, different cache-buster query — must dedup to one.
        fire('https://cdn.example.com/logo.webp?v=1&t=111');
        fire('https://cdn.example.com/logo.webp?v=2&t=222');
        await flush();

        const matches = (await getCapturedErrors())
            .filter((e) => e.type === 'csp-violation' && (e.blockedURI || '').includes('cdn.example.com'));
        expect(matches).toHaveLength(1);
        expect(matches[0].count).toBe(2);
    });

    it('caps the ring buffer at 200 entries, evicting the oldest', async () => {
        initErrorCapture('service-worker');
        const TOTAL = 250;
        for (let i = 0; i < TOTAL; i++) {
            // Distinct message per entry → distinct signature → no dedup.
            window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
                reason: new Error(`RING_TEST #${i}`)
            }));
        }
        await flush(60);

        const list = await getCapturedErrors();
        expect(list).toHaveLength(200);
        const messages = list.map((e) => e.message);
        // Buffer keeps the last 200 (entries 50..249); the earliest are gone.
        expect(messages.some((m) => m.includes('RING_TEST #0'))).toBe(false);
        expect(messages.some((m) => m.includes('RING_TEST #49'))).toBe(false);
        expect(messages.some((m) => m.includes('RING_TEST #50'))).toBe(true);
        expect(messages.some((m) => m.includes('RING_TEST #249'))).toBe(true);
    });

    it('clears the log', async () => {
        store.codexErrorLog = [{ type: 'x', message: 'y', ts: 0 }];
        await clearCapturedErrors();
        expect(await getCapturedErrors()).toEqual([]);
    });
});
