/**
 * Immutable State Management System for The Codex
 * Provides centralized state management with validation, rollback, and change tracking
 */

import { validateLink } from '../features/securityUtils.js';

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
    theme: {
        type: 'string',
        enum: ['dark', 'light']
    },
    colorTheme: {
        type: 'string',
        enum: ['default', 'ocean', 'cosmic', 'sunset', 'forest', 'fire', 'aurora']
    },
    view: {
        type: 'string',
        enum: ['grid', 'list']
    },
    searchTerm: {
        type: 'string',
        maxLength: 200
    },
    defaultTileSize: {
        type: 'string',
        enum: ['compact', 'small', 'medium', 'large', 'square', 'wide', 'tall', 'giant']
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
    linksPerPage: 20
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

    console.log(`STATE MANAGER VALIDATE: Validating ${path}`, {
        value: value,
        valueType: typeof value,
        schemaType: schema.type,
        isArray: Array.isArray(value),
        isNull: value === null
    });

    // Type validation - handle arrays specially since typeof [] returns 'object'
    if (schema.type) {
        let actualType = typeof value;

        // Special handling for arrays
        if (schema.type === 'array' && Array.isArray(value)) {
            actualType = 'array'; // Override for arrays
        }

        // Handle nullable types (array of types)
        let validTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
        
        console.log(`STATE MANAGER VALIDATE: Type validation for ${path}`, {
            validTypes: validTypes,
            actualType: actualType,
            valueIsNull: value === null,
            nullAllowed: validTypes.includes('null')
        });

        // Special handling for null values - ensure proper nullable type handling
        if (value === null && validTypes.includes('null')) {
            actualType = 'null';
            console.log(`STATE MANAGER VALIDATE: Null value detected and allowed for ${path}`);
        }

        // Enhanced validation for nullable types
        if (value === null) {
            // If value is null, only valid if null is explicitly allowed
            if (!validTypes.includes('null')) {
                errors.push(`${path}: Expected one of [${validTypes.join(', ')}], got null`);
                console.error(`STATE MANAGER VALIDATE: Null value rejected for ${path} - null not in valid types`);
                return { valid: false, errors };
            }
            // If null is allowed, validation passes
            console.log(`STATE MANAGER VALIDATE: Null value accepted for ${path}`);
            return { valid: true, errors: [] };
        }

        if (!validTypes.includes(actualType)) {
            errors.push(`${path}: Expected one of [${validTypes.join(', ')}], got ${actualType}`);
            console.error(`STATE MANAGER VALIDATE: Type mismatch for ${path}`, {
                expected: validTypes,
                actual: actualType
            });
            return { valid: false, errors };
        }
        
        console.log(`STATE MANAGER VALIDATE: Type validation passed for ${path}`);
    }

    // String validations
    if (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'))) {
        console.log(`STATE MANAGER VALIDATE: String validation for ${path}`, {
            value: value,
            valueType: typeof value,
            schemaType: schema.type
        });
        
        // Handle null values properly for nullable string types
        if (value === null) {
            console.log(`STATE MANAGER VALIDATE: Null value in string validation for ${path}`);
            // If null is allowed, validation passes
            if (Array.isArray(schema.type) && schema.type.includes('null')) {
                console.log(`STATE MANAGER VALIDATE: Null value accepted in string validation for ${path}`);
                return { valid: true, errors: [] };
            }
            // If null is not allowed, validation fails
            errors.push(`${path}: Expected string, got null`);
            console.error(`STATE MANAGER VALIDATE: Null value rejected in string validation for ${path}`);
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
            // Handle null values properly for nullable types with enum
            if (value === null) {
                console.log(`STATE MANAGER VALIDATE: Null value in enum validation for ${path}`);
                // If null is allowed, validation passes
                if (Array.isArray(schema.type) && schema.type.includes('null')) {
                    console.log(`STATE MANAGER VALIDATE: Null value accepted in enum validation for ${path}`);
                    return { valid: true, errors: [] };
                }
                // If null is not allowed, validation fails
                errors.push(`${path}: Expected string, got null`);
                console.error(`STATE MANAGER VALIDATE: Null value rejected in enum validation for ${path}`);
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
            // Value is not a string when string is expected
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

    console.log(`STATE MANAGER VALIDATE: Validation completed for ${path}`, {
        valid: errors.length === 0,
        errorCount: errors.length,
        errors: errors
    });

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
export function rollbackState(steps = 1) {
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
export function getStateProperty(property) {
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
export function addStateValidationListener(listener) {
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
export function getStateHistory() {
    return [...stateHistory]; // Return copy to prevent external modification
}

/**
 * Clears the state history
 */
export function clearStateHistory() {
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
export function batchUpdateState(updates, options = {}) {
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