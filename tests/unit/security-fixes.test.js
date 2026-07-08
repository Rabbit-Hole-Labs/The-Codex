/**
 * Regression tests for the security-review fixes:
 *  - #53 category-reorder stored XSS  (escapeHtml)
 *  - #54 import path sanitization / #59 window.open  (validateAndSanitizeUrl)
 *  - #55 render-time encoder  (escapeHtml, replacing the decoder sanitizeHTML)
 *  - #60 custom icon scheme restriction  (getIconUrl)
 */
import { escapeHtml, validateAndSanitizeUrl } from '../../javascript/features/utils.js';
import { getIconUrl } from '../../javascript/core-systems/tileRenderer.js';

describe('escapeHtml (#53, #55, R1)', () => {
    it('neutralizes an HTML injection payload', () => {
        expect(escapeHtml('<img src=x onerror=alert(1)>'))
            .toBe('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes the quotes that enable attribute breakout', () => {
        const out = escapeHtml('x"><script>alert(1)</script>');
        expect(out).not.toContain('"');
        expect(out).not.toContain('<');
        expect(out).not.toContain('>');
    });

    it('encodes ampersands exactly once (no double-decode)', () => {
        expect(escapeHtml('A & B')).toBe('A &amp; B');
    });

    it('coerces null/undefined to an empty string', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('validateAndSanitizeUrl (#54, #59)', () => {
    it('blocks the javascript: scheme that new URL() would accept', () => {
        expect(validateAndSanitizeUrl('javascript:alert(1)')).toBe('#');
    });

    it('blocks data:text/html', () => {
        expect(validateAndSanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
    });

    it('allows a normal https URL', () => {
        expect(validateAndSanitizeUrl('https://example.com/')).toBe('https://example.com/');
    });
});

describe('getIconUrl scheme restriction (#60)', () => {
    it('rejects javascript: icons', () => {
        expect(getIconUrl({ icon: 'javascript:alert(1)' })).toBe('');
    });

    it('rejects file: icons', () => {
        expect(getIconUrl({ icon: 'file:///etc/passwd' })).toBe('');
    });

    it('rejects arbitrary https icon hosts', () => {
        expect(getIconUrl({ icon: 'https://cdn.example.com/i.png' })).toBe('');
    });

    it('rejects http icons', () => {
        expect(getIconUrl({ icon: 'http://cdn.jsdelivr.net/x.png' })).toBe('');
    });

    it('keeps jsDelivr (selfh.st) icons', () => {
        const url = 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/jellyfin.webp';
        expect(getIconUrl({ icon: url })).toBe(url);
    });

    it('keeps selfh.st icons', () => {
        const url = 'https://selfh.st/icons/webp/radarr.webp';
        expect(getIconUrl({ icon: url })).toBe(url);
    });

    it('keeps data:image icons (base64 custom icons)', () => {
        expect(getIconUrl({ icon: 'data:image/png;base64,AAAA' }))
            .toBe('data:image/png;base64,AAAA');
    });

    it('returns empty for default/absent icons', () => {
        expect(getIconUrl({ icon: 'default' })).toBe('');
        expect(getIconUrl({})).toBe('');
    });
});
