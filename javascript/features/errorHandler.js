/**
 * Comprehensive Error Handling System for The Codex
 * Provides standardized error handling, user-friendly messages, and recovery mechanisms
 */

// Error types and categories
export const ERROR_TYPES = {
    // Security errors
    SECURITY: 'security',
    VALIDATION: 'validation',
    AUTHENTICATION: 'authentication',

    // Storage errors
    STORAGE: 'storage',
    SYNC: 'sync',
    QUOTA: 'quota',

    // Network errors
    NETWORK: 'network',
    TIMEOUT: 'timeout',

    // DOM/UI errors
    DOM: 'dom',
    RENDER: 'render',

    // Logic errors
    STATE: 'state',

    // External service errors
    EXTERNAL: 'external',
    API: 'api',

    // Unknown errors
    UNKNOWN: 'unknown',
    UNEXPECTED: 'unexpected'
};

// Error severity levels
export const ERROR_SEVERITY = {
    LOW: 'low',      // Warning, non-blocking
    MEDIUM: 'medium', // User should be notified
    HIGH: 'high',     // Blocking error, requires action
    CRITICAL: 'critical' // System failure, immediate attention
};

// Error recovery strategies
export const RECOVERY_STRATEGIES = {
    RETRY: 'retry',
    FALLBACK: 'fallback',
    ROLLBACK: 'rollback',
    SKIP: 'skip',
    NOTIFY: 'notify',
    TERMINATE: 'terminate'
};

// Error handler registry
let errorHandlers = new Map();
let globalErrorHandler = null;
let errorLog = [];
const MAX_ERROR_LOG_SIZE = 100;

/**
 * Custom error class for The Codex
 */
export class CodexError extends Error {
    constructor(message, type = ERROR_TYPES.UNKNOWN, severity = ERROR_SEVERITY.MEDIUM, details = null) {
        super(message);
        this.name = 'CodexError';
        this.type = type;
        this.severity = severity;
        this.details = details;
        this.timestamp = Date.now();
        this.recoveryStrategy = null;
        this.userMessage = null;
        this.technicalDetails = null;
    }
}

/**
 * Standard error messages for different scenarios
 */
const ERROR_MESSAGES = {
    // Storage errors
    [ERROR_TYPES.STORAGE]: {
        [ERROR_SEVERITY.LOW]: 'Storage operation completed with warnings.',
        [ERROR_SEVERITY.MEDIUM]: 'Unable to save your data. Please try again.',
        [ERROR_SEVERITY.HIGH]: 'Storage error: Your changes could not be saved.',
        [ERROR_SEVERITY.CRITICAL]: 'Critical storage failure: Data may be lost.'
    },

    [ERROR_TYPES.SYNC]: {
        [ERROR_SEVERITY.LOW]: 'Sync temporarily unavailable.',
        [ERROR_SEVERITY.MEDIUM]: 'Could not sync with cloud storage.',
        [ERROR_SEVERITY.HIGH]: 'Sync failed: Changes saved locally only.',
        [ERROR_SEVERITY.CRITICAL]: 'Sync system failure: Manual intervention required.'
    },

    [ERROR_TYPES.QUOTA]: {
        [ERROR_SEVERITY.MEDIUM]: 'Storage limit reached. Please remove some items.',
        [ERROR_SEVERITY.HIGH]: 'Storage quota exceeded. Cannot save more data.',
        [ERROR_SEVERITY.CRITICAL]: 'Critical: Storage quota completely exhausted.'
    },

    // Network errors
    [ERROR_TYPES.NETWORK]: {
        [ERROR_SEVERITY.LOW]: 'Network connection slow.',
        [ERROR_SEVERITY.MEDIUM]: 'Network error. Please check your connection.',
        [ERROR_SEVERITY.HIGH]: 'Network failure: Working offline.',
        [ERROR_SEVERITY.CRITICAL]: 'Network completely unavailable.'
    },

    // Validation errors
    [ERROR_TYPES.VALIDATION]: {
        [ERROR_SEVERITY.LOW]: 'Please check your input.',
        [ERROR_SEVERITY.MEDIUM]: 'Invalid input detected.',
        [ERROR_SEVERITY.HIGH]: 'Validation failed: Please correct errors.',
        [ERROR_SEVERITY.CRITICAL]: 'Critical validation failure.'
    },

    // Security errors
    [ERROR_TYPES.SECURITY]: {
        [ERROR_SEVERITY.MEDIUM]: 'Security warning: Suspicious activity detected.',
        [ERROR_SEVERITY.HIGH]: 'Security alert: Potentially harmful content blocked.',
        [ERROR_SEVERITY.CRITICAL]: 'Security breach: Immediate action required.'
    },

    // DOM/Render errors
    [ERROR_TYPES.DOM]: {
        [ERROR_SEVERITY.LOW]: 'Display issue detected.',
        [ERROR_SEVERITY.MEDIUM]: 'Could not display content properly.',
        [ERROR_SEVERITY.HIGH]: 'Rendering failed: Content may be incomplete.',
        [ERROR_SEVERITY.CRITICAL]: 'Critical rendering failure.'
    },

    // Unknown errors
    [ERROR_TYPES.UNKNOWN]: {
        [ERROR_SEVERITY.MEDIUM]: 'An unexpected error occurred.',
        [ERROR_SEVERITY.HIGH]: 'Something went wrong. Please try again.',
        [ERROR_SEVERITY.CRITICAL]: 'Critical system error occurred.'
    }
};

