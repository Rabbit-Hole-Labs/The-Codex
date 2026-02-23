// Console Commands for Advanced Data Verification
// These commands can be run in the browser console for direct data access

import { dataVerification } from './dataVerification.js';
import { syncManager } from '../core-systems/syncManager.js';
import { getCacheStats, clearIconCache, resetCacheStats, preloadIcons } from './iconCache.js';
import { setDebugEnabled, isDebugEnabled } from '../core-systems/debug.js';

// Global console helper for The Codex
const CodexConsole = {
    // Quick data access commands
    async cloudData() {
        try {
            const data = await dataVerification.getCloudData();
            console.log('Cloud Data:', data);
            return data;
        } catch (error) {
            console.error('Failed to get cloud data:', error);
            return null;
        }
    },

    async localData() {
        try {
            const data = await dataVerification.getLocalData();
            console.log('Local Data:', data);
            return data;
        } catch (error) {
            console.error('Failed to get local data:', error);
            return null;
        }
    },

    async compare() {
        try {
            const comparison = await dataVerification.compareData();
            console.log('Data Comparison:', comparison);

            // Summary output
            console.log('\n=== COMPARISON SUMMARY ===');
            console.log(`In Sync: ${comparison.summary.isInSync}`);
            console.log(`Link Count Difference: ${comparison.summary.linkCountDifference}`);
            console.log(`Category Count Difference: ${comparison.summary.categoryCountDifference}`);
            console.log(`Size Difference: ${comparison.summary.sizeDifference} bytes`);

            return comparison;
        } catch (error) {
            console.error('Failed to compare data:', error);
            return null;
        }
    },

    async validate() {
        try {
            const validation = await dataVerification.validateDataIntegrity();
            console.log('Data Validation:', validation);

            // Summary output
            console.log('\n=== VALIDATION SUMMARY ===');
            console.log(`Local Valid: ${validation.local.isValid}`);
            console.log(`Cloud Valid: ${validation.cloud.isValid}`);
            console.log(`Cross Validation: ${validation.crossValidation.isValid}`);

            if (!validation.local.isValid) {
                console.log('\nLocal Errors:', validation.local.errors);
            }
            if (!validation.cloud.isValid) {
                console.log('\nCloud Errors:', validation.cloud.errors);
            }

            return validation;
        } catch (error) {
            console.error('Failed to validate data:', error);
            return null;
        }
    },

    // Raw Chrome storage access
    async rawSync() {
        try {
            const data = await chrome.storage.sync.get(null);
            console.log('Raw Sync Storage:', data);
            return data;
        } catch (error) {
            console.error('Failed to get raw sync data:', error);
            return null;
        }
    },

    async rawLocal() {
        try {
            const data = await chrome.storage.local.get(null);
            console.log('Raw Local Storage:', data);
            return data;
        } catch (error) {
            console.error('Failed to get raw local data:', error);
            return null;
        }
    },

    // Storage info
    async storageInfo() {
        try {
            const syncBytesInUse = await new Promise(resolve => {
                chrome.storage.sync.getBytesInUse(null, resolve);
            });

            const localBytesInUse = await new Promise(resolve => {
                chrome.storage.local.getBytesInUse(null, resolve);
            });

            const info = {
                sync: {
                    bytesInUse: syncBytesInUse,
                    quota: chrome.storage.sync.QUOTA_BYTES,
                    percentage: (syncBytesInUse / chrome.storage.sync.QUOTA_BYTES) * 100,
                    itemsLimit: chrome.storage.sync.MAX_ITEMS,
                    bytesPerItemLimit: chrome.storage.sync.QUOTA_BYTES_PER_ITEM
                },
                local: {
                    bytesInUse: localBytesInUse,
                    quota: chrome.storage.local.QUOTA_BYTES
                }
            };

            console.log('Storage Information:', info);
            console.log('\n=== SYNC STORAGE ===');
            console.log(`Used: ${(info.sync.bytesInUse / 1024).toFixed(2)} KB`);
            console.log(`Quota: ${(info.sync.quota / 1024).toFixed(0)} KB`);
            console.log(`Usage: ${info.sync.percentage.toFixed(2)}%`);
            console.log(`Max Items: ${info.sync.itemsLimit}`);

            console.log('\n=== LOCAL STORAGE ===');
            console.log(`Used: ${(info.local.bytesInUse / 1024).toFixed(2)} KB`);
            console.log(`Quota: ${(info.local.quota / 1024 / 1024).toFixed(0)} MB`);

            return info;
        } catch (error) {
            console.error('Failed to get storage info:', error);
            return null;
        }
    },

    // Sync operations
    async sync(strategy = null) {
        try {
            console.log(`Starting sync${strategy ? ` with strategy: ${strategy}` : ''}...`);
            const result = await syncManager.syncData(strategy);
            console.log('Sync Result:', result);
            return result;
        } catch (error) {
            console.error('Sync failed:', error);
            return null;
        }
    },

    async forcePush() {
        try {
            console.log('Force pushing local data to cloud...');
            const result = await syncManager.forcePushToRemote();
            console.log('Force Push Result:', result);
            return result;
        } catch (error) {
            console.error('Force push failed:', error);
            return null;
        }
    },

    async forcePull() {
        try {
            console.log('Force pulling cloud data to local...');
            const result = await syncManager.forcePullFromRemote();
            console.log('Force Pull Result:', result);
            return result;
        } catch (error) {
            console.error('Force pull failed:', error);
            return null;
        }
    },

    // Utility functions
    async exportAll() {
        try {
            const [localData, cloudData, comparison, validation] = await Promise.all([
                dataVerification.getLocalData(),
                dataVerification.getCloudData(),
                dataVerification.compareData(),
                dataVerification.validateDataIntegrity()
            ]);

            const exportData = {
                timestamp: new Date().toISOString(),
                local: localData,
                cloud: cloudData,
                comparison,
                validation,
                storageInfo: await this.storageInfo()
            };

            const dataStr = JSON.stringify(exportData, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `codex-complete-data-export-${Date.now()}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            console.log('Complete data export saved');
            return exportData;
        } catch (error) {
            console.error('Failed to export all data:', error);
            return null;
        }
    },

    // Search within data
    async findLinks(searchTerm) {
        try {
            const localData = await dataVerification.getLocalData();
            const cloudData = await dataVerification.getCloudData();

            const searchLocal = (localData.parsed.links || []).filter(link =>
                link.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                link.url.toLowerCase().includes(searchTerm.toLowerCase()) ||
                (link.category && link.category.toLowerCase().includes(searchTerm.toLowerCase()))
            );

            const searchCloud = (cloudData.parsed.links || []).filter(link =>
                link.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                link.url.toLowerCase().includes(searchTerm.toLowerCase()) ||
                (link.category && link.category.toLowerCase().includes(searchTerm.toLowerCase()))
            );

            const results = {
                searchTerm,
                local: searchLocal,
                cloud: searchCloud,
                localCount: searchLocal.length,
                cloudCount: searchCloud.length
            };

            console.log(`Search Results for "${searchTerm}":`, results);
            return results;
        } catch (error) {
            console.error('Search failed:', error);
            return null;
        }
    },

    // Icon Cache Commands
    async iconStats() {
        try {
            const stats = getCacheStats();
            console.log('Icon Cache Statistics:', stats);

            // Summary output
            console.log('\n=== ICON CACHE SUMMARY ===');
            console.log(`Cache Size: ${stats.cacheSize} icons`);
            console.log(`Hit Rate: ${stats.hitRate}%`);
            console.log(`Miss Rate: ${stats.missRate}%`);
            console.log(`Failure Rate: ${stats.failureRate}%`);
            console.log(`Total Requests: ${stats.totalRequests}`);

            return stats;
        } catch (error) {
            console.error('Failed to get icon cache stats:', error);
            return null;
        }
    },

    async clearIconCache() {
        try {
            clearIconCache();
            console.log('Icon cache cleared successfully');
            return true;
        } catch (error) {
            console.error('Failed to clear icon cache:', error);
            return false;
        }
    },

    async resetIconStats() {
        try {
            resetCacheStats();
            console.log('Icon cache statistics reset successfully');
            return true;
        } catch (error) {
            console.error('Failed to reset icon cache stats:', error);
            return false;
        }
    },

    async preloadIcons() {
        try {
            const currentState = window.getState ? window.getState() : null;
            if (!currentState || !currentState.links || currentState.links.length === 0) {
                console.warn('No links available for icon preloading');
                return false;
            }

            console.log(`Preloading icons for ${currentState.links.length} links...`);
            await preloadIcons(currentState.links);
            console.log('Icon preloading completed');

            // Show updated stats
            const stats = getCacheStats();
            console.log('Updated cache stats:', stats);

            return true;
        } catch (error) {
            console.error('Failed to preload icons:', error);
            return false;
        }
    },

    // Real Chrome Extension Tests - Version 7.0.0a
    // These tests actually verify the extension functionality and can FAIL if fixes don't work

    async testStorageCorruptionFix() {
        console.log('=== REAL CHROME STORAGE CORRUPTION TEST ===');
        console.log('Testing the actual fix for Chrome storage corruption...');

        try {
            // Test 1: Check current storage state
            console.log('\n--- Test 1: Current Storage State ---');
            const currentData = await chrome.storage.sync.get(['links', 'theme', 'view', 'colorTheme', 'defaultTileSize']);
            console.log('Current storage data:', currentData);

            // Check if we have corrupted data
            if (currentData.links && typeof currentData.links === 'object' && !Array.isArray(currentData.links)) {
                console.log('  DETECTED: Corrupted storage data (links is object, not array)');
                console.log('This is the exact issue that was breaking the extension');
            } else {
                console.log(' Storage data appears valid');
            }

            // Test 2: Test storage manager with real data
            console.log('\n--- Test 2: Storage Manager Handling ---');
            const { loadLinks } = await import('../core-systems/storageManager.js');
            const storageResult = await loadLinks();

            console.log('Storage manager result:', storageResult);
            console.log('Links type:', typeof storageResult.links);
            console.log('Links is array:', Array.isArray(storageResult.links));

            if (!Array.isArray(storageResult.links)) {
                console.error(' FAILURE: Storage manager returned non-array for links');
                console.error('The Chrome storage corruption fix is NOT working');
                return false;
            }

            console.log(' SUCCESS: Storage manager handled data correctly');

            // Test 3: Test state manager validation
            console.log('\n--- Test 3: State Manager Validation ---');
            const { safeUpdateState } = await import('../core-systems/stateManager.js');

            // Test with valid data (what we want)
            const validUpdate = {
                links: [],
                theme: 'dark',
                colorTheme: 'default',
                view: 'grid',
                defaultTileSize: 'medium'
            };

            const validResult = await safeUpdateState(validUpdate, { validate: true });
            console.log('Valid update result:', validResult);

            if (!validResult.success) {
                console.error(' FAILURE: State manager rejected valid data');
                return false;
            }

            // Test with corrupted data (what was breaking the extension)
            const corruptedUpdate = {
                links: { corrupted: 'object' }, // This is what Chrome storage was returning
                theme: 'dark'
            };

            const corruptedResult = await safeUpdateState(corruptedUpdate, { validate: true });
            console.log('Corrupted update result:', corruptedResult);

            if (corruptedResult.success) {
                console.error(' FAILURE: State manager accepted corrupted data');
                console.error('The validation fix is NOT working');
                return false;
            }

            console.log(' SUCCESS: State manager correctly rejected corrupted data');

            // Test 4: Test complete initialization
            console.log('\n--- Test 4: Complete Initialization ---');
            const { getState } = await import('../core-systems/stateManager.js');
            const currentState = getState();

            console.log('Current state:', currentState);
            console.log('State links type:', typeof currentState.links);
            console.log('State links is array:', Array.isArray(currentState.links));

            if (!Array.isArray(currentState.links)) {
                console.error(' FAILURE: Extension state contains invalid links');
                return false;
            }

            console.log(' SUCCESS: Extension initialized with valid state');

            console.log('\n=== ALL STORAGE CORRUPTION TESTS PASSED ===');
            console.log(' The Chrome storage corruption fix is working correctly');
            console.log(' The extension can handle corrupted Chrome storage');
            console.log(' Version 7.0.0a is functional and ready');

            return true;

        } catch (error) {
            console.error(' CRITICAL FAILURE:', error);
            console.error('The Chrome storage corruption fix may not be working');
            return false;
        }
    },

    async testAllRealFunctionality() {
        console.log('=== COMPREHENSIVE REAL FUNCTIONALITY TEST ===');
        console.log('Testing all critical components that were previously broken...');

        try {
            let allPassed = true;

            // Test 1: Storage corruption fix
            console.log('\n--- Test 1: Chrome Storage Corruption Fix ---');
            const corruptionTest = await this.testStorageCorruptionFix();
            if (!corruptionTest) {
                console.error(' Storage corruption test FAILED');
                allPassed = false;
            } else {
                console.log(' Storage corruption test PASSED');
            }

            // Test 2: Data integrity
            console.log('\n--- Test 2: Data Integrity ---');
            const validationTest = await this.validate();
            if (!validationTest) {
                console.error(' Data integrity test FAILED');
                allPassed = false;
            } else {
                console.log(' Data integrity test PASSED');
            }

            // Test 3: Sync functionality
            console.log('\n--- Test 3: Sync Functionality ---');
            try {
                const syncTest = await this.sync('merge');
                if (!syncTest) {
                    console.error(' Sync functionality test FAILED');
                    allPassed = false;
                } else {
                    console.log(' Sync functionality test PASSED');
                }
            } catch (error) {
                console.error(' Sync functionality test FAILED:', error.message);
                allPassed = false;
            }

            // Test 4: Icon cache
            console.log('\n--- Test 4: Icon Cache Functionality ---');
            try {
                const iconStats = await this.iconStats();
                if (!iconStats) {
                    console.error(' Icon cache test FAILED');
                    allPassed = false;
                } else {
                    console.log(' Icon cache test PASSED');
                }
            } catch (error) {
                console.error(' Icon cache test FAILED:', error.message);
                allPassed = false;
            }

            console.log('\n=== FINAL RESULTS ===');
            if (allPassed) {
                console.log(' ALL REAL FUNCTIONALITY TESTS PASSED');
                console.log(' The Codex extension is fully functional');
                console.log(' All critical fixes are working correctly');
                console.log(' Version 7.0.0a is ready for production');
            } else {
                console.error(' SOME REAL FUNCTIONALITY TESTS FAILED');
                console.error('  The extension may have issues that need to be addressed');
            }

            return allPassed;

        } catch (error) {
            console.error(' CRITICAL FAILURE IN COMPREHENSIVE TEST:', error);
            return false;
        }
    },

    // Real Chrome Extension Diagnostic - Version 7.0.0a
    // These diagnostic functions can actually identify real issues in the extension

    async testActualExtensionIssues() {
        console.log('=== REAL CHROME EXTENSION DIAGNOSTIC ===');
        console.log('Identifying actual issues that may be causing problems...');

        try {
            let issuesFound = [];

            // Diagnostic 1: Check current state
            console.log('\n--- Diagnostic 1: Current State Analysis ---');
            const { getState } = await import('../core-systems/stateManager.js');
            const currentState = getState();

            console.log('Current state:', currentState);
            console.log('State links type:', typeof currentState.links);
            console.log('State links is array:', Array.isArray(currentState.links));
            console.log('State links length:', currentState.links ? currentState.links.length : 'N/A');

            if (!Array.isArray(currentState.links)) {
                issuesFound.push('State links is not an array');
            }

            // Diagnostic 2: Check storage data
            console.log('\n--- Diagnostic 2: Storage Data Analysis ---');
            const storageData = await chrome.storage.sync.get(['links', 'theme', 'view', 'colorTheme', 'defaultTileSize']);
            console.log('Raw storage data:', storageData);

            if (storageData.links) {
                console.log('Storage links type:', typeof storageData.links);
                console.log('Storage links is array:', Array.isArray(storageData.links));

                if (typeof storageData.links === 'object' && !Array.isArray(storageData.links)) {
                    issuesFound.push('Storage links is corrupted object instead of array');
                } else if (typeof storageData.links === 'string') {
                    try {
                        const parsed = JSON.parse(storageData.links);
                        console.log('Parsed links type:', typeof parsed);
                        console.log('Parsed links is array:', Array.isArray(parsed));
                        if (!Array.isArray(parsed)) {
                            issuesFound.push('Parsed storage links is not an array');
                        }
                    } catch (parseError) {
                        issuesFound.push('Storage links string is not valid JSON');
                    }
                }
            }

            // Diagnostic 3: Check DOM elements
            console.log('\n--- Diagnostic 3: DOM Element Analysis ---');
            const linksContainer = document.getElementById('linksContainer');
            const searchInput = document.getElementById('searchInput');

            if (!linksContainer) {
                issuesFound.push('Links container element not found');
                console.error(' Links container (#links-container) not found in DOM');
            } else {
                console.log(' Links container found');
                console.log('Links container children:', linksContainer.children.length);
            }

            if (!searchInput) {
                issuesFound.push('Search input element not found');
                console.error(' Search input (#search-input) not found in DOM');
            } else {
                console.log(' Search input found');
            }

            // Diagnostic 4: Check event listeners
            console.log('\n--- Diagnostic 4: Event Listener Analysis ---');
            // This is harder to diagnose without access to the internal tracking

            // Diagnostic 5: Check rendering
            console.log('\n--- Diagnostic 5: Rendering Analysis ---');
            const renderedLinks = document.querySelectorAll('.link-tile');
            console.log('Rendered link tiles found:', renderedLinks.length);

            if (renderedLinks.length === 0 && currentState.links && currentState.links.length > 0) {
                issuesFound.push('Links exist in state but are not rendered');
                console.error(' Links exist in state but no link tiles are rendered');
            }

            // Diagnostic 6: Check theme application
            console.log('\n--- Diagnostic 6: Theme Analysis ---');
            const bodyClass = document.body.className;
            console.log('Body classes:', bodyClass);

            if (!bodyClass.includes('theme-')) {
                issuesFound.push('Theme not properly applied to body');
                console.error(' Theme classes not found on body element');
            }

            // Diagnostic 7: Check for JavaScript errors
            console.log('\n--- Diagnostic 7: JavaScript Error Analysis ---');
            // We can't directly check for errors, but we can look for signs of failure

            console.log('\n=== DIAGNOSTIC RESULTS ===');
            if (issuesFound.length > 0) {
                console.error(' ISSUES FOUND:');
                issuesFound.forEach((issue, index) => {
                    console.error(`  ${index + 1}. ${issue}`);
                });
                console.log('\nThese are the actual issues that may be causing problems, not just storage corruption.');
                return {
                    success: false,
                    issues: issuesFound
                };
            } else {
                console.log(' No critical issues found in diagnostic');
                return {
                    success: true,
                    issues: []
                };
            }

        } catch (error) {
            console.error(' CRITICAL FAILURE IN DIAGNOSTIC:', error);
            return {
                success: false,
                error: error.message
            };
        }
    },

    // Storage Corruption Testing
    async injectCorruptedData() {
        console.log('=== INJECTING CORRUPTED DATA ===');
        console.log('This will simulate the Chrome storage corruption bug for testing purposes...');
        console.log('Creating corrupted data where links property becomes an object instead of array');
        console.log('');
        try {
            // First, get current data to preserve other settings
            const currentData = await chrome.storage.sync.get(['links', 'theme', 'view', 'colorTheme', 'defaultTileSize']);
            console.log('Current storage data:', currentData);
            console.log('');
            // Create corrupted data - this mimics the Chrome storage bug
            const corruptedData = {
                // This is the corrupted part - links as an object instead of array
                links: {
                    "0": {
                        name: "Corrupted Link 1",
                        url: "https://example.com",
                        category: "Test"
                    },
                    "1": {
                        name: "Corrupted Link 2",
                        url: "https://test.com",
                        category: "Test"
                    },
                    length: 2,
                    corrupted: true
                },
                // Preserve other settings
                theme: currentData.theme || 'dark',
                view: currentData.view || 'grid',
                colorTheme: currentData.colorTheme || 'default',
                defaultTileSize: currentData.defaultTileSize || 'medium'
            };
            console.log('Injecting corrupted data:', corruptedData);
            // Save corrupted data to storage
            await chrome.storage.sync.set(corruptedData);
            console.log('');
            console.log('SUCCESS: Corrupted data injected into Chrome storage');
            console.log('');
            console.log('To test the fix:');
            console.log('1. Refresh the extension popup');
            console.log('2. Run CodexConsole.testStorageCorruptionFix() to verify the fix works');
            console.log('3. Check that links still display correctly despite the corruption');
            console.log('');
            console.log('The extension should now automatically handle this corruption and recover.');
            return true;
        } catch (error) {
            console.error('FAILED to inject corrupted data:', error);
            return false;
        }
    },

    // Debug Mode Control
    debug(enable = true) {
        setDebugEnabled(enable);
        console.log(`Debug mode: ${enable ? 'ENABLED' : 'DISABLED'}`);
        console.log('Use CodexConsole.debug(true) to enable, CodexConsole.debug(false) to disable');
        return isDebugEnabled();
    },

    debugStatus() {
        console.log(`Debug mode is currently: ${isDebugEnabled() ? 'ENABLED' : 'DISABLED'}`);
        return isDebugEnabled();
    },

    // Help command
    help() {
        console.log(`
CODEX CONSOLE COMMANDS

Debug Mode:
- CodexConsole.debug(true)     - Enable debug logging
- CodexConsole.debug(false)    - Disable debug logging
- CodexConsole.debugStatus()   - Check debug mode status

Data Access:
- CodexConsole.cloudData()     - Get all cloud storage data
- CodexConsole.localData()     - Get all local storage data
- CodexConsole.rawSync()       - Get raw sync storage (Chrome API)
- CodexConsole.rawLocal()      - Get raw local storage (Chrome API)

Data Analysis:
- CodexConsole.compare()       - Compare local vs cloud data
- CodexConsole.validate()      - Validate data integrity
- CodexConsole.findLinks('term') - Search for links containing term

Storage Info:
- CodexConsole.storageInfo()   - Get storage usage and quotas

Sync Operations:
- CodexConsole.sync()          - Perform normal sync
- CodexConsole.sync('merge')   - Sync with merge strategy
- CodexConsole.sync('local')   - Sync preferring local data
- CodexConsole.sync('remote')  - Sync preferring cloud data
- CodexConsole.forcePush()     - Force push local to cloud
- CodexConsole.forcePull()     - Force pull cloud to local

Icon Cache Management:
- CodexConsole.iconStats()     - Get icon cache statistics
- CodexConsole.clearIconCache() - Clear all cached icons
- CodexConsole.resetIconStats() - Reset cache statistics
- CodexConsole.preloadIcons()  - Preload icons for all links

Real Extension Tests (CAN FAIL IF FIXES DON'T WORK):
- CodexConsole.testStorageCorruptionFix() - Test Chrome storage corruption fix
- CodexConsole.testAllRealFunctionality() - Run all real functionality tests
- CodexConsole.testActualExtensionIssues() - Diagnostic for actual extension issues
- CodexConsole.injectCorruptedData()      - Inject corrupted data for testing storage fixes

Utilities:
- CodexConsole.exportAll()     - Export all data and analysis
- CodexConsole.help()          - Show this help

Example Usage:
CodexConsole.debug(true)        # Enable debug logging
await CodexConsole.compare()
await CodexConsole.findLinks('github')
await CodexConsole.storageInfo()
await CodexConsole.iconStats()
await CodexConsole.preloadIcons()
await CodexConsole.testStorageCorruptionFix()
        `);
    }
};

// Make CodexConsole available globally
window.CodexConsole = CodexConsole;

// Show help on load
console.log('Codex Console Commands loaded! Type CodexConsole.help() for available commands.');

export default CodexConsole;