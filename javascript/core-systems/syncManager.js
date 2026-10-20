// Advanced Sync Manager for The Codex
// Handles conflict resolution, versioning, and improved sync strategies

import { debug, debugWarn, debugError } from './debug.js';
import { parseStoredArray } from './storageFormat.js';

// Confirm-dialog text for the destructive manual sync actions, shared by the
// new-tab pill and the manage page's Sync tab so both describe the same thing.
// "Local copy" is chrome.storage.local, which only changes on a manual sync (or
// a failed sync write); normal edits go straight to chrome.storage.sync.
export const SYNC_CONFIRMATIONS = Object.freeze({
    forcePush: 'Replace the cloud data on ALL your devices with this device\'s local copy? '
        + 'The local copy is from this device\'s last manual sync, so changes made since then '
        + 'on any device will be lost. Continue?',
    forcePull: 'Replace this device\'s local copy with the cloud data? '
        + 'The cloud data is not changed. Continue?',
    localWins: 'With "This device\'s last sync wins", Sync now replaces the cloud data on ALL your '
        + 'devices with this device\'s local copy whenever another device has synced since. The '
        + 'local copy is from this device\'s last manual sync, so newer changes will be lost. Use it?',
    clearSync: 'This deletes your links, categories and settings from Chrome sync on ALL devices '
        + 'signed in to this browser profile, and this device\'s local copy. A backup is saved on '
        + 'this device and downloaded as a file first (restore the file with Import on the Manage '
        + 'page). Continue?'
});

// True when a stored links/categories value (JSON string or array) has entries.
function hasEntries(value) {
    return (parseStoredArray(value)?.length ?? 0) > 0;
}

function holdsData(data) {
    return hasEntries(data.links) || hasEntries(data.categories);
}

// Synced settings keys (besides links/categories) that a clear removes.
const SETTINGS_KEYS = ['theme', 'view', 'colorTheme', 'defaultTileSize'];

// True when a stored categories value holds nothing beyond 'Default'.
function onlyDefaultCategories(value) {
    return (parseStoredArray(value) ?? []).every(category => category === 'Default');
}

// Chrome's storage quota errors read "QUOTA_BYTES_PER_ITEM quota exceeded"
// before Chrome 137 and "Resource::kQuotaBytesPerItem quota exceeded" since
// (Chromium 58ce9efef436); match both spellings.
const isQuotaBytesError = (message) => /QUOTA_BYTES|kQuotaBytes/.test(message ?? '');
const isMaxItemsError = (message) => /MAX_ITEMS|kMaxItems/.test(message ?? '');
const isRateLimitError = (message) => /MAX_WRITE_OPERATIONS/.test(message ?? '');

// syncError payload for a failed chrome.storage.sync read or write.
function syncStorageErrorEvent(rawMessage = '') {
    if (isQuotaBytesError(rawMessage)) {
        return {
            type: 'quota_exceeded',
            message: 'Chrome sync storage quota exceeded.',
            details: 'You have reached the maximum storage limit for sync data.',
            recommendation: 'Please remove some links or categories to free up space.'
        };
    }
    if (isMaxItemsError(rawMessage)) {
        return {
            type: 'max_items_exceeded',
            message: 'Maximum number of sync items reached.',
            details: 'Chrome sync has a limit on the number of items that can be stored.',
            recommendation: 'Consider consolidating your data or removing unused items.'
        };
    }
    if (isRateLimitError(rawMessage)) {
        return {
            type: 'rate_limited',
            message: 'Chrome sync is limiting how often changes can be saved.',
            details: rawMessage,
            recommendation: 'Wait a minute, then try again.'
        };
    }
    if (rawMessage.includes('Network')) {
        return {
            type: 'network_error',
            message: 'Network error while accessing sync storage.',
            details: 'Please check your internet connection and try again.',
            recommendation: 'Sync will resume automatically when the connection is restored.'
        };
    }
    return {
        type: 'sync_storage_error',
        message: 'Failed to access Chrome sync storage.',
        details: rawMessage,
        recommendation: 'Sync will retry automatically.'
    };
}

