// NOTE: After Security/Rendering refactor, these imports may be needed:
// - purifyHTML (from securityUtils.js) — for innerHTML sanitization
// - optimizedRender (from domOptimizer.js) — for unified rendering pipeline
// - preloadIcons, batchLoadIcons (from iconCache.js) — for icon preloading optimization
import { initErrorCapture } from '../features/errorCapture.js';
import { loadLinks, saveLinks, saveSettings } from '../core-systems/storageManager.js';
import { debounce } from '../features/utils.js';
import { getState, addStateChangeListener, safeUpdateState } from '../core-systems/stateManager.js';
import { getPerformanceMetrics, resetPerformanceMetrics, groupBy } from '../features/domOptimizer.js';
import { createCategorySection, renderNoResults } from '../core-systems/tileRenderer.js';
import { handleError, safeAsync, registerErrorHandler } from '../features/errorHandler.js';
import { loadIconWithCache, getCacheStats, resolveCachedIcons, refreshCachedIcon, generateInitials, setSelfhstMatchListener } from '../features/iconCache.js';
import { queueAutoIcon, hasAutomaticIcon } from '../features/autoIconSync.js';
import { syncStatusIndicator } from '../features/syncStatusIndicator.js';
import '../features/consoleCommands.js';
import { debug } from '../core-systems/debug.js';
import { validateLink } from '../features/securityUtils.js';
import { claimStorageFields } from '../core-systems/stateManager.js';
import { coerceSettings, parseStoredArray, backfillLinkIds, SETTING_DEFAULTS, MAX_CATEGORY_LENGTH } from '../core-systems/storageFormat.js';

// Register global error capture as early as possible (newtab context).
initErrorCapture('newtab');

// This page applies links/categories itself, through the same cleanup as the
// load (receiveStoredChange), never as raw stored values: every sync change
// and every reload after a manual sync or clear reaches it there.
claimStorageFields(['links', 'categories'], receiveStoredChange);

// State is managed exclusively through stateManager — no local state object.
// Use getState() for reads, safeUpdateState() for writes.

// Event listener tracking for proper cleanup
let eventListeners = [];

// Event listener management functions
function addTrackedEventListener(element, event, handler, options = false) {
    if (!element || !event || !handler) return;

    element.addEventListener(event, handler, options);
    eventListeners.push({ element, event, handler, options });
}

function removeTrackedEventListener(element, event, handler, options = false) {
    if (!element || !event || !handler) return;

    element.removeEventListener(event, handler, options);

    // Remove from tracking array
    eventListeners = eventListeners.filter(
        listener => !(listener.element === element &&
                     listener.event === event &&
                     listener.handler === handler)
    );
}

function cleanupAllEventListeners() {
    debug('Cleaning up event listeners:', eventListeners.length);

    // Remove all tracked listeners
    eventListeners.forEach(({ element, event, handler, options }) => {
        try {
            element.removeEventListener(event, handler, options);
        } catch (error) {
            console.warn('Error removing event listener:', error);
        }
    });

    // Clear the tracking array
    eventListeners = [];
}

// DOM Elements
let searchInput, searchSuggestions, linksContainer;

// links and categories exactly as stored, before any load-time salvage or
// quarantine. Drops apply their move to this copy and save it (persistDrop),
// so nothing the load cleaned up or hid for display is ever written back.
// Kept current by receiveStoredChange() so a drop never overwrites another
// device's edit or re-uploads one a sync discarded.
let storedLinks = [];
let storedCategories = [];

// Stored values that arrive while initializeState() is still loading; applied
// once it finishes (flushStoredChanges) so none is lost between read and render.
let storedDataLoaded = false;
let pendingStoredChange = null;

// Functions
async function initializeState() {
    try {
        const loadedState = await loadLinks();
        
        // Validate the loaded data before using it
        if (!loadedState || typeof loadedState !== 'object') {
            throw new Error('Invalid state data loaded from storage');
        }

        // Kept raw for persistDrop: cleanStoredData copies each link before
        // cleaning it, so these stay exactly as stored.
        storedLinks = Array.isArray(loadedState.links) ? [...loadedState.links] : [];
        storedCategories = Array.isArray(loadedState.categories) ? [...loadedState.categories] : [];

        // Each setting falls back to its own default when the stored value is
        // unknown (e.g. a colorTheme from before the accent presets), so one
        // stale value can't fail validation for the whole page.
        const { settings } = coerceSettings(loadedState);
        const { links, categories } = cleanStoredData(storedLinks, storedCategories);

        const cleanUpdates = {
            ...settings,
            links,
            categories,
            searchTerm: '',
            isDragging: false,
            draggedElement: null,
            draggedLink: null,
            draggedCategory: null,
            draggedIndex: null
        };

        // Apply state updates safely. skipPersistence is critical here: this is
        // a LOAD, not a user edit. On a fresh install the account's synced
        // storage may not have downloaded yet, so loadLinks() returns empty
        // app-defaults. Without skipPersistence, safeUpdateState would write
        // those empty defaults straight back to chrome.storage.sync and — via
        // sync's last-writer-wins — clobber the user's real links on every
        // device. Loading must only populate in-memory state, never echo to sync.
        const updateResult = await safeUpdateState(cleanUpdates, { validate: true, skipPersistence: true });

        if (!updateResult.success) {
            console.error('Failed to initialize state:', updateResult.error);
            // Log detailed information about the state that failed validation
            console.error('State that failed validation:', {
                links,
                categories,
                ...settings
            });

            // Links and categories were validated individually by
            // cleanStoredData, so this should be unreachable. If it happens
            // anyway, reset only the settings — never blank the links and
            // categories that passed (in-memory only — never persist a load).
            const fallbackResult = await safeUpdateState({
                ...SETTING_DEFAULTS,
                links,
                categories
            }, { validate: true, skipPersistence: true });

            if (!fallbackResult.success) {
                console.error('Critical: Fallback initialization also failed');
            }
        }

    } catch (error) {
        console.error('Critical error during state initialization:', error);
        // Log detailed information about the error
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        
        // Ultimate fallback (in-memory only — never persist a load).
        await safeUpdateState({
            theme: 'dark',
            colorTheme: 'default',
            view: 'grid',
            defaultTileSize: 'medium',
            links: []
        }, { validate: true, skipPersistence: true });
    }
}

