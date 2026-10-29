/**
 * storageManager.loadCategories: pins where categories are read from (sync,
 * then local), how each stored shape is interpreted, which corruption is
 * logged (word for word), and that the result always contains 'Default'.
 *
 * Runs against the real module with a stubbed chrome.storage whose reads the
 * tests control, including throws and missing results.
 */
import { jest } from '@jest/globals';

describe('loadCategories', () => {
    let loadCategories;
    let setDebugEnabled;
    let sync;
    let local;
    let warn;
    let error;

    beforeEach(async () => {
        sync = { get: jest.fn().mockResolvedValue({}) };
        local = { get: jest.fn().mockResolvedValue({}) };
        global.chrome = { storage: { sync, local } };
        jest.resetModules();
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        error = jest.spyOn(console, 'error').mockImplementation(() => {});
        ({ loadCategories } = await import('../../javascript/core-systems/storageManager.js'));
        ({ setDebugEnabled } = await import('../../javascript/core-systems/debug.js'));
        setDebugEnabled(true);
    });

    afterEach(() => {
        setDebugEnabled(false);
        jest.restoreAllMocks();
    });

    const stored = (categories) => sync.get.mockResolvedValue({ categories });
    // syncManager reads its own keys from local when imported; count only ours.
    const categoryReads = (area) => area.get.mock.calls.filter(([keys]) =>
        Array.isArray(keys) && keys.length === 1 && keys[0] === 'categories');

    test('reads sync first and does not touch local when sync has categories', async () => {
        stored(['Default', 'Work']);
        await expect(loadCategories()).resolves.toEqual(['Default', 'Work']);
        expect(categoryReads(sync)).toHaveLength(1);
        expect(categoryReads(local)).toHaveLength(0);
    });

    test.each([
        ['an empty sync result', {}],
        ['an undefined sync result', undefined],
        ['an empty-string sync value', { categories: '' }]
    ])('falls back to local on %s', async (_label, syncResult) => {
        sync.get.mockResolvedValue(syncResult);
        local.get.mockResolvedValue({ categories: '["Default","Home"]' });
        await expect(loadCategories()).resolves.toEqual(['Default', 'Home']);
        expect(categoryReads(sync)).toHaveLength(1);
        expect(categoryReads(local)).toHaveLength(1);
    });

    test('an undefined local result is caught by the validation guard', async () => {
        local.get.mockResolvedValue(undefined);
        await expect(loadCategories()).resolves.toEqual(['Default']);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0][1]).toBe('Storage validation error: unexpected error during categories validation');
    });

    test('a stored array is returned as-is (same object) with Default prepended when missing', async () => {
        const arr = ['Work', 'Home'];
        stored(arr);
        const result = await loadCategories();
        expect(result).toBe(arr);
        expect(result).toEqual(['Default', 'Work', 'Home']);
    });

    test('Default elsewhere in the list is not moved', async () => {
        stored('["Work","Default"]');
        await expect(loadCategories()).resolves.toEqual(['Work', 'Default']);
    });

    test('a JSON string of an array is parsed, Default prepended', async () => {
        stored('["Work"]');
        await expect(loadCategories()).resolves.toEqual(['Default', 'Work']);
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    test('a JSON string of a non-array warns and yields Default', async () => {
        stored('{"a":1}');
        await expect(loadCategories()).resolves.toEqual(['Default']);
        expect(warn).toHaveBeenCalledWith('[DEBUG]',
            'Storage corruption detected: parsed categories data is not an array',
            { dataType: 'object', dataValue: { a: 1 } });
    });

    test('unparseable JSON logs a truncated sample and yields Default', async () => {
        const raw = '[' + 'x'.repeat(150);
        stored(raw);
        await expect(loadCategories()).resolves.toEqual(['Default']);
        expect(error).toHaveBeenCalledTimes(1);
        const [prefix, message, details] = error.mock.calls[0];
        expect(prefix).toBe('[DEBUG]');
        expect(message).toBe('Storage corruption detected: failed to parse categories JSON');
        expect(details.rawData).toBe(raw.substring(0, 100) + '...');
        expect(typeof details.errorMessage).toBe('string');
    });

    test('unparseable short JSON logs the whole sample without an ellipsis', async () => {
        stored('[oops');
        await loadCategories();
        expect(error.mock.calls[0][2].rawData).toBe('[oops');
    });

    test('a non-array object warns with its keys and yields Default', async () => {
        stored({ a: 1, b: 2 });
        await expect(loadCategories()).resolves.toEqual(['Default']);
        expect(warn).toHaveBeenCalledWith('[DEBUG]',
            'Storage corruption detected: categories data is an object instead of string or array',
            { dataType: 'object', dataKeys: ['a', 'b'] });
    });

    test.each([[42], [true]])('an unexpected type (%p) warns and yields Default', async (value) => {
        stored(value);
        await expect(loadCategories()).resolves.toEqual(['Default']);
        expect(warn).toHaveBeenCalledWith('[DEBUG]',
            'Storage corruption detected: categories data is of unexpected type',
            { dataType: typeof value, dataValue: value });
    });

    test('a sync read that throws logs and yields Default without trying local', async () => {
        sync.get.mockRejectedValue(new Error('boom'));
        await expect(loadCategories()).resolves.toEqual(['Default']);
        expect(categoryReads(local)).toHaveLength(0);
        expect(error).toHaveBeenCalledWith('[DEBUG]',
            'Storage load error: failed to load categories from storage',
            expect.objectContaining({ errorMessage: 'boom' }));
    });

    test('a local read that throws logs and yields Default', async () => {
        local.get.mockRejectedValue(new Error('nope'));
        await expect(loadCategories()).resolves.toEqual(['Default']);
        expect(error.mock.calls[0][1]).toBe('Storage load error: failed to load categories from storage');
    });
});
