#!/usr/bin/env node
/**
 * Builds the extension upload package: dist/the-codex-<version>.zip, with
 * manifest.json at the zip root as the Chrome Web Store requires.
 *
 * - Allowlist, not a copy of the repo: only manifest.json, the three pages and
 *   javascript/, stylesheets/ and assets/ go in (minus tests, .d.ts, source
 *   maps and anything hidden). Symlinks are refused.
 * - Reference check: every local file referenced from the manifest, an HTML
 *   page (src/href/srcset, inline styles), a JS module (static imports, parsed
 *   by V8 itself; dynamic import() only with a literal path) or a stylesheet
 *   (url()/@import/image-set) must be in the package, or the build fails.
 *   Every packaged page, module and stylesheet is checked, reached or not;
 *   packaged files nothing reaches from manifest.json are reported as warnings.
 * - Manifest check: MV3 (no MV2-only background.scripts/page or *_action), a
 *   Chrome-valid string version, name <= 75 and description <= 132 characters
 *   (the Web Store's limit). Manifest keys the packager doesn't understand fail
 *   the build instead of being skipped. import() anywhere in the background
 *   service worker's module graph fails too: extension workers can't run it.
 * - The output directory may not sit inside a packaged directory.
 * - Deterministic: sorted entries and fixed timestamps. Rebuilding with the
 *   same Node/zlib build gives a byte-identical zip; across machines compare
 *   the printed content digest (per-file SHA-256s), which ignores zlib. Text
 *   files must be checked out with LF line endings for digests to match CI.
 * - The manifest `key` is kept by default so an unpacked load of the package
 *   keeps the published extension ID and its chrome.storage.sync data (see
 *   CLAUDE.md). Pass --strip-key to build a copy without it.
 *
 * Node built-ins only: no install step needed, so CI can run it without `npm ci`.
 * Needs --experimental-vm-modules for V8's module parser (`npm run package` sets it).
 *
 * Usage: npm run package -- [--strip-key] [--out-dir <dir>]
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';

/** Top-level files and directories that make up the extension. */
export const PACKAGE_ROOTS = ['manifest.json', 'index.html', 'manage.html', 'popup.html', 'javascript', 'stylesheets', 'assets'];

const EXCLUDED_FILES = [/\.test\.js$/, /\.spec\.js$/, /\.d\.ts$/, /\.map$/];

export const MAX_NAME_LENGTH = 75;
export const MAX_DESCRIPTION_LENGTH = 132;

/** Lists packaged files as sorted posix paths relative to root. */
export function collectFiles(root, roots = PACKAGE_ROOTS) {
    const files = [];
    const walk = (rel) => {
        const stat = lstatSync(join(root, rel));
        if (stat.isSymbolicLink()) {
            throw new Error(`${rel} is a symlink; the package only takes real files`);
        }
        if (stat.isDirectory()) {
            for (const name of readdirSync(join(root, rel))) {
                if (!name.startsWith('.')) walk(posix.join(rel, name));
            }
        } else if (!EXCLUDED_FILES.some((pattern) => pattern.test(rel))) {
            files.push(rel);
        }
    };
    for (const entry of roots) {
        if (!existsSync(join(root, entry))) {
            throw new Error(`Package root "${entry}" does not exist`);
        }
        walk(entry);
    }
    return files.sort();
}

// --- Manifest ----------------------------------------------------------------

/**
 * Manifest fields that hold file paths, as functions returning the paths.
 * Anything not listed here or in NON_PATH_KEYS fails the build, so a new
 * manifest feature can't silently ship without the files it points at.
 */
const PATH_FIELDS = {
    background: (v) => [v.service_worker, v.page, ...(v.scripts || [])],
    action: (v) => [v.default_popup, ...iconPaths(v.default_icon)],
    browser_action: (v) => [v.default_popup, ...iconPaths(v.default_icon)],
    page_action: (v) => [v.default_popup, ...iconPaths(v.default_icon)],
    icons: (v) => iconPaths(v),
    chrome_url_overrides: (v) => Object.values(v),
    options_page: (v) => [v],
    options_ui: (v) => [v.page],
    devtools_page: (v) => [v],
    side_panel: (v) => [v.default_path],
    sandbox: (v) => v.pages || [],
    content_scripts: (v) => v.flatMap((script) => [...(script.js || []), ...(script.css || [])]),
    declarative_net_request: (v) => (v.rule_resources || []).map((rule) => rule.path)
};

