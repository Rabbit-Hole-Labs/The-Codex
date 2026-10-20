/**
 * scripts/package-extension.js builds the store upload zip. These tests build
 * fixture extensions and the real repo, then read every zip back with an
 * independent minimal reader (central directory + inflate + CRC).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
    buildPackage,
    collectFiles,
    contentDigest,
    crc32,
    createZip,
    cspAllows,
    cssRefs,
    cssUnescape,
    extensionIdFromKey,
    parseCsp,
    scanHtml,
    srcsetUrls,
    validateManifest
} from '../../scripts/package-extension.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Reads a zip's central directory and returns { name -> Buffer } (directories as null). */
function readZip(zip) {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(end).toBeGreaterThan(-1);
    const count = zip.readUInt16LE(end + 10);
    let pos = zip.readUInt32LE(end + 16);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
        expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
        const method = zip.readUInt16LE(pos + 10);
        const crc = zip.readUInt32LE(pos + 16);
        const compressed = zip.readUInt32LE(pos + 20);
        const size = zip.readUInt32LE(pos + 24);
        const nameLength = zip.readUInt16LE(pos + 28);
        const extraLength = zip.readUInt16LE(pos + 30);
        const commentLength = zip.readUInt16LE(pos + 32);
        const localOffset = zip.readUInt32LE(pos + 42);
        const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength);

        expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
        const localName = zip.readUInt16LE(localOffset + 26);
        const localExtra = zip.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localName + localExtra;
        const body = zip.subarray(start, start + compressed);
        const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
        expect(data.length).toBe(size);
        expect(crc32(data)).toBe(crc);
        entries.set(name, name.endsWith('/') ? null : data);
        pos += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

