/**
 * Quota-faithful in-memory fake of `chrome.storage` for Jest tests.
 *
 * Models the parts of Chrome's behavior that decide whether The Codex keeps or
 * loses data, so tests exercise real failure modes instead of mocks that accept
 * every write:
 *
 * - Two areas, `sync` and `local`, each with get / set / remove / clear /
 *   getBytesInUse in both promise and callback form (callback failures set
 *   `chrome.runtime.lastError` for the duration of the callback).
 * - Values are stored serialized, so reads return copies and `undefined`
 *   values are skipped on write. Missing keys are omitted from `get` results.
 * - `chrome.storage.sync` quotas, enforced like Chromium's
 *   SettingsStorageQuotaEnforcer:
 *     QUOTA_BYTES_PER_ITEM (8192): key bytes + bytes of the value as
 *       Chromium's JSON writer serializes it — UTF-8 JSON.stringify output,
 *       except `<` becomes `\u003C` and U+2028/U+2029 become `\u2028`/`\u2029`.
 *       Links/categories are stored as JSON *strings*, so every quote inside
 *       them is escaped again and counts double.
 *     QUOTA_BYTES (102400) total, MAX_ITEMS (512),
 *     MAX_WRITE_OPERATIONS_PER_MINUTE (120), MAX_WRITE_OPERATIONS_PER_HOUR (1800).
 *   `local` only has its total QUOTA_BYTES (10 MB, no unlimitedStorage); the
 *   write-rate limits apply to `sync` only, as in Chrome.
 * - A write is all-or-nothing: if any item breaks a quota, nothing is stored.
 *   Checks run in Chromium's order: per item, then total, then item count.
 *   Every set/remove/clear call on `sync` consumes a write operation (even one
 *   later rejected for size), as Chrome charges the call itself. The rate
 *   window is a simple sliding 60 s / 1 h window — pass `now` to control it.
 * - Rejections use current Chrome's messages (Chrome 137+, Chromium
 *   58ce9efef436): "Resource::kQuotaBytesPerItem quota exceeded",
 *   "Resource::kQuotaBytes quota exceeded", "Resource::kMaxItems quota
 *   exceeded", and "This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE
 *   quota." (or _PER_HOUR). Older Chrome said "QUOTA_BYTES_PER_ITEM quota
 *   exceeded" etc.; match both if code inspects the message.
 * - `chrome.storage.onChanged` (changes, areaName) and the per-area
 *   `onChanged` (changes) fire only for keys whose stored value actually
 *   changed, after the write is applied and before its promise resolves.
 *
 * Usage:
 *   const fake = installChromeStorageFake();   // sets globalThis.chrome
 *   fake.seed('local', { links: '[...]' });    // bypasses quotas and events
 *   await chrome.storage.sync.set({ ... });
 *   fake.dump('sync');                         // plain-object snapshot
 */

export const SYNC_QUOTAS = Object.freeze({
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800
});

