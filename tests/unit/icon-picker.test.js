/**
 * iconPicker.js: the manage-page gate that decides which icon may be written
 * into a link's icon input. Pins the modal's user-visible behavior (open,
 * search, choose, close, custom URL, None, Escape) and the live preview chip.
 *
 * The DOM is the real markup: the two link forms and the picker modal are
 * lifted out of manage.html at test time, so a drifted id breaks these tests.
 * Image probes (testImageLoad) are a controllable fake; every other icon
 * helper (validateIconValue, toIconSlug, selfhstCandidateSlugs,
 * selfhstIconUrl) is the real implementation. The catalog index is mocked so
 * a test can make it available or unreachable.
 */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const realIconCache = await import('../../javascript/features/iconCache.js');
realIconCache.stopCacheCleanup();

const probeLog = [];          // [url, timeout] per testImageLoad call
const probeResults = new Map(); // url -> Promise<string|null>

jest.unstable_mockModule('../../javascript/features/iconCache.js', () => ({
    ...realIconCache,
    testImageLoad: jest.fn((url, timeout) => {
        probeLog.push([url, timeout]);
        return probeResults.get(url) ?? Promise.resolve(null);
    })
}));

let indexValue = null;  // what getIconIndex resolves to (null = unreachable)
let indexResults = [];  // what searchIndex returns
const searchIndexCalls = [];

jest.unstable_mockModule('../../javascript/features/iconIndex.js', () => ({
    getIconIndex: jest.fn(async () => indexValue),
    searchIndex: jest.fn((query, index, options) => {
        searchIndexCalls.push([query, index, options]);
        return [...indexResults];
    })
}));

const MANAGE_HTML = readFileSync(
    fileURLToPath(new URL('../../manage.html', import.meta.url)), 'utf8');

const DEBOUNCE_MS = 350;       // search, custom-URL and preview-chip debounce
const PROBE_TIMEOUT_MS = 4000; // every image probe the picker makes

const selfhst = (slug) => `https://cdn.jsdelivr.net/gh/selfhst/icons/webp/${slug}.webp`;
const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
// Rejected by the real validateIconValue host policy (not a mocked verdict).
const BLOCKED_URL = 'https://evil.example/x.png';
const BLOCKED_REASON = /"evil\.example" would be blocked/;
const DEFAULT_NOTE = 'Allowed sources: selfh.st, jsDelivr, or a data: image URI. The preview must load before the icon can be used.';
const SHORT_QUERY = 'Type an app or service name to search the icon library.';
const NO_RESULT_INDEX = 'No matching icon in the selfh.st library. Try another name, or paste an image URL below.';
const NO_RESULT_NO_INDEX = 'No match. The icon catalog could not be loaded, so search needs the app\'s exact name (e.g. "vmware-esxi") — or paste an image URL below.';

function defer() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

/** Marks URLs as loading successfully. */
function loads(...urls) {
    urls.forEach(url => probeResults.set(url, Promise.resolve(url)));
}

/** Holds url's probe in flight; returns resolve(result) to finish it (url = loaded, null = failed). */
function loadsLater(url) {
    const pending = defer();
    probeResults.set(url, pending.promise);
    return pending.resolve;
}

/** Lets pending promise chains settle (jsdom has no setImmediate). */
async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(ms) {
    jest.advanceTimersByTime(ms);
    await flush();
    await flush();
}

const $ = (id) => document.getElementById(id);
const probedUrls = () => probeLog.map(([url]) => url);
const resultSlugs = () => [...$('iconResults').querySelectorAll('.icon-result')]
    .map(btn => btn.querySelector('.icon-slug').textContent);

function buildDom() {
    const source = new DOMParser().parseFromString(MANAGE_HTML, 'text/html');
    document.body.innerHTML = '';
    for (const id of ['linkForm', 'editForm', 'iconHelperModal']) {
        const node = source.getElementById(id);
        if (!node) throw new Error(`manage.html no longer has #${id}`);
        document.body.appendChild(document.importNode(node, true));
    }
}

function typeInto(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Types into the input with this id and lets its debounced handler run. */
async function typeAndSettle(id, value) {
    typeInto($(id), value);
    await advance(DEBOUNCE_MS);
}

function pressEscape() {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
}

const modalOpen = () => !$('iconHelperModal').classList.contains('hidden');

let picker;
let docListeners;
let context;

beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    probeLog.length = 0;
    probeResults.clear();
    searchIndexCalls.length = 0;
    indexValue = null;
    indexResults = [];
    context = { name: '', url: '' };

    // init() adds a keydown listener to document, which outlives
    // resetModules — track and remove them so old module instances can't act.
    docListeners = [];
    const add = document.addEventListener.bind(document);
    jest.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
        docListeners.push([type, fn, opts]);
        add(type, fn, opts);
    });

    buildDom();
    jest.resetModules();
    picker = await import('../../javascript/features/iconPicker.js');
});

