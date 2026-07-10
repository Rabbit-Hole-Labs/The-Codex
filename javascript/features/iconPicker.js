/**
 * Icon Picker for the manage page.
 *
 * Replaces the old "Icon Helper", which generated a selfh.st URL from the tile
 * title without checking that the icon existed — the main source of
 * saved-but-broken icons. The picker never hands out an unverified value:
 * every search result shown is an image that already loaded from the CDN, and
 * the custom-URL path is gated on the same host validation used at save time
 * plus a live image load.
 */

import {
    toIconSlug,
    selfhstCandidateSlugs,
    selfhstIconUrl,
    testImageLoad,
    validateIconValue
} from './iconCache.js';
import { getIconIndex, searchIndex, pickDisplaySlug } from './iconIndex.js';
import { debug } from '../core-systems/debug.js';

const PROBE_TIMEOUT = 4000;
const SEARCH_DEBOUNCE = 350;
const RESULT_LIMIT = 24;
const DEFAULT_CUSTOM_NOTE = 'Allowed sources: selfh.st, jsDelivr, or a data: image URI. The preview must load before the icon can be used.';

// Common self-hosted app nicknames/abbreviations → selfh.st slugs the naive
// slugification of the query would miss. Every candidate is probed as a real
// image before it is shown, so an entry that goes stale simply yields no
// result — it can never produce a wrong save.
const ICON_ALIASES = {
    'abs': ['audiobookshelf'],
    'adguard': ['adguard-home'],
    'calibre': ['calibre-web'],
    'changedetection': ['changedetection-io'],
    'dsm': ['synology-dsm'],
    'esxi': ['vmware-esxi'],
    'guacamole': ['apache-guacamole'],
    'ha': ['home-assistant'],
    'hass': ['home-assistant'],
    'homeassistant': ['home-assistant'],
    'k8s': ['kubernetes'],
    'mongo': ['mongodb'],
    'mosquitto': ['eclipse-mosquitto'],
    'npm': ['nginx-proxy-manager'],
    'nginxproxymanager': ['nginx-proxy-manager'],
    'omv': ['openmediavault'],
    'openwebui': ['open-webui'],
    'paperless': ['paperless-ngx'],
    'paperlessngx': ['paperless-ngx'],
    'pihole': ['pi-hole'],
    'postgres': ['postgresql'],
    'proxmox': ['proxmox-light'],
    'pve': ['proxmox'],
    'qbit': ['qbittorrent'],
    'speedtest': ['speedtest-tracker', 'openspeedtest', 'librespeed'],
    'stirlingpdf': ['stirling-pdf'],
    'tandoor': ['tandoor-recipes'],
    'truenas': ['truenas-scale', 'truenas-core'],
    'unifi': ['ubiquiti-unifi'],
    'uptimekuma': ['uptime-kuma'],
    'vscode': ['visual-studio-code', 'code-server'],
    'wikijs': ['wiki-js'],
    'z2m': ['zigbee2mqtt'],
    'zwave': ['z-wave-js-ui']
};

/**
 * Expands a search query into candidate selfh.st slugs, most likely first.
 * @param {string} query - Raw search text
 * @returns {string[]} - Ordered, de-duplicated slugs to probe
 */
export function expandQuery(query) {
    const slug = toIconSlug(query);
    if (!slug || slug.length < 2) return [];

    const candidates = [];
    const push = (s) => {
        if (s && s.length >= 2 && !candidates.includes(s)) candidates.push(s);
    };

    push(slug);
    push(slug.replace(/-/g, ''));
    (ICON_ALIASES[slug] || []).forEach(push);
    (ICON_ALIASES[slug.replace(/-/g, '')] || []).forEach(push);

    return candidates;
}

// ---------------------------------------------------------------------------
// Modal state and wiring
// ---------------------------------------------------------------------------

let currentTarget = 'siteIcon';
let getContext = () => ({ name: '', url: '' });
let searchGeneration = 0;
let customGeneration = 0;
let searchDebounceTimer = null;
let customDebounceTimer = null;

function els() {
    return {
        modal: document.getElementById('iconHelperModal'),
        closeBtn: document.getElementById('iconHelperClose'),
        context: document.getElementById('iconHelperContext'),
        search: document.getElementById('iconSearchInput'),
        status: document.getElementById('iconSearchStatus'),
        results: document.getElementById('iconResults'),
        customUrl: document.getElementById('customIconUrl'),
        customPreview: document.getElementById('customIconPreview'),
        customNote: document.getElementById('customIconNote'),
        useCustomBtn: document.getElementById('useCustomIconBtn'),
        noneBtn: document.getElementById('iconNoneBtn')
    };
}

function setStatus(message) {
    const status = els().status;
    if (status) status.textContent = message;
}

function setCustomNote(message, isError = false) {
    const note = els().customNote;
    if (!note) return;
    note.textContent = message;
    note.classList.toggle('error', isError);
}

