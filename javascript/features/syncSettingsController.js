// Sync Settings Page Controller
import { syncManager } from '../core-systems/syncManager.js';
import { dataVerification } from './dataVerification.js';

export class SyncSettingsController {
    constructor() {
        this.elements = {};
        this.syncLog = [];
        this.logUpdateInterval = null;
    }

    // Initialize the sync settings controller
    init() {
        this.getElements();
        this.attachEventListeners();
        this.startPeriodicUpdates();
        this.updateSyncStatus();
        this.addLogEntry('info', 'Sync settings page loaded');
    }

    // Get all DOM elements
    getElements() {
        this.elements = {
            // Status elements
            currentStatus: document.getElementById('sync-current-status'),
            lastSyncTime: document.getElementById('sync-last-time'),
            localVersion: document.getElementById('sync-local-version'),
            remoteVersion: document.getElementById('sync-remote-version'),

            // Storage elements
            storageFill: document.getElementById('storage-fill'),
            storageUsed: document.getElementById('storage-used'),
            storageTotal: document.getElementById('storage-total'),
            quotaPercentage: document.getElementById('quota-percentage'),

            // Action buttons
            refreshStatusBtn: document.getElementById('refresh-sync-status'),
            manualSyncBtn: document.getElementById('manual-sync-btn'),
            forcePushBtn: document.getElementById('force-push-btn'),
            forcePullBtn: document.getElementById('force-pull-btn'),
            clearSyncBtn: document.getElementById('clear-sync-btn'),

            // Settings
            syncStrategySelect: document.getElementById('sync-strategy-select'),

            // Diagnostics
            deviceId: document.getElementById('device-id'),
            syncEnabled: document.getElementById('sync-enabled'),
            networkStatus: document.getElementById('network-status'),
            testSyncBtn: document.getElementById('test-sync-btn'),
            exportDiagnosticsBtn: document.getElementById('export-diagnostics-btn'),

            // Log
            syncLog: document.getElementById('sync-log'),
            clearLogBtn: document.getElementById('clear-log-btn'),

            // Data verification
            viewCloudDataBtn: document.getElementById('view-cloud-data-btn'),
            viewLocalDataBtn: document.getElementById('view-local-data-btn'),
            compareDataBtn: document.getElementById('compare-data-btn'),
            validateIntegrityBtn: document.getElementById('validate-integrity-btn')
        };
    }

    // Attach event listeners
    attachEventListeners() {
        // Status refresh
        this.elements.refreshStatusBtn?.addEventListener('click', () => {
            this.updateSyncStatus();
            this.addLogEntry('info', 'Status refreshed manually');
        });

        // Sync actions
        this.elements.manualSyncBtn?.addEventListener('click', () => this.handleManualSync());
        this.elements.forcePushBtn?.addEventListener('click', () => this.handleForcePush());
        this.elements.forcePullBtn?.addEventListener('click', () => this.handleForcePull());
        this.elements.clearSyncBtn?.addEventListener('click', () => this.handleClearSync());

        // Strategy selection
        this.elements.syncStrategySelect?.addEventListener('change', (e) => {
            syncManager.conflictResolutionStrategy = e.target.value;
            this.addLogEntry('info', `Conflict resolution strategy changed to: ${e.target.value}`);
        });

        // Diagnostics
        this.elements.testSyncBtn?.addEventListener('click', () => this.handleTestSync());
        this.elements.exportDiagnosticsBtn?.addEventListener('click', () => this.handleExportDiagnostics());

        // Log management
        this.elements.clearLogBtn?.addEventListener('click', () => this.clearLog());

        // Data verification
        this.elements.viewCloudDataBtn?.addEventListener('click', () => this.handleViewCloudData());
        this.elements.viewLocalDataBtn?.addEventListener('click', () => this.handleViewLocalData());
        this.elements.compareDataBtn?.addEventListener('click', () => this.handleCompareData());
        this.elements.validateIntegrityBtn?.addEventListener('click', () => this.handleValidateIntegrity());

        // Listen to sync manager events
        syncManager.addSyncListener((event, data) => {
            this.handleSyncEvent(event, data);
        });

        // Network status
        window.addEventListener('online', () => this.updateNetworkStatus());
        window.addEventListener('offline', () => this.updateNetworkStatus());
    }

