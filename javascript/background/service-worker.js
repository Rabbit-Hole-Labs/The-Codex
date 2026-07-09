/**
 * Background Service Worker - Extension lifecycle and storage management
 */
import { initErrorCapture } from '../features/errorCapture.js';
import { parseStoredArray } from '../core-systems/storageFormat.js';

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

        // Store defaults in the same JSON-encoded form the app uses elsewhere
        // (saveLinks / saveCategories), so the stored format stays uniform.
        if (!linksData.links) {
            await chrome.storage.sync.set({ links: JSON.stringify([]) });
        }

        if (!linksData.categories) {
            await chrome.storage.sync.set({ categories: JSON.stringify(['Default']) });
        }
    } catch (error) {
        console.error('[The Codex] Failed to initialize defaults:', error);
    }
}

async function verifyStorage() {
    try {
        const data = await chrome.storage.sync.get(['links', 'categories']);

        // links/categories are stored JSON-encoded, so a string that parses to
        // an array is healthy — only warn on genuine corruption (e.g. an object,
        // or a string that doesn't decode to an array).
        if (data.links !== undefined && parseStoredArray(data.links) === null) {
            console.warn('[The Codex] Storage corruption: links is not a valid array');
        }

        const categories = parseStoredArray(data.categories);
        if (data.categories !== undefined && categories === null) {
            console.warn('[The Codex] Storage corruption: categories is not a valid array');
        }

        // Self-heal a missing Default category, preserving the stored encoding.
        if (categories && !categories.includes('Default')) {
            const healed = ['Default', ...categories];
            const encoded = typeof data.categories === 'string' ? JSON.stringify(healed) : healed;
            await chrome.storage.sync.set({ categories: encoded });
        }
    } catch (error) {
        console.error('[The Codex] Storage verification failed:', error);
    }
}