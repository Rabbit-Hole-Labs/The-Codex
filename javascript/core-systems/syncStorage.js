/**
 * chrome.storage.sync access for The Codex, with `links` split across several
 * sync items once it outgrows one.
 *
 * Chrome caps every sync item at QUOTA_BYTES_PER_ITEM (8192 bytes: the key
 * plus the value as Chromium's JSON writer serializes it). links is stored as
 * a JSON string, so each quote inside it is escaped again — about 40 links
 * with icon URLs fill one item, and every save past that was rejected.
 *
 * Stored form (sync area):
 *   links              JSON string of the links array: the whole list when it
 *                      fits one item, otherwise its first chunk
 *   links.1 … links.N  JSON strings of the following chunks, in order
 *   linksManifest      { chunks, hashes }: how many chunks are current and a
 *                      hash of each chunk's stored string
 *
 * Every write of links goes out as ONE chrome.storage.sync.set holding all
 * its chunks and the manifest (and '' over chunks a longer list left behind,
 * which frees their quota), so Chrome applies and syncs it as a unit. Readers
 * check each chunk against the manifest: a mismatch means another device's
 * save has only partly arrived (or a build without chunking replaced `links`).
 * Change listeners then wait for the rest instead of showing half a list;
 * loads take what is there (readLinks' best effort). A list never written by
 * this code has no manifest and reads exactly as before.
 *
 * Code that reads or writes `links` in chrome.storage.sync goes through
 * syncGet / syncSet / readSyncLinks; other keys pass through unchanged.
 */

import { parseStoredArray } from './storageFormat.js';
import { debugWarn } from './debug.js';

export const LINKS_KEY = 'links';
const LINKS_MANIFEST_KEY = 'linksManifest';

// More chunks than the 100 KB sync total could hold (each is filled to ~8 KB),
// so the limit that bites is always Chrome's own QUOTA_BYTES.
const MAX_LINK_CHUNKS = 16;

// Bytes kept free in each chunk, in case Chrome's accounting ever differs
// slightly from syncItemBytes.
const ITEM_SAFETY_MARGIN = 64;
const DEFAULT_QUOTA_BYTES_PER_ITEM = 8192;

const CHUNK_KEY_PATTERN = /^links\.(\d+)$/;

/** Sync key holding chunk `index` (0 is `links` itself). */
function linkChunkKey(index) {
    return index === 0 ? LINKS_KEY : `${LINKS_KEY}.${index}`;
}

const OVERFLOW_CHUNK_KEYS = Object.freeze(
    Array.from({ length: MAX_LINK_CHUNKS - 1 }, (_, i) => linkChunkKey(i + 1))
);

/** Every sync key that holds part of the links. */
const LINK_STORAGE_KEYS = Object.freeze([LINKS_KEY, ...OVERFLOW_CHUNK_KEYS, LINKS_MANIFEST_KEY]);

/** True for `links`, its chunk keys and its manifest. */
export function isLinkStorageKey(key) {
    return key === LINKS_KEY || key === LINKS_MANIFEST_KEY || CHUNK_KEY_PATTERN.test(key);
}

/** True when a chrome.storage change set touches any part of the links. */
export function linksChanged(changes) {
    return Object.keys(changes ?? {}).some(isLinkStorageKey);
}

// --- Size accounting (Chromium's SettingsStorageQuotaEnforcer) ---