    // Start periodic status updates
    startPeriodicUpdates() {
        // Update status every 30 seconds
        this.logUpdateInterval = setInterval(() => {
            this.updateSyncStatus();
        }, 30000);
    }

    // Stop periodic updates
    destroy() {
        if (this.logUpdateInterval) {
            clearInterval(this.logUpdateInterval);
            this.logUpdateInterval = null;
        }
    }

    // Update sync status display
    async updateSyncStatus() {
        try {
            const status = await syncManager.getSyncStatus();

            // Update status info
            if (this.elements.currentStatus) {
                this.elements.currentStatus.textContent = status.isInSync ? 'In Sync' : 'Out of Sync';
                this.elements.currentStatus.style.color = status.isInSync ? '#4caf50' : '#ff9800';
            }

            if (this.elements.lastSyncTime) {
                this.elements.lastSyncTime.textContent = status.lastSyncTime
                    ? this.formatTime(status.lastSyncTime)
                    : 'Never';
            }

            if (this.elements.localVersion) {
                this.elements.localVersion.textContent = status.localVersion
                    ? new Date(status.localVersion).toLocaleString()
                    : '-';
            }

            if (this.elements.remoteVersion) {
                this.elements.remoteVersion.textContent = status.remoteVersion
                    ? new Date(status.remoteVersion).toLocaleString()
                    : '-';
            }

            // Update storage info
            this.updateStorageDisplay(status);

            // Update diagnostics
            await this.updateDiagnostics();

        } catch (error) {
            console.error('Failed to update sync status:', error);
            this.addLogEntry('error', `Failed to update status: ${error.message}`);
        }
    }

    // Update storage display
    updateStorageDisplay(status) {
        const usedKB = (status.bytesInUse / 1024).toFixed(2);
        const totalKB = (status.quotaLimit / 1024).toFixed(0);
        const percentage = status.quotaPercentage;

        if (this.elements.storageUsed) {
            this.elements.storageUsed.textContent = `${usedKB} KB`;
        }

        if (this.elements.storageTotal) {
            this.elements.storageTotal.textContent = `${totalKB} KB`;
        }

        if (this.elements.quotaPercentage) {
            this.elements.quotaPercentage.textContent = `${percentage.toFixed(1)}%`;
        }

        if (this.elements.storageFill) {
            this.elements.storageFill.style.width = `${percentage}%`;

            // Change color based on usage
            this.elements.storageFill.className = 'storage-fill';
            if (percentage > 90) {
                this.elements.storageFill.classList.add('danger');
            } else if (percentage > 70) {
                this.elements.storageFill.classList.add('warning');
            }
        }
    }

    // Update diagnostics info
    async updateDiagnostics() {
        try {
            const deviceId = await syncManager.getDeviceId();
            if (this.elements.deviceId) {
                this.elements.deviceId.textContent = deviceId;
            }

            this.updateNetworkStatus();

            // Check if sync is enabled (Chrome storage API available)
            const syncEnabled = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
            if (this.elements.syncEnabled) {
                this.elements.syncEnabled.textContent = syncEnabled ? 'Yes' : 'No';
                this.elements.syncEnabled.style.color = syncEnabled ? '#4caf50' : '#f44336';
            }

        } catch (error) {
            console.error('Failed to update diagnostics:', error);
            this.addLogEntry('error', `Failed to update diagnostics: ${error.message}`);
        }
    }

    // Update network status
    updateNetworkStatus() {
        const isOnline = navigator.onLine;
        if (this.elements.networkStatus) {
            this.elements.networkStatus.textContent = isOnline ? 'Online' : 'Offline';
            this.elements.networkStatus.style.color = isOnline ? '#4caf50' : '#f44336';
        }
    }

