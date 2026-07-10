/**
 * Tests for selfh.st/icons matching — the icon source that replaced
 * per-site favicon fetching (and let the CSP drop its img-src wildcard).
 */
import {
    toIconSlug,
    selfhstCandidateSlugs,
    selfhstIconUrl,
    themedIconVariantUrl
} from '../../javascript/features/iconCache.js';

describe('toIconSlug', () => {
    it('lowercases and hyphenates spaces', () => {
        expect(toIconSlug('Home Assistant')).toBe('home-assistant');
    });

    it('preserves existing hyphens', () => {
        expect(toIconSlug('Pi-hole')).toBe('pi-hole');
    });

    it('trims surrounding whitespace and punctuation', () => {
        expect(toIconSlug('  Jellyfin  ')).toBe('jellyfin');
        expect(toIconSlug('Sonarr!!!')).toBe('sonarr');
    });

    it('returns empty for empty/nullish input', () => {
        expect(toIconSlug('')).toBe('');
        expect(toIconSlug(null)).toBe('');
        expect(toIconSlug(undefined)).toBe('');
    });
});

describe('selfhstCandidateSlugs', () => {
    it('uses the app name first, then the domain label', () => {
        expect(selfhstCandidateSlugs({ name: 'Jellyfin', url: 'https://jellyfin.mylan.net' }))
            .toEqual(['jellyfin', 'mylan']);
    });

    it('skips IP-address hosts (internal apps match by name only)', () => {
        expect(selfhstCandidateSlugs({ name: 'Radarr', url: 'http://192.168.1.10:7878' }))
            .toEqual(['radarr']);
    });

    it('falls back to domain labels when the name is unusable', () => {
        expect(selfhstCandidateSlugs({ name: '', url: 'https://grafana.example.com' }))
            .toEqual(['grafana', 'example']);
    });

    it('skips generic domain labels like "dashboard"', () => {
        expect(selfhstCandidateSlugs({ name: 'Dash', url: 'https://dashboard.example.com' }))
            .toEqual(['dash', 'example']);
    });

    it('tolerates an unparseable url (still matches by name)', () => {
        const slugs = selfhstCandidateSlugs({ name: 'Sonarr', url: 'not a url' });
        expect(Array.isArray(slugs)).toBe(true);
        expect(slugs[0]).toBe('sonarr');
    });
});

describe('selfhstIconUrl', () => {
    it('builds a jsDelivr WebP URL', () => {
        expect(selfhstIconUrl('jellyfin'))
            .toBe('https://cdn.jsdelivr.net/gh/selfhst/icons/webp/jellyfin.webp');
    });
});

describe('themedIconVariantUrl', () => {
    const BASE = 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/github.webp';

    it('prefers the -light recolor on the dark theme, -dark on light', () => {
        expect(themedIconVariantUrl(BASE, 'dark'))
            .toBe('https://cdn.jsdelivr.net/gh/selfhst/icons/webp/github-light.webp');
        expect(themedIconVariantUrl(BASE, 'light'))
            .toBe('https://cdn.jsdelivr.net/gh/selfhst/icons/webp/github-dark.webp');
    });

    it('respects an explicitly picked variant (no double transform)', () => {
        expect(themedIconVariantUrl('https://cdn.jsdelivr.net/gh/selfhst/icons/webp/github-light.webp', 'dark'))
            .toBeNull();
    });

    it('ignores non-library URLs, data URIs, and unknown themes', () => {
        expect(themedIconVariantUrl('https://cdn.selfh.st/icons/webp/plex.webp', 'dark')).toBeNull();
        expect(themedIconVariantUrl('data:image/png;base64,AAAA', 'dark')).toBeNull();
        expect(themedIconVariantUrl(BASE, 'blue')).toBeNull();
        expect(themedIconVariantUrl(null, 'dark')).toBeNull();
    });
});