/**
 * The new tab's display pipeline for stored links and categories: the salvage
 * and quarantine below, plus sanitizeLoadedCategories. Used for the initial
 * load and for every later stored value (receiveStoredChange), so the page never
 * renders — or validates — raw stored values. Pure: never persists, and never
 * mutates the stored arrays or their objects.
 * @param {*} links - stored links array (raw)
 * @param {*} categories - stored categories array (raw)
 * @returns {{links: Object[], categories: string[]}} what may be rendered
 */
function cleanStoredData(links, categories) {
    return {
        links: cleanStoredLinks(links),
        categories: sanitizeLoadedCategories(categories)
    };
}

const VALID_TILE_SIZES = ['compact', 'small', 'medium', 'large', 'square', 'wide', 'tall', 'giant', 'default'];
const MEANINGLESS_STRINGS = ['[object Object]', '[object Null]', '[object Undefined]'];

// Remove control characters, cap the length and trim.
function stripControlChars(text, maxLength) {
    return text
        // eslint-disable-next-line no-control-regex -- strip C0/DEL from user text
        .replace(/[\x00-\x1F\x7F]/g, '')
        .substring(0, maxLength)
        .trim();
}

function isParsableUrl(value) {
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
}

// A string salvaged from an object-valued field: the first non-empty string
// under one of keys, else a meaningful toString(); null when there is none.
function stringFromObject(obj, keys, onToStringError) {
    for (const key of keys) {
        if (obj[key] && typeof obj[key] === 'string') return obj[key];
    }
    if (typeof obj.toString !== 'function') return null;
    try {
        const stringified = obj.toString();
        if (stringified && typeof stringified === 'string' && !MEANINGLESS_STRINGS.includes(stringified.trim())) {
            return stringified;
        }
    } catch (e) {
        onToStringError(e);
    }
    return null;
}

// A usable name: the stored one, else the URL's hostname, else 'Unnamed Link'.
function cleanLinkName(link, index) {
    let name = link.name;
    if (!name || typeof name !== 'string') {
        let hostname = '';
        if (link.url && typeof link.url === 'string') {
            try {
                hostname = new URL(link.url).hostname;
            } catch {
                // fall through to the default
            }
        }
        name = hostname || 'Unnamed Link';
        console.warn(`Fixed missing/invalid name for link at index ${index}, set to: ${name}`);
    }
    name = stripControlChars(name, 100);
    if (!name) {
        name = 'Unnamed Link';
        console.warn(`Sanitized name was empty for link at index ${index}, set to: ${name}`);
    }
    return name;
}

function cleanLinkCategory(category, index) {
    if (!category || typeof category !== 'string') {
        category = 'Default';
        console.warn(`Fixed missing/invalid category for link at index ${index}, set to: ${category}`);
    }
    category = stripControlChars(category, 50);
    if (!category) {
        category = 'Default';
        console.warn(`Sanitized category was empty for link at index ${index}, set to: ${category}`);
    }
    return category;
}

// A parsable icon URL, or null (validation expects null rather than a missing key).
function cleanLinkIcon(icon, index) {
    if (icon === undefined || icon === null) return null;
    let candidate = null;
    if (typeof icon === 'string') {
        candidate = icon;
    } else if (typeof icon === 'object') {
        debug(`Found icon as object at index ${index}:`, icon);
        candidate = stringFromObject(icon, ['url', 'src', 'value', 'data'],
            e => console.warn(`Failed to convert icon object to string at index ${index}:`, e));
    }
    if (candidate && isParsableUrl(candidate)) return candidate;
    debug(`Removed invalid icon for link at index ${index}`);
    return null;
}

// A known tile size, or null (validation expects null rather than a missing key).
function cleanLinkSize(size, index) {
    if (size === undefined || size === null) return null;
    let candidate = null;
    if (typeof size === 'string') {
        candidate = size;
    } else if (typeof size === 'object') {
        debug(`Found size as object at index ${index}:`, size);
        candidate = stringFromObject(size, ['value', 'name', 'type'],
            e => debug(`Failed to convert size object to string at index ${index}:`, e));
    }
    if (candidate && VALID_TILE_SIZES.includes(candidate)) return candidate;
    debug(`Removed invalid size for link at index ${index}`);
    return null;
}

