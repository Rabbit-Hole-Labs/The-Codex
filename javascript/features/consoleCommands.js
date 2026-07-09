/**
 * Console Commands for Advanced Data Verification
 * These commands are accessed dynamically via window.CodexConsole in Chrome DevTools.
 *
 * INTENTIONALLY KEPT — Static analysis shows zero call sites because all access
 * is dynamic via the global CodexConsole object. Do not remove these functions
 * during dead code cleanup.
 *
 * Run CodexConsole.help() in DevTools for the current command list. Captured
 * runtime errors also have a visible surface at Manage → Sync Settings →
 * "Captured Errors", so viewing them no longer requires the console.
 */

import { dataVerification } from './dataVerification.js';
import { syncManager } from '../core-systems/syncManager.js';
import { getCacheStats, clearIconCache } from './iconCache.js';
import { setDebugEnabled, isDebugEnabled } from '../core-systems/debug.js';
import { getCapturedErrors, clearCapturedErrors, formatCapturedErrors } from './errorCapture.js';

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

    // Print captured runtime errors (uncaught, rejections, CSP violations,
    // console.error/warn) — the same problems shown on the chrome://extensions
    // errors screen, in a consistent, copy-pasteable form.
    async errors() {
        try {
            const list = await getCapturedErrors();
            console.log(formatCapturedErrors(list));
            return list;
        } catch (error) {
            console.error('Failed to read captured errors:', error);
            return [];
        }
    },

    // Download the captured error log as JSON (for pasting into a bug report).
    async exportErrors() {
        try {
            const list = await getCapturedErrors();
            const payload = {
                exportedAt: new Date().toISOString(),
                userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
                extensionVersion: (typeof chrome !== 'undefined' && chrome.runtime?.getManifest)
                    ? chrome.runtime.getManifest().version : 'unknown',
                count: list.length,
                errors: list
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `codex-errors-${Date.now()}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            console.log(`Exported ${list.length} captured error(s)`);
            return payload;
        } catch (error) {
            console.error('Failed to export captured errors:', error);
            return null;
        }
    },

    // Clear the captured error log.
    async clearErrors() {
        try {
            await clearCapturedErrors();
            console.log('Captured error log cleared');
            return true;
        } catch (error) {
            console.error('Failed to clear captured errors:', error);
            return false;
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

Error Log (captured runtime errors, CSP violations, console.error/warn):
  Also viewable in the UI: Manage → Sync Settings → "Captured Errors".
- CodexConsole.errors()        - Print captured errors (paste-friendly)
- CodexConsole.exportErrors()  - Download the error log as JSON
- CodexConsole.clearErrors()   - Clear the captured error log

Utilities:
- CodexConsole.exportAll()     - Export all data and analysis
- CodexConsole.help()          - Show this help

Example Usage:
CodexConsole.debug(true)        # Enable debug logging
await CodexConsole.compare()
await CodexConsole.findLinks('github')
await CodexConsole.storageInfo()
await CodexConsole.iconStats()
        `);
    }
};

// Make CodexConsole available globally. Discover commands with
// CodexConsole.help() — intentionally no load-time greeting, to keep the
// console quiet on every page load.
window.CodexConsole = CodexConsole;

export default CodexConsole;