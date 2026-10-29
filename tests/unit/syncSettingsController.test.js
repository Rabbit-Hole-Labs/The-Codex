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
        const mod = await import('../../javascript/features/syncSettingsController.js');
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

    describe('updateSyncStatus rendering', () => {
        let syncManager;

        function statusElements() {
            const make = () => document.createElement('span');
            return {
                currentStatus: make(),
                lastSyncTime: make(),
                localVersion: make(),
                remoteVersion: make()
            };
        }

        async function render(status, elements = statusElements()) {
            ({ syncManager } = await import('../../javascript/core-systems/syncManager.js'));
            jest.spyOn(syncManager, 'getSyncStatus').mockResolvedValue(status);
            const controller = new SyncSettingsController();
            controller.elements = elements;
            const calls = [];
            jest.spyOn(controller, 'updateStorageDisplay').mockImplementation(s => calls.push(['storage', s]));
            jest.spyOn(controller, 'updateDiagnostics').mockImplementation(async () => { calls.push(['diagnostics']); });
            jest.spyOn(controller, 'formatTime').mockImplementation(t => `fmt:${t}`);
            await controller.updateSyncStatus();
            return { controller, elements, calls };
        }

        afterEach(() => jest.restoreAllMocks());

        test('never-synced profile shows "Not synced yet" in orange', async () => {
            const status = { lastSyncTime: 0, localVersion: 0, remoteVersion: 0, hasData: false, isInSync: true };
            const { elements, calls } = await render(status);
            expect(elements.currentStatus.textContent).toBe('Not synced yet');
            expect(elements.currentStatus.style.color).toBe('rgb(255, 152, 0)');
            expect(elements.lastSyncTime.textContent).toBe('Never');
            expect(elements.localVersion.textContent).toBe('-');
            expect(elements.remoteVersion.textContent).toBe('-');
            expect(calls).toEqual([['storage', status], ['diagnostics']]);
        });

        test('profile with only hasData counts as synced', async () => {
            const { elements } = await render({ hasData: true, isInSync: true });
            expect(elements.currentStatus.textContent).toBe('In Sync');
            expect(elements.currentStatus.style.color).toBe('rgb(76, 175, 80)');
        });

        test.each([
            ['lastSyncTime', { lastSyncTime: 5 }],
            ['localVersion', { localVersion: 5 }],
            ['remoteVersion', { remoteVersion: 5 }]
        ])('a recorded %s alone is not "Not synced yet"', async (_name, partial) => {
            const { elements } = await render({ ...partial, isInSync: false });
            expect(elements.currentStatus.textContent).toBe('Out of Sync');
            expect(elements.currentStatus.style.color).toBe('rgb(255, 152, 0)');
        });

        test('synced status renders formatted times and versions', async () => {
            const status = { lastSyncTime: 1700000000000, localVersion: 1700000001000, remoteVersion: 1700000002000, isInSync: true };
            const { elements } = await render(status);
            expect(elements.currentStatus.textContent).toBe('In Sync');
            expect(elements.lastSyncTime.textContent).toBe('fmt:1700000000000');
            expect(elements.localVersion.textContent).toBe(new Date(1700000001000).toLocaleString());
            expect(elements.remoteVersion.textContent).toBe(new Date(1700000002000).toLocaleString());
        });

        test('missing elements are skipped without error', async () => {
            const status = { lastSyncTime: 1, isInSync: true };
            const { controller, calls } = await render(status, {});
            expect(calls).toEqual([['storage', status], ['diagnostics']]);
            expect(controller.syncLog).toEqual([]);
        });

        test('a failing status read is logged and nothing renders', async () => {
            ({ syncManager } = await import('../../javascript/core-systems/syncManager.js'));
            jest.spyOn(syncManager, 'getSyncStatus').mockRejectedValue(new Error('boom'));
            const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const controller = new SyncSettingsController();
            const elements = statusElements();
            controller.elements = elements;
            const storage = jest.spyOn(controller, 'updateStorageDisplay');
            await controller.updateSyncStatus();
            expect(elements.currentStatus.textContent).toBe('');
            expect(storage).not.toHaveBeenCalled();
            expect(errSpy).toHaveBeenCalledWith('Failed to update sync status:', expect.any(Error));
            expect(controller.syncLog.map(e => [e.type, e.message])).toEqual([['error', 'Failed to update status: boom']]);
        });
    });
});
