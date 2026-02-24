/**
 * Simple Verification of Chrome Storage Corruption Fixes
 */

console.log('=== Verifying Chrome Storage Corruption Fixes ===');

// Mock Chrome storage
global.chrome = {
  storage: {
    sync: {
      get: async () => ({}),
      set: async () => {},
      clear: async () => {}
    }
  }
};

async function runTests() {
  try {
    console.log('\n--- Test 1: Storage Manager Object Corruption Handling ---');
    
    // Mock corrupted data
    global.chrome.storage.sync.get = async () => ({
      links: { corrupted: 'this_should_be_an_array' },
      theme: 'dark'
    });

    // Import and test the actual storage manager
    const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
    const result = await loadLinks();

    console.log('Result:', result);
    console.log('Links is array:', Array.isArray(result.links));
    console.log('Theme:', result.theme);

    if (Array.isArray(result.links)) {
      console.log('✓ Storage manager correctly handles object corruption');
    } else {
      console.log('✗ Storage manager failed to handle object corruption');
      return false;
    }

    console.log('\n--- Test 2: State Manager Array Validation ---');
    
    // Import the state manager
    const { safeUpdateState } = await import('../javascript/core-systems/stateManager.js');

    // Test with corrupted data (object instead of array)
    const corruptedState = {
      links: { not: 'an array' },
      theme: 'dark'
    };

    const result2 = await safeUpdateState(corruptedState, { validate: true });
    console.log('Validation result:', result2);

    if (!result2.success) {
      console.log('✓ State manager correctly rejects corrupted data');
    } else {
      console.log('✗ State manager failed to reject corrupted data');
      return false;
    }

    console.log('\n--- Test 3: Valid Data Handling ---');
    
    // Test with valid data
    const validState = {
      links: [{ name: 'Test', url: 'https://example.com', category: 'Test', icon: '', size: 'medium' }],
      theme: 'dark'
    };

    const result3 = await safeUpdateState(validState, { validate: true });
    console.log('Valid data result:', result3);

    if (result3.success) {
      console.log('✓ State manager correctly accepts valid data');
    } else {
      console.log('✗ State manager incorrectly rejected valid data');
      return false;
    }

    console.log('\n=== ALL TESTS PASSED ===');
    console.log('✓ Chrome storage corruption fixes are working correctly');
    return true;

  } catch (error) {
    console.error('Test failed with error:', error);
    return false;
  }
}

runTests().then(success => {
  if (success) {
    console.log('\n🎉 All critical bug fixes are working correctly!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. The fixes may not be working.');
    process.exit(1);
  }
});