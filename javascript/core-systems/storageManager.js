import { syncManager } from './syncManager.js';
import { handleError, CodexError } from '../features/errorHandler.js';
import errorHandler from '../features/errorHandler.js';
import { validateAndSanitizeUrl, downloadJsonFile } from '../features/utils.js';
import { sanitizeUserInput } from '../features/securityUtils.js';
import { validateIconValue } from '../features/iconCache.js';
import { debug, debugWarn, debugError } from './debug.js';
import { pendingSyncKey, cloudValueFingerprint, SYNC_CLEARED_AT_KEY, coerceSettings, backfillLinkIds, SETTING_ENUMS, parseStoredArray } from './storageFormat.js';
import { withPendingSyncLock, withLinksWriteLock } from './storageLock.js';
import { syncGet, syncSet, readSyncLinks } from './syncStorage.js';
const { ERROR_TYPES, ERROR_SEVERITY } = errorHandler;

// The cloud values a save is based on, read BEFORE its sync write: if that
// write fails, the pending-sync marker must certify the local edit against
// this value, not against whatever another device wrote in the meantime.
// Null when unreadable: SyncManager then can't confirm the save is still
// newest, keeps the cloud and sets the local copy aside.
async function cloudBeforeSave(fields) {
    try {
        return await syncGet([...fields, SYNC_CLEARED_AT_KEY]);
    } catch {
        return null;
    }
}

// Ids of the pending-sync markers this page wrote (field -> id). Each page
// (module instance) knows only its own: a later successful save from this page
// supersedes them, but must not discard another page's pending edit.
const knownMarkerIds = new Map();

// Pending-sync markers for fields a save could only write to local storage
// (see storageFormat.js); SyncManager pushes them on the next Sync now. Each
// gets a random id: two pages can fall back in the same millisecond.
function pendingSyncMarkers(fields, cloud) {
    const markers = {};
    for (const field of fields) {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        markers[pendingSyncKey(field)] = cloud
            ? { id, since: Date.now(), cloud: cloudValueFingerprint(cloud[field]), clearedAt: cloud[SYNC_CLEARED_AT_KEY] ?? null }
            : { id, since: Date.now() };
    }
    return markers;
}

// Write a save's fallback (its value plus markers) under the pending-sync
// lock, and remember the markers as this page's own.
async function writeFallback(values, fields, cloudBefore) {
    const markers = pendingSyncMarkers(fields, cloudBefore);
    await withPendingSyncLock(() => chrome.storage.local.set({ ...values, ...markers }));
    for (const field of fields) knownMarkerIds.set(field, markers[pendingSyncKey(field)].id);
}

// A field that reached sync is no longer pending — as far as this page's own
// fallback saves go. A marker another page wrote (or one from before this page
// loaded) stays: this save didn't include that edit, and the next Sync now
// finds the marker superseded and sets the edit aside instead of losing it.
// For settings, a local copy left by a failed save is dropped with its marker
// (or when unmarked: stale), so a later Force push can't upload it over this
// newer value. Lists instead pass `mirror` (field -> the value just saved to
// sync): this device's local copy of each settled list becomes that value, so
// it holds what the device shows rather than the snapshot of its last sync —
// which a Force push or a merge would otherwise restore, bringing back links
// deleted since. A field another page's marker still holds is left alone (its
// local value is that page's unsynced edit), and so is a device that never
// synced: its first Sync now merges local into the cloud, which would bring
// back what other devices delete meanwhile. A sync that read the cloud before
// this save can still write its older lists over the mirror; the next save
// mirrors again. Read, compare and write happen under the pending-sync lock.
async function clearPendingSync(fields, { localCopies = false, mirror = {} } = {}) {
    try {
        await withPendingSyncLock(async () => {
            const markers = await chrome.storage.local.get(fields.map(pendingSyncKey));
            const settled = fields.filter(field => {
                const marker = markers[pendingSyncKey(field)];
                return !marker || (marker.id !== undefined && marker.id === knownMarkerIds.get(field));
            });
            settled.forEach(field => knownMarkerIds.delete(field));
            if (settled.length > 0) {
                await chrome.storage.local.remove([...settled.map(pendingSyncKey), ...(localCopies ? settled : [])]);
            }
            const toMirror = settled.filter(field => field in mirror);
            if (toMirror.length > 0) {
                const { syncMetadata } = await chrome.storage.local.get('syncMetadata');
                if (syncMetadata?.version) {
                    await chrome.storage.local.set(Object.fromEntries(toMirror.map(field => [field, mirror[field]])));
                }
            }
        });
    } catch (error) {
        debugWarn('Failed to clear pending-sync markers', { errorMessage: error.message });
    }
}