// A repaired copy of one stored link, or null when it can't be salvaged
// (not an object, or no parsable URL).
function cleanStoredLink(link, index) {
    if (!link || typeof link !== 'object') {
        console.warn(`Skipping invalid link at index ${index}: not an object`, link);
        return null;
    }

    const cleanLink = { ...link };
    cleanLink.name = cleanLinkName(cleanLink, index);

    if (!cleanLink.url || typeof cleanLink.url !== 'string') {
        console.warn(`Skipping link at index ${index}: missing or invalid URL`, cleanLink);
        return null;
    }
    if (!isParsableUrl(cleanLink.url)) {
        console.warn(`Skipping link at index ${index}: invalid URL format`, cleanLink.url);
        return null;
    }

    cleanLink.category = cleanLinkCategory(cleanLink.category, index);
    cleanLink.icon = cleanLinkIcon(cleanLink.icon, index);
    cleanLink.size = cleanLinkSize(cleanLink.size, index);

    if (!cleanLink.id) {
        cleanLink.id = `link_${Date.now()}_${index}`;
        debug(`Added missing ID for link at index ${index}: ${cleanLink.id}`);
    }
    return cleanLink;
}

/**
 * Salvage what can be repaired in each stored link (on a copy) and quarantine
 * the rest. See cleanStoredData.
 * @param {*} stored - stored links array (raw)
 * @returns {Object[]} links that pass validateLink
 */
function cleanStoredLinks(stored) {
    const loadedState = { links: Array.isArray(stored) ? stored : [] };
    try {
        // Enhanced cleanup and validation for corrupted link data
        if (Array.isArray(loadedState.links)) {
            debug(`Processing ${loadedState.links.length} links for cleanup and validation`);
            
            loadedState.links = loadedState.links
                .map(cleanStoredLink)
                .filter(link => link !== null); // Remove null links that couldn't be salvaged
            
            debug(`After cleanup: ${loadedState.links.length} valid links remaining`);

            // Quarantine links the salvage couldn't repair (e.g. an imported
            // data: icon over the 500-char limit): hide them from this render
            // instead of letting one bad link fail validation for all of them.
            // Storage is untouched — the manage page still lists them, and
            // drops save onto storedLinks (persistDrop), so they survive those.
            const quarantined = [];
            loadedState.links = loadedState.links.filter(link => {
                const result = validateLink(link);
                if (!result.valid) quarantined.push({ id: link.id, name: link.name, errors: result.errors });
                return result.valid;
            });
            if (quarantined.length > 0) {
                console.warn(`[The Codex] Hiding ${quarantined.length} stored link(s) that failed validation (storage untouched):`, quarantined);
            }
        }
        return loadedState.links;
    } catch (error) {
        console.error('Failed to clean stored links:', error);
        return [];
    }
}

/**
 * The name a stored category renders under: the salvage's link.category
 * cleanup (C0 controls and DEL stripped, like its /[\x00-\x1F\x7F]/g — spelled
 * without a control-character regex for no-control-regex — then cut to the
 * length cap and trimmed).
 * @param {string} name - stored category name
 * @returns {string}
 */
function renderedCategoryName(name) {
    return Array.from(name).filter(ch => {
        const code = ch.charCodeAt(0);
        return code > 0x1F && code !== 0x7F;
    }).join('').substring(0, MAX_CATEGORY_LENGTH).trim();
}

/**
 * Receive the stored links/categories values this page claimed
 * (claimStorageFields): each sync change, including the echo of this page's
 * own saves, and each reload after a manual sync or clear, where the cloud may
 * have won without any sync write. Returns the cleaned changes, which
 * stateManager applies in the same state update as any unclaimed fields (one
 * re-render). Values that arrive before the load finishes are buffered.
 * @param {{links?: *, categories?: *}} update - stored value per key
 *   (undefined = absent/removed)
 * @returns {Object|undefined} cleaned state changes
 */
function receiveStoredChange(update) {
    if (!storedDataLoaded) {
        pendingStoredChange = { ...pendingStoredChange, ...update };
        return undefined;
    }
    return cleanStoredChange(update);
}

/** Apply stored values buffered during the load; later ones arrive directly. */
function flushStoredChanges() {
    storedDataLoaded = true;
    if (!pendingStoredChange) return;
    const changes = cleanStoredChange(pendingStoredChange);
    pendingStoredChange = null;
    if (Object.keys(changes).length === 0) return;

    // In-memory only: this is someone's write arriving, never one to repeat.
    const result = safeUpdateState(changes, { validate: true, skipPersistence: true });
    if (!result.success) {
        console.error('[The Codex] Could not apply a storage change:', result.error);
    }
}

/**
 * Turn stored links/categories values into what this page may show
 * (cleanStoredData), refreshing the raw stored copy that drops save onto. A key
 * absent from storage (e.g. cleared) resets to empty, matching what a reload
 * would show. A value that no longer parses leaves what is on screen alone but
 * empties the stored copy, so a later drop finds nothing to move and writes
 * nothing — never resurrecting the old list.
 * @param {{links?: *, categories?: *}} update - stored value per key
 * @returns {Object} cleaned state changes (empty if nothing to show changed)
 */
function cleanStoredChange(update) {
    const changes = {};
    if ('links' in update) {
        const links = update.links === undefined ? [] : parseStoredArray(update.links);
        storedLinks = links ? backfillLinkIds(links) : [];
        if (links) changes.links = cleanStoredLinks(links);
    }
    if ('categories' in update) {
        const categories = update.categories === undefined ? [] : parseStoredArray(update.categories);
        storedCategories = categories ?? [];
        if (categories) changes.categories = sanitizeLoadedCategories(categories);
    }
    return changes;
}

/**
 * Index of a rendered link's entry in a stored links array: by id, then by
 * name + url. Stored arrays may hold non-object junk, which never matches.
 * @returns {number} index, or -1
 */
function findStoredLinkIndex(list, link) {
    if (!link) return -1;
    const isLink = (s) => s !== null && typeof s === 'object';
    if (link.id != null && link.id !== '') {
        const byId = list.findIndex(s => isLink(s) && s.id === link.id);
        if (byId !== -1) return byId;
    }
    return list.findIndex(s => isLink(s) && s.name === link.name && s.url === link.url);
}

