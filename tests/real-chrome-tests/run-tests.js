// Simple test runner for critical bug tests
import { CriticalBugTester } from './critical-bug-tests.js';

// Mock window object
global.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  location: {
    origin: 'http://localhost'
  },
  isSecureContext: true
};

// Create a mock element that can handle querySelector calls
const createMockElement = (id = '', className = '') => ({
  id: id,
  className: className,
  innerHTML: '',
  style: {},
  setAttribute: function(name, value) { this[name] = value; },
  getAttribute: function(name) { return this[name]; },
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: function(selector) {
    // For specific selectors, return mock elements
    if (selector === '#sync-status') {
      return createMockElement('sync-status');
    }
    if (selector === '#last-sync-time') {
      return createMockElement('last-sync-time');
    }
    if (selector === '#sync-now-btn') {
      return createMockElement('sync-now-btn');
    }
    if (selector === '#sync-menu-btn') {
      return createMockElement('sync-menu-btn');
    }
    if (selector === '#sync-menu') {
      return createMockElement('sync-menu');
    }
    if (selector === '.sync-details') {
      return createMockElement('', 'sync-details');
    }
    if (selector === '.sync-icon') {
      return createMockElement('', 'sync-icon');
    }
    if (selector === '.sync-text') {
      return createMockElement('', 'sync-text');
    }
    return null;
  },
  querySelectorAll: () => [],
  appendChild: () => {},
  removeChild: () => {},
  replaceChild: () => {},
  textContent: '',
  value: '',
  contains: () => true
});

// Mock document object
global.document = {
  createElement: (tag) => createMockElement('', tag),
  getElementById: (id) => {
    // For the sync status container, return a proper mock element
    if (id === 'sync-status-container') {
      return createMockElement('sync-status-container');
    }
    return createMockElement(id);
  },
  querySelector: (selector) => createMockElement('', selector),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {
    className: '',
    setAttribute: () => {},
    getAttribute: () => {},
    appendChild: () => {}
  },
  head: {
    insertAdjacentHTML: () => {}
  },
  readyState: 'complete'
};

// Mock navigator
Object.defineProperty(global, 'navigator', {
  value: {
    onLine: true
  },
  writable: true,
  configurable: true
});

// Mock Chrome storage
global.chrome = {
  storage: {
    sync: {
      get: async () => ({}),
      set: async () => {},
      clear: async () => {}
    },
    local: {
      get: async () => ({}),
      set: async () => {},
      clear: async () => {}
    }
  }
};

async function runCriticalBugTests() {
  console.log('=== Running Critical Bug Tests ===');
  
  const tester = new CriticalBugTester();
  const result = await tester.runAllCriticalTests();
  
  if (result) {
    console.log('\n🎉 All critical bug tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some critical bug tests failed.');
    process.exit(1);
  }
}

runCriticalBugTests().catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});