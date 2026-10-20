/**
 * Tests for parseStoredArray — the storage-format check the service worker
 * uses so it stops flagging the normal JSON-encoded links/categories as
 * "Storage corruption".
 */
import {
    parseStoredArray,
    coerceSettings,
    SETTING_ENUMS,
    SETTING_DEFAULTS,
    LEGACY_COLOR_THEMES
} from '../../javascript/core-systems/storageFormat.js';
import stateManager from '../../javascript/core-systems/stateManager.js';

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

describe('coerceSettings', () => {
    it('keeps valid settings untouched', () => {
        const raw = { theme: 'light', colorTheme: 'amber', view: 'list', defaultTileSize: 'giant' };
        expect(coerceSettings(raw)).toEqual({ settings: raw, coerced: [] });
    });

    it('coerces each invalid field to its own default, leaving the others', () => {
        const { settings, coerced } = coerceSettings({
            theme: 'light', colorTheme: 'ocean', view: 'list', defaultTileSize: 42
        });
        expect(settings).toEqual({ theme: 'light', colorTheme: 'default', view: 'list', defaultTileSize: 'medium' });
        expect(coerced).toEqual(['colorTheme', 'defaultTileSize']);
    });

    it('fills absent or empty fields with defaults without reporting them as coerced', () => {
        expect(coerceSettings({ colorTheme: '' })).toEqual({ settings: { ...SETTING_DEFAULTS }, coerced: [] });
        expect(coerceSettings(undefined)).toEqual({ settings: { ...SETTING_DEFAULTS }, coerced: [] });
    });

    it('rejects inherited property names', () => {
        expect(coerceSettings({ colorTheme: 'constructor' }).settings.colorTheme).toBe('default');
    });

    it('every default and every enum value passes stateManager validation (one source of truth)', () => {
        expect(stateManager.validateStateChanges({ ...SETTING_DEFAULTS }).valid).toBe(true);
        for (const [key, values] of Object.entries(SETTING_ENUMS)) {
            for (const value of values) {
                expect(stateManager.validateStateChanges({ [key]: value }).valid).toBe(true);
            }
        }
    });

    it('legacy color themes fail validation but coerce to default', () => {
        for (const legacy of LEGACY_COLOR_THEMES) {
            expect(stateManager.validateStateChanges({ colorTheme: legacy }).valid).toBe(false);
            expect(coerceSettings({ colorTheme: legacy }).settings.colorTheme).toBe('default');
        }
    });
});
