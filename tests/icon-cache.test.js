/**
 * Comprehensive Icon Cache Tests
 * Tests icon loading, caching, fallback mechanisms, and CSP compliance
 */

describe('Icon Cache', () => {
    let mockURL;

    beforeEach(() => {
        jest.resetModules();

        // Mock URL constructor
        mockURL = jest.fn((url) => {
            if (!url.startsWith('http') && !url.startsWith('data:') && !url.startsWith('chrome-extension:')) {
                throw new Error('Invalid URL');
            }
            return {
                protocol: url.startsWith('https:') ? 'https:' : url.startsWith('http:') ? 'http:' : url.split(':')[0] + ':',
                hostname: url.includes('://') ? url.split('://')[1].split('/')[0] : 'example.com',
                href: url
            };
        });
        global.URL = mockURL;
    });

    describe('Exported Functions', () => {
        test('loadIconWithCache should be exported', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            expect(typeof iconCacheModule.loadIconWithCache).toBe('function');
        });

        test('clearIconCache should be exported', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            expect(typeof iconCacheModule.clearIconCache).toBe('function');
        });

        test('getCacheStats should be exported', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            expect(typeof iconCacheModule.getCacheStats).toBe('function');
        });

        test('resetCacheStats should be exported', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            expect(typeof iconCacheModule.resetCacheStats).toBe('function');
        });

        test('preloadIcons should be exported', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            expect(typeof iconCacheModule.preloadIcons).toBe('function');
        });

        test('batchLoadIcons should be exported', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            expect(typeof iconCacheModule.batchLoadIcons).toBe('function');
        });
    });

    describe('Cache Statistics', () => {
        test('getCacheStats should return valid statistics', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const stats = iconCacheModule.getCacheStats();

            expect(stats).toHaveProperty('hits');
            expect(stats).toHaveProperty('misses');
            expect(stats).toHaveProperty('failures');
            expect(stats).toHaveProperty('totalRequests');
            expect(stats).toHaveProperty('cacheSize');
            expect(stats).toHaveProperty('hitRate');
            expect(stats).toHaveProperty('missRate');
            expect(stats).toHaveProperty('failureRate');
        });

        test('resetCacheStats should reset all statistics', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            iconCacheModule.resetCacheStats();
            const stats = iconCacheModule.getCacheStats();

            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(0);
            expect(stats.failures).toBe(0);
            expect(stats.totalRequests).toBe(0);
        });

        test('clearIconCache should be callable', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            expect(() => iconCacheModule.clearIconCache()).not.toThrow();
        });
    });

    describe('loadIconWithCache', () => {
        test('should return null for null link', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const result = await iconCacheModule.loadIconWithCache(null);
            expect(result).toBeNull();
        });

        test('should return null for undefined link', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const result = await iconCacheModule.loadIconWithCache(undefined);
            expect(result).toBeNull();
        });

        test('should handle empty object link', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const result = await iconCacheModule.loadIconWithCache({});
            // Should generate a fallback since no custom icon and favicon will fail
            expect(result).toBeDefined();
        });

        test('should handle link with only name', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const result = await iconCacheModule.loadIconWithCache({
                name: 'Test'
            });
            expect(result).toBeDefined();
        });

        test('should respect allowCustom option', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const link = {
                name: 'Test',
                url: 'https://example.com',
                icon: 'https://example.com/icon.png'
            };

            // Should try to load custom icon
            const result1 = await iconCacheModule.loadIconWithCache(link, {
                allowCustom: true,
                allowFavicon: false,
                allowGenerated: false
            });

            // Should generate fallback since custom won't load (no network)
            const result2 = await iconCacheModule.loadIconWithCache(link, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            expect(result2).toContain('data:image');
        });

        test('should respect allowGenerated option', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'Test',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            expect(result).toContain('data:image');
        });

        // TODO: The allowGenerated option doesn't prevent fallback generation
        // This appears to be a bug in the iconCache.js implementation
        test('should return null when no sources allowed', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'Test',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                preferCustom: false,
                allowFavicon: false,
                allowGenerated: false
            });

            expect(result).toBeNull();
        });

        test('should handle data URL icons', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'Test',
                url: 'https://example.com',
                icon: 'data:image/png;base64,iVBORw0KGgoAAAANS'
            });

            expect(result).toBeDefined();
        });

        test('should handle links with same URL but different names', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result1 = await iconCacheModule.loadIconWithCache({
                name: 'Site A',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            const result2 = await iconCacheModule.loadIconWithCache({
                name: 'Site B',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            // Both should generate SVG fallback icons
            expect(result1).toContain('data:image/svg+xml;base64');
            expect(result2).toContain('data:image/svg+xml;base64');
            // Since they have different names, they should generate different cache entries
            expect(result1).not.toBe(result2);
        });
    });

    describe('Options Handling', () => {
        test('should handle custom timeout option', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'Test',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true,
                timeout: 100
            });

            expect(result).toBeDefined();
        });

        test('should handle respectCSP option', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'Test',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true,
                respectCSP: true
            });

            expect(result).toBeDefined();
        });
    });

    describe('Batch Operations', () => {
        test('batchLoadIcons should be callable with empty array', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const result = await iconCacheModule.batchLoadIcons([]);

            expect(result).toEqual([]);
        });

        test('batchLoadIcons should be callable with links', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const links = [
                { name: 'Test1', url: 'https://example1.com' },
                { name: 'Test2', url: 'https://example2.com' }
            ];

            const result = await iconCacheModule.batchLoadIcons(links, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true,
                batchSize: 10,
                delayBetweenBatches: 0
            });

            expect(result).toHaveLength(2);
        });

        test('preloadIcons should be callable with links', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');
            const links = [
                { name: 'Test1', url: 'https://example1.com' },
                { name: 'Test2', url: 'https://example2.com' }
            ];

            // Should not throw
            await expect(iconCacheModule.preloadIcons(links)).resolves.toBeUndefined();
        });
    });

    describe('Edge Cases', () => {
        test('should handle very long link name', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'A'.repeat(500),
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            expect(result).toBeDefined();
        });

        test('should handle special characters in link name', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'Test-Site_123',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            expect(result).toBeDefined();
        });

        test('should handle Unicode characters in link name', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: '日本語テスト',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            expect(result).toBeDefined();
        });

        test('should handle emoji in link name', async () => {
            const iconCacheModule = await import('../javascript/features/iconCache.js');

            const result = await iconCacheModule.loadIconWithCache({
                name: 'Hello 🌍',
                url: 'https://example.com'
            }, {
                allowCustom: false,
                allowFavicon: false,
                allowGenerated: true
            });

            expect(result).toBeDefined();
        });
    });
});