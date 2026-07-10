/**
 * Tests for save-time icon validation and icon-picker query expansion.
 *
 * validateIconValue is the single source of truth for what may be persisted
 * as link.icon — the fix for "saved but broken" icons, where any string was
 * stored and then silently refused at render time.
 */
import { validateIconValue } from '../../javascript/features/iconCache.js';
import { expandQuery } from '../../javascript/features/iconPicker.js';

// A tiny valid base64 PNG payload.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('validateIconValue', () => {
    it('normalizes empty and nullish values to the "default" sentinel', () => {
        expect(validateIconValue('')).toEqual({ valid: true, value: 'default' });
        expect(validateIconValue('   ')).toEqual({ valid: true, value: 'default' });
        expect(validateIconValue(null)).toEqual({ valid: true, value: 'default' });
        expect(validateIconValue(undefined)).toEqual({ valid: true, value: 'default' });
        expect(validateIconValue('default')).toEqual({ valid: true, value: 'default' });
    });

    it('accepts selfh.st library URLs served via jsDelivr', () => {
        const url = 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/plex.webp';
        expect(validateIconValue(url)).toEqual({ valid: true, value: url });
    });

    it('accepts selfh.st and its subdomains (cdn.selfh.st)', () => {
        const url = 'https://cdn.selfh.st/icons/webp/jellyfin.webp';
        expect(validateIconValue(url)).toEqual({ valid: true, value: url });
        const apex = 'https://selfh.st/icons/some-icon.png';
        expect(validateIconValue(apex)).toEqual({ valid: true, value: apex });
    });

    it('accepts valid base64 image data URIs', () => {
        expect(validateIconValue(TINY_PNG)).toEqual({ valid: true, value: TINY_PNG });
    });

    it('rejects data URIs that are not base64 images or exceed the size cap', () => {
        expect(validateIconValue('data:text/html;base64,PGgxPmhpPC9oMT4=').valid).toBe(false);
        const oversized = 'data:image/png;base64,' + 'A'.repeat(100001);
        expect(validateIconValue(oversized).valid).toBe(false);
    });

    it('rejects arbitrary external hosts (the CSP would block them at render)', () => {
        const result = validateIconValue('https://example.com/favicon.ico');
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('example.com');
    });

    it('rejects lookalike hosts that merely end with an allowed host name', () => {
        expect(validateIconValue('https://evilselfh.st/icon.png').valid).toBe(false);
        expect(validateIconValue('https://notcdn.jsdelivr.net.evil.com/icon.png').valid).toBe(false);
    });

    it('rejects non-https schemes and non-URL garbage', () => {
        expect(validateIconValue('http://cdn.jsdelivr.net/gh/selfhst/icons/webp/plex.webp').valid).toBe(false);
        expect(validateIconValue('javascript:alert(1)').valid).toBe(false);
        expect(validateIconValue('not a url at all').valid).toBe(false);
    });
});

describe('expandQuery (icon picker search candidates)', () => {
    it('slugifies the query as the primary candidate', () => {
        expect(expandQuery('Home Assistant')[0]).toBe('home-assistant');
    });

    it('adds a hyphen-stripped variant', () => {
        expect(expandQuery('Home Assistant')).toContain('homeassistant');
    });

    it('expands known nicknames to their canonical selfh.st slugs', () => {
        expect(expandQuery('pihole')).toContain('pi-hole');
        expect(expandQuery('npm')).toContain('nginx-proxy-manager');
        expect(expandQuery('vscode')).toContain('visual-studio-code');
    });

    it('de-duplicates candidates', () => {
        const candidates = expandQuery('jellyfin');
        expect(new Set(candidates).size).toBe(candidates.length);
    });

    it('returns nothing for empty or one-character queries', () => {
        expect(expandQuery('')).toEqual([]);
        expect(expandQuery('a')).toEqual([]);
        expect(expandQuery(null)).toEqual([]);
    });
});
