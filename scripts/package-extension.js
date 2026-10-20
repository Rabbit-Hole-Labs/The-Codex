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
 *   A page's <meta> CSPs apply too, and nonces, hashes and 'strict-dynamic'
 *   are honored. Subresource Integrity metadata must match the packaged file.
 *   HTML is parsed with parse5 (the HTML Standard's parser, which browsers
 *   implement) and CSS with a small tokenizer that follows the CSS syntax
 *   rules, so text that only looks like markup isn't a reference.
 * - The output directory may not sit inside a packaged directory.
 * - Deterministic: sorted entries and fixed timestamps. Rebuilding with the
 *   same Node/zlib build gives a byte-identical zip; across machines compare
 *   the printed content digest (per-file SHA-256s), which ignores zlib. Text
 *   files must be checked out with LF line endings for digests to match CI.
 * - The manifest `key` is kept by default so an unpacked load of the package
 *   keeps the published extension ID and its chrome.storage.sync data (see
 *   CLAUDE.md). Pass --strip-key to build a copy without it.
 *
 * Needs `npm ci` (for parse5) and --experimental-vm-modules for V8's module
 * parser (`npm run package` sets it).
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
import { parse as parseHtml } from 'parse5';

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

/**
 * Chrome's match-pattern grammar for content scripts: <all_urls>, or
 * <scheme>://<host><path> with scheme *, http, https or ftp (a host of *, *.name
 * or name, with an optional port), file:// with an optional host, or urn:...
 */
