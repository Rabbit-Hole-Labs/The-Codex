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
 * - CSP: external resources a page or stylesheet loads must be allowed by the
 *   manifest's extension-page CSP for their directive (script-src, style-src,
 *   img-src, font-src, ...); inline scripts and on* handlers always fail (MV3
 *   never runs them), and inline styles fail unless style-src allows them.
 *   HTML and CSS are read with small tokenizers that follow the browsers'
 *   parsing rules, so text that only looks like markup isn't a reference.
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
    options_page: 'string', devtools_page: 'string', content_security_policy: 'object'
};

const iconPaths = (icon) => {
    if (icon === undefined) return [];
    if (typeof icon === 'string') return [icon];
    if (icon !== null && typeof icon === 'object' && !Array.isArray(icon)) return Object.values(icon);
    throw new Error('an icon must be a path or a size -> path object');
};

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

// CSS ---------------------------------------------------------------------------

/** Decodes CSS escapes: \XXXXXX (1-6 hex digits, optional trailing space) or \<char>. */
export function cssUnescape(value) {
    return value.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\f]?|\r\n|([\s\S]))/gi, (whole, hex, ch) => {
        if (hex) {
            const code = parseInt(hex, 16);
            return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '�' : String.fromCodePoint(code);
        }
        return ch === undefined || ch === '\n' ? '' : ch; // an escaped newline is a line continuation in strings
    });
}

/**
 * URLs a stylesheet (or a style attribute/block) loads, from a small CSS
 * tokenizer: comments and strings are skipped, so url()-like text inside a
 * string such as content: "url(x.png)" is not a reference. Each URL comes with
 * the CSP directive that governs it: @import -> style-src, url() inside
 * @font-face -> font-src, anything else -> img-src.
 * @returns {Array<{ url: string, directive: string }>}
 */
