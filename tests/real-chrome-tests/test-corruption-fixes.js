/**
 * Test Script for Chrome Storage Corruption Fixes
 * This script can be run in the Chrome extension console to verify the fixes
 */

// Test function to verify storage corruption handling
async function testStorageCorruptionFixes() {
    console.log('=== Testing Chrome Storage Corruption Fixes ===');
    
    // Test scenarios
    const corruptionScenarios = [
        {
            name: 'Links as Object',
            data: { links: { "0": { name: "Test", url: "https://example.com" }, length: 1 } }
        },
        {
            name: 'Links as Null',
            data: { links: null }
        },
        {
            name: 'Links as Number',
            data: { links: 42 }
        },
        {
            name: 'Links as Boolean',
            data: { links: true }
        }
    ];
    
    let allPassed = true;
    
    for (const scenario of corruptionScenarios) {
        console.log(`\n--- Testing: ${scenario.name} ---`);
        
        try {
            // Clear storage first
            await chrome.storage.sync.clear();
            
            // Inject corrupted data
            await chrome.storage.sync.set(scenario.data);
            console.log('  Injected corrupted data');
            
            // Test storage manager
            const { loadLinks } = await import('../javascript/core-systems/storageManager.js');
            const result = await loadLinks();
            
            // Check if links is properly handled
            if (Array.isArray(result.links)) {
                console.log('  ✓ Storage manager correctly handled corruption');
                console.log(`  ✓ Links is array: ${Array.isArray(result.links)}`);
                console.log(`  ✓ Links length: ${result.links.length}`);
            } else {
                console.error('  ✗ Storage manager failed to handle corruption');
                console.error(`  ✗ Links type: ${typeof result.links}`);
                console.error(`  ✗ Links value:`, result.links);
                allPassed = false;
            }
            
            // Test state manager
            const { safeUpdateState } = await import('../javascript/core-systems/stateManager.js');
            
            // Test with corrupted data (should be rejected)
            const corruptedUpdate = {
                links: scenario.data.links,
                theme: 'dark'
            };
            
            const corruptedResult = await safeUpdateState(corruptedUpdate, { validate: true });
            if (!corruptedResult.success) {
                console.log('  ✓ State manager correctly rejected corrupted data');
            } else {
                console.error('  ✗ State manager should have rejected corrupted data');
                allPassed = false;
            }
            
            // Test with valid data (should be accepted)
            const validUpdate = {
                links: [],
                theme: 'dark'
            };
            
            const validResult = await safeUpdateState(validUpdate, { validate: true });
            if (validResult.success) {
                console.log('  ✓ State manager correctly accepted valid data');
            } else {
                console.error('  ✗ State manager should have accepted valid data');
                allPassed = false;
            }
            
        } catch (error) {
            console.error(`  ✗ Test failed for ${scenario.name}:`, error);
            allPassed = false;
        }
    }
    
    // Test extension initialization
    console.log('\n--- Testing Extension Initialization ---');
    try {
        // Inject corruption one more time
        await chrome.storage.sync.set({ links: { corrupted: true } });
        
        // Test initialization
        const { initializeState } = await import('../javascript/entry-points/script.js');
        await initializeState();
        
        console.log('  ✓ Extension initialization completed successfully');
        
        // Check final state
        const { getState } = await import('../javascript/core-systems/stateManager.js');
        const finalState = getState();
        
        if (Array.isArray(finalState.links)) {
            console.log('  ✓ Final state has valid links array');
        } else {
            console.error('  ✗ Final state has invalid links');
            allPassed = false;
        }
        
    } catch (error) {
        console.error('  ✗ Extension initialization failed:', error);
        allPassed = false;
    }
    
    // Final results
    console.log('\n=== FINAL RESULTS ===');
    if (allPassed) {
        console.log('  ✓ ALL TESTS PASSED - Chrome storage corruption fixes are working!');
    } else {
        console.error('  ✗ SOME TESTS FAILED - Chrome storage corruption fixes need attention');
    }
    
    return allPassed;
}

// Make function available globally
window.testStorageCorruptionFixes = testStorageCorruptionFixes;

console.log('Test script loaded. Run testStorageCorruptionFixes() in the console to execute tests.');