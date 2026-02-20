// Advanced Sync Manager for The Codex
// Handles conflict resolution, versioning, and improved sync strategies

export class SyncManager {
    constructor() {
        this.syncInProgress = false;
        this.lastSyncTime = null;
        this.syncListeners = [];
        this.conflictResolutionStrategy = 'merge'; // 'merge', 'local', 'remote'
        this.syncDebounceTimeout = null;
        this.syncQueue = [];

        // Initialize sync status
        this.initializeSyncStatus();
    }

    // Initialize sync status and listeners
    async initializeSyncStatus() {
        try {
            const status = await chrome.storage.local.get(['lastSyncTime', 'syncStatus']);
            this.lastSyncTime = status.lastSyncTime || null;
            this.notifyListeners('initialized', status.syncStatus || 'unknown');
        } catch (error) {
            console.error('Failed to initialize sync status:', error);
        }
    }

    // Register a listener for sync events
    addSyncListener(callback) {
        this.syncListeners.push(callback);
        return () => {
            this.syncListeners = this.syncListeners.filter(cb => cb !== callback);
        };
    }

    // Notify all listeners of sync status changes
    notifyListeners(event, data) {
        this.syncListeners.forEach(callback => {
            try {
                callback(event, data);
            } catch (error) {
                console.error('Sync listener error:', error);
            }
        });
    }

    // Get sync metadata for data versioning
    async getSyncMetadata() {
        try {
            const local = await chrome.storage.local.get(['syncMetadata']);
            const sync = await chrome.storage.sync.get(['syncMetadata']);

            return {
                local: local.syncMetadata || { version: 0, lastModified: 0 },
                remote: sync.syncMetadata || { version: 0, lastModified: 0 }
            };
        } catch (error) {
            console.error('Failed to get sync metadata:', error);
            return {
                local: { version: 0, lastModified: 0 },
                remote: { version: 0, lastModified: 0 }
            };
        }
    }

    // Update sync metadata with enhanced error handling
    async updateSyncMetadata(storage = 'both') {
        const metadata = {
            version: Date.now(),
            lastModified: Date.now(),
            deviceId: await this.getDeviceId()
        };

        try {
            if (storage === 'local' || storage === 'both') {
                await chrome.storage.local.set({ syncMetadata: metadata });
            }
            if (storage === 'sync' || storage === 'both') {
                await chrome.storage.sync.set({ syncMetadata: metadata });
            }

            console.log('Sync metadata updated successfully');
            return { success: true, metadata };
        } catch (error) {
            console.error('Failed to update sync metadata:', error);

            // Handle specific Chrome storage errors
            if (error.message?.includes('QUOTA_BYTES')) {
                this.notifyListeners('error', {
                    type: 'quota_exceeded',
                    message: 'Storage quota exceeded. Cannot update sync metadata.',
                    details: error.message
                });
            } else if (error.message?.includes('MAX_ITEMS')) {
                this.notifyListeners('error', {
                    type: 'max_items',
                    message: 'Maximum storage items reached.',
                    details: error.message
                });
            } else {
                this.notifyListeners('error', {
                    type: 'storage_error',
                    message: 'Failed to update sync metadata.',
                    details: error.message
                });
            }

            return { success: false, error: error.message };
        }
    }

    // Get or create device ID for conflict resolution
    async getDeviceId() {
        try {
            const { deviceId } = await chrome.storage.local.get(['deviceId']);
            if (deviceId) return deviceId;

            const newId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            await chrome.storage.local.set({ deviceId: newId });
            return newId;
        } catch (error) {
            console.error('Failed to get device ID:', error);
            return 'unknown_device';
        }
    }