export function cssRefs(css) {
    const refs = [];
    const functions = []; // open function names, innermost last ('' for a bare parenthesis)
    let depth = 0;
    let fontFaceDepth = -1;
    let pendingFontFace = false;
    let pendingImport = false;
    let i = 0;
    const readString = (start) => {
        const quote = css[start];
        let j = start + 1;
        let raw = '';
        while (j < css.length && css[j] !== quote && css[j] !== '\n') {
            if (css[j] === '\\') {
                raw += css.slice(j, j + 2);
                j += 2;
            } else {
                raw += css[j++];
            }
        }
        return [cssUnescape(raw), Math.min(j + 1, css.length)];
    };
    const directive = () => (pendingImport ? 'style-src' : fontFaceDepth !== -1 ? 'font-src' : 'img-src');
    const push = (url) => {
        if (url) refs.push({ url, directive: directive() });
        pendingImport = false;
    };
    while (i < css.length) {
        const c = css[i];
        if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            i = end === -1 ? css.length : end + 2;
        } else if (c === '"' || c === "'") {
            const [value, end] = readString(i);
            const fn = functions[functions.length - 1];
            if (fn === 'image-set' || fn === '-webkit-image-set') refs.push({ url: value, directive: 'img-src' });
            else if (pendingImport && functions.length === 0) push(value);
            i = end;
        } else if (c === '{') {
            depth++;
            if (pendingFontFace) {
                fontFaceDepth = depth;
                pendingFontFace = false;
            }
            pendingImport = false;
            i++;
        } else if (c === '}') {
            if (depth === fontFaceDepth) fontFaceDepth = -1;
            depth = Math.max(0, depth - 1);
            i++;
        } else if (c === ';') {
            pendingImport = false;
            pendingFontFace = false;
            i++;
        } else if (c === '@') {
            const m = /^@([\w-]+)/.exec(css.slice(i, i + 64));
            const keyword = m ? m[1].toLowerCase() : '';
            if (keyword === 'import') pendingImport = true;
            if (keyword === 'font-face') pendingFontFace = true;
            i += m ? m[0].length : 1;
        } else if (c === '(') {
            functions.push('');
            i++;
        } else if (c === ')') {
            functions.pop();
            i++;
        } else if (c === '\\' || /[A-Za-z_\-\u0080-￿]/.test(c)) {
            let j = i;
            while (j < css.length && (css[j] === '\\' || /[\w\-\u0080-￿]/.test(css[j]))) j += css[j] === '\\' ? 2 : 1;
            const name = cssUnescape(css.slice(i, j)).toLowerCase();
            if (css[j] !== '(') {
                i = j;
            } else if (name !== 'url') {
                functions.push(name);
                i = j + 1;
            } else {
                // url( "quoted" ) or url(unquoted-token)
                let k = j + 1;
                while (k < css.length && /\s/.test(css[k])) k++;
                if (css[k] === '"' || css[k] === "'") {
                    const [value, end] = readString(k);
                    push(value);
                    const close = css.indexOf(')', end);
                    i = close === -1 ? css.length : close + 1;
                } else {
                    // An unquoted url token ends at ')'; unescaped whitespace before
                    // other text, or a quote or '(' inside, makes it a bad-url (no fetch).
                    let raw = '';
                    let bad = false;
                    while (k < css.length && css[k] !== ')') {
                        if (css[k] === '\\' && css[k + 1] !== '\n') {
                            raw += css.slice(k, k + 2);
                            k += 2;
                        } else if (/\s/.test(css[k])) {
                            while (k < css.length && /\s/.test(css[k])) k++;
                            if (css[k] !== ')') bad = true;
                        } else {
                            if (/["'(]/.test(css[k])) bad = true;
                            raw += css[k++];
                        }
                    }
                    if (bad) pendingImport = false;
                    else push(cssUnescape(raw));
                    i = k + 1;
                }
            }
        } else {
            i++;
        }
    }
    return refs;
}

// HTML --------------------------------------------------------------------------

/** Elements whose content is text up to their end tag, not markup (raw text / RCDATA). */
const TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

/**
 * A small HTML tokenizer: start tags with entity-decoded attributes, plus the
 * text of raw-text/RCDATA elements (script, style, textarea, title, ...) up to
 * their end tag. Comments, end tags and doctypes are skipped, and text between
 * tags is never scanned, so attribute-like or comment-like text there (or
 * inside a <textarea>) is not mistaken for markup.
 * @returns {Array<{ name: string, attrs: Map<string, string>, line: number, text?: string }>}
 */
export function scanHtml(html) {
    const tags = [];
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) break;
        if (html.startsWith('<!--', lt)) {
            const end = html.indexOf('-->', lt + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        const next = html[lt + 1] || '';
        if (next === '/' || next === '!' || next === '?') {
            const end = html.indexOf('>', lt + 2);
            i = end === -1 ? html.length : end + 1;
            continue;
        }
        if (!/[A-Za-z]/.test(next)) {
            i = lt + 1;
            continue;
        }
        let j = lt + 1;
        while (j < html.length && !/[\s/>]/.test(html[j])) j++;
        const name = html.slice(lt + 1, j).toLowerCase();
        const attrs = new Map();
        while (j < html.length && html[j] !== '>') {
            if (/[\s/]/.test(html[j])) {
                j++;
                continue;
            }
            let k = j + 1; // an attribute name may start with '='
            while (k < html.length && !/[\s/>=]/.test(html[k])) k++;
            const attr = html.slice(j, k).toLowerCase();
            j = k;
            while (j < html.length && /\s/.test(html[j])) j++;
            let value = '';
            if (html[j] === '=') {
                j++;
                while (j < html.length && /\s/.test(html[j])) j++;
                const quote = html[j];
                if (quote === '"' || quote === "'") {
                    const end = html.indexOf(quote, j + 1);
                    value = html.slice(j + 1, end === -1 ? html.length : end);
                    j = end === -1 ? html.length : end + 1;
                } else {
                    const start = j;
                    while (j < html.length && !/[\s>]/.test(html[j])) j++;
                    value = html.slice(start, j);
                }
            }
            if (!attrs.has(attr)) attrs.set(attr, decodeEntities(value));
        }
        i = j + 1;
        const tag = { name, attrs, line: html.slice(0, lt).split('\n').length };
        if (TEXT_ELEMENTS.has(name)) {
            const close = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
            close.lastIndex = i;
            const end = name === 'plaintext' ? null : close.exec(html);
            tag.text = html.slice(i, end ? end.index : html.length);
            i = end ? end.index : html.length;
        }
        tags.push(tag);
    }
    return tags;
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

const JS_TYPES = /^(|module|importmap|(text|application)\/(x-)?(java|ecma)script|text\/(j|live)script|text\/javascript1\.[0-5])$/i;

/**
 * What an HTML page loads, as { url, directive } pairs (directive is the CSP
 * directive governing the fetch, or null for navigations and hints), plus
 * markup the MV3 extension-page CSP always blocks (inline scripts and inline
 * event handlers), and which <script src> files run as classic scripts.
 */
function htmlRefs(html) {
    const urls = [];
    const inline = [];
    const classicScripts = [];
    const styles = [];
    const add = (url, directive) => {
        if (url && url.trim()) urls.push({ url: url.trim(), directive });
    };
    for (const tag of scanHtml(html)) {
        const { name, attrs, line } = tag;
        for (const attr of attrs.keys()) {
            if (/^on./.test(attr)) inline.push(`line ${line}: inline event handler ${attr}= on <${name}>`);
        }
        if (attrs.has('style')) styles.push(attrs.get('style'));
        const src = attrs.get('src');
        const href = attrs.get('href');
        switch (name) {
            case 'script': {
                const type = (attrs.get('type') || '').trim();
                if (!JS_TYPES.test(type)) break; // a data block, not a script
                if (src !== undefined) {
                    add(src, 'script-src');
                    if (type.toLowerCase() !== 'module') classicScripts.push(src);
                } else if (tag.text.trim()) {
                    inline.push(`line ${line}: inline <script>`);
                }
                break;
            }
            case 'style':
                styles.push(tag.text);
                break;
            case 'link': {
                const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
                if (rel.includes('stylesheet')) add(href, 'style-src');
                else if (rel.includes('icon') || rel.includes('apple-touch-icon')) add(href, 'img-src');
                else if (rel.includes('modulepreload')) add(href, 'script-src');
                else if (rel.includes('manifest')) add(href, 'manifest-src');
                else if (!rel.includes('preconnect') && !rel.includes('dns-prefetch')) add(href, null);
                break;
            }
            case 'img':
                add(src, 'img-src');
                srcsetUrls(attrs.get('srcset') || '').forEach((url) => add(url, 'img-src'));
                break;
            case 'source':
                add(src, 'media-src');
                srcsetUrls(attrs.get('srcset') || '').forEach((url) => add(url, 'img-src'));
                break;
            case 'video':
            case 'audio':
            case 'track':
                add(src, 'media-src');
                add(attrs.get('poster'), 'img-src');
                break;
            case 'iframe':
            case 'frame':
                add(src, 'frame-src');
                break;
            case 'object':
                add(attrs.get('data'), 'object-src');
                break;
            case 'embed':
                add(src, 'object-src');
                break;
            case 'input':
                if ((attrs.get('type') || '').toLowerCase() === 'image') add(src, 'img-src');
                break;
            case 'base':
                break;
            default:
                // a, area and anything else: a navigation or unknown use; check local targets exist.
                add(src, null);
                add(href, null);
        }
    }
    for (const css of styles) urls.push(...cssRefs(css));
    return { urls, inline, classicScripts, inlineStyles: styles.length > 0 };
}

// CSP ---------------------------------------------------------------------------

/** Chrome's default extension-pages CSP for MV3 when the manifest sets none. */
const DEFAULT_MV3_CSP = "script-src 'self'; object-src 'self';";

const CSP_FALLBACKS = { 'frame-src': ['child-src', 'default-src'] };

/** Parses a CSP string into Map(directive -> lower-cased sources). */
export function parseCsp(policy) {
    const directives = new Map();
    for (const part of String(policy).split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
        if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources.map((s) => s.toLowerCase()));
    }
    return directives;
}

const sourcesFor = (csp, directive) => {
    const name = [directive, ...(CSP_FALLBACKS[directive] || ['default-src'])].find((d) => csp.has(d));
    return name ? csp.get(name) : null;
};

/** Whether the CSP lets an extension page load the absolute URL under `directive`. */
export function cspAllows(csp, directive, url) {
    const sources = sourcesFor(csp, directive);
    if (!sources) return true;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    const scheme = parsed.protocol;
    return sources.some((source) => {
        if (source.startsWith("'")) return false; // 'self' (the extension), 'none', nonces, hashes, keywords
        if (/^[a-z][a-z0-9+.-]*:$/.test(source)) {
            return source === scheme || (source === 'http:' && scheme === 'https:') || (source === 'ws:' && scheme === 'wss:');
        }
        const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^/:]+)(?::(\d+|\*))?(\/.*)?$/.exec(source);
        if (!m) return false;
        const [, sourceScheme, host, port, path] = m;
        if (sourceScheme ? `${sourceScheme}:` !== scheme && !(sourceScheme === 'http' && scheme === 'https:') : !/^https?:$/.test(scheme)) {
            return false;
        }
        const hostname = parsed.hostname.toLowerCase();
        if (host.startsWith('*.') ? !hostname.endsWith(host.slice(1)) : host !== '*' && hostname !== host) return false;
        if (port && port !== '*') {
            const effective = parsed.port || ({ 'https:': '443', 'http:': '80' })[scheme] || '';
            if (effective !== port) return false;
        }
        if (path) {
            const pathname = decodeURIComponent(parsed.pathname);
            if (path.endsWith('/') ? !pathname.startsWith(path) : pathname !== path) return false;
        }
        return true;
    });
}