function utf8Length(str) {
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length
            && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
            bytes += 4;
            i++;
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

// Bytes of a JSON.stringify() result as Chromium's JSON writer emits it: it
// also escapes `<` (1 -> 6 bytes) and U+2028/U+2029 (3 -> 6 bytes).
function chromeJsonBytes(json) {
    let extra = 0;
    for (let i = 0; i < json.length; i++) {
        const ch = json[i];
        if (ch === '<') extra += 5;
        else if (ch === ' ' || ch === ' ') extra += 3;
    }
    return utf8Length(json) + extra;
}

/** Bytes Chrome charges for one sync item: key + JSON-serialized value. */
function syncItemBytes(key, value) {
    return utf8Length(key) + chromeJsonBytes(JSON.stringify(value));
}

function perItemLimit() {
    const quota = globalThis.chrome?.storage?.sync?.QUOTA_BYTES_PER_ITEM;
    return (Number.isFinite(quota) && quota > 0 ? quota : DEFAULT_QUOTA_BYTES_PER_ITEM) - ITEM_SAFETY_MARGIN;
}

// --- Chunk hashes ---

/** FNV-1a (32-bit) of a chunk's stored string; only compared for equality. */
function hashChunk(value) {
    if (typeof value !== 'string') return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function validManifest(manifest) {
    return manifest !== null && typeof manifest === 'object'
        && Number.isInteger(manifest.chunks) && manifest.chunks >= 1 && manifest.chunks <= MAX_LINK_CHUNKS
        && Array.isArray(manifest.hashes) && manifest.hashes.length === manifest.chunks;
}

// --- Encode / decode ---

/**
 * Split a links array into chunk strings that each fit one sync item, in
 * order. Each chunk is JSON.stringify of its slice, so the chunks parse and
 * concatenate back to the list. An entry too big for an item on its own gets
 * a chunk to itself (Chrome then rejects the write, as it did before).
 */
function splitLinks(list, limit) {
    const chunks = [];
    let slice = [];
    let sliceBytes = 0;
    const startBytes = (index) => utf8Length(linkChunkKey(index)) + 4; // key + `"[` + `]"`
    for (const entry of list) {
        // Bytes this entry takes inside the stored string, which Chrome
        // escapes a second time (JSON.stringify writes undefined as null).
        const entryBytes = chromeJsonBytes(JSON.stringify(JSON.stringify(entry) ?? 'null')) - 2;
        if (slice.length > 0 && startBytes(chunks.length) + sliceBytes + 1 + entryBytes > limit) {
            chunks.push(JSON.stringify(slice));
            slice = [];
            sliceBytes = 0;
        }
        sliceBytes += entryBytes + (slice.length > 0 ? 1 : 0); // + the comma before it
        slice.push(entry);
    }
    chunks.push(JSON.stringify(slice));
    return chunks;
}

/**
 * The sync items that store `value` (a links JSON string, or an array): the
 * chunks and the manifest, to be written in one set().
 * @param {string|Array} value
 * @param {{ itemLimit?: number }} [options]
 * @returns {{ items: Object, chunkCount: number }}
 */
export function encodeLinksForSync(value, { itemLimit = perItemLimit() } = {}) {
    const whole = typeof value === 'string' ? value : JSON.stringify(value);
    const list = parseStoredArray(whole);
    // A list that fits is stored exactly as given; so is a value that isn't a
    // list (validation rejects those before they get here).
    const chunks = !list || syncItemBytes(LINKS_KEY, whole) <= itemLimit
        ? [whole]
        : splitLinks(list, itemLimit);
    if (chunks.length > MAX_LINK_CHUNKS) {
        // Worded so isQuotaBytesError() treats it like Chrome's own rejection.
        throw new Error(`QUOTA_BYTES quota exceeded: the links need ${chunks.length} sync items (at most ${MAX_LINK_CHUNKS})`);
    }
    const items = {};
    chunks.forEach((chunk, index) => { items[linkChunkKey(index)] = chunk; });
    items[LINKS_MANIFEST_KEY] = { chunks: chunks.length, hashes: chunks.map(hashChunk) };
    return { items, chunkCount: chunks.length };
}

/**
 * Reassemble the links from the stored sync items (any superset of
 * LINK_STORAGE_KEYS that was read in one get()).
 * @param {Object} raw
 * @returns {{ value: (string|Array|undefined), consistent: boolean, chunks: number }}
 *   value: the links as stored (JSON string, or a raw array from an older
 *   build), undefined when absent; consistent: false while the chunks don't
 *   match the manifest — value is then a best effort from what is there
 */
export function decodeLinksFromSync(raw) {
    const head = raw?.[LINKS_KEY];
    const manifest = raw?.[LINKS_MANIFEST_KEY];
    if (head === undefined) return { value: undefined, consistent: true, chunks: 0 };
    if (!validManifest(manifest)) return { value: head, consistent: true, chunks: 1 };

    const parts = Array.from({ length: manifest.chunks }, (_, index) => raw[linkChunkKey(index)]);
    const consistent = parts.every((part, index) => hashChunk(part) === manifest.hashes[index]);
    if (manifest.chunks === 1) return { value: head, consistent, chunks: 1 };

    const lists = parts.map(part => parseStoredArray(part)).filter(Boolean);
    return { value: JSON.stringify(lists.flat()), consistent, chunks: manifest.chunks };
}

// --- chrome.storage.sync wrappers ---

function withDecodedLinks(raw) {
    const data = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
        if (!isLinkStorageKey(key)) data[key] = value;
    }
    const { value, consistent } = decodeLinksFromSync(raw);
    if (value !== undefined) data[LINKS_KEY] = value;
    return { data, consistent };
}

/**
 * chrome.storage.sync.get with `links` reassembled from its chunks (the
 * chunk/manifest keys left out), plus whether the chunks matched their
 * manifest. Takes null, a key or an array of keys.
 * @returns {Promise<{ data: Object, consistent: boolean }>}
 */
export async function syncGetChecked(keys) {
    if (keys === null || keys === undefined) {
        return withDecodedLinks(await chrome.storage.sync.get(null));
    }
    const list = typeof keys === 'string' ? [keys] : keys;
    if (!list.includes(LINKS_KEY)) return { data: await chrome.storage.sync.get(list), consistent: true };
    return withDecodedLinks(await chrome.storage.sync.get([...new Set([...list, ...LINK_STORAGE_KEYS])]));
}

/**
 * chrome.storage.sync.get with `links` reassembled from its chunks (the
 * chunk/manifest keys left out): a best effort while a save is still
 * arriving. Takes null, a key or an array of keys.
 */
export async function syncGet(keys) {
    return (await syncGetChecked(keys)).data;
}

/**
 * The links in sync, read in one get(), and whether every chunk matches the
 * manifest. For change listeners: an inconsistent read is a save still
 * arriving, and the change that completes it fires again.
 * @returns {Promise<{ value: (string|Array|undefined), consistent: boolean }>}
 */
export async function readSyncLinks() {
    const { value, consistent } = decodeLinksFromSync(await chrome.storage.sync.get([...LINK_STORAGE_KEYS]));
    return { value, consistent };
}

/**
 * chrome.storage.sync.set that stores `links` (when present) as chunks plus
 * manifest, in the same single write as the other items.
 */
export async function syncSet(items) {
    if (!items || items[LINKS_KEY] === undefined) return chrome.storage.sync.set(items);

    const { [LINKS_KEY]: links, ...rest } = items;
    const { items: chunkItems, chunkCount } = encodeLinksForSync(links);

    // Blank chunks a longer list left behind, in this same write: they are
    // already ignored (past the manifest's count), but still use quota.
    // Blanking rather than removing keeps it one atomic write.
    const blanks = {};
    try {
        const existing = await chrome.storage.sync.get([...OVERFLOW_CHUNK_KEYS]);
        for (const [key, value] of Object.entries(existing)) {
            const index = Number(CHUNK_KEY_PATTERN.exec(key)?.[1]);
            if (index >= chunkCount && value !== '') blanks[key] = '';
        }
    } catch (error) {
        debugWarn('Could not read leftover link chunks; leaving them in place', { errorMessage: error.message });
    }

    return chrome.storage.sync.set({ ...rest, ...blanks, ...chunkItems });
}
