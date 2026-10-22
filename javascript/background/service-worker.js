/**
 * Background Service Worker - Extension lifecycle and storage management
 */
import { initErrorCapture } from '../features/errorCapture.js';
import { debug } from '../core-systems/debug.js';
import { parseStoredArray, LEGACY_COLOR_THEMES } from '../core-systems/storageFormat.js';
import { syncGet, readSyncLinks, linksChanged } from '../core-systems/syncStorage.js';
import { warmIconStore } from '../features/iconStore.js';

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
chrome.runtime.onInstalled.addListener((details) => {
    verifyStorage();
    if (details?.reason === 'update') {
        migrateLegacyColorTheme();
    }
    scheduleIconWarmUp();
});

chrome.runtime.onStartup.addListener(() => {
    verifyStorage();
    scheduleIconWarmUp();
});

// Links saved on another device (or this one) arrive here: fetch the icons
// picked for them now, so the next new tab shows them in its first paint.
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && linksChanged(changes)) scheduleIconWarmUp();
});

const ICON_WARM_UP_DELAY_MS = 2000; // one run for a burst of changes
let iconWarmUpTimer = null;

function scheduleIconWarmUp() {
    clearTimeout(iconWarmUpTimer);
    iconWarmUpTimer = setTimeout(warmPickedIcons, ICON_WARM_UP_DELAY_MS);
}

// Download the icons picked for the synced links that this device doesn't
// have yet (automatic matches are made per device, on its first new tab).
async function warmPickedIcons() {
    try {
        const { value, consistent } = await readSyncLinks();
        if (!consistent) return; // the change that completes the save schedules another run
        const links = parseStoredArray(value) ?? [];
        const fetched = await warmIconStore(links.map(link => link?.icon));
        if (fetched > 0) debug(`Fetched ${fetched} icon(s) for synced links`);
    } catch (error) {
        debug('Icon warm-up failed; icons load on the next new tab instead:', error);
    }
}

async function verifyStorage() {
    try {
        const data = await syncGet(['links', 'categories']);

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

// One-time cleanup for colorTheme values from before the accent presets
// (7.0.0.24). Loads already coerce them in memory; this rewrites the stored
// value so every surface agrees. It is a deliberate, one-time exception to
// "loads never persist": it runs only on an extension update, touches only
// that one key, and only when it holds a known legacy value — an absent or
// empty value (e.g. sync not yet downloaded) is never written.
async function migrateLegacyColorTheme() {
    try {
        const { colorTheme } = await chrome.storage.sync.get('colorTheme');
        if (typeof colorTheme === 'string' && LEGACY_COLOR_THEMES.includes(colorTheme)) {
            await chrome.storage.sync.set({ colorTheme: 'default' });
        }
    } catch (error) {
        console.error('[The Codex] colorTheme migration failed:', error);
    }
}
