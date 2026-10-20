// Advanced Sync Manager for The Codex
// Handles conflict resolution, versioning, and improved sync strategies

import { debug, debugWarn, debugError } from './debug.js';
import { parseStoredArray, pendingSyncKey, PENDING_SYNC_FIELDS, SYNC_CLEARED_AT_KEY, SYNC_RESOLVED_AT_KEY } from './storageFormat.js';

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
    clearSync: 'This deletes your links and categories from Chrome sync and resets your settings, on '
        + 'ALL devices signed in to this browser profile, and clears this device\'s local copy. A '
        + 'backup is saved on this device and downloaded as a file first (restore the file with '
        + 'Import on the Manage page). Continue?'
});

// True when a stored links/categories value (JSON string or array) has entries.
function hasEntries(value) {
    return (parseStoredArray(value)?.length ?? 0) > 0;
}

function holdsData(data) {
    return hasEntries(data.links) || hasEntries(data.categories);
}

// Synced settings (besides links/categories) and the defaults a clear
// resets them to (the same defaults storageManager loads).
const SETTINGS_DEFAULTS = Object.freeze({ theme: 'dark', view: 'grid', colorTheme: 'default', defaultTileSize: 'medium' });
const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS);

// The defined values of `keys` in `source`.
function pick(source, keys) {
    const picked = {};
    for (const key of keys) {
        if (source?.[key] !== undefined) picked[key] = source[key];
    }
    return picked;
}

// A stored value in a canonical form for comparing content: JSON-encoded
// lists are parsed and object keys sorted, so a re-serialization with a
// different key order still counts as the same value.
function canonical(value) {
    if (typeof value === 'string') {
        const list = parseStoredArray(value);
        if (list) return canonical(list);
        return value;
    }
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value ?? null;
}