/**
 * Handles errors with standardized approach
 * @param {Error|CodexError} error - The error to handle
 * @param {Object} options - Handling options
 * @returns {Object} - Handling result
 */
export function handleError(error, options = {}) {
    const {
        context = 'general',
        showNotifications = true,
        allowRecovery = true,
        logToConsole = true,
        reportToAnalytics = false
    } = options;

    try {
        // Normalize error
        const normalizedError = normalizeError(error);

        // Log error if requested
        if (logToConsole) {
            logError(normalizedError, context);
        }

        // Add to error log
        addToErrorLog(normalizedError, context);

        // Generate user-friendly message
        const userMessage = generateUserMessage(normalizedError);

        // Determine recovery strategy
        const recoveryStrategy = determineRecoveryStrategy(normalizedError, allowRecovery);

        // Attempt recovery if possible
        let recoveryResult = null;
        if (allowRecovery && recoveryStrategy !== RECOVERY_STRATEGIES.TERMINATE) {
            recoveryResult = attemptRecovery(normalizedError, recoveryStrategy);
        }

        // Show user notification if requested
        if (showNotifications) {
            showUserNotification(userMessage, normalizedError.severity);
        }

        // Report to analytics if requested
        if (reportToAnalytics) {
            reportErrorToAnalytics(normalizedError, context);
        }

        // Call specific error handlers
        const handlerResult = callSpecificErrorHandler(normalizedError, context);

        return {
            success: true,
            error: normalizedError,
            userMessage: userMessage,
            recoveryStrategy: recoveryStrategy,
            recoveryResult: recoveryResult,
            handlerResult: handlerResult
        };

    } catch (handlerError) {
        console.error('Error in error handler:', handlerError);
        return {
            success: false,
            error: handlerError,
            originalError: error
        };
    }
}

/**
 * Normalizes different error types to CodexError
 * @param {Error|string|Object} error - The error to normalize
 * @returns {CodexError} - Normalized error
 */
function normalizeError(error) {
    if (error instanceof CodexError) {
        return error;
    }

    if (error instanceof Error) {
        return new CodexError(
            error.message,
            ERROR_TYPES.UNKNOWN,
            ERROR_SEVERITY.MEDIUM,
            { originalError: error }
        );
    }

    if (typeof error === 'string') {
        return new CodexError(
            error,
            ERROR_TYPES.UNKNOWN,
            ERROR_SEVERITY.MEDIUM
        );
    }

    if (typeof error === 'object' && error !== null) {
        return new CodexError(
            error.message || 'Unknown error',
            error.type || ERROR_TYPES.UNKNOWN,
            error.severity || ERROR_SEVERITY.MEDIUM,
            error
        );
    }

    return new CodexError(
        'Unknown error occurred',
        ERROR_TYPES.UNKNOWN,
        ERROR_SEVERITY.MEDIUM
    );
}