// chrome.storage.local keys holding the backups taken by clearSyncData()
// (the latest, and the one before it).
export const SYNC_BACKUP_KEY = 'syncBackupBeforeClear';
export const SYNC_PREVIOUS_BACKUP_KEY = 'syncBackupBeforeClearPrevious';
// chrome.storage.sync key stamped by clearSyncData() (a timestamp).
export const SYNC_CLEARED_AT_KEY = 'syncClearedAt';

export class SyncManager {
    constructor() {
        this.syncInProgress = false;
        this.lastSyncTime = null;
        this.syncListeners = [];
        // How Sync now resolves a version conflict: 'remote' (cloud wins),
        // 'merge' or 'local'. Default to the cloud: local is a snapshot from
        // this device's last manual sync, so merging it resurrects deleted
        // links and letting it win reverts every device. The manage page's
        // select can opt into the others explicitly.
        this.conflictResolutionStrategy = 'remote';
        this.syncDebounceTimeout = null;
        this.syncQueue = [];

        // Initialize sync status
        this.initializeSyncStatus();
        // Watch chrome.storage.sync so status reflects real autosync activity.
        this.registerSyncActivityRecorder();
    }

    // Initialize sync status and listeners
    async initializeSyncStatus() {
        try {
            const status = await chrome.storage.local.get(['lastSyncTime', 'syncStatus']);
            this.lastSyncTime = status.lastSyncTime || null;
            this.notifyListeners('initialized', status.syncStatus || 'unknown');
        } catch (error) {
            debugError('Failed to initialize sync status:', error);
        }
    }

    // Data keys that live in chrome.storage.sync and count as "synced" activity.
    static get SYNCED_DATA_KEYS() {
        return ['links', 'categories', 'theme', 'colorTheme', 'view', 'defaultTileSize'];
    }

