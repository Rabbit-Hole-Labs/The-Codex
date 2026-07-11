/**
 * Persistent icon byte-store (chrome.storage.local).
 *
 * Icons used to be re-fetched from the CDN on every new tab: an in-memory
 * cache died with the page, so tiles rendered empty, probed the network, and
 * "popped in" — or broke entirely offline. This store keeps the actual image
 * bytes locally as data: URIs so tiles render instantly from disk and keep
 * working offline. Entries revalidate in the background after a week
 * (stale-while-revalidate: the cached icon always shows immediately) and the
 * store prunes least-recently-used entries to stay within a byte budget.
 *
 * Byte-fetching only targets the pinned icon hosts already allowed by the
 * manifest CSP connect-src. Hosts that refuse cross-origin fetches (CORS)
 * simply fall back to the old probe-and-render path — network-only, but
 * never worse than before.
 */

import { debug } from '../core-systems/debug.js';

const KEY_PREFIX = 'iconV1:';
const BUDGET_BYTES = 6 * 1024 * 1024;      // of the ~10MB storage.local quota
const MAX_ENTRY_BYTES = 400 * 1024;        // data-URI length cap per icon
const REVALIDATE_AFTER = 7 * 24 * 60 * 60 * 1000;
const LAST_USED_WRITE_THROTTLE = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_N_WRITES = 25;

// Hosts we attempt to byte-fetch from (kept in lockstep with the manifest
// CSP connect-src). Everything else renders via plain <img> only.
const FETCHABLE_HOSTS = ['cdn.jsdelivr.net', 'selfh.st', 'www.google.com', 'gstatic.com'];

let writesSincePrune = 0;
const inFlightRefreshes = new Set();

/**
 * Whether a stored icon URL is eligible for local byte-caching.
 * @param {string} url
 * @returns {boolean}
 */
export function isCacheableIconUrl(url) {
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        return FETCHABLE_HOSTS.some(h => host === h || host.endsWith('.' + h));
    } catch {
        return false;
    }
}

/**
 * Picks which entries to evict (oldest lastUsed first) so the remaining
 * total size fits the budget. Pure — exported for tests.
 * @param {Array<{key: string, size: number, lastUsed: number}>} entries
 * @param {number} budget - Byte budget
 * @returns {string[]} - Keys to evict
 */
export function selectEvictions(entries, budget) {
    const sorted = [...entries].sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    let total = sorted.reduce((sum, e) => sum + (e.size || 0), 0);
    const evict = [];
    for (const entry of sorted) {
        if (total <= budget) break;
        evict.push(entry.key);
        total -= (entry.size || 0);
    }
    return evict;
}

function storageKey(url) {
    return KEY_PREFIX + url;
}

/**
 * Fetches an image and encodes it as a data: URI.
 * @param {string} url
 * @param {number} timeout - ms
 * @returns {Promise<{data: string|null, notFound: boolean}>}
 *   notFound=true means the server answered and the icon does not exist —
 *   callers can skip their probe fallback. data=null with notFound=false is
 *   an indeterminate failure (offline, CORS, CSP) — probing may still work.
 */
export async function fetchIconAsDataUri(url, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            return { data: null, notFound: response.status === 404 || response.status === 403 };
        }
        const type = (response.headers.get('content-type') || '').toLowerCase();
        if (type && !type.startsWith('image/')) {
            return { data: null, notFound: true };
        }
        const blob = await response.blob();
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
        if (!/^data:image\//i.test(data)) {
            return { data: null, notFound: true };
        }
        return { data, notFound: false };
    } catch {
        return { data: null, notFound: false };
    } finally {
        clearTimeout(timer);
    }
}

async function readEntry(url) {
    try {
        const key = storageKey(url);
        const result = await chrome.storage.local.get([key]);
        const entry = result && result[key];
        return entry && typeof entry.data === 'string' ? entry : null;
    } catch {
        return null;
    }
}

async function writeEntry(url, data) {
    const entry = {
        url,
        data,
        size: data.length,
        fetchedAt: Date.now(),
        lastUsed: Date.now()
    };
    try {
        await chrome.storage.local.set({ [storageKey(url)]: entry });
    } catch (error) {
        // Most likely quota — free space and retry once.
        debug('Icon store write failed, pruning and retrying:', error);
        await pruneIconStore();
        try {
            await chrome.storage.local.set({ [storageKey(url)]: entry });
        } catch {
            return; // give up quietly; rendering still has the in-memory data
        }
    }
    if (++writesSincePrune >= PRUNE_EVERY_N_WRITES) {
        writesSincePrune = 0;
        pruneIconStore().catch(() => {});
    }
}

/** Evicts least-recently-used entries until the store fits its byte budget. */
export async function pruneIconStore() {
    try {
        const all = await chrome.storage.local.get(null);
        const entries = Object.entries(all || {})
            .filter(([key]) => key.startsWith(KEY_PREFIX))
            .map(([key, value]) => ({
                key,
                size: (value && value.size) || 0,
                lastUsed: (value && value.lastUsed) || 0
            }));
        const evict = selectEvictions(entries, BUDGET_BYTES);
        if (evict.length) {
            await chrome.storage.local.remove(evict);
            debug(`Icon store pruned ${evict.length} entries`);
        }
    } catch (error) {
        debug('Icon store prune failed:', error);
    }
}

function refreshInBackground(url, timeout) {
    if (inFlightRefreshes.has(url)) return;
    inFlightRefreshes.add(url);
    fetchIconAsDataUri(url, timeout)
        .then(({ data }) => {
            if (data && data.length <= MAX_ENTRY_BYTES) return writeEntry(url, data);
        })
        .catch(() => {})
        .finally(() => inFlightRefreshes.delete(url));
}

function bumpLastUsed(url, entry) {
    if (Date.now() - (entry.lastUsed || 0) < LAST_USED_WRITE_THROTTLE) return;
    try {
        const write = chrome.storage.local.set({
            [storageKey(url)]: { ...entry, lastUsed: Date.now() }
        });
        if (write && typeof write.catch === 'function') write.catch(() => {});
    } catch {
        // lastUsed is best-effort bookkeeping — never let it break a render.
    }
}

/**
 * Main entry: returns the icon as a locally stored data: URI, fetching and
 * persisting it on first use.
 *
 * @param {string} url - Remote icon URL
 * @param {number} timeout - ms for any network fetch involved
 * @returns {Promise<{data: string|null, notFound: boolean}>} - data is a
 *   data: URI ready for img.src; notFound=true means the icon definitively
 *   does not exist upstream (callers can skip probe fallbacks).
 */
export async function loadStoredIcon(url, timeout = 8000) {
    if (!isCacheableIconUrl(url)) {
        return { data: null, notFound: false };
    }

    const entry = await readEntry(url);
    if (entry) {
        if (Date.now() - (entry.fetchedAt || 0) > REVALIDATE_AFTER) {
            refreshInBackground(url, timeout);
        }
        bumpLastUsed(url, entry);
        return { data: entry.data, notFound: false };
    }

    const { data, notFound } = await fetchIconAsDataUri(url, timeout);
    if (!data) {
        return { data: null, notFound };
    }
    if (data.length <= MAX_ENTRY_BYTES) {
        writeEntry(url, data).catch(() => {});
    }
    return { data, notFound: false };
}