const NON_PATH_KEYS = new Set([
    'manifest_version', 'name', 'short_name', 'version', 'version_name', 'description', 'key',
    'permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions',
    'content_security_policy', 'minimum_chrome_version', 'author', 'homepage_url',
    'incognito', 'offline_enabled', 'commands', 'omnibox', 'externally_connectable',
    'cross_origin_embedder_policy', 'cross_origin_opener_policy', 'oauth2',
    'default_locale' // rejected by validateManifest until _locales/ is packaged
]);

/** Expected JSON type of each path-bearing manifest field (Chrome rejects other shapes). */
const FIELD_SHAPES = {
    background: 'object', action: 'object', browser_action: 'object', page_action: 'object',
    icons: 'object', chrome_url_overrides: 'object', options_ui: 'object', side_panel: 'object',
    sandbox: 'object', declarative_net_request: 'object', content_scripts: 'array',
    options_page: 'string', devtools_page: 'string'
};

const iconPaths = (icon) => (typeof icon === 'string' ? [icon] : Object.values(icon || {}));

/** Checks the manifest fields Chrome and the Web Store validate on upload. */
export function validateManifest(manifest) {
    const errors = [];
    if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
        errors.push('name is required');
    } else if (manifest.name.length > MAX_NAME_LENGTH) {
        errors.push(`name is ${manifest.name.length} characters; Chrome allows ${MAX_NAME_LENGTH}`);
    }
    if (typeof manifest.version !== 'string') {
        errors.push('version must be a string');
    } else {
        const parts = manifest.version.split('.');
        const valid = parts.length <= 4 &&
            parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535) &&
            parts.some((part) => part !== '0');
        if (!valid) {
            errors.push(`version "${manifest.version}" must be 1-4 dot-separated integers 0-65535, no leading zeros, not all zero`);
        }
    }
    if ('description' in manifest && typeof manifest.description !== 'string') {
        errors.push('description must be a string');
    } else if (typeof manifest.description === 'string' && manifest.description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(`description is ${manifest.description.length} characters; the Web Store allows ${MAX_DESCRIPTION_LENGTH}`);
    }
    for (const [key, shape] of Object.entries(FIELD_SHAPES)) {
        if (!(key in manifest)) continue;
        const value = manifest[key];
        const ok = shape === 'array' ? Array.isArray(value)
            : shape === 'string' ? typeof value === 'string'
                : value !== null && typeof value === 'object' && !Array.isArray(value);
        if (!ok) errors.push(`${key} must be ${shape === 'array' ? 'an array' : shape === 'string' ? 'a string' : 'an object'}`);
    }
    if (manifest.manifest_version === 3) {
        const background = manifest.background && typeof manifest.background === 'object' ? manifest.background : {};
        for (const field of ['scripts', 'page']) {
            if (field in background) errors.push(`background.${field} is MV2-only; MV3 uses background.service_worker`);
        }
        for (const key of ['browser_action', 'page_action']) {
            if (key in manifest) errors.push(`${key} is MV2-only; MV3 uses action`);
        }
    }
    if (manifest.background?.service_worker && manifest.background.type !== 'module') {
        errors.push('background.type must be "module": the packager checks JS files as ES modules');
    }
    if ('default_locale' in manifest || /__MSG_\w+__/.test(JSON.stringify(manifest))) {
        errors.push('default_locale/__MSG_ strings are not supported by the packager yet (_locales/ is not packaged)');
    }
    for (const key of Object.keys(manifest)) {
        if (!(key in PATH_FIELDS) && !NON_PATH_KEYS.has(key)) {
            errors.push(`manifest key "${key}" is not understood by the packager; add it to PATH_FIELDS or NON_PATH_KEYS in scripts/package-extension.js`);
        }
    }
    return errors;
}