function sameStoredValue(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// A backup's data, without when/why/whether-downloaded, for comparing copies.
function backupContent({ exportDate, reason, downloaded, ...content }) {
    return content;
}

// Whether the cloud still holds the value a pending-sync marker recorded.
// A marker without a readable recorded value can't tell, so it never matches.
function markerMatchesCloud(marker, cloudValue) {
    if (typeof marker?.cloud !== 'string') return false;
    try {
        return sameStoredValue(JSON.parse(marker.cloud), cloudValue);
    } catch {
        return false;
    }
}

const isLinkEntry = (link) => link !== null && typeof link === 'object';
const sameLink = (a, b) => (a.id != null && a.id === b.id) || a.url === b.url;

// How many of this device's entries for `field` the cloud lacks: links with
// no cloud link of the same id or URL, or whose cloud counterpart differs
// (e.g. a category move); categories the cloud doesn't list; a setting whose
// value differs.
function entriesCloudLacks(local, cloud, field) {
    if (field === 'links') {
        const cloudLinks = (parseStoredArray(cloud.links) ?? []).filter(isLinkEntry);
        return (parseStoredArray(local.links) ?? []).filter(isLinkEntry).filter(link => {
            const counterpart = cloudLinks.find(other => sameLink(link, other));
            return !counterpart || !sameStoredValue(link, counterpart);
        }).length;
    }
    if (field === 'categories') {
        const cloudCategories = new Set(parseStoredArray(cloud.categories) ?? ['Default']);
        return (parseStoredArray(local.categories) ?? []).filter(category => !cloudCategories.has(category)).length;
    }
    return local[field] !== undefined && !sameStoredValue(local[field], cloud[field]) ? 1 : 0;
}

const SETTING_NAMES = { theme: 'theme', view: 'view', colorTheme: 'color theme', defaultTileSize: 'tile size' };
const SET_ASIDE_CAUSES = {
    superseded: 'replaced by newer changes in the cloud',
    forcePull: 'replaced by Force pull',
    cleared: 'not uploaded because the cloud was cleared',
    ambiguous: 'not uploaded because the cloud is empty and may have been cleared by an older version'
};

// "2 links and the theme setting saved only on this device were …"
function describeSetAside(fields, cause, local, cloud) {
    const parts = [];
    let total = 0;
    const count = (n, one, many) => {
        total += n;
        return `${n} ${n === 1 ? one : many}`;
    };
    if (fields.includes('links')) parts.push(count(entriesCloudLacks(local, cloud, 'links'), 'link', 'links'));
    if (fields.includes('categories')) parts.push(count(entriesCloudLacks(local, cloud, 'categories'), 'category', 'categories'));
    const settings = SETTINGS_KEYS.filter(key => fields.includes(key)).map(key => SETTING_NAMES[key]);
    if (settings.length > 0) {
        total += settings.length;
        parts.push(`the ${settings.join(', ')} setting${settings.length === 1 ? '' : 's'}`);
    }
    const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
    const verb = total === 1 ? 'was' : 'were';
    return `${what.charAt(0).toUpperCase()}${what.slice(1)} saved only on this device ${verb} ${SET_ASIDE_CAUSES[cause]}.`;
}

// Drop link entries that aren't objects (logged): one junk entry shouldn't
// fail every sync's validation.
function withoutJunkLinks(lists) {
    if (!lists || lists.links === undefined) return lists;
    const links = parseStoredArray(lists.links);
    if (!links || links.every(isLinkEntry)) return lists;
    debugWarn('Dropping link entries that are not objects:', links.filter(link => !isLinkEntry(link)));
    return { ...lists, links: JSON.stringify(links.filter(isLinkEntry)) };
}

// links/categories as stored: JSON strings, upgrading raw arrays from older builds.
function encodeLists(source) {
    const lists = pick(source, ['links', 'categories']);
    for (const [key, value] of Object.entries(lists)) {
        if (Array.isArray(value)) lists[key] = JSON.stringify(value);
    }
    return lists;
}

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
// chrome.storage.local keys holding what a sync set aside instead of uploading
// (kept apart from the clear backups, so one can't rotate the other out).
export const SYNC_SET_ASIDE_KEY = 'syncSetAside';
export const SYNC_PREVIOUS_SET_ASIDE_KEY = 'syncSetAsidePrevious';
// chrome.storage.sync key stamped by clearSyncData(); compared for equality only.
export { SYNC_CLEARED_AT_KEY };

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
            // Clear sync data is not a sync. Its single write carries
            // SYNC_CLEARED_AT_KEY: a clear from another context or device
            // resets this one's status; our own clear is handled in
            // clearSyncData. Otherwise only count keys that got a new value.
            const cleared = changes[SYNC_CLEARED_AT_KEY];
            if (cleared) {
                if ('newValue' in cleared && cleared.newValue !== this.lastClearStamp) {
                    this.recordRemoteClear();
                }
                return;
            }
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

    // Clear sync data ran elsewhere: this device's last-sync status no longer
    // describes the cloud. Its snapshot is left alone; the next Sync now
    // replaces it with the cleared cloud.
    async recordRemoteClear() {
        this.lastSyncTime = null;
        try {
            await chrome.storage.local.remove(['lastSyncTime', 'syncStatus']);
            // Saves that fell back to local before the clear must not be
            // uploaded over it: drop their recorded cloud value, so the next
            // Sync now treats them as superseded (kept as a backup, not pushed).
            const markerKeys = PENDING_SYNC_FIELDS.map(pendingSyncKey);
            const markers = await chrome.storage.local.get(markerKeys);
            const invalidated = Object.fromEntries(Object.entries(markers)
                .map(([key, marker]) => [key, { since: marker?.since }]));
            if (Object.keys(invalidated).length > 0) await chrome.storage.local.set(invalidated);
        } catch (error) {
            debugError('Failed to reset sync status after a remote clear:', error);
        }
        this.notifyListeners('syncCleared', { time: Date.now(), remote: true });
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

            // Read both storages. Abort if either fails: without knowing what
            // the cloud holds, any write could wipe it.
            let inputs;
            try {
                inputs = await this.readSyncInputs();
            } catch (readError) {
                debugError('Failed to read storage for sync:', readError);
                this.reportSyncError(readError, readError.area === 'local'
                    ? {
                        type: 'local_storage_error',
                        message: 'Failed to read local storage data.',
                        details: readError.message
                    }
                    : syncStorageErrorEvent(readError.message));
                throw readError;
            }
            const { metadata } = inputs;

            // Determine sync strategy
            const strategy = forceStrategy || this.conflictResolutionStrategy;
            const resolution = this.resolveSyncData(inputs, { forceStrategy, strategy });
            const resolvedData = resolution.data;

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

            // Local entries the cloud lacks, dropped without being uploaded, are
            // stored and downloaded before they're replaced: no backup, no
            // replacement.
            if (resolution.setAside) {
                await this.storeSetAside(resolution.setAside, inputs, resolvedData);
            }

            // Write what changed in the cloud (nothing when the cloud wins: that
            // write would only cost write quota and could overwrite a change
            // another device made meanwhile), then this device's local copy.
            const saveResult = await this.saveResolvedData(resolvedData, { syncItems: resolution.syncItems });
            if (!saveResult.syncSaved) {
                // The cloud was not updated (quota, rate limit, …; already
                // reported): fail, keep pending markers, don't stamp metadata.
                throw Object.assign(new Error(saveResult.error), { reported: true });
            }

            // Local links/categories now match what was kept, and pushed,
            // superseded or set-aside fields are no longer pending.
            await this.settleLocalFields(['links', 'categories', ...resolution.settled]);

            // Update sync metadata
            const metadataResult = await this.updateSyncMetadata('both');
            if (!metadataResult.success) {
                debugWarn('Failed to update sync metadata:', metadataResult.error);
            }

            // Update last sync time, and tell every open page to reload what
            // storage holds now (stateManager): when the cloud won there was no
            // sync write, so no sync onChanged reaches pages still holding
            // discarded local data.
            this.lastSyncTime = Date.now();
            await chrome.storage.local.set({ lastSyncTime: this.lastSyncTime, [SYNC_RESOLVED_AT_KEY]: Date.now() });

            const syncedItemsCount = (parseStoredArray(resolvedData.links) ?? []).length;
            const warning = resolution.setAside
                ? `${resolution.setAside.reason} A copy was saved on this device and downloaded as a `
                    + 'backup file (restore it with Import on the Manage page).'
                : undefined;

            this.notifyListeners('syncComplete', {
                time: this.lastSyncTime,
                itemsSynced: syncedItemsCount,
                strategy: strategy,
                metadata: metadata,
                warning
            });

            debug(`Sync completed successfully. Synced ${syncedItemsCount} items.`);

            const result = { success: true, time: this.lastSyncTime, itemsSynced: syncedItemsCount, warning };

            // Process queued sync requests
            while (this.syncQueue.length > 0) {
                const resolve = this.syncQueue.shift();
                resolve(result);
            }

            return result;

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

    // Read everything a sync decision needs in one read per area: this device's
    // local copy (lists, settings, deviceId, pending-sync markers, metadata) and
    // the cloud's lists, settings, metadata and clear stamp. A failed read
    // throws with error.area set to 'local' or 'sync' — never a guessed
    // version 0, which would make a synced device look like a first sync.
    async readSyncInputs() {
        let local, cloud;
        try {
            local = await chrome.storage.local.get([
                'links', 'categories', ...SETTINGS_KEYS, 'deviceId', 'syncMetadata',
                ...PENDING_SYNC_FIELDS.map(pendingSyncKey)
            ]);
        } catch (error) {
            throw Object.assign(error, { area: 'local' });
        }
        try {
            cloud = await chrome.storage.sync.get(['links', 'categories', ...SETTINGS_KEYS, 'syncMetadata', SYNC_CLEARED_AT_KEY]);
        } catch (error) {
            throw Object.assign(error, { area: 'sync' });
        }
        const noMetadata = { version: 0, lastModified: 0 };
        const metadata = { local: local.syncMetadata || noMetadata, remote: cloud.syncMetadata || noMetadata };
        return { local, cloud, metadata };
    }

    // Decide what a sync keeps. chrome.storage.sync is the source of truth:
    // normal edits write sync only, so local is a snapshot from the last
    // manual sync and usually stale. Never let that snapshot win just because
    // the metadata versions match — after any manual sync they always do.
    //
    // Fields with a pending-sync marker (a save that fell back to local) are
    // handled apart: superseded ones are set aside, still-pending ones are
    // pushed on top of whatever the rules below decide for the other fields.
    //
    // Returns { source, data, syncItems, settled, setAside }:
    //   data      links/categories this device's local copy becomes
    //   syncItems what to write to sync (null: nothing)
    //   settled   marked fields that stop being pending after a successful sync
    //   setAside  { fields, reason } for local entries the cloud lacks that are
    //             dropped without being uploaded; syncData keeps and downloads
    //             a copy and tells the user (null otherwise)
    resolveSyncData({ local, cloud, metadata }, { forceStrategy = null, strategy = this.conflictResolutionStrategy } = {}) {
        const fromCloud = () => ({
            source: 'cloud',
            data: { links: cloud.links ?? '[]', categories: cloud.categories ?? '["Default"]' },
            syncItems: null
        });
        const fromLocal = () => ({ source: 'local', data: encodeLists(local), syncItems: encodeLists(local) });
        const merged = (localSide, options) => {
            const data = this.mergeData(localSide, cloud, metadata, options);
            return { source: 'merged', data, syncItems: data };
        };

        // Pending while the cloud still holds the value it had when the save
        // fell back and hasn't been cleared since (same clear stamp).
        const clearedAt = cloud[SYNC_CLEARED_AT_KEY] ?? null;
        const pendingFields = [];
        const staleFields = [];
        for (const field of PENDING_SYNC_FIELDS) {
            const marker = local[pendingSyncKey(field)];
            if (!marker) continue;
            const stillPending = markerMatchesCloud(marker, cloud[field]) && (marker.clearedAt ?? null) === clearedAt;
            (stillPending ? pendingFields : staleFields).push(field);
        }

        const setAside = new Set();
        let cause = null;
        const setAsideWhatCloudLacks = (fields, why) => {
            const lost = fields.filter(field => entriesCloudLacks(local, cloud, field) > 0);
            if (lost.length === 0) return;
            lost.forEach(field => setAside.add(field));
            cause = why;
        };
        setAsideWhatCloudLacks(staleFields, 'superseded');

        let result;
        const settled = [...staleFields];
        if (forceStrategy === 'remote') {
            // Explicit pull: honor it whatever the versions say. Pending local
            // edits are replaced too, but kept as a set-aside copy.
            if (!holdsData(cloud)) throw new Error('The cloud has no links or categories to pull.');
            result = fromCloud();
            setAsideWhatCloudLacks(pendingFields, 'forcePull');
            settled.push(...pendingFields);
        } else if (forceStrategy === 'local') {
            // Explicit push: honor it whatever the versions say.
            if (!holdsData(local)) throw new Error('This device has no local copy to push.');
            result = fromLocal();
        } else {
            // The other fields first; marked fields don't take part.
            const unmarked = { ...local };
            for (const field of [...staleFields, ...pendingFields]) delete unmarked[field];

            if (!metadata.local.version && holdsData(unmarked)) {
                // This device's first sync. Its local data never came from the
                // cloud — it predates sync, or is a save that fell back to local —
                // so merge it in rather than lose it (with an empty cloud, a plain
                // migration). Unless the cloud was cleared (a clear stamp): then
                // its entries the cloud lacks are set aside instead of undoing the
                // clear. An empty cloud with no metadata on a device with a
                // deviceId (what the previous release's clear left) is treated the
                // same way, though it can also be genuine local data: the Sync tab
                // creates a deviceId, so the copy is kept and the user told.
                const legacyClear = !hasEntries(cloud.links) && !metadata.remote.version && !!local.deviceId;
                if (clearedAt !== null || legacyClear) {
                    debug('Cloud was cleared; setting this device\'s local entries aside');
                    result = fromCloud();
                    setAsideWhatCloudLacks(['links', 'categories'], clearedAt !== null ? 'cleared' : 'ambiguous');
                } else {
                    debug('First sync on this device; merging local data into sync');
                    result = merged(unmarked, { preferRemote: true });
                }
            } else if (!forceStrategy && metadata.local.version === metadata.remote.version) {
                debug('No version conflict; using sync storage data');
                result = fromCloud();
            } else {
                // Versions differ (another device synced since this one did), or a
                // merge was forced. The default 'remote' keeps the cloud; 'merge'
                // (resurrects deleted links) and 'local' (reverts the cloud to this
                // device's snapshot) apply only when chosen explicitly.
                debug('Conflict detected, resolving with strategy:', strategy);
                if (strategy === 'local') result = fromLocal();
                else if (strategy === 'merge') result = merged(unmarked);
                else result = fromCloud();
            }

            // Then this device's own newer edits win for their fields (an empty
            // list too).
            if (pendingFields.length > 0) {
                const localLists = encodeLists(local);
                const pendingItems = {
                    ...pick(localLists, pendingFields),
                    ...pick(local, SETTINGS_KEYS.filter(key => pendingFields.includes(key)))
                };
                result = {
                    source: result.source === 'cloud' ? 'pending' : result.source,
                    data: { ...result.data, ...pick(localLists, pendingFields) },
                    syncItems: { ...(result.syncItems ?? {}), ...pendingItems }
                };
                settled.push(...pendingFields);
            }
        }

        // Whatever is uploaded isn't lost.
        for (const field of Object.keys(result.syncItems ?? {})) setAside.delete(field);
        const fields = [...setAside];
        return {
            source: result.source,
            data: withoutJunkLinks(result.data),
            syncItems: result.syncItems ? withoutJunkLinks(result.syncItems) : null,
            settled,
            setAside: fields.length > 0 ? { fields, reason: describeSetAside(fields, cause, local, cloud) } : null
        };
    }

    // An importable copy of the kept data plus this device's values for the
    // set-aside fields: a union of the lists in which this device's version of
    // a link wins (so a superseded edit survives), plus its set-aside settings.
    setAsideCopy({ fields }, { local, cloud, metadata }, kept) {
        const union = this.mergeData(
            pick(local, ['links', 'categories'].filter(field => fields.includes(field))),
            kept, metadata, { preferRemote: false }
        );
        return {
            links: (parseStoredArray(union.links) ?? []).filter(isLinkEntry),
            categories: parseStoredArray(union.categories) ?? ['Default'],
            ...pick(cloud, SETTINGS_KEYS),
            ...pick(local, SETTINGS_KEYS.filter(key => fields.includes(key)))
        };
    }

    // Keep local entries a sync is about to drop without uploading, before
    // anything is replaced: downloaded as a backup file, then stored in
    // chrome.storage.local[SYNC_SET_ASIDE_KEY]. Throws if either step fails,
    // so nothing is replaced without a copy the user can restore. A retry
    // with the same content (already downloaded and stored) does neither again.
    async storeSetAside(setAside, inputs, kept) {
        const backup = {
            ...this.setAsideCopy(setAside, inputs, kept),
            exportDate: new Date().toISOString(),
            reason: setAside.reason
        };
        const { [SYNC_SET_ASIDE_KEY]: latest } = await chrome.storage.local.get(SYNC_SET_ASIDE_KEY);
        if (latest?.downloaded && sameStoredValue(backupContent(latest), backupContent(backup))) {
            debug('Set-aside copy unchanged and already downloaded');
            return;
        }
        if (!this.downloadBackupFile(backup)) {
            throw new Error('Could not download a backup of this device\'s local changes, so they were not replaced.');
        }
        try {
            await this.storeBackup({ ...backup, downloaded: true }, { key: SYNC_SET_ASIDE_KEY, previousKey: SYNC_PREVIOUS_SET_ASIDE_KEY });
        } catch (error) {
            throw new Error(`Could not back up this device's local changes, so they were not replaced (${error.message}).`);
        }
    }

    // Offer a backup as a downloaded file (the manage page's Import reads its
    // top-level links/categories/settings). Returns false when the download
    // can't be started; a cancelled or blocked one can't be detected.
    downloadBackupFile(backup) {
        try {
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `the-codex-backup-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            return true;
        } catch (error) {
            debugWarn('Could not download the backup file:', error);
            return false;
        }
    }

    // Save a backup to chrome.storage.local[key] (SYNC_BACKUP_KEY by default);
    // the backup it replaces moves to previousKey.
    // An identical backup (e.g. a retried clear) is not stored again, so it
    // can't rotate the older one out.
    async storeBackup(backup, { key = SYNC_BACKUP_KEY, previousKey = SYNC_PREVIOUS_BACKUP_KEY } = {}) {
        const { [key]: previous } = await chrome.storage.local.get(key);
        if (previous && sameStoredValue(backupContent(previous), backupContent(backup))) {
            if (backup.downloaded && !previous.downloaded) {
                await chrome.storage.local.set({ [key]: { ...previous, downloaded: true } });
            }
            debug('Backup unchanged; keeping the stored ones');
            return;
        }
        const toStore = { [key]: backup };
        if (previous) toStore[previousKey] = previous;
        await chrome.storage.local.set(toStore);
        debug(`Backup saved to chrome.storage.local["${key}"] (see CodexConsole.localData())`);
    }

    // After a successful sync: drop the pending-sync markers of `fields` (see
    // storageFormat.js), and this device's local copies of those that are
    // settings (only ever written by a save that fell back; the cloud now
    // holds the kept value). Failure only delays it.
    async settleLocalFields(fields) {
        const unique = [...new Set(fields)];
        try {
            await chrome.storage.local.remove([
                ...unique.map(pendingSyncKey),
                ...SETTINGS_KEYS.filter(key => unique.includes(key))
            ]);
        } catch (error) {
            debugWarn('Failed to clear pending-sync markers:', error);
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
        const remoteWins = preferRemote ?? metadata.remote.lastModified > metadata.local.lastModified;

        // Each local link matches at most one remote link, so two distinct
        // remote links sharing an id or URL can't collapse into one. Entries
        // that aren't objects are kept here (resolveSyncData drops them).
        const merged = localLinks.map(link => (isLinkEntry(link) ? { ...link } : link));
        const localCount = merged.length;
        const matched = new Set();
        syncLinks.forEach(link => {
            const existing = isLinkEntry(link)
                ? merged.findIndex((m, i) => i < localCount && !matched.has(i) && isLinkEntry(m) && sameLink(m, link))
                : -1;
            if (existing === -1) {
                merged.push(isLinkEntry(link) ? { ...link } : link);
            } else {
                matched.add(existing);
                if (remoteWins) merged[existing] = { ...link };
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

    // Write `syncItems` to sync storage (if any), then the resolved lists to
    // this device's local copy. Returns { syncSaved: boolean, error?: string };
    // syncSaved is false when the sync write failed, so callers can report the
    // sync as failed.
    async saveResolvedData(data, { syncItems = null } = {}) {
        try {
            debug('Saving resolved data...', {
                hasLinks: !!data.links,
                hasCategories: !!data.categories,
                syncKeys: Object.keys(syncItems ?? {})
            });

            // Sync first: it is the primary storage and the copy every device
            // reads. If it fails, the sync did not happen, and this device's
            // local data (e.g. saves that fell back to local) stays untouched.
            // Only defined fields are written: a missing one is left as is.
            const toSync = pick(syncItems, Object.keys(syncItems ?? {}));
            if (Object.keys(toSync).length > 0) {
                try {
                    await chrome.storage.sync.set(toSync);
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

            // Then this device's local copy, all of it: a field the result
            // lacks becomes empty rather than keeping a stale value.
            try {
                await chrome.storage.local.set({
                    links: data.links ?? JSON.stringify([]),
                    categories: data.categories ?? JSON.stringify(['Default'])
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

    // Back up before a clear: first to chrome.storage.local[SYNC_BACKUP_KEY]
    // (the previous backup moves to SYNC_PREVIOUS_BACKUP_KEY), then as a
    // downloaded file. Its top level, which the manage page's Import restores,
    // holds what Sync now would keep — this device's pending saves, a first
    // sync's merge, otherwise the cloud — and both raw copies are included as
    // cloudCopy and deviceLocalCopy. Throws if the stored
    // copy can't be written; resolves to the download's result. The stored
    // copy is what makes this safe: a cancelled or blocked download raises no
    // error, so the download alone can't gate the clear.
    async backupBeforeClear() {
        let inputs;
        try {
            inputs = await this.readSyncInputs();
        } catch (error) {
            const reason = error.area === 'sync' ? syncStorageErrorEvent(error.message).message : 'Could not read local storage.';
            throw new Error(`${reason} Sync data was not cleared (${error.message}).`);
        }
        const { local, cloud } = inputs;
        const localSettings = pick(local, SETTINGS_KEYS); // only ever written by a failed save
        const nothingToKeep = !hasEntries(cloud.links) && !hasEntries(local.links)
            && onlyDefaultCategories(cloud.categories) && onlyDefaultCategories(local.categories)
            && SETTINGS_KEYS.every(key => cloud[key] === undefined || cloud[key] === SETTINGS_DEFAULTS[key])
            && Object.keys(localSettings).length === 0;
        if (nothingToKeep) {
            // e.g. a second clear: keep the existing backups rather than
            // replacing them with an empty one.
            debug('Nothing to back up; keeping the existing backup');
            return true;
        }

        // What Sync now would keep, plus anything it would set aside, so
        // Import restores everything the clear removes.
        const { data, syncItems, setAside } = this.resolveSyncData(inputs, { strategy: 'remote' });
        const kept = setAside
            ? this.setAsideCopy(setAside, inputs, data)
            : {
                links: parseStoredArray(data.links) ?? [],
                categories: parseStoredArray(data.categories) ?? ['Default'],
                ...pick(cloud, SETTINGS_KEYS)
            };
        const copyOf = (source) => ({
            links: parseStoredArray(source.links) ?? [],
            categories: parseStoredArray(source.categories) ?? [],
            ...pick(source, SETTINGS_KEYS)
        });
        const backup = {
            ...kept,
            ...pick(syncItems, SETTINGS_KEYS),
            exportDate: new Date().toISOString(),
            cloudCopy: copyOf(cloud),
            deviceLocalCopy: copyOf(local)
        };
        try {
            await this.storeBackup(backup);
        } catch (error) {
            throw new Error(`Could not save a backup on this device, so sync data was not cleared (${error.message}).`);
        }

        return this.downloadBackupFile(backup);
    }

    // Clear all sync data (for troubleshooting). chrome.storage.sync is shared
    // by every signed-in device, so this wipes links everywhere: back up first
    // and don't clear anything if that fails.
    async clearSyncData() {
        try {
            if (!await this.backupBeforeClear()) {
                throw new Error('Could not download a backup, so sync data was not cleared.');
            }

            // One write sets every known key to an explicit empty or default
            // value. Chrome applies a single set() all-or-nothing, so a rejected
            // write (e.g. rate-limited) leaves the cloud untouched. Explicit
            // values rather than an empty area: when sync is empty, loadLinks
            // falls back to a device's local snapshot, whose next save would
            // re-upload everything. They also reset open tabs through
            // stateManager's onChanged listener, and SYNC_CLEARED_AT_KEY lets
            // other devices' status show the clear.
            const stamp = Date.now();
            this.lastClearStamp = stamp;
            const cleared = {
                links: JSON.stringify([]),
                categories: JSON.stringify(['Default']),
                ...SETTINGS_DEFAULTS,
                syncMetadata: { version: 0, lastModified: 0 },
                [SYNC_CLEARED_AT_KEY]: stamp
            };
            let cloudKeys;
            try {
                cloudKeys = Object.keys(await chrome.storage.sync.get(null));
                await chrome.storage.sync.set(cleared);
            } catch (syncError) {
                const event = syncStorageErrorEvent(syncError.message);
                throw new Error(`${event.message} (${syncError.message})`);
            }

            // Keys we can't reset by value (e.g. linksView): remove them, best
            // effort. Leaving one behind is harmless, so a failure here doesn't
            // fail the clear.
            const clearedKeys = new Set(Object.keys(cleared));
            const unknown = cloudKeys.filter(key => !clearedKeys.has(key));
            if (unknown.length > 0) {
                try {
                    await chrome.storage.sync.remove(unknown);
                } catch (error) {
                    debugWarn('Could not remove leftover sync keys after a clear:', { keys: unknown, error: error.message });
                }
            }

            // Drop this device's local copy too (snapshot, settings saved by a
            // failed write, pending markers, sync history), so its next Sync
            // now starts from the cleared cloud.
            await chrome.storage.local.remove([
                'syncMetadata', 'lastSyncTime', 'links', 'categories',
                ...SETTINGS_KEYS, ...PENDING_SYNC_FIELDS.map(pendingSyncKey)
            ]);
            // Every open page reloads from storage (stateManager), including
            // one that missed the storage events (e.g. mid-write).
            await chrome.storage.local.set({ [SYNC_RESOLVED_AT_KEY]: Date.now() });
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