    // Handle manual sync
    async handleManualSync() {
        this.addLogEntry('info', 'Manual sync initiated');
        this.setButtonLoading(this.elements.manualSyncBtn, true);

        try {
            const result = await syncManager.syncData();
            if (result.success) {
                this.addLogEntry('success', 'Manual sync completed successfully');
            } else {
                this.addLogEntry('error', `Manual sync failed: ${result.error}`);
            }
        } catch (error) {
            this.addLogEntry('error', `Manual sync error: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.manualSyncBtn, false);
        }
    }

    // Handle force push
    async handleForcePush() {
        if (!confirm('This will overwrite cloud data with your local data. Continue?')) {
            return;
        }

        this.addLogEntry('warning', 'Force push initiated - local data will overwrite cloud');
        this.setButtonLoading(this.elements.forcePushBtn, true);

        try {
            const result = await syncManager.forcePushToRemote();
            if (result.success) {
                this.addLogEntry('success', 'Force push completed successfully');
            } else {
                this.addLogEntry('error', `Force push failed: ${result.error}`);
            }
        } catch (error) {
            this.addLogEntry('error', `Force push error: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.forcePushBtn, false);
        }
    }

    // Handle force pull
    async handleForcePull() {
        if (!confirm('This will overwrite local data with cloud data. Continue?')) {
            return;
        }

        this.addLogEntry('warning', 'Force pull initiated - cloud data will overwrite local');
        this.setButtonLoading(this.elements.forcePullBtn, true);

        try {
            const result = await syncManager.forcePullFromRemote();
            if (result.success) {
                this.addLogEntry('success', 'Force pull completed successfully');
            } else {
                this.addLogEntry('error', `Force pull failed: ${result.error}`);
            }
        } catch (error) {
            this.addLogEntry('error', `Force pull error: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.forcePullBtn, false);
        }
    }

    // Handle clear sync data
    async handleClearSync() {
        if (!confirm('This will clear all sync data. This action cannot be undone. Continue?')) {
            return;
        }

        this.addLogEntry('warning', 'Clearing all sync data');
        this.setButtonLoading(this.elements.clearSyncBtn, true);

        try {
            const result = await syncManager.clearSyncData();
            if (result.success) {
                this.addLogEntry('success', 'Sync data cleared successfully');
                await this.updateSyncStatus();
            } else {
                this.addLogEntry('error', `Failed to clear sync data: ${result.error}`);
            }
        } catch (error) {
            this.addLogEntry('error', `Clear sync error: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.clearSyncBtn, false);
        }
    }

