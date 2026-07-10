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
import { debug } from '../core-systems/debug.js';

const PROBE_TIMEOUT = 4000;
const SEARCH_DEBOUNCE = 350;
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

    const { modal, closeBtn, search, customUrl, useCustomBtn, noneBtn } = els();

    if (closeBtn) closeBtn.addEventListener('click', close);
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
    }

    if (search) {
        search.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => runSearch(expandQuery(search.value)), SEARCH_DEBOUNCE);
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

    // Seed with everything we can derive: the name-as-typed plus the
    // hostname-derived candidates the runtime matcher would try.
    const seeds = expandQuery(name);
    selfhstCandidateSlugs({ name, url }).forEach(slug => {
        if (!seeds.includes(slug)) seeds.push(slug);
    });
    runSearch(seeds);
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
 * Probes candidate slugs against the selfh.st library and renders only the
 * icons that actually loaded.
 * @param {string[]} slugs - Candidate slugs
 */
async function runSearch(slugs) {
    const generation = ++searchGeneration;
    const { results } = els();
    if (!results) return;

    results.textContent = '';
    if (!slugs.length) {
        setStatus('Type an app or service name to search the icon library.');
        return;
    }

    setStatus('Searching the selfh.st icon library…');
    const probes = await Promise.all(slugs.map(slug =>
        testImageLoad(selfhstIconUrl(slug), PROBE_TIMEOUT)
            .then(url => (url ? { slug, url } : null))
    ));
    if (generation !== searchGeneration) return; // superseded by a newer search

    const found = probes.filter(Boolean);
    results.textContent = '';
    found.forEach(({ slug, url }) => results.appendChild(buildResult(slug, url)));
    setStatus(found.length
        ? `${found.length} verified icon${found.length === 1 ? '' : 's'} found — click one to use it.`
        : 'No match in the icon library. Try the app\'s official name, or paste an image URL below.');
    debug(`Icon picker: ${found.length}/${slugs.length} candidates verified for [${slugs.join(', ')}]`);
}

function buildResult(slug, url) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-result';
    btn.title = slug;

    const img = document.createElement('img');
    img.src = url; // just loaded in the probe, so this renders from cache
    img.alt = '';

    const label = document.createElement('span');
    label.className = 'icon-slug';
    label.textContent = slug;

    btn.appendChild(img);
    btn.appendChild(label);
    btn.addEventListener('click', () => choose(url));
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
