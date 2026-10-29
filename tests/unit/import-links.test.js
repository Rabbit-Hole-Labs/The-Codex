/**
 * storageManager.importLinks: the file is an untrusted boundary. Pins which
 * shapes are accepted, the per-link errors (word for word, since the manage
 * page shows them), and the sanitizing applied before anything is saved.
 *
 * Runs against the real module with the quota-faithful chrome.storage fake.
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake } from '../helpers/chromeStorageFake.js';

const ICON = 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/plex.webp';
const site = (overrides = {}) => ({
    name: 'Plex', url: 'https://plex.example.com/', category: 'Media', ...overrides
});
const fileOf = (data) => new Blob([JSON.stringify(data)], { type: 'application/json' });

describe('importLinks', () => {
    let importLinks;

    beforeEach(async () => {
        installChromeStorageFake();
        jest.resetModules();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        ({ importLinks } = await import('../../javascript/core-systems/storageManager.js'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('accepts a root-level array and falls back to the Default category', async () => {
        const state = {};
        await expect(importLinks(state, fileOf([site()]))).resolves.toBe(true);
        expect(state.links).toEqual([site()]);
        expect(state.categories).toEqual(['Default']);
        expect(state.theme).toBe('dark');
        expect(state.view).toBe('grid');
    });

    test('sanitizes display fields and categories, and coerces icons outside the policy', async () => {
        const state = {};
        await importLinks(state, fileOf({
            links: [
                site({ name: '  Plex  ', category: 'Media\u0007', icon: 'https://evil.example/x.png' }),
                site({ name: 'Kept', icon: ICON }),
                site({ name: 'Auto', icon: 'default' })
            ],
            categories: ['Media', '   ', 7],
            theme: 'light'
        }));
        expect(state.links.map(l => [l.name, l.category, l.icon])).toEqual([
            ['Plex', 'Media', 'default'],
            ['Kept', 'Media', ICON],
            ['Auto', 'Media', 'default']
        ]);
        expect(state.categories).toEqual(['Media', '7']);
        expect(state.theme).toBe('light');
    });

    test('strips script markup from names', async () => {
        const state = {};
        await importLinks(state, fileOf([site({ name: 'Plex<img src=x onerror=alert(1)><script>alert(2)</script>' })]));
        expect(state.links[0].name).not.toMatch(/onerror|<script/i);
        expect(state.links[0].name).toMatch(/^Plex/);
    });

    test('an import whose categories all sanitize away keeps Default', async () => {
        const state = {};
        await importLinks(state, fileOf({ links: [], categories: ['  ', ''] }));
        expect(state.categories).toEqual(['Default']);
    });

    test.each([
        ['an object without links', { nope: [] },
            'Invalid file format: Expected either a "links" array property or root-level array of link objects'],
        ['a non-object link', [site(), 'plex'], 'Invalid link at index 1: Link must be an object'],
        ['a missing name', [site({ name: '' })], 'Invalid link at index 0: Link must have a "name" property (string)'],
        ['a non-string url', [site({ url: 5 })], 'Invalid link at index 0: Link must have a "url" property (string)'],
        ['a missing category', [site({ category: undefined })],
            'Invalid link at index 0: Link must have a "category" property (string)'],
        ['an unparsable URL', [site({ url: 'not a url' })], 'Invalid link at index 0: Link has an invalid URL format'],
        ['an unsafe scheme', [site(), site({ url: 'javascript:alert(1)' })],
            'Invalid link at index 1: URL uses an unsupported or unsafe scheme']
    ])('rejects %s without saving', async (_, data, message) => {
        const state = { links: ['untouched'] };
        await expect(importLinks(state, fileOf(data))).rejects.toThrow(message);
        expect(state.links).toEqual(['untouched']);
        expect(await chrome.storage.sync.get(null)).toEqual({});
    });
});
