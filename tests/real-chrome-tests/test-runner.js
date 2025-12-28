/**
 * Real Chrome Extension Test Runner
 * Actually tests the extension in a real Chrome environment
 * Can FAIL if the fixes don't work
 */

class RealChromeExtensionTester {
    constructor() {
        this.testResults = [];
        this.hasRealChrome = !!(window.chrome && window.chrome.storage);
        this.resultsElement = document.getElementById('test-results');
        this.finalResultsElement = document.getElementById('final-results');
    }

    log(message, type = 'info') {
        const div = document.createElement('div');
        div.className = `test-result ${type}`;
        div.textContent = message;
        this.resultsElement.appendChild(div);
        console.log(`[${type.toUpperCase()}] ${message}`);
    }

    async runAllTests() {
        this.log('=== REAL CHROME EXTENSION TESTS STARTING ===', 'info');
        this.log('These tests can actually FAIL if the fixes don\'t work', 'warning');

        // Enable test buttons
        document.getElementById('test-initialization').disabled = false;
        document.getElementById('test-storage-manager').disabled = false;
        document.getElementById('test-state-manager').disabled = false;

        try {
            // Test 1: Environment Check
            const envTest = await this.testEnvironment();
            if (!envTest) return this.reportFailure("Environment test failed");

            // Test 2: Storage Operations
            const storageTest = await this.testStorageOperations();
            if (!storageTest) return this.reportFailure("Storage operations test failed");

            // Test 3: Corrupted Data Handling
            const corruptionTest = await this.testCorruptionHandling();
            if (!corruptionTest) return this.reportFailure("Corruption handling test failed");

            return this.reportSuccess();

        } catch (error) {
            this.log(`CRITICAL TEST FAILURE: ${error.message}`, 'fail');
            this.log(`Stack trace: ${error.stack}`, 'fail');
            return this.reportFailure(`Critical test failure: ${error.message}`);
        }
    }

    async testEnvironment() {
        this.log('\n--- Test 1: Chrome Environment ---', 'info');

        if (!this.hasRealChrome) {
            this.log('FAIL: Not in real Chrome extension environment', 'fail');
            this.log(`chrome object: ${typeof window.chrome}`, 'fail');
            this.log(`chrome.storage: ${typeof window.chrome?.storage}`, 'fail');
            return false;
        }

        // Update environment info
        document.getElementById('chrome-version').textContent = navigator.userAgent;
        document.getElementById('extension-context').textContent = 'Available';
        document.getElementById('storage-api').textContent = 'Available';

        this.log('SUCCESS: Real Chrome extension environment detected', 'success');
        this.log(`Chrome version: ${navigator.userAgent}`, 'success');
        return true;
    }

    async testStorageOperations() {
        this.log('\n--- Test 2: Chrome Storage Operations ---', 'info');

        try {
            // Test basic storage operations
            const testKey = 'test_corruption_' + Date.now();
            const testValue = { test: 'data', timestamp: Date.now(), links: [] };

            // Write to storage
            await chrome.storage.sync.set({ [testKey]: testValue });
            this.log('SUCCESS: Wrote to Chrome storage', 'success');

            // Read from storage
            const result = await chrome.storage.sync.get([testKey]);
            this.log('SUCCESS: Read from Chrome storage', 'success');

            // Verify data
            if (JSON.stringify(result[testKey]) !== JSON.stringify(testValue)) {
                this.log('FAIL: Storage data mismatch', 'fail');
                this.log(`Expected: ${JSON.stringify(testValue)}`, 'fail');
                this.log(`Got: ${JSON.stringify(result[testKey])}`, 'fail');
                return false;
            }

            // Clean up
            await chrome.storage.sync.remove(testKey);
            this.log('SUCCESS: Chrome storage basic operations work', 'success');
            return true;

        } catch (error) {
            this.log(`FAIL: Chrome storage operations failed: ${error.message}`, 'fail');
            return false;
        }
    }