/**
 * The stored category name behind a rendered one: an exact match first, then
 * a name that renders under it (an over-long name truncated for display). If
 * two long names share the rendered prefix, the first stored one wins.
 * @param {string} renderedName - category as rendered (tile/grid data-category)
 * @returns {string}
 */
function storedCategoryName(renderedName) {
    const candidates = [...storedCategories, ...storedLinks.map(l => l?.category)]
        .filter(c => typeof c === 'string');
    return candidates.find(c => c === renderedName)
        ?? candidates.find(c => renderedCategoryName(c) === renderedName)
        ?? renderedName;
}

/**
 * Persist a drop. The handlers compute the new order over the rendered links,
 * which load-time salvage may have cleaned and quarantine may have thinned;
 * this maps that one move onto the stored array instead, so every other
 * stored entry — hidden links, original category names, junk entries — is
 * written back exactly as stored. saveLinks is the only writer. Writes (and
 * shows) nothing if the moved link isn't in storage.
 * @param {Object[]} newLinks - rendered links in their new order
 * @param {Object} movedLink - the rendered link as it was before the move
 * @param {Object} updatedLink - the moved link as placed in newLinks
 */
async function persistDrop(newLinks, movedLink, updatedLink) {
    try {
        const full = [...storedLinks];
        const from = findStoredLinkIndex(full, movedLink);
        if (from === -1) {
            console.warn('[The Codex] Moved link not found in storage; not saving this move.', movedLink);
            return;
        }
        const [stored] = full.splice(from, 1);
        // A reorder within a category keeps the stored category untouched
        // (even a missing one that only renders as 'Default').
        const moved = movedLink.category === updatedLink.category
            ? stored
            : { ...stored, category: storedCategoryName(updatedLink.category) };

        // Place it before the stored entry of its new rendered successor, so
        // the visible order matches newLinks; hidden entries keep their slots.
        const successor = newLinks[newLinks.indexOf(updatedLink) + 1];
        const to = successor ? findStoredLinkIndex(full, successor) : -1;
        full.splice(to === -1 ? full.length : to, 0, moved);

        const result = safeUpdateState({ links: newLinks }, { validate: true, skipPersistence: true });
        if (!result.success) {
            console.warn('[The Codex] Not saving a drop that failed validation:', result.error);
            return;
        }
        renderLinks();

        // saveLinks refuses (returns false) e.g. over the sync item quota;
        // then the copy must keep matching what is actually stored.
        if (await saveLinks(full)) {
            storedLinks = full;
        }
    } catch (error) {
        console.error('Failed to save dropped link:', error);
    }
}

/**
 * Sanitize the stored category order for rendering. Each name gets the same
 * cleanup the load salvage applies to link.category (control characters
 * stripped, cut to the length cap, trimmed), so an over-long name keeps its
 * place under the same truncated name its links now carry. Non-strings and
 * names left empty are dropped. In-memory only: the stored list is untouched.
 * @param {*} stored - categories as returned by loadLinks()
 * @returns {string[]} unique valid names, always including 'Default'
 */
function sanitizeLoadedCategories(stored) {
    const list = Array.isArray(stored) ? stored : [];
    const categories = [];
    const adjusted = [];
    list.forEach(raw => {
        const name = typeof raw === 'string' ? renderedCategoryName(raw) : '';
        if (name !== raw) adjusted.push(raw);
        if (name && !categories.includes(name)) categories.push(name);
    });
    if (!categories.includes('Default')) categories.unshift('Default');
    if (adjusted.length > 0) {
        console.warn(`[The Codex] Truncated or skipped ${adjusted.length} stored category name(s) that failed validation (storage untouched):`, adjusted);
    }
    return categories;
}

// The longest the first paint waits for this device's stored icons; past it,
// tiles show and their icons load right after, as they always did.
const CACHED_ICON_WAIT_MS = 300;
// Icons resolved at once after the first paint (network politeness).
const ICON_LOAD_CONCURRENCY = 6;

// A logo matched by name is saved to its link, so every device shows it
// without matching again (autoIconSync.js).
setSelfhstMatchListener(queueAutoIcon);

// Bumped by every render. A render waits for the stored-icon lookup, so it
// checks this afterwards and gives way to a newer one: an older view must
// never replace a newer one.
let renderSequence = 0;

/**
 * This device's icons for `links` (resolveCachedIcons), within CACHED_ICON_WAIT_MS.
 * @param {Object[]} links
 * @returns {Promise<Map<Object, {src: string, fresh: boolean}>>} empty past the wait
 */
function cachedIconsForFirstPaint(links) {
    const lookup = resolveCachedIcons(links).catch(error => {
        debug('Stored icon lookup failed; icons will load after the first paint:', error);
        return new Map();
    });
    const giveUp = new Promise(resolve => setTimeout(() => resolve(new Map()), CACHED_ICON_WAIT_MS));
    return Promise.race([lookup, giveUp]);
}

