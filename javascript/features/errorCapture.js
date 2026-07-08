/**
 * Global Error Capture
 *
 * Records runtime problems that otherwise only surface in the browser's
 * chrome://extensions "Errors" screen (which is populated by the private
 * developerPrivate API and cannot be read by an extension). Captures:
 *   - uncaught exceptions            (window/self 'error')
 *   - unhandled promise rejections   ('unhandledrejection')
 *   - CSP violations                 ('securitypolicyviolation') — e.g. a
 *                                     blocked img-src/style-src request
 *   - console.error / console.warn   (wrapped, pass-through)
 *
 * Everything is written to chrome.storage.local as a de-duplicated ring
 * buffer so it survives reloads and spans every context (newtab, manage,
 * popup, service worker). To avoid unsynchronized read-modify-writes across
 * those independent contexts, the service worker is the single writer: page
 * contexts forward their entries to it via chrome.runtime.sendMessage. Export
 * the log consistently via CodexConsole.errors() / exportErrors(), or the
 * "Export Diagnostics" button.
 */

const STORAGE_KEY = 'codexErrorLog';
const MESSAGE_TYPE = 'codex:error-capture'; // page → service-worker write funnel
const MAX_ENTRIES = 200;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 2000;

let initialized = false;
let currentContext = 'unknown';
// The service worker is the single owner of the codexErrorLog storage key.
// Page contexts (newtab, manage, popup) forward their entries to it rather than
// writing directly, so read-modify-writes from different execution contexts can't
// clobber each other. Within the owner, writes are still serialized through
// writeChain so its own errors and inbound messages don't race one another.
let isOwner = false;
let writeChain = Promise.resolve();

/** Bounds any value we're about to persist so a single pathological entry
 *  (e.g. a `throw` of a huge string, or a CSP violation on a `data:` URI)
 *  can't blow past the chrome.storage.local quota. */
function truncate(value, max = MAX_MESSAGE_LENGTH) {
    const str = typeof value === 'string' ? value : String(value ?? '');
    return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** Safe stringify for console arguments. */
function formatArg(arg) {
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

/** Normalize a URI for dedup: drop query + fragment so a repeatedly-blocked
 *  URL that only varies by a cache-buster or per-request token still collapses
 *  to one entry instead of flushing the ring buffer. */
function normalizeUri(uri) {
    if (!uri) return '';
    try {
        const u = new URL(uri);
        return `${u.origin}${u.pathname}`;
    } catch {
        return String(uri).split('?')[0].split('#')[0];
    }
}

/** Signature used to collapse repeated identical entries into one (with a count). */
function signatureOf(entry) {
    // CSP violations differing only by query/fragment should still collapse,
    // so dedup on directive + normalized blocked URI rather than the full message.
    if (entry.type === 'csp-violation') {
        return ['csp-violation', entry.directive || '', normalizeUri(entry.blockedURI)].join('|');
    }
    return [entry.type, entry.message, entry.source || '', entry.directive || ''].join('|');
}

/** Serialize a storage-mutating task onto the owner's write chain so the
 *  owner's own errors and inbound forwarded entries never interleave a
 *  read-modify-write. Returns the settled promise for callers that must wait. */
function enqueueWrite(task) {
    writeChain = writeChain.then(async () => {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
            await task();
        } catch {
            /* Never let error capture throw — that would be self-defeating. */
        }
    });
    return writeChain;
}

/** Owner-only: append (or increment) an entry in the persisted ring buffer. */
async function applyRecord(entry) {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const log = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];

    const sig = signatureOf(entry);
    const existing = log.find(e => signatureOf(e) === sig);
    if (existing) {
        existing.count = (existing.count || 1) + 1;
        existing.lastTs = entry.ts;
    } else {
        entry.count = 1;
        entry.firstTs = entry.ts;
        entry.lastTs = entry.ts;
        log.push(entry);
        while (log.length > MAX_ENTRIES) log.shift();
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: log });
}

/** Owner-only: reset the ring buffer. */
async function applyClear() {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}

/** Forward a write request to the owner (service worker). Fire-and-forget: a
 *  dropped diagnostic entry is acceptable, a thrown error from capture is not. */
function forwardToOwner(payload) {
    try {
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return;
        const p = chrome.runtime.sendMessage({ type: MESSAGE_TYPE, ...payload });
        // Swallow "no receiver"/lastError rejections when the SW is transiently unavailable.
        if (p && typeof p.catch === 'function') p.catch(() => { /* dropped */ });
    } catch {
        /* ignore */
    }
}

/** Capture an entry. The owner writes it directly (serialized); every other
 *  context forwards it to the owner so there is a single writer. */
