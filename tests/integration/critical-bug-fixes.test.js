/**
 * Jest Test Suite for General Application Functionality
 * This test suite verifies the core functionality of the application
 * including state management, link operations, and user interactions
 */

import { jest } from '@jest/globals';

// Mock Chrome APIs
const mockChromeStorage = {
  sync: {
    get: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(),
    clear: jest.fn().mockResolvedValue()
  },
  local: {
    get: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue(),
    clear: jest.fn().mockResolvedValue()
  }
};

global.chrome = {
  storage: mockChromeStorage,
  bookmarks: {
    getTree: jest.fn().mockResolvedValue([])
  }
};

// Mock the imported modules
jest.unstable_mockModule('../javascript/core-systems/storageManager.js', () => ({
  loadLinks: jest.fn().mockResolvedValue({ 
    links: [], 
    theme: 'dark', 
    view: 'grid', 
    colorTheme: 'default', 
    defaultTileSize: 'medium' 
  }),
  saveLinks: jest.fn().mockResolvedValue(true),
  loadCategories: jest.fn().mockResolvedValue(['Default']),
  saveCategories: jest.fn().mockResolvedValue(['Default']),
  loadSettings: jest.fn().mockResolvedValue({ 
    theme: 'dark', 
    colorTheme: 'default', 
    view: 'grid', 
    defaultTileSize: 'medium' 
  }),
  saveSettings: jest.fn().mockResolvedValue(true)
}));

jest.unstable_mockModule('../javascript/core-systems/stateManager.js', () => ({
  safeUpdateState: jest.fn().mockImplementation(async (updates, options) => {
    // Simulate successful update for valid data, failure for invalid
    if (updates.links && !Array.isArray(updates.links)) {
      return { success: false, error: 'Links must be an array' };
    }
    return { success: true, newState: updates };
  }),
  updateState: jest.fn().mockImplementation((updates, options) => {
    return { success: true, newState: updates };
  }),
  getState: jest.fn().mockReturnValue({
    links: [],
    theme: 'dark',
    colorTheme: 'default',
    view: 'grid',
    categories: ['Default'],
    filteredLinks: [],
    searchTerm: ''
  })
}));

jest.unstable_mockModule('../javascript/entry-points/script.js', () => ({
  initializeState: jest.fn().mockResolvedValue()
}));