async function renderLinksTraditional() {
    const renderId = ++renderSequence;
    const currentState = getState();
    // Build the whole view off-DOM and swap it in only once it is complete:
    // a throw part-way must leave the last good view, not a cleared page.
    const fragment = document.createDocumentFragment();
    let filteredLinks;
    let iconSources = new Map();
    try {
        filteredLinks = currentState.links.filter(link =>
            link.name.toLowerCase().includes(currentState.searchTerm.toLowerCase()) ||
            link.url.toLowerCase().includes(currentState.searchTerm.toLowerCase())
        );
        const groupedLinks = groupBy(filteredLinks, 'category');

        // Sort categories by stored order, with any new categories at the end
        const sortedCategories = Object.keys(groupedLinks).sort((a, b) => {
            const indexA = currentState.categories.indexOf(a);
            const indexB = currentState.categories.indexOf(b);
            // Categories not in the order array go to the end
            if (indexA === -1 && indexB === -1) return 0;
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
        });

        // Icons this device already has go into the first paint, so tiles
        // don't appear empty and fill in afterwards.
        iconSources = await cachedIconsForFirstPaint(filteredLinks);
        if (renderId !== renderSequence) return;

        sortedCategories.forEach(category => {
            const links = groupedLinks[category];
            const section = createCategorySection(category, links, {
                defaultTileSize: currentState.defaultTileSize,
                view: currentState.view,
                lazyIcons: true,
                iconSources
            });
            fragment.appendChild(section);
        });

        if (filteredLinks.length === 0) {
            renderNoResults(fragment);
        }
    } catch (error) {
        console.error('[The Codex] Rendering links failed; keeping the previous view:', error);
        return;
    }

    linksContainer.replaceChildren(fragment);

    // Load the icons the first paint didn't have (and upkeep the ones it did)
    loadIconsWithCaching(filteredLinks, iconSources);

    // Set up error handling for failed icon loads
    setupIconErrorHandling();

    // Set up drag and drop
    setupDragAndDrop();
}

function setupIconErrorHandling() {
    // Clean up existing icon event listeners first
    const iconImages = document.querySelectorAll('.tile-icon');

    iconImages.forEach(img => {
        const errorHandler = function() {
            // Hide the failed image and show the placeholder
            this.style.display = 'none';
            const placeholder = this.nextElementSibling;
            if (placeholder && placeholder.classList.contains('tile-placeholder')) {
                placeholder.style.display = 'flex';
            }
        };

        const loadHandler = function() {
            // Hide the placeholder if image loads successfully
            const placeholder = this.nextElementSibling;
            if (placeholder && placeholder.classList.contains('tile-placeholder')) {
                placeholder.style.display = 'none';
            }
        };

        addTrackedEventListener(img, 'error', errorHandler);
        addTrackedEventListener(img, 'load', loadHandler);
    });
}

// Drag and Drop functionality
function setupDragAndDrop() {
    // Clean up existing drag and drop listeners first
    cleanupDragAndDrop();

    const tiles = document.querySelectorAll('.link-tile');
    const grids = document.querySelectorAll('.links-grid');

    // Add drag events to tiles
    tiles.forEach(tile => {
        addTrackedEventListener(tile, 'dragstart', handleDragStart);
        addTrackedEventListener(tile, 'dragover', handleDragOver);
        addTrackedEventListener(tile, 'drop', handleDrop);
        addTrackedEventListener(tile, 'dragend', handleDragEnd);
        addTrackedEventListener(tile, 'dragenter', handleDragEnter);
        addTrackedEventListener(tile, 'dragleave', handleDragLeave);
    });

    // Add drop zones to category grids
    grids.forEach(grid => {
        addTrackedEventListener(grid, 'dragover', handleGridDragOver);
        addTrackedEventListener(grid, 'drop', handleGridDrop);
        addTrackedEventListener(grid, 'dragenter', handleGridDragEnter);
        addTrackedEventListener(grid, 'dragleave', handleGridDragLeave);
    });
}

function cleanupDragAndDrop() {
    // Remove specific drag and drop listeners
    const dragEvents = ['dragstart', 'dragover', 'drop', 'dragend', 'dragenter', 'dragleave'];
    const tiles = document.querySelectorAll('.link-tile');
    const grids = document.querySelectorAll('.links-grid');

    // Remove listeners from tiles
    tiles.forEach(tile => {
        dragEvents.forEach(event => {
            // Find and remove specific drag event listeners
            const listenersToRemove = eventListeners.filter(
                listener => listener.element === tile && listener.event === event
            );

            listenersToRemove.forEach(listener => {
                removeTrackedEventListener(listener.element, listener.event, listener.handler);
            });
        });
    });

    // Remove listeners from grids
    grids.forEach(grid => {
        dragEvents.forEach(event => {
            const listenersToRemove = eventListeners.filter(
                listener => listener.element === grid && listener.event === event
            );

            listenersToRemove.forEach(listener => {
                removeTrackedEventListener(listener.element, listener.event, listener.handler);
            });
        });
    });
}

