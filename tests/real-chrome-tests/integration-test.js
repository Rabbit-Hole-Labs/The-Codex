/**
 * Integration Test Suite for The Codex Chrome Extension
 * Tests the actual integration between components in a real environment
 */

// Test the complete flow from storage corruption to UI rendering
class IntegrationTester {
    constructor() {
        this.results = [];
    }

    async runCompleteFlowTest() {
        console.log('=== COMPLETE FLOW INTEGRATION TEST ===');

        try {
            // Step 1: Inject real corruption
            console.log('Step 1: Injecting real storage corruption...');
            const corruptedData = {
                links: { corrupted: 'real_chrome_object' },
                theme: 'dark',
                view: 'grid',
                colorTheme: 'default',
                defaultTileSize: 'medium'
            };

            await chrome.storage.sync.set(corruptedData);
            console.log('SUCCESS: Corrupted data injected');

            // Step 2: Test storage manager
            console.log('Step 2: Testing storage manager with corruption...');
            const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
            const storageResult = await loadLinks();

            if (!Array.isArray(storageResult.links)) {
                throw new Error('Storage manager failed to handle corruption');
            }
            console.log('SUCCESS: Storage manager handled corruption correctly');

            // Step 3: Test state manager
            console.log('Step 3: Testing state manager with corruption...');
            const { safeUpdateState } = await import('../javascript/core-systems/stateManager.js');
            const stateResult = await safeUpdateState(storageResult, { validate: true });

            if (!stateResult.success) {
                throw new Error('State manager failed to accept valid data');
            }
            console.log('SUCCESS: State manager processed data correctly');

            // Step 4: Test initialization
            console.log('Step 4: Testing complete initialization...');
            const { initializeState } = await import('../javascript/entry-points/script.js');
            await initializeState();
            console.log('SUCCESS: Complete initialization completed');

            console.log(' ALL INTEGRATION TESTS PASSED');
            return true;

        } catch (error) {
            console.error(' INTEGRATION TEST FAILED:', error.message);
            console.error('Stack:', error.stack);
            return false;
        } finally {
            // Clean up
            try {
                await chrome.storage.sync.clear();
                console.log('Cleaned up test data');
            } catch (e) {
                console.warn('Could not clean up test data:', e.message);
            }
        }
    }
}

// Export for use in Chrome extension
if (typeof window !== 'undefined') {
    window.IntegrationTester = IntegrationTester;
}

// Run if executed directly in extension context
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IntegrationTester };
}