/**
 * DOM Performance Optimization Module for The Codex
 * Provides incremental DOM updates, virtual scrolling, and performance monitoring
 */

import { sanitizeHTML, validateAndSanitizeUrl } from '../features/utils.js';
import { getState } from '../core-systems/stateManager.js';

// Current state reference
let currentState = null;

// Simple icon URL function for DOM optimization
function getIconUrl(link) {
    // If custom icon URL is provided, use it
    if (link.icon && link.icon.trim()) {
        return link.icon;
    }

    // Simple fallback - return null for now
    return null;
}

// Performance metrics
let performanceMetrics = {
    renderTime: 0,
    domOperations: 0,
    memoryUsage: 0,
    lastRenderTimestamp: 0
};

// DOM diffing and incremental updates
let lastRenderedState = null;
let updateQueue = [];
let isUpdating = false;

/**
 * Calculates the difference between two states for incremental updates
 * @param {Object} oldState - Previous state
 * @param {Object} newState - Current state
 * @returns {Object} - Diff object with changes
 */
function calculateStateDiff(oldState, newState) {
    const diff = {
        linksChanged: false,
        linksAdded: [],
        linksRemoved: [],
        linksModified: [],
        themeChanged: false,
        viewChanged: false,
        searchTermChanged: false,
        categoriesChanged: false
    };

    // Handle null/undefined oldState
    if (!oldState) {
        diff.linksChanged = true;
        diff.themeChanged = true;
        diff.viewChanged = true;
        diff.searchTermChanged = true;
        return diff;
    }

    // Ensure newState has required properties
    if (!newState) {
        return diff;
    }

    // Safe property access with defaults
    const oldTheme = oldState.theme || 'dark';
    const newTheme = newState.theme || 'dark';
    const oldView = oldState.view || 'grid';
    const newView = newState.view || 'grid';
    const oldSearchTerm = oldState.searchTerm || '';
    const newSearchTerm = newState.searchTerm || '';

    diff.themeChanged = oldTheme !== newTheme;
    diff.viewChanged = oldView !== newView;
    diff.searchTermChanged = oldSearchTerm !== newSearchTerm;

    // Check if links array exists and changed
    const oldLinks = oldState.links || [];
    const newLinks = newState.links || [];

    if (!Array.isArray(oldLinks) || !Array.isArray(newLinks)) {
        diff.linksChanged = true;
        return diff;
    }

    if (oldLinks.length !== newLinks.length) {
        diff.linksChanged = true;
    }

    // Check for specific link changes
    if (!diff.linksChanged) {
        const oldLinkMap = new Map(oldLinks.map(link => [link.url, link]));
        const newLinkMap = new Map(newLinks.map(link => [link.url, link]));

        // Find added links
        newState.links.forEach(link => {
            if (!oldLinkMap.has(link.url)) {
                diff.linksAdded.push(link);
            }
        });

        // Find removed links
        oldState.links.forEach(link => {
            if (!newLinkMap.has(link.url)) {
                diff.linksRemoved.push(link);
            }
        });

        // Find modified links
        newState.links.forEach(link => {
            const oldLink = oldLinkMap.get(link.url);
            if (oldLink && JSON.stringify(oldLink) !== JSON.stringify(link)) {
                diff.linksModified.push(link);
            }
        });

        // If any specific changes found, mark as changed
        if (diff.linksAdded.length > 0 || diff.linksRemoved.length > 0 || diff.linksModified.length > 0) {
            diff.linksChanged = true;
        }
    }

    // Check categories
    if (oldState.categories && newState.categories) {
        diff.categoriesChanged = JSON.stringify(oldState.categories) !== JSON.stringify(newState.categories);
    }

    return diff;
}

/**
 * Performs incremental DOM updates based on state differences
 * @param {HTMLElement} container - The container element
 * @param {Object} diff - State difference object
 * @param {Object} newState - Current state
 */