function handleDragStart(e) {
    const dragState = {
        isDragging: true,
        draggedElement: this,
        draggedCategory: this.dataset.category,
        draggedIndex: parseInt(this.dataset.linkIndex)
    };

    // Find the link in the state
    const currentState = getState();
    const categoryLinks = currentState.links.filter(link => link.category === dragState.draggedCategory);
    dragState.draggedLink = categoryLinks[dragState.draggedIndex];

    // Update state safely
    safeUpdateState(dragState, { validate: false }); // Skip validation for internal state

    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDragEnter(e) {
    const currentState = getState();
    if (this !== currentState.draggedElement) {
        this.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

function handleDrop(e) {
    // Don't handle tile drops if we're dropping on a grid
    if (e.target.classList.contains('links-grid') || e.target.closest('.links-grid.grid-drag-over')) {
        return;
    }

    if (e.stopPropagation) {
        e.stopPropagation();
    }

    const currentState = getState();
    if (currentState.draggedElement !== this) {
        const dropCategory = this.dataset.category;
        const dropIndex = parseInt(this.dataset.linkIndex);

        // Insert at the drop tile's position in the global links array
        moveDraggedLink(currentState, dropCategory,
            () => findGlobalIndexForCategoryPosition(dropCategory, dropIndex));
    }

    return false;
}

function handleDragEnd(e) {
    safeUpdateState({
        isDragging: false,
        draggedElement: null,
        draggedLink: null,
        draggedCategory: null,
        draggedIndex: null
    }, { validate: false });

    // Remove all drag-related classes
    const tiles = document.querySelectorAll('.link-tile');
    tiles.forEach(tile => {
        tile.classList.remove('dragging', 'drag-over');
    });

    // Remove grid drag classes
    const grids = document.querySelectorAll('.links-grid');
    grids.forEach(grid => {
        grid.classList.remove('grid-drag-over');
    });
}

// Render links function that calls the traditional rendering
function renderLinks() {
    // Not awaited by callers (state listeners, drops): never let a failure
    // become an unhandled rejection.
    renderLinksTraditional().catch(error => console.error('[The Codex] Rendering links failed:', error));
}

// Grid drop handlers for category-level drops
function handleGridDragOver(e) {
    // Only handle if we're not over a tile
    if (!e.target.classList.contains('link-tile') &&
        !e.target.closest('.link-tile')) {
        if (e.preventDefault) {
            e.preventDefault();
        }
        e.dataTransfer.dropEffect = 'move';
        return false;
    }
}

function handleGridDragEnter(e) {
    // Only activate grid drop zone if we're not hovering over a tile
    const currentState = getState();
    const draggedEl = currentState.draggedElement;
    const isDraggingOverGrid = draggedEl && draggedEl instanceof Element && draggedEl.closest('.links-grid');

    if (currentState.isDragging &&
        this !== isDraggingOverGrid &&
        !e.target.classList.contains('link-tile') &&
        !e.target.closest('.link-tile')) {
        this.classList.add('grid-drag-over');
    }
}

function handleGridDragLeave(e) {
    // Only remove if we're actually leaving the grid (not entering a child)
    if (!this.contains(e.relatedTarget)) {
        this.classList.remove('grid-drag-over');
    }
}

// Index of the dragged link in state.links: by reference first, then by
// name and url (reference equality fails due to deep cloning in getState).
// -1 when it isn't there.
function findDraggedLinkIndex(currentState) {
    const byReference = currentState.links.findIndex(link => link === currentState.draggedLink);
    if (byReference !== -1) return byReference;
    return currentState.links.findIndex(link =>
        link.name === currentState.draggedLink?.name &&
        link.url === currentState.draggedLink?.url
    );
}

// Move the dragged link into dropCategory: remove it from its position, set
// its category, and insert it at insertIndexFor(linksWithoutIt). Then update
// state, re-render, and save the move onto stored links. No-op when the
// dragged link isn't in state.links.
function moveDraggedLink(currentState, dropCategory, insertIndexFor) {
    const finalIndex = findDraggedLinkIndex(currentState);
    if (finalIndex === -1) return;

    const newLinks = [...currentState.links];
    const [removedLink] = newLinks.splice(finalIndex, 1);
    const updatedLink = { ...removedLink, category: dropCategory };
    newLinks.splice(insertIndexFor(newLinks), 0, updatedLink);
    persistDrop(newLinks, removedLink, updatedLink);
}

function handleGridDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    const currentState = getState();
    if (currentState.isDragging && currentState.draggedLink) {
        const dropCategory = this.dataset.category;

        // Insert at the end of the target category
        moveDraggedLink(currentState, dropCategory, newLinks => {
            let insertIndex = newLinks.length;
            for (let i = newLinks.length - 1; i >= 0; i--) {
                if (newLinks[i].category === dropCategory) {
                    insertIndex = i + 1;
                    break;
                }
            }
            return insertIndex;
        });
    }

    // Remove drag classes
    this.classList.remove('grid-drag-over');

    return false;
}

// Helper function to convert category-relative position to global array index
function findGlobalIndexForCategoryPosition(targetCategory, categoryIndex) {
    const currentState = getState();
    let globalIndex = 0;
    let currentCategoryIndex = 0;

    // Iterate through the global links array
    for (let i = 0; i < currentState.links.length; i++) {
        const link = currentState.links[i];

        if (link.category === targetCategory) {
            // Found a link in our target category
            if (currentCategoryIndex === categoryIndex) {
                // This is the exact position we want
                return i;
            }
            currentCategoryIndex++;
        }

        // If we haven't found the position yet, the next insertion point
        // would be after this link
        globalIndex = i + 1;
    }

    // If we didn't find the exact position, insert at the end
    // This handles cases where categoryIndex >= number of links in category
    return globalIndex;
}

// Tile Styling
function getTileClasses(link) {
    const currentState = getState();
    return `class="link-tile ${link.size ? `size-${link.size}` : `size-${currentState.defaultTileSize}`}"`;
}

function getIconUrl(link) {
    // If custom icon URL is provided, use it
    if (link.icon && link.icon.trim()) {
        return link.icon;
    }

    // Use tile title for icon search - more relevant than domain
    const currentState = getState();
    if (link.name && link.name.trim()) {
        // Clean the title for use as an icon identifier
        const iconName = cleanTitleForIcon(link.name);
        if (iconName) {
            return `https://cdn.jsdelivr.net/gh/selfhst/icons/svg/${iconName}.svg`;
        }
    }

    return null;
}

function cleanTitleForIcon(title) {
    if (!title || !title.trim()) {
        return null;
    }

    // Convert title to lowercase and clean it for icon filename
    return title.toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters except hyphens and spaces
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/--+/g, '-') // Replace multiple hyphens with single hyphen
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

function toggleTheme() {
    const currentState = getState();
    const newTheme = currentState.theme === 'dark' ? 'light' : 'dark';

    safeUpdateState({ theme: newTheme }, { validate: true });
    applyTheme();
    saveSettings({ theme: newTheme });
}

function applyTheme() {
    const currentState = getState();

    // Base theme is dark/light; the accent recolors the single accent var.
    const theme = currentState.theme === 'light' ? 'light' : 'dark';
    document.body.className = theme;
    document.body.setAttribute('data-theme', theme);
    applyAccent(currentState.colorTheme);
    debug('Applied theme class:', theme);
}

// Accent presets live in base.css as body[data-accent="…"]; 'slate' is the
// default (no attribute). Legacy 'default' maps to slate.
function applyAccent(accent) {
    const valid = ['slate', 'blue', 'teal', 'violet', 'amber'];
    const a = valid.includes(accent) ? accent : 'slate';
    if (a === 'slate') document.body.removeAttribute('data-accent');
    else document.body.setAttribute('data-accent', a);
}

function toggleView() {
    const currentState = getState();
    const newView = currentState.view === 'grid' ? 'list' : 'grid';

    safeUpdateState({ view: newView }, { validate: true });
    applyView();
    saveSettings({ view: newView });
}

function applyView() {
    const currentState = getState();
    const grids = document.querySelectorAll('.links-grid');
    grids.forEach(grid => {
        grid.classList.toggle('list-view', currentState.view === 'list');
    });
}


function updateSearchSuggestions() {
    if (!searchSuggestions) return;
    const currentState = getState();
    searchSuggestions.innerHTML = '';
    currentState.links.forEach(link => {
        const option = document.createElement('option');
        option.value = link.name;
        searchSuggestions.appendChild(option);
    });
}

// Initialize DOM elements
function initializeDOMElements() {
    searchInput = document.getElementById('searchInput');
    searchSuggestions = document.getElementById('searchSuggestions');
    linksContainer = document.getElementById('linksContainer');

    debug('DOM Elements:', { searchInput, searchSuggestions, linksContainer });

    if (!searchInput) console.warn('Search input not found');
    if (!searchSuggestions) console.warn('Search suggestions datalist not found');
    if (!linksContainer) console.warn('Links container not found');
}

// Event Listeners
function setupEventListeners() {
    if (searchInput) {
        searchInput.addEventListener('input', debounce(function(event) {
            if (event && event.target) {
                safeUpdateState({ searchTerm: event.target.value }, { validate: false });
                renderLinks();
            } else {
                console.error('Invalid event object:', event);
            }
        }, 300));
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== searchInput) {
            e.preventDefault();
            searchInput?.focus();
        }
    });
}