    async testCorruptionHandling() {
        this.log('\n--- Test 3: Storage Corruption Handling ---', 'info');
        this.log('This is the critical test - if the fix doesn\'t work, this will FAIL', 'warning');

        try {
            // Step 1: Inject real corrupted data into Chrome storage
            this.log('Injecting real corrupted storage data...', 'info');
            const corruptedData = {
                links: { corrupted: 'real_chrome_object' }, // This is the real problem
                theme: 'dark',
                view: 'grid',
                colorTheme: 'default',
                defaultTileSize: 'medium'
            };

            await chrome.storage.sync.set(corruptedData);
            this.log('SUCCESS: Injected corrupted data into real Chrome storage', 'success');
            this.log(`Corrupted data: ${JSON.stringify(corruptedData)}`, 'info');
            this.log(`Corrupted links type: ${typeof corruptedData.links}`, 'info');
            this.log(`Corrupted links is array: ${Array.isArray(corruptedData.links)}`, 'info');

            // Step 2: Test storage manager with real corruption
            this.log('Testing storage manager with real corruption...', 'info');

            // Import and test the actual storage manager
            const { loadLinks } = await import('../../javascript/core-systems/storageManager.js');
            const result = await loadLinks();

            this.log(`Storage manager result with corruption: ${JSON.stringify(result)}`, 'info');
            this.log(`Result links type: ${typeof result.links}`, 'info');
            this.log(`Result links is array: ${Array.isArray(result.links)}`, 'info');

            // This is the REAL test - if links is not an array, the fix FAILED
            if (!Array.isArray(result.links)) {
                this.log('FAIL: Storage manager returned non-array with real corruption', 'fail');
                this.log('This means the Chrome storage corruption fix is NOT working', 'fail');
                this.log('The extension will fail in real conditions', 'fail');
                return false;
            }

            this.log('SUCCESS: Storage manager handled real corruption correctly', 'success');
            this.log('The fix is working in real Chrome conditions', 'success');

            // Clean up
            await chrome.storage.sync.clear();
            this.log('Cleaned up test data', 'success');

            return true;

        } catch (error) {
            this.log(`FAIL: Real corruption handling test failed: ${error.message}`, 'fail');
            this.log(`Stack trace: ${error.stack}`, 'fail');
            this.log('The fix may not be working in real conditions', 'fail');
            return false;
        }
    }

    async testExtensionInitialization() {
        this.log('\n--- Test 4: Extension Initialization ---', 'info');
        this.log('Testing actual extension initialization with corruption...', 'info');

        try {
            // First inject corruption
            const corruptedData = {
                links: { corrupted: 'real_chrome_object' },
                theme: 'dark',
                view: 'grid',
                colorTheme: 'default',
                defaultTileSize: 'medium'
            };

            await chrome.storage.sync.set(corruptedData);
            this.log('Injected corrupted data for initialization test', 'info');

            // Import and test actual initialization
            const { initializeState } = await import('../../javascript/entry-points/script.js');

            // This should not throw an error if the fix works
            await initializeState();

            this.log('SUCCESS: Extension initialization completed without error', 'success');

            // Clean up
            await chrome.storage.sync.clear();
            return true;

        } catch (error) {
            this.log(`FAIL: Extension initialization failed: ${error.message}`, 'fail');
            this.log(`Stack trace: ${error.stack}`, 'fail');
            return false;
        }
    }

    reportSuccess() {
        this.log('\n=== FINAL TEST RESULTS ===', 'info');
        this.log(' ALL REAL CHROME EXTENSION TESTS PASSED', 'success');
        this.log('The Chrome storage corruption fix is working in real conditions', 'success');
        this.log('The extension can now handle real Chrome storage corruption', 'success');

        // Update the page to show success
        if (this.finalResultsElement) {
            this.finalResultsElement.innerHTML = '<div class="status passed"> ALL TESTS PASSED - Fix is working!</div>';
        }

        return true;
    }

    reportFailure(reason) {
        this.log('\n=== FINAL TEST RESULTS ===', 'info');
        this.log(' REAL CHROME EXTENSION TESTS FAILED', 'fail');
        this.log(`Reason: ${reason}`, 'fail');
        this.log('The fix is NOT working in real conditions', 'fail');
        this.log('The extension will still fail with corrupted storage', 'fail');

        // Update the page to show failure
        if (this.finalResultsElement) {
            this.finalResultsElement.innerHTML = '<div class="status failed"> TESTS FAILED - Fix is not working!</div>';
            this.finalResultsElement.innerHTML += `<div class="test-result fail">${reason}</div>`;
        }

        return false;
    }
}

// Global test instance
let tester = null;

// Initialize when page loads
window.addEventListener('load', async () => {
    console.log('Real Chrome Extension Test Runner: Initializing...');

    tester = new RealChromeExtensionTester();

    // Auto-detect environment
    if (tester.hasRealChrome) {
        tester.log('Chrome extension environment detected', 'success');
        document.getElementById('inject-corruption').disabled = false;
    } else {
        tester.log('ERROR: Not in Chrome extension environment', 'fail');
        tester.log('This test must be run as a Chrome extension', 'fail');
    }
});

