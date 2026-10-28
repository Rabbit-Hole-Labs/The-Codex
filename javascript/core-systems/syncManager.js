// Advanced Sync Manager for The Codex
// Handles conflict resolution, versioning, and improved sync strategies

import { debug, debugWarn, debugError } from './debug.js';
import { withPendingSyncLock } from './storageLock.js';
import {
    parseStoredArray, pendingSyncKey, cloudValueFingerprint, PENDING_SYNC_FIELDS,
    SYNC_CLEARED_AT_KEY, SYNC_RESOLVED_AT_KEY, STORED_SETTING_DEFAULTS,
    sameStoredValue, markerMatchesCloud, markerStillPending
} from './storageFormat.js';
import { syncGet, syncGetChecked, syncSet, readSyncLinks, isLinkStorageKey, linksChanged } from './syncStorage.js';
import { downloadJsonFile } from '../features/utils.js';

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
const SETTINGS_DEFAULTS = STORED_SETTING_DEFAULTS;
const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS);

// The defined values of `keys` in `source`.
function pick(source, keys) {
    const picked = {};
    for (const key of keys) {
        if (source?.[key] !== undefined) picked[key] = source[key];
    }
    return picked;
}

// Whether two pending-sync markers are the same one (same fallback save).
// Markers carry a random id; older ones are compared whole.
function sameMarker(a, b) {
    if (a?.id !== undefined || b?.id !== undefined) return a?.id === b?.id;
    return JSON.stringify(a) === JSON.stringify(b);
}

// Stamp SYNC_RESOLVED_AT_KEY so every open page reloads (stateManager).
// chrome.storage fires no onChanged for a write of the value already stored,
// so each stamp must differ from the last, even within one millisecond and
// across pages: callers hold the pending-sync lock.
async function writeResolvedStampLocked(extra = {}) {
    const { [SYNC_RESOLVED_AT_KEY]: last = 0 } = await chrome.storage.local.get(SYNC_RESOLVED_AT_KEY);
    await chrome.storage.local.set({ ...extra, [SYNC_RESOLVED_AT_KEY]: Math.max(Date.now(), last + 1) });
}

