/**
 * Shared Tile Renderer Module
 * Single source of truth for tile creation across newtab and manage pages.
 * Both script.js and domOptimizer.js import from this module.
 *
 * Implements cavekit-rendering.md R1 (Single Rendering Pipeline).
 */

import { sanitizeHTML, validateAndSanitizeUrl } from '../features/utils.js';

/**
 * Get the display URL for a link's icon.
 * @param {object} link - Link object with optional icon property
 * @returns {string} Icon URL or empty string
 */
export function getIconUrl(link) {
    if (link.icon && link.icon.trim() && link.icon !== 'default') {
        return link.icon;
    }
    return '';
}

/**
 * Build the CSS class string for a tile based on its size.
 * @param {object} link - Link object
 * @param {string} defaultTileSize - Default tile size from state
 * @returns {string} CSS class string (e.g., 'link-tile size-medium')
 */
export function getTileClasses(link, defaultTileSize = 'medium') {
    const size = link.size || defaultTileSize;
    return `link-tile size-${size}`;
}

/**
 * Determine if a tile should use horizontal layout.
 * @param {object} link - Link object
 * @param {string} defaultTileSize - Default tile size from state
 * @returns {boolean}
 */
export function isHorizontalLayout(link, defaultTileSize = 'medium') {
    const size = link.size || defaultTileSize;
    return size === 'wide' || size === 'compact';
}

/**
 * Create a single tile DOM element for a link.
 * This is the canonical tile creation function used by both pages.
 *
 * @param {object} link - Link object {id, name, url, category, icon, size}
 * @param {object} options - Rendering options
 * @param {number} options.index - Link index within its category
 * @param {string} options.category - Category name
 * @param {string} options.defaultTileSize - Default tile size
 * @param {boolean} [options.lazyIcons=true] - Use data attributes for lazy icon loading
 * @returns {HTMLAnchorElement} The tile element
 */
export function createTile(link, options = {}) {
    const { index = 0, category = '', defaultTileSize = 'medium', lazyIcons = true } = options;
    const size = link.size || defaultTileSize || 'medium';
    const horizontal = isHorizontalLayout(link, defaultTileSize);
    const iconUrl = getIconUrl(link);

    const tile = document.createElement('a');
    tile.href = validateAndSanitizeUrl(link.url);
    tile.className = getTileClasses(link, defaultTileSize);
    tile.target = '_blank';
    tile.draggable = true;
    tile.dataset.linkIndex = index;
    tile.dataset.category = category;

    // Build tile content using DOM API for structure, sanitized text content
    const content = document.createElement('div');
    content.className = `tile-content${horizontal ? ' horizontal' : ''}`;

    const img = document.createElement('img');
    img.className = 'tile-icon';
    img.alt = '';
    img.loading = 'lazy';
    if (lazyIcons) {
        img.src = '';
        img.dataset.iconUrl = sanitizeHTML(iconUrl);
        img.dataset.linkId = link.id || '';
    } else {
        img.src = iconUrl ? sanitizeHTML(iconUrl) : '';
    }
    content.appendChild(img);

    const placeholder = document.createElement('div');
    placeholder.className = 'tile-placeholder';
    placeholder.style.display = iconUrl ? 'none' : '';
    content.appendChild(placeholder);

    const title = document.createElement('h3');
    title.textContent = link.name;
    content.appendChild(title);

    tile.appendChild(content);
    return tile;
}

/**
 * Create a category section with header and tile grid.
 * @param {string} categoryName - Category name
 * @param {object[]} links - Array of link objects in this category
 * @param {object} options - Rendering options
 * @param {string} options.defaultTileSize - Default tile size
 * @param {string} options.view - 'grid' or 'list'
 * @param {boolean} [options.lazyIcons=true] - Lazy load icons
 * @returns {HTMLElement} The category section element
 */
export function createCategorySection(categoryName, links, options = {}) {
    const { defaultTileSize = 'medium', view = 'grid', lazyIcons = true } = options;

    const section = document.createElement('section');
    section.className = 'category-section fade-in';

    const heading = document.createElement('h2');
    heading.textContent = categoryName;
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = `links-grid${view === 'list' ? ' list-view' : ''}`;
    grid.dataset.category = categoryName;

    links.forEach((link, index) => {
        const tile = createTile(link, { index, category: categoryName, defaultTileSize, lazyIcons });
        grid.appendChild(tile);
    });

    section.appendChild(grid);
    return section;
}

/**
 * Render the "no results" message.
 * @param {HTMLElement} container - Container to render into
 */
export function renderNoResults(container) {
    const p = document.createElement('p');
    p.className = 'no-results';
    p.textContent = 'No links found. Try a different search term or ';
    const link = document.createElement('a');
    link.href = 'manage.html';
    link.textContent = 'add some links';
    p.appendChild(link);
    container.appendChild(p);
}