    // Main sync function with conflict resolution and comprehensive error handling
    async syncData(forceStrategy = null) {
        if (this.syncInProgress) {
            console.log('Sync already in progress, queueing request');
            return new Promise((resolve) => {
                this.syncQueue.push(resolve);
            });
        }

        this.syncInProgress = true;
        this.notifyListeners('syncStart', { time: Date.now() });

        try {
            console.log('Starting sync operation...');

            // Validate Chrome storage availability
            if (!chrome.storage || !chrome.storage.local || !chrome.storage.sync) {
                throw new Error('Chrome storage API not available');
            }

            // Get current data from both storages with error handling
            let localData, syncData;

            try {
                localData = await chrome.storage.local.get(['links', 'categories']);
                console.log('Local data retrieved:', localData);
            } catch (localError) {
                console.error('Failed to retrieve local data:', localError);
                this.notifyListeners('syncError', {
                    type: 'local_storage_error',
                    message: 'Failed to read local storage data.',
                    details: localError.message
                });
                throw localError;
            }

            try {
                syncData = await chrome.storage.sync.get(['links', 'categories']);
                console.log('Sync data retrieved:', syncData);
            } catch (syncError) {
                console.error('Failed to retrieve sync data:', syncError);

                // Handle specific sync storage errors
                if (syncError.message?.includes('QUOTA_BYTES')) {
                    this.notifyListeners('syncError', {
                        type: 'quota_exceeded',
                        message: 'Chrome sync storage quota exceeded.',
                        details: 'You have reached the maximum storage limit for sync data.',
                        recommendation: 'Please remove some links or categories to free up space.'
                    });
                } else if (syncError.message?.includes('MAX_ITEMS')) {
                    this.notifyListeners('syncError', {
                        type: 'max_items_exceeded',
                        message: 'Maximum number of sync items reached.',
                        details: 'Chrome sync has a limit on the number of items that can be stored.',
                        recommendation: 'Consider consolidating your data or removing unused items.'
                    });
                } else if (syncError.message?.includes('Network')) {
                    this.notifyListeners('syncError', {
                        type: 'network_error',
                        message: 'Network error while accessing sync storage.',
                        details: 'Please check your internet connection and try again.',
                        recommendation: 'Sync will resume automatically when the connection is restored.'
                    });
                } else {
                    this.notifyListeners('syncError', {
                        type: 'sync_storage_error',
                        message: 'Failed to access Chrome sync storage.',
                        details: syncError.message,
                        recommendation: 'Sync will retry automatically.'
                    });
                }

                // For sync errors, we can still work with local data
                console.warn('Sync storage unavailable, working with local data only');
                syncData = { links: '[]', categories: '[]' }; // Empty sync data
            }

            // Get metadata for versioning
            const metadata = await this.getSyncMetadata();

            // Determine sync strategy
            const strategy = forceStrategy || this.conflictResolutionStrategy;

            let resolvedData;
            if (metadata.local.version === metadata.remote.version) {
                // No conflict, data is in sync
                console.log('No conflict detected, using local data');
                resolvedData = localData;
            } else {
                // Conflict detected, resolve based on strategy
                console.log('Conflict detected, resolving with strategy:', strategy);
                resolvedData = await this.resolveConflict(localData, syncData, metadata, strategy);
            }

            // Validate resolved data before saving with enhanced error handling
            const validationResult = this.validateSyncData(resolvedData);
            if (!validationResult.valid) {
                const validationError = new Error(`Data validation failed: ${validationResult.errors.join(', ')}`);
                console.error('Sync data validation failed:', {
                    errors: validationResult.errors,
                    data: resolvedData
                });
                this.notifyListeners('syncError', {
                    type: 'validation_error',
                    message: 'Sync data validation failed',
                    details: validationResult.errors,
                    recommendation: 'Please check your data and try again. If the problem persists, contact support.'
                });
                throw validationError;
            }

            // Save resolved data to both storages
            await this.saveResolvedData(resolvedData);

            // Update sync metadata
            const metadataResult = await this.updateSyncMetadata('both');
            if (!metadataResult.success) {
                console.warn('Failed to update sync metadata:', metadataResult.error);
            }

            // Update last sync time
            this.lastSyncTime = Date.now();
            await chrome.storage.local.set({ lastSyncTime: this.lastSyncTime });

            const syncedItemsCount = JSON.parse(resolvedData.links || '[]').length;

            this.notifyListeners('syncComplete', {
                time: this.lastSyncTime,
                itemsSynced: syncedItemsCount,
                strategy: strategy,
                metadata: metadata
            });

            console.log(`Sync completed successfully. Synced ${syncedItemsCount} items.`);

            // Process queued sync requests
            while (this.syncQueue.length > 0) {
                const resolve = this.syncQueue.shift();
                resolve({ success: true, time: this.lastSyncTime, itemsSynced: syncedItemsCount });
            }

            return { success: true, time: this.lastSyncTime, itemsSynced: syncedItemsCount };

        } catch (error) {
            console.error('Sync failed:', error);

            // Provide detailed error information to listeners
            this.notifyListeners('syncError', {
                type: 'sync_failed',
                message: 'Synchronization failed due to an unexpected error.',
                details: error.message,
                timestamp: Date.now(),
                recommendation: 'Please try again later. If the problem persists, check your internet connection or contact support.'
            });

            // Process queued sync requests with error
            while (this.syncQueue.length > 0) {
                const resolve = this.syncQueue.shift();
                resolve({ success: false, error: error.message, timestamp: Date.now() });
            }

            return { success: false, error: error.message, timestamp: Date.now() };
        } finally {
            this.syncInProgress = false;
            console.log('Sync operation completed');
        }
    }