function performIncrementalUpdate(container, diff, newState) {
    const startTime = performance.now();

    try {
        if (diff.viewChanged) {
            // View change affects all grids
            updateViewClasses(newState.view);
        }

        if (diff.themeChanged) {
            // Theme change affects the entire document
            updateThemeClasses(newState.theme, newState.colorTheme);
        }

        if (diff.searchTermChanged || diff.linksChanged) {
            // Search or links change requires content update
            updateLinkContent(container, newState);
        }

        if (diff.categoriesChanged) {
            // Categories change might require section updates
            updateCategorySections(container, newState);
        }

        // Update performance metrics
        performanceMetrics.renderTime = performance.now() - startTime;
        performanceMetrics.lastRenderTimestamp = Date.now();
        performanceMetrics.domOperations++;

    } catch (error) {
        console.error('Incremental update failed:', error);
        // Fallback to full re-render
        return false;
    }

    return true;
}

/**
 * Updates only the view classes without re-rendering content
 * @param {string} view - The view type ('grid' or 'list')
 */
function updateViewClasses(view) {
    const grids = document.querySelectorAll('.links-grid');
    grids.forEach(grid => {
        grid.classList.toggle('list-view', view === 'list');
    });
}

/**
 * Updates theme classes without re-rendering content
 * @param {string} theme - The theme ('dark' or 'light')
 * @param {string} colorTheme - The color theme
 */
function updateThemeClasses(theme, colorTheme) {
    let classes = theme;
    if (colorTheme !== 'default') {
        classes += ` ${colorTheme}`;
    }
    document.body.className = classes;
    document.body.setAttribute('data-theme', theme);
    document.body.setAttribute('data-color-theme', colorTheme);
}

/**
 * Updates link content incrementally
 * @param {HTMLElement} container - The container element
 * @param {Object} state - Current state
 */
function updateLinkContent(container, state) {
    const filteredLinks = state.links.filter(link =>
        link.name.toLowerCase().includes(state.searchTerm.toLowerCase()) ||
        link.url.toLowerCase().includes(state.searchTerm.toLowerCase())
    );

    const groupedLinks = groupBy(filteredLinks, 'category');

    // Update existing sections or create new ones
    const existingSections = container.querySelectorAll('.category-section');
    const sectionMap = new Map();

    existingSections.forEach(section => {
        const category = section.querySelector('h2')?.textContent;
        if (category) {
            sectionMap.set(category, section);
        }
    });

    // Process each category
    Object.entries(groupedLinks).forEach(([category, links]) => {
        const existingSection = sectionMap.get(category);

        if (existingSection) {
            // Update existing section
            updateCategorySection(existingSection, category, links, state);
        } else {
            // Create new section
            const newSection = createCategorySection(category, links, state);
            container.appendChild(newSection);
        }
    });

    // Remove sections that no longer have links
    existingSections.forEach(section => {
        const category = section.querySelector('h2')?.textContent;
        if (category && !groupedLinks[category]) {
            section.remove();
        }
    });

    // Handle no results case
    if (filteredLinks.length === 0) {
        const noResults = container.querySelector('.no-results');
        if (!noResults) {
            container.innerHTML = '<p class="no-results">No links found. Try a different search term or <a href="manage.html">add some links</a>.</p>';
        }
    } else {
        const noResults = container.querySelector('.no-results');
        if (noResults) {
            noResults.remove();
        }
    }
}

/**
 * Updates a single category section
 * @param {HTMLElement} section - The section element
 * @param {string} category - Category name
 * @param {Array} links - Array of links
 * @param {Object} state - Current state
 */
function updateCategorySection(section, category, links, state) {
    const grid = section.querySelector('.links-grid');
    if (!grid) return;

    // Update view class
    grid.classList.toggle('list-view', state.view === 'list');

    // Get existing links
    const existingLinks = Array.from(grid.querySelectorAll('.link-tile'));
    const linkMap = new Map();

    existingLinks.forEach(tile => {
        const url = tile.href;
        if (url) {
            linkMap.set(url, tile);
        }
    });

    // Update existing links or add new ones
    links.forEach((link, index) => {
        const existingTile = linkMap.get(link.url);

        if (existingTile) {
            // Update existing tile
            updateLinkTile(existingTile, link, index, category, state);
        } else {
            // Create new tile
            const newTile = createLinkTile(link, index, category, state);
            grid.appendChild(newTile);
        }
    });

    // Remove tiles that no longer exist
    existingLinks.forEach(tile => {
        const url = tile.href;
        if (url && !links.some(link => link.url === url)) {
            tile.remove();
        }
    });
}

/**
 * Updates a single link tile
 * @param {HTMLElement} tile - The tile element
 * @param {Object} link - Link data
 * @param {number} index - Link index
 * @param {string} category - Category name
 * @param {Object} state - Current state
 */