function record(partial) {
    const entry = {
        context: currentContext,
        type: 'error',
        message: '',
        source: '',
        ts: Date.now(),
        ...partial
    };

    if (isOwner) {
        enqueueWrite(() => applyRecord(entry));
    } else {
        forwardToOwner({ kind: 'record', entry });
    }
}

/**
 * Register the global listeners. Idempotent; call once per context, as early
 * as possible so early errors are caught.
 * @param {string} context - Which surface this is ('newtab', 'manage', 'popup', 'service-worker')
 */
export function initErrorCapture(context = 'page') {
    if (initialized) return;
    initialized = true;
    currentContext = context;
    isOwner = (context === 'service-worker');

    // Owner: accept forwarded write requests from the page contexts. Registered
    // synchronously so the listener is ready when Chrome wakes the service worker
    // to deliver a message.
    if (isOwner && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
            if (!msg || msg.type !== MESSAGE_TYPE) return undefined;
            let done;
            if (msg.kind === 'record' && msg.entry) {
                done = enqueueWrite(() => applyRecord(msg.entry));
            } else if (msg.kind === 'clear') {
                done = enqueueWrite(() => applyClear());
            } else {
                return undefined;
            }
            // Ack only once the write settles, so the SW isn't torn down mid-write.
            done.then(() => {
                try { sendResponse({ ok: true }); } catch { /* port already closed */ }
            });
            return true; // keep the message channel open for the async ack
        });
    }

    const globalScope = (typeof self !== 'undefined') ? self
        : (typeof window !== 'undefined') ? window : null;

    if (globalScope && typeof globalScope.addEventListener === 'function') {
        globalScope.addEventListener('error', (event) => {
            const err = event.error;
            record({
                type: 'uncaught-error',
                message: truncate(event.message || (err && err.message) || 'Uncaught error'),
                source: event.filename ? `${event.filename}:${event.lineno || 0}:${event.colno || 0}` : '',
                stack: err && err.stack ? truncate(err.stack, MAX_STACK_LENGTH) : ''
            });
        });

        globalScope.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason;
            record({
                type: 'unhandled-rejection',
                message: truncate((reason && (reason.message || String(reason))) || 'Unhandled promise rejection'),
                stack: reason && reason.stack ? truncate(reason.stack, MAX_STACK_LENGTH) : ''
            });
        });
    }

    // CSP violations only fire in a document context (not the service worker).
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('securitypolicyviolation', (event) => {
            const blockedURI = truncate(event.blockedURI);
            record({
                type: 'csp-violation',
                message: truncate(`Blocked by CSP (${event.violatedDirective}): ${blockedURI}`),
                directive: event.violatedDirective,
                blockedURI,
                source: event.sourceFile ? `${event.sourceFile}:${event.lineNumber || 0}` : ''
            });
        });
    }

    // Wrap console.error / console.warn so logged problems are captured too.
    // Originals are always called through, so console output is unchanged.
    ['error', 'warn'].forEach((level) => {
        const original = console[level];
        if (typeof original !== 'function' || original.__codexWrapped) return;
        const wrapped = function (...args) {
            try {
                record({ type: `console.${level}`, message: truncate(args.map(formatArg).join(' ')) });
            } catch {
                /* ignore */
            }
            return original.apply(console, args);
        };
        wrapped.__codexWrapped = true;
        console[level] = wrapped;
    });
}

/** @returns {Promise<Array>} the captured error entries (oldest first). */
export async function getCapturedErrors() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

/** Clears the captured error log. Routed through the owner so it can't race the
 *  owner's in-flight writes; falls back to a direct write if messaging is
 *  unavailable. */
export async function clearCapturedErrors() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    if (isOwner) {
        await enqueueWrite(() => applyClear());
        return;
    }
    if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
            await chrome.runtime.sendMessage({ type: MESSAGE_TYPE, kind: 'clear' });
            return;
        } catch {
            /* fall through to a best-effort direct clear */
        }
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}

/** Formats entries into a consistent, paste-friendly text block. */
export function formatCapturedErrors(list) {
    if (!list || !list.length) return 'No errors captured. 🎉';
    return list
        .slice()
        .sort((a, b) => (a.firstTs || a.ts || 0) - (b.firstTs || b.ts || 0))
        .map((e) => {
            const when = new Date(e.lastTs || e.ts).toLocaleString();
            const times = e.count > 1 ? ` (×${e.count})` : '';
            const src = e.source ? `\n    at ${e.source}` : '';
            const stack = e.stack ? `\n    ${String(e.stack).split('\n').slice(0, 4).join('\n    ')}` : '';
            return `[${when}] [${e.context}] ${e.type}${times}: ${e.message}${src}${stack}`;
        })
        .join('\n');
}