afterEach(() => {
    docListeners.forEach(([type, fn, opts]) => document.removeEventListener(type, fn, opts));
    jest.restoreAllMocks();
    jest.useRealTimers();
});

function initPicker() {
    picker.init({ getContext: (targetId) => ({ ...context, targetId }) });
}

const pickerButton = (targetId) => document.querySelector(`.icon-helper-btn[data-target="${targetId}"]`);

/** Clicks a picker-open button and lets the seed search run. */
async function openWith(btn) {
    btn.click();
    await flush();
    await flush();
}

const openFrom = (targetId) => openWith(pickerButton(targetId));
const search = (query) => typeAndSettle('iconSearchInput', query);

describe('opening the picker', () => {
    test.each(['siteIcon', 'editSiteIcon'])('the %s button targets its own input', async (targetId) => {
        const other = targetId === 'siteIcon' ? 'editSiteIcon' : 'siteIcon';
        context = { name: 'Plex', url: '' };
        loads(selfhst('plex'));
        initPicker();
        await openFrom(targetId);

        $('iconResults').querySelector('.icon-result').click();

        expect($(targetId).value).toBe(selfhst('plex'));
        expect($(other).value).toBe('');
    });

    test('asks getContext for the button\'s target and seeds the search with the link name', async () => {
        const getContext = jest.fn(() => ({ name: '  Plex  ', url: ' https://plex.tv ' }));
        picker.init({ getContext });

        await openFrom('editSiteIcon');

        expect(getContext).toHaveBeenCalledWith('editSiteIcon');
        expect($('iconSearchInput').value).toBe('Plex');
        expect($('iconHelperContext').textContent).toBe('Plex — https://plex.tv');
        expect($('iconHelperContext').style.display).toBe('block');
        expect(modalOpen()).toBe(true);
        expect($('iconHelperModal').style.display).toBe('flex');
        expect(document.activeElement).toBe($('iconSearchInput'));
        expect(probedUrls()).toContain(selfhst('plex'));
    });

    test('the context line shows whichever of name/url exists, and hides when neither does', async () => {
        initPicker();
        context = { name: 'Plex', url: '' };
        await openFrom('siteIcon');
        expect($('iconHelperContext').textContent).toBe('Plex');
        expect($('iconHelperContext').style.display).toBe('block');

        context = { name: '', url: 'https://plex.tv' };
        await openFrom('siteIcon');
        expect($('iconHelperContext').textContent).toBe('https://plex.tv');

        context = { name: '', url: '' };
        await openFrom('siteIcon');
        expect($('iconHelperContext').textContent).toBe('');
        expect($('iconHelperContext').style.display).toBe('none');
    });

    test('a getContext that returns nothing opens an empty picker without probing', async () => {
        picker.init({ getContext: () => null });
        await openFrom('siteIcon');

        expect(modalOpen()).toBe(true);
        expect($('iconSearchInput').value).toBe('');
        expect($('iconSearchStatus').textContent).toBe(SHORT_QUERY);
        expect(probeLog).toEqual([]);
    });

    test('init without options still opens (default context is empty)', async () => {
        picker.init();
        await openFrom('siteIcon');
        expect(modalOpen()).toBe(true);
        expect($('iconSearchStatus').textContent).toBe(SHORT_QUERY);
    });

    test('a getContext that is not a function is ignored (default empty context)', async () => {
        picker.init({ getContext: 'Plex' });
        await openFrom('siteIcon');
        expect(modalOpen()).toBe(true);
        expect($('iconSearchInput').value).toBe('');
        expect($('iconSearchStatus').textContent).toBe(SHORT_QUERY);
    });

    test('hostname-derived candidates are tried as well as the name', async () => {
        context = { name: 'My Media', url: 'https://jellyfin.home.lan' };
        loads(selfhst('jellyfin'));
        initPicker();
        await openFrom('siteIcon');

        expect(probedUrls()).toEqual(expect.arrayContaining([selfhst('my-media'), selfhst('jellyfin')]));
        expect(resultSlugs()).toEqual(['jellyfin']);
    });

    test('a seed that is already a candidate is probed and shown once', async () => {
        // The name and the hostname both yield "plex"; the seed must not be
        // re-added, or the same icon shows (and is probed) twice.
        context = { name: 'Plex', url: 'https://plex.tv' };
        loads(selfhst('plex'));
        initPicker();
        await openFrom('siteIcon');

        expect(probedUrls().filter(url => url === selfhst('plex'))).toHaveLength(1);
        expect(resultSlugs()).toEqual(['plex']);
        expect($('iconSearchStatus').textContent).toBe('1 verified icon found — click one to use it.');
    });

    test('hostname seeds alone run a search even when the name is too short', async () => {
        context = { name: '', url: 'https://jellyfin.home.lan' };
        loads(selfhst('jellyfin'));
        initPicker();
        await openFrom('siteIcon');

        expect(probedUrls()).toContain(selfhst('jellyfin'));
        expect(resultSlugs()).toEqual(['jellyfin']);
    });

    test('a picker button never submits its surrounding form', async () => {
        // The buttons are type="button" today; the click handler also cancels
        // the default so a markup change can't turn "Pick icon" into a save.
        const btn = pickerButton('siteIcon');
        btn.type = 'submit';
        const submits = [];
        $('linkForm').addEventListener('submit', (e) => { e.preventDefault(); submits.push(e); });
        initPicker();

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        btn.dispatchEvent(event);
        await flush();

        expect(event.defaultPrevented).toBe(true);
        expect(submits).toEqual([]);
        expect(modalOpen()).toBe(true);
    });

    test('a picker button without data-target targets the add form\'s siteIcon', async () => {
        const btn = pickerButton('editSiteIcon');
        btn.removeAttribute('data-target');
        const getContext = jest.fn(() => ({ name: 'Plex', url: '' }));
        loads(selfhst('plex'));
        picker.init({ getContext });

        await openWith(btn);
        expect(getContext).toHaveBeenCalledWith('siteIcon');

        $('iconResults').querySelector('.icon-result').click();
        expect($('siteIcon').value).toBe(selfhst('plex'));
        expect($('editSiteIcon').value).toBe('');
    });

    test('opening resets the custom-URL section left over from a previous session', async () => {
        loads(selfhst('custom'));
        initPicker();
        await openFrom('siteIcon');
        await typeAndSettle('customIconUrl', selfhst('custom'));
        expect($('useCustomIconBtn').disabled).toBe(false);

        // Re-open without closing (e.g. the other button) — section is reset.
        await openFrom('editSiteIcon');
        expect($('customIconUrl').value).toBe('');
        expect($('useCustomIconBtn').disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
        expect($('customIconPreview').querySelector('img').hasAttribute('src')).toBe(false);
        expect($('customIconNote').textContent).toBe(DEFAULT_NOTE);
        expect($('customIconNote').classList.contains('error')).toBe(false);
    });
});

describe('searching', () => {
    beforeEach(async () => {
        initPicker();
        await openFrom('siteIcon');
        probeLog.length = 0;
    });

    test('renders only candidates whose probe loaded, in candidate order', async () => {
        indexValue = ['catalog'];
        indexResults = ['alpha', 'bravo', 'charlie', 'delta'];
        loads(selfhst('delta'), selfhst('bravo'), selfhst('charlie-dark'));

        await search('al');

        expect(resultSlugs()).toEqual(['bravo', 'delta', 'charlie-dark']);
        expect($('iconSearchStatus').textContent).toBe('3 verified icons found — click one to use it.');
        const first = $('iconResults').querySelector('.icon-result');
        expect(first.title).toBe('bravo');
        expect(first.type).toBe('button');
        expect(first.querySelector('img').getAttribute('src')).toBe(selfhst('bravo'));
    });

    test('passes the query, index, limit and aliases to the index search', async () => {
        indexValue = ['catalog'];
        await search('ha');
        expect(searchIndexCalls).toEqual([['ha', ['catalog'], { limit: 24, aliases: ['ha', 'home-assistant'] }]]);
    });

    test('every candidate is probed at the picker\'s 4 s timeout, recolors included for small sets', async () => {
        await search('plex');
        expect(probeLog).toEqual([
            [selfhst('plex'), PROBE_TIMEOUT_MS],
            [selfhst('plex-dark'), PROBE_TIMEOUT_MS],
            [selfhst('plex-light'), PROBE_TIMEOUT_MS]
        ]);
    });

    test('recolors are still probed for exactly 8 index matches, but not for 9', async () => {
        indexValue = ['catalog'];
        const eight = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
        indexResults = eight;
        await search('aa');
        expect(probedUrls()).toContain(selfhst('a8-dark'));
        expect(probedUrls()).toContain(selfhst('a1-light'));
        expect(probeLog).toHaveLength(24);

        probeLog.length = 0;
        indexResults = [...eight, 'a9'];
        await search('aaa');
        expect(probedUrls()).toEqual([...eight, 'a9'].map(selfhst));
    });

    test('without an index, a spaced nickname ("VS Code") finds the alias of its hyphenless form', async () => {
        loads(selfhst('visual-studio-code'));
        await search('VS Code');
        expect(probedUrls()).toEqual(expect.arrayContaining([
            selfhst('vs-code'), selfhst('vscode'), selfhst('visual-studio-code'), selfhst('code-server')
        ]));
        expect(resultSlugs()).toEqual(['visual-studio-code']);
    });

    test('without an index, nickname aliases are probed', async () => {
        loads(selfhst('home-assistant'));
        await search('hass');
        expect(probedUrls()).toEqual(expect.arrayContaining([selfhst('hass'), selfhst('home-assistant')]));
        expect(resultSlugs()).toEqual(['home-assistant']);
    });

    test('result images are decorative (empty alt; the slug label names them)', async () => {
        loads(selfhst('plex'));
        await search('plex');
        const img = $('iconResults').querySelector('.icon-result img');
        expect(img.getAttribute('alt')).toBe('');
    });

    test('a single result uses the singular status', async () => {
        loads(selfhst('plex'));
        await search('plex');
        expect($('iconSearchStatus').textContent).toBe('1 verified icon found — click one to use it.');
    });

    test('nothing loading says so — differently with and without the catalog', async () => {
        await search('nothing-here');
        expect(resultSlugs()).toEqual([]);
        expect($('iconSearchStatus').textContent).toBe(NO_RESULT_NO_INDEX);

        indexValue = ['catalog'];
        indexResults = ['nothing-here'];
        await search('nothing-here');
        expect($('iconSearchStatus').textContent).toBe(NO_RESULT_INDEX);
    });

    test('an index with no matches reports no result without probing', async () => {
        indexValue = ['catalog'];
        indexResults = [];
        await search('zz-unknown');
        expect(probeLog).toEqual([]);
        expect($('iconSearchStatus').textContent).toBe(NO_RESULT_INDEX);
    });

    test.each(['', 'a', '  ', '!!'])('a too-short query (%j) clears results and asks for a name, without probing', async (query) => {
        loads(selfhst('plex'));
        await search('plex');
        expect(resultSlugs()).toEqual(['plex']);
        probeLog.length = 0;

        await search(query);

        expect(resultSlugs()).toEqual([]);
        expect($('iconSearchStatus').textContent).toBe(SHORT_QUERY);
        expect(probeLog).toEqual([]);
    });

    test('shows a searching status while probes are in flight', async () => {
        const slow = loadsLater(selfhst('plex'));
        await search('plex');
        expect($('iconSearchStatus').textContent).toBe('Searching the selfh.st icon library…');
        slow(selfhst('plex'));
        await flush();
        expect(resultSlugs()).toEqual(['plex']);
    });

    test('typing is debounced: only the last query within 350 ms is searched', async () => {
        typeInto($('iconSearchInput'), 'pl');
        jest.advanceTimersByTime(200);
        typeInto($('iconSearchInput'), 'plex');
        await advance(DEBOUNCE_MS - 1);
        expect(probeLog).toEqual([]);
        await advance(1);
        expect(probedUrls()).toContain(selfhst('plex'));
        expect(probedUrls()).not.toContain(selfhst('pl'));
    });

    test('a superseded search resolving late never overwrites the newer results', async () => {
        const slowOld = loadsLater(selfhst('old'));
        loads(selfhst('new'));

        await search('old');
        await search('new');
        expect(resultSlugs()).toEqual(['new']);
        const status = $('iconSearchStatus').textContent;

        slowOld(selfhst('old'));
        await flush();
        await flush();

        expect(resultSlugs()).toEqual(['new']);
        expect($('iconSearchStatus').textContent).toBe(status);
    });

    test('a superseded search whose index lookup resolves late is dropped', async () => {
        const slowIndex = defer();
        const { getIconIndex } = await import('../../javascript/features/iconIndex.js');
        getIconIndex.mockImplementationOnce(() => slowIndex.promise);
        loads(selfhst('old'), selfhst('new'));

        await search('old');
        await search('new');
        expect(resultSlugs()).toEqual(['new']);

        slowIndex.resolve(null);
        await flush();
        await flush();
        expect(resultSlugs()).toEqual(['new']);
        expect(probedUrls()).not.toContain(selfhst('old'));
    });

    test('closing mid-search discards the results', async () => {
        const slow = loadsLater(selfhst('plex'));
        await search('plex');

        $('iconHelperClose').click();
        slow(selfhst('plex'));
        await flush();
        await flush();

        expect(resultSlugs()).toEqual([]);
    });
});

describe('choosing a result', () => {
    test('writes exactly the probed URL into the target, fires a bubbling input event, and closes', async () => {
        context = { name: 'Plex', url: '' };
        loads(selfhst('plex-light'));
        initPicker();
        await openFrom('editSiteIcon');

        const seen = [];
        $('editForm').addEventListener('input', (e) => seen.push([e.target.id, e.target.value]));
        const btn = $('iconResults').querySelector('.icon-result');
        expect(btn.title).toBe('plex-light');
        btn.click();

        expect(seen).toEqual([['editSiteIcon', selfhst('plex-light')]]);
        expect($('editSiteIcon').value).toBe(selfhst('plex-light'));
        expect(modalOpen()).toBe(false);
        expect($('iconHelperModal').style.display).toBe('none');
    });
});

describe('custom URL', () => {
    const note = () => $('customIconNote');
    const useBtn = () => $('useCustomIconBtn');

    beforeEach(async () => {
        initPicker();
        await openFrom('siteIcon');
        probeLog.length = 0;
    });

    const paste = (value) => typeAndSettle('customIconUrl', value);

    test('empty input shows the default note', async () => {
        await paste(BLOCKED_URL);
        await paste('   ');
        expect(note().textContent).toBe(DEFAULT_NOTE);
        expect(note().classList.contains('error')).toBe(false);
        expect(useBtn().disabled).toBe(true);
        expect(probeLog).toEqual([]);
    });

    test('"default" shows the default note and is never probed', async () => {
        await paste('default');
        expect(note().textContent).toBe(DEFAULT_NOTE);
        expect(note().classList.contains('error')).toBe(false);
        expect(useBtn().disabled).toBe(true);
        expect(probeLog).toEqual([]);
    });

    test('"default" after a rejected value clears the error back to the default note', async () => {
        await paste(BLOCKED_URL);
        expect(note().classList.contains('error')).toBe(true);

        await paste('default');
        expect(note().textContent).toBe(DEFAULT_NOTE);
        expect(note().classList.contains('error')).toBe(false);
        expect(useBtn().disabled).toBe(true);
        expect(probeLog).toEqual([]);
    });

    test.each([
        ['a disallowed host', 'https://evil.example/icon.png', BLOCKED_REASON],
        ['http: on an allowed host', 'http://cdn.jsdelivr.net/gh/selfhst/icons/webp/plex.webp', /"cdn\.jsdelivr\.net" would be blocked/],
        ['javascript:', 'javascript:alert(1)', /would be blocked/],
        ['a lookalike host', 'https://cdn.jsdelivr.net.evil.example/x.png', /would be blocked/],
        ['a non-image data: URI', 'data:text/html;base64,PHNjcmlwdD4=', /^Data-URI icons must be base64/],
        ['a non-URL string', 'not a url', /^Icon must be a full https:\/\/ URL/]
    ])('%s is rejected with an error note, Use stays disabled, nothing is probed', async (_label, value, reason) => {
        await paste(value);
        expect(note().textContent).toMatch(reason);
        expect(note().classList.contains('error')).toBe(true);
        expect(useBtn().disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
        expect(probeLog).toEqual([]);
    });

    test('an allowed URL that does not load is an error and Use stays disabled', async () => {
        await paste('https://cdn.selfh.st/icons/webp/missing.webp');
        expect(probedUrls()).toEqual(['https://cdn.selfh.st/icons/webp/missing.webp']);
        expect(probeLog[0][1]).toBe(PROBE_TIMEOUT_MS);
        expect(note().textContent).toBe('That URL did not load an image, so it can\'t be used.');
        expect(note().classList.contains('error')).toBe(true);
        expect(useBtn().disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
    });

    test('an allowed URL that loads shows the preview, enables Use, and says verified', async () => {
        const url = 'https://cdn.selfh.st/icons/webp/jellyfin.webp';
        const pending = loadsLater(url);

        await paste(`  ${url}  `);
        expect(note().textContent).toBe('Checking that the image loads…');
        expect(useBtn().disabled).toBe(true);

        pending(url);
        await flush();

        expect(probedUrls()).toEqual([url]);
        expect($('customIconPreview').hidden).toBe(false);
        expect($('customIconPreview').querySelector('img').getAttribute('src')).toBe(url);
        expect(useBtn().disabled).toBe(false);
        expect(note().textContent).toBe('Image verified — click Use.');
        expect(note().classList.contains('error')).toBe(false);
    });

    test('editing a verified URL disables Use until the new value is verified', async () => {
        const first = 'https://cdn.selfh.st/icons/webp/first.webp';
        const second = 'https://cdn.selfh.st/icons/webp/second.webp';
        loads(first);
        const pending = loadsLater(second);

        await paste(first);
        expect(useBtn().disabled).toBe(false);

        await paste(second);
        expect(note().textContent).toBe('Checking that the image loads…');
        expect(useBtn().disabled).toBe(true);
        useBtn().click();
        expect($('siteIcon').value).toBe('');
        expect(modalOpen()).toBe(true);

        pending(null);
        await flush();
        expect(useBtn().disabled).toBe(true);
        expect(note().classList.contains('error')).toBe(true);
    });

    test('editing a verified URL to a rejected one disables Use', async () => {
        const url = 'https://cdn.selfh.st/icons/webp/ok.webp';
        loads(url);
        await paste(url);
        expect(useBtn().disabled).toBe(false);

        await paste(BLOCKED_URL);
        expect(useBtn().disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
    });

    test('pasting is debounced: only the last value within 350 ms is verified', async () => {
        const first = 'https://cdn.selfh.st/icons/webp/first.webp';
        const second = 'https://cdn.selfh.st/icons/webp/second.webp';
        loads(first, second);

        typeInto($('customIconUrl'), first);
        jest.advanceTimersByTime(200);
        typeInto($('customIconUrl'), second);
        await advance(DEBOUNCE_MS - 1);
        expect(probeLog).toEqual([]);
        expect(useBtn().disabled).toBe(true);

        await advance(1);
        expect(probedUrls()).toEqual([second]);
        expect(useBtn().disabled).toBe(false);
    });

    test('a valid data: image URI is probed and can be used', async () => {
        loads(PNG_URI);
        await paste(PNG_URI);
        expect(useBtn().disabled).toBe(false);

        useBtn().click();
        expect($('siteIcon').value).toBe(PNG_URI);
        expect(modalOpen()).toBe(false);
    });

    test('a stale verification is ignored when the input changed meanwhile', async () => {
        const first = 'https://cdn.selfh.st/icons/webp/first.webp';
        const slow = loadsLater(first);

        await paste(first);
        await paste(BLOCKED_URL);
        slow(first);
        await flush();

        expect(useBtn().disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
        expect(note().classList.contains('error')).toBe(true);
        expect(note().textContent).toMatch(BLOCKED_REASON);
    });

    test('closing while a verification is pending discards it', async () => {
        const url = 'https://cdn.selfh.st/icons/webp/late.webp';
        const slow = loadsLater(url);
        await paste(url);

        $('iconHelperClose').click();
        slow(url);
        await flush();

        expect(useBtn().disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
        expect(note().textContent).toBe(DEFAULT_NOTE);
    });

    test('Use writes the verified URL into the target, fires input, and closes', async () => {
        const url = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/plex.svg';
        loads(url);
        await paste(url);

        const seen = [];
        $('linkForm').addEventListener('input', (e) => seen.push(e.target.id));
        useBtn().click();

        expect($('siteIcon').value).toBe(url);
        expect(seen).toEqual(['siteIcon']);
        expect(modalOpen()).toBe(false);
        expect($('customIconUrl').value).toBe('');
        expect(useBtn().disabled).toBe(true);
    });

    test.each([
        ['a disallowed host', BLOCKED_URL],
        ['empty', ''],
        ['"default"', 'default']
    ])('Use re-validates at click time: changed to %s after enabling, nothing is chosen', async (_label, value) => {
        const url = 'https://cdn.selfh.st/icons/webp/ok.webp';
        loads(url);
        await paste(url);
        expect(useBtn().disabled).toBe(false);

        // Changed without the debounced re-verify having run yet.
        $('customIconUrl').value = value;
        useBtn().click();

        expect($('siteIcon').value).toBe('');
        expect(modalOpen()).toBe(true);
    });

    test('typing a new URL disables Use at once, before the debounced re-verify', async () => {
        const url = 'https://cdn.selfh.st/icons/webp/ok.webp';
        loads(url);
        await paste(url);
        expect(useBtn().disabled).toBe(false);

        typeInto($('customIconUrl'), 'https://cdn.selfh.st/icons/webp/never-probed.webp');
        expect(useBtn().disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
        expect(note().textContent).toBe(DEFAULT_NOTE); // no longer "Image verified"
        expect(note().classList.contains('error')).toBe(false);
    });

    test('Use only chooses the URL whose image loaded, never another allowed one', async () => {
        const url = 'https://cdn.selfh.st/icons/webp/ok.webp';
        loads(url);
        await paste(url);

        // Same host rules, but this image was never loaded.
        $('customIconUrl').value = 'https://cdn.selfh.st/icons/webp/never-probed.webp';
        useBtn().click();

        expect($('siteIcon').value).toBe('');
        expect(modalOpen()).toBe(true);
        expect(probedUrls()).toEqual([url]);
    });

    test('a check still running for the old URL does not enable Use for a newly typed one', async () => {
        const first = 'https://cdn.selfh.st/icons/webp/first.webp';
        const second = 'https://cdn.selfh.st/icons/webp/never-probed.webp';
        const slow = loadsLater(first);
        await paste(first);

        typeInto($('customIconUrl'), second); // its debounce has not run yet
        slow(first);
        await flush();

        expect(useBtn().disabled).toBe(true);
        expect($('customIconPreview').hidden).toBe(true);
        useBtn().click();
        expect($('siteIcon').value).toBe('');
    });
});

describe('closing cancels pending typing', () => {
    beforeEach(async () => {
        initPicker();
        await openFrom('siteIcon');
        probeLog.length = 0;
    });

    test('a search typed less than 350 ms before closing never runs', async () => {
        loads(selfhst('plex'));
        typeInto($('iconSearchInput'), 'plex');
        $('iconHelperClose').click();
        await advance(DEBOUNCE_MS);

        expect(probeLog).toEqual([]);
        expect(resultSlugs()).toEqual([]);
    });

    test('a custom URL typed less than 350 ms before closing is never checked', async () => {
        const url = 'https://cdn.selfh.st/icons/webp/late.webp';
        loads(url);
        typeInto($('customIconUrl'), url);
        $('iconHelperClose').click();
        // Closing empties the field; put a URL back (no input event) so only
        // the cancelled timer, not the empty field, can stop the check.
        $('customIconUrl').value = url;
        await advance(DEBOUNCE_MS);

        expect(probeLog).toEqual([]);
        expect($('useCustomIconBtn').disabled).toBe(true);
    });
});

describe('None, Escape and backdrop', () => {
    beforeEach(async () => {
        initPicker();
    });

    test('None writes an empty value into the target, fires input, and closes', async () => {
        $('editSiteIcon').value = selfhst('plex');
        await openFrom('editSiteIcon');
        const seen = [];
        $('editForm').addEventListener('input', (e) => seen.push([e.target.id, e.target.value]));

        $('iconNoneBtn').click();

        expect($('editSiteIcon').value).toBe('');
        expect(seen).toEqual([['editSiteIcon', '']]);
        expect(modalOpen()).toBe(false);
    });

    test('Escape closes the open picker and consumes the key', async () => {
        await openFrom('siteIcon');
        const event = pressEscape();
        expect(modalOpen()).toBe(false);
        expect(event.defaultPrevented).toBe(true);
    });

    test('Escape does nothing while the picker is closed', async () => {
        const event = pressEscape();
        expect(modalOpen()).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });

    test('other keys do not close the picker', async () => {
        await openFrom('siteIcon');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(modalOpen()).toBe(true);
    });

    test('a backdrop click does not close the picker', async () => {
        await openFrom('siteIcon');
        $('iconHelperModal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(modalOpen()).toBe(true);
    });

    test('the close button closes without writing anything', async () => {
        $('siteIcon').value = 'keep-me';
        await openFrom('siteIcon');
        $('iconHelperClose').click();
        expect(modalOpen()).toBe(false);
        expect($('siteIcon').value).toBe('keep-me');
    });
});

describe('missing markup', () => {
    test('init, open and search tolerate a page without the picker modal', async () => {
        $('iconHelperModal').remove();
        initPicker();
        context = { name: 'Plex', url: '' };
        await openFrom('siteIcon');
        expect(probeLog).toEqual([]);
        expect(() => pressEscape()).not.toThrow();
    });

    test('the custom-URL check is a no-op without a Use button', async () => {
        initPicker();
        await openFrom('siteIcon');
        $('useCustomIconBtn').remove();
        loads(selfhst('x'));
        await typeAndSettle('customIconUrl', selfhst('x'));
        expect(probeLog.filter(([url]) => url === selfhst('x'))).toEqual([]);
    });

    test('a target input that no longer exists still closes the picker', async () => {
        initPicker();
        await openFrom('siteIcon');
        $('siteIcon').remove();
        $('iconNoneBtn').click();
        expect(modalOpen()).toBe(false);
    });
});

describe('attachPreview', () => {
    const chip = () => $('siteIconPreview');
    const chipImg = () => chip().querySelector('img');

    beforeEach(() => {
        picker.attachPreview('siteIcon', 'siteIconPreview');
    });

    const set = (value) => typeAndSettle('siteIcon', value);

    test('empty and "default" hide the chip and clear the invalid state', async () => {
        await set(BLOCKED_URL);
        expect(chip().hidden).toBe(false);

        await set('default');
        expect(chip().hidden).toBe(true);
        expect(chip().classList.contains('invalid')).toBe(false);

        await set(BLOCKED_URL);
        await set('   ');
        expect(chip().hidden).toBe(true);
        expect(chip().classList.contains('invalid')).toBe(false);
        expect(probeLog).toEqual([]);
    });

    test('an invalid value shows an invalid chip titled with the reason, src removed, no probe', async () => {
        const url = selfhst('plex');
        loads(url);
        await set(url);
        expect(chipImg().getAttribute('src')).toBe(url);
        probeLog.length = 0;

        await set(BLOCKED_URL);

        expect(chip().hidden).toBe(false);
        expect(chip().classList.contains('invalid')).toBe(true);
        expect(chip().title).toMatch(BLOCKED_REASON);
        expect(chipImg().hasAttribute('src')).toBe(false);
        expect(probeLog).toEqual([]);
    });

    test('a value that loads shows a verified chip with the loaded src', async () => {
        const url = selfhst('plex');
        loads(url);
        await set(BLOCKED_URL);
        await set(`  ${url}  `);

        expect(probeLog).toEqual([[url, PROBE_TIMEOUT_MS]]);
        expect(chip().hidden).toBe(false);
        expect(chip().classList.contains('invalid')).toBe(false);
        expect(chipImg().getAttribute('src')).toBe(url);
        expect(chip().title).toBe('Icon verified');
    });

    test('a valid value that does not load shows an invalid chip, src removed', async () => {
        const good = selfhst('plex');
        loads(good);
        await set(good);

        await set(selfhst('dead'));

        expect(chip().hidden).toBe(false);
        expect(chip().classList.contains('invalid')).toBe(true);
        expect(chipImg().hasAttribute('src')).toBe(false);
        expect(chip().title).toBe('This icon URL does not load an image');
    });

    test('a dead URL typed into an empty input reveals the hidden chip as invalid', async () => {
        expect(chip().hidden).toBe(true);
        await set(selfhst('dead'));
        expect(chip().hidden).toBe(false);
        expect(chip().classList.contains('invalid')).toBe(true);
        expect(chip().title).toBe('This icon URL does not load an image');
    });

    test('a URL that loads, typed into an empty input, reveals the hidden chip as verified', async () => {
        const url = selfhst('plex');
        loads(url);
        expect(chip().hidden).toBe(true);
        await set(url);
        expect(chip().hidden).toBe(false);
        expect(chip().classList.contains('invalid')).toBe(false);
        expect(chipImg().getAttribute('src')).toBe(url);
    });

    test('a stale probe resolving after a newer value is ignored', async () => {
        const slowUrl = selfhst('slow');
        const fastUrl = selfhst('fast');
        const slow = loadsLater(slowUrl);
        loads(fastUrl);

        await set(slowUrl);
        await set(fastUrl);
        slow(null);
        await flush();

        expect(chip().classList.contains('invalid')).toBe(false);
        expect(chipImg().getAttribute('src')).toBe(fastUrl);
        expect(chip().title).toBe('Icon verified');
    });

    test('a stale probe is ignored when the value was cleared meanwhile', async () => {
        const slowUrl = selfhst('slow');
        const slow = loadsLater(slowUrl);

        await set(slowUrl);
        await set('');
        slow(slowUrl);
        await flush();

        expect(chip().hidden).toBe(true);
        expect(chipImg().hasAttribute('src')).toBe(false);
    });

    test('input is debounced by 350 ms', async () => {
        loads(selfhst('a'), selfhst('ab'));
        typeInto($('siteIcon'), selfhst('a'));
        jest.advanceTimersByTime(300);
        typeInto($('siteIcon'), selfhst('ab'));
        await advance(DEBOUNCE_MS - 1);
        expect(probeLog).toEqual([]);
        await advance(1);
        expect(probedUrls()).toEqual([selfhst('ab')]);
    });

    test('resetting the surrounding form hides the chip again', async () => {
        await set(BLOCKED_URL);
        expect(chip().hidden).toBe(false);

        $('linkForm').reset();
        await advance(0);

        expect($('siteIcon').value).toBe('');
        expect(chip().hidden).toBe(true);
        expect(chip().classList.contains('invalid')).toBe(false);
    });

    test('works for the edit form input as well', async () => {
        picker.attachPreview('editSiteIcon', 'editSiteIconPreview');
        await typeAndSettle('editSiteIcon', BLOCKED_URL);
        expect($('editSiteIconPreview').hidden).toBe(false);
        expect($('editSiteIconPreview').classList.contains('invalid')).toBe(true);
    });

    test('missing input or chip is a no-op', () => {
        expect(() => picker.attachPreview('nope', 'siteIconPreview')).not.toThrow();
        expect(() => picker.attachPreview('siteIcon', 'nope')).not.toThrow();
    });

    test('an input outside a form gets no reset hook', async () => {
        const input = document.createElement('input');
        input.id = 'loose';
        const span = document.createElement('span');
        span.id = 'looseChip';
        span.hidden = true;
        span.appendChild(document.createElement('img'));
        document.body.append(input, span);

        picker.attachPreview('loose', 'looseChip');
        typeInto(input, BLOCKED_URL);
        await advance(DEBOUNCE_MS);
        expect(span.hidden).toBe(false);
        expect(span.classList.contains('invalid')).toBe(true);
    });
});

describe('expandWithVariants', () => {
    test('returns a new list and leaves its input untouched', () => {
        const input = ['github', 'plex'];
        const out = picker.expandWithVariants(input);
        expect(out).toEqual(['github', 'plex', 'github-dark', 'github-light', 'plex-dark', 'plex-light']);
        expect(input).toEqual(['github', 'plex']);
        expect(out).not.toBe(input);
    });
});
