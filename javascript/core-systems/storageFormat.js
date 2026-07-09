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
