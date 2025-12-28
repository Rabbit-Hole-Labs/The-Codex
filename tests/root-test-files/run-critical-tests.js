// Simple test runner for critical bug tests
import { CriticalBugTester } from './tests/real-chrome-tests/critical-bug-tests.js';

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