/** Whether inline content is allowed: 'unsafe-inline' with no hash/nonce (which would disable it). */
const cspAllowsInline = (csp, directive) => {
    const sources = sourcesFor(csp, directive);
    if (!sources) return true;
    return sources.includes("'unsafe-inline'") && !sources.some((s) => /^'(nonce|sha(256|384|512))-/.test(s));
};

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
 * References made by one packaged file.
 * @returns {{ refs: string[], external: Array<{ url: string, directive: string }>, errors: string[],
 *   dynamicImports: number, classicScripts: string[], inline: string[], inlineStyles: boolean }}
 *   refs are root-relative local paths; external are absolute URLs with the CSP
 *   directive governing them; classicScripts/inline/inlineStyles are for pages.
 */
export function extractRefs(file, text, { classic = false } = {}) {
    const result = { refs: [], external: [], errors: [], dynamicImports: 0, classicScripts: [], inline: [], inlineStyles: false };
    const add = ({ url, directive }) => {
        const resolved = resolveRef(file, url);
        if (resolved) result.refs.push(resolved);
        else if (directive && /^[a-z][a-z0-9+.-]*:/i.test(url.trim())) result.external.push({ url: url.trim(), directive });
    };
    if (file.endsWith('.html')) {
        const page = htmlRefs(text);
        page.urls.forEach(add);
        result.inline = page.inline;
        result.inlineStyles = page.inlineStyles;
        result.classicScripts = page.classicScripts.map((src) => resolveRef(file, src)).filter(Boolean);
    } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
        const dynamic = dynamicImports(file, text);
        result.errors.push(...dynamic.errors);
        result.dynamicImports = dynamic.specifiers.length + dynamic.errors.length;
        let statics = [];
        if (classic) {
            // Content scripts and <script> without type="module" run as classic
            // scripts: module syntax (import/export) is a SyntaxError there.
            try {
                new vm.Script(text, { filename: file });
            } catch (error) {
                result.errors.push(`${file} runs as a classic script (content script or <script> without type="module") but doesn't compile as one: ${error.message}`);
            }
        } else {
            statics = staticImports(file, text);
        }
        for (const specifier of [...statics, ...dynamic.specifiers]) {
            if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
                add({ url: specifier, directive: 'script-src' });
            } else {
                result.errors.push(`${file}: bare module specifier "${specifier}" cannot be loaded by an unbundled extension`);
            }
        }
    } else if (file.endsWith('.css')) {
        cssRefs(text).forEach(add);
    }
    return result;
}