/**
 * Wires the picker modal and the picker-open buttons. Call once at page init.
 * @param {Object} options
 * @param {Function} options.getContext - (targetId) => {name, url} for the
 *   link being edited, used to seed the search.
 */
export function init(options = {}) {
    if (typeof options.getContext === 'function') {
        getContext = options.getContext;
    }

    document.querySelectorAll('.icon-helper-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            open(btn.getAttribute('data-target') || 'siteIcon');
        });
    });

    const { closeBtn, search, customUrl, useCustomBtn, noneBtn } = els();

    if (closeBtn) closeBtn.addEventListener('click', close);

    // Escape closes the picker only — the modal below (edit) checks picker
    // visibility before reacting, so layers close one at a time. Backdrop
    // clicks deliberately do NOT close: an accidental click outside the
    // dialog was dismissing it and losing the search.
    document.addEventListener('keydown', (e) => {
        const { modal } = els();
        if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
            e.preventDefault();
            close();
        }
    });

    if (search) {
        search.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => runSearch(search.value), SEARCH_DEBOUNCE);
        });
    }

    if (customUrl) {
        customUrl.addEventListener('input', () => {
            clearTimeout(customDebounceTimer);
            customDebounceTimer = setTimeout(verifyCustomUrl, SEARCH_DEBOUNCE);
        });
    }

    if (useCustomBtn) {
        useCustomBtn.addEventListener('click', () => {
            const value = els().customUrl?.value.trim();
            const check = validateIconValue(value);
            // The button is only enabled after validation + a successful image
            // load, but re-check here so a stale enabled state can't save junk.
            if (check.valid && check.value !== 'default') choose(check.value);
        });
    }

    if (noneBtn) noneBtn.addEventListener('click', () => choose(''));
}

/**
 * Opens the picker for a given icon input and seeds the search from the
 * link's name and URL.
 * @param {string} targetId - 'siteIcon' or 'editSiteIcon'
 */
export function open(targetId = 'siteIcon') {
    currentTarget = targetId;
    const { modal, context, search } = els();
    if (!modal) return;

    const ctx = getContext(targetId) || {};
    const name = (ctx.name || '').trim();
    const url = (ctx.url || '').trim();

    if (context) {
        context.textContent = name && url ? `${name} — ${url}` : (name || url || '');
        context.style.display = context.textContent ? 'block' : 'none';
    }

    if (search) search.value = name;
    resetCustomSection();

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    if (search) search.focus();

    // Seed the first search from the link's name plus the hostname-derived
    // candidates the runtime matcher would try.
    runSearch(name, selfhstCandidateSlugs({ name, url }));
}

export function close() {
    const { modal } = els();
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
    searchGeneration++;
    customGeneration++;
    resetCustomSection();
}

function resetCustomSection() {
    const { customUrl, customPreview, useCustomBtn } = els();
    if (customUrl) customUrl.value = '';
    if (useCustomBtn) useCustomBtn.disabled = true;
    if (customPreview) {
        customPreview.hidden = true;
        const img = customPreview.querySelector('img');
        if (img) img.removeAttribute('src');
    }
    setCustomNote(DEFAULT_CUSTOM_NOTE);
}

/**
 * Builds the candidate slug list for a query: ranked substring matches from
 * the catalog index when it's available, otherwise the probe-only expansion
 * (exact slug + hyphenless variant + nickname aliases).
 * @param {string} query - Raw search text
 * @param {string[]} extraSeeds - Additional slugs to always try
 * @returns {Promise<{candidates: string[], hasIndex: boolean}>}
 */
async function collectCandidates(query, extraSeeds = []) {
    const aliases = expandQuery(query);
    const index = await getIconIndex();
    const candidates = index
        ? searchIndex(query, index, { limit: RESULT_LIMIT, aliases })
        : [...aliases];
    for (const seed of extraSeeds) {
        if (seed && !candidates.includes(seed)) candidates.push(seed);
    }
    return { candidates, index };
}

function noResultText(hasIndex) {
    return hasIndex
        ? 'No matching icon in the selfh.st library. Try another name, or paste an image URL below.'
        : 'No match. The icon catalog could not be loaded, so search needs the app\'s exact name (e.g. "vmware-esxi") — or paste an image URL below.';
}

/**
 * Searches the library for a query and renders only icons that actually
 * loaded from the CDN.
 * @param {string} query - Raw search text
 * @param {string[]} extraSeeds - Additional slugs to always try
 */
