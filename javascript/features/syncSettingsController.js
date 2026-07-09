// Sync Settings Page Controller
import { syncManager } from '../core-systems/syncManager.js';
import { dataVerification } from './dataVerification.js';
import { getCapturedErrors, clearCapturedErrors, formatCapturedErrors } from './errorCapture.js';

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
        this.updateErrorDisplay();
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

            // Captured errors
            errorLog: document.getElementById('error-log'),
            refreshErrorsBtn: document.getElementById('refresh-errors-btn'),
            copyErrorsBtn: document.getElementById('copy-errors-btn'),
            clearErrorsBtn: document.getElementById('clear-errors-btn'),

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

        // Captured errors panel
        this.elements.refreshErrorsBtn?.addEventListener('click', () => this.updateErrorDisplay());
        this.elements.copyErrorsBtn?.addEventListener('click', () => this.handleCopyErrors());
        this.elements.clearErrorsBtn?.addEventListener('click', () => this.handleClearErrors());

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

            // Update status info. A version of 0/falsy on both sides means no
            // sync has ever been recorded — don't render that as a green
            // "In Sync" (matches the newtab indicator's neverSynced treatment).
            if (this.elements.currentStatus) {
                const neverSynced = !status.localVersion && !status.remoteVersion;
                if (neverSynced) {
                    this.elements.currentStatus.textContent = 'Not synced yet';
                    this.elements.currentStatus.style.color = '#ff9800';
                } else {
                    this.elements.currentStatus.textContent = status.isInSync ? 'In Sync' : 'Out of Sync';
                    this.elements.currentStatus.style.color = status.isInSync ? '#4caf50' : '#ff9800';
                }
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
                capturedErrors: await getCapturedErrors(), // Runtime errors / CSP violations
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

    // Render the captured runtime errors into the panel (safe DOM construction —
    // messages/URLs are attacker-influenceable, so never use innerHTML here).
    async updateErrorDisplay() {
        const container = this.elements.errorLog;
        if (!container) return;

        let list = [];
        try {
            list = await getCapturedErrors();
        } catch {
            /* leave list empty on read failure */
        }

        container.textContent = '';

        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'error-log-empty';
            empty.textContent = 'No errors captured. 🎉';
            container.appendChild(empty);
            if (this.elements.copyErrorsBtn) this.elements.copyErrorsBtn.disabled = true;
            if (this.elements.clearErrorsBtn) this.elements.clearErrorsBtn.disabled = true;
            return;
        }

        if (this.elements.copyErrorsBtn) this.elements.copyErrorsBtn.disabled = false;
        if (this.elements.clearErrorsBtn) this.elements.clearErrorsBtn.disabled = false;

        const fragment = document.createDocumentFragment();
        list
            .slice()
            .sort((a, b) => (b.lastTs || b.ts || 0) - (a.lastTs || a.ts || 0)) // newest first
            .forEach(entry => fragment.appendChild(this.buildErrorRow(entry)));
        container.appendChild(fragment);
    }

    // Build one error row element.
    buildErrorRow(entry) {
        const row = document.createElement('div');
        const kind = String(entry.type || 'error');
        row.className = 'error-log-entry';
        row.dataset.type = kind;

        const head = document.createElement('div');
        head.className = 'error-log-head';

        const time = document.createElement('span');
        time.className = 'error-log-time';
        time.textContent = this.formatTime(entry.lastTs || entry.ts || 0);

        const context = document.createElement('span');
        context.className = 'error-log-badge';
        context.textContent = entry.context || 'unknown';

        const type = document.createElement('span');
        type.className = 'error-log-type';
        type.textContent = kind;

        head.appendChild(time);
        head.appendChild(context);
        head.appendChild(type);

        if (entry.count > 1) {
            const count = document.createElement('span');
            count.className = 'error-log-count';
            count.textContent = `×${entry.count}`;
            head.appendChild(count);
        }

        const message = document.createElement('div');
        message.className = 'error-log-message';
        message.textContent = entry.message || '';

        row.appendChild(head);
        row.appendChild(message);

        if (entry.source) {
            const source = document.createElement('div');
            source.className = 'error-log-source';
            source.textContent = entry.source;
            row.appendChild(source);
        }

        return row;
    }

    // Copy the full captured log to the clipboard in the same paste-friendly
    // format as CodexConsole.errors().
    async handleCopyErrors() {
        try {
            const text = formatCapturedErrors(await getCapturedErrors());
            const ok = await this.copyToClipboard(text);
            this.addLogEntry(ok ? 'success' : 'error',
                ok ? 'Captured errors copied to clipboard' : 'Could not copy errors to clipboard');
        } catch (error) {
            this.addLogEntry('error', `Failed to copy errors: ${error.message}`);
        }
    }

    // Clear the captured error log (routed through the owner) and refresh the panel.
    async handleClearErrors() {
        try {
            await clearCapturedErrors();
            await this.updateErrorDisplay();
            this.addLogEntry('info', 'Captured error log cleared');
        } catch (error) {
            this.addLogEntry('error', `Failed to clear errors: ${error.message}`);
        }
    }

    // Clipboard helper: prefer the async Clipboard API, fall back to execCommand.
    async copyToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                /* fall through to the legacy path */
            }
        }
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            return ok;
        } catch {
            return false;
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

    // Update log display (safe DOM construction — no innerHTML with dynamic content)
    updateLogDisplay() {
        if (!this.elements.syncLog) return;

        const fragment = document.createDocumentFragment();
        this.syncLog
            .slice(-20)
            .reverse()
            .forEach(entry => {
                const div = document.createElement('div');
                div.className = `log-entry ${entry.type}`;
                const timeSpan = document.createElement('span');
                timeSpan.className = 'log-time';
                timeSpan.textContent = this.formatTime(entry.timestamp);
                const msgSpan = document.createElement('span');
                msgSpan.className = 'log-message';
                msgSpan.textContent = entry.message;
                div.appendChild(timeSpan);
                div.appendChild(msgSpan);
                fragment.appendChild(div);
            });

        this.elements.syncLog.textContent = '';
        this.elements.syncLog.appendChild(fragment);
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