/**
 * Logs error with appropriate level
 * @param {CodexError} error - The error to log
 * @param {string} context - Error context
 */
function logError(error, context) {
    const logData = {
        message: error.message,
        type: error.type,
        severity: error.severity,
        context: context,
        timestamp: error.timestamp,
        details: error.details
    };

    switch (error.severity) {
        case ERROR_SEVERITY.CRITICAL:
            console.error('CRITICAL ERROR:', logData);
            break;
        case ERROR_SEVERITY.HIGH:
            console.error('ERROR:', logData);
            break;
        case ERROR_SEVERITY.MEDIUM:
            console.warn('WARNING:', logData);
            break;
        case ERROR_SEVERITY.LOW:
            console.info('INFO:', logData);
            break;
        default:
            console.log('ERROR:', logData);
    }
}

/**
 * Adds error to error log
 * @param {CodexError} error - The error to log
 * @param {string} context - Error context
 */
function addToErrorLog(error, context) {
    const logEntry = {
        error: error,
        context: context,
        timestamp: Date.now()
    };

    errorLog.push(logEntry);

    // Maintain log size limit
    if (errorLog.length > MAX_ERROR_LOG_SIZE) {
        errorLog.shift();
    }
}

/**
 * Generates user-friendly error message
 * @param {CodexError} error - The error
 * @returns {string} - User-friendly message
 */
function generateUserMessage(error) {
    // Use custom user message from details if provided (takes precedence)
    if (error.details && error.details.userMessage) {
        return error.details.userMessage;
    }

    // Use predefined messages if available
    const typeMessages = ERROR_MESSAGES[error.type];
    if (typeMessages && typeMessages[error.severity]) {
        return typeMessages[error.severity];
    }

    // Default message based on severity
    switch (error.severity) {
        case ERROR_SEVERITY.CRITICAL:
            return 'A critical error occurred. Please restart the application.';
        case ERROR_SEVERITY.HIGH:
            return 'An error occurred. Please try again or contact support.';
        case ERROR_SEVERITY.MEDIUM:
            return 'Something went wrong. Please check your input and try again.';
        case ERROR_SEVERITY.LOW:
            return 'A minor issue occurred. The application will continue working.';
        default:
            return 'An unexpected error occurred.';
    }
}

/**
 * Determines recovery strategy for error
 * @param {CodexError} error - The error
 * @param {boolean} allowRecovery - Whether recovery is allowed
 * @returns {string} - Recovery strategy
 */
function determineRecoveryStrategy(error, allowRecovery) {
    if (!allowRecovery) {
        return RECOVERY_STRATEGIES.NOTIFY;
    }

    // Use predefined strategy if available
    if (error.details && error.details.recoveryStrategy) {
        return error.details.recoveryStrategy;
    }

    // Determine based on error type and severity
    switch (error.type) {
        case ERROR_TYPES.NETWORK:
        case ERROR_TYPES.TIMEOUT:
            return RECOVERY_STRATEGIES.RETRY;

        case ERROR_TYPES.QUOTA:
            return RECOVERY_STRATEGIES.FALLBACK;

        case ERROR_TYPES.STORAGE:
        case ERROR_TYPES.SYNC:
            return RECOVERY_STRATEGIES.FALLBACK;

        case ERROR_TYPES.VALIDATION:
            return RECOVERY_STRATEGIES.NOTIFY;

        case ERROR_TYPES.SECURITY:
            return RECOVERY_STRATEGIES.TERMINATE;

        default:
            return error.severity === ERROR_SEVERITY.CRITICAL ?
                RECOVERY_STRATEGIES.TERMINATE : RECOVERY_STRATEGIES.NOTIFY;
    }
}

/**
 * Attempts to recover from error
 * @param {CodexError} error - The error
 * @param {string} strategy - Recovery strategy
 * @returns {Object} - Recovery result
 */