async function runSearch(query, extraSeeds = []) {
    const generation = ++searchGeneration;
    const { results } = els();
    if (!results) return;

    results.textContent = '';
    if (!expandQuery(query).length && !extraSeeds.length) {
        setStatus('Type an app or service name to search the icon library.');
        return;
    }

    setStatus('Searching the selfh.st icon library…');
    const { candidates, index } = await collectCandidates(query, extraSeeds);
    if (generation !== searchGeneration) return; // superseded by a newer search
    if (!candidates.length) {
        setStatus(noResultText(!!index));
        return;
    }

    // Display the theme recolor (-light on dark) when the catalog has one so
    // monochrome logos are visible in the grid; the BASE URL is what gets
    // stored — rendering re-applies the theme preference on each surface.
    const theme = document.body.classList.contains('light') ? 'light' : 'dark';
    const probes = await Promise.all(candidates.map(async (slug) => {
        const displaySlug = pickDisplaySlug(slug, index, theme);
        let url = await testImageLoad(selfhstIconUrl(displaySlug), PROBE_TIMEOUT);
        if (!url && displaySlug !== slug) {
            url = await testImageLoad(selfhstIconUrl(slug), PROBE_TIMEOUT);
        }
        return url ? { slug, url } : null;
    }));
    if (generation !== searchGeneration) return;

    const found = probes.filter(Boolean);
    results.textContent = '';
    found.forEach(({ slug, url }) => results.appendChild(buildResult(slug, url)));
    setStatus(found.length
        ? `${found.length} verified icon${found.length === 1 ? '' : 's'} found — click one to use it.`
        : noResultText(!!index));
    debug(`Icon picker: ${found.length}/${candidates.length} candidates verified for "${query}" (index: ${!!index})`);
}

function buildResult(slug, displayUrl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-result';
    btn.title = slug;

    const img = document.createElement('img');
    img.src = displayUrl; // just loaded in the probe, so this renders from cache
    img.alt = '';

    const label = document.createElement('span');
    label.className = 'icon-slug';
    label.textContent = slug;

    btn.appendChild(img);
    btn.appendChild(label);
    // Store the canonical base URL — theme recolors are applied at render.
    btn.addEventListener('click', () => choose(selfhstIconUrl(slug)));
    return btn;
}

/** Validates the pasted custom URL and enables Use only once it renders. */
async function verifyCustomUrl() {
    const { customUrl, customPreview, useCustomBtn } = els();
    if (!customUrl || !useCustomBtn) return;

    const generation = ++customGeneration;
    useCustomBtn.disabled = true;
    if (customPreview) customPreview.hidden = true;

    const raw = customUrl.value.trim();
    if (!raw) {
        setCustomNote(DEFAULT_CUSTOM_NOTE);
        return;
    }

    const check = validateIconValue(raw);
    if (!check.valid) {
        setCustomNote(check.reason, true);
        return;
    }
    if (check.value === 'default') {
        setCustomNote(DEFAULT_CUSTOM_NOTE);
        return;
    }

    setCustomNote('Checking that the image loads…');
    const loaded = await testImageLoad(check.value, PROBE_TIMEOUT);
    if (generation !== customGeneration) return;

    if (loaded) {
        if (customPreview) {
            const img = customPreview.querySelector('img');
            if (img) img.src = loaded;
            customPreview.hidden = false;
        }
        useCustomBtn.disabled = false;
        setCustomNote('Image verified — click Use.');
    } else {
        setCustomNote('That URL did not load an image, so it can\'t be used.', true);
    }
}

/** Writes the chosen (already verified) value into the target input. */
function choose(value) {
    const input = document.getElementById(currentTarget);
    if (input) {
        input.value = value;
        // Notify listeners (the live preview chip) of the programmatic change.
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    close();
}

// ---------------------------------------------------------------------------
// Live preview chip next to an icon input
// ---------------------------------------------------------------------------

/**
 * Attaches a live preview chip to an icon input: shows the image when the
 * value is valid and loads, an error state when it is invalid or dead, and
 * hides for empty/'default' (automatic icon).
 * @param {string} inputId - Icon input element id
 * @param {string} chipId - Chip element id (contains an <img>)
 */
export function attachPreview(inputId, chipId) {
    const input = document.getElementById(inputId);
    const chip = document.getElementById(chipId);
    if (!input || !chip) return;

    let generation = 0;
    let debounceTimer = null;

    const refresh = async () => {
        const gen = ++generation;
        const img = chip.querySelector('img');
        const value = input.value.trim();

        if (!value || value === 'default') {
            chip.hidden = true;
            chip.classList.remove('invalid');
            return;
        }

        const check = validateIconValue(value);
        if (!check.valid) {
            chip.hidden = false;
            chip.classList.add('invalid');
            if (img) img.removeAttribute('src');
            chip.title = check.reason || 'Invalid icon';
            return;
        }

        const loaded = await testImageLoad(check.value, PROBE_TIMEOUT);
        if (gen !== generation) return;
        if (loaded) {
            if (img) img.src = loaded;
            chip.hidden = false;
            chip.classList.remove('invalid');
            chip.title = 'Icon verified';
        } else {
            chip.hidden = false;
            chip.classList.add('invalid');
            if (img) img.removeAttribute('src');
            chip.title = 'This icon URL does not load an image';
        }
    };

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(refresh, SEARCH_DEBOUNCE);
    });

    // Hide the chip again when the surrounding form resets (e.g. after Add).
    if (input.form) {
        input.form.addEventListener('reset', () => setTimeout(refresh, 0));
    }
}
