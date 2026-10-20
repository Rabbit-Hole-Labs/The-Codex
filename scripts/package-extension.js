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
import { createHash, createPublicKey } from 'node:crypto';
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
    if ('key' in manifest) {
        // The Web Store's public key: strict base64 of a DER SubjectPublicKeyInfo.
        let validKey = typeof manifest.key === 'string' && manifest.key.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key);
        if (validKey) {
            try {
                createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' });
            } catch {
                validKey = false;
            }
        }
        if (!validKey) errors.push('key must be the base64 public key from the Chrome Web Store dashboard');
    }
    const overrides = manifest.chrome_url_overrides;
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        const keys = Object.keys(overrides);
        if (keys.length !== 1 || !['newtab', 'history', 'bookmarks'].includes(keys[0])) {
            errors.push('chrome_url_overrides must override exactly one of newtab, history or bookmarks');
        }
    }
    const cspField = manifest.content_security_policy;
    if (cspField && typeof cspField === 'object' && !Array.isArray(cspField)) {
        for (const [member, value] of Object.entries(cspField)) {
            if (!['extension_pages', 'sandbox'].includes(member)) {
                errors.push(`content_security_policy.${member} is not an MV3 member (use extension_pages or sandbox)`);
            } else if (typeof value !== 'string') {
                errors.push(`content_security_policy.${member} must be a policy string`);
            }
        }
    }
    if (typeof cspField?.sandbox === 'string') {
        // Chrome requires a custom sandbox policy to keep the sandbox directive, without allow-same-origin.
        const sandboxDirectives = parseCsp(cspField.sandbox);
        if (!sandboxDirectives.has('sandbox')) {
            errors.push('content_security_policy.sandbox must include the sandbox directive');
        } else if (sandboxDirectives.get('sandbox').includes('allow-same-origin')) {
            errors.push('content_security_policy.sandbox may not use allow-same-origin');
        }
    }
    for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
        if (key in manifest && !(Array.isArray(manifest[key]) && manifest[key].every((item) => typeof item === 'string' && item))) {
            errors.push(`${key} must be an array of strings`);
        }
    }
    if (Array.isArray(manifest.content_scripts)) {
        const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item);
        manifest.content_scripts.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                errors.push(`content_scripts[${index}] must be an object`);
                return;
            }
            if (!strings(entry.matches)) errors.push(`content_scripts[${index}].matches must be a non-empty array of match patterns`);
            for (const key of ['js', 'css']) {
                if (key in entry && !strings(entry[key])) errors.push(`content_scripts[${index}].${key} must be a non-empty array of paths`);
            }
            if (!('js' in entry) && !('css' in entry)) errors.push(`content_scripts[${index}] needs js or css`);
        });
    }
    const policy = manifest.content_security_policy?.extension_pages;
    if (manifest.manifest_version === 3 && typeof policy === 'string') {
        // MV3 can't relax extension pages' script/object/worker sources beyond these.
        const directives = parseCsp(policy);
        for (const directive of ['script-src', 'object-src', 'worker-src']) {
            const sources = directives.get(directive) ?? directives.get('default-src');
            const disallowed = (sources || []).filter((source) =>
                !["'self'", "'none'", "'wasm-unsafe-eval'"].includes(source) &&
                !/^http:\/\/(localhost|127\.0\.0\.1)(:(\d+|\*))?$/.test(source));
            if (disallowed.length) {
                errors.push(`content_security_policy.extension_pages ${directive} allows ${disallowed.join(' ')}; MV3 only permits 'self', 'none', 'wasm-unsafe-eval' and localhost there`);
            }
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

/**
 * HTML named character references the packager decodes: every ASCII
 * punctuation reference plus nbsp. Others are reported by unknownEntities()
 * rather than guessed, so a URL attribute never resolves to the wrong file.
 */
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', sol: '/', bsol: '\\', colon: ':', semi: ';',
    comma: ',', period: '.', excl: '!', quest: '?', num: '#', dollar: '$', percnt: '%', commat: '@', ast: '*',
    midast: '*', plus: '+', equals: '=', lowbar: '_', hyphen: '-', dash: '-', lpar: '(', rpar: ')', lsqb: '[',
    lbrack: '[', rsqb: ']', rbrack: ']', lcub: '{', lbrace: '{', rcub: '}', rbrace: '}', verbar: '|', vert: '|',
    tilde: '~', grave: '`', Hat: '^', Tab: '\t', NewLine: '\n'
};

// Numeric references decode with or without the ';' (as the HTML parser does); named ones need it.
const decodeEntities = (text) => text.replace(/&(?:(#[xX][0-9a-fA-F]+|#\d+);?|([A-Za-z][A-Za-z0-9]*);)/g, (whole, numeric, named) => {
    const ref = numeric ?? named;
    if (ref[0] === '#') {
        const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
        return code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : '\uFFFD';
    }
    return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : whole;
});

/** Named references in raw attribute text that decodeEntities leaves undecoded. */
const unknownEntities = (raw) => [...raw.matchAll(/&([A-Za-z][A-Za-z0-9]*);/g)]
    .map((m) => m[1])
    .filter((name) => !Object.hasOwn(NAMED_ENTITIES, name));

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

/** Index just past the CSS escape starting at css[j] ('\\'): 1-6 hex digits plus one optional whitespace, or one character. */
function cssEscapeEnd(css, j) {
    let k = j + 1;
    if (!/[0-9a-f]/i.test(css[k] || '')) return Math.min(k + 1, css.length);
    const start = k;
    while (k < css.length && k - start < 6 && /[0-9a-f]/i.test(css[k])) k++;
    if (css[k] === '\r' && css[k + 1] === '\n') return k + 2;
    return /[ \t\n\f\r]/.test(css[k] || '') ? k + 1 : k;
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
    let importsAllowed = true; // @import only counts before any other rule (after @charset/@layer statements)
    let skipPrelude = false; // inside an @namespace or an ignored @import: its url() is not a fetch
    const directive = () => (pendingImport ? 'style-src' : fontFaceDepth !== -1 ? 'font-src' : 'img-src');
    const push = (url) => {
        if (url && !skipPrelude) refs.push({ url, directive: directive() });
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
            if (depth === 0) importsAllowed = false;
            skipPrelude = false;
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
            skipPrelude = false;
            i++;
        } else if (c === '@') {
            // An at-keyword may contain escapes (@\\69 mport is @import).
            let j = i + 1;
            while (j < css.length && (css[j] === '\\' || /[\w\-\u0080-\uFFFF]/.test(css[j]))) j = css[j] === '\\' ? cssEscapeEnd(css, j) : j + 1;
            const keyword = cssUnescape(css.slice(i + 1, j)).toLowerCase();
            if (keyword === 'import') {
                // Browsers ignore an @import after other rules or nested in a block.
                if (importsAllowed && depth === 0) pendingImport = true;
                else skipPrelude = true;
            } else if (keyword === 'namespace') {
                importsAllowed = false;
                skipPrelude = true; // @namespace url(...) names a namespace; nothing is fetched
            } else if (keyword !== 'charset' && keyword !== 'layer') {
                importsAllowed = false;
            }
            if (keyword === 'font-face') pendingFontFace = true;
            i = Math.max(j, i + 1);
        } else if (c === '(') {
            functions.push('');
            i++;
        } else if (c === ')') {
            functions.pop();
            i++;
        } else if (c === '\\' || /[A-Za-z_\-\u0080-￿]/.test(c)) {
            let j = i;
            while (j < css.length && (css[j] === '\\' || /[\w\-\u0080-￿]/.test(css[j]))) j = css[j] === '\\' ? cssEscapeEnd(css, j) : j + 1;
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
                            const end = cssEscapeEnd(css, k);
                            raw += css.slice(k, end);
                            k = end;
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
export function scanHtml(html, { scripting = true } = {}) {
    // With scripting enabled (every extension page, and sandbox pages that allow
    // scripts), <noscript> content is text, not markup.
    const textElements = scripting ? new Set([...TEXT_ELEMENTS, 'noscript']) : TEXT_ELEMENTS;
    // Open svg/math subtrees: inside them elements are foreign, and raw-text/RCDATA rules
    // (title, style, script, ...) don't apply, except under an HTML integration point
    // (svg foreignObject/desc/title, math annotation-xml), where HTML parsing resumes.
    const foreign = []; // [{ name, html: boolean }]
    const inHtml = () => foreign.length === 0 || foreign[foreign.length - 1].html;
    const tags = [];
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) break;
        if (html.startsWith('<!--', lt)) {
            // <!--> and <!---> are abruptly closed empty comments; --!> also closes one.
            if (html.startsWith('<!-->', lt)) {
                i = lt + 5;
                continue;
            }
            if (html.startsWith('<!--->', lt)) {
                i = lt + 6;
                continue;
            }
            const close = /--!?>/g;
            close.lastIndex = lt + 4;
            const end = close.exec(html);
            i = end ? end.index + end[0].length : html.length;
            continue;
        }
        const next = html[lt + 1] || '';
        if (next === '/' && /[A-Za-z]/.test(html[lt + 2] || '')) {
            // An end tag: pop the foreign-content stack back to the matching element.
            const m = /^<\/([^\s/>]+)/.exec(html.slice(lt, lt + 64));
            const endName = m[1].toLowerCase();
            const at = foreign.map((frame) => frame.name).lastIndexOf(endName);
            if (at !== -1) foreign.length = at;
            const end = html.indexOf('>', lt + 2);
            i = end === -1 ? html.length : end + 1;
            continue;
        }
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
        const raw = new Map();
        let selfClosing = false;
        while (j < html.length && html[j] !== '>') {
            if (html[j] === '/' && html[j + 1] === '>') selfClosing = true;
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
            if (!attrs.has(attr)) {
                attrs.set(attr, decodeEntities(value));
                raw.set(attr, value);
            }
        }
        i = j + 1;
        const htmlContext = inHtml();
        const tag = { name, attrs, raw, foreign: !htmlContext, line: html.slice(0, lt).split('\n').length };
        if (!selfClosing) {
            if (htmlContext && (name === 'svg' || name === 'math')) {
                foreign.push({ name, html: false });
            } else if (!htmlContext) {
                const integrationPoint = ['foreignobject', 'desc', 'title', 'annotation-xml'].includes(name);
                foreign.push({ name, html: integrationPoint });
            }
        }
        if (htmlContext && textElements.has(name)) {
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
function htmlRefs(html, inheritedBase = null, scripting = true) {
    const urls = [];
    const problems = [];
    const inline = [];
    const inlineScripts = [];
    const classicScripts = [];
    const styles = [];
    let base = null; // the first <base href>, which applies to everything after it
    const currentBase = () => base?.href ?? inheritedBase;
    const add = (url, directive) => {
        if (url && url.trim()) urls.push({ url: url.trim(), directive, base: currentBase() });
    };
    for (const tag of scanHtml(html, { scripting })) {
        const { name, attrs, line } = tag;
        for (const attr of ['src', 'href', 'xlink:href', 'srcset', 'data', 'poster']) {
            const unknown = attrs.has(attr) ? unknownEntities(tag.raw.get(attr)) : [];
            if (unknown.length) {
                problems.push(`line ${line}: <${name} ${attr}> uses HTML character reference(s) the packager can't decode (${unknown.map((n) => `&${n};`).join(' ')}); write the characters literally`);
            }
        }
        for (const attr of attrs.keys()) {
            if (/^on./.test(attr)) inline.push({ kind: 'handler', desc: `line ${line}: inline event handler ${attr}= on <${name}>` });
        }
        if (attrs.has('style')) styles.push(attrs.get('style'));
        const src = attrs.get('src');
        const href = attrs.get('href');
        if (tag.foreign && attrs.has('href') && !attrs.get('href').trim().startsWith('#')) {
            // SVG 2 href: image/feImage fetch an image, script a script; use/a etc. just refer.
            add(href, name === 'image' || name === 'feimage' ? 'img-src' : name === 'script' ? 'script-src' : null);
        }
        if (attrs.has('xlink:href')) {
            // SVG's legacy xlink:href: <image> and <feImage> load images, <script> a script, others (use, a) just refer.
            const directive = name === 'image' || name === 'feimage' ? 'img-src' : name === 'script' ? 'script-src' : null;
            const target = attrs.get('xlink:href');
            if (!target.trim().startsWith('#')) add(target, directive);
        }
        switch (tag.foreign ? '' : name) {
            case 'script': {
                const type = (attrs.get('type') || '').trim();
                if (!JS_TYPES.test(type)) break; // a data block, not a script
                if (src !== undefined) {
                    add(src, 'script-src');
                    if (type.toLowerCase() !== 'module' && src.trim()) classicScripts.push({ url: src.trim(), base: currentBase() });
                } else if (tag.text.trim()) {
                    inline.push({ kind: 'script', desc: `line ${line}: inline <script>`, text: tag.text, nonce: attrs.get('nonce') ?? null });
                    inlineScripts.push({ text: tag.text, module: type.toLowerCase() === 'module', line, base: currentBase() });
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
                if (attrs.has('srcdoc')) {
                    // srcdoc is a nested document: same CSP, relative URLs against this page's base.
                    const nested = htmlRefs(attrs.get('srcdoc'), currentBase(), scripting);
                    urls.push(...nested.urls);
                    problems.push(...nested.problems.map((item) => `line ${line} srcdoc ${item}`));
                    inlineScripts.push(...nested.inlineScripts.map((script) => ({ ...script, line: `${line} srcdoc line ${script.line}` })));
                    classicScripts.push(...nested.classicScripts);
                    inline.push(...nested.inline.map((item) => ({ ...item, desc: `line ${line} srcdoc ${item.desc}` })));
                    if (nested.inlineStyles) styles.push('');
                }
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
                if (!base && href !== undefined && href.trim()) base = { href: href.trim(), line };
                break;
                case '':
                break; // foreign (SVG/MathML) element: handled above
            case '':
                // a foreign (SVG/MathML) element: its href was handled above
                add(src, null);
                break;
            default:
                // a, area and anything else: a navigation or unknown use; check local targets exist.
                add(src, null);
                add(href, null);
        }
    }
    for (const css of styles) urls.push(...cssRefs(css).map((ref) => ({ ...ref, base: currentBase() })));
    return { urls, problems, inline, inlineScripts, classicScripts, inlineStyles: styles.length > 0, base };
}

// CSP ---------------------------------------------------------------------------

/** Chrome's default extension-pages CSP for MV3 when the manifest sets none. */
const DEFAULT_MV3_CSP = "script-src 'self'; object-src 'self';";

/** Chrome's default CSP for manifest sandbox pages. */
const DEFAULT_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';";

/** Whether <base href> is allowed: base-uri has no default-src fallback. */
function baseUriAllows(csp, href, local) {
    const sources = csp?.get('base-uri');
    if (!sources) return true;
    if (local) return sources.includes("'self'");
    return cspAllows(new Map([['base-uri', sources]]), 'base-uri', href);
}

const CSP_FALLBACKS = { 'frame-src': ['child-src', 'default-src'] };

/** Lower-cases a CSP source's keyword, scheme and host, keeping any path's case (paths match case-sensitively). */
const normalizeSource = (source) => {
    // Nonce and hash values are case-sensitive base64: lower-case only their prefix.
    const token = /^'(nonce|sha256|sha384|sha512)-(.*)'$/i.exec(source);
    if (token) return `'${token[1].toLowerCase()}-${token[2]}'`;
    if (source.startsWith("'")) return source.toLowerCase();
    const m = /^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/]*)(\/.*)?$/i.exec(source);
    return m ? m[1].toLowerCase() + (m[2] ?? '') : source;
};

/** Parses a CSP string into Map(directive -> sources), names lower-cased. */
export function parseCsp(policy) {
    const directives = new Map();
    for (const part of String(policy).split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
        if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources.map(normalizeSource));
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
    return sources.some((source) => sourceMatches(source, parsed));
}

/** Whether one CSP source expression matches a parsed absolute URL (keywords never match here). */
function sourceMatches(source, parsed) {
    const scheme = parsed.protocol;
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
    } else if (!port && parsed.port !== '') {
        return false; // no port in the source: only the scheme's default port matches
    }
    if (path) {
        let sourcePath = path;
        try {
            sourcePath = decodeURIComponent(path);
        } catch {
            // keep the raw path
        }
        const pathname = decodeURIComponent(parsed.pathname);
        if (sourcePath.endsWith('/') ? !pathname.startsWith(sourcePath) : pathname !== sourcePath) return false;
    }
    return true;
}

/**
 * Whether the CSP lets a page load the extension's own file `path` under
 * `directive`: 'self', the chrome-extension: scheme, or a chrome-extension://
 * source whose host and path match the file's URL.
 */
function cspAllowsSelf(csp, directive, path, extensionId) {
    const sources = sourcesFor(csp, directive);
    if (!sources) return true;
    const url = new URL(`chrome-extension://${extensionId || 'unknown-extension-id'}/${path.split('/').map(encodeURIComponent).join('/')}`);
    return sources.some((source) => source === "'self'" || source === 'chrome-extension:' ||
        (source.startsWith('chrome-extension://') && sourceMatches(source, url)));
}

/** The extension ID Chrome derives from a manifest `key` (sha256 of the public key, first 16 bytes as a-p). */
export function extensionIdFromKey(key) {
    if (typeof key !== 'string' || !key) return null;
    const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

/** Whether one inline <script> may run: 'unsafe-inline' (when no nonce/hash disables it), a matching nonce, or a matching hash. */
function inlineScriptAllowed(csp, { text, nonce }) {
    const sources = sourcesFor(csp, 'script-src');
    if (!sources) return true;
    if (cspAllowsInline(csp, 'script-src')) return true;
    if (nonce && sources.includes(`'nonce-${nonce}'`)) return true;
    return sources.some((source) => {
        const m = /^'(sha256|sha384|sha512)-(.+)'$/.exec(source);
        return Boolean(m) && createHash(m[1]).update(text, 'utf8').digest('base64') === m[2];
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
export function extractRefs(file, text, { classic = false, csp = null, scripting = true, extensionId = null } = {}) {
    const result = { refs: [], uses: [], external: [], errors: [], dynamicImports: 0, classicScripts: [], inline: [], inlineStyles: false };
    const kind = (/\.(html?|m?js|css)$/i.exec(file)?.[1] || '').toLowerCase();
    let baseUsable = true;
    // Resolves url (relative to `base` when a <base href> applies) to a local path or an absolute URL.
    const locate = (url, base) => {
        const trimmed = url.trim();
        if (base && baseUsable && !isExternal(trimmed)) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(base)) {
                try {
                    return { external: new URL(trimmed, base).href };
                } catch {
                    return {};
                }
            }
            const resolvedBase = resolveRef(file, base) ?? '.';
            const baseDir = base.endsWith('/') ? resolvedBase.replace(/\/$/, '') || '.' : posix.dirname(resolvedBase);
            return { local: resolveRef(posix.join(baseDir, '_'), trimmed) };
        }
        const local = resolveRef(file, trimmed);
        if (local) return { local };
        // A scheme-relative URL takes the page's scheme: chrome-extension://.
        if (trimmed.startsWith('//')) return { external: `chrome-extension:${trimmed}` };
        return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? { external: trimmed } : {};
    };
    // chrome-extension://<this extension's id>/path is one of our own files.
    const ownPrefix = extensionId ? `chrome-extension://${extensionId}/` : null;
    const ownPath = (url) => {
        if (!ownPrefix || !url.toLowerCase().startsWith(ownPrefix)) return null;
        try {
            return posix.normalize(decodeURIComponent(new URL(url).pathname).replace(/^\//, ''));
        } catch {
            return null;
        }
    };
    const add = ({ url, directive, base = null }) => {
        const located = locate(url, base);
        const local = located.local ?? (located.external ? ownPath(located.external) : null);
        const external = local ? null : located.external;
        if (local) {
            result.refs.push(local);
            if (directive) result.uses.push({ path: local, directive });
        } else if (external && directive) {
            if (/^chrome-extension:\/\//i.test(external) && !ownPrefix) {
                result.errors.push(`${file}: ${external} can't be checked without a manifest key (the extension ID is unknown)`);
            } else if (/^(https?|wss?|data|blob|chrome-extension):/i.test(external)) {
                result.external.push({ url: external, directive });
            } else {
                result.errors.push(`${file}: ${external} uses a URL scheme an extension page can't load (${directive})`);
            }
        }
    };
    // Module specifiers: relative/absolute paths and http(s)/data/blob/chrome-extension URLs only.
    function addSpecifiers(label, specifiers, base) {
        for (const specifier of specifiers) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !/^(https?|data|blob|chrome-extension):/i.test(specifier)) {
                result.errors.push(`${label}: module specifier "${specifier}" uses a scheme Chrome can't import (e.g. node: built-ins don't exist in an extension)`);
            } else if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
                add({ url: specifier, directive: 'script-src', base });
            } else {
                result.errors.push(`${label}: bare module specifier "${specifier}" cannot be loaded by an unbundled extension`);
            }
        }
    }
    if (kind === 'html' || kind === 'htm') {
        const page = htmlRefs(text, null, scripting);
        result.errors.push(...page.problems.map((item) => `${file} ${item}`));
        if (page.base) {
            const local = !/^[a-z][a-z0-9+.-]*:/i.test(page.base.href);
            if (!baseUriAllows(csp, page.base.href, local)) {
                baseUsable = false;
                result.errors.push(`${file} line ${page.base.line}: <base href="${page.base.href}"> is blocked by the manifest CSP (base-uri), so Chrome ignores it; remove it`);
            }
        }
        page.urls.forEach(add);
        // Inline scripts: check what they import (they run where the page's CSP allows inline script).
        for (const script of page.inlineScripts) {
            const label = `${file} (inline script, line ${script.line})`;
            const dynamic = dynamicImports(label, script.text);
            result.errors.push(...dynamic.errors);
            let statics = [];
            try {
                if (script.module) statics = staticImports(label, script.text);
                else new vm.Script(script.text, { filename: label });
            } catch (error) {
                result.errors.push(script.module ? error.message : `${label} doesn't compile as a classic script: ${error.message}`);
            }
            addSpecifiers(label, [...statics, ...dynamic.specifiers], script.base);
        }
        result.inline = page.inline;
        result.inlineStyles = page.inlineStyles;
        result.classicScripts = page.classicScripts.map(({ url, base }) => locate(url, base).local).filter(Boolean);
    } else if (kind === 'js' || kind === 'mjs') {
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
        addSpecifiers(file, [...statics, ...dynamic.specifiers], null);
    } else if (kind === 'css') {
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
    const sandboxPolicy = manifest.content_security_policy?.sandbox;
    const sandboxCsp = parseCsp(typeof sandboxPolicy === 'string' ? sandboxPolicy : DEFAULT_SANDBOX_CSP);
    const sandboxPages = new Set((Array.isArray(manifest.sandbox?.pages) ? manifest.sandbox.pages : [])
        .filter((page) => typeof page === 'string')
        .map((page) => posix.normalize(page.replace(/^\//, ''))));
    // Sandboxed pages get their own CSP; every other page runs under extension_pages.
    const cspFor = (file) => (sandboxPages.has(file) ? sandboxCsp : csp);
    // Scripting is on in sandbox pages unless their CSP's sandbox directive omits allow-scripts.
    const scriptingFor = (file) => !sandboxPages.has(file) || !sandboxCsp.has('sandbox') || sandboxCsp.get('sandbox').includes('allow-scripts');
    const isPage = (file) => /\.html?$/i.test(file);
    const extensionId = extensionIdFromKey(manifest.key);
    const read = (file) => readFileSync(join(root, file), 'utf8');

    // Pages first: they decide which scripts run as classic scripts.
    const results = new Map();
    for (const file of files.filter(isPage)) {
        results.set(file, extractRefs(file, read(file), { csp: cspFor(file), scripting: scriptingFor(file), extensionId }));
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
        if (!/\.(html?|m?js|css)$/i.test(file)) continue;
        edges.set(file, []);
        let result = results.get(file);
        if (!result) {
            try {
                result = extractRefs(file, read(file), { classic: classic.has(file), extensionId });
            } catch (error) {
                errors.push(error.message);
                continue;
            }
        }
        errors.push(...result.errors);
        if (result.dynamicImports > 0) usesDynamicImport.add(file);
        for (const ref of result.refs) note(file, ref);
        results.set(file, result);
        if (!isPage(file)) continue;
        const pageCsp = cspFor(file);
        const policyName = sandboxPages.has(file) ? 'sandbox CSP' : 'manifest CSP';
        for (const item of result.inline) {
            const allowed = item.kind === 'script' ? inlineScriptAllowed(pageCsp, item) : cspAllowsInline(pageCsp, 'script-src');
            if (!allowed) {
                errors.push(`${file} ${item.desc}: the ${policyName} blocks inline script (MV3 extension pages never run it); move it to a file`);
            }
        }
        if (result.inlineStyles && !cspAllowsInline(pageCsp, 'style-src')) {
            errors.push(`${file} uses inline styles (style= or <style>), which the ${policyName} blocks: style-src has no 'unsafe-inline'`);
        }
    }
    // Each file's loads are checked under the CSP of every page context that reaches it:
    // a page's own policy, and for stylesheets/modules the policies of the pages loading them
    // (a sandbox page's stylesheet runs under the sandbox CSP). Files no page reaches
    // (the service worker, content scripts) are checked under extension_pages.
    const contexts = new Map();
    for (const page of files.filter((f) => isPage(f) && edges.has(f))) {
        const context = sandboxPages.has(page) ? 'sandbox' : 'extension';
        const stack = [page];
        const seen = new Set();
        while (stack.length) {
            const file = stack.pop();
            if (seen.has(file)) continue;
            seen.add(file);
            if (!contexts.has(file)) contexts.set(file, new Set());
            contexts.get(file).add(context);
            for (const next of edges.get(file) || []) {
                if (!isPage(next)) stack.push(next); // a link to another page is a navigation, with that page's own context
            }
        }
    }
    for (const [file, result] of results) {
        const fileContexts = isPage(file)
            ? [sandboxPages.has(file) ? 'sandbox' : 'extension']
            : [...(contexts.get(file) || ['extension'])];
        for (const context of fileContexts) {
            const policyCsp = context === 'sandbox' ? sandboxCsp : csp;
            const policyName = context === 'sandbox' ? 'sandbox CSP' : 'manifest CSP';
            for (const { url, directive } of result.external) {
                if (/^(https?|wss?|data|blob):/i.test(url) && !cspAllows(policyCsp, directive, url)) {
                    errors.push(`${file} loads ${url}, which the ${policyName} blocks (${directive})`);
                }
            }
            for (const { path, directive } of result.uses) {
                if (!cspAllowsSelf(policyCsp, directive, path, extensionId)) {
                    errors.push(`${file} loads ${path}, which the ${policyName} blocks (${directive} doesn't allow 'self')`);
                }
            }
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