function attemptRecovery(error, strategy) {
    try {
        switch (strategy) {
            case RECOVERY_STRATEGIES.RETRY:
                return retryOperation(error);

            case RECOVERY_STRATEGIES.FALLBACK:
                return fallbackOperation(error);

            case RECOVERY_STRATEGIES.ROLLBACK:
                return rollbackOperation(error);

            case RECOVERY_STRATEGIES.SKIP:
                return skipOperation(error);

            case RECOVERY_STRATEGIES.NOTIFY:
                return { success: true, message: 'User notified of error' };

            case RECOVERY_STRATEGIES.TERMINATE:
                return { success: false, message: 'Operation terminated' };

            default:
                return { success: false, message: 'Unknown recovery strategy' };
        }
    } catch (recoveryError) {
        console.error('Recovery failed:', recoveryError);
        return {
            success: false,
            error: recoveryError,
            message: 'Recovery attempt failed'
        };
    }
}

/**
 * Retries failed operation
 * @param {CodexError} error - The error
 * @returns {Object} - Retry result
 */
function retryOperation(error) {
    // Implementation would depend on specific operation
    return {
        success: true,
        message: 'Operation will be retried',
        attempts: 3,
        delay: 1000
    };
}

/**
 * Falls back to alternative operation
 * @param {CodexError} error - The error
 * @returns {Object} - Fallback result
 */
function fallbackOperation(error) {
    // Implementation would depend on specific operation
    return {
        success: true,
        message: 'Falling back to local storage',
        fallback: 'local_storage'
    };
}

/**
 * Rolls back to previous state
 * @param {CodexError} error - The error
 * @returns {Object} - Rollback result
 */
function rollbackOperation(error) {
    // Implementation would depend on state management
    return {
        success: true,
        message: 'State rolled back to previous version',
        rollbackPoint: Date.now() - 60000 // 1 minute ago
    };
}

/**
 * Skips failed operation
 * @param {CodexError} error - The error
 * @returns {Object} - Skip result
 */
function skipOperation(error) {
    return {
        success: true,
        message: 'Operation skipped, continuing with next item'
    };
}

/**
 * Shows user notification
 * @param {string} message - The message to show
 * @param {string} severity - Error severity
 */
function showUserNotification(message, severity) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `codex-error-notification severity-${severity}`;
    notification.textContent = message;

    // Style based on severity
    const styles = getNotificationStyles(severity);
    Object.assign(notification.style, styles);

    // Add to page
    document.body.appendChild(notification);

    // Auto-remove after delay
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, getNotificationDuration(severity));
}

/**
 * Gets notification styles based on severity
 * @param {string} severity - Error severity
 * @returns {Object} - CSS styles
 */
function getNotificationStyles(severity) {
    const baseStyles = {
        position: 'fixed',
        top: '20px',
        right: '20px',
        padding: '12px 16px',
        borderRadius: '4px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '14px',
        fontWeight: '500',
        zIndex: '10000',
        maxWidth: '300px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        transition: 'all 0.3s ease',
        opacity: '0',
        transform: 'translateX(100%)'
    };

    const severityStyles = {
        [ERROR_SEVERITY.LOW]: {
            backgroundColor: '#f0f9ff',
            color: '#0369a1',
            border: '1px solid #bae6fd'
        },
        [ERROR_SEVERITY.MEDIUM]: {
            backgroundColor: '#fef3c7',
            color: '#d97706',
            border: '1px solid #fcd34d'
        },
        [ERROR_SEVERITY.HIGH]: {
            backgroundColor: '#fee2e2',
            color: '#dc2626',
            border: '1px solid #fca5a5'
        },
        [ERROR_SEVERITY.CRITICAL]: {
            backgroundColor: '#7f1d1d',
            color: '#ffffff',
            border: '1px solid #dc2626',
            fontWeight: '700'
        }
    };

    return { ...baseStyles, ...severityStyles[severity] };
}

/**
 * Gets notification duration based on severity
 * @param {string} severity - Error severity
 * @returns {number} - Duration in milliseconds
 */
function getNotificationDuration(severity) {
    const durations = {
        [ERROR_SEVERITY.LOW]: 3000,
        [ERROR_SEVERITY.MEDIUM]: 5000,
        [ERROR_SEVERITY.HIGH]: 7000,
        [ERROR_SEVERITY.CRITICAL]: 10000
    };

    return durations[severity] || 5000;
}

/**
 * Reports error to analytics (placeholder)
 * @param {CodexError} error - The error
 * @param {string} context - Error context
 */