    // Record real autosync activity by listening to chrome.storage.sync.
    //
    // chrome.storage.sync IS the cross-device transport: the browser propagates
    // it automatically, and onChanged fires in every context — the one that
    // wrote (a local edit) AND every device that receives the update. So a
    // single sync-area listener captures both "we just pushed" and "a remote
    // change just landed", which is exactly what the status pill should show.
    //
    // We deliberately do NOT call syncData()/reconcile here: saveLinks writes
    // chrome.storage.sync as primary and only falls back to local, so local is
    // usually stale — reconciling would resurrect deleted links. Recording is
    // safe because it only writes local-only status keys (never sync), so it
    // can't clobber data and can't loop (the listener ignores the local area).
    registerSyncActivityRecorder() {
        if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'sync') return;
            // Clear sync data is not a sync: skip its removals and the empty
            // values it writes (stamped with SYNC_CLEARED_AT_KEY). Otherwise
            // only count keys that received a new value.
            if (SYNC_CLEARED_AT_KEY in changes) return;
            const touched = Object.entries(changes).some(([k, change]) =>
                SyncManager.SYNCED_DATA_KEYS.includes(k) && change && 'newValue' in change);
            if (!touched) return;
            this.recordSyncActivity(changes);
        });
    }

    // Stamp the last-sync time and notify listeners that a sync just happened.
    // Writes only chrome.storage.local (status keys), so it never clobbers
    // synced data and never re-triggers the sync-area listener above.
    async recordSyncActivity(changes = {}) {
        try {
            this.lastSyncTime = Date.now();
            await chrome.storage.local.set({ lastSyncTime: this.lastSyncTime, syncStatus: 'synced' });

            let itemsSynced;
            const linksChange = changes.links;
            if (linksChange && typeof linksChange.newValue === 'string') {
                try { itemsSynced = JSON.parse(linksChange.newValue).length; } catch { /* leave undefined */ }
            }
            this.notifyListeners('syncComplete', { time: this.lastSyncTime, itemsSynced });
        } catch (error) {
            debugError('Failed to record sync activity:', error);
        }
    }

    // Register a listener for sync events
    addSyncListener(callback) {
        this.syncListeners.push(callback);
        return () => {
            this.syncListeners = this.syncListeners.filter(cb => cb !== callback);
        };
    }

    // Emit a syncError and mark the error as reported, so syncData's
    // catch-all doesn't report the same failure a second time.
    reportSyncError(error, payload) {
        if (error && typeof error === 'object') error.reported = true;
        this.notifyListeners('syncError', payload);
    }

    // Notify all listeners of sync status changes
    notifyListeners(event, data) {
        this.syncListeners.forEach(callback => {
            try {
                callback(event, data);
            } catch (error) {
                debugError('Sync listener error:', error);
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
            debugError('Failed to get sync metadata:', error);
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

            debug('Sync metadata updated successfully');
            return { success: true, metadata };
        } catch (error) {
            debugError('Failed to update sync metadata:', error);

            // Handle specific Chrome storage errors
            if (isQuotaBytesError(error.message)) {
                this.notifyListeners('error', {
                    type: 'quota_exceeded',
                    message: 'Storage quota exceeded. Cannot update sync metadata.',
                    details: error.message
                });
            } else if (isMaxItemsError(error.message)) {
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
            debugError('Failed to get device ID:', error);
            return 'unknown_device';
        }
    }

    // Main sync function with conflict resolution and comprehensive error handling
    async syncData(forceStrategy = null) {
        if (this.syncInProgress) {
            debug('Sync already in progress, queueing request');
            return new Promise((resolve) => {
                this.syncQueue.push(resolve);
            });
        }

        this.syncInProgress = true;
        this.notifyListeners('syncStart', { time: Date.now() });

        try {
            debug('Starting sync operation...');

            // Validate Chrome storage availability
            if (!chrome.storage || !chrome.storage.local || !chrome.storage.sync) {
                throw new Error('Chrome storage API not available');
            }

            // Get current data from both storages with error handling
            let localData, syncData;

            try {
                localData = await chrome.storage.local.get(['links', 'categories']);
                debug('Local data retrieved:', localData);
            } catch (localError) {
                debugError('Failed to retrieve local data:', localError);
                this.reportSyncError(localError, {
                    type: 'local_storage_error',
                    message: 'Failed to read local storage data.',
                    details: localError.message
                });
                throw localError;
            }

            try {
                syncData = await chrome.storage.sync.get(['links', 'categories']);
                debug('Sync data retrieved:', syncData);
            } catch (syncError) {
                debugError('Failed to retrieve sync data:', syncError);
                this.reportSyncError(syncError, syncStorageErrorEvent(syncError.message));

                // Abort: without knowing what the cloud holds, any write we
                // made (e.g. of stand-in empty data) could wipe it.
                throw syncError;
            }

            // Get metadata for versioning
            const metadata = await this.getSyncMetadata();

            // Determine sync strategy
            const strategy = forceStrategy || this.conflictResolutionStrategy;

            // chrome.storage.sync is the source of truth: normal edits
            // (storageManager.saveLinks) write sync only, so local is a snapshot
            // from the last manual sync and usually stale. Never let that
            // snapshot win just because the metadata versions match — after any
            // manual sync they always do.
            let resolvedData;
            if (forceStrategy === 'remote' || forceStrategy === 'local') {
                // Explicit pull/push: honor it whatever the versions say.
                resolvedData = forceStrategy === 'remote' ? syncData : localData;
                if (!holdsData(resolvedData)) {
                    throw new Error(forceStrategy === 'remote'
                        ? 'The cloud has no links or categories to pull.'
                        : 'This device has no local copy to push.');
                }
            } else if (!metadata.local.version && holdsData(localData)) {
                // This device's first sync. Its local data never came from the
                // cloud (it predates sync, or is a save that fell back to local),
                // so it can't be a stale snapshot: merge it in rather than lose
                // it. With an empty cloud this is a plain migration. A device
                // that has synced before never takes this path, so it can't
                // re-upload its snapshot into an emptied cloud.
                debug('First sync on this device; merging local data into sync');
                resolvedData = this.mergeData(localData, syncData, metadata, { preferRemote: true });
            } else if (!forceStrategy && metadata.local.version === metadata.remote.version) {
                debug('No version conflict; using sync storage data');
                resolvedData = syncData;
            } else {
                // Versions differ (another device synced since this one did),
                // or a merge was forced. The default 'remote' keeps the cloud; 'merge' (resurrects
                // deleted links) and 'local' (reverts the cloud to this device's
                // snapshot) apply only when chosen explicitly.
                debug('Conflict detected, resolving with strategy:', strategy);
                resolvedData = await this.resolveConflict(localData, syncData, metadata, strategy);
            }

            // Validate resolved data before saving with enhanced error handling
            const validationResult = this.validateSyncData(resolvedData);
            if (!validationResult.valid) {
                const validationError = new Error(`Data validation failed: ${validationResult.errors.join(', ')}`);
                debugError('Sync data validation failed:', {
                    errors: validationResult.errors,
                    data: resolvedData
                });
                this.reportSyncError(validationError, {
                    type: 'validation_error',
                    message: 'Sync data validation failed',
                    details: validationResult.errors,
                    recommendation: 'Please check your data and try again. If the problem persists, contact support.'
                });
                throw validationError;
            }

            // Save resolved data to both storages. Data that came from sync is
            // not written back to it: that write would only cost write quota
            // and could overwrite a change another device made meanwhile.
            const saveResult = await this.saveResolvedData(resolvedData, { toSync: resolvedData !== syncData });
            if (!saveResult.syncSaved) {
                // The cloud was not updated (quota, rate limit, …; already
                // reported): fail, and don't stamp metadata as if it synced.
                throw Object.assign(new Error(saveResult.error), { reported: true });
            }

            // Update sync metadata
            const metadataResult = await this.updateSyncMetadata('both');
            if (!metadataResult.success) {
                debugWarn('Failed to update sync metadata:', metadataResult.error);
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

            debug(`Sync completed successfully. Synced ${syncedItemsCount} items.`);

            // Process queued sync requests
            while (this.syncQueue.length > 0) {
                const resolve = this.syncQueue.shift();
                resolve({ success: true, time: this.lastSyncTime, itemsSynced: syncedItemsCount });
            }

            return { success: true, time: this.lastSyncTime, itemsSynced: syncedItemsCount };

        } catch (error) {
            debugError('Sync failed:', error);

            // Provide detailed error information to listeners, unless the
            // step that failed already did.
            if (!error.reported) {
                this.notifyListeners('syncError', {
                    type: 'sync_failed',
                    message: 'Synchronization failed due to an unexpected error.',
                    details: error.message,
                    timestamp: Date.now(),
                    recommendation: 'Please try again later. If the problem persists, check your internet connection or contact support.'
                });
            }

            // Process queued sync requests with error
            while (this.syncQueue.length > 0) {
                const resolve = this.syncQueue.shift();
                resolve({ success: false, error: error.message, timestamp: Date.now() });
            }

            return { success: false, error: error.message, timestamp: Date.now() };
        } finally {
            this.syncInProgress = false;
            debug('Sync operation completed');
        }
    }

    // Resolve conflicts between local and remote data
    async resolveConflict(localData, syncData, metadata, strategy) {
        debug(`Resolving conflict with strategy: ${strategy}`);

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

    // Merge local and remote data: the union of both link lists (stored as
    // JSON strings or raw arrays), where a local and a remote link are the
    // same link if their ids or URLs match. When both have a link, the remote
    // version wins if preferRemote is set, else the side that synced last.
    mergeData(localData, syncData, metadata, { preferRemote } = {}) {
        const mergedData = {};

        const localLinks = parseStoredArray(localData.links) ?? [];
        const syncLinks = parseStoredArray(syncData.links) ?? [];
        const sameLink = (a, b) => (a.id != null && a.id === b.id) || a.url === b.url;
        const remoteWins = preferRemote ?? metadata.remote.lastModified > metadata.local.lastModified;

        const merged = localLinks.map(link => ({ ...link }));
        const localCount = merged.length;
        syncLinks.forEach(link => {
            const existing = merged.findIndex((m, i) => i < localCount && sameLink(m, link));
            if (existing === -1) {
                merged.push({ ...link });
            } else if (remoteWins) {
                merged[existing] = { ...link };
            }
        });

        mergedData.links = JSON.stringify(merged);

        // Merge categories
        const localCategories = parseStoredArray(localData.categories) ?? ['Default'];
        const syncCategories = parseStoredArray(syncData.categories) ?? ['Default'];
        const mergedCategories = [...new Set([...localCategories, ...syncCategories])];

        // Ensure Default category exists
        if (!mergedCategories.includes('Default')) {
            mergedCategories.unshift('Default');
        }

        mergedData.categories = JSON.stringify(mergedCategories);

        return mergedData;
    }

    // Save resolved data to sync storage (unless toSync is false), then local.
    // Returns { syncSaved: boolean, error?: string }; syncSaved is false when
    // the sync write failed, so callers can report the sync as failed.
    async saveResolvedData(data, { toSync = true } = {}) {
        try {
            debug('Saving resolved data...', {
                hasLinks: !!data.links,
                hasCategories: !!data.categories,
                linksType: typeof data.links,
                categoriesType: typeof data.categories
            });

            // Validate data before saving with detailed validation
            if (!data.links && !data.categories) {
                // Nothing to persist (e.g. a fresh profile with no data yet).
                // This is a no-op, not an error — skip quietly instead of
                // throwing and spamming the console on every sync tick.
                debug('Nothing to sync — no links or categories present; skipping save');
                return { syncSaved: true };
            }

            // Sync first: it is the primary storage and the copy every device
            // reads. If it fails, the sync did not happen, and this device's
            // local data (e.g. saves that fell back to local) stays untouched.
            if (toSync) {
                try {
                    await chrome.storage.sync.set({
                        links: data.links,
                        categories: data.categories
                    });
                    debug('Data saved to sync storage successfully');
                } catch (syncError) {
                    debugWarn('Failed to save to sync storage:', {
                        errorMessage: syncError.message,
                        errorStack: syncError.stack
                    });
                    const event = syncStorageErrorEvent(syncError.message);
                    this.reportSyncError(syncError, event);
                    return { syncSaved: false, error: `${event.message} (${syncError.message})` };
                }
            }

            // Then this device's local copy
            try {
                await chrome.storage.local.set({
                    links: data.links,
                    categories: data.categories
                });
                debug('Data saved to local storage successfully');
            } catch (localError) {
                debugError('Failed to save to local storage:', {
                    errorMessage: localError.message,
                    errorStack: localError.stack
                });
                this.reportSyncError(localError, {
                    type: 'local_storage_error',
                    message: 'Failed to save data to local storage',
                    details: localError.message,
                    recommendation: 'Please check your storage permissions and available space.'
                });
                throw localError;
            }

            return { syncSaved: true };
        } catch (error) {
            debugError('Failed to save resolved data:', {
                errorMessage: error.message,
                errorStack: error.stack,
                data: data
            });
            if (!error.reported) {
                this.reportSyncError(error, {
                    type: 'save_failure',
                    message: 'Failed to save sync data',
                    details: error.message,
                    recommendation: 'Please try again later. If the problem persists, contact support.'
                });
            }
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
                debug('Links property is null, which is acceptable');
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
                debug('Categories property is null, which is acceptable');
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
                debugWarn(`Unexpected property in sync data: ${key}`);
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
            if (isQuotaBytesError(error.message)) {
                debugError('Sync storage quota exceeded');
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
        const hasData = await this.hasSyncedData();

        return {
            lastSyncTime: this.lastSyncTime,
            localVersion: metadata.local.version,
            remoteVersion: metadata.remote.version,
            isInSync: metadata.local.version === metadata.remote.version,
            // Whether chrome.storage.sync currently holds links. Used by the UI
            // to decide "Synced" vs "Not synced" even before versioned metadata
            // exists (a profile restored from the cloud has data but version 0).
            hasData,
            syncInProgress: this.syncInProgress,
            bytesInUse,
            quotaLimit: chrome.storage.sync.QUOTA_BYTES,
            quotaPercentage: (bytesInUse / chrome.storage.sync.QUOTA_BYTES) * 100
        };
    }

    // True when chrome.storage.sync currently holds a non-empty links array.
    async hasSyncedData() {
        try {
            const { links } = await chrome.storage.sync.get('links');
            if (Array.isArray(links)) return links.length > 0;
            if (typeof links === 'string') {
                try { return JSON.parse(links).length > 0; } catch { return false; }
            }
            return false;
        } catch {
            return false;
        }
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

    // Back up the cloud data (plus this device's local copy) before a clear:
    // first to chrome.storage.local[SYNC_BACKUP_KEY] (the previous backup moves
    // to SYNC_PREVIOUS_BACKUP_KEY), then as a download in the manage page's
    // export format so it can be restored with Import. Throws if the stored
    // copy can't be written; resolves to the download's result. The stored
    // copy is what makes this safe: a cancelled or blocked download raises no
    // error, so the download alone can't gate the clear.
    async backupBeforeClear() {
        const [cloud, local] = await Promise.all([
            chrome.storage.sync.get(null),
            chrome.storage.local.get(['links', 'categories', SYNC_BACKUP_KEY])
        ]);
        const nothingToKeep = !hasEntries(cloud.links) && !hasEntries(local.links)
            && onlyDefaultCategories(cloud.categories) && onlyDefaultCategories(local.categories)
            && !SETTINGS_KEYS.some(key => cloud[key] !== undefined);
        if (nothingToKeep) {
            // e.g. a second clear: keep the existing backups rather than
            // replacing them with an empty one.
            debug('Nothing to back up; keeping the existing backup');
            return true;
        }

        const backup = {
            links: parseStoredArray(cloud.links) ?? [],
            categories: parseStoredArray(cloud.categories) ?? ['Default'],
            theme: cloud.theme,
            view: cloud.view,
            colorTheme: cloud.colorTheme,
            defaultTileSize: cloud.defaultTileSize,
            exportDate: new Date().toISOString(),
            deviceLocalCopy: {
                links: parseStoredArray(local.links) ?? [],
                categories: parseStoredArray(local.categories) ?? []
            }
        };
        const toStore = { [SYNC_BACKUP_KEY]: backup };
        if (local[SYNC_BACKUP_KEY]) toStore[SYNC_PREVIOUS_BACKUP_KEY] = local[SYNC_BACKUP_KEY];
        try {
            await chrome.storage.local.set(toStore);
        } catch (error) {
            throw new Error(`Could not save a backup on this device, so sync data was not cleared (${error.message}).`);
        }
        debug(`Sync data backed up to chrome.storage.local["${SYNC_BACKUP_KEY}"] (see CodexConsole.localData())`);

        // Lazy import: storageManager imports this module, so a static import
        // would be circular.
        const { exportLinks } = await import('./storageManager.js');
        return exportLinks(backup);
    }

    // Clear all sync data (for troubleshooting). chrome.storage.sync is shared
    // by every signed-in device, so this wipes links everywhere: back up first
    // and don't clear anything if that fails.
    async clearSyncData() {
        try {
            if (!await this.backupBeforeClear()) {
                throw new Error('Could not download a backup, so sync data was not cleared.');
            }

            // Leave explicit empty values rather than an empty sync area. When
            // sync is empty, loadLinks falls back to a device's local snapshot,
            // whose next save would re-upload everything; the explicit values
            // also reset open tabs through stateManager's onChanged listener.
            // Write them before removing the rest, so sync is never empty.
            try {
                const cloudKeys = Object.keys(await chrome.storage.sync.get(null));
                await chrome.storage.sync.set({
                    links: JSON.stringify([]),
                    categories: JSON.stringify(['Default']),
                    [SYNC_CLEARED_AT_KEY]: Date.now()
                });
                const leftover = cloudKeys.filter(key => !['links', 'categories', SYNC_CLEARED_AT_KEY].includes(key));
                if (leftover.length > 0) {
                    await chrome.storage.sync.remove(leftover);
                }
            } catch (syncError) {
                const event = syncStorageErrorEvent(syncError.message);
                throw new Error(`${event.message} (${syncError.message})`);
            }

            // Drop this device's snapshot and sync history too, so its next
            // Sync now starts fresh instead of from pre-clear data.
            await chrome.storage.local.remove(['syncMetadata', 'lastSyncTime', 'links', 'categories']);
            this.lastSyncTime = null;
            this.notifyListeners('syncCleared', { time: Date.now() });
            return { success: true };
        } catch (error) {
            debugError('Failed to clear sync data:', error);
            return { success: false, error: error.message };
        }
    }
}

// Create singleton instance
export const syncManager = new SyncManager();