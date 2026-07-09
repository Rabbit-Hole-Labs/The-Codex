/**
 * Background Service Worker - Extension lifecycle and storage management
 */
import { initErrorCapture } from '../features/errorCapture.js';
import { parseStoredArray } from '../core-systems/storageFormat.js';

// Register global error capture as early as possible (service-worker context).
initErrorCapture('service-worker');

// On install, update, and startup we only VERIFY/self-heal existing storage —
// we never seed defaults into chrome.storage.sync. On a fresh install the
// account's synced data may not have downloaded yet, so a read returns empty
// even for an existing user with links in the cloud. Writing "defaults"
// (empty links/categories, a default theme) based on that empty read would,
// via sync's last-writer-wins, clobber the user's real data on every device.
// The app tolerates absent keys everywhere (loadLinks/initializeFromStorage
// fall back to in-memory defaults), so seeding is unnecessary as well as unsafe.
chrome.runtime.onInstalled.addListener(() => {
    verifyStorage();
});

chrome.runtime.onStartup.addListener(() => {
    verifyStorage();
});

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