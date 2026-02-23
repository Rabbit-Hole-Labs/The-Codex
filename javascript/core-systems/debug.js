/**
 * Debug logging utility for The Codex
 * Controlled by a single DEBUG flag to reduce console noise
 */

// Master debug flag - set to false for production
let DEBUG_ENABLED = false;

/**
 * Enable or disable debug logging
 * @param {boolean} enabled - Whether to enable debug logging
 */
export function setDebugEnabled(enabled) {
    DEBUG_ENABLED = enabled;
}

/**
 * Check if debug logging is enabled
 * @returns {boolean}
 */
export function isDebugEnabled() {
    return DEBUG_ENABLED;
}

/**
 * Log debug messages (only when DEBUG is enabled)
 * @param {...any} args - Arguments to log
 */
export function debug(...args) {
    if (DEBUG_ENABLED) {
        console.log('[DEBUG]', ...args);
    }
}

/**
 * Log warnings (only when DEBUG is enabled)
 * @param {...any} args - Arguments to log
 */
export function debugWarn(...args) {
    if (DEBUG_ENABLED) {
        console.warn('[DEBUG]', ...args);
    }
}

/**
 * Log errors (always shown, but with debug prefix when enabled)
 * @param {...any} args - Arguments to log
 */
export function debugError(...args) {
    if (DEBUG_ENABLED) {
        console.error('[DEBUG]', ...args);
    } else {
        console.error(...args);
    }
}

export default {
    setDebugEnabled,
    isDebugEnabled,
    debug,
    debugWarn,
    debugError
};