    // Handle test sync connection
    async handleTestSync() {
        this.addLogEntry('info', 'Testing sync connection...');
        this.setButtonLoading(this.elements.testSyncBtn, true);

        try {
            // Test by attempting to read sync storage
            const testData = await chrome.storage.sync.get(['test']);
            await chrome.storage.sync.set({ syncTest: Date.now() });
            await chrome.storage.sync.remove(['syncTest']);

            this.addLogEntry('success', 'Sync connection test passed');
        } catch (error) {
            this.addLogEntry('error', `Sync connection test failed: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.testSyncBtn, false);
        }
    }

    // Handle export diagnostics
    async handleExportDiagnostics() {
        try {
            const status = await syncManager.getSyncStatus();
            const deviceId = await syncManager.getDeviceId();

            const diagnostics = {
                timestamp: new Date().toISOString(),
                deviceId,
                syncStatus: status,
                networkStatus: navigator.onLine,
                userAgent: navigator.userAgent,
                syncLog: this.syncLog.slice(-50), // Last 50 log entries
                chromeVersion: chrome?.runtime?.getManifest?.()?.version || 'unknown'
            };

            const dataStr = JSON.stringify(diagnostics, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `codex-sync-diagnostics-${Date.now()}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            this.addLogEntry('info', 'Diagnostics exported successfully');
        } catch (error) {
            this.addLogEntry('error', `Failed to export diagnostics: ${error.message}`);
        }
    }

    // Handle sync events from sync manager
    handleSyncEvent(event, data) {
        switch (event) {
            case 'syncStart':
                this.addLogEntry('info', 'Sync started');
                break;
            case 'syncComplete':
                this.addLogEntry('success', `Sync completed - ${data.itemsSynced || 0} items synced`);
                this.updateSyncStatus();
                break;
            case 'syncError':
                this.addLogEntry('error', `Sync error: ${data.error}`);
                break;
            case 'quotaExceeded':
                this.addLogEntry('warning', 'Sync storage quota exceeded');
                break;
            case 'syncCleared':
                this.addLogEntry('info', 'Sync data cleared');
                break;
        }
    }

    // Add entry to sync log
    addLogEntry(type, message) {
        const entry = {
            timestamp: Date.now(),
            type,
            message
        };

        this.syncLog.push(entry);

        // Keep only last 100 entries
        if (this.syncLog.length > 100) {
            this.syncLog = this.syncLog.slice(-100);
        }

        this.updateLogDisplay();
    }

    // Update log display
    updateLogDisplay() {
        if (!this.elements.syncLog) return;

        const logHTML = this.syncLog
            .slice(-20) // Show last 20 entries
            .reverse()
            .map(entry => `
                <div class="log-entry ${entry.type}">
                    <span class="log-time">${this.formatTime(entry.timestamp)}</span>
                    <span class="log-message">${entry.message}</span>
                </div>
            `)
            .join('');

        this.elements.syncLog.innerHTML = logHTML;
    }

    // Clear sync log
    clearLog() {
        this.syncLog = [];
        this.updateLogDisplay();
        this.addLogEntry('info', 'Log cleared');
    }

    // Set button loading state
    setButtonLoading(button, loading) {
        if (!button) return;

        if (loading) {
            button.disabled = true;
            button.dataset.originalText = button.textContent;
            button.textContent = 'Loading...';
        } else {
            button.disabled = false;
            button.textContent = button.dataset.originalText || button.textContent;
        }
    }

    // Handle view cloud data
    async handleViewCloudData() {
        this.addLogEntry('info', 'Fetching cloud data...');
        this.setButtonLoading(this.elements.viewCloudDataBtn, true);

        try {
            const cloudData = await dataVerification.getCloudData();
            dataVerification.showDataModal('Cloud Storage Data', cloudData);
            this.addLogEntry('success', 'Cloud data retrieved successfully');
        } catch (error) {
            this.addLogEntry('error', `Failed to get cloud data: ${error.message}`);
            alert(`Failed to get cloud data: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.viewCloudDataBtn, false);
        }
    }

    // Handle view local data
    async handleViewLocalData() {
        this.addLogEntry('info', 'Fetching local data...');
        this.setButtonLoading(this.elements.viewLocalDataBtn, true);

        try {
            const localData = await dataVerification.getLocalData();
            dataVerification.showDataModal('Local Storage Data', localData);
            this.addLogEntry('success', 'Local data retrieved successfully');
        } catch (error) {
            this.addLogEntry('error', `Failed to get local data: ${error.message}`);
            alert(`Failed to get local data: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.viewLocalDataBtn, false);
        }
    }

    // Handle compare data
    async handleCompareData() {
        this.addLogEntry('info', 'Comparing local and cloud data...');
        this.setButtonLoading(this.elements.compareDataBtn, true);

        try {
            const comparison = await dataVerification.compareData();
            dataVerification.showDataModal('Data Comparison', comparison, 'comparison');
            this.addLogEntry('success', `Data comparison completed - In sync: ${comparison.summary.isInSync}`);
        } catch (error) {
            this.addLogEntry('error', `Failed to compare data: ${error.message}`);
            alert(`Failed to compare data: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.compareDataBtn, false);
        }
    }

    // Handle validate integrity
    async handleValidateIntegrity() {
        this.addLogEntry('info', 'Validating data integrity...');
        this.setButtonLoading(this.elements.validateIntegrityBtn, true);

        try {
            const validation = await dataVerification.validateDataIntegrity();
            dataVerification.showDataModal('Data Integrity Validation', validation, 'validation');

            const isValid = validation.local.isValid && validation.cloud.isValid && validation.crossValidation.isValid;
            this.addLogEntry(isValid ? 'success' : 'warning', `Data integrity validation completed - Valid: ${isValid}`);
        } catch (error) {
            this.addLogEntry('error', `Failed to validate data integrity: ${error.message}`);
            alert(`Failed to validate data integrity: ${error.message}`);
        } finally {
            this.setButtonLoading(this.elements.validateIntegrityBtn, false);
        }
    }

    // Format timestamp for display
    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) {
            return 'Just now';
        } else if (diff < 3600000) {
            return `${Math.floor(diff / 60000)}m ago`;
        } else if (diff < 86400000) {
            return `${Math.floor(diff / 3600000)}h ago`;
        } else {
            return date.toLocaleDateString();
        }
    }
}

// Create and export singleton instance
export const syncSettingsController = new SyncSettingsController();