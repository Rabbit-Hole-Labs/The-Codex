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
import { parse as parseHtml, parseFragment } from 'parse5';

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
    sandbox: (v) => (v.pages || []).filter((page) => typeof page !== 'string' || !page.includes('*')), // '*' entries are patterns
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
 * Chrome's match-pattern grammar for content scripts: <all_urls>, file://...,
 * uuid-in-package:..., or <scheme>://<host><path> with scheme *, http, https or
 * ftp and a host of *, *.name or name. A port (0-65535) needs a scheme with a
 * default port, so not '*'; ':*' is allowed for any.
 */
const validMatchPattern = (pattern) => {
    if (pattern === '<all_urls>' || /^file:\/\/./s.test(pattern) || /^uuid-in-package:(?!\/\/)./s.test(pattern)) return true;
    const m = /^(?<scheme>\*|https?|ftp):\/\/(?<host>\*|(\*\.)?[^/*:[\]]+|\[[0-9A-Fa-f:.]+\])(?::(?<port>\*|\d+))?\/.*$/s.exec(pattern);
    if (!m) return false;
    const { scheme, host, port } = m.groups;
    // The host must be a real host name (the URL parser rejects spaces and other forbidden characters).
    if (host !== '*' && !host.startsWith('[')) {
        try {
            if (!new URL(`http://${host.replace(/^\*\./, '')}/`).hostname) return false;
        } catch {
            return false;
        }
    }
    return port === undefined || port === '*' || (scheme !== '*' && Number(port) <= 65535);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Content-script match patterns and paths: a non-empty array of non-empty strings. */
const nonEmptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item);

/** Why one content_scripts entry is malformed, in the order Chrome would complain. */
function contentScriptProblems(entry, index) {
    if (!isPlainObject(entry)) return [`content_scripts[${index}] must be an object`];
    const problems = [];
    if (!nonEmptyStrings(entry.matches)) problems.push(`content_scripts[${index}].matches must be a non-empty array of match patterns`);
    for (const key of ['js', 'css']) {
        if (key in entry && !nonEmptyStrings(entry[key])) problems.push(`content_scripts[${index}].${key} must be a non-empty array of paths`);
    }
    if (!('js' in entry) && !('css' in entry)) problems.push(`content_scripts[${index}] needs js or css`);
    for (const key of ['matches', 'exclude_matches']) {
        if (!Array.isArray(entry[key])) continue;
        entry[key].forEach((pattern, n) => {
            if (typeof pattern === 'string' && !validMatchPattern(pattern)) {
                problems.push(`content_scripts[${index}].${key}[${n}] "${pattern}" isn't a match pattern (<scheme>://<host><path> or <all_urls>)`);
            }
        });
    }
    return problems;
}

/**
 * The manifest checks, in the order their errors are reported. Each pushes what it finds onto
 * `errors`; they are independent of one another.
 */
const MANIFEST_RULES = [
    function manifestVersion(manifest, errors) {
        if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
    },
    function name(manifest, errors) {
        if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
            errors.push('name is required');
        } else if (manifest.name.length > MAX_NAME_LENGTH) {
            errors.push(`name is ${manifest.name.length} characters; Chrome allows ${MAX_NAME_LENGTH}`);
        }
    },
    function version(manifest, errors) {
        if (typeof manifest.version !== 'string') {
            errors.push('version must be a string');
            return;
        }
        const parts = manifest.version.split('.');
        const valid = parts.length <= 4 &&
            parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535) &&
            parts.some((part) => part !== '0');
        if (!valid) {
            errors.push(`version "${manifest.version}" must be 1-4 dot-separated integers 0-65535, no leading zeros, not all zero`);
        }
    },
    function description(manifest, errors) {
        if ('description' in manifest && typeof manifest.description !== 'string') {
            errors.push('description must be a string');
        } else if (typeof manifest.description === 'string' && manifest.description.length > MAX_DESCRIPTION_LENGTH) {
            errors.push(`description is ${manifest.description.length} characters; the Web Store allows ${MAX_DESCRIPTION_LENGTH}`);
        }
    },
    function fieldShapes(manifest, errors) {
        const checks = { array: [Array.isArray, 'an array'], string: [(value) => typeof value === 'string', 'a string'], object: [isPlainObject, 'an object'] };
        for (const [key, shape] of Object.entries(FIELD_SHAPES)) {
            const [ok, expected] = checks[shape];
            if (key in manifest && !ok(manifest[key])) errors.push(`${key} must be ${expected}`);
        }
    },
    function optionsUi(manifest, errors) {
        const options = manifest.options_ui;
        if (!isPlainObject(options)) return;
        // Chrome drops a malformed options_ui (an install warning), falling back to options_page if any;
        // a well-formed one may not have chrome_style at all in MV3 (even false).
        const broken = typeof options.page !== 'string' || !options.page.trim() ? 'has no page'
            : 'open_in_tab' in options && typeof options.open_in_tab !== 'boolean' ? 'has a non-boolean open_in_tab'
                : 'chrome_style' in options && typeof options.chrome_style !== 'boolean' ? 'has a non-boolean chrome_style' : null;
        const parses = typeof options.page === 'string' && !['open_in_tab', 'chrome_style'].some((key) => key in options && typeof options[key] !== 'boolean');
        if (parses && manifest.manifest_version === 3 && 'chrome_style' in options) {
            errors.push("options_ui.chrome_style can't be used with manifest_version 3 (Chrome refuses it even when false)");
        } else if (broken && !(typeof manifest.options_page === 'string' && manifest.options_page.trim())) {
            errors.push(`options_ui ${broken}, so Chrome ignores it and the extension has no options page`);
        }
    },
    function mv2Leftovers(manifest, errors) {
        if (manifest.manifest_version !== 3) return;
        const background = manifest.background && typeof manifest.background === 'object' ? manifest.background : {};
        for (const field of ['scripts', 'page']) {
            if (field in background) errors.push(`background.${field} is MV2-only; MV3 uses background.service_worker`);
        }
        for (const key of ['browser_action', 'page_action']) {
            if (key in manifest) errors.push(`${key} is MV2-only; MV3 uses action`);
        }
    },
    function key(manifest, errors) {
        if (!('key' in manifest)) return;
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
    },
    function urlOverrides(manifest, errors) {
        const overrides = manifest.chrome_url_overrides;
        if (!isPlainObject(overrides)) return;
        const keys = Object.keys(overrides);
        if (keys.length !== 1 || !['newtab', 'history', 'bookmarks'].includes(keys[0])) {
            errors.push('chrome_url_overrides must override exactly one of newtab, history or bookmarks');
        } else if (typeof overrides[keys[0]] !== 'string' || !overrides[keys[0]].trim()) {
            errors.push(`chrome_url_overrides.${keys[0]} must be the path of the override page`);
        }
    },
    function cspMembers(manifest, errors) {
        const cspField = manifest.content_security_policy;
        if (!isPlainObject(cspField)) return;
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
    },
    function sandboxCsp(manifest, errors) {
        const policy = manifest.content_security_policy?.sandbox;
        if (typeof policy !== 'string') return;
        // Chrome requires a custom sandbox policy to keep the sandbox directive, without allow-same-origin.
        const sandboxDirectives = parseCsp(policy);
        if (!sandboxDirectives.has('sandbox')) {
            errors.push('content_security_policy.sandbox must include the sandbox directive');
        } else if (sandboxDirectives.get('sandbox').includes('allow-same-origin')) {
            errors.push('content_security_policy.sandbox may not use allow-same-origin');
        }
    },
    function permissions(manifest, errors) {
        for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
            if (key in manifest && !(Array.isArray(manifest[key]) && manifest[key].every((item) => typeof item === 'string' && item))) {
                errors.push(`${key} must be an array of strings`);
            }
        }
    },
    function ruleResources(manifest, errors) {
        const dnr = manifest.declarative_net_request;
        if (!isPlainObject(dnr)) return;
        const resources = dnr.rule_resources;
        if (!Array.isArray(resources)) {
            errors.push('declarative_net_request.rule_resources must be an array');
            return;
        }
        const ids = new Set();
        resources.forEach((resource, index) => {
            const ok = resource && typeof resource === 'object' && typeof resource.id === 'string' && resource.id &&
                typeof resource.enabled === 'boolean' && typeof resource.path === 'string' && resource.path;
            if (!ok) errors.push(`declarative_net_request.rule_resources[${index}] needs a string id, a boolean enabled and a string path`);
            else if (ids.has(resource.id)) errors.push(`declarative_net_request.rule_resources[${index}] repeats the ruleset id "${resource.id}"`);
            else ids.add(resource.id);
        });
    },
    function contentScripts(manifest, errors) {
        if (Array.isArray(manifest.content_scripts)) errors.push(...manifest.content_scripts.flatMap(contentScriptProblems));
    },
    function extensionPagesCsp(manifest, errors) {
        const policy = manifest.content_security_policy?.extension_pages;
        if (manifest.manifest_version !== 3 || typeof policy !== 'string') return;
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
    },
    function serviceWorker(manifest, errors) {
        if (manifest.manifest_version === 3 && isPlainObject(manifest.background) &&
            !(typeof manifest.background.service_worker === 'string' && manifest.background.service_worker.trim())) {
            errors.push('background.service_worker is required in MV3 (a non-empty path)');
        }
        if (manifest.background?.service_worker && manifest.background.type !== 'module') {
            errors.push('background.type must be "module": the packager checks JS files as ES modules');
        }
    },
    function locales(manifest, errors) {
        if ('default_locale' in manifest || /__MSG_\w+__/.test(JSON.stringify(manifest))) {
            errors.push('default_locale/__MSG_ strings are not supported by the packager yet (_locales/ is not packaged)');
        }
    },
    function unknownKeys(manifest, errors) {
        for (const key of Object.keys(manifest)) {
            if (!(key in PATH_FIELDS) && !NON_PATH_KEYS.has(key)) {
                errors.push(`manifest key "${key}" is not understood by the packager; add it to PATH_FIELDS or NON_PATH_KEYS in scripts/package-extension.js`);
            }
        }
    }
];

