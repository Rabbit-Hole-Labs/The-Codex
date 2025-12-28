#!/usr/bin/env node

/**
 * Simple Critical Bug Test Runner
 * This script runs the critical bug tests in a simplified environment
 */

console.log('=== Simple Critical Bug Test Runner ===');

// Create a mock Chrome environment
global.chrome = {
  storage: {
    sync: {
      get: async (keys) => {
        console.log('chrome.storage.sync.get called with:', keys);
        return {};
      },
      set: async (data) => {
        console.log('chrome.storage.sync.set called with:', Object.keys(data));
        return Promise.resolve();
      },
      clear: async () => {
        console.log('chrome.storage.sync.clear called');
        return Promise.resolve();
      }
    },
    local: {
      get: async (keys) => {
        console.log('chrome.storage.local.get called with:', keys);
        return {};
      },
      set: async (data) => {
        console.log('chrome.storage.local.set called with:', Object.keys(data));
        return Promise.resolve();
      },
      clear: async () => {
        console.log('chrome.storage.local.clear called');
        return Promise.resolve();
      }
    }
  }
};

// Import and run the critical bug tests
import('./real-chrome-tests/critical-bug-tests.js').then(async (module) => {
  const { CriticalBugTester } = module;
  
  console.log('SUCCESS: Critical bug tests file parsed and executed');
  
  // Check if CriticalBugTester is available
  if (typeof CriticalBugTester !== 'undefined') {
    console.log('Found CriticalBugTester class');
    
    // Create an instance and run tests
    const tester = new CriticalBugTester();
    
    console.log('\n--- Running Critical Bug Tests ---');
    const result = await tester.runAllCriticalTests();
    
    console.log('\n=== FINAL RESULTS ===');
    if (result) {
      console.log('✓ ALL CRITICAL BUG TESTS PASSED');
      console.log('The Chrome storage corruption fixes are working correctly');
    } else {
      console.log('✗ SOME CRITICAL BUG TESTS FAILED');
      console.log('The Chrome storage corruption fixes may not be working');
    }
    process.exit(result ? 0 : 1);
  } else {
    console.error('CriticalBugTester class not found');
    process.exit(1);
  }
}).catch((error) => {
  console.error('Error executing critical bug tests:', error);
  process.exit(1);
});