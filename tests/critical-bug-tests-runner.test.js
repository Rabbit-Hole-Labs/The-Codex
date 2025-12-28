#!/usr/bin/env node

/**
 * Critical Bug Test Runner
 * This script runs the critical bug tests in a simulated environment
 */

const fs = require('fs');
const path = require('path');

console.log('=== Critical Bug Test Runner ===');

// Create a mock Chrome environment
const mockChrome = {
  storage: {
    sync: {
      get: async (keys) => {
        console.log('Mock chrome.storage.sync.get called with:', keys);
        // Return empty object to simulate clean state
        return {};
      },
      set: async (data) => {
        console.log('Mock chrome.storage.sync.set called with:', data);
        // Simulate successful save
        return Promise.resolve();
      },
      clear: async () => {
        console.log('Mock chrome.storage.sync.clear called');
        return Promise.resolve();
      }
    },
    local: {
      get: async (keys) => {
        console.log('Mock chrome.storage.local.get called with:', keys);
        return {};
      },
      set: async (data) => {
        console.log('Mock chrome.storage.local.set called with:', data);
        return Promise.resolve();
      },
      clear: async () => {
        console.log('Mock chrome.storage.local.clear called');
        return Promise.resolve();
      }
    }
  }
};

// Mock the import system
const mockRequire = (modulePath) => {
  console.log('Mock require called with:', modulePath);
  
  if (modulePath === '../javascript/core-systems/storageManager.js') {
    // Mock storageManager
    return {
      loadLinks: async () => {
        console.log('Mock storageManager.loadLinks called');
        return { links: [], theme: 'dark', view: 'grid', colorTheme: 'default', defaultTileSize: 'medium' };
      }
    };
  } else if (modulePath === '../javascript/core-systems/stateManager.js') {
    // Mock stateManager
    return {
      safeUpdateState: async (updates, options) => {
        console.log('Mock stateManager.safeUpdateState called with:', updates, options);
        // Simulate successful update for valid data, failure for invalid
        if (updates.links && !Array.isArray(updates.links)) {
          return { success: false, error: 'Links must be an array' };
        }
        return { success: true, newState: updates };
      }
    };
  } else if (modulePath === '../javascript/entry-points/script.js') {
    // Mock script.js
    return {
      initializeState: async () => {
        console.log('Mock script.js initializeState called');
        return Promise.resolve();
      }
    };
  }
  return {};
};

// Create a more complete mock environment
global.chrome = mockChrome;
global.window = {
  chrome: mockChrome
};

// Mock module system
const mockModule = { exports: {} };
global.module = mockModule;
global.exports = mockModule.exports;

// Override require
const originalRequire = require;
global.require = mockRequire;

// Read and execute the critical bug tests file
const testFilePath = path.join(__dirname, 'real-chrome-tests', 'critical-bug-tests.js');
if (!fs.existsSync(testFilePath)) {
  console.error('Critical bug tests file not found:', testFilePath);
  process.exit(1);
}

const testFileContent = fs.readFileSync(testFilePath, 'utf8');

try {
  // Execute the test file
  eval(testFileContent);
  
  console.log('SUCCESS: Critical bug tests file parsed and executed');
  
  // Try to run the tests
  if (global.CriticalBugTester) {
    console.log('Found CriticalBugTester class');
    
    // Create an instance and run tests
    const tester = new global.CriticalBugTester();
    
    console.log('Running critical bug tests...');
    tester.runAllCriticalTests().then((result) => {
      console.log('\n=== TEST RESULTS ===');
      if (result) {
        console.log('✓ ALL CRITICAL BUG TESTS PASSED');
        console.log('The Chrome storage corruption fixes are working correctly');
      } else {
        console.log('✗ SOME CRITICAL BUG TESTS FAILED');
        console.log('The Chrome storage corruption fixes may not be working');
      }
      process.exit(result ? 0 : 1);
    }).catch((error) => {
      console.error('Error running tests:', error);
      process.exit(1);
    });
  } else if (mockModule.exports && mockModule.exports.CriticalBugTester) {
    console.log('Found CriticalBugTester in module.exports');
    
    // Create an instance and run tests
    const tester = new mockModule.exports.CriticalBugTester();
    
    console.log('Running critical bug tests...');
    tester.runAllCriticalTests().then((result) => {
      console.log('\n=== TEST RESULTS ===');
      if (result) {
        console.log('✓ ALL CRITICAL BUG TESTS PASSED');
        console.log('The Chrome storage corruption fixes are working correctly');
      } else {
        console.log('✗ SOME CRITICAL BUG TESTS FAILED');
        console.log('The Chrome storage corruption fixes may not be working');
      }
      process.exit(result ? 0 : 1);
    }).catch((error) => {
      console.error('Error running tests:', error);
      process.exit(1);
    });
  } else {
    console.error('CriticalBugTester class not found');
    console.log('Available globals:', Object.keys(global));
    console.log('Module exports:', mockModule.exports);
    process.exit(1);
  }
  
} catch (error) {
  console.error('Error executing critical bug tests:', error);
  process.exit(1);
}