/** Root-relative paths referenced by the manifest. Throws on a field with an unexpected shape. */
export function manifestRefs(manifest) {
    const refs = [];
    for (const [key, read] of Object.entries(PATH_FIELDS)) {
        if (manifest[key] === undefined) continue;
        let paths = null;
        try {
            paths = read(manifest[key]);
        } catch {
            // reported below
        }
        if (!Array.isArray(paths) || paths.some((path) => path !== undefined && typeof path !== 'string')) {
            throw new Error(`manifest "${key}" has an unexpected shape`);
        }
        refs.push(...paths.filter(Boolean));
    }
    return refs;
}

// --- Reference extraction ------------------------------------------------------

const isExternal = (ref) => /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#');

const decodeEntities = (text) => text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Resolves a reference relative to the referencing file; null for external refs. */
export function resolveRef(fromFile, ref, { rootRelative = false } = {}) {
    const trimmed = ref.trim();
    if (!trimmed || isExternal(trimmed)) return null;
    let clean = trimmed.split(/[?#]/)[0];
    try {
        clean = decodeURIComponent(clean);
    } catch {
        // keep the raw path; a bad escape will fail the existence check
    }
    if (!clean) return null;
    if (clean.startsWith('/')) return posix.normalize(clean.slice(1));
    return posix.normalize(rootRelative ? clean : posix.join(posix.dirname(fromFile), clean));
}

/** Removes CSS comments without treating '/*' inside a quoted string as one. */
function stripCssComments(css) {
    let out = '';
    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '"' || ch === "'") {
            // A CSS string ends at the matching unescaped quote or an unescaped newline.
            let j = i + 1;
            while (j < css.length && css[j] !== ch && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
            out += css.slice(i, j + 1);
            i = j;
        } else if (ch === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            i = end === -1 ? css.length : end + 1;
        } else {
            out += ch;
        }
    }
    return out;
}

/** Decodes CSS escapes: \\XXXXXX (1-6 hex digits, optional trailing space) or \\<char>. */
export function cssUnescape(value) {
    return value.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\f]?|\r\n|([\s\S]))/gi, (whole, hex, ch) => {
        if (hex) {
            const code = parseInt(hex, 16);
            return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(code);
        }
        return ch === undefined || ch === '\n' ? '' : ch; // an escaped newline is a line continuation in strings
    });
}

// Quoted CSS strings may contain escaped quotes; unquoted url() tokens may contain escapes (e.g. "\\ ").
const CSS_DQ = '"((?:\\\\[\\s\\S]|[^"\\\\\\n])*)"';
const CSS_SQ = "'((?:\\\\[\\s\\S]|[^'\\\\\\n])*)'";

function cssRefs(css) {
    const refs = [];
    const text = stripCssComments(css);
    const url = new RegExp(`url\\(\\s*(?:${CSS_DQ}|${CSS_SQ}|((?:\\\\[\\s\\S]|[^)'"\\s\\\\])+))\\s*\\)`, 'gi');
    for (const m of text.matchAll(url)) {
        // An unquoted value can't contain unescaped parentheses; skip var(--x) and other functions.
        if (m[3] !== undefined && /(^|[^\\])[()]|^var\b/.test(m[3])) continue;
        refs.push(cssUnescape(m[1] ?? m[2] ?? m[3]));
    }
    for (const m of text.matchAll(new RegExp(`@import\\s+(?:${CSS_DQ}|${CSS_SQ})`, 'gi'))) refs.push(cssUnescape(m[1] ?? m[2]));
    for (const m of text.matchAll(/image-set\(((?:[^()]|\([^()]*\))*)\)/gi)) {
        // Strings inside type("image/avif") are MIME types, not paths.
        const candidates = m[1].replace(/type\(\s*(?:"[^"]*"|'[^']*')\s*\)/gi, '');
        for (const s of candidates.matchAll(new RegExp(`${CSS_DQ}|${CSS_SQ}`, 'g'))) refs.push(cssUnescape(s[1] ?? s[2]));
    }
    return refs.filter(Boolean);
}

/** Removes <!-- --> comments that start outside a tag (not inside an attribute value). */
function stripHtmlComments(html) {
    let out = '';
    let quote = null;
    let inTag = false;
    for (let i = 0; i < html.length; i++) {
        const ch = html[i];
        if (inTag) {
            if (quote) {
                if (ch === quote) quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === '>') {
                inTag = false;
            }
            out += ch;
        } else if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i + 4);
            i = end === -1 ? html.length : end + 2;
        } else {
            if (ch === '<' && /[a-z/!]/i.test(html[i + 1] || '')) inTag = true;
            out += ch;
        }
    }
    return out;
}

