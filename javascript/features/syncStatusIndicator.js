// Sync Status Indicator Component
import { syncManager } from '../core-systems/syncManager.js';

export class SyncStatusIndicator {
    constructor() {
        this.container = null;
        this.statusElement = null;
        this.lastSyncElement = null;
        this.syncButton = null;
        this.isInitialized = false;

        // Status states
        this.states = {
            synced: { icon: '✓', text: 'Synced', class: 'sync-success' },
            syncing: { icon: '↻', text: 'Syncing...', class: 'sync-progress' },
            error: { icon: '!', text: 'Sync Error', class: 'sync-error' },
            offline: { icon: '◌', text: 'Offline', class: 'sync-offline' },
            pending: { icon: '•', text: 'Changes Pending', class: 'sync-pending' }
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
        this.isInitialized = true;
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

    // Inject CSS styles
    injectStyles() {
        if (document.getElementById('sync-status-styles')) return;

        const styles = `
            <style id="sync-status-styles">
                .sync-status-wrapper {
                    position: relative;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                }

                .sync-status {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 6px 12px;
                    border-radius: 20px;
                    background: rgba(255, 255, 255, 0.1);
                    cursor: pointer;
                    transition: all 0.3s ease;
                    font-size: 14px;
                }

                .sync-status:hover {
                    background: rgba(255, 255, 255, 0.15);
                }

                .sync-icon {
                    font-size: 16px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                }

                .sync-success .sync-icon { color: #4caf50; }
                .sync-progress .sync-icon {
                    color: #2196f3;
                    animation: spin 1s linear infinite;
                }
                .sync-error .sync-icon { color: #f44336; }
                .sync-offline .sync-icon { color: #9e9e9e; }
                .sync-pending .sync-icon { color: #ff9800; }

                @keyframes spin {
                    100% { transform: rotate(360deg); }
                }

                .sync-details {
                    position: absolute;
                    top: 100%;
                    right: 0;
                    margin-top: 8px;
                    padding: 16px;
                    background: var(--bg-secondary, #1e1e1e);
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                    min-width: 200px;
                    z-index: 1000;
                }

                .sync-last-time {
                    font-size: 12px;
                    color: var(--text-secondary, #aaa);
                    margin-bottom: 12px;
                }

                .sync-actions {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 8px;
                }

                .sync-btn {
                    background: transparent;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    padding: 4px 8px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .sync-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                    border-color: rgba(255, 255, 255, 0.3);
                }

                .sync-btn svg {
                    fill: currentColor;
                }

                .sync-menu {
                    margin-top: 8px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    padding-top: 8px;
                }

                .sync-menu-item {
                    display: block;
                    width: 100%;
                    padding: 8px 12px;
                    background: transparent;
                    border: none;
                    text-align: left;
                    cursor: pointer;
                    transition: background 0.2s ease;
                    font-size: 14px;
                    color: var(--text-primary, #fff);
                }

                .sync-menu-item:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .sync-menu-danger {
                    color: #f44336;
                }

                .sync-menu hr {
                    margin: 8px 0;
                    border: none;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                }

                .sync-status-modal {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: var(--bg-primary, #121212);
                    padding: 24px;
                    border-radius: 8px;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
                    max-width: 400px;
                    z-index: 10000;
                }

                .sync-status-modal h3 {
                    margin-top: 0;
                    margin-bottom: 16px;
                }

                .sync-status-info {
                    display: grid;
                    gap: 12px;
                }

                .sync-status-row {
                    display: flex;
                    justify-content: space-between;
                    font-size: 14px;
                }

                .sync-status-label {
                    color: var(--text-secondary, #aaa);
                }

                .sync-status-value {
                    font-weight: 500;
                }

                .sync-quota-bar {
                    width: 100%;
                    height: 8px;
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                    overflow: hidden;
                    margin-top: 4px;
                }

                .sync-quota-fill {
                    height: 100%;
                    background: #2196f3;
                    transition: width 0.3s ease;
                }

                .sync-quota-fill.warning {
                    background: #ff9800;
                }

                .sync-quota-fill.danger {
                    background: #f44336;
                }
            </style>
        `;

        document.head.insertAdjacentHTML('beforeend', styles);
    }

    // Attach event listeners
    attachEventListeners() {
        // Listen to sync manager events
        syncManager.addSyncListener((event, data) => {
            this.handleSyncEvent(event, data);
        });

        // Status click to toggle details
        this.statusElement.addEventListener('click', () => {
            const details = this.container.querySelector('.sync-details');
            details.style.display = details.style.display === 'none' ? 'block' : 'none';
        });

        // Sync now button
        this.syncButton.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.handleSyncNow();
        });

        // Menu button
        const menuBtn = this.container.querySelector('#sync-menu-btn');
        const menu = this.container.querySelector('#sync-menu');

        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });

        // Menu items
        menu.addEventListener('click', async (e) => {
            const action = e.target.dataset.action;
            if (action) {
                await this.handleMenuAction(action);
                menu.style.display = 'none';
            }
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target)) {
                menu.style.display = 'none';
                this.container.querySelector('.sync-details').style.display = 'none';
            }
        });

        // Check online/offline status
        window.addEventListener('online', () => this.updateStatus());
        window.addEventListener('offline', () => this.updateStatus('offline'));
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

        modal.innerHTML = `
            <h3>Sync Status</h3>
            <div class="sync-status-info">
                <div class="sync-status-row">
                    <span class="sync-status-label">Status:</span>
                    <span class="sync-status-value">${status.isInSync ? 'In Sync' : 'Out of Sync'}</span>
                </div>
                <div class="sync-status-row">
                    <span class="sync-status-label">Local Version:</span>
                    <span class="sync-status-value">${new Date(status.localVersion).toLocaleString()}</span>
                </div>
                <div class="sync-status-row">
                    <span class="sync-status-label">Cloud Version:</span>
                    <span class="sync-status-value">${new Date(status.remoteVersion).toLocaleString()}</span>
                </div>
                <div class="sync-status-row">
                    <span class="sync-status-label">Storage Used:</span>
                    <span class="sync-status-value">${(status.bytesInUse / 1024).toFixed(2)} KB / ${(status.quotaLimit / 1024).toFixed(0)} KB</span>
                </div>
                <div class="sync-quota-bar">
                    <div class="sync-quota-fill ${quotaClass}" style="width: ${status.quotaPercentage}%"></div>
                </div>
            </div>
            <button class="sync-btn" style="margin-top: 16px; width: 100%;" onclick="this.parentElement.remove()">Close</button>
        `;

        document.body.appendChild(modal);
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