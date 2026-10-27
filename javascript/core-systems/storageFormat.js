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
 * Allowed values for the persisted display settings. Single source of truth:
 * stateManager's validation schemas reference these, and every LOAD path
 * coerces stored values against them (see coerceSettings). Narrowing one of
 * these lists without load-time coercion is how a pre-7.0.0.24 colorTheme
 * used to fail startup validation and blank the new tab.
 */
export const SETTING_ENUMS = Object.freeze({
    theme: Object.freeze(['dark', 'light']),
    // Accent preset. 'default' is kept for backward-compat with data saved
    // before the accent presets replaced the old color themes.
    colorTheme: Object.freeze(['default', 'slate', 'blue', 'teal', 'violet', 'amber']),
    view: Object.freeze(['grid', 'list']),
    defaultTileSize: Object.freeze(['compact', 'small', 'medium', 'large', 'square', 'wide', 'tall', 'giant'])
});

export const SETTING_DEFAULTS = Object.freeze({
    theme: 'dark',
    colorTheme: 'default',
    view: 'grid',
    defaultTileSize: 'medium'
});

/**
 * colorTheme values accepted before the accent presets (7.0.0.24). Users who
 * picked one still have it stored; the service worker rewrites exactly these
 * to 'default' on update, and loads coerce them in memory regardless.
 */
export const LEGACY_COLOR_THEMES = Object.freeze([
    'ocean', 'cosmic', 'sunset', 'forest', 'fire', 'aurora',
    'theme-purple', 'theme-pink', 'theme-green', 'theme-orange', 'theme-teal',
    'theme-focus',
    'theme-dark-orange', 'theme-dark-purple', 'theme-dark-emerald',
    'theme-dark-crimson', 'theme-dark-sapphire'
]);

/** Maximum category name length (matches the links/categories schemas). */
export const MAX_CATEGORY_LENGTH = 50;

/**
 * Coerce stored display settings field by field: a value outside its enum
 * (absent, legacy, or corrupt) falls back to that field's default without
 * affecting the others. In-memory only — callers must never persist the result
 * of a load.
 * @param {Object} raw - object with theme/colorTheme/view/defaultTileSize
 * @returns {{settings: Object, coerced: string[]}} the valid settings, plus the
 *   keys that held a present-but-invalid value (for logging)
 */
export function coerceSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = {};
    const coerced = [];
    for (const [key, allowed] of Object.entries(SETTING_ENUMS)) {
        const value = source[key];
        if (allowed.includes(value)) {
            settings[key] = value;
        } else {
            settings[key] = SETTING_DEFAULTS[key];
            if (value !== undefined && value !== null && value !== '') coerced.push(key);
        }
    }
    return { settings, coerced };
}

/**
 * Give every link object a usable, unique id in memory, in place: one stored
 * without an id (missing, null, '' …), or with an id an earlier link already
 * uses (importLinks keeps supplied ids as-is), gets a fresh one. The pages
 * resolve a rendered tile back to its stored entry by id, so ids must be
 * unique in memory or a drag/edit can hit the wrong record. The new id
 * persists only with the next real save of the links — never on load.
 * @param {Array} links - parsed links array (entries may be non-objects)
 * @returns {Array} the same array
 */
export function backfillLinkIds(links) {
    const seen = new Set();
    links.forEach((link, i) => {
        if (!link || typeof link !== 'object') return;
        if (!link.id || seen.has(link.id)) {
            do {
                link.id = `link_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
            } while (seen.has(link.id));
        }
        seen.add(link.id);
    });
    return links;
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
export const STORED_SETTING_DEFAULTS = SETTING_DEFAULTS;

/** chrome.storage.sync key stamped by Clear sync data: identifies each clear. */
export const SYNC_CLEARED_AT_KEY = 'syncClearedAt';

/**
 * chrome.storage.local key stamped after each successful manual sync or clear.
 * Every open page re-reads storage when it changes (stateManager), since a
 * sync where the cloud wins writes nothing to sync and fires no sync onChanged.
 */
export const SYNC_RESOLVED_AT_KEY = 'syncResolvedAt';
const PENDING_SYNC_PREFIX = 'pendingSyncSince.';

/** Fields that can be pending: links, categories and the synced settings. */
export const PENDING_SYNC_FIELDS = Object.freeze(['links', 'categories', ...Object.keys(SETTING_ENUMS)]);

/** Local storage key of a field's pending-sync marker. */
export function pendingSyncKey(field) {
    return `${PENDING_SYNC_PREFIX}${field}`;
}

/** The JSON form a marker records for a cloud value (absent → 'null'). */
export function cloudValueFingerprint(value) {
    return JSON.stringify(value ?? null);
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

/** Whether two stored values hold the same content (see canonical). */
export function sameStoredValue(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Whether the cloud still holds the value a pending-sync marker recorded.
 * A marker without a readable recorded value can't tell, so it never matches.
 */
export function markerMatchesCloud(marker, cloudValue) {
    if (typeof marker?.cloud !== 'string') return false;
    try {
        return sameStoredValue(JSON.parse(marker.cloud), cloudValue);
    } catch {
        return false;
    }
}

/**
 * Whether a field's pending-sync marker is still pending: the cloud holds the
 * value it had when the save fell back and hasn't been cleared since (same
 * clear stamp), so Sync now pushes this device's value. Otherwise the marker
 * is superseded and Sync now sets the local value aside instead.
 * @param {Object} marker - local `pendingSyncSince.<field>` value
 * @param {Object} cloud - chrome.storage.sync data (links reassembled), with
 *   the field and SYNC_CLEARED_AT_KEY
 * @param {string} field
 * @returns {boolean}
 */
export function markerStillPending(marker, cloud, field) {
    return markerMatchesCloud(marker, cloud[field])
        && (marker.clearedAt ?? null) === (cloud[SYNC_CLEARED_AT_KEY] ?? null);
}
