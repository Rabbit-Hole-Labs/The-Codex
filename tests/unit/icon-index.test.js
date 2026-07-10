/**
 * Tests for the selfh.st catalog index: payload parsing (defensive across
 * source shapes) and ranked substring search — the fix for "vmware" finding
 * nothing even though vmware-esxi etc. exist in the library.
 */
import {
    parseIndexPayload,
    searchIndex,
    normalizeForMatch,
    pickDisplaySlug
} from '../../javascript/features/iconIndex.js';

describe('parseIndexPayload', () => {
    it('parses selfh.st directory entries (objects with Name/Reference)', () => {
        const payload = [
            { Name: 'Home Assistant', Reference: 'home-assistant' },
            { Name: 'VMware ESXi', Reference: 'vmware-esxi' }
        ];
        expect(parseIndexPayload(payload).sort())
            .toEqual(['home-assistant', 'vmware-esxi']);
    });

    it('parses jsDelivr flat file listings and counts each icon once', () => {
        const payload = { files: [
            { name: '/webp/plex.webp' },
            { name: '/png/plex.png' },
            { name: '/svg/plex.svg' },
            { name: '/webp/jellyfin.webp' }
        ] };
        expect(parseIndexPayload(payload).sort()).toEqual(['jellyfin', 'plex']);
    });

    it('parses plain string arrays, slugifying names', () => {
        expect(parseIndexPayload(['Pi-hole', 'Uptime Kuma']).sort())
            .toEqual(['pi-hole', 'uptime-kuma']);
    });

    it('keeps -light/-dark theme variants (needed to know recolors exist)', () => {
        const slugs = parseIndexPayload(['plex', 'plex-light', 'plex-dark', 'nightlight']);
        expect(slugs.sort()).toEqual(['nightlight', 'plex', 'plex-dark', 'plex-light']);
    });

    it('returns empty for unknown shapes without throwing', () => {
        expect(parseIndexPayload(null)).toEqual([]);
        expect(parseIndexPayload({ nope: true })).toEqual([]);
        expect(parseIndexPayload('garbage')).toEqual([]);
    });
});

describe('searchIndex', () => {
    const CATALOG = [
        'vmware-esxi', 'vmware-vcenter', 'vmware-workstation-pro',
        'plex', 'plexamp', 'simplex', 'pi-hole', 'home-assistant', 'jellyfin'
    ];

    it('finds family matches from a vendor prefix (the reported case)', () => {
        const results = searchIndex('vmware', CATALOG);
        expect(results).toContain('vmware-esxi');
        expect(results).toContain('vmware-vcenter');
        expect(results).toContain('vmware-workstation-pro');
    });

    it('matches "vmware esx" against vmware-esxi via normalization', () => {
        expect(searchIndex('vmware esx', CATALOG)).toContain('vmware-esxi');
    });

    it('ranks exact matches before prefix matches before substring matches', () => {
        const results = searchIndex('plex', CATALOG);
        expect(results[0]).toBe('plex');           // exact
        expect(results[1]).toBe('plexamp');        // prefix
        expect(results).toContain('simplex');      // substring, ranked last
        expect(results.indexOf('simplex')).toBeGreaterThan(results.indexOf('plexamp'));
    });

    it('matches hyphenated slugs from unhyphenated queries', () => {
        expect(searchIndex('pihole', CATALOG)[0]).toBe('pi-hole');
        expect(searchIndex('homeassistant', CATALOG)[0]).toBe('home-assistant');
    });

    it('treats alias slugs as top-ranked exact matches', () => {
        const results = searchIndex('hass', CATALOG, { aliases: ['home-assistant'] });
        expect(results[0]).toBe('home-assistant');
    });

    it('caps the result count at the limit', () => {
        const many = Array.from({ length: 50 }, (_, i) => `app-${i}`);
        expect(searchIndex('app', many, { limit: 24 })).toHaveLength(24);
    });

    it('returns nothing for empty or too-short queries', () => {
        expect(searchIndex('', CATALOG)).toEqual([]);
        expect(searchIndex('a', CATALOG)).toEqual([]);
    });

    it('hides theme recolors of existing base icons from results', () => {
        const catalog = ['github', 'github-light', 'github-dark', 'nightlight'];
        const results = searchIndex('git', catalog);
        expect(results).toEqual(['github']);
        // ...but a -light slug with no base is a real icon, not a variant.
        expect(searchIndex('night', catalog)).toEqual(['nightlight']);
    });
});

describe('pickDisplaySlug', () => {
    const CATALOG = ['github', 'github-light', 'github-dark', 'plex'];

    it('prefers the -light recolor on the dark theme when it exists', () => {
        expect(pickDisplaySlug('github', CATALOG, 'dark')).toBe('github-light');
        expect(pickDisplaySlug('github', CATALOG, 'light')).toBe('github-dark');
    });

    it('keeps the base slug when no recolor exists', () => {
        expect(pickDisplaySlug('plex', CATALOG, 'dark')).toBe('plex');
    });

    it('respects an explicitly chosen variant and missing catalogs', () => {
        expect(pickDisplaySlug('github-light', CATALOG, 'light')).toBe('github-light');
        expect(pickDisplaySlug('github', null, 'dark')).toBe('github');
    });
});

describe('normalizeForMatch', () => {
    it('slugifies and strips hyphens', () => {
        expect(normalizeForMatch('VMware ESXi')).toBe('vmwareesxi');
        expect(normalizeForMatch('Pi-hole')).toBe('pihole');
    });
});
