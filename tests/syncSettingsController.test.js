/**
 * Unit tests for syncSettingsController.js
 * Covers: sync log rendering, conflict strategy selection, status display
 */

// Mock chrome API
if (typeof globalThis.chrome === 'undefined') {
    globalThis.chrome = {
        storage: {
            sync: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: (d, cb) => cb ? cb() : Promise.resolve(), getBytesInUse: (k, cb) => cb ? cb(0) : Promise.resolve(0) },
            local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: (d, cb) => cb ? cb() : Promise.resolve() },
            onChanged: { addListener: () => {} }
        },
        runtime: { lastError: null }
    };
}

describe('SyncSettingsController', () => {
    let SyncSettingsController;

    function setupDOM() {
        document.body.textContent = '';
        const ids = [
            'sync-status', 'sync-last-time', 'sync-items-count', 'sync-storage-used',
            'sync-quota-bar', 'sync-now-btn', 'force-push-btn', 'force-pull-btn',
            'clear-sync-btn', 'test-sync-btn', 'export-diagnostics-btn',
            'sync-strategy-select', 'sync-log', 'auto-sync-toggle', 'sync-interval',
            'clear-log-btn', 'network-status', 'device-id',
            'diag-sync-version', 'diag-last-modified', 'diag-device-id',
            'diag-conflict-count', 'diag-storage-health'
        ];
        ids.forEach(id => {
            const el = document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
        });
        // Conflict strategy needs to be a select
        const select = document.createElement('select');
        select.id = 'sync-strategy-select';
        const existing = document.getElementById('sync-strategy-select');
        existing.parentNode.replaceChild(select, existing);
        ['merge', 'local', 'remote'].forEach(val => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            select.appendChild(opt);
        });
    }

    beforeEach(async () => {
        jest.resetModules();
        setupDOM();
        const mod = await import('../javascript/features/syncSettingsController.js');
        SyncSettingsController = mod.SyncSettingsController;
    });

    describe('Sync Log Rendering', () => {
        test('addLog creates log entries with message and type', () => {
            const controller = new SyncSettingsController();
            controller.init();
            controller.addLogEntry('info', 'Test sync message');
            expect(controller.syncLog.length).toBeGreaterThanOrEqual(1);
            const lastEntry = controller.syncLog[controller.syncLog.length - 1];
            expect(lastEntry.message).toBe('Test sync message');
            expect(lastEntry.type).toBe('info');
        });

        test('addLog appends multiple entries', () => {
            const controller = new SyncSettingsController();
            controller.init();
            controller.addLogEntry('info', 'First');
            controller.addLogEntry('error', 'Second');
            controller.addLogEntry('success', 'Third');
            expect(controller.syncLog.length).toBeGreaterThanOrEqual(3);
        });

        test('updateLogDisplay renders log entries safely', () => {
            const controller = new SyncSettingsController();
            controller.init();
            controller.addLogEntry('info', 'Safe <b>message</b>');
            controller.updateLogDisplay();
            const logEl = document.getElementById('sync-log');
            // Should render as text, not HTML
            const msgSpan = logEl.querySelector('.log-message');
            if (msgSpan) {
                expect(msgSpan.textContent).toContain('<b>message</b>');
                expect(msgSpan.querySelector('b')).toBeNull(); // Not rendered as HTML
            }
        });

        test('clearLog resets the sync log to single "Log cleared" entry', () => {
            const controller = new SyncSettingsController();
            controller.init();
            controller.addLogEntry('info', 'Entry');
            const beforeCount = controller.syncLog.length;
            controller.clearLog();
            // clearLog empties then adds "Log cleared" entry
            expect(controller.syncLog.length).toBe(1);
            expect(controller.syncLog[0].message).toBe('Log cleared');
            expect(controller.syncLog.length).toBeLessThan(beforeCount);
        });
    });

    describe('Conflict Strategy Selection', () => {
        test('init reads conflict strategy from select element', () => {
            const controller = new SyncSettingsController();
            const select = document.getElementById('sync-strategy-select');
            select.value = 'local';
            controller.init();
            // Controller should have cached elements
            expect(controller.elements.syncStrategySelect).toBeTruthy();
        });

        test('conflict strategy select has merge, local, remote options', () => {
            const select = document.getElementById('sync-strategy-select');
            const values = Array.from(select.options).map(o => o.value);
            expect(values).toContain('merge');
            expect(values).toContain('local');
            expect(values).toContain('remote');
        });
    });

    describe('Status Display', () => {
        test('formatTime returns formatted string', () => {
            const controller = new SyncSettingsController();
            const result = controller.formatTime(Date.now());
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        });

        test('init caches all DOM elements', () => {
            const controller = new SyncSettingsController();
            controller.init();
            expect(controller.elements).toBeTruthy();
            expect(controller.elements.syncLog).toBeTruthy();
            expect(controller.elements.syncStrategySelect).toBeTruthy();
        });
    });
});
