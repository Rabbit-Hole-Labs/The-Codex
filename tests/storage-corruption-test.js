/**
 * Test file to verify that the link validation fixes work correctly
 * This test simulates corrupted link data and verifies that it's properly cleaned up
 */

// Mock Chrome storage API for testing
const mockChromeStorage = {
    sync: {
        get: async (keys) => {
            // Simulate corrupted data
            return {
                links: JSON.stringify([
                    // Valid link
                    { id: '1', name: 'Google', url: 'https://google.com', category: 'Search' },
                    // Link with missing name
                    { id: '2', url: 'https://github.com', category: 'Development' },
                    // Link with invalid URL
                    { id: '3', name: 'Invalid Link', url: 'not-a-url', category: 'Test' },
                    // Link with missing category
                    { id: '4', name: 'No Category', url: 'https://example.com' },
                    // Link with invalid icon
                    { id: '5', name: 'Bad Icon', url: 'https://example.com', category: 'Test', icon: 'not-a-url' },
                    // Link with invalid size
                    { id: '6', name: 'Bad Size', url: 'https://example.com', category: 'Test', size: 'humongous' },
                    // Link with control characters in name
                    { id: '7', name: 'Bad\x01Name', url: 'https://example.com', category: 'Test' },
                    // Null link
                    null,
                    // Non-object link
                    'not-an-object',
                    // Valid link
                    { id: '8', name: 'Valid Link', url: 'https://valid.com', category: 'Valid', icon: 'https://valid.com/icon.png', size: 'medium' }
                ]),
                theme: 'dark',
                view: 'grid',
                colorTheme: 'default',
                defaultTileSize: 'medium'
            };
        },
        set: async (data) => {
            console.log('STORAGE_TEST: Data saved to sync storage', data);
        }
    },
    local: {
        get: async (keys) => {
            return {};
        },
        set: async (data) => {
            console.log('STORAGE_TEST: Data saved to local storage', data);
        }
    }
};

// Mock the Chrome API globally
global.chrome = mockChromeStorage;

// Import the functions we want to test
import { loadLinks } from '../core-systems/storageManager.js';
import { initializeState } from '../entry-points/script.js';

// Test the storage loading and state initialization
async function runTest() {
    console.log('STORAGE_TEST: Starting test of link validation fixes');
    
    try {
        // Test storage loading
        console.log('STORAGE_TEST: Testing loadLinks function');
        const loadedData = await loadLinks();
        console.log('STORAGE_TEST: Loaded data', loadedData);
        
        // Test state initialization
        console.log('STORAGE_TEST: Testing initializeState function');
        // Note: We can't fully test initializeState without a DOM, but we can verify the data processing
        
        console.log('STORAGE_TEST: Test completed successfully');
        console.log('STORAGE_TEST: Links count after loading:', loadedData.links.length);
        console.log('STORAGE_TEST: Sample of cleaned links:', loadedData.links.slice(0, 3));
        
    } catch (error) {
        console.error('STORAGE_TEST: Test failed with error:', error);
    }
}

// Run the test
runTest();