function newDeviceId() {
    return `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// A backup's data, without when/why/whether-downloaded, for comparing copies.
function backupContent({ exportDate, reason, downloaded, ...content }) {
    return content;
}

const isLinkEntry = (link) => link !== null && typeof link === 'object';
const sameLink = (a, b) => (a.id != null && a.id === b.id) || a.url === b.url;
/**
 * A link's content apart from its id. A link stored without an id gets a new
 * random one on every load (backfillLinkIds) until a save keeps it, so two
 * copies of an untouched link can differ in id alone — that loses nothing.
 * @param {Object} link
 * @returns {Object}
 */
const withoutId = ({ id, ...content }) => content;

// How many of this device's entries for `field` the cloud lacks: links with
// no cloud link of the same id or URL, or whose cloud counterpart differs
// (e.g. a category move); categories the cloud doesn't list; a setting whose
// value differs.
function entriesCloudLacks(local, cloud, field, { countReorder = false } = {}) {
    if (field === 'links') {
        // Each cloud link answers for one local link: the one with its id,
        // else one with the same content (ids aside). A local link left
        // without an equal counterpart is lost — so a duplicate the cloud
        // holds once still counts, and duplicates in another order don't.
        const unmatched = (parseStoredArray(cloud.links) ?? []).filter(isLinkEntry);
        const take = (matches) => {
            const index = unmatched.findIndex(matches);
            return index === -1 ? null : unmatched.splice(index, 1)[0];
        };
        const localLinks = (parseStoredArray(local.links) ?? []).filter(isLinkEntry);
        const counterparts = localLinks.map(link => (link.id != null ? take(other => other.id === link.id) : null));
        localLinks.forEach((link, i) => {
            counterparts[i] ??= take(other => sameStoredValue(withoutId(other), withoutId(link)));
        });
        return localLinks.filter((link, i) =>
            !counterparts[i] || !sameStoredValue(withoutId(link), withoutId(counterparts[i]))).length;
    }
    if (field === 'categories') {
        const { missing, reordered } = categoryChanges(local, cloud);
        return missing + (countReorder && reordered ? 1 : 0);
    }
    return local[field] !== undefined && !sameStoredValue(local[field], cloud[field]) ? 1 : 0;
}

// Local categories the cloud lacks, and whether the categories both have are
// in a different order (a reorder is a change too).
function categoryChanges(local, cloud) {
    const localCategories = parseStoredArray(local.categories) ?? [];
    const cloudCategories = parseStoredArray(cloud.categories) ?? ['Default'];
    const inCloud = new Set(cloudCategories);
    const inLocal = new Set(localCategories);
    const shared = localCategories.filter(category => inCloud.has(category));
    return {
        missing: localCategories.length - shared.length,
        reordered: JSON.stringify(shared) !== JSON.stringify(cloudCategories.filter(category => inLocal.has(category)))
    };
}

const SETTING_NAMES = { theme: 'theme', view: 'view', colorTheme: 'color theme', defaultTileSize: 'tile size' };
const SET_ASIDE_CAUSES = {
    superseded: 'replaced by newer changes in the cloud',
    forcePull: 'replaced by Force pull',
    cleared: 'not uploaded because the cloud was cleared',
    ambiguous: 'not uploaded because the cloud is empty and may have been cleared by an older version'
};

// "2 links and the theme setting saved only on this device were …"
function describeSetAside(fields, cause, local, cloud, { countReorder = false } = {}) {
    const parts = [];
    let total = 0;
    const count = (n, one, many) => {
        total += n;
        return `${n} ${n === 1 ? one : many}`;
    };
    if (fields.includes('links')) parts.push(count(entriesCloudLacks(local, cloud, 'links'), 'link', 'links'));
    if (fields.includes('categories')) {
        const { missing, reordered } = categoryChanges(local, cloud);
        if (missing > 0) parts.push(count(missing, 'category', 'categories'));
        if (countReorder && reordered) {
            total += 1;
            parts.push('the category order');
        }
    }
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

// A read of the cloud whose links chunks don't match their manifest: another
// device's save has only partly arrived (see syncStorage.js).
const LINKS_ARRIVING_MESSAGE = 'Links saved on another device are still arriving in Chrome sync.';

// syncError payload for a failed chrome.storage.sync read or write.
function syncStorageErrorEvent(rawMessage = '') {
    if (rawMessage.startsWith(LINKS_ARRIVING_MESSAGE)) {
        return {
            type: 'sync_incomplete',
            message: 'Your links are still syncing from another device.',
            details: rawMessage,
            recommendation: 'Try again in a moment.'
        };
    }
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
// A set-aside copy already downloaded for a sync that hasn't completed yet, so
// a retry doesn't download it again; moved to SYNC_SET_ASIDE_KEY on success.
const SYNC_SET_ASIDE_PARKED_KEY = 'syncSetAsideInProgress';
// chrome.storage.sync key stamped by clearSyncData(); compared for equality only.
export { SYNC_CLEARED_AT_KEY };
// chrome.storage.local key holding this device's conflict strategy (the Sync
// tab's select): how Sync now resolves a conflict here. Per device, since
// "This device's last sync wins" names one.
export const SYNC_STRATEGY_KEY = 'syncConflictStrategy';
export const SYNC_STRATEGIES = Object.freeze(['remote', 'merge', 'local']);

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
                (SyncManager.SYNCED_DATA_KEYS.includes(k) || isLinkStorageKey(k)) && change && 'newValue' in change);
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

            // The links can span several sync items, not all in this change:
            // count them from storage.
            let itemsSynced;
            if (linksChanged(changes)) {
                try { itemsSynced = parseStoredArray((await readSyncLinks()).value)?.length; } catch { /* leave undefined */ }
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
            await withPendingSyncLock(async () => {
                const markers = await chrome.storage.local.get(PENDING_SYNC_FIELDS.map(pendingSyncKey));
                const invalidated = Object.fromEntries(Object.entries(markers)
                    .map(([key, marker]) => [key, { id: marker?.id, since: marker?.since }]));
                if (Object.keys(invalidated).length > 0) await chrome.storage.local.set(invalidated);
            });
        } catch (error) {
            debugError('Failed to reset sync status after a remote clear:', error);
        }
        this.notifyListeners('syncCleared', { time: Date.now(), remote: true });
    }

    /**
     * This device's conflict strategy: the saved choice, else the current
     * one ('remote' by default). Read at each sync, so a choice made on any
     * page of this device applies.
     * @returns {Promise<'remote'|'merge'|'local'>}
     */
    async getConflictResolutionStrategy() {
        try {
            const { [SYNC_STRATEGY_KEY]: saved } = await chrome.storage.local.get(SYNC_STRATEGY_KEY);
            if (SYNC_STRATEGIES.includes(saved)) this.conflictResolutionStrategy = saved;
        } catch (error) {
            debugWarn('Could not read the saved conflict strategy:', error);
        }
        return this.conflictResolutionStrategy;
    }

    /**
     * Save this device's conflict strategy. Throws if it can't be saved, so
     * the caller doesn't show a choice that won't stick.
     * @param {'remote'|'merge'|'local'} strategy
     * @returns {Promise<void>}
     */
    async setConflictResolutionStrategy(strategy) {
        if (!SYNC_STRATEGIES.includes(strategy)) throw new Error(`Unknown conflict strategy: ${strategy}`);
        await chrome.storage.local.set({ [SYNC_STRATEGY_KEY]: strategy });
        this.conflictResolutionStrategy = strategy;
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
            const sync = await syncGet(['syncMetadata']);

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

    // Get or create device ID for conflict resolution
    async getDeviceId() {
        try {
            const { deviceId } = await chrome.storage.local.get(['deviceId']);
            if (deviceId) return deviceId;

            const newId = newDeviceId();
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

            // Determine sync strategy (this device's saved choice)
            const strategy = forceStrategy || await this.getConflictResolutionStrategy();
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

            // Nothing changes until the cloud has accepted this sync. Local
            // entries the cloud lacks that are dropped without being uploaded are
            // downloaded first (no backup, no replacement). Then the changed
            // fields and the new version go to sync in ONE write, which Chrome
            // applies all-or-nothing: a rejected write (quota, rate limit) leaves
            // both areas as they were. Only then is this device's copy updated.
            const parkedSetAside = resolution.setAside
                ? await this.prepareSetAside(resolution.setAside, inputs, resolvedData)
                : null;

            // A Force pull from a cloud that holds only settings changes no
            // lists and records no sync (no new version on either side): a
            // never-synced device then still merges its lists on its next sync.
            const now = Date.now();
            const newMetadata = resolution.keepLocalLists
                ? null
                : { version: now, lastModified: now, deviceId: inputs.local.deviceId ?? newDeviceId() };
            if (newMetadata || resolution.syncItems) {
                const cloudResult = await this.writeCloud(resolution.syncItems, newMetadata);
                if (!cloudResult.syncSaved) {
                    // Already reported: fail, with nothing changed.
                    throw Object.assign(new Error(cloudResult.error), { reported: true });
                }
            }

            // From here on the cloud has this sync: record it locally first
            // (the version on its own, then the kept lists), so a later local
            // failure can't leave this device looking unsynced — a first sync
            // would then merge again and bring back links deleted since.
            // Pushed, superseded or set-aside fields stop being pending.
            const markerKeys = PENDING_SYNC_FIELDS.map(pendingSyncKey);
            await this.writeLocal(resolvedData, newMetadata, {
                readMarkers: pick(inputs.local, markerKeys),
                cloudRead: inputs.cloud,
                pushed: resolution.syncItems ?? {},
                keepLocalLists: resolution.keepLocalLists,
                settle: [
                    ...(resolution.keepLocalLists ? [] : ['links', 'categories']),
                    ...resolution.settled,
                    ...Object.keys(resolution.syncItems ?? {})
                ]
            });
            // Then keep the set-aside copy on this device. It was already
            // downloaded (and parked) before the cloud write, so a failure here
            // is logged and doesn't fail the sync. With no set-aside this time,
            // a copy parked by an earlier attempt is kept if that attempt got
            // past the cloud write (afterCloud), else dropped.
            let setAsideKept = false;
            if (parkedSetAside) {
                setAsideKept = await this.commitSetAside(parkedSetAside);
            } else {
                await this.settleParkedSetAside();
            }

            const syncedItemsCount = (parseStoredArray(resolvedData.links) ?? []).length;
            const warning = resolution.setAside
                ? `${resolution.setAside.reason} A copy was ${setAsideKept ? 'saved on this device and ' : ''}`
                    + 'downloaded as a backup file (restore it with Import on the Manage page).'
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
        let linksConsistent;
        try {
            ({ data: cloud, consistent: linksConsistent } = await syncGetChecked(['links', 'categories', ...SETTINGS_KEYS, 'syncMetadata', SYNC_CLEARED_AT_KEY]));
        } catch (error) {
            throw Object.assign(error, { area: 'sync' });
        }
        // Deciding from half of another device's save could drop or upload a
        // mixed list: wait for the rest (it syncs as one write).
        if (!linksConsistent) {
            throw Object.assign(new Error(`${LINKS_ARRIVING_MESSAGE} Try again in a moment.`), { area: 'sync' });
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
        // This device's local copy: its lists plus the settings it holds that
        // are still marked pending. An unmarked local setting is stale (its
        // save reached sync later, or an older build wrote it) and would revert
        // a newer choice on every device.
        const markedSettings = SETTINGS_KEYS.filter(key => local[pendingSyncKey(key)] !== undefined);
        const fromLocal = () => ({
            source: 'local',
            data: encodeLists(local),
            syncItems: { ...encodeLists(local), ...pick(local, markedSettings) }
        });
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
            (markerStillPending(marker, cloud, field) ? pendingFields : staleFields).push(field);
        }

        const setAside = new Set();
        let cause = null;
        // A category reorder is a change worth keeping only when this device
        // made it deliberately: a marked (fallback) save, or one Force pull
        // replaces. Unmarked categories that only differ in order aren't.
        let countReorder = false;
        const setAsideWhatCloudLacks = (fields, why) => {
            const reorderCounts = why === 'superseded' || why === 'forcePull';
            const lost = fields.filter(field => entriesCloudLacks(local, cloud, field, { countReorder: reorderCounts }) > 0);
            if (lost.length === 0) return;
            lost.forEach(field => setAside.add(field));
            cause = why;
            if (reorderCounts && lost.includes('categories')) countReorder = true;
        };
        setAsideWhatCloudLacks(staleFields, 'superseded');

        let result;
        const settled = [...staleFields];
        if (forceStrategy === 'remote') {
            // Explicit pull: honor it whatever the versions say. Pending local
            // edits are replaced too, but kept as a set-aside copy.
            if (holdsData(cloud)) {
                result = fromCloud();
                setAsideWhatCloudLacks(pendingFields, 'forcePull');
                settled.push(...pendingFields);
            } else if (Object.keys(pick(cloud, SETTINGS_KEYS)).length > 0) {
                // The cloud holds only settings: pull those, and leave this
                // device's lists (and their markers) as they are — there are no
                // cloud lists to replace them with.
                const pendingSettings = pendingFields.filter(field => SETTINGS_KEYS.includes(field));
                result = { source: 'cloud', data: encodeLists(local), syncItems: null, keepLocalLists: true };
                setAsideWhatCloudLacks(pendingSettings, 'forcePull');
                settled.push(...pendingSettings);
            } else {
                throw new Error('The cloud has no links, categories or settings to pull.');
            }
        } else if (forceStrategy === 'local') {
            // Explicit push: honor it whatever the versions say.
            if (!holdsData(local) && Object.keys(pick(local, markedSettings)).length === 0) {
                throw new Error('This device has no local copy to push.');
            }
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

        // Whatever is uploaded isn't lost, and lists left in place aren't either.
        for (const field of Object.keys(result.syncItems ?? {})) setAside.delete(field);
        const keepLocalLists = result.keepLocalLists === true;
        const isList = (field) => field === 'links' || field === 'categories';
        if (keepLocalLists) ['links', 'categories'].forEach(field => setAside.delete(field));
        const fields = [...setAside];
        return {
            source: result.source,
            data: withoutJunkLinks(result.data),
            syncItems: result.syncItems ? withoutJunkLinks(result.syncItems) : null,
            settled: keepLocalLists ? settled.filter(field => !isList(field)) : settled,
            keepLocalLists,
            setAside: fields.length > 0
                ? { fields, reason: describeSetAside(fields, cause, local, cloud, { countReorder }) }
                : null
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

    // Before a sync drops local entries without uploading them: download a copy
    // (throws if that fails, so nothing is replaced). The copy is parked in
    // chrome.storage.local, so a retry after a rejected sync write doesn't
    // download it again; commitSetAside() keeps it once the sync went through.
    async prepareSetAside(setAside, inputs, kept) {
        const backup = {
            ...this.setAsideCopy(setAside, inputs, kept),
            exportDate: new Date().toISOString(),
            reason: setAside.reason
        };
        const { [SYNC_SET_ASIDE_PARKED_KEY]: parked } = await chrome.storage.local.get(SYNC_SET_ASIDE_PARKED_KEY);
        if (parked?.downloaded && sameStoredValue(backupContent(parked), backupContent(backup))) {
            debug('Set-aside copy already downloaded for an earlier attempt');
            return parked;
        }
        if (!this.downloadBackupFile(backup)) {
            throw new Error('Could not download a backup of this device\'s local changes, so they were not replaced.');
        }
        const downloaded = { ...backup, downloaded: true };
        try {
            await chrome.storage.local.set({ [SYNC_SET_ASIDE_PARKED_KEY]: downloaded });
        } catch (error) {
            debugWarn('Could not park the set-aside copy (a retry would download it again):', error);
        }
        return downloaded;
    }

    // After a successful sync: keep the set-aside copy in
    // chrome.storage.local[SYNC_SET_ASIDE_KEY] (rotating the previous one) and
    // drop the parked one. Best effort: the copy was downloaded before the
    // cloud write, so a failure here is logged (the parked copy stays) and
    // doesn't undo a sync the cloud has already taken.
    // Returns whether the copy was kept. On failure it stays parked, marked
    // afterCloud (this device's data was replaced), so a later sync or clear
    // keeps it instead of dropping it.
    async commitSetAside(backup) {
        try {
            await this.storeBackup(backup, { key: SYNC_SET_ASIDE_KEY, previousKey: SYNC_PREVIOUS_SET_ASIDE_KEY });
        } catch (error) {
            debugWarn('Could not keep the set-aside copy on this device (it was downloaded):', error);
            try {
                await chrome.storage.local.set({ [SYNC_SET_ASIDE_PARKED_KEY]: { ...backup, afterCloud: true } });
            } catch {
                // best effort: the copy was downloaded
            }
            return false;
        }
        await this.discardParkedSetAside();
        return true;
    }

    // A copy parked by an earlier attempt: keep it if that attempt replaced
    // this device's data (afterCloud), drop it if it never got that far.
    async settleParkedSetAside() {
        let leftover;
        try {
            ({ [SYNC_SET_ASIDE_PARKED_KEY]: leftover } = await chrome.storage.local.get(SYNC_SET_ASIDE_PARKED_KEY));
        } catch (error) {
            debugWarn('Could not read the parked set-aside copy:', error);
            return;
        }
        if (leftover?.afterCloud) {
            const copy = { ...leftover };
            delete copy.afterCloud;
            await this.commitSetAside(copy);
        } else if (leftover) {
            await this.discardParkedSetAside();
        }
    }

    async discardParkedSetAside() {
        try {
            await chrome.storage.local.remove(SYNC_SET_ASIDE_PARKED_KEY);
        } catch (error) {
            debugWarn('Could not clear the parked set-aside copy:', error);
        }
    }

    // Offer a backup as a downloaded file (the manage page's Import reads its
    // top-level links/categories/settings). Returns false when the download
    // can't be started; a cancelled or blocked one can't be detected.
    downloadBackupFile(backup) {
        try {
            downloadJsonFile(JSON.stringify(backup, null, 2), `the-codex-backup-${new Date().toISOString().slice(0, 10)}.json`);
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

    // The cloud side of a sync: the changed fields plus the new version in one
    // chrome.storage.sync.set, which Chrome applies all-or-nothing. Fields not
    // in syncItems are left as they are. Returns { syncSaved, error }.
    async writeCloud(syncItems, metadata) {
        try {
            await syncSet({ ...pick(syncItems, Object.keys(syncItems ?? {})), syncMetadata: metadata });
            debug('Sync data and version saved to sync storage');
            return { syncSaved: true };
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

    // This device's side, once the cloud has accepted the sync: the new
    // version on its own first, then the kept lists (a field the result lacks
    // becomes empty rather than stale), then the settled fields, then the stamp
    // that makes open pages reload. A fallback save that landed while this sync
    // ran (its marker differs from the one the sync read) is newer than what
    // the sync read, so that field is left alone, marker included, for the next
    // sync — re-fingerprinted to what this sync pushed when it was based on the
    // value the sync replaced, so the next sync pushes it rather than setting
    // it aside. The pending-sync lock (storageLock.js) keeps fallback saves out
    // of this phase; markers are re-checked before settling all the same.
    async writeLocal(data, metadata, options) {
        await withPendingSyncLock(() => this.writeLocalLocked(data, metadata, options));
    }

    async writeLocalLocked(data, metadata, { readMarkers = {}, cloudRead = {}, pushed = {}, settle, keepLocalLists = false }) {
        const markerKeys = PENDING_SYNC_FIELDS.map(pendingSyncKey);
        const changedSinceRead = (markers) => PENDING_SYNC_FIELDS.filter(field => {
            const marker = markers[pendingSyncKey(field)];
            return marker !== undefined && !sameMarker(marker, readMarkers[pendingSyncKey(field)]);
        });
        const reportLocalFailure = (localError) => {
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
        };

        const current = await chrome.storage.local.get(markerKeys);
        const savedDuringSync = changedSinceRead(current);

        if (metadata) {
            try {
                await chrome.storage.local.set({ syncMetadata: metadata, deviceId: metadata.deviceId });
            } catch (localError) {
                reportLocalFailure(localError);
                throw localError;
            }
        }

        const lists = keepLocalLists ? {} : {
            links: data.links ?? JSON.stringify([]),
            categories: data.categories ?? JSON.stringify(['Default'])
        };
        const refingerprinted = {};
        for (const field of savedDuringSync) {
            delete lists[field];
            const key = pendingSyncKey(field);
            if (field in pushed && markerMatchesCloud(current[key], cloudRead[field])) {
                refingerprinted[key] = { ...current[key], cloud: cloudValueFingerprint(pushed[field]) };
            }
        }
        try {
            await chrome.storage.local.set({ ...lists, ...refingerprinted });
            debug('Data saved to local storage successfully');
        } catch (localError) {
            reportLocalFailure(localError);
            throw localError;
        }

        const stillPending = new Set([...savedDuringSync, ...changedSinceRead(await chrome.storage.local.get(markerKeys))]);
        await this.settleLocalFields(settle.filter(field => !stillPending.has(field)));

        // Tell every open page to reload what storage holds now
        // (stateManager): when the cloud won there was no data written to
        // sync, so no sync onChanged reaches pages still holding discarded data.
        this.lastSyncTime = Date.now();
        await writeResolvedStampLocked({ lastSyncTime: this.lastSyncTime });
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
            const { links } = await syncGet('links');
            if (Array.isArray(links)) return links.length > 0;
            if (typeof links === 'string') {
                try { return JSON.parse(links).length > 0; } catch { return false; }
            }
            return false;
        } catch {
            return false;
        }
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
            throw new Error(`${reason} Sync data was not cleared (${error.message}).`, { cause: error });
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
            throw new Error(`Could not save a backup on this device, so sync data was not cleared (${error.message}).`, { cause: error });
        }

        return this.downloadBackupFile(backup);
    }

    // Clear all sync data (for troubleshooting). chrome.storage.sync is shared
    // by every signed-in device, so this wipes links everywhere: back up first
    // and don't clear anything if that fails.
    async clearSyncData() {
        try {
            // A set-aside copy still parked after a sync that replaced this
            // device's data is kept before the clear removes the parked slot.
            await this.settleParkedSetAside();
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
                await syncSet(cleared);
            } catch (syncError) {
                const event = syncStorageErrorEvent(syncError.message);
                throw new Error(`${event.message} (${syncError.message})`, { cause: syncError });
            }

            // Keys we can't reset by value (e.g. linksView): remove them, best
            // effort. Leaving one behind is harmless, so a failure here doesn't
            // fail the clear. The links' chunk keys stay: the write above
            // already blanked them, and removing one could hit a save another
            // device makes meanwhile.
            const clearedKeys = new Set(Object.keys(cleared));
            const unknown = cloudKeys.filter(key => !clearedKeys.has(key) && !isLinkStorageKey(key));
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
                'syncMetadata', 'lastSyncTime', 'links', 'categories', SYNC_SET_ASIDE_PARKED_KEY,
                ...SETTINGS_KEYS, ...PENDING_SYNC_FIELDS.map(pendingSyncKey)
            ]);
            // Every open page reloads from storage (stateManager), including
            // one that missed the storage events (e.g. mid-write).
            await withPendingSyncLock(() => writeResolvedStampLocked());
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