    // Resolve conflicts between local and remote data
    async resolveConflict(localData, syncData, metadata, strategy) {
        console.log(`Resolving conflict with strategy: ${strategy}`);

        switch (strategy) {
            case 'local':
                // Local data wins
                return localData;

            case 'remote':
                // Remote data wins
                return syncData;

            case 'merge':
            default:
                // Merge both datasets
                return this.mergeData(localData, syncData, metadata);
        }
    }

    // Merge local and remote data intelligently
    mergeData(localData, syncData, metadata) {
        const mergedData = {};

        // Merge links
        const localLinks = JSON.parse(localData.links || '[]');
        const syncLinks = JSON.parse(syncData.links || '[]');

        // Create a map of links by URL for deduplication
        const linkMap = new Map();

        // Add local links
        localLinks.forEach(link => {
            linkMap.set(link.url, { ...link, source: 'local' });
        });

        // Add or update with sync links
        syncLinks.forEach(link => {
            const existing = linkMap.get(link.url);
            if (!existing) {
                linkMap.set(link.url, { ...link, source: 'sync' });
            } else {
                // If both have the same link, keep the most recently modified
                // Since we don't have per-link timestamps, we'll prefer the remote version
                // in a real implementation, you'd want to track modification times per link
                if (metadata.remote.lastModified > metadata.local.lastModified) {
                    linkMap.set(link.url, { ...link, source: 'sync' });
                }
            }
        });

        mergedData.links = JSON.stringify(Array.from(linkMap.values()).map(({ source, ...link }) => link));

        // Merge categories
        const localCategories = JSON.parse(localData.categories || '["Default"]');
        const syncCategories = JSON.parse(syncData.categories || '["Default"]');
        const mergedCategories = [...new Set([...localCategories, ...syncCategories])];

        // Ensure Default category exists
        if (!mergedCategories.includes('Default')) {
            mergedCategories.unshift('Default');
        }

        mergedData.categories = JSON.stringify(mergedCategories);

        return mergedData;
    }