/**
 * Candidate URLs of a srcset, following the HTML parsing rules: a URL runs to
 * the next whitespace (so a data: URL's comma stays inside it), trailing commas
 * end a URL, and descriptors run to the next comma outside parentheses.
 */
export function srcsetUrls(value) {
    const urls = [];
    let i = 0;
    while (i < value.length) {
        while (i < value.length && /[\s,]/.test(value[i])) i++;
        const start = i;
        while (i < value.length && !/\s/.test(value[i])) i++;
        let url = value.slice(start, i);
        if (url.endsWith(',')) {
            url = url.replace(/,+$/, '');
        } else {
            let depth = 0;
            for (; i < value.length && !(value[i] === ',' && depth === 0); i++) {
                if (value[i] === '(') depth++;
                else if (value[i] === ')') depth = Math.max(0, depth - 1);
            }
        }
        if (url) urls.push(url);
    }
    return urls;
}

/** src of each <script> that isn't type="module" (it runs as a classic script). */
function classicScriptSrcs(html) {
    const srcs = [];
    for (const m of stripHtmlComments(html).matchAll(/<script\b([^>]*)>/gi)) {
        const attrs = m[1];
        if (/(?<![\w-])type\s*=\s*(?:"module"|'module'|module\b)/i.test(attrs)) continue;
        const src = attrs.match(/(?<![\w-])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i);
        if (src) srcs.push(decodeEntities(src[1] ?? src[2] ?? src[3]));
    }
    return srcs;
}

function htmlRefs(html) {
    const refs = [];
    const text = stripHtmlComments(html);
    const attr = (name) => new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'gi');
    for (const m of text.matchAll(attr('(?:src|href|poster|data)'))) {
        const tagStart = text.lastIndexOf('<', m.index);
        // <object data=...> is a reference; data-* attributes are not (excluded by the lookbehind).
        if (/^data\s*=/i.test(m[0]) && !/^<object\b/i.test(text.slice(tagStart))) continue;
        refs.push(decodeEntities(m[1] ?? m[2] ?? m[3]));
    }
    for (const m of text.matchAll(attr('srcset'))) refs.push(...srcsetUrls(decodeEntities(m[1] ?? m[2] ?? m[3])));
    for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) refs.push(...cssRefs(m[1]));
    for (const m of text.matchAll(attr('style'))) refs.push(...cssRefs(decodeEntities(m[1] ?? m[2] ?? m[3])));
    return refs;
}

/** Static import/export specifiers, from V8's own module parser. */
function staticImports(file, source) {
    if (typeof vm.SourceTextModule !== 'function') {
        throw new Error('Run with node --experimental-vm-modules (npm run package does) so imports can be parsed');
    }
    let mod;
    try {
        mod = new vm.SourceTextModule(source, { identifier: file });
    } catch (error) {
        throw new Error(`${file}: ${error.name}: ${error.message}`);
    }
    return mod.moduleRequests ? mod.moduleRequests.map((request) => request.specifier) : mod.dependencySpecifiers;
}

/**
 * Dynamic import() calls. V8 doesn't report them, so this is a deliberately
 * conservative text scan: a plain literal path is checked like a static
 * import; any other import( occurrence, even in a comment, fails the build.
 */
