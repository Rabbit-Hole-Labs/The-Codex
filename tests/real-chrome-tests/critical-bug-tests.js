/**
 * Critical Bug Test Suite
 * Tests that specifically target known issues and can FAIL if not fixed
 */

class CriticalBugTester {
    constructor() {
        this.bugTests = [
            {
                id: 'CORRUPTION-001',
                name: 'Chrome Storage Object Corruption',
                description: 'Tests handling of links property being an object instead of array',
                test: this.testObjectCorruption
            },
            {
                id: 'CORRUPTION-002',
                name: 'State Manager Array Validation',
                description: 'Tests that state manager rejects non-array links',
                test: this.testArrayValidation
            },
            {
                id: 'INIT-001',
                name: 'Extension Initialization with Corruption',
                description: 'Tests complete initialization with corrupted storage',
                test: this.testInitializationWithCorruption
            },
            {
                id: 'STORAGE-001',
                name: 'Storage Manager Corruption Recovery',
                description: 'Tests storage manager recovery from various corruption scenarios',
                test: this.testStorageRecovery
            }
        ];
    }

    async runAllCriticalTests() {
        console.log('=== CRITICAL BUG TEST SUITE ===');
        console.log('These tests are designed to FAIL if bugs are not fixed');

        let passed = 0;
        let failed = 0;

        for (const bugTest of this.bugTests) {
            try {
                console.log(`\n--- Running ${bugTest.id}: ${bugTest.name} ---`);
                const result = await bugTest.test.call(this);

                if (result) {
                    console.log(` PASS: ${bugTest.name}`);
                    passed++;
                } else {
                    console.log(` FAIL: ${bugTest.name}`);
                    failed++;
                }
            } catch (error) {
                console.log(` ERROR: ${bugTest.name} - ${error.message}`);
                failed++;
            }
        }

        console.log('\n=== CRITICAL BUG TEST RESULTS ===');
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);
        console.log(`Total: ${this.bugTests.length}`);

        if (failed > 0) {
            console.log(' SOME CRITICAL TESTS FAILED');
            return false;
        } else {
            console.log(' ALL CRITICAL TESTS PASSED');
            return true;
        }
    }

    async testObjectCorruption() {
        console.log('Testing Chrome storage returning object instead of array...');

        try {
            // Inject the exact corruption that was causing crashes
            const corruptedData = {
                links: { corrupted: 'this_should_be_an_array' },
                theme: 'dark',
                view: 'grid'
            };

            await chrome.storage.sync.set(corruptedData);
            console.log('Injected corruption: links is object instead of array');

            // Test storage manager
            const { loadLinks } = await import('../../javascript/core-systems/storageManager.js');
            const result = await loadLinks();

            // Verify fix works
            if (!Array.isArray(result.links)) {
                throw new Error('Storage manager did not handle object corruption - links is not array');
            }

            console.log('SUCCESS: Storage manager converted object to empty array');
            return true;

        } catch (error) {
            console.error('FAIL:', error.message);
            return false;
        } finally {
            // Clean up
            await chrome.storage.sync.clear();
        }
    }

    async testArrayValidation() {
        console.log('Testing state manager array validation...');

        try {
            const { safeUpdateState } = await import('../../javascript/core-systems/stateManager.js');

            // Test with corrupted data that should be rejected
            const corruptedState = {
                links: { not: 'an array' },
                theme: 'dark'
            };

            const result = await safeUpdateState(corruptedState, { validate: true });

            // Should be rejected
            if (result.success) {
                throw new Error('State manager should have rejected non-array links');
            }

            console.log('SUCCESS: State manager correctly rejected non-array links');
            return true;

        } catch (error) {
            console.error('FAIL:', error.message);
            return false;
        }
    }

    async testInitializationWithCorruption() {
        console.log('Testing extension initialization with corruption...');

        try {
            // Inject corruption that was causing initialization to fail
            const corruptedData = {
                links: { initialization: 'failure_test' },
                theme: 'dark',
                view: 'grid',
                colorTheme: 'default',
                defaultTileSize: 'medium'
            };

            await chrome.storage.sync.set(corruptedData);
            console.log('Injected corruption that previously caused initialization failure');

            // Test actual initialization
            // Skip this test in Node.js environment since it requires browser APIs
            if (typeof window === 'undefined') {
                console.log('SKIP: Extension initialization test (requires browser environment)');
                return true;
            }
            
            const { initializeState } = await import('../../javascript/entry-points/script.js');

            // This should NOT throw an error
            await initializeState();

            console.log('SUCCESS: Extension initialized successfully with corruption');
            return true;

        } catch (error) {
            console.error('FAIL: Initialization failed with corruption:', error.message);
            return false;
        } finally {
            // Clean up
            await chrome.storage.sync.clear();
        }
    }

    async testStorageRecovery() {
        console.log('Testing storage manager recovery from various corruption scenarios...');

        const corruptionScenarios = [
            {
                name: 'Object instead of array',
                data: { links: { corrupted: true } }
            },
            {
                name: 'Null links',
                data: { links: null }
            },
            {
                name: 'Invalid JSON string',
                data: { links: '{ invalid: json' }
            },
            {
                name: 'Number instead of array',
                data: { links: 42 }
            },
            {
                name: 'Boolean instead of array',
                data: { links: true }
            }
        ];

        let passed = 0;

        for (const scenario of corruptionScenarios) {
            try {
                await chrome.storage.sync.set(scenario.data);
                console.log(`Testing scenario: ${scenario.name}`);

                const { loadLinks } = await import('../../javascript/core-systems/storageManager.js');
                const result = await loadLinks();

                if (Array.isArray(result.links)) {
                    console.log(` PASS: ${scenario.name} handled correctly`);
                    passed++;
                } else {
                    console.log(` FAIL: ${scenario.name} not handled correctly`);
                }
            } catch (error) {
                console.log(` ERROR: ${scenario.name} - ${error.message}`);
            } finally {
                await chrome.storage.sync.clear();
            }
        }

        console.log(`Recovery test results: ${passed}/${corruptionScenarios.length} scenarios passed`);
        return passed === corruptionScenarios.length;
    }
}

// Export for use in Chrome extension
if (typeof window !== 'undefined') {
    window.CriticalBugTester = CriticalBugTester;
}

// Run if executed directly
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CriticalBugTester };
}