const LOCAL_QUOTAS = Object.freeze({
    QUOTA_BYTES: 10485760
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** UTF-8 byte length of a string (lone surrogates count as U+FFFD, 3 bytes). */
// fallow-ignore-next-line code-duplication -- re-derives Chrome's quota byte math independently of syncStorage.js on purpose, so the fake can catch bugs there.
export function utf8ByteLength(str) {
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

/**
 * Byte length of a JSON.stringify() result as Chromium's JSON writer would
 * emit it: it additionally escapes `<` (1 → 6 bytes) and U+2028/U+2029
 * (3 → 6 bytes), which only ever occur inside strings.
 */
function chromeJsonByteLength(json) {
    let extra = 0;
    for (const ch of json) {
        if (ch === '<') extra += 5;
        else if (ch === '\u2028' || ch === '\u2029') extra += 3;
    }
    return utf8ByteLength(json) + extra;
}

/** Bytes Chrome charges for one stored item: key + JSON-serialized value. */
export function itemBytes(key, value) {
    return utf8ByteLength(key) + chromeJsonByteLength(JSON.stringify(value));
}

const QUOTA_MESSAGES = Object.freeze({
    QUOTA_BYTES: 'Resource::kQuotaBytes quota exceeded',
    QUOTA_BYTES_PER_ITEM: 'Resource::kQuotaBytesPerItem quota exceeded',
    MAX_ITEMS: 'Resource::kMaxItems quota exceeded',
    MAX_WRITE_OPERATIONS_PER_MINUTE: 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.',
    MAX_WRITE_OPERATIONS_PER_HOUR: 'This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.'
});

function quotaError(name) {
    return new Error(QUOTA_MESSAGES[name]);
}

function createEvent() {
    const listeners = new Set();
    return {
        api: {
            addListener: (fn) => { listeners.add(fn); },
            removeListener: (fn) => { listeners.delete(fn); },
            hasListener: (fn) => listeners.has(fn),
            hasListeners: () => listeners.size > 0
        },
        dispatch(...args) {
            for (const fn of [...listeners]) {
                try {
                    fn(...args);
                } catch (error) {
                    // Chrome isolates listeners: one throwing doesn't stop the rest.
                    console.error('chrome.storage.onChanged listener threw:', error);
                }
            }
        }
    };
}

// Wrap an implementation so it supports Chrome's two calling conventions:
// a trailing callback (returns undefined, errors via runtime.lastError) or a
// returned promise. The implementation runs asynchronously, like Chrome's.
function chromeMethod(impl, runtime) {
    return (...args) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const promise = Promise.resolve().then(() => impl(...args));
        if (!callback) return promise;
        promise.then(
            (result) => callback(result),
            (error) => {
                runtime.lastError = { message: error.message };
                try {
                    callback();
                } finally {
                    runtime.lastError = undefined;
                }
            }
        );
        return undefined;
    };
}

function normalizeKeyList(keys) {
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    throw new TypeError('keys must be a string or an array of strings');
}

function createArea(areaName, quotas, { now, runtime, emit }) {
    const items = new Map(); // key -> serialized JSON (what Chrome persists)
    const writeTimes = [];
    const onChanged = createEvent();

    const sizeOf = (key) => utf8ByteLength(key) + chromeJsonByteLength(items.get(key));
    const totalBytes = () => [...items.keys()].reduce((sum, key) => sum + sizeOf(key), 0);

    function chargeWriteOperation() {
        if (!quotas.MAX_WRITE_OPERATIONS_PER_MINUTE) return;
        const t = now();
        while (writeTimes.length && writeTimes[0] <= t - HOUR_MS) writeTimes.shift();
        const inLastMinute = writeTimes.filter((w) => w > t - MINUTE_MS).length;
        if (inLastMinute >= quotas.MAX_WRITE_OPERATIONS_PER_MINUTE) {
            throw quotaError('MAX_WRITE_OPERATIONS_PER_MINUTE');
        }
        if (writeTimes.length >= quotas.MAX_WRITE_OPERATIONS_PER_HOUR) {
            throw quotaError('MAX_WRITE_OPERATIONS_PER_HOUR');
        }
        writeTimes.push(t);
    }

    function get(keys) {
        const result = {};
        if (keys === null || keys === undefined) {
            for (const [key, json] of items) result[key] = JSON.parse(json);
            return result;
        }
        if (typeof keys === 'object' && !Array.isArray(keys)) {
            for (const [key, fallback] of Object.entries(keys)) {
                result[key] = items.has(key) ? JSON.parse(items.get(key)) : fallback;
            }
            return result;
        }
        for (const key of normalizeKeyList(keys)) {
            if (items.has(key)) result[key] = JSON.parse(items.get(key));
        }
        return result;
    }

    function set(toSet) {
        if (!toSet || typeof toSet !== 'object' || Array.isArray(toSet)) {
            throw new TypeError('items must be an object');
        }
        chargeWriteOperation();

        const entries = [];
        for (const [key, value] of Object.entries(toSet)) {
            const json = value === undefined ? undefined : JSON.stringify(value);
            if (json !== undefined) entries.push([key, json]);
        }

        // Validate everything before writing anything (all-or-nothing).
        let newTotal = totalBytes();
        let newCount = items.size;
        for (const [key, json] of entries) {
            const size = utf8ByteLength(key) + chromeJsonByteLength(json);
            if (quotas.QUOTA_BYTES_PER_ITEM && size > quotas.QUOTA_BYTES_PER_ITEM) {
                throw quotaError('QUOTA_BYTES_PER_ITEM');
            }
            if (items.has(key)) {
                newTotal -= sizeOf(key);
            } else {
                newCount += 1;
            }
            newTotal += size;
        }
        if (newTotal > quotas.QUOTA_BYTES) throw quotaError('QUOTA_BYTES');
        if (quotas.MAX_ITEMS && newCount > quotas.MAX_ITEMS) throw quotaError('MAX_ITEMS');

        const changes = {};
        for (const [key, json] of entries) {
            const previous = items.get(key);
            items.set(key, json);
            if (previous === json) continue;
            changes[key] = previous === undefined
                ? { newValue: JSON.parse(json) }
                : { oldValue: JSON.parse(previous), newValue: JSON.parse(json) };
        }
        emit(areaName, changes);
    }

    function removeKeys(keyList) {
        const changes = {};
        for (const key of keyList) {
            if (!items.has(key)) continue;
            changes[key] = { oldValue: JSON.parse(items.get(key)) };
            items.delete(key);
        }
        emit(areaName, changes);
    }

    function remove(keys) {
        const keyList = normalizeKeyList(keys);
        chargeWriteOperation();
        removeKeys(keyList);
    }

    function clear() {
        chargeWriteOperation();
        removeKeys([...items.keys()]);
    }

    function getBytesInUse(keys) {
        if (keys === null || keys === undefined) return totalBytes();
        return normalizeKeyList(keys)
            .filter((key) => items.has(key))
            .reduce((sum, key) => sum + sizeOf(key), 0);
    }

    const api = {
        ...quotas,
        get: chromeMethod(get, runtime),
        set: chromeMethod(set, runtime),
        remove: chromeMethod(remove, runtime),
        clear: chromeMethod(clear, runtime),
        getBytesInUse: chromeMethod(getBytesInUse, runtime),
        onChanged: onChanged.api
    };

    return {
        api,
        onChanged,
        // Test-setup backdoor: no quotas, no write charge, no events.
        seed(toSeed) {
            for (const [key, value] of Object.entries(toSeed)) {
                if (value !== undefined) items.set(key, JSON.stringify(value));
            }
        },
        dump: () => get(null),
        bytesInUse: () => totalBytes()
    };
}

/**
 * Build a fresh fake. Returns { chrome, sync, local, seed, dump, install }.
 * @param {{ now?: () => number }} [options] - clock for the write-rate window
 */
export function createChromeStorageFake({ now = () => Date.now() } = {}) {
    const runtime = { lastError: undefined, id: 'codex-test-extension' };
    const storageOnChanged = createEvent();
    const areas = {};

    const emit = (areaName, changes) => {
        if (Object.keys(changes).length === 0) return;
        areas[areaName].onChanged.dispatch(changes);
        storageOnChanged.dispatch(changes, areaName);
    };

    areas.sync = createArea('sync', SYNC_QUOTAS, { now, runtime, emit });
    areas.local = createArea('local', LOCAL_QUOTAS, { now, runtime, emit });

    const area = (areaName) => {
        const found = areas[areaName];
        if (!found) throw new Error(`Unknown storage area: ${areaName}`);
        return found;
    };

    const chrome = {
        runtime,
        storage: {
            sync: areas.sync.api,
            local: areas.local.api,
            onChanged: storageOnChanged.api
        }
    };

    return {
        chrome,
        sync: chrome.storage.sync,
        local: chrome.storage.local,
        /** Write directly, bypassing quotas, write charges and onChanged. */
        seed: (areaName, items) => area(areaName).seed(items),
        /** Plain-object copy of everything stored in an area. */
        dump: (areaName) => area(areaName).dump(),
        /** Synchronous bytes-in-use for an area (same measure as getBytesInUse). */
        bytesInUse: (areaName) => area(areaName).bytesInUse(),
        install() {
            globalThis.chrome = chrome;
            return this;
        }
    };
}

/** Create a fake and install it as `globalThis.chrome`. */
export function installChromeStorageFake(options) {
    return createChromeStorageFake(options).install();
}