/**
 * Shows fallback UI when initialization fails
 */
function showFallbackUI() {
    const container = document.querySelector('.app-container');
    if (container) {
        container.textContent = '';
        const fallback = document.createElement('div');
        fallback.className = 'error-fallback';
        const h2 = document.createElement('h2');
        h2.textContent = 'Application Error';
        const p1 = document.createElement('p');
        p1.textContent = 'The application failed to initialize properly.';
        const btn = document.createElement('button');
        btn.textContent = 'Reload Application';
        btn.addEventListener('click', () => location.reload());
        const p2 = document.createElement('p');
        const small = document.createElement('small');
        small.textContent = 'If the problem persists, please check the console for error details.';
        p2.appendChild(small);
        fallback.append(h2, p1, btn, p2);
        container.appendChild(fallback);
    }
}

// Register specific error handlers
registerErrorHandler('storage', 'initialization', async (error, context) => {
    console.warn('Storage initialization error:', error);
    return {
        success: true,
        message: 'Storage error handled, using local fallback'
    };
});

registerErrorHandler('network', 'sync', async (error, context) => {
    console.warn('Sync network error:', error);
    return {
        success: true,
        message: 'Sync will resume when connection is restored'
    };
});

registerErrorHandler('validation', 'user_input', async (error, context) => {
    console.warn('User input validation error:', error);
    return {
        success: true,
        message: 'Please check your input and try again'
    };
});

// Initialize the application with comprehensive error handling
const init = safeAsync(async function init() {
    debug('Initializing application...');

    // Reset performance metrics
    resetPerformanceMetrics();

    const startTime = performance.now();
    try {
        initializeDOMElements();
        await initializeState();
        flushStoredChanges();
        applyTheme();  // Apply theme from saved state
        setupEventListeners();
        
        // Render links after state is initialized
        debug('Rendering links after initialization...');
        renderLinks();

        // Add state change listener for automatic re-rendering
        addStateChangeListener((changeInfo) => {
            debug('State changed:', changeInfo);

            // Only re-render if relevant properties changed
            const relevantChanges = ['links', 'theme', 'colorTheme', 'view', 'searchTerm', 'defaultTileSize', 'categories'];
            const hasRelevantChange = Object.keys(changeInfo.changes).some(key =>
                relevantChanges.includes(key)
            );

            if (hasRelevantChange) {
                debug('Re-rendering due to state change');
                renderLinks();
            }
        });

        // Initialize sync status indicator
        syncStatusIndicator.init('sync-status-container');

        const initTime = performance.now() - startTime;
        debug(`Application initialized in ${initTime.toFixed(2)}ms`);

        // Log performance metrics
        const metrics = getPerformanceMetrics();
        debug('Performance metrics:', metrics);

    } catch (error) {
        console.error('Initialization failed:', error);

        // Handle initialization errors specifically
        await handleError(error, {
            context: 'initialization',
            showUserNotification: true,
            allowRecovery: true
        });

        // Show fallback UI
        showFallbackUI();
    }
}, {
    context: 'application_initialization',
    fallbackValue: null,
    retryAttempts: 1,
    retryDelay: 1000
});

