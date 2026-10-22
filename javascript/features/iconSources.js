/**
 * Remembered icon sources and the new tab's first-paint lookup.
 *
 * Which source each automatically matched icon came from — a selfh.st URL,
 * the Google favicon URL, or generated initials — is kept in
 * chrome.storage.local, so the next new tab can paint it at once instead of
 * probing candidates over the network again. resolveCachedIcons() combines
 * that with the icon byte-store into what the first paint can show without
 * the network. iconCache.js records the matches and supplies its in-memory
 * cache and initials generator, so this module doesn't depend on it.
 */

import { debug } from '../core-systems/debug.js';
import { withStorageLock } from '../core-systems/storageLock.js';
import { loadStoredIcon, readStoredIcons } from './iconStore.js';
import { validateDataUrl } from './iconPolicy.js';

const ICON_SOURCES_KEY = 'iconSourcesV1';
export const GENERATED_SOURCE = 'generated';
const SOURCE_FRESH_FOR = 7 * 24 * 60 * 60 * 1000;      // then re-matched in the background
const GENERATED_FRESH_FOR = 24 * 60 * 60 * 1000;       // initials (e.g. matched offline): retried daily
const SOURCE_FORGET_AFTER = 60 * 24 * 60 * 60 * 1000;  // links not seen for two months
const GOOGLE_FAVICON_PREFIX = 'https://www.google.com/s2/favicons?';
const FLUSH_DELAY_MS = 500;
// Every new tab merges into the one stored map: its read-modify-write runs
// under this lock, so two tabs flushing at once can't drop each other's
// matches (or slip initials past the guard below).
const SOURCES_LOCK = 'codex-icon-sources';

let pendingSources = null;
let sourcesFlushTimer = null;

/**
 * Key a link's remembered source (and its in-memory cache entry) by url,
 * name and icon, so a renamed or re-pointed link is matched afresh. No icon
 * ('', null) and 'default' are the same: the new tab loads 'default' as null.
 * JSON keeps the parts apart (a ':' in a name can't pass for a port).
 * @param {Object} link
 * @returns {string}
 */
export function iconCacheKey(link) {
    const icon = link.icon && link.icon !== 'default' ? link.icon : '';
    return JSON.stringify([link.url ?? '', link.name ?? '', icon]);
}

/**
 * Remember which source an automatically matched icon came from. Written in
 * one batch shortly after, so a page of tiles is a single storage write.
 * @param {Object} link
 * @param {string} src - Icon URL, or GENERATED_SOURCE
 */
export function rememberIconSource(link, src) {
    pendingSources = { ...pendingSources, [iconCacheKey(link)]: { src, at: Date.now() } };
    if (!sourcesFlushTimer) sourcesFlushTimer = setTimeout(flushIconSources, FLUSH_DELAY_MS);
}

/**
 * Merge the pending sources into storage, dropping links not seen for two
 * months. A re-match that only got as far as initials (e.g. offline) keeps
 * the logo found before.
 * @returns {Promise<void>}
 */
async function flushIconSources() {
    sourcesFlushTimer = null;
    const updates = pendingSources;
    pendingSources = null;
    if (!updates) return;
    try {
        await withStorageLock(SOURCES_LOCK, async () => {
            const { [ICON_SOURCES_KEY]: stored } = await chrome.storage.local.get(ICON_SOURCES_KEY);
            const now = Date.now();
            const sources = {};
            for (const [key, value] of Object.entries(stored ?? {})) {
                if (now - (value?.at ?? 0) < SOURCE_FORGET_AFTER) sources[key] = value;
            }
            for (const [key, value] of Object.entries(updates)) {
                const previous = sources[key];
                if (value.src === GENERATED_SOURCE && previous && previous.src !== GENERATED_SOURCE) continue;
                sources[key] = value;
            }
            await chrome.storage.local.set({ [ICON_SOURCES_KEY]: sources });
        });
    } catch (error) {
        debug('Could not remember icon sources:', error);
    }
}

/**
 * The icons this device can show in the new tab's first paint, without the
 * network: custom icons and remembered selfh.st matches whose bytes are
 * stored, remembered Google favicons (served from the browser's HTTP cache)
 * and generated initials. Icons not listed load after the first paint.
 * @param {Object[]} links
 * @param {Object} helpers - from iconCache.js
 * @param {(link: Object) => (string|null)} helpers.inMemory - this page's
 *   already-resolved icon for a link, if any
 * @param {(link: Object) => (string|null)} helpers.initialsFor - generated
 *   initials icon (data: URI)
 * @returns {Promise<Map<Object, {src: string, fresh: boolean, storedUrl: string|null, network: boolean}>>}
 *   per link object: src for img.src; fresh = no need to match it again;
 *   storedUrl = the byte-store entry it came from (its bytes revalidate);
 *   network = src is a network URL that may still fail to load
 */
export async function resolveCachedIcons(links, { inMemory, initialsFor }) {
    const result = new Map();
    const misses = [];
    for (const link of links ?? []) {
        if (!link) continue;
        const src = inMemory(link);
        // Anything but a data: URI (e.g. a favicon this page resolved) can
        // still fail to load on a re-render.
        if (src) result.set(link, { src, fresh: true, storedUrl: null, network: !/^data:/i.test(src) });
        else misses.push(link);
    }
    if (misses.length === 0) return result;

    let sources = {};
    try {
        ({ [ICON_SOURCES_KEY]: sources = {} } = await chrome.storage.local.get(ICON_SOURCES_KEY));
    } catch {
        // Nothing remembered: custom icons can still come from the byte store.
    }
    const now = Date.now();
    const fromStore = new Map(); // link -> { url, fresh }
    for (const link of misses) {
        const custom = String(link.icon ?? '').trim();
        if (custom && custom !== 'default') {
            if (/^data:/i.test(custom)) {
                if (validateDataUrl(custom)) result.set(link, { src: custom, fresh: true, storedUrl: null, network: false });
            } else {
                fromStore.set(link, { url: custom, fresh: true });
            }
            continue;
        }
        const remembered = sources?.[iconCacheKey(link)];
        if (typeof remembered?.src !== 'string') continue;
        const freshFor = remembered.src === GENERATED_SOURCE ? GENERATED_FRESH_FOR : SOURCE_FRESH_FOR;
        const fresh = now - (remembered.at ?? 0) < freshFor;
        if (remembered.src === GENERATED_SOURCE) {
            const generated = initialsFor(link);
            if (generated) result.set(link, { src: generated, fresh, storedUrl: null, network: false });
        } else if (remembered.src.startsWith(GOOGLE_FAVICON_PREFIX)) {
            result.set(link, { src: remembered.src, fresh, storedUrl: null, network: true });
        } else {
            fromStore.set(link, { url: remembered.src, fresh });
        }
    }

    // readStoredIcons only reads the pinned icon hosts, as loadCustomIcon allows.
    const stored = await readStoredIcons([...fromStore.values()].map(entry => entry.url));
    for (const [link, { url, fresh }] of fromStore) {
        const data = stored.get(url);
        if (data) result.set(link, { src: data, fresh, storedUrl: url, network: false });
    }
    return result;
}

/**
 * Background upkeep for an icon the first paint took from this device:
 * revalidates its stored bytes (weekly) and keeps it in the store's LRU.
 * @param {{storedUrl: string|null}} cached - from resolveCachedIcons
 * @param {number} [timeout] - ms for a revalidation fetch
 * @returns {Promise<void>}
 */
export async function refreshCachedIcon(cached, timeout) {
    if (cached?.storedUrl) await loadStoredIcon(cached.storedUrl, timeout);
}