function dynamicImports(file, source) {
    const specifiers = [];
    const errors = [];
    const literal = /\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`)\s*[,)]/y;
    for (const m of source.matchAll(/(?<![\w$.])import(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/g)) {
        literal.lastIndex = m.index + m[0].length;
        const lit = literal.exec(source);
        if (lit) {
            specifiers.push(lit[1] ?? lit[2] ?? lit[3]);
        } else {
            const line = source.slice(0, m.index).split('\n').length;
            errors.push(`${file}:${line}: import() without a literal path can't be checked; use a static import or a string literal`);
        }
    }
    return { specifiers, errors };
}

/**
 * Local references made by one packaged file.
 * @returns {{ refs: string[], errors: string[], dynamicImports: number }} refs are
 *   root-relative paths; dynamicImports counts import() calls (literal or not)
 */
export function extractRefs(file, text, { classic = false } = {}) {
    const refs = [];
    const errors = [];
    let dynamicImportCount = 0;
    const add = (ref) => {
        const resolved = resolveRef(file, ref);
        if (resolved) refs.push(resolved);
    };
    if (file.endsWith('.html')) {
        htmlRefs(text).forEach(add);
    } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
        const dynamic = dynamicImports(file, text);
        errors.push(...dynamic.errors);
        dynamicImportCount = dynamic.specifiers.length + dynamic.errors.length;
        let statics = [];
        if (classic) {
            // Content scripts and <script> without type="module" run as classic
            // scripts: module syntax (import/export) is a SyntaxError there.
            try {
                new vm.Script(text, { filename: file });
            } catch (error) {
                errors.push(`${file} runs as a classic script (content script or <script> without type="module") but doesn't compile as one: ${error.message}`);
            }
        } else {
            statics = staticImports(file, text);
        }
        for (const specifier of [...statics, ...dynamic.specifiers]) {
            if (specifier.startsWith('.') || specifier.startsWith('/')) {
                add(specifier);
            } else {
                errors.push(`${file}: bare module specifier "${specifier}" cannot be loaded by an unbundled extension`);
            }
        }
    } else if (file.endsWith('.css')) {
        cssRefs(text).forEach(add);
    }
    return { refs, errors, dynamicImports: dynamicImportCount };
}

/**
 * Checks every reference made by the manifest and every packaged page, module
 * and stylesheet. Returns errors for references that are not in the package
 * and warnings for packaged files nothing reaches from manifest.json.
 */
