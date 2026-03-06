/**
 * Comprehensive Error Handler Tests
 * Tests the error handling system including error normalization, recovery strategies, and notifications
 */

describe('Error Handler', () => {
    let CodexError, handleError, ERROR_TYPES, ERROR_SEVERITY, RECOVERY_STRATEGIES;
    let mockConsole;
    let mockDocument;

    beforeEach(() => {
        // Mock console
        mockConsole = {
            error: jest.fn(),
            warn: jest.fn(),
            info: jest.fn(),
            log: jest.fn()
        };
        global.console = mockConsole;

        // Mock document for notifications
        mockDocument = {
            body: null,
            createElement: jest.fn().mockReturnValue({
                style: {},
                textContent: '',
                className: '',
                parentNode: null,
                remove: jest.fn()
            }),
            removeChild: jest.fn()
        };
        global.document = mockDocument;
    });

    describe('CodexError Class', () => {
        test('should create CodexError with required properties', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const error = new CodexError('Test error', ERROR_TYPES.VALIDATION, ERROR_SEVERITY.HIGH);

            expect(error.name).toBe('CodexError');
            expect(error.message).toBe('Test error');
            expect(error.type).toBe(ERROR_TYPES.VALIDATION);
            expect(error.severity).toBe(ERROR_SEVERITY.HIGH);
            expect(error.timestamp).toBeCloseTo(Date.now(), -2);
        });

        test('should create CodexError with default values', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;

            const error = new CodexError('Test error');

            expect(error.type).toBe(errorHandler.ERROR_TYPES.UNKNOWN);
            expect(error.severity).toBe(errorHandler.ERROR_SEVERITY.MEDIUM);
            expect(error.details).toBe(null);
        });

        test('should create CodexError with details', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const details = { field: 'name', value: 'test' };
            const error = new CodexError('Test error', ERROR_TYPES.VALIDATION, ERROR_SEVERITY.HIGH, details);

            expect(error.details).toEqual(details);
        });

        test('should be an instance of Error', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;

            const error = new CodexError('Test error');

            expect(error instanceof Error).toBe(true);
        });
    });

    describe('Error Normalization', () => {
        test('should normalize CodexError', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const codexError = new CodexError('Test error', ERROR_TYPES.STORAGE, ERROR_SEVERITY.HIGH);
            const result = handleError(codexError, { logToConsole: false });

            expect(result.error.type).toBe(ERROR_TYPES.STORAGE);
            expect(result.error.severity).toBe(ERROR_SEVERITY.HIGH);
        });

        test('should normalize standard Error', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            handleError = errorHandler.handleError;

            const standardError = new Error('Standard error');
            const result = handleError(standardError, { logToConsole: false });

            expect(result.error.type).toBe(errorHandler.ERROR_TYPES.UNKNOWN);
            expect(result.error.severity).toBe(errorHandler.ERROR_SEVERITY.MEDIUM);
        });

        test('should normalize string error', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            handleError = errorHandler.handleError;

            const stringError = 'String error message';
            const result = handleError(stringError, { logToConsole: false });

            expect(result.error.message).toBe('String error message');
            expect(result.error.type).toBe(errorHandler.ERROR_TYPES.UNKNOWN);
        });
    });

    describe('Error Logging', () => {
        test('should log critical errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const error = new CodexError('Critical error', ERROR_TYPES.STORAGE, ERROR_SEVERITY.CRITICAL);
            handleError(error, { showUserNotification: false });

            expect(mockConsole.error).toHaveBeenCalledWith('CRITICAL ERROR:', expect.objectContaining({
                message: 'Critical error',
                severity: ERROR_SEVERITY.CRITICAL
            }));
        });

        test('should log high severity errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const error = new CodexError('High error', ERROR_TYPES.STORAGE, ERROR_SEVERITY.HIGH);
            handleError(error, { showUserNotification: false });

            expect(mockConsole.error).toHaveBeenCalledWith('ERROR:', expect.objectContaining({
                message: 'High error',
                severity: ERROR_SEVERITY.HIGH
            }));
        });

        test('should log medium severity errors as warnings', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const error = new CodexError('Medium error', ERROR_TYPES.VALIDATION, ERROR_SEVERITY.MEDIUM);
            handleError(error, { showUserNotification: false });

            expect(mockConsole.warn).toHaveBeenCalledWith('WARNING:', expect.objectContaining({
                message: 'Medium error',
                severity: ERROR_SEVERITY.MEDIUM
            }));
        });
    });

    describe('Recovery Strategies', () => {
        test('should determine retry strategy for network errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;
            RECOVERY_STRATEGIES = errorHandler.RECOVERY_STRATEGIES;

            const error = new CodexError('Network error', ERROR_TYPES.NETWORK, ERROR_SEVERITY.HIGH);
            const result = handleError(error, { allowRecovery: true, showUserNotification: false });

            expect(result.recoveryStrategy).toBe(RECOVERY_STRATEGIES.RETRY);
        });

        test('should determine notify strategy for validation errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;
            RECOVERY_STRATEGIES = errorHandler.RECOVERY_STRATEGIES;

            const error = new CodexError('Validation error', ERROR_TYPES.VALIDATION, ERROR_SEVERITY.HIGH);
            const result = handleError(error, { allowRecovery: true, showUserNotification: false });

            expect(result.recoveryStrategy).toBe(RECOVERY_STRATEGIES.NOTIFY);
        });
    });

    describe('User Message Generation', () => {
        test('should generate user-friendly message for storage errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const error = new CodexError('Storage error', ERROR_TYPES.STORAGE, ERROR_SEVERITY.MEDIUM);
            const result = handleError(error, { showUserNotification: false });

            expect(result.userMessage).toBe('Unable to save your data. Please try again.');
        });

        test('should generate user-friendly message for quota errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            ERROR_TYPES = errorHandler.ERROR_TYPES;
            ERROR_SEVERITY = errorHandler.ERROR_SEVERITY;

            const error = new CodexError('Quota error', ERROR_TYPES.QUOTA, ERROR_SEVERITY.HIGH);
            const result = handleError(error, { showUserNotification: false });

            expect(result.userMessage).toBe('Storage quota exceeded. Cannot save more data.');
        });

        test('should use custom user message from details', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;

            const customMessage = 'Custom error message for user';
            const error = new CodexError('Error', errorHandler.ERROR_TYPES.VALIDATION, errorHandler.ERROR_SEVERITY.HIGH, {
                userMessage: customMessage
            });
            const result = handleError(error, { showUserNotification: false });

            expect(result.userMessage).toBe(customMessage);
        });
    });

    describe('Error Log', () => {
        test('should add errors to log', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            getErrorLog = errorHandler.getErrorLog;
            clearErrorLog = errorHandler.clearErrorLog;

            clearErrorLog();

            const error1 = new CodexError('Error 1', errorHandler.ERROR_TYPES.STORAGE, errorHandler.ERROR_SEVERITY.HIGH);
            const error2 = new CodexError('Error 2', errorHandler.ERROR_TYPES.VALIDATION, errorHandler.ERROR_SEVERITY.MEDIUM);

            handleError(error1, { logToConsole: false, showUserNotification: false });
            handleError(error2, { logToConsole: false, showUserNotification: false });

            const log = getErrorLog();
            expect(log).toHaveLength(2);
        });

        test('should limit error log size', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            getErrorLog = errorHandler.getErrorLog;
            clearErrorLog = errorHandler.clearErrorLog;

            clearErrorLog();

            const error = new CodexError('Test error', errorHandler.ERROR_TYPES.STORAGE, errorHandler.ERROR_SEVERITY.HIGH);

            // Add more than max log size (100)
            for (let i = 0; i < 150; i++) {
                handleError(error, { logToConsole: false, showUserNotification: false });
            }

            const log = getErrorLog();
            expect(log.length).toBeLessThanOrEqual(100);
        });

        test('should clear error log', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            getErrorLog = errorHandler.getErrorLog;
            clearErrorLog = errorHandler.clearErrorLog;

            clearErrorLog();

            const error = new CodexError('Test error', errorHandler.ERROR_TYPES.STORAGE, errorHandler.ERROR_SEVERITY.HIGH);

            handleError(error, { logToConsole: false, showUserNotification: false });
            expect(getErrorLog()).toHaveLength(1);

            clearErrorLog();
            expect(getErrorLog()).toHaveLength(0);
        });

        test('should return limited number of errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            getErrorLog = errorHandler.getErrorLog;
            clearErrorLog = errorHandler.clearErrorLog;

            clearErrorLog();

            const error = new CodexError('Test error', errorHandler.ERROR_TYPES.STORAGE, errorHandler.ERROR_SEVERITY.HIGH);

            for (let i = 0; i < 10; i++) {
                handleError(error, { logToConsole: false, showUserNotification: false });
            }

            const limitedLog = getErrorLog(5);
            expect(limitedLog).toHaveLength(5);
        });
    });

    describe('Error Handlers', () => {
        test('should register error handler', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            registerErrorHandler = errorHandler.registerErrorHandler;

            const handler = jest.fn();
            const unregister = registerErrorHandler(errorHandler.ERROR_TYPES.STORAGE, 'test-context', handler);

            expect(typeof unregister).toBe('function');
        });

        test('should call registered handler on matching error', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            registerErrorHandler = errorHandler.registerErrorHandler;

            const handler = jest.fn();
            registerErrorHandler(errorHandler.ERROR_TYPES.STORAGE, 'test-context', handler);

            const error = new CodexError('Storage error', errorHandler.ERROR_TYPES.STORAGE, errorHandler.ERROR_SEVERITY.HIGH);
            handleError(error, { logToConsole: false, showUserNotification: false, context: 'test-context' });

            expect(handler).toHaveBeenCalled();
        });

        test('should not call handler for different error type', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            registerErrorHandler = errorHandler.registerErrorHandler;

            const handler = jest.fn();
            registerErrorHandler(errorHandler.ERROR_TYPES.STORAGE, 'test-context', handler);

            const error = new CodexError('Validation error', errorHandler.ERROR_TYPES.VALIDATION, errorHandler.ERROR_SEVERITY.HIGH);
            handleError(error, { logToConsole: false, showUserNotification: false, context: 'test-context' });

            expect(handler).not.toHaveBeenCalled();
        });

        test('should unregister handler', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            registerErrorHandler = errorHandler.registerErrorHandler;

            const handler = jest.fn();
            const unregister = registerErrorHandler(errorHandler.ERROR_TYPES.STORAGE, 'test-context', handler);

            unregister();

            const error = new CodexError('Storage error', errorHandler.ERROR_TYPES.STORAGE, errorHandler.ERROR_SEVERITY.HIGH);
            handleError(error, { logToConsole: false, showUserNotification: false, context: 'test-context' });

            expect(handler).not.toHaveBeenCalled();
        });

        test('should handle handler errors gracefully', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            CodexError = errorHandler.CodexError;
            handleError = errorHandler.handleError;
            registerErrorHandler = errorHandler.registerErrorHandler;

            const erroringHandler = jest.fn(() => {
                throw new Error('Handler error');
            });
            registerErrorHandler(errorHandler.ERROR_TYPES.STORAGE, 'test-context', erroringHandler);

            const error = new CodexError('Storage error', errorHandler.ERROR_TYPES.STORAGE, errorHandler.ERROR_SEVERITY.HIGH);
            const result = handleError(error, { logToConsole: false, showUserNotification: false, context: 'test-context' });

            // Should not throw despite handler error
            expect(result.success).toBe(true);
        });
    });

    describe('Safe Async Wrapper', () => {
        test('should wrap async function and handle errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            safeAsync = errorHandler.safeAsync;

            const asyncFn = jest.fn().mockResolvedValue('success');
            const wrappedFn = safeAsync(asyncFn, { fallbackValue: 'fallback' });

            const result = await wrappedFn();
            expect(result).toBe('success');
            expect(asyncFn).toHaveBeenCalled();
        });

        test('should return fallback value on error', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            safeAsync = errorHandler.safeAsync;

            const asyncFn = jest.fn().mockRejectedValue(new Error('Async error'));
            const wrappedFn = safeAsync(asyncFn, { fallbackValue: 'fallback' });

            const result = await wrappedFn();
            expect(result).toBe('fallback');
        });

        test('should pass arguments to wrapped function', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            safeAsync = errorHandler.safeAsync;

            const asyncFn = jest.fn().mockResolvedValue('result');
            const wrappedFn = safeAsync(asyncFn, { fallbackValue: 'fallback' });

            await wrappedFn('arg1', 'arg2', 'arg3');

            expect(asyncFn).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
        });
    });

    describe('Safe Sync Wrapper', () => {
        test('should wrap sync function and handle errors', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            safeSync = errorHandler.safeSync;

            const syncFn = jest.fn().mockReturnValue('success');
            const wrappedFn = safeSync(syncFn, { fallbackValue: 'fallback' });

            const result = wrappedFn();
            expect(result).toBe('success');
            expect(syncFn).toHaveBeenCalled();
        });

        test('should return fallback value on error', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            safeSync = errorHandler.safeSync;

            const syncFn = jest.fn().mockImplementation(() => {
                throw new Error('Sync error');
            });
            const wrappedFn = safeSync(syncFn, { fallbackValue: 'fallback' });

            const result = wrappedFn();
            expect(result).toBe('fallback');
        });
    });

    describe('Error Boundaries', () => {
        test('should create error boundary for operation', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            createErrorBoundary = errorHandler.createErrorBoundary;

            const operation = jest.fn().mockResolvedValue('success');
            const boundary = createErrorBoundary('test-operation', operation, {
                fallbackValue: 'fallback'
            });

            const result = await boundary();
            expect(result).toBe('success');
        });

        test('should return fallback on error', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            createErrorBoundary = errorHandler.createErrorBoundary;

            const operation = jest.fn().mockRejectedValue(new Error('Operation error'));
            const boundary = createErrorBoundary('test-operation', operation, {
                fallbackValue: 'fallback'
            });

            const result = await boundary();
            expect(result).toBe('fallback');
        });

        test('should call onError callback if provided', async () => {
            const errorHandler = await import('../javascript/features/errorHandler.js');
            createErrorBoundary = errorHandler.createErrorBoundary;

            const onError = jest.fn();
            const operation = jest.fn().mockRejectedValue(new Error('Operation error'));
            const boundary = createErrorBoundary('test-operation', operation, {
                fallbackValue: 'fallback',
                onError: onError
            });

            await boundary();

            expect(onError).toHaveBeenCalled();
        });
    });
});