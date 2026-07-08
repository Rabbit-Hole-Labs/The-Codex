/**
 * Background Service Worker - Extension lifecycle and storage management
 */
import { initErrorCapture } from '../features/errorCapture.js';

// Register global error capture as early as possible (service-worker context).
initErrorCapture('service-worker');

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        initializeDefaults();
    } else if (details.reason === 'update') {
        verifyStorage();
    }
});

chrome.runtime.onStartup.addListener(() => {
    verifyStorage();
});

async function initializeDefaults() {
    try {
        const existing = await chrome.storage.sync.get(['theme', 'colorTheme', 'view', 'defaultTileSize']);
        
        const defaults = {};
        if (!existing.theme) defaults.theme = 'dark';
        if (!existing.colorTheme) defaults.colorTheme = 'default';
        if (!existing.view) defaults.view = 'grid';
        if (!existing.defaultTileSize) defaults.defaultTileSize = 'medium';
        
        if (Object.keys(defaults).length > 0) {
            await chrome.storage.sync.set(defaults);
        }
        
        const linksData = await chrome.storage.sync.get(['links', 'categories']);
        
        if (!linksData.links) {
            await chrome.storage.sync.set({ links: [] });
        }
        
        if (!linksData.categories) {
            await chrome.storage.sync.set({ categories: ['Default'] });
        }
    } catch (error) {
        console.error('[The Codex] Failed to initialize defaults:', error);
    }
}

async function verifyStorage() {
    try {
        const data = await chrome.storage.sync.get(['links', 'categories']);
        
        if (data.links && !Array.isArray(data.links)) {
            console.warn('[The Codex] Storage corruption: links is not an array');
        }
        
        if (data.categories && !Array.isArray(data.categories)) {
            console.warn('[The Codex] Storage corruption: categories is not an array');
        }
        
        if (data.categories && Array.isArray(data.categories) && !data.categories.includes('Default')) {
            await chrome.storage.sync.set({ categories: ['Default', ...data.categories] });
        }
    } catch (error) {
        console.error('[The Codex] Storage verification failed:', error);
    }
}