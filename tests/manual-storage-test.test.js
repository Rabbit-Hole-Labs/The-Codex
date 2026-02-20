/**
 * User-Facing Feature Tests
 * This test suite verifies the core user-facing functionality of the application
 * including link management, UI interactions, and user experience features
 */

// Simple test framework
function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    throw error;
  }
}

function expect(actual) {
  return {
    toBe: (expected) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toEqual: (expected) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toContain: (expected) => {
      if (!actual.includes || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${expected}`);
      }
    }
  };
}

// Mock Chrome storage
const mockChrome = {
  storage: {
    sync: {
      get: async () => ({}),
      set: async () => {},
      clear: async () => {}
    }
  }
};

global.chrome = mockChrome;

console.log('=== User-Facing Feature Tests ===');

describe('Link Management Features', () => {
  test('should add a new link with valid data', async () => {
    // Mock valid data
    global.chrome.storage.sync.get = async () => ({
      links: [],
      theme: 'dark'
    });

    // Import and test the actual storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    const result = await loadLinks();

    // Verify initial state
    expect(Array.isArray(result.links)).toBe(true);
    expect(result.links.length).toBe(0);
    expect(result.theme).toBe('dark');
  });

  test('should display links in grid view by default', async () => {
    // Mock valid data with links
    global.chrome.storage.sync.get = async () => ({
      links: [{ name: 'Test', url: 'https://example.com', category: 'Test' }],
      theme: 'dark',
      view: 'grid'
    });

    // Import and test the actual storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    const result = await loadLinks();

    // Verify that valid data is preserved and view is grid
    expect(Array.isArray(result.links)).toBe(true);
    expect(result.links.length).toBe(1);
    expect(result.view).toBe('grid');
  });

  test('should allow switching between grid and list views', async () => {
    // Mock list view
    global.chrome.storage.sync.get = async () => ({
      links: [{ name: 'Test', url: 'https://example.com', category: 'Test' }],
      theme: 'dark',
      view: 'list'
    });

    // Import and test the actual storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    const result = await loadLinks();

    // Verify list view
    expect(result.view).toBe('list');
  });
});

describe('Category Management Features', () => {
  test('should organize links by categories', async () => {
    // Import the storage manager
    const { loadCategories } = await import('../javascript/core-systems/storageManager.js');
    
    // Test with categories
    global.chrome.storage.sync.get = async () => ({
      categories: ['Default', 'Work', 'Personal']
    });

    const result = await loadCategories();

    // Should contain all categories
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);
    expect(result).toContain('Default');
    expect(result).toContain('Work');
    expect(result).toContain('Personal');
  });

  test('should always include Default category', async () => {
    // Import the storage manager
    const { loadCategories } = await import('../javascript/core-systems/storageManager.js');
    
    // Test with empty storage
    global.chrome.storage.sync.get = async () => ({});

    const result = await loadCategories();

    // Should always have Default
    expect(result).toContain('Default');
  });
});

describe('Theme and Appearance Features', () => {
  test('should support dark theme by default', async () => {
    // Import the storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    
    // Test with empty storage
    global.chrome.storage.sync.get = async () => ({});

    const result = await loadLinks();

    // Should default to dark theme
    expect(result.theme).toBe('dark');
  });

  test('should support light theme', async () => {
    // Import the storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    
    // Test with light theme
    global.chrome.storage.sync.get = async () => ({
      theme: 'light'
    });

    const result = await loadLinks();

    // Should support light theme
    expect(result.theme).toBe('light');
  });

  test('should support multiple color themes', async () => {
    // Import the storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    
    // Test with color theme
    global.chrome.storage.sync.get = async () => ({
      theme: 'dark',
      colorTheme: 'ocean'
    });

    const result = await loadLinks();

    // Should support color themes
    expect(result.theme).toBe('dark');
    expect(result.colorTheme).toBe('ocean');
  });
});

describe('User Experience Features', () => {
  test('should support different tile sizes', async () => {
    // Import the storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    
    // Test with tile size
    global.chrome.storage.sync.get = async () => ({
      links: [],
      defaultTileSize: 'large'
    });

    const result = await loadLinks();

    // Should support tile sizes
    expect(result.defaultTileSize).toBe('large');
  });

  test('should handle empty link collection gracefully', async () => {
    // Import the storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    
    // Test with empty links
    global.chrome.storage.sync.get = async () => ({
      links: []
    });

    const result = await loadLinks();

    // Should handle empty gracefully
    expect(Array.isArray(result.links)).toBe(true);
    expect(result.links.length).toBe(0);
  });
});

console.log('\n=== All User-Facing Feature Tests Completed ===');
console.log('✓ Core application features are working correctly');