    // Save resolved data to both storages with enhanced error handling
    async saveResolvedData(data) {
        try {
            console.log('Saving resolved data...', {
                hasLinks: !!data.links,
                hasCategories: !!data.categories,
                linksType: typeof data.links,
                categoriesType: typeof data.categories
            });

            // Validate data before saving with detailed validation
            if (!data.links && !data.categories) {
                const validationError = new Error('Invalid resolved data structure: both links and categories are missing');
                console.error('Sync save validation failed: missing required data');
                this.notifyListeners('syncError', {
                    type: 'data_validation',
                    message: 'Sync data validation failed',
                    details: 'Both links and categories data are missing',
                    recommendation: 'Please check your data and try again.'
                });
                throw validationError;
            }

            // Save to local storage (always succeeds)
            try {
                await chrome.storage.local.set({
                    links: data.links,
                    categories: data.categories
                });
                console.log('Data saved to local storage successfully');
            } catch (localError) {
                console.error('Failed to save to local storage:', {
                    errorMessage: localError.message,
                    errorStack: localError.stack
                });
                this.notifyListeners('syncError', {
                    type: 'local_storage_error',
                    message: 'Failed to save data to local storage',
                    details: localError.message,
                    recommendation: 'Please check your storage permissions and available space.'
                });
                throw localError;
            }

            // Try to save to sync storage (may fail due to quota/network)
            try {
                await chrome.storage.sync.set({
                    links: data.links,
                    categories: data.categories
                });
                console.log('Data saved to sync storage successfully');
            } catch (syncError) {
                console.warn('Failed to save to sync storage:', {
                    errorMessage: syncError.message,
                    errorStack: syncError.stack
                });
                
                // Provide detailed error information to listeners
                if (syncError.message?.includes('QUOTA_BYTES')) {
                    this.notifyListeners('syncError', {
                        type: 'quota_exceeded',
                        message: 'Chrome sync storage quota exceeded.',
                        details: 'You have reached the maximum storage limit for sync data.',
                        recommendation: 'Please remove some links or categories to free up space.'
                    });
                } else if (syncError.message?.includes('MAX_ITEMS')) {
                    this.notifyListeners('syncError', {
                        type: 'max_items_exceeded',
                        message: 'Maximum number of sync items reached.',
                        details: 'Chrome sync has a limit on the number of items that can be stored.',
                        recommendation: 'Consider consolidating your data or removing unused items.'
                    });
                } else if (syncError.message?.includes('Network')) {
                    this.notifyListeners('syncError', {
                        type: 'network_error',
                        message: 'Network error while accessing sync storage.',
                        details: 'Please check your internet connection and try again.',
                        recommendation: 'Sync will resume automatically when the connection is restored.'
                    });
                } else {
                    this.notifyListeners('syncError', {
                        type: 'sync_storage_error',
                        message: 'Failed to access Chrome sync storage.',
                        details: syncError.message,
                        recommendation: 'Sync will retry automatically.'
                    });
                }
                
                // Don't throw here - local storage save succeeded, which is the primary storage
                console.log('Continuing with local storage as primary storage');
            }
        } catch (error) {
            console.error('Failed to save resolved data:', {
                errorMessage: error.message,
                errorStack: error.stack,
                data: data
            });
            this.notifyListeners('syncError', {
                type: 'save_failure',
                message: 'Failed to save sync data',
                details: error.message,
                recommendation: 'Please try again later. If the problem persists, contact support.'
            });
            throw error; // Re-throw to be handled by caller
        }
    }