/** Checks the manifest fields Chrome and the Web Store validate on upload. */
export function validateManifest(manifest) {
    const errors = [];
    for (const rule of MANIFEST_RULES) rule(manifest, errors);
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

/** Strips ASCII whitespace from both ends (not U+00A0 and other Unicode spaces). */
const asciiTrim = (value) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');

/** What the URL parser ignores in a URL: C0 controls and spaces at either end, tabs and newlines anywhere. */
// eslint-disable-next-line no-control-regex -- C0 controls are exactly what the URL parser strips
const urlTrim = (value) => value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');

/** Resolves a reference relative to the referencing file; null for external refs. */
export function resolveRef(fromFile, ref, { rootRelative = false } = {}) {
    const trimmed = urlTrim(ref);
    if (!trimmed || isExternal(trimmed)) return null;
    let clean = trimmed.split(/[?#]/)[0];
    try {
        clean = decodeURIComponent(clean);
    } catch {
        // keep the raw path; a bad escape will fail the existence check
    }
    if (!clean) return null;
    // Like URL resolution, '..' can't climb above the extension's root.
    const aboveRoot = (path) => path.replace(/^(\.\.(\/|$))+/, '') || '.';
    if (clean.startsWith('/')) return aboveRoot(posix.normalize(clean.slice(1)));
    return aboveRoot(posix.normalize(rootRelative ? clean : posix.join(posix.dirname(fromFile), clean)));
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
export function cssRefs(css, options) {
    return cssScan(css, options).refs;
}

/** Index just past the CSS whitespace (space, tab, newline: ASCII only) starting at css[j]. */
function cssSpaceEnd(css, j) {
    let k = j;
    while (k < css.length && /[ \t\n]/.test(css[k])) k++;
    return k;
}

/** Index just past the CSS name (name characters and escapes) starting at css[j]. */
function cssNameEnd(css, j) {
    let k = j;
    while (k < css.length && (css[k] === '\\' || /[\w\-\u0080-￿]/.test(css[k]))) k = css[k] === '\\' ? cssEscapeEnd(css, k) : k + 1;
    return k;
}

/**
 * cssRefs plus the custom properties the CSS reads with var(): `uses` outside
 * custom properties, and `chains` ([holder, read] pairs) where one custom
 * property's value reads another, so its url()s resolve where the holder is used;
 * `registeredUrls` are properties an @property rule registers with a <url> syntax
 * (their url()s resolve where they are declared).
 */
export function cssScan(input, { declarations = false } = {}) {
    const css = input.replace(/\r\n?|\f/g, '\n'); // CSS preprocessing: CR, CRLF and FF are newlines
    const refs = [];
    const uses = new Set();
    const chains = [];
    const registeredUrls = new Set(); // @property rules whose syntax includes <url>
    let pendingProperty = null; // @property --name, before its block
    let property = null; // the @property block being read, at propertyDepth
    let propertyDepth = -1;
    let expectSyntax = false; // after "syntax" in that block: the next string is the syntax
    const functions = []; // open function names, innermost last ('' for a bare parenthesis)
    let depth = 0;
    let fontFaceDepth = -1;
    let pendingFontFace = false;
    let pendingImport = false;
    let customDepth = -1; // inside a custom property's value (--x: ...) declared at this block depth
    let customName = null;
    let declarationStart = true; // where a declaration may start: after '{', ';', '}' or at the start
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
    // A url() in a custom property resolves where var() substitutes it, so it names the property.
    const custom = () => (customDepth !== -1 ? { custom: customName } : {});
    const push = (url) => {
        if (url && !skipPrelude) refs.push({ url, directive: directive(), ...custom() });
        pendingImport = false;
    };

    // Token handlers: each reads the token starting at css[i] and returns the index just past it.
    const string = () => {
        declarationStart = false;
        const [value, end] = readString(i);
        if (expectSyntax) {
            if (/<url>/i.test(value)) registeredUrls.add(property);
            expectSyntax = false;
        }
        const fn = functions[functions.length - 1];
        if (fn === 'image-set' || fn === '-webkit-image-set') refs.push({ url: value, directive: 'img-src', ...custom() });
        else if (pendingImport && functions.length === 0) push(value);
        return end;
    };
    const openBlock = () => {
        if (depth === 0) importsAllowed = false;
        skipPrelude = false;
        depth++;
        if (pendingFontFace) {
            fontFaceDepth = depth;
            pendingFontFace = false;
        }
        if (pendingProperty) {
            property = pendingProperty;
            propertyDepth = depth;
            pendingProperty = null;
        }
        pendingImport = false;
        declarationStart = true;
        return i + 1;
    };
    const closeBlock = () => {
        if (depth === fontFaceDepth) fontFaceDepth = -1;
        if (depth === propertyDepth) {
            property = null;
            propertyDepth = -1;
        }
        depth = Math.max(0, depth - 1);
        if (depth < customDepth) customDepth = -1;
        declarationStart = true;
        return i + 1;
    };
    const semicolon = () => {
        if (depth === customDepth && functions.length === 0) customDepth = -1;
        expectSyntax = false;
        pendingProperty = null;
        declarationStart = true;
        pendingImport = false;
        pendingFontFace = false;
        skipPrelude = false;
        return i + 1;
    };
    const atKeyword = () => {
        declarationStart = false;
        // An at-keyword may contain escapes (@\\69 mport is @import).
        const j = cssNameEnd(css, i + 1);
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
        if (keyword === 'property') {
            const k = cssSpaceEnd(css, j);
            const name = cssUnescape(css.slice(k, cssNameEnd(css, k)));
            if (name.startsWith('--')) pendingProperty = name;
        }
        return Math.max(j, i + 1);
    };
    const openParen = () => {
        declarationStart = false;
        functions.push('');
        return i + 1;
    };
    const closeParen = () => {
        declarationStart = false;
        functions.pop();
        return i + 1;
    };
    // --name read inside var() (a use, or a chain inside another custom property's value), or
    // a custom property declaration (--x: ...), only where a declaration can start: inside a
    // block, or anywhere in a style attribute; not a selector such as .--primary:hover.
    const customProperty = (rawName, j) => {
        if (functions[functions.length - 1] === 'var') {
            if (customDepth === -1) uses.add(rawName);
            else chains.push([customName, rawName]);
        }
        if (declarationStart && functions.length === 0 && customDepth === -1 && (depth > 0 || declarations)) {
            let k = j;
            while (k < css.length && /\s/.test(css[k])) k++;
            if (css[k] === ':') {
                customDepth = depth;
                customName = rawName; // custom property names are case-sensitive
            }
        }
    };
    // url( "quoted" ): it must close after optional whitespace; anything else makes the value invalid.
    const quotedUrl = (k) => {
        const [value, end] = readString(k);
        if (css[cssSpaceEnd(css, end)] === ')') push(value);
        else pendingImport = false;
        const close = css.indexOf(')', end);
        return close === -1 ? css.length : close + 1;
    };
    // url(unquoted-token) ends at ')'; unescaped whitespace before other text, or a quote or '('
    // inside, makes it a bad-url (no fetch).
    const unquotedUrl = (start) => {
        let k = start;
        let raw = '';
        let bad = false;
        while (k < css.length && css[k] !== ')') {
            if (css[k] === '\\' && css[k + 1] !== '\n') {
                const end = cssEscapeEnd(css, k);
                raw += css.slice(k, end);
                k = end;
            } else if (/[ \t\n]/.test(css[k])) {
                // CSS whitespace is ASCII only: U+00A0 stays part of the URL.
                k = cssSpaceEnd(css, k);
                bad ||= css[k] !== ')';
            } else {
                bad ||= /["'(]/.test(css[k]);
                raw += css[k++];
            }
        }
        if (bad) pendingImport = false;
        else push(cssUnescape(raw));
        return k + 1;
    };
    const identifier = () => {
        const j = cssNameEnd(css, i);
        const rawName = cssUnescape(css.slice(i, j));
        const name = rawName.toLowerCase();
        if (property && depth === propertyDepth && name === 'syntax' && declarationStart && /^[ \t\n]*:/.test(css.slice(j, j + 64))) expectSyntax = true;
        if (rawName.startsWith('--')) customProperty(rawName, j);
        declarationStart = false;
        if (css[j] !== '(') return j;
        if (name !== 'url') {
            functions.push(name);
            return j + 1;
        }
        const k = cssSpaceEnd(css, j + 1);
        return css[k] === '"' || css[k] === "'" ? quotedUrl(k) : unquotedUrl(k);
    };
    const punctuation = new Map([['{', openBlock], ['}', closeBlock], [';', semicolon], ['@', atKeyword], ['(', openParen], [')', closeParen]]);
    const token = (c) => {
        if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            return end === -1 ? css.length : end + 2;
        }
        if (c === '"' || c === "'") return string();
        if (punctuation.has(c)) return punctuation.get(c)();
        if (c === '\\' || /[A-Za-z_\-\u0080-￿]/.test(c)) return identifier();
        if (!/\s/.test(c)) declarationStart = false;
        return i + 1;
    };
    while (i < css.length) i = token(css[i]);
    return { refs, uses, chains, registeredUrls };
}

// HTML --------------------------------------------------------------------------

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Elements parse5 keeps inside <select>: its legacy "in select" mode drops all others. */
const SELECT_KEPT = new Set(['option', 'optgroup', 'hr', 'script', 'template', 'select']);

/** One parse5 element as a scanHtml tag, its source location shifted into the whole document's. */
function tagRecord(child, parent, context) {
    const name = child.tagName.toLowerCase(); // parse5 keeps SVG's camelCase names (foreignObject)
    const location = child.sourceCodeLocation;
    const attrs = new Map();
    for (const attr of child.attrs) attrs.set((attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase(), attr.value);
    const ns = child.namespaceURI === HTML_NS ? 'html' : child.namespaceURI === SVG_NS ? 'svg' : 'math';
    return {
        name,
        attrs,
        ns,
        foreign: ns !== 'html',
        line: location ? location.startLine + context.lineDelta : context.line,
        offset: location ? location.startOffset + context.offsetDelta : context.offset,
        text: child.childNodes.filter((n) => n.nodeName === '#text').map((n) => n.value).join(''),
        inHead: context.inHead,
        inTemplate: context.inTemplate,
        parent: parent.tagName?.toLowerCase() ?? null
    };
}

/**
 * What scanHtml walks below one element: its children (a <template>'s live in its content
 * fragment), and for a <select> its source parsed again, minus the elements parse5 kept.
 */
function childWork(child, tag, context, source, options) {
    const location = child.sourceCodeLocation;
    const inner = { ...context, line: tag.line, offset: tag.offset, inHead: context.inHead || tag.name === 'head' };
    const work = [];
    if (child.content) {
        if (!context.skip) work.push({ node: child.content, context: { ...inner, inTemplate: true } });
    } else {
        work.push({ node: child, context: inner });
    }
    if (tag.name === 'select' && tag.ns === 'html' && location?.startTag && !context.skip) {
        const start = location.startTag.endOffset;
        const end = location.endTag?.startOffset ?? location.endOffset;
        work.push({
            node: parseFragment(source.slice(start, end), options),
            context: {
                ...inner,
                skip: SELECT_KEPT, // already in the tree (their descendants are not)
                offsetDelta: context.offsetDelta + start,
                lineDelta: context.lineDelta + location.startTag.endLine - 1
            }
        });
    }
    return work;
}

/**
 * The elements of an HTML document in source order, as parse5 (the HTML
 * Standard's parser, which browsers implement) builds them: character
 * references decoded, SVG/MathML namespaces and breakouts applied, raw-text
 * elements' content kept as text. Template contents are included (flagged
 * inTemplate), since a script can clone them into the page. Chrome parses
 * <select> contents like ordinary markup (customizable select), while parse5
 * still drops most of them, so each select's source is parsed again for them.
 * @returns {Array<{ name: string, attrs: Map<string, string>, ns: 'html' | 'svg' | 'math', foreign: boolean,
 *   line: number, offset: number, text: string, inHead: boolean, inTemplate: boolean, parent: string | null }>}
 */
export function scanHtml(html, { scripting = true } = {}) {
    const source = html.replace(/^\uFEFF/, ''); // a byte order mark is consumed by decoding, not parsed
    const options = { scriptingEnabled: scripting, sourceCodeLocationInfo: true };
    const tags = [];
    // An explicit stack, not recursion: Chrome accepts markup nested thousands deep.
    const stack = [{ node: parseHtml(source, options), context: { line: 1, offset: -1, lineDelta: 0, offsetDelta: 0, inHead: false, inTemplate: false, skip: null } }];
    while (stack.length) {
        const { node, context } = stack.pop();
        const work = [];
        for (const child of node.childNodes ?? []) {
            if (!child.tagName) continue;
            const tag = tagRecord(child, node, context);
            if (!context.skip?.has(tag.name)) tags.push(tag);
            work.push(...childWork(child, tag, context, source, options));
        }
        stack.push(...work.reverse());
    }
    // Source order: the parser moves some elements (foster parenting, <head>/<body> relocation),
    // but each takes effect when its tag is parsed.
    return tags.map((tag, index) => ({ tag, index }))
        .sort((a, b) => a.tag.offset - b.tag.offset || a.index - b.index)
        .map(({ tag }) => tag);
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
        // HTML splits on ASCII whitespace only: U+00A0 and other Unicode spaces stay in the URL.
        while (i < value.length && /[\t\n\f\r ,]/.test(value[i])) i++;
        const start = i;
        while (i < value.length && !/[\t\n\f\r ]/.test(value[i])) i++;
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

/**
 * A srcdoc's <base href> resolved against the base it inherits from its page (HTML's
 * fallback base URL): a relative path joins the inherited one; absolute URLs stand.
 */
function joinBase(inherited, href) {
    if (!inherited || !href || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return href;
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(inherited)) {
        try {
            return new URL(href, inherited.startsWith('//') ? `chrome-extension:${inherited}` : inherited).href;
        } catch {
            return href;
        }
    }
    if (href.startsWith('#') || href.startsWith('?') || href.startsWith('/')) return href.startsWith('/') ? href : inherited;
    return posix.join(inherited.endsWith('/') ? inherited : `${posix.dirname(inherited)}/`, href);
}

/** Classic-script MIME types; Chrome strips whitespace (vertical tab included) around the type first. */
const CLASSIC_JS_TYPES = /^(|(text|application)\/(x-)?(java|ecma)script|text\/(j|live)script|text\/javascript1\.[0-5])$/i;
const trimScriptType = (type) => type.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');

/**
 * Event-handler content attributes (on + name) that Chrome compiles as inline script: the
 * names in Blink's attribute-to-event maps (HTML, body/frameset, SVG, SMIL) and its
 * GlobalEventHandlers, WindowEventHandlers and media IDLs. Other on* attributes
 * (only, once) are ordinary attributes.
 */
const EVENT_HANDLER_ATTRIBUTES = new Set((
    'move openerchange rejectionhandled unhandledrejection encrypted waitingforkey enterpictureinpicture ' +
    'leavepictureinpicture ' +
    'abort afterprint animationcancel animationend animationiteration animationstart auxclick beforecopy ' +
    'beforecut beforefilter beforeinput beforematch beforepaste beforeprint beforetoggle beforeunload ' +
    'begin blur cancel canplay canplaythrough change click close command complete ' +
    'contentvisibilityautostatechange contextlost contextmenu contextrestored copy cuechange cut dblclick ' +
    'drag dragend dragenter dragexit dragleave dragover dragstart drop durationchange emptied end ended ' +
    'error focus focusin focusout formdata gotpointercapture hashchange input installresult invalid ' +
    'keydown keypress keyup languagechange load loadeddata loadedmetadata loadstart location ' +
    'lostpointercapture message messageerror mousedown mouseenter mouseleave mousemove mouseout mouseover ' +
    'mouseup mousewheel offline online orientationchange overscrollcancel overscrollchanging ' +
    'overscrollend overscrollstart pagehide pageshow paste pause play playing pointercancel pointerdown ' +
    'pointerenter pointerleave pointermove pointerout pointerover pointerrawupdate pointerup popstate ' +
    'progress promptaction promptdismiss ratechange repeat reset resize scroll scrollend scrollsnapchange ' +
    'scrollsnapchanging securitypolicyviolation seeked seeking select selectionchange selectstart ' +
    'slotchange sort stalled storage stream submit suspend timeupdate timezonechange toggle touchcancel ' +
    'touchend touchmove touchstart transitioncancel transitionend transitionrun transitionstart unload ' +
    'validationstatuschange volumechange waiting webkitanimationend webkitanimationiteration ' +
    'webkitanimationstart webkitfullscreenchange webkitfullscreenerror webkittransitionend wheel'
).split(' ').map((name) => `on${name}`));

/** SVG presentation attributes whose url() values Chrome fetches (checked in Chromium 147). */
const SVG_URL_ATTRIBUTES = ['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'cursor'];

/** Elements whose legacy background attribute is a background image (HTML's rendering rules; Chrome adds col and colgroup). */
const BACKGROUND_ELEMENTS = new Set(['body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup']);

/** The CSP directive of each <link rel=modulepreload as=...> destination Chrome fetches. */
const MODULEPRELOAD_DIRECTIVES = { '': 'script-src', script: 'script-src', style: 'style-src', json: 'connect-src' };

/** Splits on ASCII whitespace, as HTML does for token lists (rel, sandbox, ping). */
const asciiTokens = (value) => (value ?? '').split(/[\t\n\f\r ]+/).filter(Boolean);

/** Whether a style element or <link rel=stylesheet> type means CSS, as Chrome reads it. */
const isCssType = (type, { parameters = false } = {}) => {
    if (type === undefined) return true;
    // <link>: whitespace and MIME parameters are dropped; <style>: the value must be exact.
    const essence = parameters ? asciiTrim(type.split(';')[0]) : type;
    return /^(text\/css)?$/i.test(essence);
};

/**
 * What an HTML page loads, as { url, directive } items (directive is the CSP
 * directive governing the fetch, or null for navigations and hints), plus the
 * inline scripts, handlers and styles the CSP must allow, inline import maps,
 * which script files run as classic scripts, the page's <meta> CSPs, and what
 * its CSS needs to resolve custom properties. Each item carries the <meta>
 * policies in effect where it appears.
 */
function htmlRefs(html, inheritedBase = null, scripting = true, inheritedPolicies = []) {
    const urls = [];
    const problems = [];
    const inline = [];
    const inlineScripts = [];
    const importMaps = [];
    const classicScripts = [];
    const inertScripts = []; // script files a page names but never runs (no scripting, nomodule)
    const styleItems = []; // inline styles for the CSP check: { kind: 'block' | 'attr', text, nonce?, policies }
    const styles = []; // CSS whose url()s load once styles apply: { text, declarations }
    const deferred = []; // loads made after parsing (background=, pings), against the document's base URL
    const policies = [...inheritedPolicies]; // <meta> CSPs so far: each applies to what follows it
    const varUses = new Set(); // custom properties the page's CSS reads with var()
    const varChains = []; // [holder, read] custom property pairs (see cssScan)
    const pauses = []; // positions of parser-blocking scripts and stylesheets (they let styles apply)
    const srcdocs = []; // nested srcdoc documents: their custom property readers
    let firstModule = null; // line of the first module script: import maps after it can't be relied on
    const registeredUrls = new Set(); // custom properties registered with @property syntax "<url>"
    let base = null; // the first <base> with an href (an empty href keeps the fallback base)
    const currentBase = () => (base ? base.href || inheritedBase : inheritedBase);
    const add = (url, directive, extra = {}) => {
        if (url && urlTrim(url)) urls.push({ url, directive, base: currentBase(), policies: [...policies], fragments: true, order: urls.length, ...extra });
    };
    // A script file: classic ones compile as classic scripts. Inert ones (never run here) are
    // recorded apart: Chrome never fetches or compiles them.
    const markScript = (src, { classic = true, inert = false } = {}) => {
        if (src === undefined || !urlTrim(src)) return;
        if (classic) classicScripts.push({ url: src, base: currentBase() });
        if (inert) inertScripts.push({ url: src, base: currentBase() });
    };
    // Following a link POSTs to each of its ping URLs (hyperlink auditing, under connect-src).
    // Blink sends none when the value looks like dangling markup (a newline or tab with '<').
    const ping = (value) => {
        if (!value || (/[\t\n\r]/.test(value) && value.includes('<'))) return;
        asciiTokens(value).forEach((url) => deferred.push({ url, directive: 'connect-src', ping: true }));
    };
    const styleBlock = (text, nonce, here) => {
        styles.push({ text, declarations: false });
        styleItems.push({ kind: 'block', text, nonce, policies: here });
    };

    // Each element handler gets the tag and `at`: its position, the <meta> policies in effect
    // there (here), and its nonce, src and href attributes.

    // Attributes any element may carry: on* handlers, style=, and formaction on a submit control.
    const anyElement = ({ name, attrs, line, foreign }, { here }) => {
        if (scripting) {
            for (const attr of attrs.keys()) {
                if (EVENT_HANDLER_ATTRIBUTES.has(attr)) inline.push({ kind: 'handler', desc: `line ${line}: inline event handler ${attr}= on <${name}>`, text: attrs.get(attr), policies: here });
            }
        }
        if (attrs.has('style')) {
            styles.push({ text: attrs.get('style'), declarations: true });
            styleItems.push({ kind: 'attr', text: attrs.get('style'), policies: here });
        }
        // formaction is a submit target only on submit buttons and image/submit inputs.
        const controlType = (attrs.get('type') ?? '').toLowerCase();
        const submits = (name === 'button' && !['button', 'reset'].includes(controlType)) || (name === 'input' && ['submit', 'image'].includes(asciiTrim(controlType)));
        if (attrs.has('formaction') && !foreign && submits) add(attrs.get('formaction'), 'form-action');
    };
    // An SVG or MathML href that names a resource, not a #fragment of this document.
    const linkTarget = (target) => target !== undefined && !urlTrim(target).startsWith('#');
    // Presentation attributes take CSS values: url() in them loads a resource (an image load).
    const presentationStyles = ({ attrs }) => {
        for (const attr of SVG_URL_ATTRIBUTES) {
            if (attrs.has(attr)) styles.push({ text: attrs.get(attr), declarations: false });
        }
    };
    // SVG script types read like HTML's: module exact, a classic type trimmed, others are data.
    const svgScript = (tag, { nonce, src }, target) => {
        const { attrs, line, text } = tag;
        const module = /^module$/i.test(attrs.get('type') ?? '');
        if (!module && !CLASSIC_JS_TYPES.test(trimScriptType(attrs.get('type') ?? ''))) return;
        markScript(target, { classic: !module && scripting, inert: !scripting });
        if (!scripting) return;
        if (module && firstModule === null) firstModule = line;
        if (target === undefined && text.trim()) {
            problems.push(`line ${line}: inline <script> inside <svg> isn't supported by the packager; load it from a file`);
        }
        presentationStyles(tag);
        if (linkTarget(target)) add(target, 'script-src', { parserInserted: true, nonce, integrity: attrs.get('integrity'), line, cors: module, module });
        add(src, null);
    };
    const svgElement = (tag, { here, nonce, src }, target) => {
        const { name, attrs, text } = tag;
        presentationStyles(tag);
        if (name === 'style' && isCssType(attrs.get('type'))) styleBlock(text, nonce, here);
        if (linkTarget(target)) add(target, name === 'image' || name === 'feimage' ? 'img-src' : null);
        if (name === 'a' && target !== undefined) ping(attrs.get('ping'));
        add(src, null);
    };
    // SVG 2 href (or the legacy xlink:href, which href overrides): image and feImage load an
    // image, script a classic script; use, a and the rest refer to their target. MathML
    // elements load nothing.
    const foreignElement = (tag, at) => {
        const target = at.href ?? tag.attrs.get('xlink:href');
        if (tag.ns === 'svg') {
            (tag.name === 'script' ? svgScript : svgElement)(tag, at, target);
        } else {
            if (linkTarget(target)) add(target, null);
            add(at.src, null);
        }
    };
    const importMapElement = ({ line, text }, { here, nonce, src }) => {
        if (!scripting) return;
        if (src !== undefined) {
            problems.push(`line ${line}: <script type="importmap" src> is ignored by Chrome (import maps must be inline)`);
        } else if (text !== '') { // an empty one is skipped before anything is parsed
            inline.push({ kind: 'script', desc: `line ${line}: inline import map`, text, nonce, policies: here });
            // A module script before the map may resolve its imports first (always, when inline).
            if (firstModule !== null) problems.push(`line ${line}: this import map comes after the module script on line ${firstModule}, so Chrome may resolve that script's imports without it; put import maps first`);
            else importMaps.push({ text, line, base: currentBase() });
        }
    };
    // A <script> that runs (module or classic): its file, or its inline text.
    const runScript = ({ attrs, line, text }, { position, here, nonce, src }, module) => {
        if (src !== undefined) {
            add(src, 'script-src', { parserInserted: true, nonce, integrity: attrs.get('integrity'), line, cors: module || attrs.has('crossorigin'), module });
            if (!module) markScript(src);
            if (!module && !attrs.has('async') && !attrs.has('defer')) pauses.push(position);
        } else if (text.trim()) {
            inline.push({ kind: 'script', desc: `line ${line}: inline <script>`, text, nonce, policies: here });
            inlineScripts.push({ text, module, nonce, line, base: currentBase() });
        }
    };
    const scriptElement = (tag, at) => {
        const { attrs, line } = tag;
        // Chrome matches module/importmap exactly; a classic type may have whitespace around it.
        const language = attrs.get('language') ?? '';
        const type = attrs.has('type') ? attrs.get('type') : language ? `text/${language}` : '';
        const module = /^module$/i.test(type);
        if (/^importmap$/i.test(type)) {
            importMapElement(tag, at);
        } else if (module || CLASSIC_JS_TYPES.test(trimScriptType(type))) { // anything else is a data block
            if (module && scripting && firstModule === null) firstModule = line;
            // Never run: scripting is off (a sandbox without allow-scripts), or it is a nomodule
            // script, which Chrome skips because it runs modules. A classic file stays classic.
            if (!scripting || (!module && attrs.has('nomodule'))) markScript(at.src, { classic: false, inert: true });
            else runScript(tag, at, module);
        }
    };
    const checkedLoad = ({ attrs, line }, { nonce }) => ({ nonce, integrity: attrs.get('integrity'), line, cors: attrs.has('crossorigin') });
    const linkAs = ({ attrs }) => asciiTrim(attrs.get('as') ?? '').toLowerCase();
    // <link> kinds by rel token, the first that matches wins; other links are navigations.
    const linkKinds = [
        [['stylesheet'], (tag, at) => {
            // Only a CSS sheet is fetched, and an integrity mismatch makes Chrome drop it.
            const css = isCssType(tag.attrs.get('type'), { parameters: true });
            add(at.href, css ? 'style-src' : null, css ? checkedLoad(tag, at) : {});
            if (css) pauses.push(at.position);
        }],
        [['icon', 'apple-touch-icon'], (tag, { href }) => add(href, 'img-src')],
        [['modulepreload'], (tag, at) => {
            // Fetched into the module map, so an integrity mismatch breaks later imports.
            const as = linkAs(tag);
            const known = Object.hasOwn(MODULEPRELOAD_DIRECTIVES, as);
            add(at.href, known ? MODULEPRELOAD_DIRECTIVES[as] : null, known ? { ...checkedLoad(tag, at), cors: true, module: true } : {});
        }],
        [['preload'], ({ attrs, line }, { nonce, href }) => {
            // A preload's integrity counts where the page later uses the preloaded response
            // (a script, stylesheet or @font-face of that URL): see checkReferences.
            const as = linkAs({ attrs });
            const preload = ['script', 'style', 'font'].includes(as) && attrs.has('integrity')
                ? { as, cors: attrs.has('crossorigin'), integrity: attrs.get('integrity'), line } : undefined;
            add(href, Object.hasOwn(PRELOAD_DIRECTIVES, as) ? PRELOAD_DIRECTIVES[as] : null, { nonce, preload, hint: true });
            // An image preload may name its candidates in imagesrcset (href is then optional).
            if (as === 'image') srcsetUrls(attrs.get('imagesrcset') || '').forEach((url) => add(url, 'img-src', { hint: true }));
        }],
        [['manifest'], (tag, { href }) => add(href, 'manifest-src')],
        [['prefetch'], (tag, { href }) => add(href, 'default-src')], // CSP3 has no prefetch-src: prefetches fall under default-src
        [['preconnect', 'dns-prefetch'], () => {}] // connection hints: nothing is fetched
    ];
    const linkElement = (tag, at) => {
        const rel = asciiTokens(tag.attrs.get('rel')?.toLowerCase());
        const kind = linkKinds.find(([tokens]) => tokens.some((token) => rel.includes(token)));
        if (kind) kind[1](tag, at);
        else add(at.href, null);
    };
    // srcdoc wins over src (never requested). It is a nested document: it inherits this page's
    // policies and base URL, and runs no script when the iframe's sandbox lacks allow-scripts.
    const srcdocFrame = ({ attrs, line }, here) => {
        const sandbox = attrs.has('sandbox') ? asciiTokens(attrs.get('sandbox').toLowerCase()) : null;
        const nested = htmlRefs(attrs.get('srcdoc'), currentBase(), scripting && (!sandbox || sandbox.includes('allow-scripts')), here);
        // Without allow-same-origin the srcdoc's origin is opaque: Chrome exempts its own-URL scripts from CSP.
        const opaque = sandbox && !sandbox.includes('allow-same-origin') ? { sandboxed: true } : {};
        // Custom properties don't cross documents: the srcdoc's url()s in them resolve within it.
        const nestedRead = (property, seen = new Set()) => !seen.has(property) && (seen.add(property), nested.varUses.has(property) ||
            nested.varChains.some(([holder, read]) => read === property && (nested.registeredUrls.has(holder) || nestedRead(holder, seen))));
        const srcdoc = `${line}:${urls.length}`; // the srcdoc document's loads, for custom properties (see checkReferences)
        urls.push(...nested.urls.flatMap((item) => (item.custom === undefined ? [{ srcdoc, ...item, ...opaque }]
            : nested.registeredUrls.has(item.custom) || nestedRead(item.custom) ? [{ srcdoc, ...item, custom: undefined, ...opaque }] : [])));
        srcdocs.push({ id: srcdoc, varUses: [...nested.varUses], varChains: nested.varChains, registeredUrls: [...nested.registeredUrls],
            policies: [...nested.policies], opaque: Boolean(opaque.sandboxed) }, ...nested.srcdocs);
        problems.push(...nested.problems.map((item) => `line ${line} srcdoc ${item}`));
        inlineScripts.push(...nested.inlineScripts.map((script) => ({ ...script, ...opaque, line: `${line} srcdoc line ${script.line}` })));
        importMaps.push(...nested.importMaps.map((map) => ({ ...map, line: `${line} srcdoc line ${map.line}` })));
        classicScripts.push(...nested.classicScripts);
        inertScripts.push(...nested.inertScripts);
        inline.push(...nested.inline.map((item) => ({ ...item, desc: `line ${line} srcdoc ${item.desc}` })));
        styleItems.push(...nested.inlineStyles);
    };
    const metaElement = ({ attrs, inHead, inTemplate }) => {
        const equiv = (attrs.get('http-equiv') ?? '').toLowerCase(); // Chrome compares it unpadded
        if (equiv === 'refresh') {
            // <meta http-equiv="refresh" content="N; url=target"> navigates to target.
            const m = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?(["']?)(.*?)\1\s*$/i.exec(attrs.get('content') || '');
            if (m && m[2]) add(m[2], null);
        } else if (equiv === 'content-security-policy' && inHead && !inTemplate && attrs.has('content')) {
            policies.push(attrs.get('content')); // enforced with the page's own policy from here on
        }
    };
    // a, area and anything else: a navigation or unknown use; check local targets exist.
    const otherElement = ({ name, attrs, line }, { position, here, src, href }) => {
        if (BACKGROUND_ELEMENTS.has(name) && urlTrim(attrs.get('background') ?? '')) {
            deferred.push({ url: attrs.get('background'), directive: 'img-src', line, name, elementBase: currentBase(), position });
        }
        add(src, null);
        add(href, null);
        if ((name === 'a' || name === 'area') && href !== undefined) {
            ping(attrs.get('ping'));
            // Following a javascript: link runs its code as inline script.
            if (scripting && /^javascript:/i.test(urlTrim(href))) {
                inline.push({ kind: 'navigation', desc: `line ${line}: javascript: URL in <${name} href>`, text: urlTrim(href).slice('javascript:'.length), policies: here });
            }
        }
    };
    const media = ({ name, attrs }, { src }) => {
        add(src, 'media-src');
        if (name === 'video') add(attrs.get('poster'), 'img-src'); // poster means nothing on audio or track
    };
    const frame = (tag, { here, src }) => {
        if (tag.name === 'iframe' && tag.attrs.has('srcdoc')) srcdocFrame(tag, here);
        else add(src, 'frame-src');
    };
    const elements = new Map([
        ['script', scriptElement],
        ['style', ({ attrs, text }, { here, nonce }) => {
            if (isCssType(attrs.get('type'))) styleBlock(text, nonce, here); // otherwise not CSS, so never applied
        }],
        ['link', linkElement],
        ['img', ({ attrs }, { src }) => {
            add(src, 'img-src');
            srcsetUrls(attrs.get('srcset') || '').forEach((url) => add(url, 'img-src'));
        }],
        ['source', ({ attrs, parent }, { src }) => {
            // Under <picture> only srcset (image candidates) counts; under <audio>/<video> only
            // src (media); elsewhere a <source> loads nothing.
            if (parent === 'picture') srcsetUrls(attrs.get('srcset') || '').forEach((url) => add(url, 'img-src'));
            else if (parent === 'audio' || parent === 'video') add(src, 'media-src');
        }],
        ['video', media],
        ['audio', media],
        ['track', media],
        ['iframe', frame],
        ['frame', frame],
        ['object', ({ attrs }) => add(attrs.get('data'), 'object-src')],
        ['embed', (tag, { src }) => add(src, 'object-src')],
        ['input', ({ attrs }, { src }) => {
            if (asciiTrim(attrs.get('type') ?? '').toLowerCase() === 'image') add(src, 'img-src');
        }],
        ['base', ({ inTemplate, line }, { position, here, href }) => {
            if (!base && href !== undefined && !inTemplate) base = { href: joinBase(inheritedBase, urlTrim(href)), line, policies: here, position };
        }],
        ['form', ({ attrs }) => add(attrs.get('action'), 'form-action')],
        ['meta', metaElement]
    ]);

    for (const [position, tag] of scanHtml(html, { scripting }).entries()) {
        const { attrs } = tag;
        const at = { position, here: [...policies], nonce: attrs.get('nonce') ?? null, src: attrs.get('src'), href: attrs.get('href') };
        anyElement(tag, at);
        const handle = tag.foreign ? foreignElement : elements.get(tag.name) ?? otherElement;
        handle(tag, at);
    }

    // Styles, legacy backgrounds and pings load once the page is parsed: against the document's
    // base URL, under every <meta> policy. Imports from inline modules and import maps too.
    const finalBase = currentBase();
    for (const item of deferred) {
        // Chrome resolves the attribute when styles are computed: after the whole page, unless a
        // parser-blocking script or a stylesheet in between lets styles apply before the <base>.
        if (item.elementBase !== undefined && item.elementBase !== finalBase && pauses.some((at) => at > item.position && at < base.position)) {
            problems.push(`line ${item.line}: <${item.name} background> comes before <base href>, so Chrome may resolve it against either; move <base> into <head>`);
            continue;
        }
        urls.push({ ...item, base: finalBase, policies: [...policies], fragments: true });
    }
    for (const { text, declarations } of styles) {
        const scan = cssScan(text, { declarations });
        urls.push(...scan.refs.map((ref) => ({ ...ref, base: finalBase, policies: [...policies] })));
        scan.uses.forEach((property) => varUses.add(property));
        varChains.push(...scan.chains);
        scan.registeredUrls.forEach((property) => registeredUrls.add(property));
    }
    for (const script of inlineScripts) script.policies = [...policies];
    for (const map of importMaps) map.policies = [...policies];
    return { urls, problems, inline, inlineScripts, importMaps, classicScripts, inertScripts, inlineStyles: styleItems, base, policies, varUses, varChains, registeredUrls, srcdocs };
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

/**
 * The minimum CSP Chrome appends as a separate policy to every MV3 extension page
 * and the service worker of a packed extension (csp_info.cc kMinimumMV3CSP), so a
 * looser manifest policy (say script-src-elem) can't let remote scripts in.
 */
const MINIMUM_MV3_CSP = "script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'; object-src 'self';";

/** Chrome's default CSP for manifest sandbox pages. */
const DEFAULT_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';";

/** Whether an external <base href> is allowed: base-uri has no default-src fallback. */
function baseUriAllows(csp, href) {
    const sources = csp?.get('base-uri');
    if (!sources) return true;
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
        // CSP splits on ASCII whitespace only; a name that isn't [A-Za-z0-9-]+ is ignored, as in Chrome.
        const [name, ...sources] = part.split(/[\t\n\f\r ]+/).filter(Boolean);
        if (name && /^[A-Za-z0-9-]+$/.test(name) && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources.map(normalizeSource));
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
    return sources.some((source) => sourceMatches(source, parsed, directive));
}

/** Whether one CSP source expression matches a parsed absolute URL (keywords never match here). */
function sourceMatches(source, parsed, directive = null) {
    const scheme = parsed.protocol;
    if (source.startsWith("'")) return false; // 'self' (the extension), 'none', nonces, hashes, keywords
    // A lone '*' matches HTTP(S) and WS(S) URLs and the page's own scheme, chrome-extension: here
    // (CSP3; Chrome includes ws/wss). data:, blob: and other schemes must be listed.
    if (source === '*') return /^(https?|wss?|chrome-extension):$/.test(scheme);
    if (/^[a-z][a-z0-9+.-]*:$/.test(source)) {
        return source === scheme || (source === 'http:' && scheme === 'https:') || (source === 'ws:' && scheme === 'wss:');
    }
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^/:[\]]+|\[[0-9a-f:.]+\])(?::(\d+|\*))?(\/.*)?$/.exec(source); // [IPv6] hosts too
    if (!m) return false;
    const [, sourceScheme, host, port, path] = m;
    // A source without a scheme matches only the protected page's scheme, chrome-extension: here.
    const upgrade = (sourceScheme === 'http' && scheme === 'https:') || (sourceScheme === 'ws' && scheme === 'wss:');
    if (sourceScheme ? `${sourceScheme}:` !== scheme && !upgrade : scheme !== 'chrome-extension:') {
        return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (host.startsWith('*.') ? !hostname.endsWith(host.slice(1)) : host !== '*' && hostname !== host) return false;
    return sourcePortMatches(port, parsed, { upgraded: upgrade && `${sourceScheme}:` !== scheme, directive }) &&
        (!path || sourcePathMatches(path, parsed.pathname));
}

/** Whether a CSP source's port (undefined when it names none) admits the URL's port. */
function sourcePortMatches(port, parsed, { upgraded, directive }) {
    const scheme = parsed.protocol;
    // No port in the source: only the scheme's default port matches.
    if (!port) return parsed.port === '';
    if (port === '*') return true;
    const effective = parsed.port || ({ 'https:': '443', 'http:': '80', 'wss:': '443', 'ws:': '80' })[scheme] || '';
    if (!upgraded) return effective === port;
    // With the scheme upgraded (http to https, ws to wss), Chrome matches only port 443: from a
    // source port of 80, or of 443 for an https subresource (not a frame or form target), never
    // from another port (http://h:8080 doesn't match https://h:8080).
    const navigation = directive === 'frame-src' || directive === 'form-action';
    const sourcePortOk = port === '80' || (port === '443' && scheme === 'https:' && !navigation);
    return sourcePortOk && effective === '443';
}

/** Decodes percent-escapes, or keeps the text as written when an escape is malformed. */
const decodeOrKeep = (text) => {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
};

/** Whether a CSP source path matches a URL path: a "/"-ending source is a prefix, any other is exact. */
function sourcePathMatches(path, urlPath) {
    const sourcePath = decodeOrKeep(path);
    const pathname = decodeOrKeep(urlPath);
    return sourcePath.endsWith('/') ? pathname.startsWith(sourcePath) : pathname === sourcePath;
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
        // Chrome decodes base64 or base64url, padded or not, and compares the bytes.
        const m = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)'$/.exec(source);
        if (!m) return false;
        const expected = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''), 'base64');
        return expected.length > 0 && expected.equals(createHash(m[1]).update(text, 'utf8').digest());
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
    for (const token of metadata.split(/[\t\n\v\f\r ]+/).filter(Boolean)) {
        if (/^ed25519-[A-Za-z0-9+/=_-]+/.test(token)) return 'asks for an ed25519 signature, which a packaged file never carries, so Chrome refuses to load it';
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
            // import(path, { with: { type: 'json' | 'css' } }) loads a JSON or CSS module.
            const options = /\s*\{\s*with\s*:\s*\{\s*type\s*:\s*(['"])(json|css)\1\s*,?\s*\}\s*,?\s*\}\s*,?\s*\)/y;
            options.lastIndex = literal.lastIndex;
            const typed = lit[0].trimEnd().endsWith(',') ? options.exec(source) : null;
            specifiers.push(typed ? { specifier: lit[1] ?? lit[2] ?? lit[3], type: typed[2] } : lit[1] ?? lit[2] ?? lit[3]);
        } else {
            const line = source.slice(0, m.index).split('\n').length;
            errors.push(`${file}:${line}: import() without a literal path can't be checked; use a static import or a string literal`);
        }
    }
    return { specifiers, errors };
}

/** The extension's origin as a URL prefix (a placeholder ID when the manifest has no key). */
const extensionOrigin = (extensionId) => `chrome-extension://${extensionId ?? 'extension'}/`;

/**
 * Resolves a bare module specifier through a page's import map, as HTML's
 * "resolve a module specifier" does: scopes matching the referrer first, then
 * the top-level imports; exact keys and "/"-ending prefix keys, longest first.
 * @returns {{ url: string } | { blocked: true } | null} null when nothing maps it
 */
function resolveThroughImportMap(map, specifier, referrer) {
    const match = (entries) => {
        for (const key of Object.keys(entries).sort().reverse()) {
            const address = entries[key];
            if (key === specifier) return address === null ? { blocked: true } : { url: address };
            if (key.endsWith('/') && specifier.startsWith(key)) {
                if (address === null) return { blocked: true };
                try {
                    const url = new URL(specifier.slice(key.length), address).href;
                    return url.startsWith(address) ? { url } : { blocked: true }; // no backtracking above the prefix
                } catch {
                    return { blocked: true };
                }
            }
        }
        return null;
    };
    for (const scope of Object.keys(map.scopes).sort().reverse()) {
        if (scope === referrer || (scope.endsWith('/') && referrer.startsWith(scope))) {
            const found = match(map.scopes[scope]);
            if (found) return found;
        }
    }
    return match(map.imports);
}

/**
 * Resolves URLs as one packaged file sees them: against the file itself or a
 * <base href> (a local directory or an external base URL), to a local path or
 * an absolute URL. chrome-extension://<this extension's id>/path is one of our
 * own files.
 */
function locator(file, extensionId) {
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
        const trimmedBase = urlTrim(base);
        const href = trimmedBase.startsWith('//') ? `chrome-extension:${trimmedBase}` : trimmedBase;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            const own = ownPath(href);
            if (own === null) return { externalBase: href };
            return { localDir: own.endsWith('/') ? own.replace(/\/$/, '') || '.' : posix.dirname(own) };
        }
        // Resolve like a URL against the document: "#frag" or "?q" keeps the document itself.
        let path = posix.dirname(file);
        try {
            const url = new URL(href, `chrome-extension://base/${file.split('/').map(encodeURIComponent).join('/')}`);
            path = decodeURIComponent(url.pathname).replace(/^\//, '');
            return { localDir: url.pathname.endsWith('/') ? path.replace(/\/$/, '') || '.' : posix.dirname(path) || '.' };
        } catch {
            return { localDir: path };
        }
    };
    // A #fragment-only URL names part of a stylesheet or SVG document and loads nothing, unless
    // `fragments` (HTML attributes and pings, which resolve it against the base like any URL).
    const locate = (url, base, fragments = false) => {
        const trimmed = urlTrim(url);
        if (trimmed.startsWith('#') && !fragments) return {};
        if (base && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
            const info = typeof base === 'string' ? baseInfo(base) : base;
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
    return { ownPrefix, ownPath, baseInfo, locate };
}

/** The CSP directive an import of a module `type` loads under: JSON is fetched under connect-src, CSS under style-src. */
const moduleDirective = (type) => (type === 'json' ? 'connect-src' : type === 'css' ? 'style-src' : 'script-src');

/** Whether Chrome's module loader takes `path` for an import of `type` (JavaScript unless json or css). */
const moduleFileOk = (type, path) => (type === 'json' ? /\.json$/i : type === 'css' ? /\.css$/i : /\.m?js$/i).test(path);

/** An import map address or integrity key Chrome reads as a URL: absolute, or a /, ./ or ../ path. */
const urlLike = (value) => /^(\/|\.\.?\/|[a-z][a-z0-9+.-]*:)/i.test(value);

/** Why Chrome rejects a parsed import map whole (a member of the wrong type), or null. */
const importMapShapeProblem = (parsed) => (!isPlainObject(parsed) ? 'must be a JSON object'
    : 'imports' in parsed && !isPlainObject(parsed.imports) ? '"imports" must be an object'
        : 'scopes' in parsed && !(isPlainObject(parsed.scopes) && Object.values(parsed.scopes).every(isPlainObject)) ? '"scopes" must be an object of objects'
            : 'integrity' in parsed && !isPlainObject(parsed.integrity) ? '"integrity" must be an object' : null);

/** Whether a hyperlink-auditing ping is sent to `url`: only to HTTP(S) URLs, and not to one that doesn't parse. */
const pingable = (url) => {
    if (!/^https?:/i.test(url ?? '')) return false;
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
};

/** Why Chrome blocks or can't load the imports one import map entry names, or null when it maps them. */
const importMapEntryProblem = (key, address) => {
    const blocked = typeof address !== 'string' ? 'is not a string'
        : !urlLike(address) ? 'is not a URL or a /, ./ or ../ path'
            : key.endsWith('/') && !address.endsWith('/') ? 'must end in "/" like its key' : null;
    if (blocked) return `${blocked}, so Chrome blocks imports of "${key}"`;
    return address.endsWith('/') && !key.endsWith('/') ? "maps a module to a directory, which Chrome can't load" : null;
};

/**
 * References made by one packaged file.
 * @returns {{ refs: string[], uses: object[], external: object[], errors: string[], dynamicImports: number,
 *   classicScripts: string[], inertScripts: string[], inline: object[], inlineStyles: object[], integrity: object[],
 *   mapIntegrity: object[], preloads: object[], policies: string[], customRefs: object[], varUses: string[],
 *   varChains: string[][], registeredUrls: string[], documentBase: object | null }}
 *   refs are root-relative local paths. uses (local files) and external (absolute URLs) are loads, each
 *   with the CSP directive governing it, its nonce, whether the parser inserted it (a <script> in the
 *   markup) and the <meta> CSPs in effect there. Pages also report their inline content, their <meta>
 *   CSPs (policies), their document base, preloads and import-map integrity entries. customRefs are
 *   url()s in custom properties, which resolve where var() uses them (varUses, varChains); integrity
 *   lists element metadata to verify.
 */
export function extractRefs(file, text, { classic = false, csp = null, scripting = true, extensionId = null } = {}) {
    const result = {
        refs: [], uses: [], external: [], errors: [], dynamicImports: 0, classicScripts: [], inertScripts: [], inline: [], inlineStyles: [],
        integrity: [], mapIntegrity: [], preloads: [], opaqueRefs: [], srcdocRefs: [], srcdocs: [], bareImports: [], importMap: null, policies: [], customRefs: [], varUses: [], varChains: [], registeredUrls: [], documentBase: null
    };
    const kind = (/\.(html?|m?js|css)$/i.exec(file)?.[1] || '').toLowerCase();
    const { ownPrefix, ownPath, baseInfo, locate } = locator(file, extensionId);
    let baseUsable = true;
    // This file's URL and a document base URL, for import maps and bare specifiers.
    const origin = extensionOrigin(extensionId);
    const fileUrl = origin + file.split('/').map(encodeURIComponent).join('/');
    const baseUrl = (base) => {
        if (!base || !baseUsable) return fileUrl;
        const info = baseInfo(base);
        if (info.externalBase) return info.externalBase;
        return info.localDir === '.' ? origin : `${origin}${info.localDir.split('/').map(encodeURIComponent).join('/')}/`;
    };
    const add = ({ url, directive, base = null, policies = [], nonce = null, parserInserted = false, integrity, line, ping = false, fragments = false, custom, cors = false, module = false, preload, hint = false, mapAddress = false, sandboxed = false, order = null, srcdoc = null }) => {
        if (custom && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(urlTrim(url))) {
            // Resolved where var() substitutes the property: see checkReferences.
            result.customRefs.push({ name: custom, url: urlTrim(url), directive });
            return;
        }
        const located = locate(url, baseUsable ? base : null, fragments || ping);
        if (ping && !pingable(located.external)) return;
        const local = located.local ?? (located.external ? ownPath(located.external) : null);
        const external = local ? null : located.external;
        // cors and ownIntegrity let a preload of the same URL be matched to this load.
        const load = { directive, policies, nonce, parserInserted, cors, module, ownIntegrity: Boolean(integrity), integrityAttr: integrity !== undefined, hint, mapAddress, sandboxed, order };
        if (local) addLocal(local, load, { srcdoc, integrity, line, preload });
        else if (external && directive) addExternal(external, load);
    };
    // A load of one of the package's own files, with what the checks need to know about it.
    const addLocal = (local, load, { srcdoc, integrity, line, preload }) => {
        result.refs.push(local);
        if (load.sandboxed) result.opaqueRefs.push(local);
        if (srcdoc) result.srcdocRefs.push({ id: srcdoc, path: local });
        if (load.directive) result.uses.push({ path: local, ...load });
        if (integrity !== undefined) result.integrity.push({ path: local, integrity, line });
        if (preload) result.preloads.push({ path: local, order: load.order, ...preload });
    };
    const addExternal = (external, load) => {
        if (/^chrome-extension:\/\//i.test(external) && !ownPrefix) {
            result.errors.push(`${file}: ${external} can't be checked without a manifest key (the extension ID is unknown)`);
        } else if (/^(https?|wss?|data|blob|chrome-extension):/i.test(external)) {
            result.external.push({ url: external, ...load });
        } else {
            result.errors.push(`${file}: ${external} uses a URL scheme an extension page can't load (${load.directive})`);
        }
    };
    // The packaged file a URL names here (resolved against `base` while it is usable), or null.
    const localTarget = (url, base) => {
        const located = locate(url, baseUsable ? base : null);
        return located.local ?? (located.external ? ownPath(located.external) : null);
    };
    // Module specifiers: relative/absolute paths and http(s)/data/blob/chrome-extension URLs only.
    // A packaged target must be JavaScript, or JSON/CSS imported with that type attribute (which
    // Chrome fetches under connect-src and style-src). Imports inherit their importer's nonce.
    function addSpecifiers(label, entries, base, { policies = [], nonce = null, sandboxed = false } = {}) {
        for (const entry of entries) {
            const { specifier, type } = typeof entry === 'string' ? { specifier: entry, type: undefined } : entry;
            const isPath = specifier.startsWith('.') || specifier.startsWith('/') || /^chrome-extension:/i.test(specifier);
            const target = isPath ? localTarget(specifier, base) : null;
            if (target && !moduleFileOk(type, target)) {
                result.errors.push(`${label}: module "${specifier}" resolves to ${target}, which Chrome's module loader rejects (not ${type ? `a ${type} module` : 'JavaScript'})`);
            }
            if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !/^(https?|data|blob|chrome-extension):/i.test(specifier)) {
                result.errors.push(`${label}: module specifier "${specifier}" uses a scheme Chrome can't import (e.g. node: built-ins don't exist in an extension)`);
            } else if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
                add({ url: specifier, directive: moduleDirective(type), base, policies, nonce, cors: true, module: true, sandboxed });
            } else {
                // Only the import map of the page that loads the module can resolve it: see checkReferences.
                result.bareImports.push({ label, specifier, type, referrer: base ? baseUrl(base) : fileUrl, policies, nonce, sandboxed });
            }
        }
    }
    // A page's <base href>: blocked by a CSP's base-uri (then ignored), or the document base.
    const documentBase = (page) => {
        // An own (chrome-extension:) base is exempt from CSP, as Chrome exempts own URLs.
        const own = baseInfo(page.base.href).localDir !== undefined;
        const blocking = own ? null : [[csp, 'manifest CSP'], ...page.base.policies.map((meta) => [parseMetaCsp(meta), '<meta> CSP'])]
            .find(([policy]) => policy && !baseUriAllows(policy, page.base.href));
        if (blocking) {
            baseUsable = false;
            result.errors.push(`${file} line ${page.base.line}: <base href="${page.base.href}"> is blocked by the ${blocking[1]} (base-uri), so Chrome ignores it; remove it`);
        } else {
            result.documentBase = baseInfo(page.base.href);
        }
    };
    // Inline scripts: check what they import (they run where the page's CSP allows inline script).
    const inlineScript = (script) => {
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
        addSpecifiers(label, [...statics, ...dynamic.specifiers], script.base, { policies: script.policies, nonce: script.nonce, sandboxed: script.sandboxed });
    };
    // The map as Chrome merges it into the page's (the first entry for a key wins): keys and
    // addresses resolved against the document base, bad addresses as null (blocking).
    const mergeImportMap = (parsed, mapBase) => {
        const asUrl = (value) => {
            if (!urlLike(value)) return null;
            try {
                return new URL(value, mapBase).href;
            } catch {
                return null;
            }
        };
        const merge = (entries, target) => {
            for (const [key, address] of Object.entries(entries)) {
                const normalized = asUrl(key) ?? key;
                if (key === '' || Object.hasOwn(target, normalized)) continue;
                const url = typeof address === 'string' ? asUrl(address) : null;
                target[normalized] = url && !(key.endsWith('/') && !url.endsWith('/')) ? url : null;
            }
        };
        result.importMap ??= { imports: {}, scopes: {} };
        merge(parsed.imports ?? {}, result.importMap.imports);
        for (const [scope, entries] of Object.entries(parsed.scopes ?? {})) {
            try {
                const prefix = new URL(scope, mapBase).href;
                merge(entries, result.importMap.scopes[prefix] ??= {});
            } catch {
                // a scope that isn't a URL is ignored
            }
        }
    };
    // Each mapping's address: one Chrome would block, or a module load to check.
    const importMapAddresses = (label, parsed, map) => {
        const specifierMaps = [['imports', parsed.imports ?? {}], ...Object.entries(parsed.scopes ?? {}).map(([scope, entries]) => [`scopes["${scope}"]`, entries])];
        const mappings = specifierMaps.flatMap(([where, entries]) => Object.entries(entries).map(([key, address]) => ({ where, key, address })));
        for (const { where, key, address } of mappings) {
            if (key === '') continue; // ignored
            const problem = importMapEntryProblem(key, address);
            if (problem) result.errors.push(`${label}: ${where}["${key}"] ${problem}`);
            else if (!address.endsWith('/')) add({ url: address, directive: 'script-src', base: map.base, policies: map.policies, cors: true, mapAddress: true });
        }
    };
    // Inline import maps: JSON that Chrome rejects whole when a member has the wrong type, and
    // whose bad entries become null mappings that block the imports they name.
    const importMap = (map) => {
        const label = `${file} (import map, line ${map.line})`;
        let parsed;
        try {
            parsed = JSON.parse(map.text);
        } catch (error) {
            result.errors.push(`${label} is not valid JSON, so Chrome rejects it: ${error.message}`);
            return;
        }
        const fatal = importMapShapeProblem(parsed);
        if (fatal) {
            result.errors.push(`${label}: ${fatal}, so Chrome rejects the map`);
            return;
        }
        mergeImportMap(parsed, baseUrl(map.base));
        importMapAddresses(label, parsed, map);
        // Integrity entries: Chrome applies one to a module fetch of that URL (see checkReferences).
        for (const [key, metadata] of Object.entries(parsed.integrity ?? {})) {
            if (typeof metadata !== 'string' || !urlLike(key)) continue; // ignored by Chrome
            const local = localTarget(key, map.base);
            // Maps merge with the first entry for a URL winning.
            if (local && !result.mapIntegrity.some((entry) => entry.path === local)) result.mapIntegrity.push({ path: local, integrity: metadata, line: map.line });
        }
    };
    const htmlPage = () => {
        const page = htmlRefs(text, null, scripting);
        result.errors.push(...page.problems.map((item) => `${file} ${item}`));
        if (page.base?.href) documentBase(page);
        page.urls.forEach(add);
        page.inlineScripts.forEach(inlineScript);
        page.importMaps.forEach(importMap);
        const resolveScripts = (list) => list.map(({ url, base }) => localTarget(url, base)).filter(Boolean);
        result.inline = page.inline;
        result.inlineStyles = page.inlineStyles;
        result.policies = page.policies;
        result.classicScripts = resolveScripts(page.classicScripts);
        result.inertScripts = resolveScripts(page.inertScripts);
        result.varUses = [...page.varUses];
        result.varChains = page.varChains;
        result.registeredUrls = [...page.registeredUrls];
        result.srcdocs = page.srcdocs;
    };
    const jsModule = () => {
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
    };
    const stylesheet = () => {
        const scan = cssScan(text);
        scan.refs.forEach(add);
        result.varUses = [...scan.uses];
        result.varChains = scan.chains;
        result.registeredUrls = [...scan.registeredUrls];
    };
    if (kind === 'html' || kind === 'htm') htmlPage();
    else if (kind === 'js' || kind === 'mjs') jsModule();
    else if (kind === 'css') stylesheet();
    return result;
}

// declarativeNetRequest ------------------------------------------------------------

const RULE_ACTIONS = new Set(['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests']);

/** Checks of a redirect action by the field Chrome uses: the first of url, extensionPath, transform and regexSubstitution present. */
const REDIRECT_CHECKS = {
    url: (redirect) => {
        let scheme = null;
        try {
            scheme = new URL(redirect.url).protocol;
        } catch {
            // reported below
        }
        return !scheme || scheme === 'javascript:' ? ['action.redirect.url must be a valid URL other than javascript:'] : [];
    },
    extensionPath: (redirect, rule, packaged) => {
        if (!(typeof redirect.extensionPath === 'string' && redirect.extensionPath.startsWith('/'))) {
            return ['action.redirect.extensionPath must be a path starting with "/"'];
        }
        const target = resolveRef('manifest.json', redirect.extensionPath);
        return target && !packaged.has(target) ? [`action.redirect.extensionPath ${redirect.extensionPath} is not in the package`] : [];
    },
    transform: () => [],
    regexSubstitution: (redirect, rule) => {
        if (typeof redirect.regexSubstitution !== 'string' || !redirect.regexSubstitution) return ['action.redirect.regexSubstitution must be a non-empty string'];
        return typeof rule.condition?.regexFilter !== 'string' ? ['action.redirect.regexSubstitution needs condition.regexFilter'] : [];
    }
};

/** Why Chrome rejects one modifyHeaders entry: an HTTP token for the name; no CR, LF or NUL in a value (as Chrome checks them). */
const headerProblem = (info) => {
    const operation = info?.operation;
    if (!info || typeof info.header !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(info.header) || !['append', 'set', 'remove'].includes(operation)) {
        return 'needs a valid header name and an operation of append, set or remove';
    }
    if (operation === 'remove' ? 'value' in info : typeof info.value !== 'string') {
        return operation === 'remove' ? "can't have a value with remove" : `needs a string value with ${operation}`;
    }
    return typeof info.value === 'string' && /[\r\n\0]/.test(info.value) ? 'has a value with CR, LF or NUL' : null;
};

/** The fields each action type needs (Chrome drops a static rule without them). */
const RULE_ACTION_CHECKS = {
    redirect: (rule, action, packaged) => {
        const redirect = action.redirect && typeof action.redirect === 'object' ? action.redirect : null;
        const field = redirect && Object.keys(REDIRECT_CHECKS).find((key) => key in redirect);
        if (!field) return ['a redirect action needs action.redirect with url, extensionPath, transform or regexSubstitution'];
        return REDIRECT_CHECKS[field](redirect, rule, packaged);
    },
    modifyHeaders: (rule, action) => {
        const lists = ['requestHeaders', 'responseHeaders'].filter((key) => key in action);
        const problems = lists.length ? [] : ['a modifyHeaders action needs requestHeaders or responseHeaders'];
        for (const key of lists) {
            if (!Array.isArray(action[key]) || !action[key].length) {
                problems.push(`action.${key} must be a non-empty list`);
                continue;
            }
            action[key].forEach((info, n) => {
                const problem = headerProblem(info);
                if (problem) problems.push(`action.${key}[${n}] ${problem}`);
            });
        }
        return problems;
    },
    allowAllRequests: (rule) => {
        const types = rule.condition?.resourceTypes;
        return !Array.isArray(types) || !types.length || types.some((type) => type !== 'main_frame' && type !== 'sub_frame')
            ? ['an allowAllRequests action needs condition.resourceTypes of main_frame and/or sub_frame only'] : [];
    }
};

/**
 * Why Chrome would drop one static rule (none when it is valid): unique positive integer ids
 * (tracked in `ruleIds`), an action with a known type and what that type needs, a condition object.
 */
function ruleProblems(rule, ruleIds, packaged) {
    if (!isPlainObject(rule)) return ['must be an object'];
    const action = rule.action && typeof rule.action === 'object' ? rule.action : {};
    const actionCheck = typeof action.type === 'string' && Object.hasOwn(RULE_ACTION_CHECKS, action.type) ? RULE_ACTION_CHECKS[action.type] : () => [];
    return [
        ruleIdProblem(rule.id, ruleIds),
        'priority' in rule && (!Number.isInteger(rule.priority) || rule.priority < 1) ? 'priority must be a positive integer' : null,
        !rule.action || typeof rule.action !== 'object' || !RULE_ACTIONS.has(rule.action.type) ? `action.type must be one of ${[...RULE_ACTIONS].join(', ')}` : null,
        !isPlainObject(rule.condition) ? 'condition must be an object' : null,
        ...actionCheck(rule, action, packaged)
    ].filter(Boolean);
}

/** Why a rule id is refused: not a positive integer, or already used in the ruleset (ids so far in `ruleIds`). */
function ruleIdProblem(id, ruleIds) {
    if (!Number.isInteger(id) || id < 1) return 'id must be a positive integer';
    if (ruleIds.has(id)) return `duplicate id ${id}`;
    ruleIds.add(id);
    return null;
}

// Reference check ------------------------------------------------------------------

/**
 * The CSPs the extension's pages run under. sandbox.pages entries are paths, or patterns where
 * '*' matches anything: those pages get the sandbox CSP, every other page extension_pages.
 * policiesAt gives a page's policies at one point: its own CSP plus the <meta> CSPs in effect
 * there (and the MV3 minimum CSP on non-sandbox pages).
 */
function pagePolicies(manifest) {
    const policy = manifest.content_security_policy?.extension_pages;
    const csp = withMinimumCsp(parseCsp(typeof policy === 'string' ? policy : DEFAULT_MV3_CSP));
    const sandboxPolicy = manifest.content_security_policy?.sandbox;
    const sandboxCsp = parseCsp(typeof sandboxPolicy === 'string' ? sandboxPolicy : DEFAULT_SANDBOX_CSP);
    const sandboxEntries = (Array.isArray(manifest.sandbox?.pages) ? manifest.sandbox.pages : [])
        .filter((page) => typeof page === 'string')
        .map((page) => posix.normalize(page.replace(/^\//, '')));
    const sandboxPatterns = sandboxEntries.map((page) => new RegExp(`^${page.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
    const isSandboxPage = (file) => sandboxPatterns.some((pattern) => pattern.test(file));
    const cspFor = (file) => (isSandboxPage(file) ? sandboxCsp : csp);
    const policyNameFor = (file) => (isSandboxPage(file) ? 'sandbox CSP' : 'manifest CSP');
    const minimum = manifest.manifest_version === 3 ? [[parseCsp(MINIMUM_MV3_CSP), "MV3 minimum CSP (script-src 'self')"]] : [];
    const policiesAt = (page, metas) => [[cspFor(page), policyNameFor(page)], ...(isSandboxPage(page) ? [] : minimum),
        ...metas.map((meta) => [parseMetaCsp(meta), `<meta> CSP in ${page}`])];
    // Scripting is on in sandbox pages unless their CSP's sandbox directive omits allow-scripts.
    const scriptingFor = (file) => !isSandboxPage(file) || !sandboxCsp.has('sandbox') || sandboxCsp.get('sandbox').includes('allow-scripts');
    return { csp, sandboxEntries, sandboxPatterns, isSandboxPage, cspFor, minimum, policiesAt, scriptingFor };
}

/** Scripts that run as classic scripts: those the pages load without type="module", and content scripts. */
function classicScriptFiles(pageResults, manifest) {
    const classic = new Set([...pageResults.values()].flatMap((page) => page.classicScripts));
    if (Array.isArray(manifest.content_scripts)) {
        for (const script of manifest.content_scripts) {
            for (const js of Array.isArray(script?.js) ? script.js : []) {
                if (typeof js === 'string') classic.add(posix.normalize(js.replace(/^\//, '')));
            }
        }
    }
    return classic;
}

/** Every file reachable from `roots` along `edges`, the roots included. */
function reachableFrom(edges, roots) {
    const seen = new Set(roots);
    const queue = [...roots];
    while (queue.length) {
        for (const next of edges.get(queue.shift()) || []) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return seen;
}

/** Whether a page's inline script (an element, a javascript: navigation or an on* handler) may run under `policy`. */
const inlineScriptAllowed = (policy, item) => (item.kind === 'script'
    ? inlineAllowed(policy, 'script-src', item)
    // A javascript: navigation is checked like a script element that needs 'unsafe-hashes' for a hash.
    : item.kind === 'navigation' ? inlineAllowed(policy, 'script-src', { text: item.text, attribute: true })
        : inlineAllowed(policy, 'script-src-attr', { text: item.text, attribute: true }));

/** Whether a page's inline style (a <style> block or a style attribute) applies under `policy`. */
const inlineStyleAllowed = (policy, item) => (item.kind === 'block'
    ? inlineAllowed(policy, 'style-src', item)
    : inlineAllowed(policy, 'style-src-attr', { text: item.text, attribute: true }));

/** Why a page's import map leaves a bare specifier unresolved (`found` is its result, if any). */
const unmappedReason = (page, map, found) => (!map ? `${page} has no import map`
    : found ? `the import map of ${page} blocks it` : `the import map of ${page} doesn't map it`);

/** Whether `policy` blocks a load in a context whose module graph inherits `nonces`. */
const loadBlocked = (policy, load, nonces, extensionId) => !loadAllowed(policy, load, extensionId) &&
    // An import inherits the nonce of the script that roots its module graph.
    !(load.directive === 'script-src' && !load.parserInserted && nonces.some((nonce) => loadAllowed(policy, { ...load, nonce }, extensionId)));

/** What a blocked load's message names: the directive, or why a markup <script> fails 'strict-dynamic'. */
const blockedReason = (policy, load) => (load.directive === 'script-src' && load.parserInserted && sourcesFor(policy, 'script-src')?.includes("'strict-dynamic'")
    ? "script-src has 'strict-dynamic', so a <script> in the markup needs a matching nonce"
    : load.url ? load.directive : `${load.directive} doesn't allow 'self'`);

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
    const { csp, sandboxEntries, sandboxPatterns, isSandboxPage, cspFor, minimum, policiesAt, scriptingFor } = pagePolicies(manifest);
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
    const servedIntegrityProblem = (path, integrity) => {
        const bytes = servedBytes(path);
        return bytes ? integrityProblem(integrity, bytes) : "can't be pinned: Chrome fills in the file's locale-dependent __MSG_ placeholders";
    };

    // Pages first: they decide which scripts run as classic scripts.
    const results = new Map();
    for (const file of files.filter(isPage)) {
        results.set(file, extractRefs(file, read(file), { csp: cspFor(file), scripting: scriptingFor(file), extensionId }));
    }
    const classic = classicScriptFiles(results, manifest);

    const note = (from, ref) => {
        if (packaged.has(ref)) {
            edges.get(from).push(ref);
        } else {
            errors.push(`${from} references ${ref}, which is not in the package`);
        }
    };
    // The manifest's own paths (and sandbox page patterns that match nothing).
    const manifestPaths = () => {
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
        sandboxEntries.forEach((entry, index) => {
            if (entry.includes('*') && !files.some((file) => sandboxPatterns[index].test(file))) {
                errors.push(`manifest.json sandbox page pattern "${entry}" matches no packaged file`);
            }
        });
        return refs;
    };
    const refs = manifestPaths();
    // Files only never-run scripts name (nomodule, or scripting off): Chrome never fetches or
    // compiles them, so neither does this, unless something that runs imports them.
    const liveScripts = new Set([...classic, ...refs.map((ref) => posix.normalize(ref.replace(/^\//, ''))),
        ...[...results.values()].flatMap((page) => page.uses.filter((load) => load.directive === 'script-src' && !load.hint).map((load) => load.path))]);
    const inertNamed = new Set([...results.values()].flatMap((page) => page.inertScripts));
    const inertOnly = new Set([...inertNamed].filter((file) => !liveScripts.has(file)));
    const checkIntegrity = (file, result) => {
        for (const { path, integrity, line } of result.integrity) {
            if (!packaged.has(path)) continue; // reported as missing above
            const problem = servedIntegrityProblem(path, integrity);
            if (problem) errors.push(`${file} line ${line}: integrity="${integrity}" for ${path} ${problem}`);
        }
    };
    const checkInline = (file, result) => {
        for (const item of result.inline) {
            const blocked = policiesAt(file, item.policies).find(([pagePolicy]) => !inlineScriptAllowed(pagePolicy, item));
            if (blocked) {
                errors.push(`${file} ${item.desc}: the ${blocked[1]} blocks inline script (MV3 extension pages never run it); move it to a file`);
            }
        }
        const blockedStyle = result.inlineStyles.map((item) => policiesAt(file, item.policies).find(([pagePolicy]) => !inlineStyleAllowed(pagePolicy, item))).find(Boolean);
        if (blockedStyle) {
            errors.push(`${file} uses inline styles (style= or <style>), which the ${blockedStyle[1]} blocks: style-src has no 'unsafe-inline'`);
        }
    };
    const processFile = (file) => {
        edges.set(file, []);
        let result = results.get(file);
        if (!result) {
            try {
                result = extractRefs(file, read(file), { classic: classic.has(file), extensionId });
            } catch (error) {
                errors.push(error.message);
                return;
            }
        }
        errors.push(...result.errors);
        if (result.dynamicImports > 0) usesDynamicImport.add(file);
        for (const ref of result.refs) note(file, ref);
        checkIntegrity(file, result);
        results.set(file, result);
        if (isPage(file)) checkInline(file, result);
    };
    for (const file of files) {
        if (/\.(html?|m?js|css)$/i.test(file) && !inertOnly.has(file)) processFile(file);
    }
    for (let pending = [...inertOnly].filter((file) => files.includes(file) && /\.m?js$/i.test(file)); ;) {
        const imported = pending.filter((file) => [...edges.values()].some((targets) => targets.includes(file)));
        if (!imported.length) break;
        imported.forEach(processFile);
        pending = pending.filter((file) => !imported.includes(file));
    }
    // What each page's document loads: the files reachable from it without navigating to another
    // page. Files reached only through an opaque sandboxed srcdoc load in that sandbox; files
    // reached only through scripts the page never runs (inert) don't load at all.
    const reachFrom = (roots) => {
        const seen = new Set();
        const stack = [...roots];
        while (stack.length) {
            const file = stack.pop();
            if (seen.has(file)) continue;
            seen.add(file);
            for (const next of edges.get(file) || []) {
                if (!isPage(next)) stack.push(next); // a link to another page is a navigation
            }
        }
        return seen;
    };
    // Bare module specifiers resolve through the import map of each page whose module graph
    // includes the importing file; every such page must map them. New targets can import more,
    // so this repeats until nothing changes. Nothing else (the service worker, content scripts,
    // modules no page loads) can resolve them.
    const pages = files.filter((f) => isPage(f) && results.has(f));
    const origin = extensionOrigin(extensionId);
    const urlToPath = (url) => {
        if (!url.startsWith(origin)) return null;
        try {
            return posix.normalize(decodeURIComponent(new URL(url).pathname).replace(/^\//, ''));
        } catch {
            return null;
        }
    };
    const workerFile = typeof manifest.background?.service_worker === 'string' ? posix.normalize(manifest.background.service_worker.replace(/^\//, '')) : null;
    // One bare specifier `file` imports, through `page`'s import map: true when it adds an edge.
    const resolveBare = (page, map, file, bare) => {
        const fileResult = results.get(file);
        const found = map ? resolveThroughImportMap(map, bare.specifier, bare.referrer) : null;
        if (!found || found.blocked) {
            errors.push(`${bare.label}: bare module specifier "${bare.specifier}" cannot be loaded by an unbundled extension (${unmappedReason(page, map, found)})`);
            return false;
        }
        const load = { directive: moduleDirective(bare.type), policies: bare.policies, nonce: bare.nonce, parserInserted: false, cors: true, module: true, sandboxed: bare.sandboxed };
        const local = urlToPath(found.url);
        if (!local) {
            if (/^(https?|data|blob):/i.test(found.url)) fileResult.external.push({ url: found.url, ...load });
            else errors.push(`${bare.label}: "${bare.specifier}" maps to ${found.url} in ${page}, which Chrome can't import`);
            return false;
        }
        const problem = !moduleFileOk(bare.type, local) ? `Chrome's module loader rejects (not ${bare.type ? `a ${bare.type} module` : 'JavaScript'})`
            : !packaged.has(local) ? 'is not in the package' : null;
        if (problem) {
            errors.push(`${bare.label}: "${bare.specifier}" maps to ${local} in ${page}, which ${problem}`);
            return false;
        }
        fileResult.uses.push({ path: local, ...load });
        if ((edges.get(file) || []).includes(local)) return false;
        edges.get(file)?.push(local);
        return true;
    };
    // The bare imports of the files in a page's module graph, each resolved once per page.
    const resolvedBare = new Set();
    const unresolvedBareImports = (page) => [...reachFrom([page])]
        .flatMap((file) => (results.get(file)?.bareImports ?? []).map((bare) => ({ file, bare })))
        .filter(({ file, bare }) => {
            const key = `${page}\n${file}\n${bare.specifier}`;
            return !resolvedBare.has(key) && resolvedBare.add(key);
        });
    // One pass over every page; true when it added an edge (a new import to follow).
    const resolveBarePass = () => {
        let changed = false;
        for (const page of pages) {
            const map = results.get(page).importMap;
            for (const { file, bare } of unresolvedBareImports(page)) {
                if (resolveBare(page, map, file, bare)) changed = true;
            }
        }
        return changed;
    };
    while (resolveBarePass());
    const pageReached = new Set(pages.flatMap((page) => [...reachFrom([page])]));
    const workerGraph = workerFile && edges.has(workerFile) ? reachFrom([workerFile]) : new Set();
    for (const [file, fileResult] of results) {
        const where = workerGraph.has(file) ? 'the service worker has no import map' : !pageReached.has(file) ? 'no page loads this module' : null;
        for (const bare of where ? fileResult.bareImports ?? [] : []) {
            errors.push(`${bare.label}: bare module specifier "${bare.specifier}" cannot be loaded by an unbundled extension (${where})`);
        }
    }
    const documents = new Map(); // page -> { normal, opaque, inert, all }
    const documentOf = (page) => {
        if (!documents.has(page)) {
            const result = results.get(page);
            const count = (list) => list.reduce((counts, path) => counts.set(path, (counts.get(path) ?? 0) + 1), new Map());
            const refs = count(edges.get(page) || []);
            const opaqueRefs = count(result.opaqueRefs.filter((path) => packaged.has(path)));
            const normal = reachFrom([...refs.keys()].filter((path) => !isPage(path) && refs.get(path) > (opaqueRefs.get(path) ?? 0)));
            normal.add(page);
            const opaque = new Set([...reachFrom([...opaqueRefs.keys()])].filter((file) => !normal.has(file)));
            const inert = new Set([...reachFrom(result.inertScripts)].filter((file) => !normal.has(file) && !opaque.has(file)));
            documents.set(page, { normal, opaque, inert, all: new Set([...normal, ...opaque, ...inert]) });
        }
        return documents.get(page);
    };
    // A preload's integrity applies where the page then uses the preloaded response: a later
    // script or stylesheet of that URL with the same CORS mode and no integrity of its own, an
    // import, or a font.
    const checkPreloads = (page, result, loads) => {
        for (const preload of result.preloads) {
            const consumed = loads.some((load) => load.path === preload.path && !load.hint &&
                (load.from !== page || load.order == null || load.order > preload.order) && (preload.as === 'font'
                ? load.directive === 'font-src' && preload.cors
                : load.directive === (preload.as === 'script' ? 'script-src' : 'style-src') && Boolean(load.cors) === preload.cors && !load.ownIntegrity));
            if (!consumed || !packaged.has(preload.path)) continue;
            const problem = servedIntegrityProblem(preload.path, preload.integrity);
            if (problem) errors.push(`${page} line ${preload.line}: preload integrity="${preload.integrity}" for ${preload.path} ${problem}`);
        }
    };
    // An import map's integrity entry applies to module fetches of that URL with no integrity
    // attribute of their own: module scripts, modulepreloads and imports (not classic scripts).
    // A module script or modulepreload with its own integrity attribute fetches the URL once for
    // the page's module map, so the map's entry for it is never used.
    const checkMapIntegrity = (page, result, loads) => {
        const moduleFetched = new Set(loads.filter((load) => load.module && !load.mapAddress).map((load) => load.path));
        const ownIntegrity = new Set(result.uses.filter((load) => load.module && load.integrityAttr).map((load) => load.path));
        for (const entry of result.mapIntegrity) {
            if (!moduleFetched.has(entry.path) || ownIntegrity.has(entry.path) || !packaged.has(entry.path)) continue;
            const problem = integrityProblem(entry.integrity, readFileSync(join(root, entry.path)));
            if (problem) errors.push(`${page} line ${entry.line}: import map integrity "${entry.integrity}" for ${entry.path} ${problem}`);
        }
    };
    for (const page of pages) {
        const result = results.get(page);
        const { normal } = documentOf(page);
        // Every load in this document, with the file that makes it (a page's own carry their order).
        const loads = [...normal].flatMap((file) => (results.get(file)?.uses ?? []).map((load) => ({ ...load, from: file })));
        checkPreloads(page, result, loads);
        checkMapIntegrity(page, result, loads);
    }
    // url()s in custom properties resolve where var() finally substitutes the property, following
    // chains (--b: var(--a)), within one document: a page with the stylesheets it loads, or a
    // stylesheet no page loads on its own. A property registered with @property and a <url> syntax
    // resolves where it is declared (also when it holds a chain).
    const reachedSheets = new Set(pages.flatMap((page) => [...documentOf(page).all]));
    // Each document's members: files with their var() readers, chains and custom url()s. A srcdoc
    // is its own document: the stylesheets it links plus its inline styles (resolved at the page).
    const member = (file) => ({ file, ...results.get(file) });
    const cssSheets = (roots) => [...reachFrom(roots)].filter((file) => /\.css$/i.test(file));
    const pageCssDocuments = (page) => {
        const result = results.get(page);
        const fromSrcdoc = new Set(result.srcdocRefs.map((ref) => ref.path));
        const pageRoots = (edges.get(page) || []).filter((path) => !isPage(path) && !(fromSrcdoc.has(path) &&
            (edges.get(page) || []).filter((ref) => ref === path).length <= result.srcdocRefs.filter((ref) => ref.path === path).length));
        return [
            [member(page), ...cssSheets(pageRoots).map(member)],
            ...result.srcdocs.map((srcdoc) => [
                { file: page, varUses: srcdoc.varUses, varChains: srcdoc.varChains, registeredUrls: srcdoc.registeredUrls, customRefs: [] },
                ...cssSheets(result.srcdocRefs.filter((ref) => ref.id === srcdoc.id).map((ref) => ref.path)).map(member)
            ])
        ];
    };
    const cssDocuments = [
        ...pages.flatMap(pageCssDocuments),
        ...files.filter((file) => /\.css$/i.test(file) && results.has(file) && !reachedSheets.has(file)).map((file) => [member(file)])
    ];
    // One custom url() from `file`, resolved at `site` (a file that reads its property).
    const resolveCustomRef = (file, ref, site) => {
        const siteResult = results.get(site);
        const base = siteResult.documentBase;
        const located = base?.externalBase ? locator(site, extensionId).locate(ref.url, base) : { local: resolveRef(base ? posix.join(base.localDir, '_') : site, ref.url) };
        const where = site === file ? `${file}: url(${ref.url}) in ${ref.name}` : `${site} uses ${ref.name} from ${file}: url(${ref.url})`;
        if (located.local) {
            if (!packaged.has(located.local)) errors.push(`${where} resolves to ${located.local}, which is not in the package`);
            else edges.get(site)?.push(located.local);
        } else if (located.external) {
            siteResult.external.push({ url: located.external, directive: ref.directive, policies: siteResult.policies, nonce: null, parserInserted: false });
        }
    };
    const resolveCustomRefs = (members) => {
        // @property registrations count only within their own document.
        const registeredUrls = new Set(members.flatMap((entry) => entry.registeredUrls ?? []));
        const readersOf = (property, seen = new Set()) => {
            if (seen.has(property)) return [];
            seen.add(property);
            const direct = members.filter((entry) => entry.varUses?.includes(property)).map((entry) => entry.file);
            const viaChains = members.flatMap((entry) => (entry.varChains ?? [])
                .filter(([, read]) => read === property)
                .flatMap(([holder]) => (registeredUrls.has(holder) ? [entry.file] : readersOf(holder, seen))));
            return [...new Set([...direct, ...viaChains])];
        };
        for (const { file, customRefs = [] } of members) {
            for (const ref of customRefs) {
                const sites = registeredUrls.has(ref.name) ? [file] : readersOf(ref.name);
                sites.forEach((site) => resolveCustomRef(file, ref, site));
            }
        }
    };
    cssDocuments.forEach(resolveCustomRefs);
    // Each file's loads are checked under the policies of every page context that reaches it.
    // A page's own loads: its CSP plus the <meta> CSPs in effect where each appears. The
    // stylesheets and modules a page loads: its CSP plus all its <meta> CSPs (they load after
    // parsing; a sandbox page's stylesheet runs under the sandbox CSP); those reached only from an
    // opaque srcdoc load in that sandbox, and those reached only through scripts the page never
    // runs aren't loaded at all. Files no page reaches (the service worker, content scripts) use
    // extension_pages. A module graph inherits the nonce of the script element (or import) that
    // roots it.
    const contexts = new Map(); // file -> Map(page -> { policies, nonces, sandbox })
    const addPageContexts = (page) => {
        const result = results.get(page);
        const { normal, opaque, inert } = documentOf(page);
        const policies = policiesAt(page, result.policies);
        const nonces = new Map(); // file -> nonces it inherits in this page
        for (const root of result.uses.filter((load) => load.directive === 'script-src' && load.nonce && !load.hint)) {
            for (const file of reachFrom([root.path])) {
                if (!nonces.has(file)) nonces.set(file, new Set());
                nonces.get(file).add(root.nonce);
            }
        }
        const set = (file, context) => {
            if (!contexts.has(file)) contexts.set(file, new Map());
            contexts.get(file).set(page, context);
        };
        normal.forEach((file) => set(file, { policies, nonces: [...(nonces.get(file) ?? [])], sandbox: isSandboxPage(page) }));
        opaque.forEach((file) => set(file, { policies, nonces: [], sandbox: true }));
        inert.forEach((file) => set(file, { policies: [], nonces: [], sandbox: true }));
        // What a srcdoc links loads in that document, under its own policies (the page's at the
        // iframe plus the srcdoc's <meta> CSPs).
        for (const srcdoc of result.srcdocs) {
            const roots = result.srcdocRefs.filter((ref) => ref.id === srcdoc.id && packaged.has(ref.path)).map((ref) => ref.path);
            for (const file of reachFrom(roots)) {
                contexts.get(file)?.set(`${page}#${srcdoc.id}`, { policies: policiesAt(page, srcdoc.policies), nonces: [], sandbox: isSandboxPage(page) || srcdoc.opaque });
            }
        }
    };
    pages.forEach(addPageContexts);
    const extensionContext = { policies: [[csp, 'manifest CSP'], ...minimum], nonces: [], sandbox: false };
    // One load by `file`, under each page context that reaches it.
    const checkLoad = (file, load) => {
        if (load.url && !/^(https?|wss?|data|blob|chrome-extension):/i.test(load.url)) return;
        const pageContexts = isPage(file)
            ? [{ policies: policiesAt(file, load.policies), nonces: [], sandbox: isSandboxPage(file) }]
            : [...(contexts.get(file)?.values() ?? [extensionContext])];
        // Chrome exempts chrome-extension: URLs from CSP, except scripts on (non-sandbox,
        // non-opaque) extension pages.
        const extensionUrl = load.path !== undefined || /^chrome-extension:/i.test(load.url);
        for (const context of pageContexts) {
            if (extensionUrl && (load.directive !== 'script-src' || context.sandbox || load.sandboxed)) continue;
            const blocked = context.policies.find(([loadPolicy]) => loadBlocked(loadPolicy, load, context.nonces, extensionId));
            if (blocked) errors.push(`${file} loads ${load.url ?? load.path}, which the ${blocked[1]} blocks (${blockedReason(blocked[0], load)})`);
        }
    };
    for (const [file, result] of results) {
        for (const load of [...result.external, ...result.uses]) checkLoad(file, load);
    }
    // Static declarativeNetRequest rulesets: Chrome silently ignores invalid rules in a packed
    // extension, so check each file's shape (JSON array of rules with unique positive integer
    // ids, an action with a known type and a condition object).
    const checkRuleset = (path) => {
        let rules;
        try {
            rules = JSON.parse(read(path));
        } catch (error) {
            errors.push(`${path}: declarativeNetRequest ruleset is not valid JSON (${error.message})`);
            return;
        }
        if (!Array.isArray(rules)) {
            errors.push(`${path}: declarativeNetRequest ruleset must be a JSON array of rules`);
            return;
        }
        const ruleIds = new Set();
        rules.forEach((rule, index) => errors.push(...ruleProblems(rule, ruleIds, packaged).map((problem) => `${path} rule ${index}: ${problem}`)));
    };
    const rulesets = Array.isArray(manifest.declarative_net_request?.rule_resources) ? manifest.declarative_net_request.rule_resources : [];
    for (const resource of rulesets) {
        if (typeof resource?.path !== 'string') continue;
        const path = posix.normalize(resource.path.replace(/^\//, ''));
        if (packaged.has(path)) checkRuleset(path); // a missing one is reported as a missing reference above
    }
    // Extension service workers don't support import(); check the worker's whole module graph.
    if (workerFile && edges.has(workerFile)) {
        for (const file of [...reachableFrom(edges, [workerFile])].filter((f) => usesDynamicImport.has(f)).sort()) {
            errors.push(`${file} uses import(), which the extension service worker (${workerFile}) can't run; use a static import`);
        }
    }
    const reached = reachableFrom(edges, ['manifest.json']);
    const warnings = files.filter((file) => !reached.has(file) && !inertNamed.has(file)).map((file) => `${file} is packaged but nothing references it`);
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
    // Without the key the extension gets another ID, so check the manifest that ships.
    const shipped = stripKey && 'key' in manifest ? Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'key')) : manifest;
    const { errors, warnings } = checkReferences(root, files, shipped);
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