export function checkReferences(root, files, manifest) {
    const packaged = new Set(files);
    const errors = [];
    const edges = new Map([['manifest.json', []]]);
    const usesDynamicImport = new Set();
    // Files that run as classic scripts: content scripts and non-module <script src>.
    const classic = new Set();
    if (Array.isArray(manifest.content_scripts)) {
        for (const script of manifest.content_scripts) {
            for (const js of Array.isArray(script?.js) ? script.js : []) {
                if (typeof js === 'string') classic.add(posix.normalize(js.replace(/^\//, '')));
            }
        }
    }
    for (const file of files.filter((f) => f.endsWith('.html'))) {
        for (const src of classicScriptSrcs(readFileSync(join(root, file), 'utf8'))) {
            const resolved = resolveRef(file, src);
            if (resolved) classic.add(resolved);
        }
    }
    const note = (from, ref) => {
        if (packaged.has(ref)) {
            edges.get(from).push(ref);
        } else {
            errors.push(`${from} references ${ref}, which is not in the package`);
        }
    };
    let refs = [];
    try {
        refs = manifestRefs(manifest);
    } catch (error) {
        errors.push(error.message);
    }
    for (const ref of refs) {
        // Chrome reads manifest paths literally: no URL decoding or ?/# handling.
        note('manifest.json', posix.normalize(ref.startsWith('/') ? ref.slice(1) : ref));
    }
    for (const file of files) {
        if (!/\.(html|js|mjs|css)$/.test(file)) continue;
        edges.set(file, []);
        let result;
        try {
            result = extractRefs(file, readFileSync(join(root, file), 'utf8'), { classic: classic.has(file) });
        } catch (error) {
            errors.push(error.message);
            continue;
        }
        errors.push(...result.errors);
        if (result.dynamicImports > 0) usesDynamicImport.add(file);
        for (const ref of result.refs) note(file, ref);
    }
    // Extension service workers don't support import(); check the worker's whole module graph.
    const worker = typeof manifest.background?.service_worker === 'string'
        ? posix.normalize(manifest.background.service_worker.replace(/^\//, ''))
        : null;
    if (worker && edges.has(worker)) {
        const graph = new Set([worker]);
        const pending = [worker];
        while (pending.length) {
            for (const next of edges.get(pending.shift()) || []) {
                if (!graph.has(next)) {
                    graph.add(next);
                    pending.push(next);
                }
            }
        }
        for (const file of [...graph].filter((f) => usesDynamicImport.has(f)).sort()) {
            errors.push(`${file} uses import(), which the extension service worker (${worker}) can't run; use a static import`);
        }
    }
    const reached = new Set(['manifest.json']);
    const queue = ['manifest.json'];
    while (queue.length) {
        for (const next of edges.get(queue.shift()) || []) {
            if (!reached.has(next)) {
                reached.add(next);
                queue.push(next);
            }
        }
    }
    const warnings = files.filter((file) => !reached.has(file)).map((file) => `${file} is packaged but nothing references it`);
    return { errors, warnings };
}

// --- Deterministic zip writer (store/deflate, no zip64) ----------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

export function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the earliest DOS date
const UTF8_FLAG = 0x0800;
const MADE_BY_UNIX = (3 << 8) | 20;

/** Builds a zip from [{ name, data }] (files) plus the parent directories they need. */
export function createZip(entries) {
    const dirs = new Set();
    for (const { name } of entries) {
        const parts = name.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
    }
    const all = [
        ...[...dirs].map((name) => ({ name, data: Buffer.alloc(0), dir: true })),
        ...entries.map((entry) => ({ ...entry, dir: false }))
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (all.length >= 0xFFFF) throw new Error('Too many entries for a zip without zip64');

    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data, dir } of all) {
        const nameBytes = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const deflated = dir ? data : deflateRawSync(data, { level: 9 });
        const useDeflate = !dir && deflated.length < data.length;
        const body = useDeflate ? deflated : data;
        const method = useDeflate ? 8 : 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(UTF8_FLAG, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(MADE_BY_UNIX, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(UTF8_FLAG, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        // extra (30), comment (32), disk (34), internal attrs (36) stay 0
        const mode = dir ? 0o40755 : 0o100644;
        central.writeUInt32LE(((mode << 16) | (dir ? 0x10 : 0)) >>> 0, 38);
        central.writeUInt32LE(offset, 42);

        locals.push(local, nameBytes, body);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + body.length;
        if (offset >= 0xFFFFFFFF) throw new Error('Package too large for a zip without zip64');
    }
    const centralDir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(all.length, 8);
    end.writeUInt16LE(all.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralDir, end]);
}

/** SHA-256 over sorted "name\tsha256(bytes)" lines: equal for equal contents on any zlib. */
export function contentDigest(entries) {
    const lines = entries
        .map(({ name, data }) => `${name}\t${createHash('sha256').update(data).digest('hex')}`)
        .sort()
        .join('\n');
    return createHash('sha256').update(lines).digest('hex');
}

// --- Build -------------------------------------------------------------------

/** realpath of a path that may not exist yet (resolves its nearest existing ancestor). */
function realpathLoose(path) {
    let existing = resolve(path);
    const rest = [];
    while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing) break;
        rest.unshift(basename(existing));
        existing = parent;
    }
    return join(realpathSync(existing), ...rest);
}

/**
 * Builds the package. Throws with every problem listed if validation fails.
 * @returns {{ zipPath, zipName, version, files, warnings, bytes, sha256, contentSha256 }}
 */
export function buildPackage({ root, outDir = join(root, 'dist'), stripKey = false } = {}) {
    if (typeof vm.SourceTextModule !== 'function') {
        throw new Error('Run with node --experimental-vm-modules (npm run package does) so imports can be parsed');
    }
    const manifestBytes = readFileSync(join(root, 'manifest.json'));
    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch (error) {
        throw new Error(`manifest.json is not valid JSON (the Web Store rejects comments): ${error.message}`);
    }
    const realOut = realpathLoose(outDir);
    for (const entry of PACKAGE_ROOTS) {
        const packaged = join(root, entry);
        if (!existsSync(packaged)) continue;
        const realPackaged = realpathSync(packaged);
        if (realOut === realPackaged || realOut.startsWith(realPackaged + sep)) {
            throw new Error(`Output directory ${outDir} is inside the packaged "${entry}"; the zip would package itself on the next build`);
        }
    }
    const files = collectFiles(root);
    const problems = validateManifest(manifest);
    const { errors, warnings } = checkReferences(root, files, manifest);
    problems.push(...errors);
    if (problems.length) {
        throw new Error(`Package validation failed:\n  - ${problems.join('\n  - ')}`);
    }

    const entries = files.map((name) => {
        if (name === 'manifest.json' && stripKey && 'key' in manifest) {
            const withoutKey = { ...manifest };
            delete withoutKey.key;
            return { name, data: Buffer.from(`${JSON.stringify(withoutKey, null, 2)}\n`, 'utf8') };
        }
        return { name, data: name === 'manifest.json' ? manifestBytes : readFileSync(join(root, name)) };
    });
    const zip = createZip(entries);
    const keyStripped = stripKey && 'key' in manifest;
    const zipName = `the-codex-${manifest.version}${keyStripped ? '-nokey' : ''}.zip`;
    mkdirSync(outDir, { recursive: true });
    const zipPath = join(outDir, zipName);
    writeFileSync(zipPath, zip);
    return {
        zipPath,
        zipName,
        version: manifest.version,
        files,
        warnings,
        bytes: zip.length,
        sha256: createHash('sha256').update(zip).digest('hex'),
        contentSha256: contentDigest(entries)
    };
}

function main() {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { values } = parseArgs({
        options: { 'strip-key': { type: 'boolean', default: false }, 'out-dir': { type: 'string' } },
        strict: true
    });
    const stripKey = values['strip-key'];
    // npm runs scripts from the package root; INIT_CWD is where the user ran npm.
    if (values['out-dir'] === '') throw new Error('--out-dir needs a directory');
    const outDir = values['out-dir'] !== undefined ? resolve(process.env.INIT_CWD || process.cwd(), values['out-dir']) : undefined;
    const result = buildPackage({ root, stripKey, outDir });

    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    const kb = (result.bytes / 1024).toFixed(1);
    console.log(`Built ${result.zipPath}`);
    console.log(`  version ${result.version}, ${result.files.length} files, ${kb} KiB${stripKey ? ', manifest key stripped' : ''}`);
    console.log(`  zip sha256      ${result.sha256} (same Node/zlib build only)`);
    console.log(`  content sha256  ${result.contentSha256} (per-file SHA-256s; comparable anywhere)`);

    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, [
            `version=${result.version}`,
            `zip-name=${result.zipName}`,
            `zip-path=${result.zipPath}`,
            `sha256=${result.sha256}`,
            `content-sha256=${result.contentSha256}`,
            ''
        ].join('\n'));
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        const lines = [
            `### Extension package: \`${result.zipName}\``,
            '',
            `- Version: ${result.version}`,
            `- Files: ${result.files.length}, size: ${kb} KiB`,
            `- Content SHA-256 (per-file hashes; compare with a local \`npm run package\`): \`${result.contentSha256}\``,
            `- Zip SHA-256 (this runner's zlib): \`${result.sha256}\``,
            stripKey ? '- Manifest `key`: stripped' : '- Manifest `key`: kept (unpacked loads keep the published ID)',
            ...result.warnings.map((warning) => `- Warning: ${warning}`),
            ''
        ];
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    }
}

const isMain = (() => {
    try {
        return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();

if (isMain) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