// Test functions for buttons
async function injectCorruption() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        const corruptedData = {
            links: { corrupted: 'real_chrome_object' },
            theme: 'dark',
            view: 'grid',
            colorTheme: 'default',
            defaultTileSize: 'medium'
        };

        await chrome.storage.sync.set(corruptedData);
        tester.log('SUCCESS: Injected corrupted data into Chrome storage', 'success');
        tester.log(`Data: ${JSON.stringify(corruptedData)}`, 'info');

        // Enable test buttons
        document.getElementById('test-initialization').disabled = false;
        document.getElementById('test-storage-manager').disabled = false;
        document.getElementById('test-state-manager').disabled = false;

    } catch (error) {
        tester.log(`FAIL: Could not inject corruption: ${error.message}`, 'fail');
    }
}

async function testInitialization() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        tester.log('Testing extension initialization...', 'info');
        const { initializeState } = await import('../../javascript/entry-points/script.js');
        await initializeState();
        tester.log('SUCCESS: Extension initialization completed', 'success');
    } catch (error) {
        tester.log(`FAIL: Extension initialization failed: ${error.message}`, 'fail');
    }
}

async function testStorageManager() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        tester.log('Testing storage manager...', 'info');
        const { loadLinks } = await import('../../javascript/core-systems/storageManager.js');
        const result = await loadLinks();
        tester.log(`SUCCESS: Storage manager returned: ${JSON.stringify(result)}`, 'success');
        tester.log(`Links is array: ${Array.isArray(result.links)}`, 'info');
    } catch (error) {
        tester.log(`FAIL: Storage manager test failed: ${error.message}`, 'fail');
    }
}

async function testStateManager() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        tester.log('Testing state manager...', 'info');
        const { safeUpdateState } = await import('../../javascript/core-systems/stateManager.js');

        // Test with corrupted data
        const corruptedUpdate = {
            links: { corrupted: 'real_object' },
            theme: 'dark'
        };

        const result = await safeUpdateState(corruptedUpdate, { validate: true });
        tester.log(`State manager result with corruption: ${JSON.stringify(result)}`, 'info');

        if (!result.success) {
            tester.log('SUCCESS: State manager correctly rejected corrupted data', 'success');
        } else {
            tester.log('FAIL: State manager should have rejected corrupted data', 'fail');
        }
    } catch (error) {
        tester.log(`FAIL: State manager test failed: ${error.message}`, 'fail');
    }
}

async function clearStorage() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();
        tester.log('SUCCESS: Storage cleared', 'success');
    } catch (error) {
        tester.log(`FAIL: Could not clear storage: ${error.message}`, 'fail');
    }
}

async function viewStorage() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        const syncData = await chrome.storage.sync.get(null);
        const localData = await chrome.storage.local.get(null);

        tester.log('Current Chrome Storage Contents:', 'info');
        tester.log(`Sync storage: ${JSON.stringify(syncData, null, 2)}`, 'info');
        tester.log(`Local storage: ${JSON.stringify(localData, null, 2)}`, 'info');
    } catch (error) {
        tester.log(`FAIL: Could not view storage: ${error.message}`, 'fail');
    }
}

async function runCriticalBugTests() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        tester.log('Running critical bug test suite...', 'info');
        const { CriticalBugTester } = await import('./critical-bug-tests.js');
        const bugTester = new CriticalBugTester();
        const passed = await bugTester.runAllCriticalTests();

        if (passed) {
            tester.log(' ALL CRITICAL BUG TESTS PASSED', 'success');
        } else {
            tester.log(' SOME CRITICAL BUG TESTS FAILED', 'fail');
        }
    } catch (error) {
        tester.log(`FAIL: Critical bug test suite failed: ${error.message}`, 'fail');
    }
}

async function runIntegrationTests() {
    if (!tester) {
        console.error('Tester not initialized');
        return;
    }

    try {
        tester.log('Running integration tests...', 'info');
        const { IntegrationTester } = await import('./integration-test.js');
        const integrationTester = new IntegrationTester();
        const passed = await integrationTester.runCompleteFlowTest();

        if (passed) {
            tester.log(' ALL INTEGRATION TESTS PASSED', 'success');
        } else {
            tester.log(' SOME INTEGRATION TESTS FAILED', 'fail');
        }
    } catch (error) {
        tester.log(`FAIL: Integration test suite failed: ${error.message}`, 'fail');
    }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'runAllTests' && tester) {
        tester.runAllTests();
    }
});