    // Validate sync data structure with enhanced validation
    validateSyncData(data) {
        const errors = [];

        // Enhanced validation with detailed error reporting
        if (!data || typeof data !== 'object') {
            errors.push('Data must be an object');
            return { valid: false, errors };
        }

        // Validate links property with comprehensive checks
        if (data.links !== undefined) {
            if (data.links === null) {
                // Null is acceptable for links
                console.log('Links property is null, which is acceptable');
            } else if (typeof data.links !== 'string') {
                errors.push(`Links must be a JSON string, got ${typeof data.links}`);
            } else {
                // Try to parse JSON to validate format
                try {
                    const links = JSON.parse(data.links);
                    if (!Array.isArray(links)) {
                        errors.push('Links must be a valid JSON array');
                    } else {
                        // Validate each link in the array
                        for (let i = 0; i < links.length; i++) {
                            const link = links[i];
                            if (!link || typeof link !== 'object') {
                                errors.push(`Link at index ${i} must be an object`);
                                continue;
                            }
                            
                            // Validate required properties
                            if (!link.name || typeof link.name !== 'string') {
                                errors.push(`Link at index ${i} must have a valid name string`);
                            }
                            if (!link.url || typeof link.url !== 'string') {
                                errors.push(`Link at index ${i} must have a valid URL string`);
                            }
                            if (!link.category || typeof link.category !== 'string') {
                                errors.push(`Link at index ${i} must have a valid category string`);
                            }
                            
                            // Validate URL format
                            try {
                                new URL(link.url);
                            } catch {
                                errors.push(`Link at index ${i} has an invalid URL format: ${link.url}`);
                            }
                        }
                    }
                } catch (e) {
                    errors.push(`Links must be valid JSON: ${e.message}`);
                }
            }
        }

        // Validate categories property with comprehensive checks
        if (data.categories !== undefined) {
            if (data.categories === null) {
                // Null is acceptable for categories
                console.log('Categories property is null, which is acceptable');
            } else if (typeof data.categories !== 'string') {
                errors.push(`Categories must be a JSON string, got ${typeof data.categories}`);
            } else {
                // Try to parse JSON to validate format
                try {
                    const categories = JSON.parse(data.categories);
                    if (!Array.isArray(categories)) {
                        errors.push('Categories must be a valid JSON array');
                    } else {
                        // Validate each category in the array
                        for (let i = 0; i < categories.length; i++) {
                            const category = categories[i];
                            if (typeof category !== 'string') {
                                errors.push(`Category at index ${i} must be a string`);
                            } else if (category.length === 0) {
                                errors.push(`Category at index ${i} cannot be empty`);
                            } else if (category.length > 50) {
                                errors.push(`Category at index ${i} exceeds maximum length of 50 characters`);
                            }
                        }
                    }
                } catch (e) {
                    errors.push(`Categories must be valid JSON: ${e.message}`);
                }
            }
        }

        // Additional content structure validation
        const validProperties = ['links', 'categories'];
        const dataKeys = Object.keys(data);
        for (const key of dataKeys) {
            if (!validProperties.includes(key)) {
                console.warn(`Unexpected property in sync data: ${key}`);
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }

    // Get bytes in use for sync storage
    async getSyncBytesInUse() {
        return new Promise((resolve) => {
            chrome.storage.sync.getBytesInUse(null, (bytes) => {
                resolve(bytes);
            });
        });
    }

    // Save compressed data for large datasets
    async saveCompressedData(data) {
        // For now, we'll just try to save as-is and handle errors
        // In a production app, you'd implement actual compression
        try {
            await chrome.storage.sync.set(data);
        } catch (error) {
            if (error.message.includes('QUOTA_BYTES')) {
                console.error('Sync storage quota exceeded');
                this.notifyListeners('quotaExceeded', {
                    bytesNeeded: new Blob([JSON.stringify(data)]).size,
                    quotaLimit: chrome.storage.sync.QUOTA_BYTES
                });
            }
            throw error;
        }
    }

    // Force sync from remote (pull)
    async forcePullFromRemote() {
        return this.syncData('remote');
    }

    // Force sync to remote (push)
    async forcePushToRemote() {
        return this.syncData('local');
    }

    // Get sync status and statistics
    async getSyncStatus() {
        const metadata = await this.getSyncMetadata();
        const bytesInUse = await this.getSyncBytesInUse();

        return {
            lastSyncTime: this.lastSyncTime,
            localVersion: metadata.local.version,
            remoteVersion: metadata.remote.version,
            isInSync: metadata.local.version === metadata.remote.version,
            syncInProgress: this.syncInProgress,
            bytesInUse,
            quotaLimit: chrome.storage.sync.QUOTA_BYTES,
            quotaPercentage: (bytesInUse / chrome.storage.sync.QUOTA_BYTES) * 100
        };
    }

    // Debounced sync for automatic syncing
    debouncedSync(delay = 2000) {
        if (this.syncDebounceTimeout) {
            clearTimeout(this.syncDebounceTimeout);
        }

        this.syncDebounceTimeout = setTimeout(() => {
            this.syncData();
        }, delay);
    }

    // Clear all sync data (for troubleshooting)
    async clearSyncData() {
        try {
            await chrome.storage.sync.clear();
            await chrome.storage.local.remove(['syncMetadata', 'lastSyncTime']);
            this.lastSyncTime = null;
            this.notifyListeners('syncCleared', { time: Date.now() });
            return { success: true };
        } catch (error) {
            console.error('Failed to clear sync data:', error);
            return { success: false, error: error.message };
        }
    }
}

// Create singleton instance
export const syncManager = new SyncManager();