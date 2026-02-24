/**
 * Comprehensive Security Utils Tests
 * Tests HTML sanitization, URL validation, and security utilities
 */

describe('Security Utils', () => {
    let mockDocument;
    let mockURL;

    beforeEach(() => {
        // Mock URL constructor
        mockURL = global.URL;

        // Mock document for DOM operations
        const mockElement = {
            innerHTML: '',
            textContent: '',
            querySelectorAll: jest.fn(() => []),
            getElementsByTagName: jest.fn(() => []),
            hasAttribute: jest.fn(() => false),
            getAttribute: jest.fn(() => null),
            removeAttribute: jest.fn(),
            parentNode: null,
            remove: jest.fn(),
            attributes: []
        };

        const mockNode = {
            textContent: '',
            replaceChild: jest.fn()
        };

        mockDocument = {
            createElement: jest.fn(() => mockElement),
            createTextNode: jest.fn(() => mockNode)
        };

        global.document = mockDocument;
    });

    describe('HTML Purification', () => {
        test('should sanitize HTML with dangerous elements', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            const dangerousHTML = '<script>alert("XSS")</script><p>Safe content</p>';
            const sanitized = purifyHTML(dangerousHTML);

            expect(sanitized).not.toContain('<script>');
            expect(sanitized).toContain('<p>Safe content</p>');
        });

        test('should remove style tags', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            const htmlWithStyle = '<style>body { background: red; }</style><p>Content</p>';
            const sanitized = purifyHTML(htmlWithStyle);

            expect(sanitized).not.toContain('<style>');
        });

        test('should remove iframe elements', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            const htmlWithIframe = '<iframe src="evil.com"></iframe><p>Content</p>';
            const sanitized = purifyHTML(htmlWithIframe);

            expect(sanitized).not.toContain('<iframe>');
        });

        test('should remove event handler attributes', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            const htmlWithEvents = '<p onclick="alert(\'XSS\')">Click me</p>';
            const sanitized = purifyHTML(htmlWithEvents);

            expect(sanitized).not.toContain('onclick');
        });

        test('should keep allowed tags', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            const htmlWithAllowed = '<div><p><strong>Bold</strong> <em>italic</em></p></div>';
            const sanitized = purifyHTML(htmlWithAllowed);

            expect(sanitized).toContain('<div>');
            expect(sanitized).toContain('<p>');
            expect(sanitized).toContain('<strong>');
            expect(sanitized).toContain('<em>');
        });

        test('should validate URLs in href attributes', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            const htmlWithHref = '<a href="javascript:alert(\'XSS\')">Click</a>';
            const sanitized = purifyHTML(htmlWithHref);

            expect(sanitized).not.toContain('javascript:');
        });

        test('should handle custom allowed tags', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            const html = '<div><span>Text</span><code>code</code></div>';
            const sanitized = purifyHTML(html, { allowedTags: ['div', 'span'] });

            expect(sanitized).toContain('<div>');
            expect(sanitized).toContain('<span>');
            expect(sanitized).not.toContain('<code>');
        });

        test('should handle empty or null input', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            expect(purifyHTML('')).toBe('');
            expect(purifyHTML(null)).toBe('');
            expect(purifyHTML(undefined)).toBe('');
        });

        test('should handle non-string input', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const purifyHTML = securityUtils.purifyHTML;

            expect(purifyHTML(123)).toBe('');
            expect(purifyHTML({})).toBe('');
        });
    });

    describe('Schema Validation', () => {
        test('should validate correct data structure', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'name', type: 'string', required: true, minLength: 1, maxLength: 100 },
                    { field: 'age', type: 'number', min: 0, max: 150 }
                ]
            };

            const data = { name: 'John Doe', age: 30 };
            const result = validateSchema(data, schema);

            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        test('should fail validation for missing required field', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'name', type: 'string', required: true }
                ]
            };

            const data = { };
            const result = validateSchema(data, schema);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('name: Field is required but was undefined');
        });

        test('should fail validation for wrong type', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'age', type: 'number' }
                ]
            };

            const data = { age: 'thirty' };
            const result = validateSchema(data, schema);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('age: Expected number, got string');
        });

        test('should fail validation for string too short', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'name', type: 'string', minLength: 5 }
                ]
            };

            const data = { name: 'Bob' };
            const result = validateSchema(data, schema);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('name: Minimum length is 5, got 3 characters');
        });

        test('should fail validation for string too long', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'name', type: 'string', maxLength: 10 }
                ]
            };

            const data = { name: 'This name is too long' };
            const result = validateSchema(data, schema);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('name: Maximum length is 10, got 21 characters');
        });

        test('should validate enum values', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'status', type: 'string', enum: ['active', 'inactive', 'pending'] }
                ]
            };

            const validData = { status: 'active' };
            const validResult = validateSchema(validData, schema);
            expect(validResult.valid).toBe(true);

            const invalidData = { status: 'invalid' };
            const invalidResult = validateSchema(invalidData, schema);
            expect(invalidResult.valid).toBe(false);
        });

        test('should validate pattern matching', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'email', type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' }
                ]
            };

            const validData = { email: 'test@example.com' };
            const validResult = validateSchema(validData, schema);
            expect(validResult.valid).toBe(true);

            const invalidData = { email: 'invalid-email' };
            const invalidResult = validateSchema(invalidData, schema);
            expect(invalidResult.valid).toBe(false);
        });

        test('should handle nullable types', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    { field: 'optional', type: ['string', 'null'] }
                ]
            };

            const dataWithNull = { optional: null };
            const result = validateSchema(dataWithNull, schema);
            expect(result.valid).toBe(true);

            const dataWithString = { optional: 'value' };
            const result2 = validateSchema(dataWithString, schema);
            expect(result2.valid).toBe(true);
        });

        test('should handle custom validation function', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateSchema = securityUtils.validateSchema;

            const schema = {
                fields: [
                    {
                        field: 'password',
                        type: 'string',
                        validate: (value) => {
                            if (value.length < 8) return 'Password must be at least 8 characters';
                            if (!/[A-Z]/.test(value)) return 'Password must contain uppercase letter';
                            if (!/[0-9]/.test(value)) return 'Password must contain number';
                            return true;
                        }
                    }
                ]
            };

            const weakPassword = { password: 'weak' };
            const weakResult = validateSchema(weakPassword, schema);
            expect(weakResult.valid).toBe(false);

            const strongPassword = { password: 'StrongPass123' };
            const strongResult = validateSchema(strongPassword, schema);
            expect(strongResult.valid).toBe(true);
        });
    });

    describe('Link Validation', () => {
        test('should validate correct link object', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const validLink = {
                name: 'Example Site',
                url: 'https://example.com',
                category: 'Test',
                icon: 'https://example.com/favicon.ico',
                size: 'medium'
            };

            const result = validateLink(validLink);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        test('should validate link without optional fields', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const validLink = {
                name: 'Example Site',
                url: 'https://example.com',
                category: 'Test'
            };

            const result = validateLink(validLink);
            expect(result.valid).toBe(true);
        });

        test('should accept null for optional icon field', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const link = {
                name: 'Example Site',
                url: 'https://example.com',
                category: 'Test',
                icon: null
            };

            const result = validateLink(link);
            expect(result.valid).toBe(true);
        });

        test('should accept null for optional size field', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const link = {
                name: 'Example Site',
                url: 'https://example.com',
                category: 'Test',
                size: null
            };

            const result = validateLink(link);
            expect(result.valid).toBe(true);
        });

        test('should reject link without name', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const invalidLink = {
                url: 'https://example.com',
                category: 'Test'
            };

            const result = validateLink(invalidLink);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('name: Field is required but was undefined');
        });

        test('should reject link without url', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const invalidLink = {
                name: 'Example Site',
                category: 'Test'
            };

            const result = validateLink(invalidLink);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('url: Field is required but was undefined');
        });

        test('should reject link without category', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const invalidLink = {
                name: 'Example Site',
                url: 'https://example.com'
            };

            const result = validateLink(invalidLink);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('category: Field is required but was undefined');
        });

        test('should reject link with invalid URL', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const invalidLink = {
                name: 'Example Site',
                url: 'not-a-url',
                category: 'Test'
            };

            const result = validateLink(invalidLink);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('url: Invalid URL format: not-a-url');
        });

        test('should reject link with invalid size', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const invalidLink = {
                name: 'Example Site',
                url: 'https://example.com',
                category: 'Test',
                size: 'invalid-size'
            };

            const result = validateLink(invalidLink);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('size: Invalid size value: invalid-size');
        });

        test('should handle null link object', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const result = validateLink(null);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Link object is null or undefined');
        });

        test('should handle non-object link', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const validateLink = securityUtils.validateLink;

            const result = validateLink('not an object');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Link must be an object, got string');
        });
    });

    describe('User Input Sanitization', () => {
        test('should sanitize user input by trimming whitespace', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const input = '  spaced input  ';
            const sanitized = sanitizeUserInput(input);

            expect(sanitized).toBe('spaced input');
        });

        test('should remove control characters', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const input = 'test\u0000\u0001\u007Fstring';
            const sanitized = sanitizeUserInput(input);

            expect(sanitized).toBe('teststring');
        });

        test('should limit input length', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const longInput = 'A'.repeat(200);
            const sanitized = sanitizeUserInput(longInput, { maxLength: 50 });

            expect(sanitized.length).toBe(50);
        });

        test('should sanitize HTML in user input', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const input = 'Click <script>alert("XSS")</script> here';
            const sanitized = sanitizeUserInput(input);

            expect(sanitized).not.toContain('<script>');
        });

        test('should handle empty or null input', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            expect(sanitizeUserInput('')).toBe('');
            expect(sanitizeUserInput(null)).toBe('');
            expect(sanitizeUserInput(undefined)).toBe('');
        });

        test('should handle non-string input', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            expect(sanitizeUserInput(123)).toBe('');
            expect(sanitizeUserInput({})).toBe('');
        });
    });

    describe('Edge Cases', () => {
        test('should handle very long strings without crashing', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const veryLongString = 'A'.repeat(10000);
            const sanitized = sanitizeUserInput(veryLongString, { maxLength: 1000 });

            expect(sanitized.length).toBe(1000);
        });

        test('should handle special characters in input', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const input = 'Test <>&"\'\\/';
            const sanitized = sanitizeUserInput(input);

            expect(sanitized).toContain('Test');
        });

        test('should handle Unicode characters', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const input = '日本語 中文 العربية';
            const sanitized = sanitizeUserInput(input);

            expect(sanitized).toBe('日本語 中文 العربية');
        });

        test('should handle emoji in input', async () => {
            const securityUtils = await import('../javascript/features/securityUtils.js');
            const sanitizeUserInput = securityUtils.sanitizeUserInput;

            const input = 'Hello 😀 World 🌍';
            const sanitized = sanitizeUserInput(input);

            expect(sanitized).toContain('😀');
            expect(sanitized).toContain('🌍');
        });
    });
});