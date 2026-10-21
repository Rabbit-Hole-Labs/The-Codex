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
    cssScan,
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
        expect(scanHtml('<a title=">" href=x.html>').filter((t) => t.name === 'a').map((t) => t.attrs.get('href'))).toEqual(['x.html']);
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

    test('HTML character references: &sol; decodes; unknown names stay literal, as in browsers', () => {
        writeFixture(root, fixtureFiles({
            'popup.html': '<img src="assets&sol;icons&sol;icon128.png"><script type="module" src="javascript/entry-points/popup.js"></script>'
        }));
        expect(buildPackage({ root, outDir: out }).warnings).toEqual([]);
        expect(buildError({
            'popup.html': '<img src="assets&frobnicate;x.png"><script type="module" src="javascript/entry-points/popup.js"></script>'
        })).toContain('popup.html references assets&frobnicate;x.png');
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

    test('options_ui needs a page unless options_page provides one; MV3 forbids chrome_style', () => {
        const message = 'options_ui has no page, so Chrome ignores it and the extension has no options page';
        expect(validateManifest({ ...MANIFEST, options_ui: { open_in_tab: true } })).toContain(message);
        expect(validateManifest({ ...MANIFEST, options_ui: { page: '  ' } })).toContain(message);
        expect(validateManifest({ ...MANIFEST, options_ui: { page: 'o.html', open_in_tab: 'yes' } }))
            .toContain('options_ui has a non-boolean open_in_tab, so Chrome ignores it and the extension has no options page');
        expect(validateManifest({ ...MANIFEST, options_page: 'o.html', options_ui: { open_in_tab: true } })).toEqual([]);
        for (const chromeStyle of [true, false]) {
            expect(validateManifest({ ...MANIFEST, options_ui: { page: 'o.html', chrome_style: chromeStyle } }))
                .toContain("options_ui.chrome_style can't be used with manifest_version 3 (Chrome refuses it even when false)");
        }
        // A malformed options_ui is dropped before chrome_style matters when options_page takes over.
        expect(validateManifest({ ...MANIFEST, options_page: 'o.html', options_ui: { chrome_style: true } })).toEqual([]);
    });

    test('manifest CSP strings may only hold tab, form feed and printable ASCII other than a comma', () => {
        for (const policy of ["script-src 'self';\nobject-src 'self'", "script-src 'self', object-src 'self'", "script-src 'self' https://café.example", "script-src 'self'\u0000"]) {
            expect(validateManifest({ ...MANIFEST, content_security_policy: { extension_pages: policy } }))
                .toContain('content_security_policy.extension_pages contains a character Chrome rejects (only tab, form feed and printable ASCII other than "," are allowed)');
        }
        expect(validateManifest({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self';\tobject-src 'self'" } })).toEqual([]);
    });

    test('content script matches must be match patterns', () => {
        const entry = (matches) => ({ ...MANIFEST, content_scripts: [{ matches, js: ['javascript/content.js'] }] });
        expect(validateManifest(entry(['not a pattern']))).toContain('content_scripts[0].matches[0] "not a pattern" isn\'t a match pattern (<scheme>://<host><path> or <all_urls>)');
        // '*' has no default port, so a numeric port needs a concrete scheme; urn: isn't a content-script scheme.
        for (const bad of ['https://example.com', 'https://foo.*.com/*', 'chrome://settings/*', 'http:///*', '*://localhost:3000/*', 'http://h:70000/*', 'urn:*']) {
            expect(validateManifest(entry([bad]))).toHaveLength(1);
        }
        expect(validateManifest(entry(['<all_urls>', '*://*/*', 'https://*.example.com/*', 'file:///*', 'http://localhost:8080/*', '*://h:*/*',
            'http://[::1]/*', 'uuid-in-package:*']))).toEqual([]);
        expect(validateManifest({ ...MANIFEST, content_scripts: [{ matches: ['<all_urls>'], exclude_matches: ['bad'], js: ['javascript/content.js'] }] }))
            .toContain('content_scripts[0].exclude_matches[0] "bad" isn\'t a match pattern (<scheme>://<host><path> or <all_urls>)');
    });

    test('a relative url() in a CSS custom property is checked where var() reads the property', () => {
        // Chrome resolves it against the stylesheet (or page) that substitutes it.
        expect(buildError({ 'stylesheets/base.css': '.x { --bg: url(icon.png); }\n.y { background: var(--bg); }\n' }))
            .toContain('stylesheets/base.css: url(icon.png) in --bg resolves to stylesheets/icon.png, which is not in the package');
        expect(buildError({ 'stylesheets/base.css': ':root { --bg: url(../assets/icons/icon128.png); }\n', 'stylesheets/sub/b.css': '.y { background: var(--bg); }\n',
            'popup.html': '<link rel="stylesheet" href="stylesheets/base.css"><link rel="stylesheet" href="stylesheets/sub/b.css"><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain('stylesheets/sub/b.css uses --bg from stylesheets/base.css: url(../assets/icons/icon128.png) resolves to stylesheets/assets/icons/icon128.png');
        // Same directory, root-relative, data: and @property "<url>" (resolved where declared) are fine; unread ones load nothing.
        writeFixture(root, fixtureFiles({ 'stylesheets/base.css': ':root { --a: url(../assets/icons/icon128.png); --b: url(/assets/icons/icon128.png); --c: url(data:image/png;base64,AA); --unused: url(gone.png); }\n' +
            '@property --d { syntax: "<url>"; inherits: true; initial-value: url(../assets/icons/icon128.png); }\n:root { --d: url(../assets/icons/icon128.png); }\n' +
            '.x { background: var(--a), var(--b), var(--c); }\n', 'stylesheets/sub/b.css': '.y { background: var(--d); }\n',
        'popup.html': '<link rel="stylesheet" href="stylesheets/base.css"><link rel="stylesheet" href="stylesheets/sub/b.css"><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // A dashed class or id in a selector is not a declaration.
        expect(cssRefs('.--active:hover { background: url(a.png) } .b { --x: url(b.png); color: red } .c { background: url(c.png) }')).toEqual([
            { url: 'a.png', directive: 'img-src' }, { url: 'b.png', directive: 'img-src', custom: '--x' }, { url: 'c.png', directive: 'img-src' }]);
        expect(cssRefs('--x: url(a.png)', { declarations: true })).toEqual([{ url: 'a.png', directive: 'img-src', custom: '--x' }]);
    });

    test('legacy named references decode as browsers do: without a semicolon, not before = or an alphanumeric', () => {
        writeFixture(root, fixtureFiles({ 'assets/a&.png': 'png', 'assets/café.png': 'png', 'assets/x˜y.png': 'png',
            'popup.html': '<img src="assets/a&amp.png"><img src="assets/caf&eacute.png"><img src="assets/x&tilde;y.png"><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(buildPackage({ root, outDir: out }).warnings).toEqual([]);
        const message = buildError({ 'popup.html': '<img src="assets/b&amp=1.png"><img src="assets/c&copyx.png"><script type="module" src="javascript/entry-points/popup.js"></script>' });
        expect(message).toContain('popup.html references assets/b&amp=1.png');
        expect(message).toContain('popup.html references assets/c&copyx.png');
    });

    test('inline import maps are JSON: checked for shape, mapped files and integrity', () => {
        const sandboxed = JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] } });
        const map = (json) => `<script type="importmap">${json}</script>`;
        writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed, 'assets/x.js': 'export const x = 1;\n',
            'assets/s.html': `${map('{"imports": {"x": "./x.js", "lib/": "./lib/"}, "scopes": {"/assets/": {"y": "./x.js"}}}')}<script type="importmap"></script><script type="module">import "./x.js";</script>` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow(); // an empty map is skipped
        const label = 'assets/s.html (import map, line 1)';
        expect(buildError({ 'manifest.json': sandboxed, 'assets/s.html': map('{"imports": []}') })).toContain(`${label}: "imports" must be an object, so Chrome rejects the map`);
        expect(buildError({ 'manifest.json': sandboxed, 'assets/s.html': map(' ') })).toContain(`${label} is not valid JSON, so Chrome rejects it`);
        expect(buildError({ 'manifest.json': sandboxed, 'assets/s.html': map('{"imports": {"x": "./missing.js"}}') })).toContain('assets/s.html references assets/missing.js');
        expect(buildError({ 'manifest.json': sandboxed, 'assets/s.html': map('{"imports": {"./a.js": "lodash", "b/": "./b.js"}}') }))
            .toEqual(expect.stringContaining(`${label}: imports["./a.js"] is not a URL or a /, ./ or ../ path, so Chrome blocks imports of "./a.js"`));
        expect(buildError({ 'manifest.json': sandboxed, 'assets/s.html': map('{"imports": {"b/": "./b.js"}}') })).toContain('imports["b/"] must end in "/" like its key');
        expect(buildError({ 'manifest.json': sandboxed, 'assets/s.html': '<script type="importmap" src="m.json"></script>' }))
            .toContain('<script type="importmap" src> is ignored by Chrome (import maps must be inline)');
    });

    test('nothing script-related is checked where scripting is off or a script is nomodule', () => {
        const sandboxed = JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] }, content_security_policy: { sandbox: "sandbox; script-src 'self'" } });
        writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed, 'assets/legacy.js': 'with (Math) { var r = PI; }\nvar x = 010;\n',
            'assets/s.html': '<script>not javascript (</script><script type="module">import "./missing.js";</script><div onclick="x()"></div>' +
                '<script src="legacy.js"></script><script src="gone.js"></script><svg><script>x()</script></svg>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow(); // legacy.js still compiles as a classic script
        // An iframe sandbox without allow-scripts makes its srcdoc inert too.
        writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed, 'popup.html': '<iframe sandbox srcdoc="<script>not javascript (</script>"></iframe><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // Chrome runs modules, so it never fetches a nomodule classic script; a nomodule module still runs.
        writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed, 'popup.html': '<script nomodule src="missing.js"></script><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({ 'manifest.json': sandboxed, 'popup.html': '<script type="module" nomodule src="missing.js"></script><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain('popup.html references missing.js');
    });

    test('sandbox.pages patterns with * mark every matching page as sandboxed', () => {
        const manifest = (pages) => JSON.stringify({ ...MANIFEST, sandbox: { pages }, content_security_policy: { sandbox: "sandbox; script-src 'self'" } });
        writeFixture(root, fixtureFiles({ 'manifest.json': manifest(['assets/sb/*.html']), 'assets/sb/a.html': '<script>not javascript (</script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow(); // inert: scripting is off there
        expect(buildError({ 'manifest.json': manifest(['assets/none/*.html']), 'assets/sb/a.html': '<p>x</p>' }))
            .toContain('manifest.json sandbox page pattern "assets/none/*.html" matches no packaged file');
    });

    test('an SVG <script href> file compiles as a classic script', () => {
        writeFixture(root, fixtureFiles({ 'assets/legacy.js': 'with (Math) { var r = PI; }\n',
            'popup.html': '<svg><script href="assets/legacy.js"></script></svg><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('with an upgraded scheme only port 80 pairs with 443', () => {
        const csp = parseCsp('img-src http://h.example:8080');
        expect(cspAllows(csp, 'img-src', 'http://h.example:8080/a.png')).toBe(true);
        expect(cspAllows(csp, 'img-src', 'https://h.example:8080/a.png')).toBe(false);
        expect(cspAllows(parseCsp('img-src https://h.example:80'), 'img-src', 'https://h.example/a.png')).toBe(false);
    });

    test('script types and SVG module scripts, as Chrome reads them', () => {
        // language="" means JavaScript; an SVG <script type="module"> is a module (not compiled as classic).
        expect(buildError({ 'popup.html': '<script language="" src="missing.js"></script><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain('popup.html references missing.js');
        writeFixture(root, fixtureFiles({ 'assets/m.js': 'export const m = 1;\n',
            'popup.html': '<svg><script type="module" href="assets/m.js"></script></svg><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('import map integrity applies to modules the page loads', () => {
        const sandboxed = JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] } });
        const map = '<script type="importmap">{"integrity": {"./x.js": "sha256-wrong", "./unused.js": "sha256-wrong"}}</script>';
        expect(buildError({ 'manifest.json': sandboxed, 'assets/x.js': 'export const x = 1;\n', 'assets/unused.js': 'export const u = 1;\n',
            'assets/s.html': `${map}<script type="module">import './x.js';</script>` }))
            .toEqual(expect.stringMatching(/import map integrity "sha256-wrong" for assets\/x\.js doesn't match(?![\s\S]*unused\.js doesn't)/));
        expect(buildError({ 'manifest.json': sandboxed, 'assets/s.html': '<script type="importmap">{"imports": {"x": "./dir/"}}</script>' }))
            .toContain('imports["x"] maps a module to a directory, which Chrome can\'t load');
    });

    test('an upgraded scheme matches port 443 from a source port of 80 or 443', () => {
        expect(cspAllows(parseCsp('img-src http://h.example:443'), 'img-src', 'https://h.example/a.png')).toBe(true);
        expect(validateManifest({ ...MANIFEST, content_scripts: [{ matches: ['uuid-in-package://*/*'], js: ['javascript/content.js'] }] })).toHaveLength(1);
        expect(validateManifest({ ...MANIFEST, options_page: 'o.html', options_ui: { page: '', chrome_style: false } }))
            .toContain("options_ui.chrome_style can't be used with manifest_version 3 (Chrome refuses it even when false)");
    });

    test('import map integrity applies only to module fetches without their own integrity', () => {
        const sandboxed = JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] } });
        const files = (html) => ({ 'manifest.json': sandboxed, 'assets/x.js': 'export const x = 1;\n', 'assets/c.js': 'self.c = 1;\n', 'assets/s.html': html });
        const good = `sha256-${createHash('sha256').update('export const x = 1;\n').digest('base64')}`;
        for (const html of ['<script type="importmap">{"integrity": {"./c.js": "sha256-wrong"}}</script><script src="c.js"></script>',
            '<script type="importmap">{"integrity": {"./x.js": "sha256-wrong"}}</script><script type="module" src="x.js" integrity=""></script>',
            `<script type="importmap">{"integrity": {"./x.js": "${good}"}}</script><script type="importmap">{"integrity": {"./x.js": "sha256-wrong"}}</script><script type="module">import './x.js';</script>`,
            '<script type="importmap">{"imports": {"x": "./x.js"}, "integrity": {"./x.js": "sha256-wrong"}}</script>']) {
            writeFixture(root, fixtureFiles(files(html)));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        }
    });

    test('SVG scripts with a data-block type load nothing; uuid-in-package takes one slash; typed import()', () => {
        writeFixture(root, fixtureFiles({ 'javascript/tpl.js': 'export const t = 1;\n',
            'popup.html': '<svg><script type="text/plain" href="javascript/tpl.js"></script></svg><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(validateManifest({ ...MANIFEST, content_scripts: [{ matches: ['uuid-in-package:/x'], js: ['javascript/content.js'] }] })).toEqual([]);
        writeFixture(root, fixtureFiles({ 'assets/dyn.js': "const s = await import('../stylesheets/base.css', { with: { type: 'css' } });\nexport const a = s;\n",
            'popup.html': '<script type="module" src="assets/dyn.js"></script><script type="module" src="javascript/entry-points/popup.js"></script>' }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('deeply nested markup, srcdoc stylesheets and other push-gate cases', () => {
        // Chrome accepts thousands of nested elements; the scan must not overflow the stack.
        writeFixture(root, fixtureFiles({ 'popup.html': `${'<div>'.repeat(4000)}x${'</div>'.repeat(4000)}<script type="module" src="javascript/entry-points/popup.js"></script>` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // A srcdoc's linked stylesheet is its own document: reusing a token name there is fine...
        const srcdocPage = (sheet) => '<link rel="stylesheet" href="stylesheets/app.css"><div class="x"></div>' +
            `<iframe sandbox srcdoc="<link rel=stylesheet href=${sheet}><div class=c></div>"></iframe><script type="module" src="javascript/entry-points/popup.js"></script>`;
        writeFixture(root, fixtureFiles({ 'stylesheets/app.css': ':root { --icon: url(icons/a.svg); } .x { background-image: var(--icon); }\n', 'stylesheets/icons/a.svg': 'svg',
            'stylesheets/preview/preview.css': ':root { --icon: url(img/p.svg); } .c { background-image: var(--icon); }\n', 'stylesheets/preview/img/p.svg': 'svg',
            'popup.html': srcdocPage('stylesheets/preview/preview.css') }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // ...and its inline styles read the tokens of the sheets it links.
        expect(buildError({ 'stylesheets/app.css': '.x { color: red }\n', 'stylesheets/preview/tokens.css': ':root { --p: url(gone.svg); }\n',
            'popup.html': '<iframe srcdoc="<link rel=stylesheet href=stylesheets/preview/tokens.css><style>.c { background-image: var(--p) }</style>"></iframe><script type="module" src="javascript/entry-points/popup.js"></script>' }))
            .toContain('popup.html uses --p from stylesheets/preview/tokens.css: url(gone.svg) resolves to gone.svg, which is not in the package');
        // A module script with its own integrity attribute shadows the import map's entry for that URL.
        const sandboxed = JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] } });
        const x = 'export const x = 1;\n';
        const good = `sha256-${createHash('sha256').update(x).digest('base64')}`;
        writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed, 'assets/x.js': x,
            'assets/s.html': `<script type="importmap">{"integrity": {"./x.js": "sha256-wrong"}}</script><script type="module" src="x.js" integrity="${good}"></script><script type="module">import './x.js';</script>` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // Prettier's typed import() with trailing commas.
        writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed, 'assets/s.html': '<script type="module" src="dyn.js"></script>',
            'assets/dyn.js': "const s = await import('../stylesheets/base.css', {\n  with: { type: 'css' },\n});\nexport const a = s;\n" }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('round 12: srcset whitespace, <source> parents, DNR actions, CSS newlines, CSP escapes, overrides', () => {
        const entry = '<script type="module" src="javascript/entry-points/popup.js"></script>';
        // srcset splits on ASCII whitespace only: U+00A0 stays part of the URL.
        expect(srcsetUrls('assets/a\u00a0b.png 1x, c.png 2x')).toEqual(['assets/a\u00a0b.png', 'c.png']);
        // <source>: srcset under <picture>, src under <audio>/<video>, nothing elsewhere.
        writeFixture(root, fixtureFiles({ 'popup.html': `<picture><source src="missing.mp4" srcset="assets/icons/icon128.png"><img src="assets/icons/icon128.png"></picture>${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        const sources = buildError({ 'popup.html': `<picture><source srcset="gone.png"></picture><video><source src="gone.mp4" srcset="fine.png"></video>${entry}` });
        expect(sources).toContain('popup.html references gone.png');
        expect(sources).toContain('popup.html references gone.mp4');
        expect(sources).not.toContain('fine.png');
        // DNR: each action needs its own fields.
        const dnr = (rules) => buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'assets/rules.json' }] } }),
            'assets/rules.json': JSON.stringify(rules) });
        const message = dnr([
            { id: 1, action: { type: 'redirect' }, condition: {} },
            { id: 2, action: { type: 'modifyHeaders', requestHeaders: [] }, condition: {} },
            { id: 3, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x', operation: 'remove', value: 'v' }, { header: 'y', operation: 'set' }] }, condition: {} },
            { id: 4, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['script'] } },
            { id: 5, action: { type: 'redirect', redirect: { regexSubstitution: '\\1' } }, condition: {} },
            { id: 6, action: { type: 'redirect', redirect: { url: 'javascript:alert(1)' } }, condition: {} },
            { id: 7, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'bad header', operation: 'remove' }] }, condition: {} },
            // Valid: url wins over a later field; transform alone; extensionPath; frames for allowAllRequests.
            { id: 8, action: { type: 'redirect', redirect: { url: 'https://example.com/', regexSubstitution: '' } }, condition: {} },
            { id: 9, action: { type: 'redirect', redirect: { transform: { scheme: 'https' } } }, condition: {} },
            { id: 10, action: { type: 'redirect', redirect: { extensionPath: '/index.html' } }, condition: {} },
            { id: 11, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame', 'sub_frame'] } },
            { id: 12, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' }] }, condition: {} }
        ]);
        expect(message).not.toMatch(/rule (7|8|9|10|11):/);
        expect(message).toContain('assets/rules.json rule 0: a redirect action needs action.redirect with url, extensionPath, transform or regexSubstitution');
        expect(message).toContain('assets/rules.json rule 1: action.requestHeaders must be a non-empty list');
        expect(message).toContain("assets/rules.json rule 2: action.responseHeaders[0] can't have a value with remove");
        expect(message).toContain('assets/rules.json rule 2: action.responseHeaders[1] needs a string value with set');
        expect(message).toContain('assets/rules.json rule 3: an allowAllRequests action needs condition.resourceTypes of main_frame and/or sub_frame only');
        expect(message).toContain('assets/rules.json rule 4: action.redirect.regexSubstitution needs condition.regexFilter');
        expect(message).toContain('assets/rules.json rule 5: action.redirect.url must be a valid URL other than javascript:');
        expect(message).toContain('assets/rules.json rule 6: action.requestHeaders[0] needs a valid header name and an operation of append, set or remove');
        // CSS: CR and FF end an unterminated string like LF, so later declarations are scanned.
        expect(cssRefs('.x{content:"oops\r; background:url(a.png)} .y{content:"b\f; background:url(b.png)}')).toEqual([
            { url: 'a.png', directive: 'img-src' }, { url: 'b.png', directive: 'img-src' }]);
        // A malformed escape in a URL compared with a CSP path source doesn't throw.
        expect(cspAllows(parseCsp('img-src https://cdn.example/'), 'img-src', 'https://cdn.example/%ZZ')).toBe(true);
        expect(cspAllows(parseCsp('img-src https://cdn.example/a/'), 'img-src', 'https://cdn.example/%ZZ')).toBe(false);
        // chrome_url_overrides needs a page.
        expect(validateManifest({ ...MANIFEST, chrome_url_overrides: { newtab: '' } })).toContain('chrome_url_overrides.newtab must be the path of the override page');
    });

    test('round 13: bare imports resolve through the page import map', () => {
        const sandboxed = JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] } });
        const page = (map, body) => `<script type="importmap">${JSON.stringify(map)}</script>${body}`;
        const files = { 'manifest.json': sandboxed, 'assets/x.js': 'export const x = 1;\n', 'assets/lib/a.js': 'export const a = 1;\n',
            'assets/m.js': "import { x } from 'x';\nimport { a } from 'lib/a.js';\nexport const m = x + a;\n" };
        // Exact keys and "/" prefixes, from inline modules and from module files the page loads.
        writeFixture(root, fixtureFiles({ ...files, 'assets/s.html': page({ imports: { x: './x.js', 'lib/': './lib/' } }, '<script type="module">import "x";</script><script type="module" src="m.js"></script>') }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // Scopes apply to modules under their prefix.
        writeFixture(root, fixtureFiles({ ...files, 'assets/s.html': page({ imports: { 'lib/': './lib/' }, scopes: { './': { x: './x.js' } } }, '<script type="module" src="m.js"></script>') }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        const message = buildError({ ...files, 'assets/s.html': page({ imports: { x: './gone.js', 'lib/': './lib/', y: './d.json' } },
            '<script type="module" src="m.js"></script><script type="module">import "z"; import "y";</script>'), 'assets/d.json': '{}' });
        expect(message).toContain('"x" maps to assets/gone.js in assets/s.html, which is not in the package');
        expect(message).toContain('bare module specifier "z" cannot be loaded by an unbundled extension (the import map of assets/s.html doesn\'t map it)');
        expect(message).toContain('"y" maps to assets/d.json in assets/s.html, which Chrome\'s module loader rejects (not JavaScript)');
        // A page without a map can't resolve them.
        expect(buildError({ ...files, 'assets/s.html': '<script type="module" src="m.js"></script>' }))
            .toContain('assets/m.js: bare module specifier "x" cannot be loaded by an unbundled extension (assets/s.html has no import map)');
    });

    test('round 13: CSS whitespace in url(), poster, event handlers, IPv6 sources, imagesrcset, prefetch', () => {
        const entry = '<script type="module" src="javascript/entry-points/popup.js"></script>';
        // CSS whitespace is ASCII: U+00A0 stays in an unquoted url().
        expect(cssRefs('.a { background: url(assets/a\u00a0b.png) }')).toEqual([{ url: 'assets/a\u00a0b.png', directive: 'img-src' }]);
        // poster loads only on <video>.
        writeFixture(root, fixtureFiles({ 'popup.html': `<audio poster="missing.png"></audio><track poster="missing.png">${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({ 'popup.html': `<video poster="missing.png"></video>${entry}` })).toContain('popup.html references missing.png');
        // Only real event-handler attributes are inline script.
        writeFixture(root, fixtureFiles({ 'popup.html': `<div only="x" once="y" onfoo="z"></div>${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({ 'popup.html': `<div onpointerdown="x()"></div>${entry}` })).toContain('inline event handler onpointerdown= on <div>');
        // Bracketed IPv6 hosts in CSP sources.
        expect(cspAllows(parseCsp('img-src https://[::1]'), 'img-src', 'https://[::1]/a.png')).toBe(true);
        expect(cspAllows(parseCsp('img-src https://[::1]:8443'), 'img-src', 'https://[::1]/a.png')).toBe(false);
        // An image preload's imagesrcset candidates are loads; a prefetch falls under default-src.
        const preload = buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; img-src 'self'; default-src 'self'" } }),
            'popup.html': `<link rel="preload" as="image" imagesrcset="gone.png 1x, https://evil.example/x.png 2x"><link rel="prefetch" href="https://blocked.example/page">${entry}` });
        expect(preload).toContain('popup.html references gone.png');
        expect(preload).toContain('popup.html loads https://evil.example/x.png, which the manifest CSP blocks (img-src)');
        expect(preload).toContain('popup.html loads https://blocked.example/page, which the manifest CSP blocks (default-src)');
    });

    test('round 14: an import map after a module script is not relied on', () => {
        // Chrome may resolve that script's imports before the map is seen (always, for an inline module).
        const sandboxed = JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] } });
        const late = buildError({ 'manifest.json': sandboxed, 'assets/x.js': 'export const x = 1;\n', 'assets/m.js': "import { x } from 'x';\nexport const m = x;\n",
            'assets/s.html': '<script type="module" src="m.js"></script><script type="importmap">{"imports": {"x": "./x.js"}}</script>' });
        expect(late).toContain('assets/s.html line 1: this import map comes after the module script on line 1, so Chrome may resolve that script\'s imports without it; put import maps first');
        expect(late).toContain('bare module specifier "x" cannot be loaded by an unbundled extension (assets/s.html has no import map)');
    });

    test('round 14: late import maps, window handlers, formaction, empty worker, fragment bases, url() syntax, javascript: links, SVG url attributes', () => {
        const entry = '<script type="module" src="javascript/entry-points/popup.js"></script>';
        // Window handlers on <body> are inline script too.
        expect(buildError({ 'popup.html': `<body onunhandledrejection="handle(event)">${entry}` })).toContain('inline event handler onunhandledrejection= on <body>');
        // formaction counts only on controls that submit.
        writeFixture(root, fixtureFiles({ 'popup.html': `<button type="button" formaction="missing.html"></button><input type="text" formaction="missing.html">${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({ 'popup.html': `<button formaction="gone.html"></button><input type="image" formaction="gone2.html">${entry}` }))
            .toEqual(expect.stringMatching(/references gone\.html[\s\S]*references gone2\.html|references gone2\.html[\s\S]*references gone\.html/));
        // background.service_worker must be a non-empty path.
        expect(validateManifest({ ...MANIFEST, background: { service_worker: '', type: 'module' } })).toContain('background.service_worker is required in MV3 (a non-empty path)');
        // A fragment- or query-only <base> keeps the document's directory.
        writeFixture(root, fixtureFiles({ 'assets/icons/page.html': '<base href="#frag"><img src="icon128.png">', 'popup.html': `<a href="assets/icons/page.html">p</a>${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // A quoted url() followed by anything but ')' is invalid: nothing loads.
        expect(cssRefs('.a { background: url("missing.png" garbage) } .b { background: url( "ok.png" ) }')).toEqual([{ url: 'ok.png', directive: 'img-src' }]);
        // Following a javascript: link runs inline script.
        expect(buildError({ 'popup.html': `<a href="javascript:run()">x</a><map><area href=" javascript:go()"></map>${entry}` }))
            .toEqual(expect.stringContaining('line 1: javascript: URL in <a href>: the manifest CSP blocks inline script'));
        // SVG presentation attributes load their url()s.
        const svg = buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; img-src 'self'" } }),
            'popup.html': `<svg><rect fill="url(assets/missing.svg#paint)" filter="url(https://evil.example/f.svg#f)" stroke="url(#local)"/></svg>${entry}` });
        expect(svg).toContain('popup.html references assets/missing.svg');
        expect(svg).toContain('popup.html loads https://evil.example/f.svg#f, which the manifest CSP blocks (img-src)');
        expect(svg).not.toContain('local');
    });

    test('round 15: per-document @property, host checks, DNR targets, MIME parameters, the MV3 minimum CSP', () => {
        const entry = '<script type="module" src="javascript/entry-points/popup.js"></script>';
        const sheets = (list) => `${list.map((sheet) => `<link rel="stylesheet" href="${sheet}">`).join('')}${entry}`;
        // Another page's @property registration doesn't apply here, and one inside a string registers nothing.
        for (const register of ['@property --bg { syntax: "<url>"; inherits: true; initial-value: url(data:,); }\n', '.n::after { content: "@property --bg { syntax: \'<url>\'; }"; }\n']) {
            expect(buildError({ 'stylesheets/reg.css': register, 'stylesheets/b.css': ':root { --bg: url(i.png); }\n', 'stylesheets/i.png': 'png',
                'stylesheets/sub/c.css': '.c { background: var(--bg); }\n',
                'manage.html': sheets(['stylesheets/reg.css']), 'popup.html': sheets(['stylesheets/reg.css', 'stylesheets/b.css', 'stylesheets/sub/c.css'].slice(register.startsWith('@') ? 1 : 0)) }))
                .toContain('stylesheets/sub/c.css uses --bg from stylesheets/b.css: url(i.png) resolves to stylesheets/sub/i.png, which is not in the package');
        }
        // Match-pattern hosts must be real hosts.
        expect(validateManifest({ ...MANIFEST, content_scripts: [{ matches: ['https://bad host/*'], js: ['javascript/content.js'] }] })).toHaveLength(1);
        // A DNR redirect to an extension path needs that file.
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'assets/rules.json' }] } }),
            'assets/rules.json': JSON.stringify([{ id: 1, action: { type: 'redirect', redirect: { extensionPath: '/missing.html' } }, condition: {} },
                { id: 2, action: { type: 'redirect', redirect: { extensionPath: '/index.html?x#y' } }, condition: {} }]) }))
            .toEqual(expect.stringMatching(/rule 0: action\.redirect\.extensionPath \/missing\.html is not in the package(?![\s\S]*rule 1:)/));
        // A script type with MIME parameters is a data block in Chrome (checked in Chromium 147): nothing loads.
        writeFixture(root, fixtureFiles({ 'popup.html': `<script type="text/javascript; charset=utf-8" src="missing.js"></script>${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // Chrome appends its minimum MV3 policy separately, so script-src-elem can't allow remote scripts.
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; script-src-elem 'self' https://evil.example; object-src 'self'" } }),
            'popup.html': `<script src="https://evil.example/x.js"></script>${entry}` }))
            .toContain("popup.html loads https://evil.example/x.js, which the MV3 minimum CSP (script-src 'self') blocks (script-src)");
    });

    test('round 16: inert scripts, @property syntax, --strip-key, CSP whitespace and hashes, srcdoc bases and policies', () => {
        const entry = '<script type="module" src="javascript/entry-points/popup.js"></script>';
        // A file only a never-run script names isn't compiled: module syntax in a nomodule file is fine.
        writeFixture(root, fixtureFiles({ 'assets/legacy.js': 'export {};\n', 'popup.html': `<script nomodule src="assets/legacy.js"></script>${entry}` }));
        const built = buildPackage({ root, outDir: out });
        expect(built.warnings.join('\n')).not.toContain('assets/legacy.js');
        // ...unless something that runs imports it.
        expect(buildError({ 'assets/legacy2.js': 'export { x };\n', 'assets/m.js': "import './legacy2.js';\n",
            'popup.html': `<script nomodule src="assets/legacy2.js"></script><script type="module" src="assets/m.js"></script>${entry}` }))
            .toContain('assets/legacy2.js');
        writeFixture(root, fixtureFiles({ 'assets/legacy2.js': 'export {};\n', 'assets/m.js': 'export {};\n' }));
        // "syntax" counts only as the @property descriptor.
        expect(cssScan('@property --bg { syntax: "*"; inherits: false; initial-value: syntax "<url>"; }').registeredUrls).toEqual(new Set());
        expect(cssScan('@property --bg { syntax: "<url>"; inherits: false; }').registeredUrls).toEqual(new Set(['--bg']));
        // --strip-key checks the manifest that ships: its own chrome-extension:// URLs can't be pinned.
        const id = extensionIdFromKey(MANIFEST.key);
        writeFixture(root, fixtureFiles({ 'popup.html': `<img src="chrome-extension://${id}/assets/icons/icon128.png">${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(() => buildPackage({ root, outDir: out, stripKey: true })).toThrow(`popup.html: chrome-extension://${id}/assets/icons/icon128.png can't be checked without a manifest key`);
        // CSP whitespace is ASCII: "img-src\u00a0'none'" is a malformed directive name, ignored.
        writeFixture(root, fixtureFiles({ 'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; img-src https://ok.example data:" } }),
            'popup.html': `<head><meta http-equiv="Content-Security-Policy" content="img-src\u00a0'none'"></head><img src="https://ok.example/x.png">${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        // Hash sources may be base64url (and unpadded).
        const css = '.a { color: red }';
        const url = createHash('sha256').update(css).digest('base64url');
        writeFixture(root, fixtureFiles({ 'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: `script-src 'self'; object-src 'self'; style-src 'self' https://fonts.example.com 'sha256-${url}'` } }),
            'popup.html': `<style>${css}</style>${entry}` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
    });

    test('round 16: a srcdoc resolves its <base> against the inherited one and keeps its own policies', () => {
        const entry = '<script type="module" src="javascript/entry-points/popup.js"></script>';
        writeFixture(root, fixtureFiles({ 'popup.html': `${entry}<base href="assets/"><iframe srcdoc="<base href=icons/><img src=icon128.png>"></iframe>` }));
        expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        expect(buildError({ 'manifest.json': JSON.stringify({ ...MANIFEST, content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; img-src 'self' https://a.cdn.example; style-src 'self'" } }),
            'stylesheets/s.css': '.a { background: url(https://a.cdn.example/x.png) }\n',
            'popup.html': `${entry}<iframe srcdoc="<head><meta http-equiv=Content-Security-Policy content=&quot;img-src 'none'&quot;></head><link rel=stylesheet href=stylesheets/s.css>"></iframe>` }))
            .toContain("stylesheets/s.css loads https://a.cdn.example/x.png, which the <meta> CSP in popup.html blocks (img-src)");
    });

    test('an MV3 background needs a service worker', () => {
        expect(validateManifest({ ...MANIFEST, background: { type: 'module' } })).toContain('background.service_worker is required in MV3 (a non-empty path)');
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
                'manifest.json': JSON.stringify({ ...sandboxed, content_security_policy: { extension_pages: CSP, sandbox: "sandbox allow-scripts; script-src 'self'" } }),
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
            // base-uri governs external bases; Chrome exempts the extension's own URLs from CSP.
            expect(buildError({ 'manifest.json': withCsp(`${CSP}; base-uri 'none'`), 'popup.html': page('<base href="stylesheets/">') }))
                .toContain('popup.html references stylesheets/javascript/entry-points/popup.js');
            expect(buildError({
                'manifest.json': withCsp(`${CSP}; base-uri 'none'`),
                'popup.html': '<script type="module" src="javascript/entry-points/popup.js"></script><base href="https://cdn.example/">'
            })).toContain('popup.html line 1: <base href="https://cdn.example/"> is blocked by the manifest CSP (base-uri)');
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

        test('own files are exempt from CSP, except scripts on extension pages', () => {
            // Chrome exempts chrome-extension: URLs from CSP checks other than script-src.
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(CSP.replace("img-src 'self' data:", 'img-src data:')), 'popup.html': page('<img src="assets/icons/icon128.png">') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            expect(buildError({ 'manifest.json': withCsp(CSP.replace("script-src 'self'", "script-src 'none'")), 'popup.html': page('') }))
                .toContain("popup.html loads javascript/entry-points/popup.js, which the manifest CSP blocks (script-src doesn't allow 'self')");
            // A sandbox page's own scripts run whatever its CSP says.
            writeFixture(root, fixtureFiles({ 'manifest.json': JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] }, content_security_policy: { sandbox: "sandbox allow-scripts; script-src 'none'" } }),
                'assets/s.html': '<script src="s.js"></script>', 'assets/s.js': 'console.log(1);\n' }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
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

        test("chrome-extension:// sources must match the script's own URL", () => {
            const id = extensionIdFromKey(MANIFEST.key);
            const meta = (source) => page(`<head><meta http-equiv="Content-Security-Policy" content="script-src ${source}"></head>`);
            expect(buildError({ 'popup.html': meta(`chrome-extension://${id}/allowed/`) }))
                .toContain("popup.html loads javascript/entry-points/popup.js, which the <meta> CSP in popup.html blocks (script-src doesn't allow 'self')");
            writeFixture(root, fixtureFiles({ 'popup.html': meta(`chrome-extension://${id}/javascript/`) }));
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

        test("other extensions' scripts are checked against the CSP (their images are exempt)", () => {
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<script src="chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.js"></script>') }))
                .toContain('popup.html loads chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.js, which the manifest CSP blocks (script-src)');
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(), 'popup.html': page('<img src="chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x.png">') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
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
            expect(buildError({ 'manifest.json': withCsp(`${CSP}; script-src-elem 'none'`), 'popup.html': page('') }))
                .toContain("popup.html loads javascript/entry-points/popup.js, which the manifest CSP blocks (script-src doesn't allow 'self')");
        });

        test('HTML start tags that break out of SVG/MathML are checked as HTML (parse5)', () => {
            const blocked = 'popup.html loads https://evil.example/x.png, which the manifest CSP blocks (img-src)';
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<svg><p><img src="https://evil.example/x.png"></svg>') })).toContain(blocked);
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<svg><font color="red"><input type="image" src="https://evil.example/x.png"></svg>') })).toContain(blocked);
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<svg></p><image src="https://evil.example/x.png"></svg>') })).toContain(blocked);
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<image src="https://evil.example/x.png">') })).toContain(blocked);
            // CDATA in SVG is text, so markup-like text inside it neither breaks out nor loads anything.
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<svg><style><![CDATA[ a>b {} /* <b> */ ]]></style><image href="https://evil.example/x.png"/></svg>') }))
                .toContain(blocked);
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(), 'popup.html': page('<svg><![CDATA[ a > b <img src="https://evil.example/x.png"> ]]></svg>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            // MathML text integration points (mtext) hold HTML; annotation-xml only with an HTML encoding.
            expect(buildError({ 'manifest.json': withCsp(`${CSP}; media-src 'self'`), 'popup.html': page('<math><mtext><video src="https://evil.example/v.mp4"></video></mtext></math>') }))
                .toContain('popup.html loads https://evil.example/v.mp4, which the manifest CSP blocks (media-src)');
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(`${CSP}; media-src 'self'`), 'popup.html': page('<math><annotation-xml><video src="https://evil.example/v.mp4"></video></annotation-xml></math>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('legacy background attributes are image loads, resolved against the document base', () => {
            const message = buildError({ 'manifest.json': withCsp(), 'popup.html': page('<table><colgroup background="https://evil.example/c.png"></colgroup><tr><td background="https://evil.example/bg.png"></td></tr></table>') });
            expect(message).toContain('popup.html loads https://evil.example/c.png, which the manifest CSP blocks (img-src)');
            expect(message).toContain('popup.html loads https://evil.example/bg.png, which the manifest CSP blocks (img-src)');
            expect(buildError({ 'popup.html': page('<body background="assets/missing.png">') })).toContain('popup.html references assets/missing.png');
            // A later <base> applies (styles compute after parsing), unless a parser-blocking script or a
            // stylesheet in between lets them apply first: then the result depends on timing.
            writeFixture(root, fixtureFiles({ 'popup.html': '<script type="module" src="javascript/entry-points/popup.js"></script><body background="icon128.png"><p>x</p><base href="assets/icons/">' }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            expect(buildError({ 'assets/slow.js': 'self.y = 1;\n',
                'popup.html': '<script type="module" src="javascript/entry-points/popup.js"></script><body background="icon128.png"><script src="assets/slow.js"></script><base href="assets/icons/">' }))
                .toContain('popup.html line 1: <body background> comes before <base href>, so Chrome may resolve it against either; move <base> into <head>');
        });

        test('hyperlink ping targets are checked against connect-src (HTTP(S) only, links with href only)', () => {
            const withConnect = withCsp(`${CSP}; connect-src 'self'`);
            expect(buildError({ 'manifest.json': withConnect, 'popup.html': page('<a href="https://ok.example/" ping="audit https://blocked.example/audit">x</a>') }))
                .toContain('popup.html loads https://blocked.example/audit, which the manifest CSP blocks (connect-src)');
            expect(buildError({ 'manifest.json': withConnect, 'popup.html': page('<svg><a href="https://ok.example/" ping="https://blocked.example/svg">x</a></svg>') }))
                .toContain('popup.html loads https://blocked.example/svg, which the manifest CSP blocks (connect-src)');
            // Relative pings are chrome-extension: URLs (never sent); a link without href pings nothing.
            writeFixture(root, fixtureFiles({ 'manifest.json': withConnect, 'popup.html': page('<a href="https://ok.example/" ping="audit/missing">x</a><a ping="https://blocked.example/x">y</a>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(`${CSP}; connect-src *`), 'popup.html': page('<a href="https://ok.example/" ping="https://any.example/audit">x</a>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('a <meta> CSP in <head> applies with the manifest CSP to what follows it', () => {
            const meta = (policy) => `<head><link rel="icon" href="https://a.cdn.example/i.png"><meta http-equiv="Content-Security-Policy" content="${policy}"></head>`;
            const message = buildError({ 'manifest.json': withCsp(), 'popup.html': page(`${meta("img-src 'none'")}<body><img src="https://a.cdn.example/x.png"><img src="assets/icons/icon128.png">`) });
            expect(message).toContain('loads https://a.cdn.example/x.png, which the <meta> CSP in popup.html blocks (img-src)');
            expect(message).not.toContain('i.png'); // the icon came before the <meta>
            expect(message).not.toContain('icon128'); // own files are exempt
            // Chrome ignores a <meta> outside <head>, and a padded http-equiv.
            for (const markup of ['<body><meta http-equiv="Content-Security-Policy" content="img-src \'none\'"><img src="https://a.cdn.example/x.png">',
                '<head><meta http-equiv=" Content-Security-Policy " content="img-src \'none\'"></head><img src="https://a.cdn.example/x.png">']) {
                writeFixture(root, fixtureFiles({ 'manifest.json': withCsp(), 'popup.html': page(markup) }));
                expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            }
            // It covers the page's stylesheets, and a byte order mark doesn't move it out of <head>.
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': `\uFEFF<!doctype html>${page(`${meta("img-src 'none'")}<link rel="stylesheet" href="stylesheets/base.css">`)}`,
                'stylesheets/base.css': '.a { background: url(https://a.cdn.example/bg.png) }\n' }))
                .toContain('stylesheets/base.css loads https://a.cdn.example/bg.png, which the <meta> CSP in popup.html blocks (img-src)');
            // Imports inherit the nonce of the script that loads them.
            writeFixture(root, fixtureFiles({ 'popup.html': '<head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-n1\'"></head><script type="module" nonce="n1" src="javascript/entry-points/popup.js"></script>' }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test("'strict-dynamic' ignores 'unsafe-inline' and 'self': markup scripts need a nonce, imports don't", () => {
            const sandboxed = (policy) => JSON.stringify({ ...MANIFEST, sandbox: { pages: ['assets/s.html'] }, content_security_policy: { sandbox: `sandbox allow-scripts; ${policy}` } });
            expect(buildError({ 'manifest.json': sandboxed("script-src 'unsafe-inline' 'strict-dynamic'"), 'assets/s.html': '<script>x()</script>' }))
                .toContain('assets/s.html line 1: inline <script>: the sandbox CSP blocks inline script');
            expect(buildError({ 'manifest.json': sandboxed("script-src https://cdn.example 'strict-dynamic'"), 'assets/s.html': '<script src="https://cdn.example/a.js"></script>' }))
                .toContain("assets/s.html loads https://cdn.example/a.js, which the sandbox CSP blocks (script-src has 'strict-dynamic', so a <script> in the markup needs a matching nonce)");
            writeFixture(root, fixtureFiles({ 'manifest.json': sandboxed("script-src 'nonce-Ab9' 'strict-dynamic'"), 'assets/s.html': '<script nonce="Ab9" src="https://cdn.example/a.js"></script>' }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            // On an extension page (a <meta> policy), own markup scripts need the nonce; their imports inherit it.
            const meta = (body) => `<head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n1' 'strict-dynamic'"></head>${body}`;
            const kept = sandboxed("script-src 'nonce-Ab9' 'strict-dynamic'"); // assets/s.html is still there
            writeFixture(root, fixtureFiles({ 'manifest.json': kept, 'popup.html': meta('<script type="module" nonce="n1" src="javascript/entry-points/popup.js"></script>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            expect(buildError({ 'manifest.json': kept, 'popup.html': meta('<script type="module" src="javascript/entry-points/popup.js"></script>') }))
                .toContain("popup.html loads javascript/entry-points/popup.js, which the <meta> CSP in popup.html blocks (script-src has 'strict-dynamic', so a <script> in the markup needs a matching nonce)");
        });

        test('an insecure source with port 80 also matches the upgraded scheme on 443', () => {
            const csp = parseCsp('img-src http://cdn.example:80; connect-src ws://socket.example:80');
            expect(cspAllows(csp, 'img-src', 'https://cdn.example/image.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'http://cdn.example/image.png')).toBe(true);
            expect(cspAllows(csp, 'img-src', 'https://cdn.example:8443/image.png')).toBe(false);
            expect(cspAllows(csp, 'connect-src', 'wss://socket.example/s')).toBe(true);
        });

        test('Subresource Integrity metadata must match the served file, as Chrome parses it', () => {
            const body = 'console.log(1);\n';
            const digest = (algorithm, encoding = 'base64') => createHash(algorithm).update(body).digest(encoding);
            const files = (integrity, tag = 'script') => ({ 'assets/i.js': body,
                'popup.html': page(tag === 'script' ? `<script src="assets/i.js" integrity="${integrity}"></script>` : tag.replace('$', integrity)) });
            expect(buildError(files('sha256-wrong'))).toContain('popup.html line 1: integrity="sha256-wrong" for assets/i.js doesn\'t match its sha256 digest, so Chrome refuses to load it');
            // The strongest algorithm decides; an upper-case name is an unknown algorithm (ignored).
            expect(buildError(files(`sha256-${digest('sha256')} sha384-${digest('sha256')}`))).toContain("doesn't match its sha384 digest");
            expect(buildError(files(`SHA512-${digest('sha512')} sha256-wrong`))).toContain("doesn't match its sha256 digest");
            expect(buildError(files(`ed25519-${digest('sha256')}`))).toContain('asks for an ed25519 signature');
            const base64url = digest('sha512', 'base64url');
            for (const ok of [`sha384-${digest('sha384')}`, `sha-256-${digest('sha256')}`, `sha256-x sha512-${base64url}?opt`,
                `sha256-${digest('sha256').replace(/=+$/, '')}===`, 'md5-unknown', 'SHA256-wrong']) {
                writeFixture(root, fixtureFiles(files(ok)));
                expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            }
            expect(buildError({ 'popup.html': page('<link rel="stylesheet" href="stylesheets/base.css" integrity="sha512-wrong">') }))
                .toContain('integrity="sha512-wrong" for stylesheets/base.css doesn\'t match its sha512 digest');
            // A used script preload's integrity is enforced, and an SVG script's.
            expect(buildError(files('sha256-wrong', '<link rel="preload" as="script" href="assets/i.js" integrity="$"><script src="assets/i.js"></script>')))
                .toContain("preload integrity=\"sha256-wrong\" for assets/i.js doesn't match its sha256 digest");
            expect(buildError(files('sha256-wrong', '<svg><script href="assets/i.js" integrity="$"></script></svg>'))).toContain("for assets/i.js doesn't match its sha256 digest");
            // Loads Chrome never checks or never makes: an image preload, nomodule classic scripts, modulepreload as=image.
            for (const tag of ['<link rel="preload" as="image" href="assets/i.js" integrity="$">', '<script nomodule src="assets/i.js" integrity="$"></script>',
                '<link rel="modulepreload" as="image" href="assets/i.js" integrity="$">']) {
                writeFixture(root, fixtureFiles(files('sha256-wrong', tag)));
                expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            }
        });

        test('stylesheet integrity is checked against the bytes Chrome serves (__MSG_@@extension_id__ filled in)', () => {
            const id = extensionIdFromKey(MANIFEST.key);
            const css = '.a::after { content: "__MSG_@@extension_id__"; }\n';
            const served = createHash('sha256').update(css.replace('__MSG_@@extension_id__', id)).digest('base64');
            writeFixture(root, fixtureFiles({ 'stylesheets/base.css': css, 'popup.html': page(`<link rel="stylesheet" href="stylesheets/base.css" integrity="sha256-${served}">`) }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            expect(buildError({ 'stylesheets/base.css': '.a::after { content: "__MSG_@@ui_locale__"; }\n', 'popup.html': page('<link rel="stylesheet" href="stylesheets/base.css" integrity="sha256-x">') }))
                .toContain("can't be pinned: Chrome fills in the file's locale-dependent __MSG_ placeholders");
        });

        test('<select> contents are checked: Chrome parses them like ordinary markup', () => {
            const message = buildError({ 'manifest.json': withCsp(), 'popup.html': page('<select><option><img src="https://evil.example/fr.png"> France</option>' +
                '<button><selectedcontent></selectedcontent></button><option><img src="assets/flags/de.svg"> Germany</option></select>') });
            expect(message).toContain('popup.html loads https://evil.example/fr.png, which the manifest CSP blocks (img-src)');
            expect(message).toContain('popup.html references assets/flags/de.svg');
        });

        test('elements take effect in source order: a foster-parented <base> applies only after its tag', () => {
            writeFixture(root, fixtureFiles({ 'popup.html': page('<table><tr><td><img src="assets/icons/icon128.png"></td></tr><base href="assets/sub/"></table>') }));
            expect(buildError({ 'popup.html': page('<table><tr><td><img src="assets/icons/icon128.png"></td></tr><base href="assets/sub/"></table>') }))
                .not.toContain('icon128');
            // The first <base> with an href wins even when empty; one inside <template> doesn't count.
            writeFixture(root, fixtureFiles({ 'popup.html': '<base href=""><base href="nowhere/"><template><base href="https://cdn.example/"></template><img src="assets/icons/icon128.png">' +
                '<script type="module" src="javascript/entry-points/popup.js"></script>' }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('type attributes are read as Chrome reads them', () => {
            const styleCsp = withCsp(CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"));
            const blocked = 'popup.html loads https://evil.example/x.png, which the manifest CSP blocks (img-src)';
            const bg = 'body{background:url(https://evil.example/x.png)}';
            // <style> applies only with no type, an empty one or exactly text/css (any case), in HTML and SVG.
            for (const markup of [`<style type="TEXT/CSS">${bg}</style>`, `<svg><style type="">${bg}</style></svg>`]) {
                expect(buildError({ 'manifest.json': styleCsp, 'popup.html': page(markup) })).toContain(blocked);
            }
            for (const markup of [`<style type="text/css ">${bg}</style>`, `<svg><style type="text/x-scss">${bg}</style></svg>`]) {
                writeFixture(root, fixtureFiles({ 'manifest.json': styleCsp, 'popup.html': page(markup) }));
                expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            }
            // A stylesheet <link> type drops whitespace and parameters.
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': page('<link rel="stylesheet" type=" text/css; charset=utf-8" href="https://evil.example/x.css">') }))
                .toContain('popup.html loads https://evil.example/x.css, which the manifest CSP blocks (style-src)');
            // A classic script type may have whitespace (vertical tab included) around it; module must be exact.
            expect(buildError({ 'popup.html': page('<script type="text/javascript\u000b" src="missing.js"></script>') })).toContain('popup.html references missing.js');
            writeFixture(root, fixtureFiles({ 'popup.html': page('<script type="module " src="missing.js"></script>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('modulepreload fetches scripts, styles and JSON under their own directives', () => {
            const message = buildError({ 'manifest.json': withCsp(`${CSP}; connect-src 'self'`), 'popup.html': page('<link rel="modulepreload" as="style" href="https://evil.example/m.css">' +
                '<link rel="modulepreload" as="json" href="https://evil.example/m.json">') });
            expect(message).toContain('popup.html loads https://evil.example/m.css, which the manifest CSP blocks (style-src)');
            expect(message).toContain('popup.html loads https://evil.example/m.json, which the manifest CSP blocks (connect-src)');
            expect(buildError({ 'manifest.json': withCsp(`${CSP}; connect-src 'self'`), 'javascript/features/a.js': "import data from 'https://evil.example/d.json' with { type: 'json' };\nexport const a = data;\n" }))
                .toContain('javascript/features/a.js loads https://evil.example/d.json, which the manifest CSP blocks (connect-src)');
        });

        test('pings, fragments and srcdoc follow the URL parser and HTML rules', () => {
            const withConnect = withCsp(`${CSP}; connect-src 'self'`);
            // The URL parser strips C0 controls; an unparsable ping and dangling-markup pings are skipped.
            expect(buildError({ 'manifest.json': withConnect, 'popup.html': page('<a href="https://ok.example/" ping="&#11;https://blocked.example/a">x</a>') }))
                .toContain('popup.html loads https://blocked.example/a, which the manifest CSP blocks (connect-src)');
            writeFixture(root, fixtureFiles({ 'manifest.json': withConnect, 'popup.html': page('<a href="https://ok.example/" ping="http://[bad">x</a><a href="https://ok.example/" ping="https://blocked.example/b\n<x">y</a>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            // A #fragment-only src under an external <base> is a real fetch.
            expect(buildError({ 'manifest.json': withCsp(), 'popup.html': '<script type="module" src="javascript/entry-points/popup.js"></script><base href="https://evil.example/"><img src="#x">' }))
                .toContain('popup.html loads https://evil.example/#x, which the manifest CSP blocks (img-src)');
            // An iframe with srcdoc never requests its src.
            writeFixture(root, fixtureFiles({ 'popup.html': page('<iframe src="missing.html" srcdoc="<p>hi</p>"></iframe>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('custom properties resolve at their final use in the same document, through chains', () => {
            const page = (sheets) => `${sheets.map((sheet) => `<link rel="stylesheet" href="${sheet}">`).join('')}<script type="module" src="javascript/entry-points/popup.js"></script>`;
            // --b: var(--a) passes --a's url() on to wherever --b is read (stylesheets/sub here).
            expect(buildError({ 'stylesheets/a.css': ':root { --a: url(i.png); --b: var(--a); }\n', 'stylesheets/sub/b.css': '.y { background: var(--b); }\n', 'stylesheets/i.png': 'png',
                'popup.html': page(['stylesheets/a.css', 'stylesheets/sub/b.css']) }))
                .toContain('stylesheets/sub/b.css uses --a from stylesheets/a.css: url(i.png) resolves to stylesheets/sub/i.png, which is not in the package');
            // Pages don't share custom properties: each page's own reader decides; '..' stops at the root.
            writeFixture(root, fixtureFiles({ 'stylesheets/deep/a.css': ':root { --i: url(../../../../assets/icons/icon128.png); }\n.x { background: var(--i); }\n',
                'stylesheets/b.css': ':root { --i: url(../assets/icons/icon128.png); }\n', 'popup.html': page(['stylesheets/deep/a.css']),
                'manage.html': page(['stylesheets/b.css']) }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            // Any @property syntax with <url> resolves where declared; var() inside a string or comment is no reader.
            writeFixture(root, fixtureFiles({ 'stylesheets/a.css': '@property --l { syntax: "<url>+"; inherits: true; initial-value: url(../assets/icons/icon128.png); }\n' +
                ':root { --l: url(../assets/icons/icon128.png); --m: url(gone.png); }\n.n::after { content: "var(--m)"; /* var(--m) */ }\n',
            'stylesheets/sub/b.css': '.y { background: var(--l); }\n', 'popup.html': page(['stylesheets/a.css', 'stylesheets/sub/b.css']) }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('preload integrity counts where the page uses the preloaded response', () => {
            const body = 'console.log(1);\n';
            const good = `sha256-${createHash('sha256').update(body).digest('base64')}`;
            const files = (markup) => ({ 'assets/i.js': body, 'popup.html': page(markup) });
            expect(buildError(files('<link rel="preload" as="script" href="assets/i.js" integrity="sha256-wrong"><script src="assets/i.js"></script>')))
                .toContain('popup.html line 1: preload integrity="sha256-wrong" for assets/i.js doesn\'t match its sha256 digest');
            // Unused, consumed with its own integrity, or with another CORS mode: Chrome refetches and runs it.
            for (const markup of ['<link rel="preload" as="script" href="assets/i.js" integrity="sha256-wrong">',
                `<link rel="preload" as="script" href="assets/i.js" integrity="sha256-wrong"><script src="assets/i.js" integrity="${good}"></script>`,
                '<link rel="preload" as="script" href="assets/i.js" integrity="sha256-wrong"><script type="module" src="assets/i.js"></script>']) {
                writeFixture(root, fixtureFiles(files(markup)));
                expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            }
            expect(buildError({ 'assets/f.woff2': 'font', 'stylesheets/base.css': '@font-face { font-family: f; src: url(../assets/f.woff2); }\n',
                'popup.html': page('<link rel="preload" as="font" crossorigin href="assets/f.woff2" integrity="sha256-wrong"><link rel="stylesheet" href="stylesheets/base.css">') }))
                .toContain('preload integrity="sha256-wrong" for assets/f.woff2 doesn\'t match');
        });

        test('nonces pass down only the module graph their script roots', () => {
            const meta = "<head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'nonce-n1' https://cdn.example\"></head>";
            // a.js (allowed by host) imports an own file: no nonce reaches it, so Chrome blocks it.
            expect(buildError({ 'popup.html': `${meta}<script nonce="n1" type="module" src="javascript/entry-points/popup.js"></script><script type="module">import './javascript/features/a.js';</script>` }))
                .toContain("popup.html loads javascript/features/a.js, which the <meta> CSP in popup.html blocks (script-src doesn't allow 'self')");
        });

        test('own scripts in an opaque sandboxed srcdoc are exempt from CSP', () => {
            writeFixture(root, fixtureFiles({ 'popup.html': page("<head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'self' 'unsafe-inline'\"></head>" +
                '<iframe sandbox="allow-scripts" srcdoc="<script src=assets/s.js></script>"></iframe>'), 'assets/s.js': 'console.log(1);\n' }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('preloads, nonces and opaque srcdocs follow Chrome more closely', () => {
            const body = 'console.log(1);\n';
            // A preload after the script that uses the file is never used.
            writeFixture(root, fixtureFiles({ 'assets/i.js': body, 'popup.html': page('<script src="assets/i.js"></script><link rel="preload" as="script" href="assets/i.js" integrity="sha256-wrong">') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            // A nonced preload is no nonce root: the un-nonced <script>'s imports get no nonce.
            const id = extensionIdFromKey(MANIFEST.key);
            const meta = `<head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n1' chrome-extension://${id}/assets/c.js"></head>`;
            expect(buildError({ 'assets/c.js': "import './d.js';\n", 'assets/d.js': 'export const d = 1;\n',
                'popup.html': `${meta}<link rel="preload" as="script" nonce="n1" href="assets/c.js"><script type="module" src="assets/c.js"></script>` }))
                .toContain("assets/c.js loads assets/d.js, which the <meta> CSP in popup.html blocks (script-src doesn't allow 'self')");
            // An opaque sandboxed srcdoc's own module graph is exempt too.
            writeFixture(root, fixtureFiles({ 'assets/m.js': "import './n.js';\n", 'assets/n.js': 'export const n = 1;\n',
                'popup.html': page("<head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'nonce-x'\"></head><iframe sandbox=\"allow-scripts\" srcdoc=\"<script type=module src=assets/m.js></script>\"></iframe>")
                    .replace('<script type="module" src', '<script type="module" nonce="x" src') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
        });

        test('an upgraded port 443 source matches https subresources, not frames', () => {
            const csp = parseCsp('img-src http://h.example:443; frame-src http://h.example:443');
            expect(cspAllows(csp, 'img-src', 'https://h.example/a.png')).toBe(true);
            expect(cspAllows(csp, 'frame-src', 'https://h.example/')).toBe(false);
            expect(cspAllows(parseCsp('frame-src http://h.example:80'), 'frame-src', 'https://h.example/')).toBe(true);
        });

        test('custom properties: chains into @property holders, srcdoc documents and unreached sheets', () => {
            // --p is registered as <url>, so a url() chained into it resolves where --p: var(--a) is written.
            writeFixture(root, fixtureFiles({ 'stylesheets/tokens/a.css': ':root { --a: url(i.svg); }\n', 'stylesheets/mid/i.svg': 'svg',
                'stylesheets/mid/b.css': "@property --p { syntax: '<url>'; inherits: true; initial-value: url(data:,); }\n:root { --p: var(--a); }\n",
                'stylesheets/use/c.css': '.c { background-image: var(--p); }\n',
                'popup.html': '<link rel="stylesheet" href="stylesheets/tokens/a.css"><link rel="stylesheet" href="stylesheets/mid/b.css"><link rel="stylesheet" href="stylesheets/use/c.css">' +
                    '<script type="module" src="javascript/entry-points/popup.js"></script>' }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            // A srcdoc is another document: it can't read the page's properties.
            writeFixture(root, fixtureFiles({ 'stylesheets/t.css': ':root { --a: url(icons/a.svg); }\n.x { background-image: var(--a); }\n', 'stylesheets/icons/a.svg': 'svg',
                'popup.html': page('<link rel="stylesheet" href="stylesheets/t.css"><iframe srcdoc="<style>.c { background-image: var(--a); }</style>"></iframe>') }));
            expect(() => buildPackage({ root, outDir: out })).not.toThrow();
            // A sheet no page links (inserted by script) still pairs its own declarations and readers.
            expect(buildError({ 'stylesheets/theme.css': ':root { --bg: url(gone.png); }\n.x { background: var(--bg); }\n' }))
                .toContain('stylesheets/theme.css: url(gone.png) in --bg resolves to stylesheets/gone.png, which is not in the package');
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
