/**
 * Link Management Functionality Tests
 * This test suite verifies the link management features of the application
 * including adding, editing, deleting, and organizing links
 */

import { jest } from '@jest/globals';

// Mock the storageManager module before importing linkManager
const mockSaveLinks = jest.fn().mockResolvedValue(true);

jest.unstable_mockModule('../javascript/core-systems/storageManager.js', () => {
  return {
    loadLinks: jest.fn(),
    saveLinks: mockSaveLinks,
    saveSettings: jest.fn().mockResolvedValue(true),
    loadSettings: jest.fn(),
    clearStorage: jest.fn().mockResolvedValue(true),
    loadCategories: jest.fn(),
    saveCategories: jest.fn().mockResolvedValue(['Default']),
    loadState: jest.fn(),
    exportLinks: jest.fn().mockResolvedValue(true),
    importLinks: jest.fn().mockResolvedValue(true),
    importBookmarks: jest.fn().mockResolvedValue(true)
  };
});

describe('Link Management Functionality', () => {
  // Mock the Chrome storage API
  const mockChromeStorage = {
    sync: {
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

  describe('Adding Links', () => {
    test('should successfully add a valid link', async () => {
      // Mock successful save
      mockChromeStorage.sync.set.mockResolvedValue();
      
      // Mock empty initial state
      mockChromeStorage.sync.get.mockResolvedValue({
        links: []
      });

      // Import the link manager and storage manager
      const { addLink } = await import('../javascript/core-systems/linkManager.js');
      const { loadLinks } = await import('../javascript/core-systems/storageManager.js');

      // Mock loadLinks to return empty array
      loadLinks.mockResolvedValue({ links: [] });

      // Create a mock state with both links and filteredLinks
      const state = { links: [], filteredLinks: [] };
      
      // Add a valid link
      const result = await addLink(
        state,
        'Test Link',
        'https://example.com',
        'Test Category',
        'https://example.com/favicon.ico'
      );

      // Verify the link was added correctly
      expect(result).toBeDefined();
      expect(result.name).toBe('Test Link');
      expect(result.url).toBe('https://example.com/'); // URL gets normalized
      expect(result.category).toBe('Test Category');
      expect(mockSaveLinks).toHaveBeenCalled();
      expect(state.links.length).toBe(1);
      expect(state.filteredLinks.length).toBe(1);
    });

    test('should reject links with invalid URLs', async () => {
      // Import the link manager
      const { addLink } = await import('../javascript/core-systems/linkManager.js');

      // Create a mock state with both links and filteredLinks
      const state = {
        links: [],
        filteredLinks: []
      };
      
      // Try to add a link with an invalid URL
      await expect(
        addLink(
          state,
          'Invalid Link',
          'not-a-valid-url',
          'Test Category',
          'https://example.com/favicon.ico'
        )
      ).rejects.toThrow('Invalid or unsafe URL provided');
    });

    test('should reject links with missing required fields', async () => {
      // Import the link manager
      const { addLink } = await import('../javascript/core-systems/linkManager.js');

      // Create a mock state with both links and filteredLinks
      const state = {
        links: [],
        filteredLinks: []
      };
      
      // Try to add a link with missing name
      await expect(
        addLink(
          state,
          '', // Empty name
          'https://example.com',
          'Test Category',
          'https://example.com/favicon.ico'
        )
      ).rejects.toThrow('Link name is required and cannot be empty');
    });
  });

  describe('Deleting Links', () => {
    test('should successfully delete a link by index', async () => {
      // Import the link manager and storage manager
      const { deleteLink } = await import('../javascript/core-systems/linkManager.js');

      // Create shared link objects
      const link1 = { name: 'Link 1', url: 'https://example1.com/', category: 'Test', icon: 'https://example1.com/favicon.ico' };
      const link2 = { name: 'Link 2', url: 'https://example2.com/', category: 'Test', icon: 'https://example2.com/favicon.ico' };

      // Create a mock state with both links and filteredLinks
      const state = {
        links: [link1, link2],
        filteredLinks: [link1, link2]
      };
      
      // Delete the first link
      await deleteLink(state, 0);

      // Verify the link was deleted
      expect(state.links.length).toBe(1);
      expect(state.filteredLinks.length).toBe(1);
      expect(state.links[0].name).toBe('Link 2');
      expect(mockSaveLinks).toHaveBeenCalled();
    });
  });

  describe('Bulk Operations', () => {
    test('should successfully delete multiple links', async () => {
      // Import the link manager
      const { bulkDeleteLinks } = await import('../javascript/core-systems/linkManager.js');

      // Create shared link objects
      const link1 = { name: 'Link 1', url: 'https://example1.com/', category: 'Test', icon: 'https://example1.com/favicon.ico' };
      const link2 = { name: 'Link 2', url: 'https://example2.com/', category: 'Test', icon: 'https://example2.com/favicon.ico' };
      const link3 = { name: 'Link 3', url: 'https://example3.com/', category: 'Test', icon: 'https://example3.com/favicon.ico' };

      // Create a mock state with multiple links and filteredLinks
      const state = {
        links: [link1, link2, link3],
        filteredLinks: [link1, link2, link3]
      };
      
      // Delete indices 2 and 0 (in that order to avoid index shifting issues)
      await bulkDeleteLinks(state, [2, 0]);

      // Verify the links were deleted (should have Link 2 remaining)
      expect(state.links.length).toBe(1);
      expect(state.filteredLinks.length).toBe(1);
      expect(state.links[0].name).toBe('Link 2');
      expect(mockSaveLinks).toHaveBeenCalled();
    });

    test('should successfully move multiple links to a new category', async () => {
      // Import the link manager
      const { bulkMoveLinks } = await import('../javascript/core-systems/linkManager.js');

      // Create shared link objects
      const link1 = { name: 'Link 1', url: 'https://example1.com/', category: 'Old Category', icon: 'https://example1.com/favicon.ico' };
      const link2 = { name: 'Link 2', url: 'https://example2.com/', category: 'Old Category', icon: 'https://example2.com/favicon.ico' };

      // Create a mock state with multiple links and filteredLinks
      const state = {
        links: [link1, link2],
        filteredLinks: [link1, link2]
      };
      
      // Move both links to a new category (indices 0 and 1)
      await bulkMoveLinks(state, [0, 1], 'New Category');

      // Verify the links were moved
      expect(state.links[0].category).toBe('New Category');
      expect(state.links[1].category).toBe('New Category');
      expect(state.filteredLinks[0].category).toBe('New Category');
      expect(state.filteredLinks[1].category).toBe('New Category');
      expect(mockSaveLinks).toHaveBeenCalled();
    });
  });

  describe('Editing Links', () => {
    test('should successfully edit an existing link', async () => {
      // Import the link manager
      const { editLink } = await import('../javascript/core-systems/linkManager.js');

      // Create shared link objects
      const link1 = { name: 'Old Name', url: 'https://old.com/', category: 'Old Category', icon: 'https://old.com/favicon.ico' };

      // Create a mock state with a link and filteredLinks
      const state = {
        links: [link1],
        filteredLinks: [link1]
      };
      
      // Edit the link
      await editLink(
        state,
        0,
        'New Name',
        'https://new.com',
        'New Category',
        'https://new.com/favicon.ico'
      );

      // Verify the link was edited
      expect(state.links[0].name).toBe('New Name');
      expect(state.links[0].url).toBe('https://new.com/'); // URL gets normalized
      expect(state.links[0].category).toBe('New Category');
      expect(state.filteredLinks[0].name).toBe('New Name');
      expect(state.filteredLinks[0].url).toBe('https://new.com/'); // URL gets normalized
      expect(state.filteredLinks[0].category).toBe('New Category');
      expect(mockSaveLinks).toHaveBeenCalled();
    });
  });
});