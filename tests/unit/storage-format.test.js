/**
 * Tests for parseStoredArray — the storage-format check the service worker
 * uses so it stops flagging the normal JSON-encoded links/categories as
 * "Storage corruption".
 */
import { parseStoredArray } from '../../javascript/core-systems/storageFormat.js';

describe('parseStoredArray', () => {
    it('accepts a real array', () => {
        const arr = [{ name: 'A' }];
        expect(parseStoredArray(arr)).toBe(arr);
    });

    it('accepts a JSON-encoded array string (the normal stored form)', () => {
        expect(parseStoredArray(JSON.stringify(['Default', 'Work']))).toEqual(['Default', 'Work']);
        expect(parseStoredArray('[]')).toEqual([]);
    });

    it('rejects a JSON string that decodes to a non-array', () => {
        expect(parseStoredArray('{"a":1}')).toBeNull();
        expect(parseStoredArray('"just a string"')).toBeNull();
        expect(parseStoredArray('42')).toBeNull();
    });

    it('rejects an unparseable string', () => {
        expect(parseStoredArray('not json')).toBeNull();
    });

    it('rejects a plain object (genuine corruption)', () => {
        expect(parseStoredArray({ 0: 'a', 1: 'b' })).toBeNull();
    });

    it('rejects null/undefined/number', () => {
        expect(parseStoredArray(null)).toBeNull();
        expect(parseStoredArray(undefined)).toBeNull();
        expect(parseStoredArray(7)).toBeNull();
    });
});