function updateLinkTile(tile, link, index, category, state) {
    // Update tile attributes
    tile.href = validateAndSanitizeUrl(link.url);
    tile.dataset.linkIndex = index;
    tile.dataset.category = category;

    // Update tile content
    const content = tile.querySelector('.tile-content');
    if (content) {
        const nameElement = content.querySelector('h3');
        if (nameElement) {
            nameElement.textContent = sanitizeHTML(link.name);
        }

        // Update icon if changed
        const iconElement = content.querySelector('.tile-icon');
        const placeholderElement = content.querySelector('.tile-placeholder');
        const iconUrl = getIconUrl(link);

        if (iconUrl && iconElement) {
            if (iconElement.src !== iconUrl) {
                iconElement.src = sanitizeHTML(iconUrl);
            }
            iconElement.style.display = 'block';
            if (placeholderElement) placeholderElement.style.display = 'none';
        } else if (placeholderElement) {
            placeholderElement.style.display = 'flex';
            if (iconElement) iconElement.style.display = 'none';
        }
    }

    // Update tile size class
    const size = link.size || state.defaultTileSize || 'medium';
    tile.className = `link-tile size-${size}`;
}

/**
 * Creates a new category section
 * @param {string} category - Category name
 * @param {Array} links - Array of links
 * @param {Object} state - Current state
 * @returns {HTMLElement} - The created section
 */
function createCategorySection(category, links, state) {
    const section = document.createElement('section');
    section.className = 'category-section fade-in';

    const grid = document.createElement('div');
    grid.className = `links-grid ${state.view === 'list' ? 'list-view' : ''}`;
    grid.dataset.category = category;

    // Add links to grid
    links.forEach((link, index) => {
        const tile = createLinkTile(link, index, category, state);
        grid.appendChild(tile);
    });

    section.innerHTML = `
        <h2>${sanitizeHTML(category)}</h2>
    `;
    section.appendChild(grid);

    return section;
}

/**
 * Creates a new link tile
 * @param {Object} link - Link data
 * @param {number} index - Link index
 * @param {string} category - Category name
 * @param {Object} state - Current state
 * @returns {HTMLElement} - The created tile
 */
function createLinkTile(link, index, category, state) {
    const size = link.size || state.defaultTileSize || 'medium';
    const isCompact = size === 'compact';
    const isHorizontal = size === 'wide' || isCompact;

    const tile = document.createElement('a');
    tile.href = validateAndSanitizeUrl(link.url);
    tile.className = `link-tile size-${size}`;
    tile.target = '_blank';
    tile.draggable = true;
    tile.dataset.linkIndex = index;
    tile.dataset.category = category;

    const iconUrl = getIconUrl(link);

    tile.innerHTML = `
        <div class="tile-content${isHorizontal ? ' horizontal' : ''}">
            ${iconUrl ? `<img class="tile-icon" src="${sanitizeHTML(iconUrl)}" alt="" loading="lazy">
            <div class="tile-placeholder" style="display: none;"></div>` : '<div class="tile-placeholder"></div>'}
            <h3>${sanitizeHTML(link.name)}</h3>
        </div>
    `;

    return tile;
}

/**
 * Updates category sections in the container
 * @param {HTMLElement} container - The container element
 * @param {Object} state - Current state
 */
function updateCategorySections(container, state) {
    // This would handle category-level changes like renames or reordering
    // For now, handled by updateLinkContent
}

/**
 * Groups links by category
 * @param {Array} array - Array of links
 * @param {string} key - Property to group by
 * @returns {Object} - Grouped links
 */
function groupBy(array, key) {
    return array.reduce((result, currentValue) => {
        (result[currentValue[key]] = result[currentValue[key]] || []).push(currentValue);
        return result;
    }, {});
}

/**
 * Gets current performance metrics
 * @returns {Object} - Performance metrics
 */
export function getPerformanceMetrics() {
    return { ...performanceMetrics };
}

/**
 * Resets performance metrics
 */
export function resetPerformanceMetrics() {
    performanceMetrics = {
        renderTime: 0,
        domOperations: 0,
        memoryUsage: 0,
        lastRenderTimestamp: 0
    };
}

/**
 * Monitors memory usage (if available)
 */
export function monitorMemoryUsage() {
    if (performance.memory) {
        performanceMetrics.memoryUsage = performance.memory.usedJSHeapSize;
    }
}