// A stored links/categories value as an array (see parseStoredArray), or
// null when it is absent or corrupted; corruption is logged.
function storedArray(value, label) {
    if (!value) return null;
    const parsed = parseStoredArray(value);
    if (!parsed) {
        debugWarn(`STORAGE_MANAGER: Storage corruption detected: ${label} data is not an array or a JSON array string`, {
            dataType: typeof value,
            sampleData: typeof value === 'string' ? value.substring(0, 100) : undefined
        });
    }
    return parsed;
}

export async function loadLinks() {
    try {
        debug('STORAGE_MANAGER: Starting to load links from storage');
        let data = await syncGet(['links', 'theme', 'view', 'colorTheme', 'defaultTileSize', 'categories']);
        debug('STORAGE_MANAGER: Raw data loaded from sync storage', {
            hasLinks: !!data.links,
            linksType: data.links ? typeof data.links : 'undefined',
            linksLength: Array.isArray(data.links) ? data.links.length : (typeof data.links === 'string' ? data.links.length : 'N/A'),
            hasCategories: !!data.categories
        });

        if (!data || Object.keys(data).length === 0) {
            debug('STORAGE_MANAGER: No data in sync storage, trying local storage');
            data = await chrome.storage.local.get(['links', 'theme', 'view', 'colorTheme', 'defaultTileSize', 'categories']);
            debug('STORAGE_MANAGER: Data loaded from local storage', {
                hasLinks: !!data.links,
                linksType: data.links ? typeof data.links : 'undefined',
                hasCategories: !!data.categories
            });
        }

        // A corrupted value (an object, a non-array JSON string, unparseable
        // JSON) reads as empty: links [], categories ['Default'].
        const links = storedArray(data.links, 'links') ?? [];
        debug('STORAGE_MANAGER: Links ready', { linksCount: links.length });

        const categories = storedArray(data.categories, 'categories') ?? ['Default'];
        // Ensure Default category exists
        if (!categories.includes('Default')) {
            categories.unshift('Default');
        }

        // Ensure every link has a stable id. The manage page resolves a rendered
        // row back to its stored entry by id; without one it falls back to a
        // brittle object-reference match that fails against JSON-cloned state
        // snapshots (see linkManager.resolveLinkIndex). Ids persist on next save.
        // Any falsy id ('' too) counts as missing, and so does a duplicate.
        backfillLinkIds(links);

        debug('STORAGE_MANAGER: Final links data ready for return', {
            linksCount: links.length,
            categoriesCount: categories.length,
            hasInvalidLinks: links.some(link => !link || typeof link !== 'object')
        });

        // Coerce each setting independently: one unknown value (e.g. a
        // colorTheme from before the accent presets) must fall back to its own
        // default, not fail startup validation for everything. In-memory only.
        const { settings, coerced } = coerceSettings(data);
        if (coerced.length > 0) {
            console.warn('[The Codex] Ignoring unsupported stored setting(s), using defaults in memory:',
                Object.fromEntries(coerced.map(key => [key, data[key]])));
        }

        return {
            links: links,
            ...settings,
            categories: categories
        };
    } catch (error) {
        debugError('STORAGE_MANAGER: Storage load error: failed to load data from storage', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return { links: [], theme: 'dark', view: 'grid', colorTheme: 'default', defaultTileSize: 'medium', categories: ['Default'] };
    }
}

/**
 * Save the links to sync. When the sync write fails the links are kept on
 * this device with a pending-sync marker, unless `fallback` is false (a
 * background save that can simply try again): it then returns false and
 * leaves local storage alone.
 * @param {Object[]} links
 * @param {{ fallback?: boolean }} [options]
 * @returns {Promise<boolean>} whether the links were saved
 */
export function saveLinks(links, options) {
    return withLinksWriteLock(() => writeLinks(links, options));
}

/**
 * Change the synced links in one step: read them, let `transform` return the
 * new list (or null for no change), and save it — with no other save from
 * this browser in between. Never falls back to local storage.
 * @param {(links: Object[]) => (Object[]|null|Promise<Object[]|null>)} transform
 * @returns {Promise<boolean>} whether a changed list was saved
 */
export function updateSyncedLinks(transform) {
    return withLinksWriteLock(async () => {
        const { value, consistent } = await readSyncLinks();
        const links = consistent ? parseStoredArray(value) : null;
        if (!links) return false;
        const updated = await transform(links);
        return updated ? writeLinks(updated, { fallback: false }) : false;
    });
}

// saveLinks without the links-write lock (its callers hold it).
async function writeLinks(links, { fallback = true } = {}) {
    try {
        // Validate links is an array before saving
        if (!Array.isArray(links)) {
            const validationError = new CodexError(
                'Links validation failed: data must be an array',
                ERROR_TYPES.VALIDATION,
                ERROR_SEVERITY.HIGH,
                {
                    receivedType: typeof links,
                    receivedValue: links
                }
            );
            handleError(validationError, {
                context: 'storage-save-links',
                showUserNotification: true,
                logToConsole: true
            });
            throw validationError;
        }

        const linksString = JSON.stringify(links);

        // Validate data before saving
        if (!linksString) {
            const dataError = new CodexError(
                'Links serialization failed: resulting string is empty',
                ERROR_TYPES.STORAGE,
                ERROR_SEVERITY.HIGH,
                {
                    linksLength: links.length
                }
            );
            handleError(dataError, {
                context: 'storage-save-links',
                showUserNotification: true,
                logToConsole: true
            });
            throw dataError;
        }

        // Try sync storage first (primary storage). syncSet splits the links
        // across several sync items when they outgrow Chrome's 8 KB per item.
        const cloudBefore = await cloudBeforeSave(['links']);
        try {
            await syncSet({ links: linksString });
            await clearPendingSync(['links'], { mirror: { links: linksString } });
        } catch (syncError) {
            if (!fallback) {
                debugWarn('Sync storage failed; not saved', { errorMessage: syncError.message });
                return false;
            }
            debugWarn('Sync storage failed, falling back to local storage', {
                errorMessage: syncError.message,
                errorStack: syncError.stack
            });
            if (/QUOTA_BYTES|kQuotaBytes/.test(syncError.message ?? '')) {
                console.warn(`[The Codex] Links (${Math.round(linksString.length / 1024)} KB) don't fit in Chrome sync storage; `
                    + 'saved on this device only. Sync now uploads them once there is room.', syncError.message);
            }
            
            // Fallback to local storage
            try {
                await writeFallback({ links: linksString }, ['links'], cloudBefore);
                debug('Successfully saved to local storage as fallback');
            } catch (localError) {
                const storageError = new CodexError(
                    'Failed to save links to both sync and local storage',
                    ERROR_TYPES.STORAGE,
                    ERROR_SEVERITY.CRITICAL,
                    {
                        syncError: syncError.message,
                        localError: localError.message
                    }
                );
                handleError(storageError, {
                    context: 'storage-save-links',
                    showUserNotification: true,
                    logToConsole: true
                });
                throw storageError;
            }
        }

        return true;
    } catch (error) {
        debugError('Storage save error: failed to save links data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

export async function saveSettings(settings) {
    try {
        const dataToSave = {};

        // Only save valid settings
        for (const [key, allowed] of Object.entries(SETTING_ENUMS)) {
            if (allowed.includes(settings[key])) {
                dataToSave[key] = settings[key];
            }
        }

        // Validate that we have something to save
        if (Object.keys(dataToSave).length === 0) {
            debugWarn('Settings save warning: no valid settings to save', {
                receivedSettings: settings
            });
            return true; // Not an error, just nothing to save
        }

        // Try sync storage first, fallback to local
        const cloudBefore = await cloudBeforeSave(Object.keys(dataToSave));
        try {
            await chrome.storage.sync.set(dataToSave);
            await clearPendingSync(Object.keys(dataToSave), { localCopies: true });
        } catch (syncError) {
            debugWarn('Sync storage failed for settings, falling back to local storage', {
                errorMessage: syncError.message,
                errorStack: syncError.stack
            });
            
            try {
                await writeFallback(dataToSave, Object.keys(dataToSave), cloudBefore);
                debug('Successfully saved settings to local storage as fallback');
            } catch (localError) {
                const storageError = new CodexError(
                    'Failed to save settings to both sync and local storage',
                    ERROR_TYPES.STORAGE,
                    ERROR_SEVERITY.HIGH,
                    {
                        syncError: syncError.message,
                        localError: localError.message
                    }
                );
                handleError(storageError, {
                    context: 'storage-save-settings',
                    showUserNotification: true,
                    logToConsole: true
                });
                throw storageError;
            }
        }

        return true;
    } catch (error) {
        debugError('Storage save error: failed to save settings data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

export async function loadSettings() {
    try {
        let data = await chrome.storage.sync.get(['theme', 'colorTheme', 'view', 'defaultTileSize']);
        if (!data || Object.keys(data).length === 0) {
            data = await chrome.storage.local.get(['theme', 'colorTheme', 'view', 'defaultTileSize']);
        }

        return {
            theme: data.theme || 'dark',
            colorTheme: data.colorTheme || 'default',
            view: data.view || 'grid',
            defaultTileSize: data.defaultTileSize || 'medium'
        };
    } catch (error) {
        debugError('Storage load error: failed to load settings data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return { theme: 'dark', colorTheme: 'default', view: 'grid', defaultTileSize: 'medium' };
    }
}

export async function clearStorage() {
    try {
        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();
        debug('Storage cleared successfully from both sync and local storage');
        return true;
    } catch (error) {
        debugError('Storage clear error: failed to clear storage', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

// Category management functions

/**
 * Read the stored categories record: sync first, local when sync has none.
 * @returns {Promise<Object|undefined>} The raw `get` result.
 */
async function readStoredCategories() {
    let data = await chrome.storage.sync.get(['categories']);
    if (!data || !data.categories) {
        data = await chrome.storage.local.get(['categories']);
    }
    return data;
}

/**
 * Parse categories stored as a JSON string; anything but an array is
 * corruption and yields ['Default'].
 * @param {string} raw
 * @returns {string[]}
 */
function parseCategoriesString(raw) {
    try {
        const parsedCategories = JSON.parse(raw);
        if (Array.isArray(parsedCategories)) {
            return parsedCategories;
        }
        debugWarn('Storage corruption detected: parsed categories data is not an array', {
            dataType: typeof parsedCategories,
            dataValue: parsedCategories
        });
    } catch (parseError) {
        debugError('Storage corruption detected: failed to parse categories JSON', {
            errorMessage: parseError.message,
            errorStack: parseError.stack,
            rawData: raw.substring(0, 100) + (raw.length > 100 ? '...' : '')
        });
    }
    return ['Default'];
}

/**
 * Interpret a stored categories value (JSON string or array); a missing value
 * or any other shape yields ['Default'], corrupt shapes with a warning.
 * @param {*} value
 * @returns {string[]}
 */
function interpretStoredCategories(value) {
    if (!value) {
        return ['Default'];
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        debugWarn('Storage corruption detected: categories data is an object instead of string or array', {
            dataType: typeof value,
            dataKeys: Object.keys(value)
        });
        return ['Default'];
    }
    if (typeof value === 'string') {
        return parseCategoriesString(value);
    }
    if (Array.isArray(value)) {
        return value;
    }
    debugWarn('Storage corruption detected: categories data is of unexpected type', {
        dataType: typeof value,
        dataValue: value
    });
    return ['Default'];
}

export async function loadCategories() {
    try {
        const data = await readStoredCategories();

        let categories;
        try {
            categories = interpretStoredCategories(data.categories);
        } catch (validationError) {
            debugError('Storage validation error: unexpected error during categories validation', {
                errorMessage: validationError.message,
                errorStack: validationError.stack
            });
            categories = ['Default'];
        }

        // Ensure Default category exists
        if (!categories.includes('Default')) {
            categories.unshift('Default');
        }

        return categories;
    } catch (error) {
        debugError('Storage load error: failed to load categories from storage', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return ['Default'];
    }
}

export async function saveCategories(categories) {
    try {
        // Validate categories is an array before saving
        if (!Array.isArray(categories)) {
            const validationError = new CodexError(
                'Categories validation failed: data must be an array',
                ERROR_TYPES.VALIDATION,
                ERROR_SEVERITY.HIGH,
                {
                    receivedType: typeof categories,
                    receivedValue: categories
                }
            );
            handleError(validationError, {
                context: 'storage-save-categories',
                showUserNotification: true,
                logToConsole: true
            });
            throw validationError;
        }

        const categoriesString = JSON.stringify(categories);

        // Validate data before saving
        if (!categoriesString) {
            const dataError = new CodexError(
                'Categories serialization failed: resulting string is empty',
                ERROR_TYPES.STORAGE,
                ERROR_SEVERITY.HIGH,
                {
                    categoriesLength: categories.length
                }
            );
            handleError(dataError, {
                context: 'storage-save-categories',
                showUserNotification: true,
                logToConsole: true
            });
            throw dataError;
        }

        if (categoriesString.length > 8000) { // Chrome sync item size limit
            const quotaError = new CodexError(
                'Categories data exceeds storage quota limit',
                ERROR_TYPES.QUOTA,
                ERROR_SEVERITY.HIGH,
                {
                    dataSize: categoriesString.length,
                    limit: 8000
                }
            );
            handleError(quotaError, {
                context: 'storage-save-categories',
                showUserNotification: true,
                logToConsole: true
            });
            throw quotaError;
        }

        // Try sync storage first (primary storage)
        const cloudBefore = await cloudBeforeSave(['categories']);
        try {
            await chrome.storage.sync.set({ categories: categoriesString });
            await clearPendingSync(['categories'], { mirror: { categories: categoriesString } });
        } catch (syncError) {
            debugWarn('Sync storage failed, falling back to local storage', {
                errorMessage: syncError.message,
                errorStack: syncError.stack
            });
            
            // Fallback to local storage
            try {
                await writeFallback({ categories: categoriesString }, ['categories'], cloudBefore);
                debug('Successfully saved to local storage as fallback');
            } catch (localError) {
                const storageError = new CodexError(
                    'Failed to save categories to both sync and local storage',
                    ERROR_TYPES.STORAGE,
                    ERROR_SEVERITY.CRITICAL,
                    {
                        syncError: syncError.message,
                        localError: localError.message
                    }
                );
                handleError(storageError, {
                    context: 'storage-save-categories',
                    showUserNotification: true,
                    logToConsole: true
                });
                throw storageError;
            }
        }

        return categories;
    } catch (error) {
        debugError('Storage save error: failed to save categories data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return ['Default'];
    }
}

// Load complete application state
export async function loadState(initialState = {}) {
    try {
        // Load links and settings
        const linksData = await loadLinks();
        
        // Load categories
        const categories = await loadCategories();
        
        // Merge all data into state
        return {
            ...initialState,
            ...linksData,
            categories: categories,
            filteredLinks: linksData.links || []
        };
    } catch (error) {
        debugError('Storage load error: failed to load complete state', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return {
            ...initialState,
            links: [],
            categories: ['Default'],
            filteredLinks: [],
            theme: 'dark',
            view: 'grid',
            colorTheme: 'default',
            defaultTileSize: 'medium'
        };
    }
}

// Export links as JSON file
export async function exportLinks(state) {
    try {
        const data = {
            links: state.links,
            categories: state.categories,
            theme: state.theme,
            view: state.view,
            colorTheme: state.colorTheme,
            defaultTileSize: state.defaultTileSize,
            exportDate: new Date().toISOString()
        };

        downloadJsonFile(JSON.stringify(data, null, 2), `the-codex-export-${new Date().toISOString().slice(0, 10)}.json`);

        debug('Links exported successfully');
        return true;
    } catch (error) {
        debugError('Export error: failed to export links', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

/**
 * Read a user-picked file as text.
 * @param {Blob} file
 * @returns {Promise<string>}
 */
function readFileAsText(file) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsText(file);
    });
}

/**
 * The link list of a parsed import file: either its "links" array property or
 * the file itself when it is a root-level array. Throws on anything else.
 * @param {*} data - parsed JSON
 * @returns {Array}
 */
function importedLinkList(data) {
    // Check if data.links exists and is an array
    if (data.links && Array.isArray(data.links)) {
        return data.links;
    }
    // Check if data itself is an array (root-level links)
    if (Array.isArray(data)) {
        return data;
    }
    // Invalid format
    throw new Error('Invalid file format: Expected either a "links" array property or root-level array of link objects');
}

/**
 * Check one imported link's shape: an object with string name/url/category
 * and a URL that parses. Throws with the link's index on the first problem.
 * @param {*} link
 * @param {number} i - index in the imported list, for the error message
 */
function assertImportedLinkShape(link, i) {
    if (!link || typeof link !== 'object') {
        throw new Error(`Invalid link at index ${i}: Link must be an object`);
    }

    // Check required properties
    for (const field of ['name', 'url', 'category']) {
        if (!link[field] || typeof link[field] !== 'string') {
            throw new Error(`Invalid link at index ${i}: Link must have a "${field}" property (string)`);
        }
    }

    // Validate URL format
    try {
        new URL(link.url);
    } catch {
        throw new Error(`Invalid link at index ${i}: Link has an invalid URL format`);
    }
}

/**
 * Sanitize an already shape-checked imported link in place. An imported file
 * is an untrusted boundary (security review #54): new URL() accepts
 * javascript:/data: schemes, so re-validate the URL and strip any markup from
 * the display fields.
 * @param {Object} link - mutated
 * @param {number} i - index in the imported list, for the error message
 */
function sanitizeImportedLink(link, i) {
    const safeUrl = validateAndSanitizeUrl(link.url);
    if (safeUrl === '#') {
        throw new Error(`Invalid link at index ${i}: URL uses an unsupported or unsafe scheme`);
    }
    link.url = safeUrl;
    link.name = sanitizeUserInput(link.name, { maxLength: 100 });
    link.category = sanitizeUserInput(link.category, { maxLength: 50 });
    if (link.icon != null && link.icon !== 'default') {
        // Imported icons must pass the same source rules as the forms
        // (selfh.st/jsDelivr https or data: image). Coerce failures to
        // 'default' (automatic icon) instead of failing the whole
        // import — old exports commonly carry dead favicon URLs.
        const iconCheck = validateIconValue(link.icon);
        link.icon = iconCheck.valid ? iconCheck.value : 'default';
    }
}

/**
 * The sanitized category list of an import file, falling back to
 * ['Default'] when it has none (or none survive sanitizing).
 * @param {*} data - parsed JSON
 * @returns {string[]}
 */
function importedCategories(data) {
    const categories = (Array.isArray(data.categories) ? data.categories : ['Default'])
        .map(category => sanitizeUserInput(String(category), { maxLength: 50 }))
        .filter(category => category.length > 0);
    return categories.length === 0 ? ['Default'] : categories;
}

// Import links from JSON file
export async function importLinks(state, file) {
    try {
        const fileContent = await readFileAsText(file);
        const data = JSON.parse(fileContent);

        const linksToImport = importedLinkList(data);

        // Validate and sanitize each link object
        linksToImport.forEach((link, i) => {
            assertImportedLinkShape(link, i);
            sanitizeImportedLink(link, i);
        });

        // Update state with imported data
        state.links = linksToImport;
        state.categories = importedCategories(data);
        state.theme = data.theme || 'dark';
        state.view = data.view || 'grid';
        state.colorTheme = data.colorTheme || 'default';
        state.defaultTileSize = data.defaultTileSize || 'medium';

        // Save to storage
        await saveLinks(state.links);
        await saveCategories(state.categories);
        await saveSettings({
            theme: state.theme,
            view: state.view,
            colorTheme: state.colorTheme,
            defaultTileSize: state.defaultTileSize
        });

        debug('Links imported successfully');
        return true;
    } catch (error) {
        debugError('Import error: failed to import links', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        throw error;
    }
}

// Import bookmarks from browser
export async function importBookmarks(state) {
    try {
        // Get all bookmarks
        const bookmarkTree = await new Promise((resolve) => {
            chrome.bookmarks.getTree(resolve);
        });

        // Extract bookmarks from tree
        const bookmarks = [];
        
        function extractBookmarks(nodes) {
            for (const node of nodes) {
                if (node.url) {
                    // Validate the scheme (blocks javascript:/data:/file:/etc.)
                    // and sanitize the title before importing (security review #54).
                    const safeUrl = validateAndSanitizeUrl(node.url);
                    if (safeUrl !== '#') {
                        bookmarks.push({
                            name: sanitizeUserInput(node.title || 'Untitled', { maxLength: 100 }),
                            url: safeUrl,
                            category: 'Bookmarks'
                        });
                    }
                }
                if (node.children) {
                    extractBookmarks(node.children);
                }
            }
        }
        
        extractBookmarks(bookmarkTree);

        // Add bookmarks to existing links
        const existingUrls = new Set(state.links.map(link => link.url));
        const newLinks = bookmarks.filter(bookmark => !existingUrls.has(bookmark.url));
        
        state.links = [...state.links, ...newLinks];
        
        // Ensure Bookmarks category exists
        if (!state.categories.includes('Bookmarks')) {
            state.categories.push('Bookmarks');
        }
        
        // Save to storage
        await saveLinks(state.links);
        await saveCategories(state.categories);

        debug(`Imported ${newLinks.length} bookmarks`);
        return true;
    } catch (error) {
        debugError('Import bookmarks error: failed to import bookmarks', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        throw error;
    }
}