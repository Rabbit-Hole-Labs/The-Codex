/**
 * Storage Manager Functionality Tests
 * This test suite verifies the core functionality of the storage manager
 * including data persistence, settings management, and error handling
 */

import { jest } from '@jest/globals';

describe('Storage Manager Functionality', () => {
  // Mock the Chrome storage API
  const mockChromeStorage = {
    sync: {
      get: jest.fn(),
      set: jest.fn(),
      clear: jest.fn()
    },
    local: {
      get: jest.fn(),
      set: jest.fn(),
      clear: jest.fn()
    }
  };

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Set up global chrome object
    global.chrome = {
      storage: mockChromeStorage
    };
  });

  describe('Link Management', () => {
    test('should load links and default settings when storage is empty', async () => {
      // Simulate empty storage
      mockChromeStorage.sync.get.mockResolvedValue({});
      mockChromeStorage.local.get.mockResolvedValue({});

      // Import the actual storage manager
      const { loadLinks } = await import('../javascript/core-systems/storageManager.js');

      // Call the function
      const result = await loadLinks();

      // Verify default values
      expect(Array.isArray(result.links)).toBe(true);
      expect(result.links).toEqual([]);
      expect(result.theme).toBe('dark');
      expect(result.view).toBe('grid');
      expect(result.colorTheme).toBe('default');
      expect(result.defaultTileSize).toBe('medium');
    });

    test('should load valid link data from storage', async () => {
      // Simulate valid data in storage
      const validLinks = [
        { name: 'Test Link', url: 'https://example.com', category: 'Test' },
        { name: 'Another Link', url: 'https://test.com', category: 'Test' }
      ];
      
      mockChromeStorage.sync.get.mockResolvedValue({
        links: validLinks,
        theme: 'light',
        view: 'list'
      });

      // Import the actual storage manager
      const { loadLinks } = await import('../javascript/core-systems/storageManager.js');

      // Call the function
      const result = await loadLinks();

      // Verify that valid data is loaded correctly
      expect(Array.isArray(result.links)).toBe(true);
      expect(result.links).toEqual(validLinks);
      expect(result.theme).toBe('light');
      expect(result.view).toBe('list');
    });

    test('should save valid link data to storage', async () => {
      // Mock successful save
      mockChromeStorage.sync.set.mockResolvedValue();

      // Import the actual storage manager
      const { saveLinks } = await import('../javascript/core-systems/storageManager.js');

      // Test with valid data
      const validLinks = [
        { name: 'Test Link', url: 'https://example.com', category: 'Test' }
      ];

      const result = await saveLinks(validLinks);

      // Verify that save was successful
      expect(result).toBe(true);
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith({
        links: JSON.stringify(validLinks)
      });
    });

    test('should reject invalid link data during save', async () => {
      // Import the actual storage manager
      const { saveLinks } = await import('../javascript/core-systems/storageManager.js');

      // Test with invalid data (not an array)
      const invalidLinks = { not: 'an array' };

      const result = await saveLinks(invalidLinks);

      // Should be rejected
      expect(result).toBe(false);
    });
  });

  describe('Settings Management', () => {
    test('should save valid settings to storage', async () => {
      // Mock successful save
      mockChromeStorage.sync.set.mockResolvedValue();

      // Import the actual storage manager
      const { saveSettings } = await import('../javascript/core-systems/storageManager.js');

      // Test with valid settings
      const validSettings = {
        theme: 'light',
        colorTheme: 'ocean',
        view: 'list',
        defaultTileSize: 'large'
      };

      const result = await saveSettings(validSettings);

      // Verify that save was successful
      expect(result).toBe(true);
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith(validSettings);
    });

    test('should filter out invalid settings during save', async () => {
      // Mock successful save
      mockChromeStorage.sync.set.mockResolvedValue();

      // Import the actual storage manager
      const { saveSettings } = await import('../javascript/core-systems/storageManager.js');

      // Test with mixed valid/invalid settings
      const mixedSettings = {
        theme: 'invalid-theme', // Invalid
        colorTheme: 'ocean',    // Valid
        view: 'grid',           // Valid
        invalidProp: 'value'    // Invalid
      };

      const result = await saveSettings(mixedSettings);

      // Should be successful but only save valid settings
      expect(result).toBe(true);
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith({
        colorTheme: 'ocean',
        view: 'grid'
      });
    });
  });

  describe('Category Management', () => {
    test('should load categories with default category when storage is empty', async () => {
      // Simulate empty storage
      mockChromeStorage.sync.get.mockResolvedValue({});
      mockChromeStorage.local.get.mockResolvedValue({});

      // Import the actual storage manager
      const { loadCategories } = await import('../javascript/core-systems/storageManager.js');

      // Call the function
      const result = await loadCategories();

      // Verify default category exists
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual(['Default']);
    });

    test('should load valid categories from storage', async () => {
      // Simulate valid data in storage
      const validCategories = ['Default', 'Work', 'Personal', 'Development'];
      
      mockChromeStorage.sync.get.mockResolvedValue({
        categories: validCategories
      });

      // Import the actual storage manager
      const { loadCategories } = await import('../javascript/core-systems/storageManager.js');

      // Call the function
      const result = await loadCategories();

      // Verify that valid data is loaded correctly
      expect(result).toEqual(validCategories);
      expect(result[0]).toBe('Default'); // Default should always be first
    });

    test('should save valid categories to storage', async () => {
      // Mock successful save
      mockChromeStorage.sync.set.mockResolvedValue();

      // Import the actual storage manager
      const { saveCategories } = await import('../javascript/core-systems/storageManager.js');

      // Test with valid data
      const validCategories = ['Default', 'Work', 'Personal'];

      const result = await saveCategories(validCategories);

      // Verify that save was successful
      expect(result).toEqual(validCategories);
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith({
        categories: JSON.stringify(validCategories)
      });
    });
  });

  describe('Storage Error Handling', () => {
    test('should handle sync storage failure by falling back to local storage', async () => {
      // Mock sync failure but local success
      mockChromeStorage.sync.set.mockRejectedValue(new Error('Sync storage failed'));
      mockChromeStorage.local.set.mockResolvedValue();

      // Import the actual storage manager
      const { saveLinks } = await import('../javascript/core-systems/storageManager.js');

      // Test with valid data
      const validLinks = [
        { name: 'Test Link', url: 'https://example.com', category: 'Test' }
      ];

      const result = await saveLinks(validLinks);

      // Should succeed with fallback
      expect(result).toBe(true);
      expect(mockChromeStorage.sync.set).toHaveBeenCalled();
      expect(mockChromeStorage.local.set).toHaveBeenCalledWith({
        links: JSON.stringify(validLinks)
      });
    });

    test('should handle complete storage failure gracefully', async () => {
      // Mock both sync and local failure
      mockChromeStorage.sync.set.mockRejectedValue(new Error('Sync storage failed'));
      mockChromeStorage.local.set.mockRejectedValue(new Error('Local storage failed'));

      // Import the actual storage manager
      const { saveLinks } = await import('../javascript/core-systems/storageManager.js');

      // Test with valid data
      const validLinks = [
        { name: 'Test Link', url: 'https://example.com', category: 'Test' }
      ];

      const result = await saveLinks(validLinks);

      // Should fail gracefully
      expect(result).toBe(false);
    });
  });
});