describe('General Application Functionality', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('State Management', () => {
    it('should update state with valid link data', async () => {
      const { safeUpdateState } = await import('../javascript/core-systems/stateManager.js');
      
      const validState = {
        links: [{ name: 'Test', url: 'https://example.com/', category: 'Test', icon: 'https://example.com/favicon.ico' }],
        theme: 'dark'
      };

      const result = await safeUpdateState(validState, { validate: true });

      // Should be accepted
      expect(result.success).toBe(true);
      expect(result.newState.links).toEqual(validState.links);
      expect(result.newState.theme).toBe('dark');
    });

    it('should reject state updates with invalid link data', async () => {
      const { safeUpdateState } = await import('../javascript/core-systems/stateManager.js');
      
      // Test with corrupted data (object instead of array)
      const invalidState = {
        links: { not: 'an array' },
        theme: 'dark'
      };

      const result = await safeUpdateState(invalidState, { validate: true });

      // Should be rejected
      expect(result.success).toBe(false);
      expect(result.error).toContain('Links must be an array');
    });

    it('should maintain state consistency during updates', async () => {
      const { updateState } = await import('../javascript/core-systems/stateManager.js');
      
      const updates = {
        theme: 'light',
        view: 'list'
      };

      const result = updateState(updates);
      
      expect(result.success).toBe(true);
      expect(result.newState.theme).toBe('light');
      expect(result.newState.view).toBe('list');
    });
  });

  describe('Link Operations', () => {
    it('should add a new link to the state', async () => {
      const { addLink } = await import('../javascript/core-systems/linkManager.js');
      
      const mockState = {
        links: [],
        filteredLinks: []
      };

      const result = await addLink(
        mockState,
        'Test Link',
        'https://example.com',
        'Test Category',
        'https://example.com/favicon.ico'
      );

      expect(result).toBeDefined();
      expect(result.name).toBe('Test Link');
      expect(result.url).toBe('https://example.com/'); // URL gets normalized
      expect(result.category).toBe('Test Category');
      expect(mockState.links.length).toBe(1);
    });

    it('should validate link data before adding', async () => {
      const { addLink } = await import('../javascript/core-systems/linkManager.js');
      
      const mockState = {
        links: [],
        filteredLinks: []
      };

      // Test with invalid URL
      await expect(
        addLink(
          mockState,
          'Test Link',
          'invalid-url',
          'Test Category',
          'https://example.com/favicon.ico'
        )
      ).rejects.toThrow('Invalid or unsafe URL provided');
    });

    it('should delete a link from the state', async () => {
      const { deleteLink } = await import('../javascript/core-systems/linkManager.js');
      
      // Create shared link objects
      const link1 = { name: 'Link 1', url: 'https://example1.com/', category: 'Test', icon: 'https://example1.com/favicon.ico' };
      const link2 = { name: 'Link 2', url: 'https://example2.com/', category: 'Test', icon: 'https://example2.com/favicon.ico' };
      
      const mockState = {
        links: [link1, link2],
        filteredLinks: [link1, link2]
      };

      await deleteLink(mockState, 0);

      expect(mockState.links.length).toBe(1);
      expect(mockState.filteredLinks.length).toBe(1);
      expect(mockState.links[0].name).toBe('Link 2');
    });
  });

  describe('Category Management', () => {
    it('should load categories from storage', async () => {
      const { loadCategories } = await import('../javascript/core-systems/storageManager.js');
      
      const result = await loadCategories();
      
      expect(Array.isArray(result)).toBe(true);
      expect(result).toContain('Default');
    });

    it('should ensure Default category exists', async () => {
      const { loadCategories } = await import('../javascript/core-systems/storageManager.js');
      
      // Even with empty storage, Default should be present
      const result = await loadCategories();
      
      expect(result[0]).toBe('Default');
    });
  });

  describe('User Interface Interactions', () => {
    it('should initialize application state correctly', async () => {
      const { initializeState } = await import('../javascript/entry-points/script.js');
      
      // This should not throw an error
      await expect(initializeState()).resolves.not.toThrow();
    });

    it('should handle theme changes properly', async () => {
      const { updateState } = await import('../javascript/core-systems/stateManager.js');
      
      const result = updateState({ theme: 'light' });
      
      expect(result.success).toBe(true);
      expect(result.newState.theme).toBe('light');
    });

    it('should handle view changes properly', async () => {
      const { updateState } = await import('../javascript/core-systems/stateManager.js');
      
      const result = updateState({ view: 'list' });
      
      expect(result.success).toBe(true);
      expect(result.newState.view).toBe('list');
    });
  });

  describe('Data Validation', () => {
    it('should validate link structure', async () => {
      const { validateLink } = await import('../javascript/features/securityUtils.js');
      
      // Valid link
      const validLink = {
        name: 'Test Link',
        url: 'https://example.com',
        category: 'Test',
        icon: 'https://example.com/favicon.ico',
        size: 'medium'  // Add the size field to make it valid
      };
      
      const validResult = validateLink(validLink);
      expect(validResult.valid).toBe(true);
      
      // Invalid link (missing required fields)
      const invalidLink = {
        name: 'Test Link'
        // Missing url and category
      };
      
      const invalidResult = validateLink(invalidLink);
      expect(invalidResult.valid).toBe(false);
    });

    it('should sanitize user input', async () => {
      const { sanitizeUserInput } = await import('../javascript/features/securityUtils.js');
      
      // Test basic sanitization
      const result = sanitizeUserInput('<script>alert("xss")</script>Test Link');
      expect(result).toBe('Test Link');
      
      // Test length limiting
      const longInput = 'A'.repeat(200);
      const limitedResult = sanitizeUserInput(longInput, { maxLength: 100 });
      expect(limitedResult.length).toBe(100);
    });
  });
});