// Start the application when the DOM is fully loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    debug('Cleaning up before page unload...');
    cleanupAllEventListeners();
});

// Handle visibility change (tab switching) for cleanup
let wasHidden = false;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        wasHidden = true;
        debug('Page hidden - performing light cleanup');
        // Could perform lighter cleanup here if needed
    } else if (wasHidden) {
        wasHidden = false;
        debug('Page visible again');
        // Could re-initialize certain components if needed
    }
});

// Log any unhandled errors
window.addEventListener('error', function(event) {
    console.error('Unhandled error:', event.error);
});

/**
 * Loads each tile's icon after the first paint. Tiles the first paint already
 * gave a stored icon only get background upkeep (or, once their remembered
 * match is a week old, a fresh match that replaces the icon if it changed);
 * the rest resolve through loadIconWithCache, ICON_LOAD_CONCURRENCY at a time.
 * @param {Array} links - Array of link objects
 * @param {Map<Object, {src: string, fresh: boolean}>} [cachedIcons] - what the
 *   first paint showed, per link (resolveCachedIcons)
 */
async function loadIconsWithCaching(links, cachedIcons = new Map()) {
    if (!links || links.length === 0) return;

    try {
        debug(`Loading icons for ${links.length} links...`);
        const startTime = performance.now();

        // Map link ID to its icon element
        const iconMap = new Map();
        document.querySelectorAll('.tile-icon[data-link-id]').forEach(element => {
            const linkId = element.dataset.linkId;
            if (linkId) {
                iconMap.set(linkId, element);
            }
        });

        const queue = links.filter(link => iconMap.has(link.id));
        const worker = async () => {
            while (queue.length > 0) {
                const link = queue.shift();
                await loadTileIcon(link, iconMap.get(link.id), cachedIcons.get(link));
            }
        };
        await Promise.all(Array.from({ length: Math.min(ICON_LOAD_CONCURRENCY, queue.length) }, worker));

        const endTime = performance.now();
        debug(`Icon loading completed in ${(endTime - startTime).toFixed(2)}ms`);

        // Log cache statistics
        const cacheStats = getCacheStats();
        debug('Icon cache stats:', cacheStats);

    } catch (error) {
        console.error('Error in icon loading process:', error);
    }
}

/**
 * Show a tile's initials placeholder instead of its icon.
 * @param {HTMLImageElement} iconElement
 * @param {Object} link
 */
function showIconPlaceholder(iconElement, link) {
    iconElement.style.display = 'none';
    const placeholder = iconElement.nextElementSibling;
    if (placeholder && placeholder.classList.contains('tile-placeholder')) {
        placeholder.style.display = 'flex';
        placeholder.textContent = generateInitials(link.name);
    }
}

/**
 * A first-paint icon that is a network URL (a remembered favicon) may fail
 * to load — offline, or not in the HTTP cache. Watch it outside the load
 * queue (a lazy <img> below the fold may not load until scrolled to) and, if
 * it fails, match the tile afresh, down to initials.
 * @param {Object} link
 * @param {HTMLImageElement} iconElement
 */
function watchNetworkIcon(link, iconElement) {
    const fallBack = () => loadTileIcon(link, iconElement, undefined);
    if (iconElement.complete) {
        if (iconElement.naturalWidth === 0) fallBack();
        return;
    }
    iconElement.addEventListener('error', fallBack, { once: true });
}

/**
 * A logo the first paint took from this device's remembered matches (made
 * before matches were saved to the link): save it to the link now.
 * @param {Object} link
 * @param {{storedUrl: string|null}|undefined} cached - from resolveCachedIcons
 */
function saveRememberedMatch(link, cached) {
    if (cached?.storedUrl && hasAutomaticIcon(link)) queueAutoIcon(link, cached.storedUrl);
}

/**
 * Resolve one tile's icon (see loadIconsWithCaching).
 * @param {Object} link
 * @param {HTMLImageElement} iconElement
 * @param {{src: string, fresh: boolean, network: boolean}|undefined} cached - shown by the first paint
 */
async function loadTileIcon(link, iconElement, cached) {
    try {
        saveRememberedMatch(link, cached);
        if (cached?.fresh) {
            if (cached.network) watchNetworkIcon(link, iconElement);
            else await refreshCachedIcon(cached);
            return;
        }

        const iconUrl = await loadIconWithCache(link, {
            preferCustom: true,
            allowFavicon: true,
            allowGenerated: true,
            timeout: 3000,
            respectCSP: true
        });

        if (iconUrl) {
            if (iconElement.getAttribute('src') !== iconUrl) iconElement.src = iconUrl;
            iconElement.style.display = 'block';
            const placeholder = iconElement.nextElementSibling;
            if (placeholder && placeholder.classList.contains('tile-placeholder')) {
                placeholder.style.display = 'none';
            }
        } else if (!cached) {
            showIconPlaceholder(iconElement, link);
        }
    } catch (error) {
        console.warn(`Failed to load icon for ${link.name}:`, error);
        if (!cached) showIconPlaceholder(iconElement, link);
    }
}