function writeFixture(root, files) {
    for (const [name, content] of Object.entries(files)) {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
}

// A real public key in the Web Store's format (base64 DER SubjectPublicKeyInfo).
const FIXTURE_KEY = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const MANIFEST = {
    manifest_version: 3,
    name: 'Fixture',
    version: '1.2.3.4',
    description: 'A fixture extension.',
    key: FIXTURE_KEY,
    background: { service_worker: 'javascript/background/sw.js', type: 'module' },
    chrome_url_overrides: { newtab: 'index.html' },
    action: { default_popup: 'popup.html' },
    icons: { 128: 'assets/icons/icon128.png' }
};

function fixtureFiles(overrides = {}) {
    return {
        'manifest.json': JSON.stringify(MANIFEST, null, 2),
        'index.html': '<link rel="stylesheet" href="stylesheets/base.css"><a href="manage.html">m</a>' +
            '<link href="https://fonts.example.com/x.css" rel="stylesheet">' +
            '<script type="module" src="javascript/entry-points/script.js"></script>',
        'manage.html': '<!-- <script src="javascript/missing.js"></script> -->' +
            '<script type="module" src="javascript/entry-points/manage.js"></script>',
        'popup.html': '<script type="module" src="javascript/entry-points/popup.js"></script>',
        'javascript/entry-points/script.js': "import { a } from '../features/a.js';\nimport '../features/side.js';\n" +
            "// import { gone } from '../features/gone.js';\n/* import x from './nope.js' */\nconst lazy = () => import('../features/lazy.js');\n",
        'javascript/entry-points/manage.js': "import {\n    a,\n} from '../features/a.js';\n",
        'javascript/entry-points/popup.js': "export { a } from '../features/a.js';\n",
        'javascript/features/a.js': 'export const a = 1;\n',
        'javascript/features/side.js': 'globalThis.side = true;\n',
        'javascript/features/lazy.js': 'export default 1;\n',
        'javascript/features/a.d.ts': 'export const a: number;\n',
        'javascript/features/a.test.js': 'test("x", () => {});\n',
        'javascript/background/sw.js': "import { a } from '../features/a.js';\n",
        'stylesheets/base.css': '.x { background: url("data:image/svg+xml,%3Csvg%3E"); }\n',
        'assets/icons/icon128.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        'assets/icons/.DS_Store': 'junk',
        'tests/unit/ignored.test.js': 'not packaged',
        ...overrides
    };
}

describe('package-extension', () => {
    let root;
    let out;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'codex-pkg-'));
        out = join(root, 'dist');
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test('packages only the allowlisted extension files', () => {
        writeFixture(root, fixtureFiles());
        expect(collectFiles(root)).toEqual([
            'assets/icons/icon128.png',
            'index.html',
            'javascript/background/sw.js',
            'javascript/entry-points/manage.js',
            'javascript/entry-points/popup.js',
            'javascript/entry-points/script.js',
            'javascript/features/a.js',
            'javascript/features/lazy.js',
            'javascript/features/side.js',
            'manage.html',
            'manifest.json',
            'popup.html',
            'stylesheets/base.css'
        ]);
    });

    test('zip round-trips byte-for-byte with manifest.json at the root and the key kept', () => {
        const files = fixtureFiles();
        writeFixture(root, files);
        const result = buildPackage({ root, outDir: out });

        expect(result.zipName).toBe('the-codex-1.2.3.4.zip');
        expect(result.warnings).toEqual([]);
        const entries = readZip(readFileSync(result.zipPath));
        for (const name of result.files) {
            expect(entries.get(name).equals(Buffer.from(files[name]))).toBe(true);
        }
        expect(entries.has('manifest.json')).toBe(true);
        expect(JSON.parse(entries.get('manifest.json')).key).toBe(FIXTURE_KEY);
        expect(entries.has('javascript/')).toBe(true);
        expect(entries.has('javascript/features/a.d.ts')).toBe(false);
        expect([...entries.keys()].some((name) => name.startsWith('tests/'))).toBe(false);
    });

    test('--strip-key removes only the manifest key and names the zip accordingly', () => {
        writeFixture(root, fixtureFiles());
        const result = buildPackage({ root, outDir: out, stripKey: true });

        expect(result.zipName).toBe('the-codex-1.2.3.4-nokey.zip');
        const manifest = JSON.parse(readZip(readFileSync(result.zipPath)).get('manifest.json'));
        expect(manifest.key).toBeUndefined();
        const expected = { ...MANIFEST };
        delete expected.key;
        expect(manifest).toEqual(expected);
    });

    test('is deterministic: rebuilding the same sources gives identical bytes', () => {
        writeFixture(root, fixtureFiles());
        const first = buildPackage({ root, outDir: join(root, 'a') });
        const second = buildPackage({ root, outDir: join(root, 'b') });
        expect(readFileSync(first.zipPath).equals(readFileSync(second.zipPath))).toBe(true);
        expect(first.sha256).toBe(second.sha256);
    });

    test('fails when a referenced file is missing from the package', () => {
        writeFixture(root, fixtureFiles({
            'javascript/entry-points/popup.js': "import { b } from '../features/b.js';\n"
        }));
        expect(() => buildPackage({ root, outDir: out }))
            .toThrow('javascript/entry-points/popup.js references javascript/features/b.js, which is not in the package');
    });

    test('fails when a referenced file is excluded from the package (e.g. a .d.ts)', () => {
        writeFixture(root, fixtureFiles({
            'javascript/features/a.js': "export * from './a.d.ts';\n"
        }));
        expect(() => buildPackage({ root, outDir: out })).toThrow('references javascript/features/a.d.ts');
    });

    test('fails on manifest references that do not exist and on bare module specifiers', () => {
        writeFixture(root, fixtureFiles({
            'manifest.json': JSON.stringify({ ...MANIFEST, icons: { 48: 'assets/icons/icon48.png' } }),
            'javascript/features/side.js': "import lodash from 'lodash';\n"
        }));
        let message = '';
        try {
            buildPackage({ root, outDir: out });
        } catch (error) {
            message = error.message;
        }
        expect(message).toContain('manifest.json references assets/icons/icon48.png');
        expect(message).toContain('bare module specifier "lodash"');
    });

    test('warns about packaged files nothing references', () => {
        writeFixture(root, fixtureFiles({ 'javascript/features/orphan.js': 'export const o = 1;\n' }));
        const result = buildPackage({ root, outDir: out });
        expect(result.warnings).toEqual(['javascript/features/orphan.js is packaged but nothing references it']);
    });

    test('rejects manifests the Web Store would refuse', () => {
        expect(validateManifest({ ...MANIFEST, description: 'x'.repeat(133) }))
            .toEqual(['description is 133 characters; the Web Store allows 132']);
        expect(validateManifest({ ...MANIFEST, description: 'x'.repeat(132) })).toEqual([]);
        for (const version of ['1.2.3.4.5', '01.2', '1.70000', '', '1..2', 'v1']) {
            expect(validateManifest({ ...MANIFEST, version })).toHaveLength(1);
        }
        expect(validateManifest({ ...MANIFEST, manifest_version: 2 })).toEqual(['manifest_version must be 3']);
        writeFixture(root, fixtureFiles({ 'manifest.json': '{ // comment\n "manifest_version": 3 }' }));
        expect(() => buildPackage({ root, outDir: out })).toThrow('manifest.json is not valid JSON');
    });

    const buildError = (overrides) => {
        writeFixture(root, fixtureFiles(overrides));
        try {
            buildPackage({ root, outDir: out });
        } catch (error) {
            return error.message;
        }
        return '';
    };

    test("a '/*' inside a line comment or string does not hide a missing import", () => {
        expect(buildError({
            'javascript/features/a.js': "// icons may be data:image/* URIs\nimport { s } from './gone.js';\nexport const a = 1;\n"
        })).toContain('javascript/features/a.js references javascript/features/gone.js');
        expect(buildError({
            'javascript/features/a.js': "const accept = 'image/*';\nimport { s } from './gone2.js';\nexport const a = 1;\n"
        })).toContain('references javascript/features/gone2.js');
    });

    test('import forms without spaces are checked', () => {
        const message = buildError({
            'javascript/features/a.js': "import{x}from'./n1.js';import*as y from'./n2.js';export{z}from'./n3.js';export const a = 1;\n"
        });
        for (const name of ['n1', 'n2', 'n3']) expect(message).toContain(`references javascript/features/${name}.js`);
    });

    test('every packaged module is checked, even one nothing reaches', () => {
        expect(buildError({ 'javascript/features/orphan.js': "import { g } from './gone.js';\n" }))
            .toContain('javascript/features/orphan.js references javascript/features/gone.js');
    });

    test('syntax errors fail the build', () => {
        expect(buildError({ 'javascript/features/a.js': 'export const a = ;\n' })).toContain('javascript/features/a.js: SyntaxError');
    });

    test('dynamic import(): literal paths are checked, anything else fails', () => {
        expect(buildError({
            'javascript/features/lazy.js': 'export default () => import(`./gone.js`);\n'
        })).toContain('javascript/features/lazy.js references javascript/features/gone.js');
        expect(buildError({
            'javascript/features/lazy.js': "const name = './a.js';\nexport default () => import(name);\n"
        })).toContain("javascript/features/lazy.js:2: import() without a literal path can't be checked");
        writeFixture(root, fixtureFiles({ 'javascript/features/lazy.js': "export const load = () => import('./a.js', { with: {} });\nexport const m = obj => obj.import('x');\n" }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('manifest keys the packager does not understand fail the build', () => {
        expect(validateManifest({ ...MANIFEST, web_accessible_resources: [{ resources: ['x.png'], matches: ['<all_urls>'] }] }))
            .toEqual([expect.stringContaining('manifest key "web_accessible_resources" is not understood')]);
        expect(validateManifest({ ...MANIFEST, default_locale: 'en' }))
            .toEqual(expect.arrayContaining([expect.stringContaining('default_locale/__MSG_ strings are not supported')]));
        expect(validateManifest({ ...MANIFEST, short_name: 'Codex.js' })).toEqual([]);
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, icons: { 128: 'assets/icons/icon@2x.png' } }) }))
            .toContain('manifest.json references assets/icons/icon@2x.png');
    });

    test('version must be a non-zero string and the name at most 75 characters', () => {
        expect(validateManifest({ ...MANIFEST, version: 7 })).toEqual(['version must be a string']);
        expect(validateManifest({ ...MANIFEST, version: '0.0.0.0' })).toHaveLength(1);
        expect(validateManifest({ ...MANIFEST, name: 'N'.repeat(76) })).toEqual(['name is 76 characters; Chrome allows 75']);
        expect(validateManifest({ ...MANIFEST, name: 'N'.repeat(75) })).toEqual([]);
    });

    test('hidden directories are not packaged and symlinks are refused', () => {
        writeFixture(root, fixtureFiles({ 'javascript/.idea/workspace.json': '{}', 'assets/.git/HEAD': 'ref' }));
        expect(collectFiles(root).some((name) => name.includes('/.'))).toBe(false);
        symlinkSync(join(root, 'tests'), join(root, 'assets/linked'));
        expect(() => collectFiles(root)).toThrow('assets/linked is a symlink');
    });

    test('HTML srcset, unquoted and style references are checked; data-* attributes are not', () => {
        const message = buildError({
            'popup.html': '<img srcset="assets/a.png 1x, assets/b.png 2x" data-src="nope.png">' +
                '<img src=assets/c.png><div style="background: url(\'assets/d.png\')"></div>' +
                '<style>.x { background: url(assets/e.png) }</style>' +
                '<script type="module" src="javascript/entry-points/popup.js"></script>'
        });
        for (const name of ['a', 'b', 'c', 'd', 'e']) expect(message).toContain(`popup.html references assets/${name}.png`);
        expect(message).not.toContain('nope.png');
    });

    test("CSS: a '/*' inside a string does not hide a later url(), and var() is not a path", () => {
        const message = buildError({
            'stylesheets/base.css': '.a::after { content: "/*"; }\n.b { background: url(missing.png); }\n.c { background: url(var(--bg)); }\n'
        });
        expect(message).toContain('stylesheets/base.css references stylesheets/missing.png');
        expect(message).not.toContain('var(');
    });

    test('percent-encoded references are decoded before the existence check', () => {
        writeFixture(root, fixtureFiles({
            'assets/icons/my icon.png': 'png',
            'stylesheets/base.css': '.x { background: url("../assets/icons/my%20icon.png"); }\n'
        }));
        expect(buildPackage({ root, outDir: out }).warnings).toEqual([]);
    });

    test('the content digest ignores compression but tracks contents', () => {
        writeFixture(root, fixtureFiles());
        const first = buildPackage({ root, outDir: join(root, 'a') });
        writeFileSync(join(root, 'javascript/features/a.js'), 'export const a = 2;\n');
        const second = buildPackage({ root, outDir: join(root, 'b') });
        expect(first.contentSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(second.contentSha256).not.toBe(first.contentSha256);
        expect(contentDigest([{ name: 'x', data: Buffer.from('1') }])).toBe(contentDigest([{ name: 'x', data: Buffer.from('1') }]));
    });

    test('the CLI builds when run through a symlinked path and resolves --out-dir from INIT_CWD', () => {
        const link = join(root, 'repo-link');
        symlinkSync(REPO_ROOT, link);
        const output = execFileSync(process.execPath, [
            '--experimental-vm-modules', '--disable-warning=ExperimentalWarning',
            join(link, 'scripts/package-extension.js'), '--out-dir', 'cli-out'
        ], { encoding: 'utf8', env: { ...process.env, INIT_CWD: root, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } });
        expect(output).toContain(`Built ${join(root, 'cli-out')}`);
        for (const args of [['--out-dir'], ['--out-dir', '']]) {
            expect(() => execFileSync(process.execPath, ['--experimental-vm-modules', join(REPO_ROOT, 'scripts/package-extension.js'), ...args], { stdio: 'pipe' }))
                .toThrow();
        }
        const noFlag = (() => {
            try {
                execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/package-extension.js'), '--out-dir', join(root, 'x')], { stdio: 'pipe' });
                return '';
            } catch (error) {
                return error.stderr.toString();
            }
        })();
        expect(noFlag.match(/--experimental-vm-modules/g)).toHaveLength(1);
    });

    test('CSS: an escaped quote does not let a later "/*" string hide url()s', () => {
        const message = buildError({
            'stylesheets/base.css': 'q::before { content: "\\""; }\n.c::after { content: "/*"; }\n.d { background: url(gone.png); }\n' +
                ".e::after { content: 'it\\'s /*'; }\n.f { background: url(\"p(1).png\"); }\n"
        });
        expect(message).toContain('stylesheets/base.css references stylesheets/gone.png');
        expect(message).toContain('stylesheets/base.css references stylesheets/p(1).png');
    });

    test('dynamic import with a comment before the parenthesis is still checked', () => {
        expect(buildError({ 'javascript/features/lazy.js': "export default () => import /* c */ ('./gone.js');\n" }))
            .toContain('javascript/features/lazy.js references javascript/features/gone.js');
        expect(buildError({ 'javascript/features/lazy.js': 'const n = "x";\nexport default () => import // c\n(n);\n' }))
            .toContain("javascript/features/lazy.js:2: import() without a literal path can't be checked");
    });

    test("HTML: '<!--' inside an attribute value does not hide later references", () => {
        expect(buildError({
            'index.html': '<div title="<!--"></div><script type="module" src="javascript/gone.js"></script><!-- x -->' +
                '<script type="module" src="javascript/entry-points/script.js"></script>'
        })).toContain('index.html references javascript/gone.js');
        expect(buildError({
            'popup.html': '<a href="a&#x2F;b.html">x</a><script type="module" src="javascript/entry-points/popup.js"></script>'
        })).toContain('popup.html references a/b.html');
    });

    test('malformed manifest fields give clear errors instead of crashing', () => {
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, sandbox: { pages: 'sb.html' } }) }))
            .toContain('manifest "sandbox" has an unexpected shape');
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, background: null }) }))
            .toContain('manifest "background" has an unexpected shape');
        expect(validateManifest({ ...MANIFEST, icons: null })).toEqual(['icons must be an object']);
        expect(validateManifest({ ...MANIFEST, description: 5 })).toEqual(['description must be a string']);
        expect(validateManifest({ ...MANIFEST, background: { service_worker: 'sw.js' } }))
            .toEqual(['background.type must be "module": the packager checks JS files as ES modules']);
        expect(validateManifest({ ...MANIFEST, default_locale: 'en' })).toHaveLength(1);
    });

    test('manifest paths are literal: percent escapes are not decoded', () => {
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, icons: { 128: 'assets/icons/icon%31%32%38.png' } }) }))
            .toContain('manifest.json references assets/icons/icon%31%32%38.png');
    });

    test('--strip-key without a key keeps the plain zip name', () => {
        const manifest = { ...MANIFEST };
        delete manifest.key;
        writeFixture(root, fixtureFiles({ 'manifest.json': JSON.stringify(manifest) }));
        expect(buildPackage({ root, outDir: out, stripKey: true }).zipName).toBe('the-codex-1.2.3.4.zip');
    });

    test('srcset: a data: URL keeps its comma; other candidates are still checked', () => {
        expect(srcsetUrls('data:image/png;base64,AAAA 1x, assets/two.png 2x')).toEqual(['data:image/png;base64,AAAA', 'assets/two.png']);
        expect(srcsetUrls('a.png, b.png 2x , c.png (min-width: 1px, x) 3x')).toEqual(['a.png', 'b.png', 'c.png']);
        // Per the HTML rules a URL runs to whitespace, so 'a.png,b.png' is one URL; trailing commas end it.
        expect(srcsetUrls('a.png,b.png 2x')).toEqual(['a.png,b.png']);
        expect(srcsetUrls('a.png, b.png,')).toEqual(['a.png', 'b.png']);
        writeFixture(root, fixtureFiles({
            'popup.html': '<img srcset="data:image/png;base64,AAAA 1x, assets/icons/icon128.png 2x">' +
                '<script type="module" src="javascript/entry-points/popup.js"></script>'
        }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({
            'popup.html': '<img srcset="data:image/png;base64,AAAA 1x, assets/gone.png 2x">' +
                '<script type="module" src="javascript/entry-points/popup.js"></script>'
        })).toContain('popup.html references assets/gone.png');
    });

    test('an output directory inside a packaged directory is refused', () => {
        writeFixture(root, fixtureFiles());
        expect(() => buildPackage({ root, outDir: join(root, 'assets/build') }))
            .toThrow('is inside the packaged "assets"');
        expect(() => buildPackage({ root, outDir: join(root, 'javascript') })).toThrow('is inside the packaged "javascript"');
        expect(() => buildPackage({ root, outDir: join(root, 'release') })).not.toThrow();
    });

    test('MV2-only background and action fields are rejected in an MV3 manifest', () => {
        expect(validateManifest({ ...MANIFEST, background: { ...MANIFEST.background, scripts: ['a.js'] } }))
            .toEqual(['background.scripts is MV2-only; MV3 uses background.service_worker']);
        expect(validateManifest({ ...MANIFEST, background: { ...MANIFEST.background, page: 'bg.html' } }))
            .toEqual(['background.page is MV2-only; MV3 uses background.service_worker']);
        expect(validateManifest({ ...MANIFEST, browser_action: {} })).toEqual(['browser_action is MV2-only; MV3 uses action']);
    });

    test("import() anywhere in the service worker's module graph fails; pages may use it", () => {
        expect(buildError({ 'javascript/features/a.js': "export const a = 1;\nexport const load = () => import('./lazy.js');\n" }))
            .toContain("javascript/features/a.js uses import(), which the extension service worker (javascript/background/sw.js) can't run");
        // fixture script.js (page-only) already uses import('../features/lazy.js')
        writeFixture(root, fixtureFiles());
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('a background (or other path field) of the wrong JSON type is rejected', () => {
        for (const background of ['javascript/background/sw.js', ['x'], true]) {
            expect(validateManifest({ ...MANIFEST, background })).toContain('background must be an object');
        }
        expect(validateManifest({ ...MANIFEST, content_scripts: {} })).toContain('content_scripts must be an array');
        expect(validateManifest({ ...MANIFEST, options_page: ['o.html'] })).toContain('options_page must be a string');
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, background: 'javascript/background/sw.js' }) }))
            .toContain('background must be an object');
    });

    test('CSS escapes are decoded, so escaped spaces and hex escapes are checked', () => {
        expect(cssUnescape('my\\ icon.png')).toBe('my icon.png');
        expect(cssUnescape('\\61 b.png')).toBe('ab.png');
        expect(cssUnescape('a\\"b')).toBe('a"b');
        const message = buildError({
            'stylesheets/base.css': '.a { background: url(../assets/my\\ gone.png); }\n' +
                '.b { background: url("../assets/\\67 one2.png"); }\n.c { background: url(\'../assets/q\\\'s.png\'); }\n'
        });
        expect(message).toContain('stylesheets/base.css references assets/my gone.png');
        expect(message).toContain('stylesheets/base.css references assets/gone2.png');
        expect(message).toContain("stylesheets/base.css references assets/q's.png");
        writeFixture(root, fixtureFiles({
            'assets/icons/my icon.png': 'png',
            'stylesheets/base.css': '.x { background: url(../assets/icons/my\\ icon.png); }\n'
        }));
        expect(buildPackage({ root, outDir: out }).warnings).toEqual([]);
    });

    test('content scripts and non-module <script> files must compile as classic scripts', () => {
        const withContentScript = JSON.stringify({ ...MANIFEST, content_scripts: [{ matches: ['<all_urls>'], js: ['javascript/content.js'] }] });
        expect(buildError({
            'manifest.json': withContentScript,
            'javascript/content.js': "import { a } from './features/a.js';\nconsole.log(a);\n"
        })).toContain('javascript/content.js runs as a classic script');
        writeFixture(root, fixtureFiles({ 'manifest.json': withContentScript, 'javascript/content.js': 'with (Math) { console.log(PI); }\n' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow(); // sloppy classic code is fine there
        expect(buildError({
            'popup.html': '<script src="javascript/entry-points/popup.js"></script>'
        })).toContain('javascript/entry-points/popup.js runs as a classic script');
    });

    test('HTML text and <textarea> content are not markup: no phantom refs, no swallowed tags', () => {
        writeFixture(root, fixtureFiles({
            'popup.html': '<p>href="missing.html" src=gone.js</p><textarea>href="missing.html"</textarea>' +
                '<title><img src="nope.png"></title><script type="module" src="javascript/entry-points/popup.js"></script>'
        }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({
            'popup.html': '<textarea><!--</textarea><img src="assets/missing.png">' +
                '<script type="module" src="javascript/entry-points/popup.js"></script>'
        })).toContain('popup.html references assets/missing.png');
        expect(scanHtml('<a title=">" href=x.html>').map((t) => t.attrs.get('href'))).toEqual(['x.html']);
    });

    test('CSS: url()-like text inside a string is not a reference; @import and @font-face are typed', () => {
        expect(cssRefs('.l::after { content: "url(missing.png)"; } .m { background: url(ok.png) }')).toEqual([{ url: 'ok.png', directive: 'img-src' }]);
        expect(cssRefs('@import "a.css"; @import url(b.css) screen; @font-face { src: url(f.woff2) format("woff2"); } .x { cursor: url(c.cur), auto }'))
            .toEqual([
                { url: 'a.css', directive: 'style-src' },
                { url: 'b.css', directive: 'style-src' },
                { url: 'f.woff2', directive: 'font-src' },
                { url: 'c.cur', directive: 'img-src' }
            ]);
        expect(cssRefs('.i { background: image-set(url(a.png) 1x, "b.png" 2x type("image/avif")) }').map((r) => r.url)).toEqual(['a.png', 'b.png']);
        expect(buildError({ 'stylesheets/base.css': '.l::after { content: "url(missing.png)"; }\n.m { background: url(gone.png) }\n' }))
            .not.toContain('missing.png');
    });

    test('CSS: escapes inside function names and unquoted url tokens are consumed whole', () => {
        expect(cssRefs('.a { background: u\\72 l(missing.png) }')).toEqual([{ url: 'missing.png', directive: 'img-src' }]);
        expect(cssRefs('.a { background: url(a\\31 b.png) }')).toEqual([{ url: 'a1b.png', directive: 'img-src' }]);
        expect(buildError({ 'stylesheets/base.css': '.a { background: u\\72 l(gone.png) }\n' }))
            .toContain('stylesheets/base.css references stylesheets/gone.png');
    });

    test('escaped at-keywords are decoded: @\\69 mport is @import', () => {
        expect(cssRefs('@\\69 mport "missing.css";')).toEqual([{ url: 'missing.css', directive: 'style-src' }]);
    });

    test('content_scripts entries need matches and js or css', () => {
        expect(validateManifest({ ...MANIFEST, content_scripts: [{ js: ['javascript/content.js'] }] }))
            .toContain('content_scripts[0].matches must be a non-empty array of match patterns');
        expect(validateManifest({ ...MANIFEST, content_scripts: [{ matches: ['<all_urls>'] }] }))
            .toContain('content_scripts[0] needs js or css');
        expect(validateManifest({ ...MANIFEST, content_scripts: [{ matches: ['<all_urls>'], css: 'a.css' }] }))
            .toContain('content_scripts[0].css must be a non-empty array of paths');
    });

    test('HTML character references: &sol; decodes; unknown names fail loudly', () => {
        writeFixture(root, fixtureFiles({
            'popup.html': '<img src="assets&sol;icons&sol;icon128.png"><script type="module" src="javascript/entry-points/popup.js"></script>'
        }));
        expect(buildPackage({ root, outDir: out }).warnings).toEqual([]);
        expect(buildError({
            'popup.html': '<img src="assets&frobnicate;x.png"><script type="module" src="javascript/entry-points/popup.js"></script>'
        })).toContain("popup.html line 1: <img src> uses HTML character reference(s) the packager can't decode (&frobnicate;)");
    });

    test('<noscript> content is text on extension pages, markup where scripting is off', () => {
        writeFixture(root, fixtureFiles({
            'popup.html': '<noscript><img src="assets/missing.png"></noscript><script type="module" src="javascript/entry-points/popup.js"></script>'
        }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({
            'manifest.json': JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] }, content_security_policy: { sandbox: "sandbox; script-src 'self'" } }),
            'assets/s.html': '<noscript><img src="missing.png"></noscript>'
        })).toContain('assets/s.html references assets/missing.png');
    });

    test('file extensions are matched case-insensitively', () => {
        expect(buildError({
            'manifest.json': JSON.stringify({ ...MANIFEST, options_page: 'assets/Options.HTML' }),
            'assets/Options.HTML': '<img src="missing.png">'
        })).toContain('assets/Options.HTML references assets/missing.png');
    });

    test('the extension ID is derived from the manifest key like Chrome does', () => {
        const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf8'));
        expect(extensionIdFromKey(manifest.key)).toBe('dimphibhkgnildpnlapckpgnonmaiddj');
        expect(extensionIdFromKey(undefined)).toBeNull();
    });

    test('numeric character references without a semicolon are decoded', () => {
        writeFixture(root, fixtureFiles({
            'popup.html': '<img src="assets&#47icons&#x2Ficon128.png"><script type="module" src="javascript/entry-points/popup.js"></script>'
        }));
        expect(buildPackage({ root, outDir: out }).warnings).toEqual([]);
    });

    test("scheme-relative and own chrome-extension:// URLs are checked as this extension's files", () => {
        const id = extensionIdFromKey(MANIFEST.key);
        const message = buildError({
            'popup.html': `<script type="module" src="//${id}/javascript/missing.js"></script><img src="chrome-extension://${id}/assets/gone.png">` +
                '<script type="module" src="javascript/entry-points/popup.js"></script>'
        });
        expect(message).toContain('popup.html references javascript/missing.js');
        expect(message).toContain('popup.html references assets/gone.png');
    });

    test('SVG xlink:href references are checked; same-document #fragments are not', () => {
        const message = buildError({
            'popup.html': '<svg><image xlink:href="assets/missing.png"/><use xlink:href="#icon"/><use xlink:href="assets/sprite.svg#i"/></svg>' +
                '<script type="module" src="javascript/entry-points/popup.js"></script>'
        });
        expect(message).toContain('popup.html references assets/missing.png');
        expect(message).toContain('popup.html references assets/sprite.svg');
        expect(message).not.toContain('#icon');
    });

    test('permission fields must be arrays of strings', () => {
        expect(validateManifest({ ...MANIFEST, permissions: 'storage' })).toEqual(['permissions must be an array of strings']);
        expect(validateManifest({ ...MANIFEST, host_permissions: [5] })).toEqual(['host_permissions must be an array of strings']);
        expect(validateManifest({ ...MANIFEST, permissions: ['storage'], optional_host_permissions: ['https://*/*'] })).toEqual([]);
    });

    test('abruptly closed HTML comments end at once', () => {
        expect(buildError({ 'popup.html': '<!--><img src="assets/missing1.png"><!---><img src="assets/missing2.png"><!-- x --!><img src="assets/missing3.png">' +
            '<script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toEqual(expect.stringMatching(/missing1[\s\S]*missing2[\s\S]*missing3/));
    });

    test('CSS: @namespace url() is not a fetch, and late or nested @import is ignored', () => {
        expect(cssRefs('@namespace svg url(http://www.w3.org/2000/svg); .a { background: url(ok.png) }')).toEqual([{ url: 'ok.png', directive: 'img-src' }]);
        expect(cssRefs('@charset "utf-8"; @import "a.css"; body { color: red } @import url("late.css");')).toEqual([{ url: 'a.css', directive: 'style-src' }]);
        expect(cssRefs('@media print { @import "nested.css"; }')).toEqual([]);
    });

    test('SVG: modern href on image is an image load; <title> inside <svg> is not RCDATA', () => {
        const message = buildError({
            'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; img-src 'self'" } }),
            'popup.html': '<svg><image href="https://evil.example/x.png"/><title><img src="assets/missing.png"></title></svg><title><img src="nope.png"></title>' +
                '<script type="module" src="javascript/entry-points/popup.js"></script>'
        });
        expect(message).toContain('popup.html loads https://evil.example/x.png, which the manifest CSP blocks (img-src)');
        expect(message).toContain('popup.html references assets/missing.png');
        expect(message).not.toContain('nope.png'); // an HTML <title> is still RCDATA
    });

    test('the manifest key must be a real public key', () => {
        for (const key of ['FIXTUREKEY', 'not base64!!', 5, 'QUJD']) {
            expect(validateManifest({ ...MANIFEST, key })).toContain('key must be the base64 public key from the Chrome Web Store dashboard');
        }
    });

    test('chrome_url_overrides must override exactly one supported page', () => {
        expect(validateManifest({ ...MANIFEST, chrome_url_overrides: { newtab: 'index.html', history: 'index.html' } }))
            .toContain('chrome_url_overrides must override exactly one of newtab, history or bookmarks');
        expect(validateManifest({ ...MANIFEST, chrome_url_overrides: { downloads: 'index.html' } }))
            .toContain('chrome_url_overrides must override exactly one of newtab, history or bookmarks');
    });

    test('&hyphen; and &dash; decode to U+2010, not ASCII -', () => {
        writeFixture(root, fixtureFiles({ 'assets/-.png': 'png' }));
        expect(buildError({ 'assets/-.png': 'png', 'popup.html': '<img src="assets/&dash;.png"><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain('popup.html references assets/\u2010.png');
    });

    test('a scheme-relative <base href> resolves against the extension origin', () => {
        const id = extensionIdFromKey(MANIFEST.key);
        expect(buildError({
            'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'self'" } }),
            'popup.html': `<base href="//${id}/stylesheets/"><img src="missing.png"><script type="module" src="../javascript/entry-points/popup.js"></script>`
        })).toContain('popup.html references stylesheets/missing.png');
        expect(buildError({
            'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'self'" } }),
            'popup.html': '<base href="//bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/sub/"><script type="module" src="javascript/entry-points/popup.js"></script>'
        })).toContain('is blocked by the manifest CSP (base-uri)');
    });

    test('an inline <script> inside <svg> fails as uncheckable', () => {
        expect(buildError({ 'popup.html': '<svg><script>alert(1)</script></svg><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain("popup.html line 1: inline <script> inside <svg> isn't supported by the packager");
    });

    test('declarativeNetRequest rulesets are declared and shaped correctly', () => {
        const dnr = (rules, resource = {}) => ({
            'manifest.json': JSON.stringify({ ...MANIFEST, declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'assets/rules.json', ...resource }] } }),
            'assets/rules.json': typeof rules === 'string' ? rules : JSON.stringify(rules)
        });
        const good = [{ id: 1, action: { type: 'block' }, condition: { urlFilter: 'ads' } }];
        writeFixture(root, fixtureFiles(dnr(good)));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError(dnr('{ not json'))).toContain('assets/rules.json: declarativeNetRequest ruleset is not valid JSON');
        const message = buildError(dnr([{ id: 1, action: { type: 'nuke' }, condition: {} }, { id: 1, action: { type: 'block' } }]));
        expect(message).toContain('assets/rules.json rule 0: action.type must be one of');
        expect(message).toContain('assets/rules.json rule 1: duplicate id 1');
        expect(message).toContain('assets/rules.json rule 1: condition must be an object');
        expect(buildError(dnr(good, { enabled: 'yes' }))).toContain('declarative_net_request.rule_resources[0] needs a string id, a boolean enabled and a string path');
    });

    test('a classic <script> given as the extension\'s own URL must compile as a classic script', () => {
        const id = extensionIdFromKey(MANIFEST.key);
        expect(buildError({ 'popup.html': `<script src="chrome-extension://${id}/javascript/features/side.js"></script><script type="module" src="javascript/entry-points/popup.js"></script>`,
            'javascript/features/side.js': 'export const x = 1;\n' }))
            .toContain('javascript/features/side.js runs as a classic script');
    });

    test('legacy numeric references in the C1 range map like browsers do (&#x80; is €)', () => {
        writeFixture(root, fixtureFiles({ 'assets/\u20ac.png': 'png', 'popup.html': '<img src="assets/&#x80;.png"><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(buildPackage({ root, outDir: out }).warnings).toEqual([]);
    });

    test('modules must import JavaScript (or JSON/CSS with a matching type attribute)', () => {
        expect(buildError({ 'javascript/features/a.js': "import './payload.txt';\nexport const a = 1;\n", 'javascript/features/payload.txt': 'x' }))
            .toContain("javascript/features/a.js: module \"./payload.txt\" resolves to javascript/features/payload.txt, which Chrome's module loader rejects (not JavaScript)");
        writeFixture(root, fixtureFiles({ 'javascript/features/a.js': "import data from './data.json' with { type: 'json' };\nexport const a = data;\n", 'javascript/features/data.json': '{}' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('an MV3 background needs a service worker', () => {
        expect(validateManifest({ ...MANIFEST, background: { type: 'module' } })).toContain('background.service_worker is required in MV3');
    });

    test('<meta http-equiv=refresh> targets are checked', () => {
        expect(buildError({ 'popup.html': '<meta http-equiv="refresh" content="0; url=missing.html"><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain('popup.html references missing.html');
    });

    test('only ASCII whitespace is trimmed around URLs (U+00A0 is part of the URL)', () => {
        expect(buildError({ 'popup.html': '<img src="&nbsp;assets/icons/icon128.png"><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain('popup.html references \u00a0assets/icons/icon128.png');
    });

    test('a scalar or non-string icon value is rejected instead of dropped', () => {
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, action: { default_popup: 'popup.html', default_icon: 5 } }) }))
            .toContain('manifest "action" has an unexpected shape');
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, icons: { 128: true } }) }))
            .toContain('manifest "icons" has an unexpected shape');
    });

    describe('extension-page CSP', () => {
        const CSP = "script-src 'self'; object-src 'none'; style-src 'self' https://ok.example https://fonts.example.com; " +
            "img-src 'self' data: https://*.cdn.example; font-src 'self' https://fonts.example/kit/";
        const withCsp = (csp = CSP) => JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: csp } });
        const page = (body) => `${body}<script type="module" src="javascript/entry-points/popup.js"></script>`;

        test('cspAllows follows CSP source matching', () => {
            const csp = parseCsp(CSP);
            expect(cspAllows(csp, 'img-src', 'https://a.cdn.example/x.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'https://cdn.example/x.png')).toBe(false); // *.host excludes the apex
            expect(cspAllows(csp, 'img-src', 'data:image/png;base64,AAAA')).toBe(true);
            expect(cspAllows(csp, 'script-src', 'https://evil.example/x.js')).toBe(false);
            expect(cspAllows(csp, 'font-src', 'https://fonts.example/kit/a.woff2')).toBe(true);
            expect(cspAllows(csp, 'font-src', 'https://fonts.example/other.woff2')).toBe(false);
            expect(cspAllows(parseCsp('img-src http:'), 'img-src', 'https://x.example/a.png')).toBe(true);
            expect(cspAllows(parseCsp("default-src 'self'"), 'media-src', 'https://x.example/a.mp4')).toBe(false);
            expect(cspAllows(parseCsp("script-src 'self'"), 'img-src', 'https://x.example/a.png')).toBe(true); // no img-src/default-src
        });

        test('external resources a page or stylesheet loads must be allowed', () => {
            const message = buildError({
                'manifest.json': withCsp(),
                'popup.html': page('<script src="https://evil.example/x.js"></script><link rel="stylesheet" href="https://bad.example/a.css">' +
                    '<link rel="stylesheet" href="https://ok.example/a.css"><img src="https://a.cdn.example/i.png"><img src="https://cdn.example/j.png">'),
                'stylesheets/base.css': '@font-face { src: url(https://evil.example/f.woff2) } .x { background: url(data:image/png;base64,AA) }\n'
            });
            expect(message).toContain('popup.html loads https://evil.example/x.js, which the manifest CSP blocks (script-src)');
            expect(message).toContain('popup.html loads https://bad.example/a.css, which the manifest CSP blocks (style-src)');
            expect(message).toContain('popup.html loads https://cdn.example/j.png, which the manifest CSP blocks (img-src)');
            expect(message).toContain('stylesheets/base.css loads https://evil.example/f.woff2, which the manifest CSP blocks (font-src)');
            expect(message).not.toContain('ok.example');
            expect(message).not.toContain('a.cdn.example');
            expect(message).not.toContain('data:image');
        });

        test('JS imports from a URL are checked against script-src', () => {
            expect(buildError({ 'manifest.json': withCsp(), 'javascript/features/a.js': "import x from 'https://cdn.example/x.js';\nexport const a = x;\n" }))
                .toContain('javascript/features/a.js loads https://cdn.example/x.js, which the manifest CSP blocks (script-src)');
        });

        test('inline scripts and on* handlers always fail; JSON data blocks do not', () => {
            const message = buildError({
                'manifest.json': withCsp(),
                'popup.html': page('<script>alert(1)</script><button onclick="go()">x</button>')
            });
            expect(message).toContain('popup.html line 1: inline <script>');
            expect(message).toContain('popup.html line 1: inline event handler onclick= on <button>');
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(), 'popup.html': page('<script type="application/json">{"a":1}</script>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test("inline styles need 'unsafe-inline' in style-src", () => {
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<div style="color: red"></div>') }))
                .toContain("popup.html uses inline styles (style= or <style>), which the manifest CSP blocks: style-src has no 'unsafe-inline'");
            writeFixture(root, fixtureFiles({
                'manifest.json': withCsp(CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")),
                'popup.html': page('<div style="color: red"></div><style>.a { color: blue }</style>')
            }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('the extension_pages policy itself may not relax MV3 script/object/worker sources', () => {
            expect(validateManifest({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self' https://cdn.example; object-src 'self'" } }))
                .toEqual(["content_security_policy.extension_pages script-src allows https://cdn.example; MV3 only permits 'self', 'none', 'wasm-unsafe-eval' and localhost there"]);
            expect(validateManifest({ ...MANIFEST, content_security_policy: { extension_pages: "default-src 'self' 'unsafe-eval'" } }))
                .toHaveLength(3); // script-src, object-src and worker-src all fall back to default-src
            expect(validateManifest({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval' http://localhost:8080; object-src 'none'" } }))
                .toEqual([]);
        });

        test("a lone '*' source matches HTTP(S), WS(S) and the extension's own URLs, not data: or blob:", () => {
            const csp = parseCsp('img-src *; connect-src *');
            expect(cspAllows(csp, 'img-src', 'https://x.example/a.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'http://x.example:8080/a.png')).toBe(true);
            expect(cspAllows(csp, 'connect-src', 'wss://x.example/socket')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'data:image/png;base64,AAAA')).toBe(false);
            expect(cspAllows(csp, 'img-src', 'blob:https://x.example/0')).toBe(false);
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(CSP.replace("img-src 'self' data: https://*.cdn.example", 'img-src * data:')),
                'popup.html': page('<img src="https://x.example/a.png"><img src="assets/icons/icon128.png">') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('a source without a port only matches the default port', () => {
            const csp = parseCsp('img-src https://cdn.jsdelivr.net https://alt.example:8443');
            expect(cspAllows(csp, 'img-src', 'https://cdn.jsdelivr.net/x.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'https://cdn.jsdelivr.net:443/x.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'https://cdn.jsdelivr.net:8443/x.png')).toBe(false);
            expect(cspAllows(csp, 'img-src', 'https://alt.example:8443/x.png')).toBe(true);
        });

        test('sandbox pages are checked against the sandbox CSP', () => {
            const sandboxed = { ...MANIFEST, sandbox: { pages: ['assets/sandbox.html'] }, content_security_policy: { extension_pages: CSP } };
            writeFixture(root, fixtureFiles({
                'manifest.json': JSON.stringify(sandboxed),
                'assets/sandbox.html': '<script>eval("1")</script><div onclick="x()"></div>'
            }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow(); // Chrome's default sandbox CSP allows inline script
            expect(buildError({
                'manifest.json': JSON.stringify({ ...sandboxed, content_security_policy: { extension_pages: CSP, sandbox: "sandbox; script-src 'self'" } }),
                'assets/sandbox.html': '<script>eval("1")</script>'
            })).toContain('assets/sandbox.html line 1: inline <script>: the sandbox CSP blocks inline script');
            expect(buildError({
                'manifest.json': withCsp(),
                'assets/sandbox.html': '<script>eval("1")</script>'
            })).toContain('assets/sandbox.html line 1: inline <script>: the manifest CSP blocks inline script');
        });

        test('<base href> moves later relative URLs, unless base-uri blocks it', () => {
            expect(buildError({
                'manifest.json': withCsp(`${CSP}; base-uri 'self'`),
                'popup.html': '<base href="stylesheets/"><link rel="stylesheet" href="stylesheets/base.css">' +
                    '<script type="module" src="../javascript/entry-points/popup.js"></script>'
            })).toContain('popup.html references stylesheets/stylesheets/base.css');
            writeFixture(root, fixtureFiles({
                'manifest.json': withCsp(`${CSP}; base-uri 'self'`),
                'popup.html': '<link rel="stylesheet" href="stylesheets/base.css"><base href="stylesheets/">' +
                    '<script type="module" src="../javascript/entry-points/popup.js"></script>'
            }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow(); // refs before <base> use the page URL
            expect(buildError({
                'manifest.json': withCsp(`${CSP}; base-uri 'none'`),
                'popup.html': page('<base href="stylesheets/">')
            })).toContain('popup.html line 1: <base href="stylesheets/"> is blocked by the manifest CSP (base-uri)');
        });

        test('iframe srcdoc content is checked as a nested document', () => {
            const message = buildError({
                'manifest.json': withCsp(),
                'popup.html': page('<iframe srcdoc="<img src=\'assets/missing.png\'><script>x()</script><img src=&quot;https://evil.example/i.png&quot;>"></iframe>')
            });
            expect(message).toContain('popup.html references assets/missing.png');
            expect(message).toContain('popup.html line 1 srcdoc line 1: inline <script>');
            expect(message).toContain('popup.html loads https://evil.example/i.png, which the manifest CSP blocks (img-src)');
        });

        test('module specifiers with schemes Chrome cannot import fail', () => {
            expect(buildError({ 'javascript/features/a.js': "import fs from 'node:fs';\nexport const a = fs;\n" }))
                .toContain('javascript/features/a.js: module specifier "node:fs" uses a scheme Chrome can\'t import');
            expect(buildError({ 'popup.html': page('<img src="chrome://favicon/x">') }))
                .toContain("popup.html: chrome://favicon/x uses a URL scheme an extension page can't load (img-src)");
        });

        test("packaged files are checked against their directive too ('self' must be allowed)", () => {
            expect(buildError({
                'manifest.json': withCsp(CSP.replace("img-src 'self' data:", 'img-src data:')),
                'popup.html': page('<img src="assets/icons/icon128.png">')
            })).toContain("popup.html loads assets/icons/icon128.png, which the manifest CSP blocks (img-src doesn't allow 'self')");
        });

        test("a sandbox page's stylesheet is checked under the sandbox CSP", () => {
            const sandboxed = {
                ...MANIFEST,
                sandbox: { pages: ['assets/sandbox.html'] },
                content_security_policy: { extension_pages: CSP, sandbox: "sandbox allow-scripts; img-src 'self'; style-src 'self'" }
            };
            const message = buildError({
                'manifest.json': JSON.stringify(sandboxed),
                'assets/sandbox.html': '<link rel="stylesheet" href="sandbox.css">',
                'assets/sandbox.css': '.x { background: url(https://a.cdn.example/i.png) }\n'
            });
            expect(message).toContain('assets/sandbox.css loads https://a.cdn.example/i.png, which the sandbox CSP blocks (img-src)');
            expect(message).not.toContain('manifest CSP blocks (img-src)'); // allowed under extension_pages
        });

        test('CSP members must be policy strings and paths keep their case', () => {
            for (const extension_pages of [5, ['x'], null, {}]) {
                expect(validateManifest({ ...MANIFEST, content_security_policy: { extension_pages } }))
                    .toContain('content_security_policy.extension_pages must be a policy string');
            }
            expect(validateManifest({ ...MANIFEST, content_security_policy: { pages: "script-src 'self'" } }))
                .toContain('content_security_policy.pages is not an MV3 member (use extension_pages or sandbox)');
            const csp = parseCsp('img-src https://CDN.example/Images/');
            expect(cspAllows(csp, 'img-src', 'https://cdn.example/Images/icon.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'https://cdn.example/images/icon.png')).toBe(false);
        });

        test("chrome-extension:// sources must match the file's own URL", () => {
            const id = extensionIdFromKey(MANIFEST.key);
            const csp = (img) => withCsp(CSP.replace("img-src 'self' data:", `img-src ${img} data:`));
            expect(buildError({ 'manifest.json': csp(`chrome-extension://${id}/allowed/`), 'popup.html': page('<img src="assets/icons/icon128.png">') }))
                .toContain("popup.html loads assets/icons/icon128.png, which the manifest CSP blocks (img-src doesn't allow 'self')");
            writeFixture(root, fixtureFiles({ 'manifest.json': csp(`chrome-extension://${id}/assets/`), 'popup.html': page('<img src="assets/icons/icon128.png">') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('custom sandbox policies keep the sandbox directive, without allow-same-origin', () => {
            expect(validateManifest({ ...MANIFEST, content_security_policy: { sandbox: "script-src 'self' 'unsafe-inline'" } }))
                .toContain('content_security_policy.sandbox must include the sandbox directive');
            expect(validateManifest({ ...MANIFEST, content_security_policy: { sandbox: 'sandbox allow-scripts allow-same-origin' } }))
                .toContain('content_security_policy.sandbox may not use allow-same-origin');
            expect(validateManifest({ ...MANIFEST, content_security_policy: { sandbox: "sandbox allow-scripts; script-src 'self'" } })).toEqual([]);
        });

        test('imports inside inline scripts are checked (e.g. in sandbox pages, where inline script runs)', () => {
            expect(buildError({
                'manifest.json': JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/sandbox.html'] } }),
                'assets/sandbox.html': "<script type=\"module\">import './missing.js'; import('./lazy-missing.js');</script>"
            })).toEqual(expect.stringContaining('assets/sandbox.html references assets/missing.js'));
            expect(buildError({
                'manifest.json': JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/sandbox.html'] } }),
                'assets/sandbox.html': "<script type=\"module\">import('./lazy-missing.js');</script>"
            })).toContain('assets/sandbox.html references assets/lazy-missing.js');
        });

        test('inline scripts allowed by a matching nonce or hash pass (sandbox CSP)', () => {
            const body = 'console.log(1)';
            const hash = createHash('sha256').update(body).digest('base64');
            const sandboxed = (policy) => JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] }, content_security_policy: { sandbox: policy } });
            writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed("sandbox allow-scripts; script-src 'nonce-AbC123'"), 'assets/s.html': `<script nonce="AbC123">${body}</script>` }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed(`sandbox allow-scripts; script-src 'sha256-${hash}'`), 'assets/s.html': `<script>${body}</script>` }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            expect(buildError({ 'manifest.json': sandboxed("sandbox allow-scripts; script-src 'nonce-AbC123'"), 'assets/s.html': '<script nonce="abc123">x()</script>' }))
                .toContain('assets/s.html line 1: inline <script>: the sandbox CSP blocks inline script');
        });

        test("Chrome's minimum script-src applies when a custom policy omits it", () => {
            expect(buildError({ 'manifest.json': withCsp("style-src 'self' https://fonts.example.com"), 'popup.html': page('<script>x()</script>') }))
                .toContain('popup.html line 1: inline <script>: the manifest CSP blocks inline script');
        });

        test('a source without a scheme only matches the extension scheme', () => {
            const csp = parseCsp('img-src cdn.example');
            expect(cspAllows(csp, 'img-src', 'https://cdn.example/x.png')).toBe(false);
            expect(cspAllows(csp, 'img-src', 'chrome-extension://cdn.example/x.png')).toBe(true);
        });

        test('preload links are checked under the directive of their destination', () => {
            const message = buildError({
                'manifest.json': withCsp(),
                'popup.html': page('<link rel="preload" as="image" href="https://evil.example/x.png"><link rel="preload" as="font" href="https://evil.example/f.woff2">' +
                    '<link rel="preload" as="image" href="assets/missing.png">')
            });
            expect(message).toContain('popup.html loads https://evil.example/x.png, which the manifest CSP blocks (img-src)');
            expect(message).toContain('popup.html loads https://evil.example/f.woff2, which the manifest CSP blocks (font-src)');
            expect(message).toContain('popup.html references assets/missing.png');
        });

        test('form targets: local ones must exist; external ones obey form-action (no default-src fallback)', () => {
            const message = buildError({
                'manifest.json': withCsp(`${CSP}; form-action 'self'`),
                'popup.html': page('<form action="missing.html"></form><form action="https://evil.example/post"><button formaction="gone.html">x</button></form>')
            });
            expect(message).toContain('popup.html references missing.html');
            expect(message).toContain('popup.html references gone.html');
            expect(message).toContain('popup.html loads https://evil.example/post, which the manifest CSP blocks (form-action)');
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp("default-src 'self'; script-src 'self'; object-src 'none'; img-src 'self' data:; style-src 'self' https://fonts.example.com"), 'popup.html': page('<form action="https://ok.example/post"></form>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow(); // default-src doesn't govern form-action
        });

        test("other extensions' URLs are checked against the CSP", () => {
            expect(buildError({ 'manifest.json': withCsp(CSP.replace("img-src 'self' data:", "img-src 'self'")), 'popup.html': page('<img src="chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.png">') }))
                .toContain('popup.html loads chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.png, which the manifest CSP blocks (img-src)');
        });

        test('inline styles allowed by a nonce or hash pass; style attributes need unsafe-hashes', () => {
            const css = '.a { color: red }';
            const attrCss = 'color: red';
            const hash = (text) => createHash('sha256').update(text).digest('base64');
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(CSP.replace("style-src 'self'", "style-src 'self' 'nonce-Ab9'")), 'popup.html': page(`<style nonce="Ab9">${css}</style>`) }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(CSP.replace("style-src 'self'", `style-src 'self' 'unsafe-hashes' 'sha256-${hash(attrCss)}'`)), 'popup.html': page(`<div style="${attrCss}"></div>`) }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            expect(buildError({ 'manifest.json': withCsp(CSP.replace("style-src 'self'", `style-src 'self' 'sha256-${hash(attrCss)}'`)), 'popup.html': page(`<div style="${attrCss}"></div>`) }))
                .toContain('popup.html uses inline styles');
        });

        test('element-specific directives (script-src-elem) take precedence', () => {
            expect(buildError({
                'manifest.json': JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] }, content_security_policy: { sandbox: "sandbox allow-scripts; script-src 'self'; script-src-elem 'none'" } }),
                'assets/s.html': '<script src="s.js"></script>',
                'assets/s.js': 'console.log(1);\n'
            })).toContain("assets/s.html loads assets/s.js, which the sandbox CSP blocks (script-src doesn't allow 'self')");
        });

        test('content_security_policy must be the MV3 object form', () => {
            expect(validateManifest({ ...MANIFEST, content_security_policy: "script-src 'self'" }))
                .toContain('content_security_policy must be an object');
        });
    });

    test('createZip adds parent directories once and keeps names sorted', () => {
        const zip = createZip([
            { name: 'b/c/d.txt', data: Buffer.from('d') },
            { name: 'a.txt', data: Buffer.from('a') },
            { name: 'b/e.txt', data: Buffer.alloc(0) }
        ]);
        expect([...readZip(zip).keys()]).toEqual(['a.txt', 'b/', 'b/c/', 'b/c/d.txt', 'b/e.txt']);
    });

    test('the real extension packages cleanly with every reference resolved', () => {
        const result = buildPackage({ root: REPO_ROOT, outDir: out });
        const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf8'));

        expect(result.version).toBe(manifest.version);
        expect(result.warnings).toEqual([]);
        const entries = readZip(readFileSync(result.zipPath));
        expect(entries.get('manifest.json').equals(readFileSync(join(REPO_ROOT, 'manifest.json')))).toBe(true);
        for (const required of [
            manifest.background.service_worker,
            manifest.chrome_url_overrides.newtab,
            manifest.action.default_popup,
            ...Object.values(manifest.icons)
        ]) {
            expect(entries.has(required)).toBe(true);
        }
        const names = [...entries.keys()];
        expect(names.some((name) => /(^tests\/|\.d\.ts$|\.test\.js$|^node_modules\/|^\.)/.test(name))).toBe(false);
    });

    const hasUnzip = (() => {
        try {
            execFileSync('unzip', ['-v'], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    })();

    (hasUnzip ? test : test.skip)('Info-ZIP unzip accepts the archive', () => {
        writeFixture(root, fixtureFiles());
        const result = buildPackage({ root, outDir: out });
        const output = execFileSync('unzip', ['-t', result.zipPath], { encoding: 'utf8' });
        expect(output).toContain('No errors detected');
    });
});
