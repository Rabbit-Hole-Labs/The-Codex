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
 * popup, service worker). Export it consistently via CodexConsole.errors()
 * / exportErrors(), or the "Export Diagnostics" button.
 */

const STORAGE_KEY = 'codexErrorLog';
const MAX_ENTRIES = 200;

let initialized = false;
let currentContext = 'unknown';
// Serialize storage writes within this context to avoid read/modify/write races.
let writeChain = Promise.resolve();

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

/** Signature used to collapse repeated identical entries into one (with a count). */
function signatureOf(entry) {
    return [entry.type, entry.message, entry.source || '', entry.directive || ''].join('|');
}

/** Append (or increment) an entry in the persisted ring buffer. */
function record(partial) {
    const entry = {
        context: currentContext,
        type: 'error',
        message: '',
        source: '',
        ts: Date.now(),
        ...partial
    };

    writeChain = writeChain.then(async () => {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
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
        } catch {
            /* Never let error capture throw — that would be self-defeating. */
        }
    });
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

    const globalScope = (typeof self !== 'undefined') ? self
        : (typeof window !== 'undefined') ? window : null;

    if (globalScope && typeof globalScope.addEventListener === 'function') {
        globalScope.addEventListener('error', (event) => {
            const err = event.error;
            record({
                type: 'uncaught-error',
                message: event.message || (err && err.message) || 'Uncaught error',
                source: event.filename ? `${event.filename}:${event.lineno || 0}:${event.colno || 0}` : '',
                stack: err && err.stack ? String(err.stack).slice(0, 2000) : ''
            });
        });

        globalScope.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason;
            record({
                type: 'unhandled-rejection',
                message: (reason && (reason.message || String(reason))) || 'Unhandled promise rejection',
                stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : ''
            });
        });
    }

    // CSP violations only fire in a document context (not the service worker).
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('securitypolicyviolation', (event) => {
            record({
                type: 'csp-violation',
                message: `Blocked by CSP (${event.violatedDirective}): ${event.blockedURI}`,
                directive: event.violatedDirective,
                blockedURI: event.blockedURI,
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
                record({ type: `console.${level}`, message: args.map(formatArg).join(' ').slice(0, 1000) });
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

/** Clears the captured error log. */
export async function clearCapturedErrors() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    }
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
