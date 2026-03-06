/**
 * Comprehensive Sync Manager Tests
 * Tests the sync manager including conflict resolution, versioning, and error handling
 */

describe('Sync Manager', () => {
    let syncManager;
    let mockStorageLocal;
    let mockStorageSync;

    beforeEach(() => {
        // Mock Chrome storage
        mockStorageLocal = {
            get: jest.fn(),
            set: jest.fn(),
            remove: jest.fn(),
            clear: jest.fn()
        };

        mockStorageSync = {
            get: jest.fn(),
            set: jest.fn(),
            clear: jest.fn(),
            getBytesInUse: jest.fn((keys, callback) => callback(1000)),
            QUOTA_BYTES: 102400
        };

        global.chrome = {
            storage: {
                local: mockStorageLocal,
                sync: mockStorageSync
            }
        };
    });

    describe('Initialization', () => {
        test('should initialize with default values', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            expect(syncManager.syncInProgress).toBe(false);
            expect(syncManager.lastSyncTime).toBe(null);
            expect(syncManager.conflictResolutionStrategy).toBe('merge');
            expect(syncManager.syncQueue).toEqual([]);
        });

        test('should initialize sync status on construction', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockResolvedValue({
                lastSyncTime: 1234567890,
                syncStatus: 'synced'
            });

            await syncManager.initializeSyncStatus();

            expect(syncManager.lastSyncTime).toBe(1234567890);
        });

        test('should handle initialization errors gracefully', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockRejectedValue(new Error('Storage error'));

            // Should not throw
            await expect(syncManager.initializeSyncStatus()).resolves.toBeUndefined();
        });
    });

    describe('Device ID Management', () => {
        test('should generate and store device ID', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockResolvedValue({});
            mockStorageLocal.set.mockResolvedValue();

            const deviceId = await syncManager.getDeviceId();

            expect(deviceId).toMatch(/^device_\d+_[a-z0-9]+$/);
            expect(mockStorageLocal.set).toHaveBeenCalledWith({ deviceId });
        });

        test('should reuse existing device ID', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const existingId = 'device_123_abc123';
            mockStorageLocal.get.mockResolvedValue({ deviceId: existingId });

            const deviceId = await syncManager.getDeviceId();

            expect(deviceId).toBe(existingId);
            expect(mockStorageLocal.set).not.toHaveBeenCalled();
        });

        test('should handle device ID errors gracefully', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockRejectedValue(new Error('Storage error'));

            const deviceId = await syncManager.getDeviceId();

            expect(deviceId).toBe('unknown_device');
        });
    });

    describe('Sync Metadata', () => {
        test('should get sync metadata from both storages', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockResolvedValue({ syncMetadata: { version: 100, lastModified: 1000 } });
            mockStorageSync.get.mockResolvedValue({ syncMetadata: { version: 200, lastModified: 2000 } });

            const metadata = await syncManager.getSyncMetadata();

            expect(metadata.local.version).toBe(100);
            expect(metadata.remote.version).toBe(200);
        });

        test('should return default metadata when not found', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockResolvedValue({});
            mockStorageSync.get.mockResolvedValue({});

            const metadata = await syncManager.getSyncMetadata();

            expect(metadata.local.version).toBe(0);
            expect(metadata.remote.version).toBe(0);
        });

        test('should update sync metadata in both storages', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.set.mockResolvedValue();
            mockStorageSync.set.mockResolvedValue();
            mockStorageLocal.get.mockResolvedValue({ deviceId: 'device_test' });

            const result = await syncManager.updateSyncMetadata('both');

            expect(result.success).toBe(true);
            expect(mockStorageLocal.set).toHaveBeenCalled();
            expect(mockStorageSync.set).toHaveBeenCalled();
        });

        test('should handle quota exceeded error when updating metadata', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.set.mockResolvedValue();
            mockStorageSync.set.mockRejectedValue(new Error('QUOTA_BYTES exceeded'));
            mockStorageLocal.get.mockResolvedValue({ deviceId: 'device_test' });

            const result = await syncManager.updateSyncMetadata('both');

            expect(result.success).toBe(false);
            expect(result.error).toContain('QUOTA');
        });
    });

    describe('Conflict Resolution', () => {
        test('should resolve conflict with local strategy', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const localData = { links: '[{"url":"local.com"}]', categories: '["Local"]' };
            const syncData = { links: '[{"url":"remote.com"}]', categories: '["Remote"]' };
            const metadata = { local: { version: 1 }, remote: { version: 2 } };

            const result = await syncManager.resolveConflict(localData, syncData, metadata, 'local');

            expect(result.links).toBe(localData.links);
        });

        test('should resolve conflict with remote strategy', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const localData = { links: '[{"url":"local.com"}]', categories: '["Local"]' };
            const syncData = { links: '[{"url":"remote.com"}]', categories: '["Remote"]' };
            const metadata = { local: { version: 1 }, remote: { version: 2 } };

            const result = await syncManager.resolveConflict(localData, syncData, metadata, 'remote');

            expect(result.links).toBe(syncData.links);
        });

        test('should merge data with merge strategy', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const localData = { links: '[{"url":"local.com","name":"Local"}]', categories: '["Local"]' };
            const syncData = { links: '[{"url":"remote.com","name":"Remote"}]', categories: '["Remote"]' };
            const metadata = { local: { version: 1 }, remote: { version: 2 } };

            const result = await syncManager.mergeData(localData, syncData, metadata);

            const mergedLinks = JSON.parse(result.links);
            expect(mergedLinks.length).toBe(2);
        });

        test('should deduplicate links by URL when merging', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const localData = { links: '[{"url":"same.com","name":"Local Name"}]', categories: '["Local"]' };
            const syncData = { links: '[{"url":"same.com","name":"Remote Name"}]', categories: '["Remote"]' };
            const metadata = { local: { version: 1, lastModified: 1000 }, remote: { version: 2, lastModified: 3000 } };

            const result = await syncManager.mergeData(localData, syncData, metadata);

            const mergedLinks = JSON.parse(result.links);
            expect(mergedLinks.length).toBe(1);
            expect(mergedLinks[0].name).toBe('Remote Name'); // Remote wins due to newer timestamp
        });

        test('should merge categories and include Default', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const localData = { links: '[]', categories: '["Work", "Personal"]' };
            const syncData = { links: '[]', categories: '["Music", "Personal"]' };
            const metadata = { local: { version: 1 }, remote: { version: 2 } };

            const result = await syncManager.mergeData(localData, syncData, metadata);

            const mergedCategories = JSON.parse(result.categories);
            expect(mergedCategories).toContain('Default');
            expect(mergedCategories).toContain('Work');
            expect(mergedCategories).toContain('Personal');
            expect(mergedCategories).toContain('Music');
        });
    });

    describe('Data Validation', () => {
        test('should validate correct sync data structure', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const validData = {
                links: '[{"name":"Test","url":"https://example.com","category":"Test"}]',
                categories: '["Test"]'
            };

            const result = syncManager.validateSyncData(validData);

            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        test('should reject non-object data', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const invalidData = null;

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Data must be an object');
        });

        test('should reject invalid links JSON', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const invalidData = {
                links: 'not valid json',
                categories: '[]'
            };

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        test('should reject links that are not an array', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const invalidData = {
                links: '{"not":"an array"}',
                categories: '[]'
            };

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Links must be a valid JSON array');
        });

        test('should validate individual link properties', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const invalidData = {
                links: '[{"name":"","url":"","category":""}]',
                categories: '[]'
            };

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        test('should reject links with invalid URLs', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const invalidData = {
                links: '[{"name":"Test","url":"not-a-url","category":"Test"}]',
                categories: '[]'
            };

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('URL'))).toBe(true);
        });

        test('should reject categories that are not an array', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const invalidData = {
                links: '[]',
                categories: '{"not":"an array"}'
            };

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Categories must be a valid JSON array');
        });

        test('should reject empty category strings', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const invalidData = {
                links: '[]',
                categories: '["Work",""]'
            };

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('empty'))).toBe(true);
        });

        test('should reject categories exceeding max length', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const longCategory = 'A'.repeat(51);
            const invalidData = {
                links: '[]',
                categories: `["${longCategory}"]`
            };

            const result = syncManager.validateSyncData(invalidData);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('50'))).toBe(true);
        });

        test('should accept null values for links and categories', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const dataWithNulls = {
                links: null,
                categories: null
            };

            const result = syncManager.validateSyncData(dataWithNulls);

            expect(result.valid).toBe(true);
        });
    });

    describe('Sync Status', () => {
        test('should get sync status with statistics', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockResolvedValue({
                syncMetadata: { version: 100, lastModified: 1000 }
            });

            mockStorageSync.get.mockResolvedValue({
                syncMetadata: { version: 100, lastModified: 1000 }
            });

            // Override the getBytesInUse mock for this specific test
            mockStorageSync.getBytesInUse.mockImplementation((keys, callback) => callback(5000));

            syncManager.lastSyncTime = 1234567890;

            const status = await syncManager.getSyncStatus();

            expect(status.lastSyncTime).toBe(1234567890);
            expect(status.localVersion).toBe(100);
            expect(status.remoteVersion).toBe(100);
            expect(status.isInSync).toBe(true);
            expect(status.syncInProgress).toBe(false);
            expect(status.bytesInUse).toBe(5000);
            expect(status.quotaLimit).toBe(102400);
        });

        test('should calculate quota percentage correctly', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            mockStorageLocal.get.mockResolvedValue({});
            mockStorageSync.get.mockResolvedValue({});
            mockStorageSync.getBytesInUse.mockImplementation((keys, callback) => callback(51200)); // 50%

            const status = await syncManager.getSyncStatus();

            expect(status.quotaPercentage).toBe(50);
        });
    });

    describe('Sync Listeners', () => {
        test('should add and remove sync listeners', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const listener1 = jest.fn();
            const listener2 = jest.fn();

            const unsubscribe1 = syncManager.addSyncListener(listener1);
            const unsubscribe2 = syncManager.addSyncListener(listener2);

            expect(syncManager.syncListeners).toHaveLength(2);

            unsubscribe1();

            expect(syncManager.syncListeners).toHaveLength(1);
            expect(syncManager.syncListeners).toContain(listener2);
            expect(syncManager.syncListeners).not.toContain(listener1);

            unsubscribe2();

            expect(syncManager.syncListeners).toHaveLength(0);
        });

        test('should return unsubscribe function', async () => {
            const syncModule = await import('../javascript/core-systems/syncManager.js');
            syncManager = new syncModule.SyncManager();

            const listener = jest.fn();
            const unsubscribe = syncManager.addSyncListener(listener);

            expect(typeof unsubscribe).toBe('function');
        });
    });
});