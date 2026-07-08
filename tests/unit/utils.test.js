/**
 * Utils Module Tests
 * Tests utility functions including debounce, throttle, sanitization, and URL validation
 */

import { jest } from '@jest/globals';

describe('Utils Module', () => {
    describe('debounce', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should debounce function calls', async () => {
            const utils = await import('../javascript/features/utils.js');
            const fn = jest.fn();
            const debouncedFn = utils.debounce(fn, 100);

            debouncedFn();
            debouncedFn();
            debouncedFn();

            // Function should not be called yet
            expect(fn).not.toHaveBeenCalled();

            // Fast forward time
            jest.advanceTimersByTime(100);

            // Function should be called once
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test('should pass arguments to debounced function', async () => {
            const utils = await import('../javascript/features/utils.js');
            const fn = jest.fn();
            const debouncedFn = utils.debounce(fn, 100);

            debouncedFn('arg1', 'arg2');

            jest.advanceTimersByTime(100);

            expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
        });

        test('should reset timer on subsequent calls', async () => {
            const utils = await import('../javascript/features/utils.js');
            const fn = jest.fn();
            const debouncedFn = utils.debounce(fn, 100);

            debouncedFn();
            jest.advanceTimersByTime(50);
            debouncedFn();
            jest.advanceTimersByTime(50);
            debouncedFn();
            jest.advanceTimersByTime(100);

            // Function should only be called once after the final debounce delay
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('throttle', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should throttle function calls', async () => {
            const utils = await import('../javascript/features/utils.js');
            const fn = jest.fn();
            const throttledFn = utils.throttle(fn, 100);

            throttledFn();
            throttledFn();
            throttledFn();

            // Function should be called immediately on first call
            expect(fn).toHaveBeenCalledTimes(1);

            // Advance time but not past throttle limit
            jest.advanceTimersByTime(50);
            throttledFn();

            // Function should still only be called once
            expect(fn).toHaveBeenCalledTimes(1);

            // Advance time past throttle limit
            jest.advanceTimersByTime(50);
            throttledFn();

            // Function should be called again
            expect(fn).toHaveBeenCalledTimes(2);
        });

        test('should pass arguments to throttled function', async () => {
            const utils = await import('../javascript/features/utils.js');
            const fn = jest.fn();
            const throttledFn = utils.throttle(fn, 100);

            throttledFn('arg1', 'arg2');

            expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
        });

        test('should ignore calls during throttle period', async () => {
            const utils = await import('../javascript/features/utils.js');
            const fn = jest.fn();
            const throttledFn = utils.throttle(fn, 100);

            throttledFn('first');
            expect(fn).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(50);
            throttledFn('second');
            expect(fn).toHaveBeenCalledTimes(1);  // Still only called once

            jest.advanceTimersByTime(100);
            throttledFn('third');
            expect(fn).toHaveBeenCalledTimes(2);  // Called again after throttle period
        });
    });

    describe('sanitizeHTML', () => {
        test('should remove dangerous HTML tags', async () => {
            const utils = await import('../javascript/features/utils.js');
            const dangerousHTML = '<script>alert("XSS")</script>Hello<p>World</p>';
            const result = utils.sanitizeHTML(dangerousHTML);

            expect(result).not.toContain('<script>');
            expect(result).toContain('Hello');
            expect(result).not.toContain('<p>');  // textContent removes all HTML
        });

        test('should remove event handlers', async () => {
            const utils = await import('../javascript/features/utils.js');
            const dangerousHTML = '<div onclick="alert(\'XSS\')">Click me</div>';
            const result = utils.sanitizeHTML(dangerousHTML);

            expect(result).not.toContain('onclick');
        });

        test('should preserve text content from safe HTML', async () => {
            const utils = await import('../javascript/features/utils.js');
            const safeHTML = '<div class="test">Hello <span>World</span></div>';
            const result = utils.sanitizeHTML(safeHTML);

            expect(result).not.toContain('<div');  // textContent removes all HTML
            expect(result).not.toContain('<span>');
            expect(result).toContain('Hello');
            expect(result).toContain('World');
        });

        test('should handle empty string', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.sanitizeHTML('');

            expect(result).toBe('');
        });

        test('should handle null input', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.sanitizeHTML(null);

            expect(result).toBe('');
        });
    });

    describe('validateAndSanitizeUrl', () => {
        test('should validate and normalize valid URLs', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.validateAndSanitizeUrl('https://example.com');

            expect(result).toBe('https://example.com/');
        });

        test('should reject invalid URLs', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.validateAndSanitizeUrl('not-a-url');

            expect(result).toBe('#');
        });

        test('should reject javascript: URLs', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.validateAndSanitizeUrl('javascript:alert("XSS")');

            expect(result).toBe('#');
        });

        test('should reject data: URLs', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.validateAndSanitizeUrl('data:text/html,<script>alert("XSS")</script>');

            expect(result).toBe('#');
        });

        test('should fail for URLs without protocol', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.validateAndSanitizeUrl('example.com');

            // URLs without protocol are invalid and return '#'
            expect(result).toBe('#');
        });

        test('should handle empty string', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.validateAndSanitizeUrl('');

            expect(result).toBe('#');
        });

        test('should accept http: URLs', async () => {
            const utils = await import('../javascript/features/utils.js');
            const result = utils.validateAndSanitizeUrl('http://example.com');

            expect(result).toBe('http://example.com/');
        });
    });

    describe('isValidUrlFormat', () => {
        test('should return true for valid https URLs', async () => {
            const utils = await import('../javascript/features/utils.js');
            expect(utils.isValidUrlFormat('https://example.com')).toBe(true);
        });

        test('should return true for http URLs', async () => {
            const utils = await import('../javascript/features/utils.js');
            expect(utils.isValidUrlFormat('http://example.com')).toBe(true);
        });

        test('should return true for javascript: URLs (parsable)', async () => {
            const utils = await import('../javascript/features/utils.js');
            expect(utils.isValidUrlFormat('javascript:alert("XSS")')).toBe(true);
        });

        test('should return true for data: URLs (parsable)', async () => {
            const utils = await import('../javascript/features/utils.js');
            expect(utils.isValidUrlFormat('data:text/html,test')).toBe(true);
        });

        test('should return false for invalid URL format', async () => {
            const utils = await import('../javascript/features/utils.js');
            expect(utils.isValidUrlFormat('not-a-url')).toBe(false);
        });
    });

    describe('extractDomain', () => {
        test('should extract domain from URL', async () => {
            const utils = await import('../javascript/features/utils.js');
            const domain = utils.extractDomain('https://example.com/path');

            expect(domain).toBe('example.com');
        });

        test('should extract domain from URL with subdomain', async () => {
            const utils = await import('../javascript/features/utils.js');
            const domain = utils.extractDomain('https://www.example.com/path');

            expect(domain).toBe('www.example.com');
        });

        test('should extract domain from URL with port', async () => {
            const utils = await import('../javascript/features/utils.js');
            const domain = utils.extractDomain('https://example.com:8080/path');

            expect(domain).toBe('example.com');  // hostname doesn't include port
        });

        test('should extract domain from URL with query string', async () => {
            const utils = await import('../javascript/features/utils.js');
            const domain = utils.extractDomain('https://example.com/path?query=value');

            expect(domain).toBe('example.com');
        });

        test('should extract domain from URL with fragment', async () => {
            const utils = await import('../javascript/features/utils.js');
            const domain = utils.extractDomain('https://example.com/path#fragment');

            expect(domain).toBe('example.com');
        });

        test('should handle invalid URL gracefully', async () => {
            const utils = await import('../javascript/features/utils.js');
            const domain = utils.extractDomain('not-a-url');

            expect(domain).toBe('');
        });

        test('should handle empty string', async () => {
            const utils = await import('../javascript/features/utils.js');
            const domain = utils.extractDomain('');

            expect(domain).toBe('');
        });
    });
});