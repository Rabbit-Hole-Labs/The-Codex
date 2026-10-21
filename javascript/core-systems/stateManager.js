/**
 * Immutable State Management System for The Codex
 * Provides centralized state management with validation, rollback, and change tracking
 */

import { validateLink } from '../features/securityUtils.js';
import { SETTING_ENUMS, MAX_CATEGORY_LENGTH, SYNC_RESOLVED_AT_KEY, STORED_SETTING_DEFAULTS } from './storageFormat.js';

// State validation schemas
const stateSchemas = {
    links: {
        type: 'array',
        items: {
            type: 'object',
            required: ['name', 'url', 'category'],
            properties: {
                name: { type: 'string', minLength: 1, maxLength: 100 },
                url: { type: 'string', format: 'uri' },
                category: { type: 'string', minLength: 1, maxLength: 50 },
                icon: { type: ['string', 'null'], maxLength: 500 },
                size: { type: ['string', 'null'], enum: ['compact', 'small', 'medium', 'large', 'square', 'wide', 'tall', 'giant', 'default'] }
            }
        }
    },
    // Setting enums live in storageFormat.js so load paths can coerce stored
    // values against the exact lists validated here (see coerceSettings).
    theme: {
        type: 'string',
        enum: SETTING_ENUMS.theme
    },
    colorTheme: {
        type: 'string',
        enum: SETTING_ENUMS.colorTheme
    },
    view: {
        type: 'string',
        enum: SETTING_ENUMS.view
    },
    searchTerm: {
        type: 'string',
        maxLength: 200
    },
    defaultTileSize: {
        type: 'string',
        enum: SETTING_ENUMS.defaultTileSize
    },
    categories: {
        type: 'array',
        items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_CATEGORY_LENGTH
        }
    }
};

// State change listeners
let stateChangeListeners = [];
let stateValidationListeners = [];

// State history for rollback functionality
let stateHistory = [];
const MAX_HISTORY_SIZE = 50;

// Current state snapshot
let currentState = {
    links: [],
    theme: 'dark',
    colorTheme: 'default',
    view: 'grid',
    searchTerm: '',
    defaultTileSize: 'medium',
    isDragging: false,
    draggedElement: null,
    draggedLink: null,
    draggedCategory: null,
    draggedIndex: null,
    categories: ['Default'],
    filteredLinks: [],
    currentPage: 1,
    linksPerPage: 20,
    editIndex: -1
};

/**
 * Creates an immutable copy of the current state
 * @returns {Object} - Deep copy of current state
 */
function createStateSnapshot() {
    return JSON.parse(JSON.stringify(currentState));
}

/**
 * Validates state changes against predefined schemas
 * @param {Object} newState - The proposed state changes
 * @returns {Object} - Validation result { valid: boolean, errors: string[] }
 */