function reportErrorToAnalytics(error, context) {
    // Placeholder for analytics integration
    console.log('Analytics report:', {
        errorType: error.type,
        severity: error.severity,
        context: context,
        timestamp: error.timestamp
    });
}

/**
 * Calls specific error handler if registered
 * @param {CodexError} error - The error
 * @param {string} context - Error context
 * @returns {Object} - Handler result
 */
function callSpecificErrorHandler(error, context) {
    const handlerKey = `${error.type}:${context}`;
    const handler = errorHandlers.get(handlerKey);

    if (handler) {
        try {
            return handler(error, context);
        } catch (handlerError) {
            console.error('Specific error handler failed:', handlerError);
            return { success: false, error: handlerError };
        }
    }

    return { success: true, message: 'No specific handler found' };
}

/**
 * Registers an error handler
 * @param {string} type - Error type
 * @param {string} context - Error context
 * @param {Function} handler - Handler function
 * @returns {Function} - Function to unregister handler
 */
export function registerErrorHandler(type, context, handler) {
    const key = `${type}:${context}`;
    errorHandlers.set(key, handler);

    return () => {
        errorHandlers.delete(key);
    };
}

/**
 * Sets global error handler
 * @param {Function} handler - Global handler function
 */
export function setGlobalErrorHandler(handler) {
    globalErrorHandler = handler;
}

/**
 * Gets error log
 * @param {number} limit - Maximum number of errors to return
 * @returns {Array} - Array of error log entries
 */
export function getErrorLog(limit = MAX_ERROR_LOG_SIZE) {
    return errorLog.slice(-limit);
}

/**
 * Clears error log
 */
export function clearErrorLog() {
    errorLog = [];
}

/**
 * Creates a safe wrapper for async functions
 * @param {Function} asyncFunction - The async function to wrap
 * @param {Object} options - Wrapper options
 * @returns {Function} - Safe async function
 */
export function safeAsync(asyncFunction, options = {}) {
    const {
        context = 'general',
        fallbackValue = null,
        retryAttempts = 0,
        retryDelay = 1000,
        onError = null
    } = options;

    return async function(...args) {
        try {
            return await asyncFunction.apply(this, args);
        } catch (error) {
            const result = handleError(error, {
                context: context,
                showUserNotification: true,
                allowRecovery: retryAttempts > 0
            });

            // Call the onError callback if provided
            if (onError && typeof onError === 'function') {
                onError(error, result);
            }

            if (result.recoveryResult && result.recoveryResult.success) {
                // Recovery succeeded, retry the operation
                if (retryAttempts > 0) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    return safeAsync(asyncFunction, {
                        ...options,
                        retryAttempts: retryAttempts - 1
                    }).apply(this, args);
                }
            }

            return fallbackValue;
        }
    };
}

/**
 * Creates a safe wrapper for sync functions
 * @param {Function} syncFunction - The sync function to wrap
 * @param {Object} options - Wrapper options
 * @returns {Function} - Safe sync function
 */
export function safeSync(syncFunction, options = {}) {
    const {
        context = 'general',
        fallbackValue = null
    } = options;

    return function(...args) {
        try {
            return syncFunction.apply(this, args);
        } catch (error) {
            handleError(error, {
                context: context,
                showUserNotification: true,
                allowRecovery: false
            });

            return fallbackValue;
        }
    };
}

/**
 * Creates error boundaries for specific operations
 * @param {string} operationName - Name of the operation
 * @param {Function} operation - The operation function
 * @param {Object} options - Boundary options
 * @returns {Function} - Operation with error boundary
 */
export function createErrorBoundary(operationName, operation, options = {}) {
    const {
        fallbackValue = null,
        onError = null,
        retryAttempts = 0
    } = options;

    return safeAsync(async function(...args) {
        return await operation.apply(this, args);
    }, {
        context: operationName,
        fallbackValue: fallbackValue,
        retryAttempts: retryAttempts,
        onError: onError
    });
}

// Export the error handling system
export default {
    handleError,
    registerErrorHandler,
    setGlobalErrorHandler,
    getErrorLog,
    clearErrorLog,
    safeAsync,
    safeSync,
    createErrorBoundary,
    CodexError,
    ERROR_TYPES,
    ERROR_SEVERITY,
    RECOVERY_STRATEGIES
};