/**
 * Optimized render function that uses incremental updates
 * @param {HTMLElement} container - The container element
 * @param {Object} newState - The new state
 * @param {Object} oldState - The previous state
 * @returns {boolean} - Success status
 */
export function optimizedRender(container, newState, oldState = null) {
    const startTime = performance.now();

    try {
        // Ensure newState is valid
        if (!newState || typeof newState !== 'object') {
            console.warn('Invalid newState provided to optimizedRender');
            return false;
        }

        // Calculate state differences
        const diff = calculateStateDiff(oldState, newState);

        // If no differences, no need to update
        if (!diff.linksChanged && !diff.themeChanged && !diff.viewChanged && !diff.searchTermChanged && !diff.categoriesChanged) {
            return true;
        }

        // Perform incremental update
        const success = performIncrementalUpdate(container, diff, newState);

        // Update last rendered state
        lastRenderedState = createStateSnapshot(newState);

        // Monitor memory usage
        monitorMemoryUsage();

        return success;

    } catch (error) {
        console.error('Optimized render failed:', error);
        return false;
    } finally {
        performanceMetrics.renderTime = performance.now() - startTime;
    }
}

/**
 * Creates a state snapshot for comparison
 * @param {Object} state - The state to snapshot (optional, uses current state if not provided)
 * @returns {Object} - State snapshot
 */
function createStateSnapshot(state = null) {
    return JSON.parse(JSON.stringify(state || currentState));
}

/**
 * Debounced update function for batching multiple changes
 * @param {Function} updateFunction - Function to execute after debounce
 * @param {number} delay - Debounce delay in milliseconds
 * @returns {Function} - Debounced function
 */
export function debouncedUpdate(updateFunction, delay = 16) {
    let timeoutId;

    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            updateFunction.apply(this, args);
        }, delay);
    };
}

/**
 * Virtual scrolling implementation for large datasets
 * @param {HTMLElement} container - The container element
 * @param {Array} items - Array of items to display
 * @param {number} itemHeight - Height of each item in pixels
 * @param {number} viewportHeight - Height of viewport in pixels
 * @param {Function} renderItem - Function to render individual items
 */
export function virtualScroll(container, items, itemHeight, viewportHeight, renderItem) {
    const totalHeight = items.length * itemHeight;
    const visibleItems = Math.ceil(viewportHeight / itemHeight) + 2; // +2 for buffer

    // Create scrollable container
    const scrollContainer = document.createElement('div');
    scrollContainer.style.height = `${viewportHeight}px`;
    scrollContainer.style.overflow = 'auto';
    scrollContainer.style.position = 'relative';

    // Create content container
    const contentContainer = document.createElement('div');
    contentContainer.style.height = `${totalHeight}px`;
    contentContainer.style.position = 'relative';

    scrollContainer.appendChild(contentContainer);
    container.appendChild(scrollContainer);

    let startIndex = 0;
    let endIndex = visibleItems;

    function renderVisibleItems() {
        const scrollTop = scrollContainer.scrollTop;
        startIndex = Math.floor(scrollTop / itemHeight);
        endIndex = Math.min(startIndex + visibleItems, items.length);

        // Clear existing items
        contentContainer.innerHTML = '';

        // Render visible items
        for (let i = startIndex; i < endIndex; i++) {
            const item = items[i];
            const itemElement = renderItem(item, i);
            itemElement.style.position = 'absolute';
            itemElement.style.top = `${i * itemHeight}px`;
            itemElement.style.height = `${itemHeight}px`;
            itemElement.style.width = '100%';
            contentContainer.appendChild(itemElement);
        }
    }

    // Initial render
    renderVisibleItems();

    // Handle scroll events
    scrollContainer.addEventListener('scroll', debouncedUpdate(renderVisibleItems, 10));

    return {
        container: scrollContainer,
        update: renderVisibleItems,
        destroy: () => {
            scrollContainer.removeEventListener('scroll', renderVisibleItems);
            container.removeChild(scrollContainer);
        }
    };
}

// Export the DOM optimization system
export default {
    optimizedRender,
    getPerformanceMetrics,
    resetPerformanceMetrics,
    monitorMemoryUsage,
    debouncedUpdate,
    virtualScroll,
    calculateStateDiff,
    performIncrementalUpdate
};