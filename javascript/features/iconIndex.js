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

// A webp file in the repo listing — the one format counted per icon.
const WEBP_FILE = /(?:^|\/)webp\/([^/]+)\.webp$/i;

// Directory Light/Dark field values meaning "no variant" / "variant exists"
// (anything else is the variant's own reference).
const VARIANT_OFF = new Set(['', 'no', 'false', '0']);
const VARIANT_ON = new Set(['yes', 'true', '1']);

/**
 * Picks the entry list out of a parsed index payload.
 * @param {*} payload - Parsed JSON from an index source
 * @returns {Array|null} - Entries, or null for an unknown shape
 */
function payloadEntries(payload) {
    if (Array.isArray(payload)) return payload;
    // jsDelivr data API: {files: [{name: "/webp/plex.webp", ...}, ...]}
    if (payload && Array.isArray(payload.files)) return payload.files;
    if (payload && Array.isArray(payload.icons)) return payload.icons;
    return null;
}

/**
 * Slug of a webp file path ("/webp/plex.webp" → "plex").
 * @param {string} path
 * @returns {string|null} - null when the path is not a webp icon file
 */
function webpSlug(path) {
    const file = path.match(WEBP_FILE);
    return file ? file[1] : null;
}

/**
 * Directory-style entries describe recolors as FIELDS on the icon entry
 * (e.g. Light: "Yes" or Light: "github-light"), not as separate entries —
 * surface them as their own slugs so the picker can offer them.
 * @param {Object} entry - Directory entry
 * @param {string} base - The entry's own slug
 * @param {string} field - Field name ('Light' / 'Dark'; lowercase also read)
 * @param {string} suffix - Slug suffix for a "yes" flag
 * @returns {string|null} - Variant slug, or null when the field is absent/off
 */
function variantFieldSlug(entry, base, field, suffix) {
    const value = entry[field] ?? entry[field.toLowerCase()];
    if (value == null) return null;
    const text = String(value).trim().toLowerCase();
    if (VARIANT_OFF.has(text)) return null;
    if (VARIANT_ON.has(text)) return `${base}-${suffix}`;
    return toIconSlug(text); // field carries the variant's own reference
}

/**
 * Slugs of a directory entry: its own reference plus Light/Dark variants.
 * @param {Object} entry - Directory entry (Name/Reference/slug fields)
 * @returns {Array<string|null>} - Candidate slugs, in insertion order
 */
function directoryEntrySlugs(entry) {
    const raw = entry.Reference || entry.reference || entry.slug ||
        entry.Name || entry.name;
    const slug = raw ? toIconSlug(String(raw)) : null;
    if (!slug) return [];
    return [
        slug,
        variantFieldSlug(entry, slug, 'Light', 'light'),
        variantFieldSlug(entry, slug, 'Dark', 'dark')
    ];
}

/**
 * Candidate slugs for one index entry of any shape (plain string, file
 * listing object, or directory object). Candidates are filtered by the caller.
 * @param {*} entry
 * @returns {Array<string|null>}
 */
function entrySlugs(entry) {
    if (typeof entry === 'string') {
        return [webpSlug(entry) ?? toIconSlug(entry)];
    }
    if (!entry || typeof entry !== 'object') return [];
    if (typeof entry.name === 'string' && /\.\w+$/.test(entry.name)) {
        // File listing entry — only count each icon once (webp set).
        return [webpSlug(entry.name)];
    }
    return directoryEntrySlugs(entry);
}

/**
 * Extracts icon slugs from any of the known index payload shapes.
 * Exported for tests.
 * @param {*} payload - Parsed JSON from an index source
 * @returns {string[]} - De-duplicated slugs (may be empty on unknown shape)
 */
export function parseIndexPayload(payload) {
    const entries = payloadEntries(payload);
    if (!entries) return [];

    const slugs = new Set();
    for (const entry of entries) {
        for (const slug of entrySlugs(entry)) {
            if (slug && slug.length >= 2) slugs.add(slug.toLowerCase());
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
