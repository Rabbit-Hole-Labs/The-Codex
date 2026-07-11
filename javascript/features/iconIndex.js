/**
 * selfh.st icon catalog index.
 *
 * Probe-based search (iconPicker) can only confirm exact slugs — searching
 * "vmware" found nothing even though vmware-esxi, vmware-vcenter, … exist.
 * This module fetches the real catalog once, caches it in
 * chrome.storage.local, and offers ranked substring search over it. Every
 * source is a pinned host already trusted by the manifest CSP; when no source
 * is reachable the picker silently falls back to probe-only matching, so the
 * index is a pure recall upgrade, never a new failure mode.
 */

import { toIconSlug } from './iconCache.js';
import { debug } from '../core-systems/debug.js';

// v3: directory-style Light/Dark FIELDS are now parsed into variant slugs
// (v2 caches were built without them); the key bump forces a refetch.
const CACHE_KEY = 'selfhstIconIndexV3';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const FETCH_TIMEOUT = 15000;

// Candidate index sources, cheapest first. Parsing is defensive because the
// exact payload shape differs per source (and may evolve).
const INDEX_SOURCES = [
    // The selfh.st directory data used by their own icon browser.
    'https://cdn.selfh.st/directory/icons.json',
    // Repo-shipped index, if present.
    'https://cdn.jsdelivr.net/gh/selfhst/icons@main/index.json',
    // Full file listing from the jsDelivr data API (largest, most reliable).
    'https://data.jsdelivr.com/v1/packages/gh/selfhst/icons@main?structure=flat'
];

let memoryIndex = null;   // resolved slugs for this page lifetime
let loadPromise = null;   // in-flight load, shared across callers

/**
 * Normalizes a slug or query for comparison: slugified with hyphens removed,
 * so "pihole" matches "pi-hole" and "vmware esx" prefixes "vmware-esxi".
 * @param {string} value
 * @returns {string}
 */
export function normalizeForMatch(value) {
    return toIconSlug(value).replace(/-/g, '');
}

/**
 * Extracts icon slugs from any of the known index payload shapes.
 * Exported for tests.
 * @param {*} payload - Parsed JSON from an index source
 * @returns {string[]} - De-duplicated slugs (may be empty on unknown shape)
 */
export function parseIndexPayload(payload) {
    let entries = null;
    if (Array.isArray(payload)) {
        entries = payload;
    } else if (payload && Array.isArray(payload.files)) {
        // jsDelivr data API: {files: [{name: "/webp/plex.webp", ...}, ...]}
        entries = payload.files;
    } else if (payload && Array.isArray(payload.icons)) {
        entries = payload.icons;
    }
    if (!entries) return [];

    const slugs = new Set();
    const add = (slug) => {
        if (slug && slug.length >= 2) slugs.add(slug.toLowerCase());
    };

    // Directory-style entries describe recolors as FIELDS on the icon entry
    // (e.g. Light: "Yes" or Light: "github-light"), not as separate entries —
    // surface them as their own slugs so the picker can offer them.
    const addVariantField = (entry, base, field, suffix) => {
        const value = entry[field] ?? entry[field.toLowerCase()];
        if (value == null) return;
        const text = String(value).trim().toLowerCase();
        if (!text || text === 'no' || text === 'false' || text === '0') return;
        if (text === 'yes' || text === 'true' || text === '1') {
            add(`${base}-${suffix}`);
        } else {
            add(toIconSlug(text)); // field carries the variant's own reference
        }
    };

    for (const entry of entries) {
        if (typeof entry === 'string') {
            const file = entry.match(/(?:^|\/)webp\/([^/]+)\.webp$/i);
            add(file ? file[1] : toIconSlug(entry));
        } else if (entry && typeof entry === 'object') {
            if (typeof entry.name === 'string' && /\.\w+$/.test(entry.name)) {
                // File listing entry — only count each icon once (webp set).
                const file = entry.name.match(/(?:^|\/)webp\/([^/]+)\.webp$/i);
                add(file ? file[1] : null);
            } else {
                const raw = entry.Reference || entry.reference || entry.slug ||
                    entry.Name || entry.name;
                const slug = raw ? toIconSlug(String(raw)) : null;
                if (slug) {
                    add(slug);
                    addVariantField(entry, slug, 'Light', 'light');
                    addVariantField(entry, slug, 'Dark', 'dark');
                }
            }
        }
    }

    // Recolor slugs are kept: they are ordinary, explicitly selectable
    // choices in the picker (never auto-applied).
    return Array.from(slugs);
}

/**
 * Ranked substring search over the catalog.
 * Exported for tests (pure).
 * @param {string} query - Raw search text
 * @param {string[]} slugs - Catalog slugs
 * @param {Object} [options]
 * @param {number} [options.limit=24] - Max results
 * @param {string[]} [options.aliases] - Extra exact-match slugs (nicknames)
 * @returns {string[]} - Matching slugs, best first
 */
export function searchIndex(query, slugs, options = {}) {
    const { limit = 24, aliases = [] } = options;
    const q = normalizeForMatch(query);
    if (!q || q.length < 2 || !Array.isArray(slugs)) return [];

    const aliasSet = new Set(aliases);
    const scored = [];
    for (const slug of slugs) {
        const s = normalizeForMatch(slug);
        let score;
        if (s === q || aliasSet.has(slug)) score = 0;
        else if (s.startsWith(q)) score = 1;
        else if (s.includes(q)) score = 2;
        else continue;
        scored.push({ slug, score });
    }
    scored.sort((a, b) =>
        a.score - b.score ||
        a.slug.length - b.slug.length ||
        a.slug.localeCompare(b.slug));
    return scored.slice(0, limit).map(item => item.slug);
}

async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function readCache() {
    try {
        const data = await chrome.storage.local.get([CACHE_KEY]);
        const cached = data && data[CACHE_KEY];
        if (cached && Array.isArray(cached.slugs) && cached.slugs.length) {
            return cached;
        }
    } catch (error) {
        debug('Icon index cache read failed:', error);
    }
    return null;
}

async function writeCache(slugs) {
    try {
        await chrome.storage.local.set({
            [CACHE_KEY]: { slugs, fetchedAt: Date.now() }
        });
    } catch (error) {
        debug('Icon index cache write failed:', error);
    }
}

async function fetchIndex() {
    for (const url of INDEX_SOURCES) {
        const payload = await fetchWithTimeout(url);
        if (!payload) continue;
        const slugs = parseIndexPayload(payload);
        if (slugs.length >= 100) { // sanity: the real catalog has thousands
            debug(`Icon index loaded from ${url}: ${slugs.length} icons`);
            return slugs;
        }
    }
    return null;
}

/**
 * Returns the catalog slugs, or null when no source is reachable (the picker
 * then falls back to probe-only matching). Cached in chrome.storage.local
 * for a week; a stale cache is still used when every source fails.
 * @returns {Promise<string[]|null>}
 */
export async function getIconIndex() {
    if (memoryIndex) return memoryIndex;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        const cached = await readCache();
        if (cached && Date.now() - (cached.fetchedAt || 0) < CACHE_TTL) {
            memoryIndex = cached.slugs;
            return memoryIndex;
        }

        const fetched = await fetchIndex();
        if (fetched) {
            memoryIndex = fetched;
            await writeCache(fetched);
            return memoryIndex;
        }

        if (cached) { // stale beats nothing
            memoryIndex = cached.slugs;
            return memoryIndex;
        }
        return null;
    })().finally(() => { loadPromise = null; });

    return loadPromise;
}
