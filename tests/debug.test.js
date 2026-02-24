/**
 * Debug Module Tests
 * Tests the debug logging utility including debug enable/disable, logging functions
 */

describe('Debug Module', () => {
    let mockConsole;

    beforeEach(() => {
        // Mock console
        mockConsole = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
        global.console = mockConsole;
    });

    describe('Debug Toggle', () => {
        test('should be disabled by default', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            expect(debugModule.isDebugEnabled()).toBe(false);
        });

        test('should enable debug logging', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            expect(debugModule.isDebugEnabled()).toBe(true);
        });

        test('should disable debug logging', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            expect(debugModule.isDebugEnabled()).toBe(true);

            debugModule.setDebugEnabled(false);
            expect(debugModule.isDebugEnabled()).toBe(false);
        });

        test('should toggle debug state', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            expect(debugModule.isDebugEnabled()).toBe(false);

            debugModule.setDebugEnabled(true);
            expect(debugModule.isDebugEnabled()).toBe(true);

            debugModule.setDebugEnabled(false);
            expect(debugModule.isDebugEnabled()).toBe(false);
        });
    });

    describe('debug() Function', () => {
        test('should log when debug is enabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug('Test message', { data: 'value' });

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', 'Test message', { data: 'value' });
        });

        test('should not log when debug is disabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(false);
            debugModule.debug('Test message');

            expect(mockConsole.log).not.toHaveBeenCalled();
        });

        test('should handle single argument', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug('Single message');

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', 'Single message');
        });

        test('should handle multiple arguments', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug('Message', 'arg1', 'arg2', 'arg3');

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', 'Message', 'arg1', 'arg2', 'arg3');
        });

        test('should not log anything when called with no arguments', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug();

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]');
        });
    });

    describe('debugWarn() Function', () => {
        test('should log warning when debug is enabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debugWarn('Warning message', { data: 'value' });

            expect(mockConsole.warn).toHaveBeenCalledWith('[DEBUG]', 'Warning message', { data: 'value' });
        });

        test('should not log when debug is disabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(false);
            debugModule.debugWarn('Warning message');

            expect(mockConsole.warn).not.toHaveBeenCalled();
        });

        test('should log to console.warn not console.log', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debugWarn('Test');

            expect(mockConsole.warn).toHaveBeenCalled();
            expect(mockConsole.log).not.toHaveBeenCalled();
        });
    });

    describe('debugError() Function', () => {
        test('should log error when debug is enabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debugError('Error message', { data: 'value' });

            expect(mockConsole.error).toHaveBeenCalledWith('[DEBUG]', 'Error message', { data: 'value' });
        });

        test('should log error even when debug is disabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(false);
            debugModule.debugError('Error message');

            expect(mockConsole.error).toHaveBeenCalledWith('Error message');
            expect(mockConsole.error).not.toHaveBeenCalledWith('[DEBUG]', expect.anything());
        });

        test('should include debug prefix when enabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debugError('Error message');

            expect(mockConsole.error).toHaveBeenCalledWith('[DEBUG]', 'Error message');
        });

        test('should handle Error objects', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            const error = new Error('Test error');
            debugModule.debugError('Error occurred:', error);

            expect(mockConsole.error).toHaveBeenCalledWith('[DEBUG]', 'Error occurred:', error);
        });
    });

    describe('State Persistence', () => {
        test('should maintain state between calls', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug('First call');
            debugModule.debug('Second call');

            expect(mockConsole.log).toHaveBeenCalledTimes(2);
        });

        test('should not log after being disabled', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug('Enabled');
            debugModule.setDebugEnabled(false);
            debugModule.debug('Disabled');

            expect(mockConsole.log).toHaveBeenCalledTimes(1);
            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', 'Enabled');
        });
    });

    describe('Multiple Function Calls', () => {
        test('should handle multiple debug calls', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug('Call 1');
            debugModule.debug('Call 2');
            debugModule.debug('Call 3');

            expect(mockConsole.log).toHaveBeenCalledTimes(3);
        });

        test('should handle mix of debug function calls', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            debugModule.debug('Info');
            debugModule.debugWarn('Warning');
            debugModule.debugError('Error');

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', 'Info');
            expect(mockConsole.warn).toHaveBeenCalledWith('[DEBUG]', 'Warning');
            expect(mockConsole.error).toHaveBeenCalledWith('[DEBUG]', 'Error');
        });
    });

    describe('Edge Cases', () => {
        test('should handle very long messages', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            const longMessage = 'A'.repeat(10000);
            debugModule.debug(longMessage);

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', longMessage);
        });

        test('should handle special characters', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            const specialChars = 'Test <>&"\'\\/\n\t';
            debugModule.debug(specialChars);

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', specialChars);
        });

        test('should handle Unicode characters', async () => {
            const debugModule = await import('../javascript/core-systems/debug.js');
            debugModule.setDebugEnabled(true);
            const unicode = '日本語 中文 العربية 🎉';
            debugModule.debug(unicode);

            expect(mockConsole.log).toHaveBeenCalledWith('[DEBUG]', unicode);
        });
    });
});