function validateStateChanges(newState) {
    const errors = [];

    // Validate each property that is being changed
    for (const [key, value] of Object.entries(newState)) {
        const schema = stateSchemas[key];
        if (schema) {
            const validation = validateAgainstSchema(value, schema, key);
            if (!validation.valid) {
                errors.push(...validation.errors);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

/**
 * Validates a value against a JSON schema
 * @param {*} value - The value to validate
 * @param {Object} schema - The JSON schema
 * @param {string} path - The property path for error messages
 * @returns {Object} - Validation result
 */
function validateAgainstSchema(value, schema, path = '') {
    const errors = [];

    // Type validation - handle arrays specially since typeof [] returns 'object'
    if (schema.type) {
        let actualType = typeof value;

        // Special handling for arrays
        if (schema.type === 'array' && Array.isArray(value)) {
            actualType = 'array';
        }

        // Handle nullable types (array of types)
        let validTypes = Array.isArray(schema.type) ? schema.type : [schema.type];

        // Special handling for null values
        if (value === null && validTypes.includes('null')) {
            actualType = 'null';
        }

        // Enhanced validation for nullable types
        if (value === null) {
            if (!validTypes.includes('null')) {
                errors.push(`${path}: Expected one of [${validTypes.join(', ')}], got null`);
                return { valid: false, errors };
            }
            return { valid: true, errors: [] };
        }

        if (!validTypes.includes(actualType)) {
            errors.push(`${path}: Expected one of [${validTypes.join(', ')}], got ${actualType}`);
            return { valid: false, errors };
        }
    }

    // String validations
    if (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'))) {
        // Handle null values properly for nullable string types
        if (value === null) {
            if (Array.isArray(schema.type) && schema.type.includes('null')) {
                return { valid: true, errors: [] };
            }
            errors.push(`${path}: Expected string, got null`);
            return { valid: false, errors };
        }

        // Only validate string properties if value is actually a string
        if (typeof value === 'string') {
            if (schema.minLength && value.length < schema.minLength) {
                errors.push(`${path}: Minimum length is ${schema.minLength}`);
                return { valid: false, errors };
            }
            if (schema.maxLength && value.length > schema.maxLength) {
                errors.push(`${path}: Maximum length is ${schema.maxLength}`);
                return { valid: false, errors };
            }
            if (schema.enum && !schema.enum.includes(value)) {
                errors.push(`${path}: Value must be one of: ${schema.enum.join(', ')}`);
                return { valid: false, errors };
            }
            if (schema.format === 'uri') {
                try {
                    new URL(value);
                } catch {
                    errors.push(`${path}: Must be a valid URL`);
                    return { valid: false, errors };
                }
            }
        } else {
            errors.push(`${path}: Expected string, got ${typeof value}`);
            return { valid: false, errors };
        }
    }

    // Array validations
    if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            errors.push(`${path}: Must be an array`);
            return { valid: false, errors };
        }

        if (schema.items) {
            value.forEach((item, index) => {
                const itemValidation = validateAgainstSchema(item, schema.items, `${path}[${index}]`);
                if (!itemValidation.valid) {
                    errors.push(...itemValidation.errors);
                }
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

/**
 * Creates an immutable state update with validation and history tracking
 * @param {Object} updates - The state updates to apply
 * @param {Object} options - Update options { validate: boolean, trackHistory: boolean, rollbackOnError: boolean }
 * @returns {Object} - Update result { success: boolean, newState: Object, error: string, rollbackState: Object }
 */
export function updateState(updates, options = {}) {
    const {
        validate = true,
        trackHistory = true,
        rollbackOnError = true
    } = options;

    try {
        // Create a copy of current state for rollback
        const rollbackState = createStateSnapshot();

        // Validate the updates if requested
        if (validate) {
            const validation = validateStateChanges(updates);
            if (!validation.valid) {
                const error = `State validation failed: ${validation.errors.join(', ')}`;

                // Notify validation listeners
                stateValidationListeners.forEach(listener => {
                    listener({ valid: false, errors: validation.errors, updates });
                });

                if (rollbackOnError) {
                    return {
                        success: false,
                        error: error,
                        rollbackState: rollbackState
                    };
                } else {
                    throw new Error(error);
                }
            }
        }

        // Track history if requested
        if (trackHistory) {
            addToHistory(rollbackState);
        }

        // Apply updates immutably
        const newState = { ...currentState, ...updates };

        // Validate individual link data if links were updated
        if (updates.links && validate) {
            const linkValidation = validateAllLinks(newState.links);
            if (!linkValidation.valid) {
                const error = `Link validation failed: ${linkValidation.errors.join(', ')}`;

                if (rollbackOnError) {
                    return {
                        success: false,
                        error: error,
                        rollbackState: rollbackState
                    };
                } else {
                    throw new Error(error);
                }
            }
        }

        // Update the current state
        currentState = newState;

        // Notify state change listeners
        stateChangeListeners.forEach(listener => {
            listener({
                previousState: rollbackState,
                newState: currentState,
                changes: updates,
                timestamp: Date.now()
            });
        });

        // Auto-persist persistent fields to chrome.storage (T-027)
        if (!options.skipPersistence) {
            const hasPersistentChanges = Object.keys(updates).some(k => PERSISTENT_FIELDS.includes(k));
            if (hasPersistentChanges) {
                persistToStorage(updates);
            }
        }

        return {
            success: true,
            newState: currentState,
            rollbackState: rollbackState
        };

    } catch (error) {
        console.error('State update failed:', error);
        return {
            success: false,
            error: error.message,
            rollbackState: rollbackOnError ? createStateSnapshot() : null
        };
    }
}

/**
 * Validates all links in the state
 * @param {Array} links - Array of link objects
 * @returns {Object} - Validation result
 */
function validateAllLinks(links) {
    const errors = [];

    links.forEach((link, index) => {
        const validation = validateLink(link);
        if (!validation.valid) {
            // Include more detailed information about the failing link
            const linkInfo = {
                index: index,
                name: link.name || 'Unnamed',
                url: link.url || 'No URL',
                category: link.category || 'No Category'
            };
            errors.push(`Link ${index} (${linkInfo.name}): ${validation.errors.join(', ')}`);
            console.warn(`Link validation failed for link at index ${index}:`, {
                link: linkInfo,
                errors: validation.errors
            });
        }
    });

    return {
        valid: errors.length === 0,
        errors: errors
    };
}

/**
 * Adds current state to history for rollback functionality
 * @param {Object} state - The state to add to history
 */
function addToHistory(state) {
    stateHistory.push({
        state: state,
        timestamp: Date.now()
    });

    // Maintain history size limit
    if (stateHistory.length > MAX_HISTORY_SIZE) {
        stateHistory.shift(); // Remove oldest entry
    }
}

/**
 * Rolls back to a previous state
 * @param {number} steps - Number of steps to roll back (default: 1)
 * @returns {Object} - Rollback result
 */
function rollbackState(steps = 1) {
    if (stateHistory.length < steps) {
        return {
            success: false,
            error: `Cannot rollback ${steps} steps. Only ${stateHistory.length} states in history.`
        };
    }

    try {
        // Get the target state from history
        const targetIndex = stateHistory.length - steps;
        const targetEntry = stateHistory[targetIndex];

        // Create current state snapshot for potential re-rollforward
        const currentSnapshot = createStateSnapshot();

        // Restore the target state
        currentState = targetEntry.state;

        // Remove rolled-back states from history
        stateHistory = stateHistory.slice(0, targetIndex);

        // Notify listeners of the rollback
        stateChangeListeners.forEach(listener => {
            listener({
                previousState: currentSnapshot,
                newState: currentState,
                changes: { rollback: true, steps: steps },
                timestamp: Date.now()
            });
        });

        return {
            success: true,
            newState: currentState,
            rolledBackTo: targetEntry.timestamp
        };

    } catch (error) {
        console.error('Rollback failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Gets the current state (immutable copy)
 * @returns {Object} - Deep copy of current state
 */
export function getState() {
    return createStateSnapshot();
}

/**
 * Gets a specific property from the current state
 * @param {string} property - The property to get
 * @returns {*} - The property value
 */
function getStateProperty(property) {
    return currentState[property];
}

/**
 * Registers a state change listener
 * @param {Function} listener - Function to call when state changes
 * @returns {Function} - Function to unregister the listener
 */
export function addStateChangeListener(listener) {
    stateChangeListeners.push(listener);

    return () => {
        const index = stateChangeListeners.indexOf(listener);
        if (index > -1) {
            stateChangeListeners.splice(index, 1);
        }
    };
}

/**
 * Registers a state validation listener
 * @param {Function} listener - Function to call when validation occurs
 * @returns {Function} - Function to unregister the listener
 */
function addStateValidationListener(listener) {
    stateValidationListeners.push(listener);

    return () => {
        const index = stateValidationListeners.indexOf(listener);
        if (index > -1) {
            stateValidationListeners.splice(index, 1);
        }
    };
}

/**
 * Gets the current state history
 * @returns {Array} - Array of historical state snapshots
 */
function getStateHistory() {
    return [...stateHistory]; // Return copy to prevent external modification
}

/**
 * Clears the state history
 */
function clearStateHistory() {
    stateHistory = [];
}

/**
 * Creates a controlled state update function for specific properties
 * @param {string} property - The property to create updater for
 * @param {Function} validator - Optional custom validator function
 * @returns {Function} - Update function for the specific property
 */
export function createStateUpdater(property, validator = null) {
    return (value, options = {}) => {
        const updates = { [property]: value };

        // Add custom validation if provided
        if (validator && options.validate !== false) {
            const validationResult = validator(value);
            if (validationResult !== true) {
                return {
                    success: false,
                    error: typeof validationResult === 'string' ? validationResult : `Invalid ${property}`
                };
            }
        }

        return updateState(updates, options);
    };
}

/**
 * Batch updates multiple properties atomically
 * @param {Object} updates - Multiple property updates
 * @param {Object} options - Update options
 * @returns {Object} - Update result
 */
function batchUpdateState(updates, options = {}) {
    return updateState(updates, { ...options, validate: true });
}

/**
 * Safe state update that never throws, always returns result
 * @param {Object} updates - The state updates to apply
 * @param {Object} options - Update options
 * @returns {Object} - Always returns a result object
 */
export function safeUpdateState(updates, options = {}) {
    try {
        return updateState(updates, { ...options, rollbackOnError: true });
    } catch (error) {
        console.error('Safe state update failed:', error);
        return {
            success: false,
            error: error.message,
            rollbackState: createStateSnapshot()
        };
    }
}

// --- T-026: Cross-tab reactivity via chrome.storage.onChanged ---
// Persistent fields that should be synced to/from chrome.storage
const PERSISTENT_FIELDS = ['theme', 'colorTheme', 'links', 'categories', 'defaultTileSize', 'view'];

// Array fields that storageManager persists as JSON strings — they must be
// stringified on write and parsed on read (and tolerated when already an
// array, for values written by an older/other code path).
const JSON_ENCODED_FIELDS = ['links', 'categories'];

// Values the array fields reset to when another context removes them.
const REMOVED_FIELD_RESETS = {
    links: () => [],
    categories: () => ['Default']
};

// Flag to prevent circular updates (our own write triggering onChanged)
let isWritingToStorage = false;

// Fields a page applies itself instead of taking the raw stored value here,
// mapped to that page's handler (see claimStorageFields).
const claimedFields = new Map();

/**
 * Opt this page out of the raw update for the given fields, because it
 * applies them itself: applyStorageValues hands their stored values to
 * `apply` instead — for every sync change (including the echo of this page's
 * own saves) and every reloadFromStorage() after a manual sync or clear. The
 * newtab claims links/categories so its load-time salvage/quarantine covers
 * all of them; raw values could re-show hidden links or crash rendering.
 * Pages that don't call this (e.g. manage) are unaffected.
 * @param {string[]} fields - persistent field names
 * @param {(values: Object, source: 'sync'|'reload') => (Object|void)} [apply] -
 *   gets { field: stored value } for the claimed fields present (undefined =
 *   absent/removed); may return cleaned state changes, which are applied in
 *   the same state update as the unclaimed fields (one re-render per change)
 */
export function claimStorageFields(fields, apply = null) {
    fields.forEach(field => claimedFields.set(field, apply));
}

const storageAppliedListeners = new Set();

/**
 * Be told when storage values have been applied to the state.
 * @param {(updates: Object, source: 'sync'|'reload') => void} listener
 * @returns {Function} unsubscribe
 */
export function addStorageAppliedListener(listener) {
    storageAppliedListeners.add(listener);
    return () => storageAppliedListeners.delete(listener);
}

/**
 * The one place stored values enter the page state: chrome.storage.onChanged
 * (sync area) and reloadFromStorage() both go through here. `values` maps keys
 * to values as stored (links/categories as JSON strings); undefined means the
 * key was removed, which resets links/categories rather than keeping the old
 * value — or this page's next save would re-upload it. Non-persistent keys
 * are ignored. Fields a page claimed (claimStorageFields) never enter the
 * state raw: their stored values go, as stored, to that page's handler, and
 * only the cleaned changes it returns are applied.
 * @param {Object} values
 * @param {{ source?: 'sync'|'reload' }} [options]
 * @returns {Object} the updates applied
 */
export function applyStorageValues(values, { source = 'sync' } = {}) {
    const updates = {};
    const claimed = new Map(); // handler -> { key: stored value }
    for (const [key, value] of Object.entries(values)) {
        if (claimedFields.has(key)) {
            const apply = claimedFields.get(key);
            if (apply) claimed.set(apply, { ...claimed.get(apply), [key]: value });
        } else if (value === undefined) {
            if (Object.prototype.hasOwnProperty.call(REMOVED_FIELD_RESETS, key)) {
                updates[key] = REMOVED_FIELD_RESETS[key]();
            }
        } else if (PERSISTENT_FIELDS.includes(key)) {
            // Array fields (links, categories) may be stored as JSON strings.
            if (JSON_ENCODED_FIELDS.includes(key) && typeof value === 'string') {
                try { updates[key] = JSON.parse(value); } catch { /* skip corrupt */ }
            } else {
                updates[key] = value;
            }
        }
    }

    claimed.forEach((claimedValues, apply) => {
        try {
            const changes = apply(claimedValues, source);
            if (changes && typeof changes === 'object') Object.assign(updates, changes);
        } catch (error) {
            console.error('Claimed storage handler failed:', error);
        }
    });

    if (Object.keys(updates).length > 0) {
        updateState(updates, { validate: false, skipPersistence: true });
        storageAppliedListeners.forEach(listener => {
            try {
                listener(updates, source);
            } catch (error) {
                console.error('Storage-applied listener failed:', error);
            }
        });
    }
    return updates;
}

/**
 * Re-read what the page should show and apply it. Runs in every open page
 * after a manual sync or clear (SYNC_RESOLVED_AT_KEY): when the cloud won there
 * was no sync write, so no sync-area onChanged reaches pages that still hold
 * discarded data. Each key comes from sync, or from chrome.storage.local when
 * sync doesn't hold it (e.g. lists kept by a Force pull from a cloud that holds
 * only settings, or emptied by a sync that set them aside) — never from the
 * page's own copy. A setting neither holds shows its default, as on a fresh
 * load; a list neither holds is emptied.
 */
export async function reloadFromStorage() {
    const [cloud, local] = await Promise.all([
        chrome.storage.sync.get(PERSISTENT_FIELDS),
        chrome.storage.local.get(PERSISTENT_FIELDS)
    ]);
    const values = {};
    for (const key of PERSISTENT_FIELDS) {
        values[key] = cloud[key] ?? local[key] ?? STORED_SETTING_DEFAULTS[key];
    }
    return applyStorageValues(values, { source: 'reload' });
}

/**
 * Listen for chrome.storage changes from other tabs/contexts.
 * Updates the stateManager singleton when storage changes externally.
 */
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            if (changes[SYNC_RESOLVED_AT_KEY]?.newValue !== undefined) {
                reloadFromStorage().catch(error => console.error('Failed to reload state after a sync:', error));
            }
            return;
        }
        if (areaName !== 'sync') return;
        let entries = Object.entries(changes);
        // Skip the echo of this page's own persistToStorage write — except
        // claimed fields: the page that claimed them tracks every change.
        if (isWritingToStorage) entries = entries.filter(([key]) => claimedFields.has(key));
        applyStorageValues(Object.fromEntries(entries.map(([key, change]) => [key, change.newValue])));
    });
}

// --- T-027: Auto-persist persistent fields to chrome.storage ---

/**
 * Write persistent state fields to chrome.storage.sync.
 * Called automatically after safeUpdateState when persistent fields change.
 * @param {Object} updates - The state updates that were applied
 */
async function persistToStorage(updates) {
    if (typeof chrome === 'undefined' || !chrome.storage?.sync) return;

    const toStore = {};
    for (const key of PERSISTENT_FIELDS) {
        if (key in updates) {
            toStore[key] = JSON_ENCODED_FIELDS.includes(key) ? JSON.stringify(updates[key]) : updates[key];
        }
    }

    if (Object.keys(toStore).length === 0) return;

    try {
        isWritingToStorage = true;
        await chrome.storage.sync.set(toStore);
    } catch (error) {
        console.error('Failed to persist state to storage:', error);
    } finally {
        isWritingToStorage = false;
    }
}

// --- T-028: Initialize stateManager from chrome.storage on page load ---

/**
 * Load state from chrome.storage.sync and initialize the stateManager.
 * Should be called once during page initialization, before rendering.
 * @returns {Promise<Object>} The loaded state
 */
export async function initializeFromStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
        return getState();
    }

    try {
        const data = await chrome.storage.sync.get(null);
        const updates = {};

        for (const key of PERSISTENT_FIELDS) {
            if (data[key] !== undefined) {
                if (JSON_ENCODED_FIELDS.includes(key) && typeof data[key] === 'string') {
                    try { updates[key] = JSON.parse(data[key]); } catch { /* skip corrupt */ }
                } else {
                    updates[key] = data[key];
                }
            }
        }

        if (Object.keys(updates).length > 0) {
            updateState(updates, { validate: false, skipPersistence: true });
        }
    } catch (error) {
        console.error('Failed to initialize state from storage:', error);
    }

    return getState();
}

// Export the state management system
export default {
    updateState,
    rollbackState,
    getState,
    getStateProperty,
    addStateChangeListener,
    addStateValidationListener,
    getStateHistory,
    clearStateHistory,
    createStateUpdater,
    batchUpdateState,
    safeUpdateState,
    validateStateChanges,
    validateAllLinks
};