/**
 * Checks every reference made by the manifest and every packaged page, module
 * and stylesheet. Returns errors for references that are not in the package,
 * for external resources and inline markup the manifest's extension-page CSP
 * blocks, and warnings for packaged files nothing reaches from manifest.json.
 */
export function checkReferences(root, files, manifest) {
    const packaged = new Set(files);
    const errors = [];
    const edges = new Map([['manifest.json', []]]);
    const usesDynamicImport = new Set();
    const policy = manifest.content_security_policy?.extension_pages;
    const csp = parseCsp(typeof policy === 'string' ? policy : DEFAULT_MV3_CSP);
    const read = (file) => readFileSync(join(root, file), 'utf8');

    // Pages first: they decide which scripts run as classic scripts.
    const results = new Map();
    for (const file of files.filter((f) => f.endsWith('.html'))) {
        results.set(file, extractRefs(file, read(file)));
    }
    const classic = new Set([...results.values()].flatMap((page) => page.classicScripts));
    if (Array.isArray(manifest.content_scripts)) {
        for (const script of manifest.content_scripts) {
            for (const js of Array.isArray(script?.js) ? script.js : []) {
                if (typeof js === 'string') classic.add(posix.normalize(js.replace(/^\//, '')));
            }
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
        let result = results.get(file);
        if (!result) {
            try {
                result = extractRefs(file, read(file), { classic: classic.has(file) });
            } catch (error) {
                errors.push(error.message);
                continue;
            }
        }
        errors.push(...result.errors);
        if (result.dynamicImports > 0) usesDynamicImport.add(file);
        for (const ref of result.refs) note(file, ref);
        for (const { url, directive } of result.external) {
            if (/^(https?|wss?|data|blob|ftp):/i.test(url) && !cspAllows(csp, directive, url)) {
                errors.push(`${file} loads ${url}, which the manifest CSP blocks (${directive})`);
            }
        }
        for (const item of result.inline) {
            errors.push(`${file} ${item}: MV3 extension pages never run inline script; move it to a file`);
        }
        if (result.inlineStyles && !cspAllowsInline(csp, 'style-src')) {
            errors.push(`${file} uses inline styles (style= or <style>), which the manifest CSP blocks: style-src has no 'unsafe-inline'`);
        }
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