const validMatchPattern = (pattern) => pattern === '<all_urls>' ||
    /^(\*|https?|ftp):\/\/(\*|(\*\.)?[^/*:[\]]+|\[[0-9A-Fa-f:.]+\])(:(\*|\d{1,5}))?\/.*$/.test(pattern) ||
    /^file:\/\/(\*|(\*\.)?[^/*:]+)?\/.*$/.test(pattern) ||
    /^urn:.+$/.test(pattern);

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
    const options = manifest.options_ui;
    if (options && typeof options === 'object' && !Array.isArray(options)) {
        if (manifest.manifest_version === 3 && options.chrome_style === true) errors.push("options_ui.chrome_style can't be used with manifest_version 3");
        // Chrome drops a malformed options_ui (an install warning), falling back to options_page if any.
        const broken = typeof options.page !== 'string' || !options.page.trim() ? 'has no page'
            : 'open_in_tab' in options && typeof options.open_in_tab !== 'boolean' ? 'has a non-boolean open_in_tab'
                : 'chrome_style' in options && typeof options.chrome_style !== 'boolean' ? 'has a non-boolean chrome_style' : null;
        if (broken && !(typeof manifest.options_page === 'string' && manifest.options_page.trim())) {
            errors.push(`options_ui ${broken}, so Chrome ignores it and the extension has no options page`);
        }
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
            } else if (/[^\t\f\x20-\x2b\x2d-\x7e]/.test(value)) {
                // Chrome refuses such a manifest (csp_validator.cc ContentSecurityPolicyIsLegal).
                errors.push(`content_security_policy.${member} contains a character Chrome rejects (only tab, form feed and printable ASCII other than "," are allowed)`);
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
    const dnr = manifest.declarative_net_request;
    if (dnr && typeof dnr === 'object' && !Array.isArray(dnr)) {
        const resources = dnr.rule_resources;
        if (!Array.isArray(resources)) {
            errors.push('declarative_net_request.rule_resources must be an array');
        } else {
            const ids = new Set();
            resources.forEach((resource, index) => {
                const ok = resource && typeof resource === 'object' && typeof resource.id === 'string' && resource.id &&
                    typeof resource.enabled === 'boolean' && typeof resource.path === 'string' && resource.path;
                if (!ok) errors.push(`declarative_net_request.rule_resources[${index}] needs a string id, a boolean enabled and a string path`);
                else if (ids.has(resource.id)) errors.push(`declarative_net_request.rule_resources[${index}] repeats the ruleset id "${resource.id}"`);
                else ids.add(resource.id);
            });
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
            for (const key of ['matches', 'exclude_matches']) {
                if (!Array.isArray(entry[key])) continue;
                entry[key].forEach((pattern, n) => {
                    if (typeof pattern === 'string' && !validMatchPattern(pattern)) {
                        errors.push(`content_scripts[${index}].${key}[${n}] "${pattern}" isn't a match pattern (<scheme>://<host><path> or <all_urls>)`);
                    }
                });
            }
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
    if (manifest.manifest_version === 3 && manifest.background && typeof manifest.background === 'object' &&
        !Array.isArray(manifest.background) && typeof manifest.background.service_worker !== 'string') {
        errors.push('background.service_worker is required in MV3');
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

/** Strips the ASCII whitespace browsers strip around URLs (not U+00A0 and other Unicode spaces). */
const asciiTrim = (value) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');

/** Resolves a reference relative to the referencing file; null for external refs. */
export function resolveRef(fromFile, ref, { rootRelative = false } = {}) {
    const trimmed = asciiTrim(ref);
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
    let customDepth = -1; // inside a custom property's value (--x: ...) declared at this block depth
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
    // A url() in a custom property resolves where var() substitutes it, so it is flagged `custom`.
    const custom = () => (customDepth !== -1 ? { custom: true } : {});
    const push = (url) => {
        if (url && !skipPrelude) refs.push({ url, directive: directive(), ...custom() });
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
            if (fn === 'image-set' || fn === '-webkit-image-set') refs.push({ url: value, directive: 'img-src', ...custom() });
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
            if (depth < customDepth) customDepth = -1;
            i++;
        } else if (c === ';') {
            if (depth === customDepth) customDepth = -1;
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
            if (name.startsWith('--') && functions.length === 0 && customDepth === -1) {
                let k = j;
                while (k < css.length && /\s/.test(css[k])) k++;
                if (css[k] === ':') customDepth = depth; // a custom property declaration
            }
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

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The elements of an HTML document in tree order, as parse5 (the HTML
 * Standard's parser, which browsers implement) builds them: character
 * references decoded, SVG/MathML namespaces and breakouts applied, raw-text
 * elements' content kept as text. Template contents are included, since a
 * script can clone them into the page.
 * @returns {Array<{ name: string, attrs: Map<string, string>, ns: 'html' | 'svg' | 'math',
 *   foreign: boolean, line: number, text: string, parent: string | null }>}
 */
export function scanHtml(html, { scripting = true } = {}) {
    const tags = [];
    const visit = (node) => {
        for (const child of node.childNodes ?? []) {
            if (!child.tagName) continue;
            const attrs = new Map();
            for (const attr of child.attrs) attrs.set((attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase(), attr.value);
            const ns = child.namespaceURI === HTML_NS ? 'html' : child.namespaceURI === SVG_NS ? 'svg' : 'math';
            tags.push({
                name: child.tagName.toLowerCase(), // parse5 keeps SVG's camelCase names (foreignObject)
                attrs,
                ns,
                foreign: ns !== 'html',
                line: child.sourceCodeLocation?.startLine ?? 1,
                text: child.childNodes.filter((n) => n.nodeName === '#text').map((n) => n.value).join(''),
                parent: node.tagName ?? null
            });
            visit(child.content ?? child); // a <template>'s children live in its content fragment
        }
    };
    visit(parseHtml(html, { scriptingEnabled: scripting, sourceCodeLocationInfo: true }));
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

/** Elements whose legacy background attribute is a background image (HTML's rendering rules; Chrome adds col and colgroup). */
const BACKGROUND_ELEMENTS = new Set(['body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup']);

/** Splits on ASCII whitespace, as HTML does for token lists (rel, sandbox, ping, integrity). */
const asciiTokens = (value) => (value ?? '').split(/[\t\n\f\r ]+/).filter(Boolean);

/**
 * What an HTML page loads, as { url, directive } items (directive is the CSP
 * directive governing the fetch, or null for navigations and hints), plus the
 * inline scripts, handlers and styles the CSP must allow, inline import maps,
 * which <script src> files run as classic scripts, and the page's <meta> CSPs.
 * Each item carries the <meta> policies in effect where it appears.
 */
function htmlRefs(html, inheritedBase = null, scripting = true, inheritedPolicies = []) {
    const urls = [];
    const problems = [];
    const inline = [];
    const inlineScripts = [];
    const importMaps = [];
    const classicScripts = [];
    const styleItems = []; // inline styles for the CSP check: { kind: 'block' | 'attr', text, nonce?, policies }
    const styles = []; // CSS whose url()s load once styles apply
    const deferred = []; // loads made after parsing (background=, pings), against the document's base URL
    const policies = [...inheritedPolicies]; // <meta> CSPs so far: each applies to what follows it
    let base = null; // the first <base href>, which applies to everything after it
    const currentBase = () => base?.href ?? inheritedBase;
    const add = (url, directive, extra = {}) => {
        if (url && asciiTrim(url)) urls.push({ url: asciiTrim(url), directive, base: currentBase(), policies: [...policies], ...extra });
    };
    const markClassic = (src) => {
        if (src !== undefined && asciiTrim(src)) classicScripts.push({ url: asciiTrim(src), base: currentBase() });
    };
    // Following a link POSTs to each of its ping URLs (hyperlink auditing, under connect-src).
    const ping = (value) => asciiTokens(value).forEach((url) => deferred.push({ url, directive: 'connect-src', ping: true }));
    for (const tag of scanHtml(html, { scripting })) {
        const { name, attrs, line, text } = tag;
        const here = [...policies];
        const nonce = attrs.get('nonce') ?? null;
        if (scripting) {
            for (const attr of attrs.keys()) {
                if (/^on./.test(attr)) inline.push({ kind: 'handler', desc: `line ${line}: inline event handler ${attr}= on <${name}>`, text: attrs.get(attr), policies: here });
            }
        }
        if (attrs.has('style')) {
            styles.push(attrs.get('style'));
            styleItems.push({ kind: 'attr', text: attrs.get('style'), policies: here });
        }
        const src = attrs.get('src');
        const href = attrs.get('href');
        if (attrs.has('formaction')) add(attrs.get('formaction'), 'form-action'); // button/input submit target
        if (tag.foreign) {
            // SVG 2 href (or the legacy xlink:href, which href overrides): image and feImage load an
            // image, script a script; use, a and the rest refer to their target.
            const target = href ?? attrs.get('xlink:href');
            if (name === 'script') {
                if (!scripting) continue;
                if (target === undefined && text.trim()) {
                    problems.push(`line ${line}: inline <script> inside <svg> isn't supported by the packager; load it from a file`);
                }
            }
            if (name === 'style' && tag.ns === 'svg') {
                styles.push(text);
                styleItems.push({ kind: 'block', text, nonce, policies: here });
            }
            if (target !== undefined && !asciiTrim(target).startsWith('#')) {
                if (name === 'script') add(target, 'script-src', { parserInserted: true, nonce });
                else add(target, name === 'image' || name === 'feimage' ? 'img-src' : null);
            }
            if (name === 'a' && tag.ns === 'svg' && target !== undefined) ping(attrs.get('ping'));
            add(src, null);
            continue;
        }
        switch (name) {
            case 'script': {
                const type = asciiTrim(attrs.get('type') ?? '');
                if (!JS_TYPES.test(type)) break; // a data block, not a script
                const module = /^module$/i.test(type);
                if (/^importmap$/i.test(type)) {
                    if (!scripting) break;
                    if (src !== undefined) {
                        problems.push(`line ${line}: <script type="importmap" src> is ignored by Chrome (import maps must be inline)`);
                    } else if (text !== '') { // an empty one is skipped before anything is parsed
                        inline.push({ kind: 'script', desc: `line ${line}: inline import map`, text, nonce, policies: here });
                        importMaps.push({ text, line, base: currentBase(), policies: here });
                    }
                    break;
                }
                if (!scripting || (!module && attrs.has('nomodule'))) {
                    // Never fetched or run: scripting is off (a sandbox without allow-scripts), or it is a
                    // nomodule script, which Chrome skips because it runs modules. A file stays classic.
                    if (!module) markClassic(src);
                    break;
                }
                if (src !== undefined) {
                    add(src, 'script-src', { parserInserted: true, nonce, integrity: attrs.get('integrity'), line });
                    if (!module) markClassic(src);
                } else if (text.trim()) {
                    inline.push({ kind: 'script', desc: `line ${line}: inline <script>`, text, nonce, policies: here });
                    inlineScripts.push({ text, module, line, base: currentBase() });
                }
                break;
            }
            case 'style': {
                const type = asciiTrim(attrs.get('type') ?? '').toLowerCase();
                if (type !== '' && type !== 'text/css') break; // not CSS, so never applied
                styles.push(text);
                styleItems.push({ kind: 'block', text, nonce, policies: here });
                break;
            }
            case 'link': {
                const rel = asciiTokens(attrs.get('rel')?.toLowerCase());
                const as = asciiTrim(attrs.get('as') ?? '').toLowerCase();
                const type = asciiTrim(attrs.get('type') ?? '').toLowerCase();
                const integrity = { nonce, integrity: attrs.get('integrity'), line };
                if (rel.includes('stylesheet')) {
                    // Only a CSS sheet is fetched, and an integrity mismatch makes Chrome drop it.
                    if (type === '' || type === 'text/css') add(href, 'style-src', integrity);
                    else add(href, null);
                } else if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
                    add(href, 'img-src');
                } else if (rel.includes('modulepreload')) {
                    // Fetched into the module map (as=script only): an integrity mismatch breaks later imports.
                    if (as === '' || as === 'script') add(href, 'script-src', integrity);
                    else add(href, null);
                } else if (rel.includes('preload')) {
                    // A preload's integrity isn't checked: a mismatch only wastes the preload.
                    add(href, PRELOAD_DIRECTIVES[as] ?? null);
                } else if (rel.includes('manifest')) {
                    add(href, 'manifest-src');
                } else if (!rel.includes('preconnect') && !rel.includes('dns-prefetch')) {
                    add(href, null);
                }
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
                if (name === 'iframe' && attrs.has('srcdoc')) {
                    // srcdoc is a nested document: it inherits this page's policies and base URL, and
                    // runs no script when the iframe's sandbox lacks allow-scripts.
                    const sandboxed = attrs.has('sandbox') && !asciiTokens(attrs.get('sandbox').toLowerCase()).includes('allow-scripts');
                    const nested = htmlRefs(attrs.get('srcdoc'), currentBase(), scripting && !sandboxed, here);
                    urls.push(...nested.urls);
                    problems.push(...nested.problems.map((item) => `line ${line} srcdoc ${item}`));
                    inlineScripts.push(...nested.inlineScripts.map((script) => ({ ...script, line: `${line} srcdoc line ${script.line}` })));
                    importMaps.push(...nested.importMaps.map((map) => ({ ...map, line: `${line} srcdoc line ${map.line}` })));
                    classicScripts.push(...nested.classicScripts);
                    inline.push(...nested.inline.map((item) => ({ ...item, desc: `line ${line} srcdoc ${item.desc}` })));
                    styleItems.push(...nested.inlineStyles);
                }
                break;
            case 'object':
                add(attrs.get('data'), 'object-src');
                break;
            case 'embed':
                add(src, 'object-src');
                break;
            case 'input':
                if (asciiTrim(attrs.get('type') ?? '').toLowerCase() === 'image') add(src, 'img-src');
                break;
            case 'base':
                if (!base && href !== undefined && asciiTrim(href)) base = { href: asciiTrim(href), line, policies: here };
                break;
            case 'form':
                add(attrs.get('action'), 'form-action');
                break;
            case 'meta': {
                const equiv = asciiTrim(attrs.get('http-equiv') ?? '').toLowerCase();
                if (equiv === 'refresh') {
                    // <meta http-equiv="refresh" content="N; url=target"> navigates to target.
                    const m = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?(["']?)(.*?)\1\s*$/i.exec(attrs.get('content') || '');
                    if (m && m[2]) add(m[2], null);
                } else if (equiv === 'content-security-policy' && tag.parent === 'head' && attrs.has('content')) {
                    policies.push(attrs.get('content')); // enforced with the page's own policy from here on
                }
                break;
            }
            default:
                // a, area and anything else: a navigation or unknown use; check local targets exist.
                if (BACKGROUND_ELEMENTS.has(name) && asciiTrim(attrs.get('background') ?? '')) {
                    deferred.push({ url: asciiTrim(attrs.get('background')), directive: 'img-src' });
                }
                add(src, null);
                add(href, null);
                if ((name === 'a' || name === 'area') && href !== undefined) ping(attrs.get('ping'));
        }
    }
    // Styles, legacy backgrounds and pings load once the page is parsed: against the document's
    // base URL, under every <meta> policy.
    for (const item of deferred) urls.push({ ...item, base: currentBase(), policies: [...policies] });
    for (const css of styles) urls.push(...cssRefs(css).map((ref) => ({ ...ref, base: currentBase(), policies: [...policies] })));
    return { urls, problems, inline, inlineScripts, importMaps, classicScripts, inlineStyles: styleItems, base, policies };
}

// CSP ---------------------------------------------------------------------------

/** Chrome's default extension-pages CSP for MV3 when the manifest sets none. */
const DEFAULT_MV3_CSP = "script-src 'self'; object-src 'self';";

/**
 * Chrome enforces script-src 'self' and object-src 'self' on extension pages even
 * when a custom policy omits them, so a missing directive (with no default-src)
 * gets that minimum instead of meaning "unrestricted".
 */
function withMinimumCsp(directives) {
    for (const directive of ['script-src', 'object-src']) {
        if (!directives.has(directive) && !directives.has('default-src')) directives.set(directive, ["'self'"]);
    }
    return directives;
}

/** Chrome's default CSP for manifest sandbox pages. */
const DEFAULT_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';";

/** Whether <base href> is allowed: base-uri has no default-src fallback. */
function baseUriAllows(csp, href, local) {
    const sources = csp?.get('base-uri');
    if (!sources) return true;
    if (local) return sources.includes("'self'");
    return cspAllows(new Map([['base-uri', sources]]), 'base-uri', href);
}

/**
 * Directive lookup order. Script and style loads here are element loads, so the
 * -elem directive applies first; inline attributes (on*=, style=) use -attr.
 */
const CSP_FALLBACKS = {
    'script-src': ['script-src-elem', 'script-src', 'default-src'],
    'style-src': ['style-src-elem', 'style-src', 'default-src'],
    'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
    'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
    'frame-src': ['frame-src', 'child-src', 'default-src'],
    'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
    'form-action': ['form-action'] // no default-src fallback
};

/** CSP directive for each <link rel=preload as=...> destination. */
const PRELOAD_DIRECTIVES = {
    image: 'img-src', script: 'script-src', style: 'style-src', font: 'font-src', fetch: 'connect-src',
    audio: 'media-src', video: 'media-src', track: 'media-src', document: 'frame-src', embed: 'object-src',
    object: 'object-src', worker: 'worker-src', sharedworker: 'worker-src'
};

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
    const name = (CSP_FALLBACKS[directive] ?? [directive, 'default-src']).find((d) => csp.has(d));
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
    // A lone '*' matches HTTP(S) and WS(S) URLs and the page's own scheme, chrome-extension: here
    // (CSP3; Chrome includes ws/wss). data:, blob: and other schemes must be listed.
    if (source === '*') return /^(https?|wss?|chrome-extension):$/.test(scheme);
    if (/^[a-z][a-z0-9+.-]*:$/.test(source)) {
        return source === scheme || (source === 'http:' && scheme === 'https:') || (source === 'ws:' && scheme === 'wss:');
    }
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^/:]+)(?::(\d+|\*))?(\/.*)?$/.exec(source);
    if (!m) return false;
    const [, sourceScheme, host, port, path] = m;
    // A source without a scheme matches only the protected page's scheme, chrome-extension: here.
    const upgrade = (sourceScheme === 'http' && scheme === 'https:') || (sourceScheme === 'ws' && scheme === 'wss:');
    if (sourceScheme ? `${sourceScheme}:` !== scheme && !upgrade : scheme !== 'chrome-extension:') {
        return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (host.startsWith('*.') ? !hostname.endsWith(host.slice(1)) : host !== '*' && hostname !== host) return false;
    if (port && port !== '*') {
        const effective = parsed.port || ({ 'https:': '443', 'http:': '80', 'wss:': '443', 'ws:': '80' })[scheme] || '';
        // An insecure source's port 80 also matches the upgraded scheme's 443 (CSP3, as Chrome does).
        if (effective !== port && !(upgrade && port === '80' && effective === '443')) return false;
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
    return sources.some((source) => source === "'self'" || source === '*' || source === 'chrome-extension:' ||
        (source.startsWith('chrome-extension://') && sourceMatches(source, url)));
}

/** The extension ID Chrome derives from a manifest `key` (sha256 of the public key, first 16 bytes as a-p). */
export function extensionIdFromKey(key) {
    if (typeof key !== 'string' || !key) return null;
    const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

/**
 * Whether one piece of inline content may run or apply under `directive`:
 * 'unsafe-inline' (unless a nonce or hash source disables it), a matching nonce
 * (elements only), or a matching hash (attributes also need 'unsafe-hashes').
 */
function inlineAllowed(csp, directive, { text, nonce = null, attribute = false }) {
    const sources = sourcesFor(csp, directive);
    if (!sources) return true;
    // A nonce or hash source (or, for scripts, 'strict-dynamic') makes Chrome ignore 'unsafe-inline'.
    const overridden = sources.some((source) => /^'(nonce|sha(256|384|512))-/.test(source)) ||
        (directive.startsWith('script-src') && sources.includes("'strict-dynamic'"));
    if (sources.includes("'unsafe-inline'") && !overridden) return true;
    if (!attribute && nonce && sources.includes(`'nonce-${nonce}'`)) return true;
    if (attribute && !sources.includes("'unsafe-hashes'")) return false;
    return typeof text === 'string' && sources.some((source) => {
        const m = /^'(sha256|sha384|sha512)-(.+)'$/.exec(source);
        return Boolean(m) && createHash(m[1]).update(text, 'utf8').digest('base64') === m[2];
    });
}

/** A <meta>-delivered CSP: parsed like the manifest's, minus what <meta> can't set (CSP3). */
const metaPolicies = new Map();
function parseMetaCsp(text) {
    if (!metaPolicies.has(text)) {
        const directives = parseCsp(text);
        for (const name of ['frame-ancestors', 'report-uri', 'sandbox']) directives.delete(name);
        metaPolicies.set(text, directives);
    }
    return metaPolicies.get(text);
}

/**
 * Whether one load is allowed under `csp`: a local file (`path`) or an absolute
 * `url`, under its directive. A matching nonce allows a script or stylesheet
 * element; with 'strict-dynamic', a <script> the parser inserted needs that
 * nonce, while scripts that trusted scripts load (imports) are allowed.
 */
function loadAllowed(csp, { directive, url = null, path = null, nonce = null, parserInserted = false }, extensionId) {
    const sources = sourcesFor(csp, directive);
    if (!sources) return true;
    const script = directive === 'script-src';
    if (nonce && (script || directive === 'style-src') && sources.includes(`'nonce-${nonce}'`)) return true;
    if (script && sources.includes("'strict-dynamic'")) return !parserInserted;
    return path !== null ? cspAllowsSelf(csp, directive, path, extensionId) : cspAllows(csp, directive, url);
}

/** Chrome's Subresource Integrity algorithm prefixes (lower case only) and the hash each names. */
const SRI_ALGORITHMS = [['sha256', 'sha256'], ['sha-256', 'sha256'], ['sha384', 'sha384'], ['sha-384', 'sha384'], ['sha512', 'sha512'], ['sha-512', 'sha512']];

/**
 * Why Chrome refuses `bytes` under Subresource Integrity `metadata`, or null if
 * it accepts them. Follows Chromium's parser: lower-case algorithm names only,
 * unknown algorithms ignored, a digest is any run of base64/base64url characters
 * (padding optional), and only the strongest algorithm listed counts.
 */
function integrityProblem(metadata, bytes) {
    const hashes = [];
    for (const token of asciiTokens(metadata)) {
        if (token.startsWith('ed25519-')) return 'asks for an ed25519 signature, which a packaged file never carries, so Chrome refuses to load it';
        const known = SRI_ALGORITHMS.find(([name]) => token.startsWith(`${name}-`));
        const digest = known ? token.slice(known[0].length + 1).split('?')[0] : '';
        if (/^[A-Za-z0-9+/=_-]+$/.test(digest)) hashes.push({ algorithm: known[1], digest });
    }
    if (!hashes.length) return null;
    const strongest = ['sha512', 'sha384', 'sha256'].find((algorithm) => hashes.some((hash) => hash.algorithm === algorithm));
    const actual = createHash(strongest).update(bytes).digest();
    const matches = hashes.some(({ algorithm, digest }) => {
        const base64 = digest.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
        return algorithm === strongest && !base64.includes('=') && base64.length % 4 !== 1 && Buffer.from(base64, 'base64').equals(actual);
    });
    return matches ? null : `doesn't match its ${strongest} digest, so Chrome refuses to load it`;
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
    return mod.moduleRequests
        ? mod.moduleRequests.map((request) => ({ specifier: request.specifier, type: request.attributes?.type }))
        : mod.dependencySpecifiers.map((specifier) => ({ specifier, type: undefined }));
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
 * @returns {{ refs: string[], uses: object[], external: object[], errors: string[], dynamicImports: number,
 *   classicScripts: string[], inline: object[], inlineStyles: object[], integrity: object[], policies: string[] }}
 *   refs are root-relative local paths. uses (local files) and external (absolute URLs) are loads, each
 *   with the CSP directive governing it, its nonce, whether the parser inserted it (a <script> in the
 *   markup) and the <meta> CSPs in effect there. classicScripts, inline, inlineStyles and policies (the
 *   page's <meta> CSPs) are for pages; integrity lists Subresource Integrity metadata to verify.
 */
export function extractRefs(file, text, { classic = false, csp = null, scripting = true, extensionId = null } = {}) {
    const result = { refs: [], uses: [], external: [], errors: [], dynamicImports: 0, classicScripts: [], inline: [], inlineStyles: [], integrity: [], policies: [] };
    const kind = (/\.(html?|m?js|css)$/i.exec(file)?.[1] || '').toLowerCase();
    let baseUsable = true;
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
    // A <base href> as either a local directory or an external base URL (scheme-relative takes chrome-extension:).
    const baseInfo = (base) => {
        const trimmedBase = asciiTrim(base);
        const href = trimmedBase.startsWith('//') ? `chrome-extension:${trimmedBase}` : trimmedBase;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            const own = ownPath(href);
            if (own === null) return { externalBase: href };
            return { localDir: own.endsWith('/') ? own.replace(/\/$/, '') || '.' : posix.dirname(own) };
        }
        const resolvedBase = resolveRef(file, href) ?? '.';
        return { localDir: href.endsWith('/') ? resolvedBase.replace(/\/$/, '') || '.' : posix.dirname(resolvedBase) };
    };
    // Resolves url (against `base` when a <base href> applies) to a local path or an absolute URL.
    // A #fragment-only URL names part of the document itself and loads nothing, except for pings
    // (`fragments`), which resolve it like any other URL.
    const locate = (url, base, fragments = false) => {
        const trimmed = asciiTrim(url);
        if (trimmed.startsWith('#') && !fragments) return {};
        if (base && baseUsable && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
            const info = baseInfo(base);
            if (info.externalBase) {
                try {
                    return { external: new URL(trimmed, info.externalBase).href };
                } catch {
                    return {};
                }
            }
            if (!isExternal(trimmed)) return { local: resolveRef(posix.join(info.localDir, '_'), trimmed) };
        }
        const local = resolveRef(file, trimmed);
        if (local) return { local };
        // A scheme-relative URL takes the page's scheme: chrome-extension://.
        if (trimmed.startsWith('//')) return { external: `chrome-extension:${trimmed}` };
        return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? { external: trimmed } : {};
    };
    const add = ({ url, directive, base = null, policies = [], nonce = null, parserInserted = false, integrity, line, ping = false, custom = false }) => {
        if (custom && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(asciiTrim(url))) {
            // Chrome resolves it against whichever stylesheet uses the property through var().
            result.errors.push(`${file}: url(${asciiTrim(url)}) in a custom property resolves where var() uses it, so it can't be checked; use a root-relative (/...) or absolute URL`);
            return;
        }
        const located = locate(url, base, ping);
        if (ping && !/^https?:/i.test(located.external ?? '')) return; // only HTTP(S) URLs are pinged
        const local = located.local ?? (located.external ? ownPath(located.external) : null);
        const external = local ? null : located.external;
        const load = { directive, policies, nonce, parserInserted };
        if (local) {
            result.refs.push(local);
            if (directive) result.uses.push({ path: local, ...load });
            if (integrity !== undefined) result.integrity.push({ path: local, integrity, line });
        } else if (external && directive) {
            if (/^chrome-extension:\/\//i.test(external) && !ownPrefix) {
                result.errors.push(`${file}: ${external} can't be checked without a manifest key (the extension ID is unknown)`);
            } else if (/^(https?|wss?|data|blob|chrome-extension):/i.test(external)) {
                result.external.push({ url: external, ...load });
            } else {
                result.errors.push(`${file}: ${external} uses a URL scheme an extension page can't load (${directive})`);
            }
        }
    };
    // Module specifiers: relative/absolute paths and http(s)/data/blob/chrome-extension URLs only.
    // A packaged target must be JavaScript, or JSON/CSS imported with that type attribute.
    function addSpecifiers(label, entries, base) {
        for (const entry of entries) {
            const { specifier, type } = typeof entry === 'string' ? { specifier: entry, type: undefined } : entry;
            const isPath = specifier.startsWith('.') || specifier.startsWith('/') || /^chrome-extension:/i.test(specifier);
            const located = isPath ? locate(specifier, base) : {};
            const target = located.local ?? (located.external ? ownPath(located.external) : null);
            const expected = type === 'json' ? /\.json$/i : type === 'css' ? /\.css$/i : /\.m?js$/i;
            if (target && !expected.test(target)) {
                result.errors.push(`${label}: module "${specifier}" resolves to ${target}, which Chrome's module loader rejects (not ${type ? `a ${type} module` : 'JavaScript'})`);
            }
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
            const local = baseInfo(page.base.href).localDir !== undefined;
            const blocking = [[csp, 'manifest CSP'], ...page.base.policies.map((meta) => [parseMetaCsp(meta), '<meta> CSP'])]
                .find(([policy]) => policy && !baseUriAllows(policy, page.base.href, local));
            if (blocking) {
                baseUsable = false;
                result.errors.push(`${file} line ${page.base.line}: <base href="${page.base.href}"> is blocked by the ${blocking[1]} (base-uri), so Chrome ignores it; remove it`);
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
        // Inline import maps: JSON that Chrome rejects whole when a member has the wrong type, and
        // whose bad entries become null mappings that block the imports they name.
        const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
        const urlLike = (value) => /^(\/|\.\.?\/|[a-z][a-z0-9+.-]*:)/i.test(value);
        for (const map of page.importMaps) {
            const label = `${file} (import map, line ${map.line})`;
            let parsed;
            try {
                parsed = JSON.parse(map.text);
            } catch (error) {
                result.errors.push(`${label} is not valid JSON, so Chrome rejects it: ${error.message}`);
                continue;
            }
            const fatal = !isObject(parsed) ? 'must be a JSON object'
                : 'imports' in parsed && !isObject(parsed.imports) ? '"imports" must be an object'
                    : 'scopes' in parsed && !(isObject(parsed.scopes) && Object.values(parsed.scopes).every(isObject)) ? '"scopes" must be an object of objects'
                        : 'integrity' in parsed && !isObject(parsed.integrity) ? '"integrity" must be an object' : null;
            if (fatal) {
                result.errors.push(`${label}: ${fatal}, so Chrome rejects the map`);
                continue;
            }
            const specifierMaps = [['imports', parsed.imports ?? {}], ...Object.entries(parsed.scopes ?? {}).map(([scope, entries]) => [`scopes["${scope}"]`, entries])];
            for (const [where, entries] of specifierMaps) {
                for (const [key, address] of Object.entries(entries)) {
                    if (key === '') continue; // ignored
                    const problem = typeof address !== 'string' ? 'is not a string'
                        : !urlLike(address) ? 'is not a URL or a /, ./ or ../ path'
                            : key.endsWith('/') && !address.endsWith('/') ? 'must end in "/" like its key' : null;
                    if (problem) result.errors.push(`${label}: ${where}["${key}"] ${problem}, so Chrome blocks imports of "${key}"`);
                    else if (!address.endsWith('/')) add({ url: address, directive: 'script-src', base: map.base, policies: map.policies });
                }
            }
            for (const [key, metadata] of Object.entries(parsed.integrity ?? {})) {
                if (typeof metadata !== 'string' || !urlLike(key)) continue; // ignored by Chrome
                const located = locate(key, map.base);
                const local = located.local ?? (located.external ? ownPath(located.external) : null);
                if (local) result.integrity.push({ path: local, integrity: metadata, line: map.line });
            }
        }
        result.inline = page.inline;
        result.inlineStyles = page.inlineStyles;
        result.policies = page.policies;
        result.classicScripts = page.classicScripts.map(({ url, base }) => {
            const located = locate(url, base);
            return located.local ?? (located.external ? ownPath(located.external) : null);
        }).filter(Boolean);
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
    const csp = withMinimumCsp(parseCsp(typeof policy === 'string' ? policy : DEFAULT_MV3_CSP));
    const sandboxPolicy = manifest.content_security_policy?.sandbox;
    const sandboxCsp = parseCsp(typeof sandboxPolicy === 'string' ? sandboxPolicy : DEFAULT_SANDBOX_CSP);
    const sandboxPages = new Set((Array.isArray(manifest.sandbox?.pages) ? manifest.sandbox.pages : [])
        .filter((page) => typeof page === 'string')
        .map((page) => posix.normalize(page.replace(/^\//, ''))));
    // Sandboxed pages get their own CSP; every other page runs under extension_pages.
    const cspFor = (file) => (sandboxPages.has(file) ? sandboxCsp : csp);
    const policyNameFor = (file) => (sandboxPages.has(file) ? 'sandbox CSP' : 'manifest CSP');
    // A page's policies at one point: its own CSP plus the <meta> CSPs in effect there.
    const policiesAt = (page, metas) => [[cspFor(page), policyNameFor(page)], ...metas.map((meta) => [parseMetaCsp(meta), `<meta> CSP in ${page}`])];
    // Scripting is on in sandbox pages unless their CSP's sandbox directive omits allow-scripts.
    const scriptingFor = (file) => !sandboxPages.has(file) || !sandboxCsp.has('sandbox') || sandboxCsp.get('sandbox').includes('allow-scripts');
    const isPage = (file) => /\.html?$/i.test(file);
    const extensionId = extensionIdFromKey(manifest.key);
    const read = (file) => readFileSync(join(root, file), 'utf8');
    // The bytes Chrome serves for a packaged file: it fills in __MSG_ placeholders in stylesheets
    // (null when they depend on the locale, so the served bytes can't be known here).
    const servedBytes = (path) => {
        const bytes = readFileSync(join(root, path));
        if (!/\.css$/i.test(path)) return bytes;
        const latin1 = bytes.toString('latin1');
        const placeholders = latin1.match(/__MSG_[A-Za-z0-9_@]+__/g) ?? [];
        if (!placeholders.length) return bytes;
        if (!extensionId || placeholders.some((placeholder) => placeholder !== '__MSG_@@extension_id__')) return null;
        return Buffer.from(latin1.replaceAll('__MSG_@@extension_id__', extensionId), 'latin1');
    };

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
        for (const { path, integrity, line } of result.integrity) {
            if (!packaged.has(path)) continue; // reported as missing above
            const bytes = servedBytes(path);
            const problem = bytes ? integrityProblem(integrity, bytes) : "can't be pinned: Chrome fills in the file's locale-dependent __MSG_ placeholders";
            if (problem) errors.push(`${file} line ${line}: integrity="${integrity}" for ${path} ${problem}`);
        }
        results.set(file, result);
        if (!isPage(file)) continue;
        for (const item of result.inline) {
            const blocked = policiesAt(file, item.policies).find(([pagePolicy]) => !(item.kind === 'script'
                ? inlineAllowed(pagePolicy, 'script-src', item)
                : inlineAllowed(pagePolicy, 'script-src-attr', { text: item.text, attribute: true })));
            if (blocked) {
                errors.push(`${file} ${item.desc}: the ${blocked[1]} blocks inline script (MV3 extension pages never run it); move it to a file`);
            }
        }
        const blockedStyle = result.inlineStyles.map((item) => policiesAt(file, item.policies).find(([pagePolicy]) => (item.kind === 'block'
            ? !inlineAllowed(pagePolicy, 'style-src', item)
            : !inlineAllowed(pagePolicy, 'style-src-attr', { text: item.text, attribute: true })))).find(Boolean);
        if (blockedStyle) {
            errors.push(`${file} uses inline styles (style= or <style>), which the ${blockedStyle[1]} blocks: style-src has no 'unsafe-inline'`);
        }
    }
    // Each file's loads are checked under the policies of every page context that reaches it.
    // A page's own loads: its CSP plus the <meta> CSPs in effect where each appears. The
    // stylesheets and modules a page loads: its CSP plus all its <meta> CSPs (they load after
    // parsing; a sandbox page's stylesheet runs under the sandbox CSP). Files no page reaches
    // (the service worker, content scripts) are checked under extension_pages.
    const contexts = new Map(); // file -> Map(context key -> [[policy, name], ...])
    for (const page of files.filter((f) => isPage(f) && edges.has(f))) {
        const metas = results.get(page)?.policies ?? [];
        const key = [policyNameFor(page), ...metas].join('\n');
        const context = policiesAt(page, metas);
        const stack = [page];
        const seen = new Set();
        while (stack.length) {
            const file = stack.pop();
            if (seen.has(file)) continue;
            seen.add(file);
            if (!contexts.has(file)) contexts.set(file, new Map());
            contexts.get(file).set(key, context);
            for (const next of edges.get(file) || []) {
                if (!isPage(next)) stack.push(next); // a link to another page is a navigation, with that page's own context
            }
        }
    }
    const extensionContext = [[csp, 'manifest CSP']];
    for (const [file, result] of results) {
        for (const load of [...result.external, ...result.uses]) {
            if (load.url && !/^(https?|wss?|data|blob|chrome-extension):/i.test(load.url)) continue;
            const policySets = isPage(file) ? [policiesAt(file, load.policies)] : [...(contexts.get(file)?.values() ?? [extensionContext])];
            for (const policySet of policySets) {
                const blocked = policySet.find(([loadPolicy]) => !loadAllowed(loadPolicy, load, extensionId));
                if (!blocked) continue;
                const reason = load.directive === 'script-src' && load.parserInserted && sourcesFor(blocked[0], 'script-src')?.includes("'strict-dynamic'")
                    ? "script-src has 'strict-dynamic', so a <script> in the markup needs a matching nonce"
                    : load.url ? load.directive : `${load.directive} doesn't allow 'self'`;
                errors.push(`${file} loads ${load.url ?? load.path}, which the ${blocked[1]} blocks (${reason})`);
            }
        }
    }
    // Static declarativeNetRequest rulesets: Chrome silently ignores invalid rules in a packed
    // extension, so check each file's shape (JSON array of rules with unique positive integer
    // ids, an action with a known type and a condition object).
    const RULE_ACTIONS = new Set(['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests']);
    for (const resource of Array.isArray(manifest.declarative_net_request?.rule_resources) ? manifest.declarative_net_request.rule_resources : []) {
        if (typeof resource?.path !== 'string') continue;
        const path = posix.normalize(resource.path.replace(/^\//, ''));
        if (!packaged.has(path)) continue; // reported as a missing reference above
        let rules;
        try {
            rules = JSON.parse(read(path));
        } catch (error) {
            errors.push(`${path}: declarativeNetRequest ruleset is not valid JSON (${error.message})`);
            continue;
        }
        if (!Array.isArray(rules)) {
            errors.push(`${path}: declarativeNetRequest ruleset must be a JSON array of rules`);
            continue;
        }
        const ruleIds = new Set();
        rules.forEach((rule, index) => {
            const where = `${path} rule ${index}`;
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return errors.push(`${where}: must be an object`);
            if (!Number.isInteger(rule.id) || rule.id < 1) errors.push(`${where}: id must be a positive integer`);
            else if (ruleIds.has(rule.id)) errors.push(`${where}: duplicate id ${rule.id}`);
            else ruleIds.add(rule.id);
            if ('priority' in rule && (!Number.isInteger(rule.priority) || rule.priority < 1)) errors.push(`${where}: priority must be a positive integer`);
            if (!rule.action || typeof rule.action !== 'object' || !RULE_ACTIONS.has(rule.action.type)) errors.push(`${where}: action.type must be one of ${[...RULE_ACTIONS].join(', ')}`);
            if (!rule.condition || typeof rule.condition !== 'object' || Array.isArray(rule.condition)) errors.push(`${where}: condition must be an object`);
            return undefined;
        });
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
    return { errors: [...new Set(errors)], warnings };
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
