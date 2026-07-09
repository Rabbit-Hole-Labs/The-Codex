// Sync Status Indicator Component
import { syncManager } from '../core-systems/syncManager.js';

export class SyncStatusIndicator {
    constructor() {
        this.container = null;
        this.statusElement = null;
        this.lastSyncElement = null;
        this.syncButton = null;
        this.isInitialized = false;
        this._abortController = null;

        // Status states
        this.states = {
            synced: { text: 'Synced', class: 'sync-success' },
            notsynced: { text: 'Not synced', class: 'sync-pending' },
            syncing: { text: 'Syncing...', class: 'sync-progress' },
            error: { text: 'Sync Error', class: 'sync-error' },
            offline: { text: 'Offline', class: 'sync-offline' },
            pending: { text: 'Changes Pending', class: 'sync-pending' }
        };
    }

    // Initialize the sync status indicator
    init(containerId = 'sync-status-container') {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.warn('Sync status container not found');
            return;
        }

        this.createIndicator();
        this.attachEventListeners();
        this.updateStatus();
        this.renderInitialLastSync();
        this.isInitialized = true;
    }

    // Populate the last-sync display from the persisted status on load, so it
    // shows the real time immediately instead of leaving the 'Never' placeholder
    // until the user clicks refresh. updateLastSyncTime() no-ops on a falsy
    // timestamp, so a genuinely never-synced profile still correctly shows 'Never'.
    async renderInitialLastSync() {
        try {
            const status = await syncManager.getSyncStatus();
            this.updateLastSyncTime(status.lastSyncTime);
            if (navigator.onLine) {
                // "Synced" means we can show real sync state: either we've
                // recorded a sync before (lastSyncTime), the versioned metadata
                // is populated, or chrome.storage.sync actually holds links right
                // now (data is present, so this profile IS in sync with the
                // cloud). Only a truly empty, never-synced profile shows "Not
                // synced". This keeps the pill consistent with the Sync panel.
                const neverSynced = !status.lastSyncTime && !status.localVersion
                    && !status.remoteVersion && !status.hasData;
                this.updateStatus(neverSynced ? 'notsynced' : 'synced');
            }
        } catch {
            /* leave the placeholder on failure */
        }
    }

    // Create the indicator UI
    createIndicator() {
        this.container.innerHTML = `
            <div class="sync-status-wrapper">
                <div class="sync-status" id="sync-status">
                    <span class="sync-icon"></span>
                    <span class="sync-text"></span>
                </div>
                <div class="sync-details" style="display: none;">
                    <div class="sync-last-time">Last sync: <span id="last-sync-time">Never</span></div>
                    <div class="sync-actions">
                        <button class="sync-btn" id="sync-now-btn" title="Sync now">
                            <svg width="16" height="16" viewBox="0 0 24 24">
                                <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                            </svg>
                        </button>
                        <button class="sync-btn" id="sync-menu-btn" title="Sync options">
                            <svg width="16" height="16" viewBox="0 0 24 24">
                                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="sync-menu" id="sync-menu" style="display: none;">
                        <button class="sync-menu-item" data-action="force-push">Force Push to Cloud</button>
                        <button class="sync-menu-item" data-action="force-pull">Force Pull from Cloud</button>
                        <button class="sync-menu-item" data-action="view-status">View Sync Status</button>
                        <hr>
                        <button class="sync-menu-item sync-menu-danger" data-action="clear-sync">Clear Sync Data</button>
                    </div>
                </div>
            </div>
        `;

        this.statusElement = this.container.querySelector('#sync-status');
        this.lastSyncElement = this.container.querySelector('#last-sync-time');
        this.syncButton = this.container.querySelector('#sync-now-btn');

        // Add styles
        this.injectStyles();
    }

    // Styles are now in stylesheets/sync-status.css (linked in HTML pages).
    // No dynamic <style> injection needed — enables removal of 'unsafe-inline' from CSP.
    injectStyles() {
        // No-op: styles loaded via external CSS file
    }

    // Attach event listeners with AbortController for lifecycle management
    attachEventListeners() {
        this._abortController?.abort();
        this._abortController = new AbortController();
        const { signal } = this._abortController;

        // Listen to sync manager events
        syncManager.addSyncListener((event, data) => {
            this.handleSyncEvent(event, data);
        });

        // Status click to toggle details
        this.statusElement.addEventListener('click', () => {
            const details = this.container.querySelector('.sync-details');
            details.style.display = details.style.display === 'none' ? 'block' : 'none';
        }, { signal });

        // Sync now button
        this.syncButton.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.handleSyncNow();
        }, { signal });

        // Menu button
        const menuBtn = this.container.querySelector('#sync-menu-btn');
        const menu = this.container.querySelector('#sync-menu');

        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }, { signal });

        // Menu items
        menu.addEventListener('click', async (e) => {
            const action = e.target.dataset.action;
            if (action) {
                await this.handleMenuAction(action);
                menu.style.display = 'none';
            }
        }, { signal });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target)) {
                menu.style.display = 'none';
                this.container.querySelector('.sync-details').style.display = 'none';
            }
        }, { signal });

        // Check online/offline status. On reconnect, re-derive the real state
        // (never-synced vs synced) rather than blindly showing "Synced".
        window.addEventListener('online', () => this.renderInitialLastSync(), { signal });
        window.addEventListener('offline', () => this.updateStatus('offline'), { signal });
    }

    /**
     * Remove all event listeners and clean up resources.
     * Call during page teardown to prevent listener leaks.
     */
    destroy() {
        this._abortController?.abort();
        this._abortController = null;
        this.isInitialized = false;
    }

    // Handle sync events
    handleSyncEvent(event, data) {
        switch (event) {
            case 'syncStart':
                this.updateStatus('syncing');
                break;
            case 'syncComplete':
                this.updateStatus('synced');
                this.updateLastSyncTime(data.time);
                break;
            case 'initialized':
                // syncManager finished its async status load after we attached
                // listeners — refresh the last-sync display from the loaded value.
                this.renderInitialLastSync();
                break;
            case 'syncError':
                this.updateStatus('error');
                this.showError(data.error);
                break;
            case 'quotaExceeded':
                this.updateStatus('error');
                this.showQuotaError(data);
                break;
        }
    }

    // Update the status display
    updateStatus(status = null) {
        if (!status) {
            // Determine current status
            if (!navigator.onLine) {
                status = 'offline';
            } else {
                // Check if there are pending changes
                status = 'synced'; // Default, would need to check actual state
            }
        }

        const state = this.states[status] || this.states.synced;
        const iconElement = this.container.querySelector('.sync-icon');
        const textElement = this.container.querySelector('.sync-text');

        iconElement.textContent = state.icon;
        textElement.textContent = state.text;
        this.statusElement.className = `sync-status ${state.class}`;
    }

    // Update last sync time
    updateLastSyncTime(timestamp) {
        if (!timestamp) return;

        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;

        let timeStr;
        if (diff < 60000) {
            timeStr = 'Just now';
        } else if (diff < 3600000) {
            timeStr = `${Math.floor(diff / 60000)} minutes ago`;
        } else if (diff < 86400000) {
            timeStr = `${Math.floor(diff / 3600000)} hours ago`;
        } else {
            timeStr = date.toLocaleDateString();
        }

        this.lastSyncElement.textContent = timeStr;
    }

    // Handle sync now action
    async handleSyncNow() {
        this.updateStatus('syncing');
        const result = await syncManager.syncData();

        if (!result.success) {
            this.showError(result.error);
        }
    }

    // Handle menu actions
    async handleMenuAction(action) {
        switch (action) {
            case 'force-push':
                if (confirm('This will overwrite cloud data with your local data. Continue?')) {
                    this.updateStatus('syncing');
                    await syncManager.forcePushToRemote();
                }
                break;

            case 'force-pull':
                if (confirm('This will overwrite local data with cloud data. Continue?')) {
                    this.updateStatus('syncing');
                    await syncManager.forcePullFromRemote();
                }
                break;

            case 'view-status':
                await this.showSyncStatus();
                break;

            case 'clear-sync':
                if (confirm('This will clear all sync data. This action cannot be undone. Continue?')) {
                    await syncManager.clearSyncData();
                    this.updateStatus('synced');
                }
                break;
        }
    }

    // Show sync status modal
    async showSyncStatus() {
        const status = await syncManager.getSyncStatus();

        const modal = document.createElement('div');
        modal.className = 'sync-status-modal';

        const quotaClass = status.quotaPercentage > 90 ? 'danger' :
                          status.quotaPercentage > 70 ? 'warning' : '';

        // A version of 0 (or falsy) means that side has never been synced;
        // don't render it as "In Sync" or as the Unix epoch (1969).
        const neverSynced = !status.localVersion && !status.remoteVersion;
        const statusText = neverSynced ? 'Not synced yet'
            : (status.isInSync ? 'In Sync' : 'Out of Sync');
        const fmtVersion = (v) => v ? new Date(v).toLocaleString() : 'Never';

        modal.innerHTML = `
            <h3>Sync Status</h3>
            <div class="sync-status-info">
                <div class="sync-status-row">
                    <span class="sync-status-label">Status:</span>
                    <span class="sync-status-value">${statusText}</span>
                </div>
                <div class="sync-status-row">
                    <span class="sync-status-label">Local Version:</span>
                    <span class="sync-status-value">${fmtVersion(status.localVersion)}</span>
                </div>
                <div class="sync-status-row">
                    <span class="sync-status-label">Cloud Version:</span>
                    <span class="sync-status-value">${fmtVersion(status.remoteVersion)}</span>
                </div>
                <div class="sync-status-row">
                    <span class="sync-status-label">Storage Used:</span>
                    <span class="sync-status-value">${(status.bytesInUse / 1024).toFixed(2)} KB / ${(status.quotaLimit / 1024).toFixed(0)} KB</span>
                </div>
                <div class="sync-quota-bar">
                    <div class="sync-quota-fill ${quotaClass}" style="width: ${status.quotaPercentage}%"></div>
                </div>
            </div>
            <button class="sync-btn sync-modal-close" style="margin-top: 16px; width: 100%;">Close</button>
        `;

        document.body.appendChild(modal);
        modal.querySelector('.sync-modal-close').addEventListener('click', function() {
            this.parentElement.remove();
        });
    }

    // Show error message
    showError(error) {
        console.error('Sync error:', error);
        // Could show a toast notification here
    }

    // Show quota error
    showQuotaError(data) {
        alert(`Sync storage quota exceeded. Using ${(data.bytesNeeded / 1024).toFixed(2)} KB but limit is ${(data.quotaLimit / 1024).toFixed(0)} KB. Some data may not sync.`);
    }
}

// Create and export singleton instance
export const syncStatusIndicator = new SyncStatusIndicator();