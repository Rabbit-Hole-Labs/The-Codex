/**
 * Shared helpers for the on-disk storage format.
 *
 * `links` and `categories` are persisted to chrome.storage as JSON-encoded
 * strings (see storageManager.saveLinks / saveCategories), though a fresh
 * install or an older build may leave a raw array. Both forms are healthy;
 * anything else (an object, a string that doesn't parse to an array) is genuine
 * corruption. Centralizing this avoids code — e.g. the service worker's storage
 * verification — mistaking the normal JSON-string encoding for corruption.
 */

/**
 * Parse a stored links/categories value into an array.
 * @param {*} value - the raw value from chrome.storage
 * @returns {Array|null} the array, or null if the value is not a valid array
 *   (array or JSON-encoded array string)
 */
export function parseStoredArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Pending-sync markers. When a save can't reach chrome.storage.sync and falls
 * back to chrome.storage.local, storageManager stores, per field,
 * `pendingSyncSince.<field>` = { since, cloud, clearedAt }: `cloud` is the JSON
 * of the field's cloud value at that moment ('null' when absent; omitted when
 * it couldn't be read) and `clearedAt` the cloud's SYNC_CLEARED_AT_KEY value
 * (null if never cleared). SyncManager pushes the local value on the next Sync
 * now only while the cloud still holds that same value and hasn't been cleared
 * since — compared for equality, never as device clocks: if anything wrote the
 * field or cleared sync since (this device or another), the copy is superseded.
 * (Markers written by builds before clearedAt was recorded — only unreleased
 * builds of this change — therefore count as superseded: they are set aside,
 * not lost.)
 */

/** Values pages use for settings that storage doesn't hold (as loadLinks does). */
export const STORED_SETTING_DEFAULTS = Object.freeze({ theme: 'dark', view: 'grid', colorTheme: 'default', defaultTileSize: 'medium' });

/** chrome.storage.sync key stamped by Clear sync data: identifies each clear. */
export const SYNC_CLEARED_AT_KEY = 'syncClearedAt';

/**
 * chrome.storage.local key stamped after each successful manual sync or clear.
 * Every open page re-reads storage when it changes (stateManager), since a
 * sync where the cloud wins writes nothing to sync and fires no sync onChanged.
 */
export const SYNC_RESOLVED_AT_KEY = 'syncResolvedAt';
export const PENDING_SYNC_PREFIX = 'pendingSyncSince.';

/** Fields that can be pending: links, categories and the synced settings. */
export const PENDING_SYNC_FIELDS = Object.freeze(['links', 'categories', 'theme', 'view', 'colorTheme', 'defaultTileSize']);

/** Local storage key of a field's pending-sync marker. */
export function pendingSyncKey(field) {
    return `${PENDING_SYNC_PREFIX}${field}`;
}

/** The JSON form a marker records for a cloud value (absent → 'null'). */
export function cloudValueFingerprint(value) {
    return JSON.stringify(value ?? null);
}
