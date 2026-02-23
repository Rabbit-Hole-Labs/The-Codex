import { loadLinks, saveLinks, saveSettings } from '../core-systems/storageManager.js';
import { debounce, sanitizeHTML, validateAndSanitizeUrl } from '../features/utils.js';
import { purifyHTML, sanitizeUserInput, validateLink } from '../features/securityUtils.js';
import { getState, updateState, addStateChangeListener, safeUpdateState, createStateUpdater } from '../core-systems/stateManager.js';
import { optimizedRender, getPerformanceMetrics, resetPerformanceMetrics } from '../features/domOptimizer.js';
import { handleError, safeAsync, safeSync, registerErrorHandler, CodexError } from '../features/errorHandler.js';
import { loadIconWithCache, preloadIcons, batchLoadIcons, getCacheStats } from '../features/iconCache.js';
import { syncStatusIndicator } from '../features/syncStatusIndicator.js';
import CodexConsole from '../features/consoleCommands.js';
import { debug, debugWarn, debugError, setDebugEnabled, isDebugEnabled } from '../core-systems/debug.js';

// State
let state = {
    links: [],
    theme: 'dark',
    colorTheme: 'default',
    view: 'grid',
    searchTerm: '',
    defaultTileSize: 'medium',
    isDragging: false,
    draggedElement: null,
    draggedLink: null,
    draggedCategory: null,
    draggedIndex: null,
};

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
    console.log('Cleaning up event listeners:', eventListeners.length);

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

// Functions
async function initializeState() {
    try {
        const loadedState = await loadLinks();
        
        // Validate the loaded data before using it
        if (!loadedState || typeof loadedState !== 'object') {
            throw new Error('Invalid state data loaded from storage');
        }
        
        // Ensure links is an array - handle corrupted data
        if (!loadedState.links) {
            console.warn('Links property is missing, setting to empty array');
            loadedState.links = [];
        } else if (!Array.isArray(loadedState.links)) {
            console.warn('Links is not an array, resetting to empty array');
            loadedState.links = [];
        }
        
        // Enhanced cleanup and validation for corrupted link data
        if (Array.isArray(loadedState.links)) {
            console.log(`Processing ${loadedState.links.length} links for cleanup and validation`);
            
            loadedState.links = loadedState.links
                .map((link, index) => {
                    // Skip if link is null, undefined, or not an object
                    if (!link || typeof link !== 'object') {
                        console.warn(`Skipping invalid link at index ${index}: not an object`, link);
                        return null;
                    }
                    
                    // Create a clean copy of the link object
                    const cleanLink = { ...link };
                    
                    // Ensure required properties exist
                    if (!cleanLink.name || typeof cleanLink.name !== 'string') {
                        // Try to salvage the link with a default name
                        if (cleanLink.url && typeof cleanLink.url === 'string') {
                            try {
                                const urlObj = new URL(cleanLink.url);
                                cleanLink.name = urlObj.hostname || 'Unnamed Link';
                            } catch {
                                cleanLink.name = 'Unnamed Link';
                            }
                        } else {
                            cleanLink.name = 'Unnamed Link';
                        }
                        console.warn(`Fixed missing/invalid name for link at index ${index}, set to: ${cleanLink.name}`);
                    }
                    
                    // Sanitize name to meet validation requirements
                    if (typeof cleanLink.name === 'string') {
                        // Remove control characters and limit length
                        cleanLink.name = cleanLink.name
                            .replace(/[\x00-\x1F\x7F]/g, '')
                            .substring(0, 100)
                            .trim();
                        
                        // If name is empty after sanitization, provide a default
                        if (!cleanLink.name) {
                            cleanLink.name = 'Unnamed Link';
                            console.warn(`Sanitized name was empty for link at index ${index}, set to: ${cleanLink.name}`);
                        }
                    }
                    
                    // Ensure URL exists and is valid
                    if (!cleanLink.url || typeof cleanLink.url !== 'string') {
                        console.warn(`Skipping link at index ${index}: missing or invalid URL`, cleanLink);
                        return null;
                    }
                    
                    // Validate and sanitize URL
                    try {
                        new URL(cleanLink.url);
                    } catch {
                        console.warn(`Skipping link at index ${index}: invalid URL format`, cleanLink.url);
                        return null;
                    }
                    
                    // Ensure category exists
                    if (!cleanLink.category || typeof cleanLink.category !== 'string') {
                        cleanLink.category = 'Default';
                        console.warn(`Fixed missing/invalid category for link at index ${index}, set to: ${cleanLink.category}`);
                    }
                    
                    // Sanitize category
                    if (typeof cleanLink.category === 'string') {
                        cleanLink.category = cleanLink.category
                            .replace(/[\x00-\x1F\x7F]/g, '')
                            .substring(0, 50)
                            .trim();
                        
                        if (!cleanLink.category) {
                            cleanLink.category = 'Default';
                            console.warn(`Sanitized category was empty for link at index ${index}, set to: ${cleanLink.category}`);
                        }
                    }
                    
                    // Handle icon property - ensure proper default values for validation
                    if (cleanLink.icon === undefined || cleanLink.icon === null) {
                        // For validation consistency, explicitly set to null rather than deleting
                        cleanLink.icon = null;
                    } else if (typeof cleanLink.icon === 'string') {
                        // Validate icon URL if present
                        try {
                            new URL(cleanLink.icon);
                        } catch {
                            // Set to null for invalid icon URL rather than deleting
                            cleanLink.icon = null;
                            console.log(`Removed invalid icon URL for link at index ${index}`, cleanLink.icon);
                        }
                    } else if (typeof cleanLink.icon === 'object') {
                        // Handle object values for icon property with enhanced object handling
                        console.log(`Found icon as object at index ${index}:`, cleanLink.icon);
                        
                        // Try to extract URL from common object structures with enhanced handling
                        let extractedIcon = null;
                        
                        // Check for common object structures
                        if (cleanLink.icon.url && typeof cleanLink.icon.url === 'string') {
                            extractedIcon = cleanLink.icon.url;
                        } else if (cleanLink.icon.src && typeof cleanLink.icon.src === 'string') {
                            extractedIcon = cleanLink.icon.src;
                        } else if (cleanLink.icon.value && typeof cleanLink.icon.value === 'string') {
                            extractedIcon = cleanLink.icon.value;
                        } else if (cleanLink.icon.data && typeof cleanLink.icon.data === 'string') {
                            // Handle data URLs
                            extractedIcon = cleanLink.icon.data;
                        } else if (typeof cleanLink.icon.toString === 'function') {
                            // Try to convert to string with enhanced error handling
                            try {
                                const stringified = cleanLink.icon.toString();
                                // More robust check for meaningful string representation
                                if (stringified && typeof stringified === 'string' &&
                                    stringified.trim() !== '[object Object]' &&
                                    stringified.trim() !== '[object Null]' &&
                                    stringified.trim() !== '[object Undefined]') {
                                    extractedIcon = stringified;
                                }
                            } catch (e) {
                                console.warn(`Failed to convert icon object to string at index ${index}:`, e);
                            }
                        } else if (Object.keys(cleanLink.icon).length > 0) {
                            // Try JSON serialization for complex objects as last resort
                            try {
                                const jsonStr = JSON.stringify(cleanLink.icon);
                                if (jsonStr && jsonStr.length > 0) {
                                    console.log(`Serialized icon object to JSON at index ${index}:`, jsonStr);
                                }
                            } catch (e) {
                                console.warn(`Failed to serialize icon object to JSON at index ${index}:`, e);
                            }
                        }
                        
                        // Validate extracted icon URL
                        if (extractedIcon) {
                            try {
                                new URL(extractedIcon);
                                cleanLink.icon = extractedIcon;
                                console.log(`Successfully extracted icon URL from object at index ${index}:`, extractedIcon);
                            } catch {
                                cleanLink.icon = null;
                                console.log(`Extracted icon URL is invalid at index ${index}:`, extractedIcon);
                            }
                        } else {
                            // For validation consistency, explicitly set to null rather than deleting
                            cleanLink.icon = null;
                            console.log(`Could not extract valid icon URL from object at index ${index}`, cleanLink.icon);
                        }
                    } else {
                        // Set to null for non-string, non-object icon property rather than deleting
                        cleanLink.icon = null;
                        console.log(`Removed invalid icon type (${typeof cleanLink.icon}) for link at index ${index}`, cleanLink.icon);
                    }
                    
                    // Handle size property - ensure proper default values for validation
                    const validSizes = ['compact', 'small', 'medium', 'large', 'square', 'wide', 'tall', 'giant', 'default'];
                    if (cleanLink.size === undefined || cleanLink.size === null) {
                        // For validation consistency, explicitly set to null rather than deleting
                        cleanLink.size = null;
                    } else if (typeof cleanLink.size === 'string') {
                        if (!validSizes.includes(cleanLink.size)) {
                            // Set to null for invalid size value rather than deleting
                            cleanLink.size = null;
                            console.log(`Removed invalid size for link at index ${index}`, cleanLink.size);
                        }
                    } else if (typeof cleanLink.size === 'object') {
                        // Handle object values for size property with enhanced object handling
                        console.log(`Found size as object at index ${index}:`, cleanLink.size);
                        
                        // Try to extract value from common object structures with enhanced handling
                        let extractedSize = null;
                        
                        // Check for common object structures
                        if (cleanLink.size.value && typeof cleanLink.size.value === 'string') {
                            extractedSize = cleanLink.size.value;
                        } else if (cleanLink.size.name && typeof cleanLink.size.name === 'string') {
                            extractedSize = cleanLink.size.name;
                        } else if (cleanLink.size.type && typeof cleanLink.size.type === 'string') {
                            extractedSize = cleanLink.size.type;
                        } else if (typeof cleanLink.size.toString === 'function') {
                            // Try to convert to string with enhanced error handling
                            try {
                                const stringified = cleanLink.size.toString();
                                // More robust check for meaningful string representation
                                if (stringified && typeof stringified === 'string' &&
                                    stringified.trim() !== '[object Object]' &&
                                    stringified.trim() !== '[object Null]' &&
                                    stringified.trim() !== '[object Undefined]') {
                                    extractedSize = stringified;
                                }
                            } catch (e) {
                                console.log(`Failed to convert size object to string at index ${index}:`, e);
                            }
                        } else if (Object.keys(cleanLink.size).length > 0) {
                            // Try JSON serialization for complex objects as last resort
                            try {
                                const jsonStr = JSON.stringify(cleanLink.size);
                                if (jsonStr && jsonStr.length > 0) {
                                    console.log(`Serialized size object to JSON at index ${index}:`, jsonStr);
                                }
                            } catch (e) {
                                console.log(`Failed to serialize size object to JSON at index ${index}:`, e);
                            }
                        }
                        
                        // Validate extracted size value
                        if (extractedSize && validSizes.includes(extractedSize)) {
                            cleanLink.size = extractedSize;
                            console.log(`Successfully extracted size value from object at index ${index}:`, extractedSize);
                        } else {
                            // For validation consistency, explicitly set to null rather than deleting
                            cleanLink.size = null;
                            console.log(`Could not extract valid size from object at index ${index}`, cleanLink.size);
                        }
                    } else {
                        // Set to null for non-string, non-object size property rather than deleting
                        cleanLink.size = null;
                        console.log(`Removed invalid size type (${typeof cleanLink.size}) for link at index ${index}`, cleanLink.size);
                    }
                    
                    // Add ID if missing
                    if (!cleanLink.id) {
                        cleanLink.id = `link_${Date.now()}_${index}`;
                        console.log(`Added missing ID for link at index ${index}: ${cleanLink.id}`);
                    }
                    
                    return cleanLink;
                })
                .filter(link => link !== null); // Remove null links that couldn't be salvaged
            
            console.log(`After cleanup: ${loadedState.links.length} valid links remaining`);
        }
        
        // Create state updates with validated data
        const stateUpdates = {};
        
        // Only add links if it's a valid array
        if (Array.isArray(loadedState.links)) {
            stateUpdates.links = loadedState.links;
        } else {
            stateUpdates.links = []; // Force empty array
        }

        if (loadedState.theme) stateUpdates.theme = loadedState.theme;
        if (loadedState.colorTheme) stateUpdates.colorTheme = loadedState.colorTheme;
        if (loadedState.view) stateUpdates.view = loadedState.view;
        if (loadedState.defaultTileSize) stateUpdates.defaultTileSize = loadedState.defaultTileSize;
        if (loadedState.categories && Array.isArray(loadedState.categories)) {
            stateUpdates.categories = loadedState.categories;
        }

        // Set defaults if not provided
        if (!loadedState.theme) stateUpdates.theme = 'dark';
        if (!loadedState.colorTheme) stateUpdates.colorTheme = 'default';
        if (!loadedState.view) stateUpdates.view = 'grid';
        if (!loadedState.defaultTileSize) stateUpdates.defaultTileSize = 'medium';
        if (!stateUpdates.categories) stateUpdates.categories = ['Default'];

        // Create clean state object with guaranteed array for links
        const cleanUpdates = {
            theme: stateUpdates.theme || 'dark',
            colorTheme: stateUpdates.colorTheme || 'default',
            view: stateUpdates.view || 'grid',
            defaultTileSize: stateUpdates.defaultTileSize || 'medium',
            links: stateUpdates.links || [], // Use validated links
            categories: stateUpdates.categories || ['Default'],
            searchTerm: stateUpdates.searchTerm || '',
            isDragging: stateUpdates.isDragging || false,
            draggedElement: stateUpdates.draggedElement || null,
            draggedLink: stateUpdates.draggedLink || null,
            draggedCategory: stateUpdates.draggedCategory || null,
            draggedIndex: stateUpdates.draggedIndex || null
        };
        
        // Apply state updates safely
        const updateResult = await safeUpdateState(cleanUpdates, { validate: true });
        
        if (!updateResult.success) {
            console.error('Failed to initialize state:', updateResult.error);
            // Log detailed information about the state that failed validation
            console.error('State that failed validation:', {
                links: stateUpdates.links,
                theme: stateUpdates.theme,
                colorTheme: stateUpdates.colorTheme,
                view: stateUpdates.view,
                defaultTileSize: stateUpdates.defaultTileSize
            });
            
            // Fallback to safe defaults
            const fallbackResult = await safeUpdateState({
                theme: 'dark',
                colorTheme: 'default',
                view: 'grid',
                defaultTileSize: 'medium',
                links: []
            }, { validate: true });
            
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
        
        // Ultimate fallback
        await safeUpdateState({
            theme: 'dark',
            colorTheme: 'default',
            view: 'grid',
            defaultTileSize: 'medium',
            links: []
        }, { validate: true });
    }
}

async function renderLinksTraditional() {
    const currentState = getState();
    const filteredLinks = currentState.links.filter(link =>
        link.name.toLowerCase().includes(currentState.searchTerm.toLowerCase()) ||
        link.url.toLowerCase().includes(currentState.searchTerm.toLowerCase())
    );
    const groupedLinks = groupBy(filteredLinks, 'category');

    linksContainer.innerHTML = '';

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

    sortedCategories.forEach(category => {
        const links = groupedLinks[category];
        const section = document.createElement('section');
        section.className = 'category-section fade-in';
        section.innerHTML = `
            <h2>${sanitizeHTML(category)}</h2>
            <div class="links-grid ${currentState.view === 'list' ? 'list-view' : ''}" data-category="${category}">
                ${links.map((link, index) => {
                    const size = link.size || currentState.defaultTileSize || 'medium';
                    const isCompact = size === 'compact';
                    const isHorizontal = size === 'wide' || isCompact;

                    return `
                    <a href="${validateAndSanitizeUrl(link.url)}" ${getTileClasses(link)} target="_blank"
                       draggable="true"
                       data-link-index="${index}"
                       data-category="${category}">
                        <div class="tile-content${isHorizontal ? ' horizontal' : ''}">
                            <img class="tile-icon" src="" alt="" loading="lazy" data-icon-url="${sanitizeHTML(getIconUrl(link))}" data-link-id="${link.id}">
                            <div class="tile-placeholder" style="display: none;"></div>
                            <h3>${sanitizeHTML(link.name)}</h3>
                        </div>
                    </a>
                `}).join('')}
            </div>
        `;
        linksContainer.appendChild(section);
    });

    if (filteredLinks.length === 0) {
        linksContainer.innerHTML = '<p class="no-results">No links found. Try a different search term or <a href="manage.html">add some links</a>.</p>';
    }

    // Load icons asynchronously with caching
    loadIconsWithCaching(filteredLinks);

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

        // Remove the dragged link from its original position
        const draggedLinkIndex = currentState.links.findIndex(link =>
            link === currentState.draggedLink
        );

        // Also try finding by name and url as fallback (in case reference was lost)
        const fallbackIndex = draggedLinkIndex === -1 ?
            currentState.links.findIndex(link =>
                link.name === currentState.draggedLink?.name &&
                link.url === currentState.draggedLink?.url
            ) : draggedLinkIndex;

        const finalIndex = fallbackIndex !== -1 ? fallbackIndex : draggedLinkIndex;

        if (finalIndex !== -1) {
            // Create new links array with the link moved
            const newLinks = [...currentState.links];
            const [removedLink] = newLinks.splice(finalIndex, 1);

            // Update the category if moving between categories
            const updatedLink = { ...removedLink, category: dropCategory };

            // Find the target position in the global links array
            const targetIndex = findGlobalIndexForCategoryPosition(dropCategory, dropIndex);

            // Insert the link at the new position
            newLinks.splice(targetIndex, 0, updatedLink);

            // Update state with new links array
            safeUpdateState({ links: newLinks }, { validate: true });

            // Save the new order
            saveLinks(newLinks);

            // Re-render the links
            renderLinks();
        }
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
    renderLinksTraditional();
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

function handleGridDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    const currentState = getState();
    if (currentState.isDragging && currentState.draggedLink) {
        const dropCategory = this.dataset.category;

        // Find link by reference first, then by name/url as fallback
        const draggedLinkIndex = currentState.links.findIndex(link =>
            link === currentState.draggedLink
        );

        // Fallback: find by name and url (reference equality fails due to deep cloning in getState)
        const fallbackIndex = draggedLinkIndex === -1 ?
            currentState.links.findIndex(link =>
                link.name === currentState.draggedLink?.name &&
                link.url === currentState.draggedLink?.url
            ) : draggedLinkIndex;

        const finalIndex = fallbackIndex !== -1 ? fallbackIndex : draggedLinkIndex;

        if (finalIndex !== -1) {
            // Create new links array with the link moved
            const newLinks = [...currentState.links];
            const [removedLink] = newLinks.splice(finalIndex, 1);

            // Update the category
            const updatedLink = { ...removedLink, category: dropCategory };

            // Find where to insert in the target category (at the end)
            let insertIndex = newLinks.length;
            for (let i = newLinks.length - 1; i >= 0; i--) {
                if (newLinks[i].category === dropCategory) {
                    insertIndex = i + 1;
                    break;
                }
            }

            // Insert the link at the end of the target category
            newLinks.splice(insertIndex, 0, updatedLink);

            // Update state with new links array
            safeUpdateState({ links: newLinks }, { validate: true });

            // Save the new order
            saveLinks(newLinks);

            // Re-render the links
            renderLinks();
        }
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

function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace('www.', '');
    } catch {
        return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    }
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

    // Use DOM optimizer for theme updates
    const theme = currentState.theme || 'dark';
    const colorTheme = currentState.colorTheme || 'default';

    // Build class string
    let classes = theme;
    if (colorTheme !== 'default') {
        classes += ` ${colorTheme}`;
    }

    // Apply to body
    document.body.className = classes;
    console.log('Applied theme classes:', classes);

    // Also store in data attribute for debugging
    document.body.setAttribute('data-theme', theme);
    document.body.setAttribute('data-color-theme', colorTheme);
}

function toggleColorThemeDropdown() {
    // Theme controls moved to management page - this function is no longer used
    console.log('Theme controls are now on the management page');
}

function setColorTheme(theme) {
    console.log('Setting color theme to:', theme);
    state.colorTheme = theme;
    applyTheme();
    updateActiveThemeOption();
    saveSettings({ colorTheme: state.colorTheme });
}

function updateActiveThemeOption() {
    // This function is no longer needed since theme controls moved to management page
    // Left as placeholder for compatibility
    console.log('Theme controls are now on the management page');
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


// Utility function to group links by category
function groupBy(array, key) {
    return array.reduce((result, currentValue) => {
        (result[currentValue[key]] = result[currentValue[key]] || []).push(currentValue);
        return result;
    }, {});
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

    console.log('DOM Elements:', { searchInput, searchSuggestions, linksContainer });

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
        container.innerHTML = `
            <div class="error-fallback">
                <h2> Application Error</h2>
                <p>The application failed to initialize properly.</p>
                <button onclick="location.reload()">Reload Application</button>
                <p><small>If the problem persists, please check the console for error details.</small></p>
            </div>
        `;
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
    console.log('Initializing application...');

    // Reset performance metrics
    resetPerformanceMetrics();

    const startTime = performance.now();
    try {
        initializeDOMElements();
        await initializeState();
        applyTheme();  // Apply theme from saved state
        setupEventListeners();
        
        // Render links after state is initialized
        console.log('Rendering links after initialization...');
        renderLinks();

        // Add state change listener for automatic re-rendering
        addStateChangeListener((changeInfo) => {
            console.log('State changed:', changeInfo);

            // Only re-render if relevant properties changed
            const relevantChanges = ['links', 'theme', 'colorTheme', 'view', 'searchTerm', 'defaultTileSize', 'categories'];
            const hasRelevantChange = Object.keys(changeInfo.changes).some(key =>
                relevantChanges.includes(key)
            );

            if (hasRelevantChange) {
                console.log('Re-rendering due to state change');
                renderLinks();
            }
        });

        // Initialize sync status indicator
        syncStatusIndicator.init('sync-status-container');

        // Update theme dropdown after everything is initialized
        setTimeout(() => {
            updateActiveThemeOption();
        }, 100);

        const initTime = performance.now() - startTime;
        console.log(`Application initialized in ${initTime.toFixed(2)}ms`);

        // Log performance metrics
        const metrics = getPerformanceMetrics();
        console.log('Performance metrics:', metrics);

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
    console.log('Cleaning up before page unload...');
    cleanupAllEventListeners();
});

// Handle visibility change (tab switching) for cleanup
let wasHidden = false;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        wasHidden = true;
        console.log('Page hidden - performing light cleanup');
        // Could perform lighter cleanup here if needed
    } else if (wasHidden) {
        wasHidden = false;
        console.log('Page visible again');
        // Could re-initialize certain components if needed
    }
});

// Log any unhandled errors
window.addEventListener('error', function(event) {
    console.error('Unhandled error:', event.error);
});

/**
 * Loads icons asynchronously with caching system
 * @param {Array} links - Array of link objects
 */
async function loadIconsWithCaching(links) {
    if (!links || links.length === 0) return;

    try {
        console.log(`Loading icons for ${links.length} links...`);
        const startTime = performance.now();

        // Get all icon elements
        const iconElements = document.querySelectorAll('.tile-icon[data-link-id]');

        // Create a map of link ID to icon element
        const iconMap = new Map();
        iconElements.forEach(element => {
            const linkId = element.dataset.linkId;
            if (linkId) {
                iconMap.set(linkId, element);
            }
        });

        // Load icons in batches for better performance with CSP compliance
        const batchSize = 5;
        for (let i = 0; i < links.length; i += batchSize) {
            const batch = links.slice(i, i + batchSize);

            // Process batch with CSP-compliant options
            await Promise.allSettled(
                batch.map(async (link) => {
                    const iconElement = iconMap.get(link.id);
                    if (!iconElement) return;

                    try {
                        // Load icon with CSP-compliant caching
                        const iconUrl = await loadIconWithCache(link, {
                            preferCustom: true,
                            allowClearbit: true,
                            allowFavicon: true,
                            allowGenerated: true,
                            timeout: 3000,
                            respectCSP: true // Enable CSP compliance
                        });

                        if (iconUrl) {
                            iconElement.src = iconUrl;
                            iconElement.style.display = 'block';

                            // Hide placeholder
                            const placeholder = iconElement.nextElementSibling;
                            if (placeholder && placeholder.classList.contains('tile-placeholder')) {
                                placeholder.style.display = 'none';
                            }
                        } else {
                            // Show placeholder if no icon found
                            iconElement.style.display = 'none';
                            const placeholder = iconElement.nextElementSibling;
                            if (placeholder && placeholder.classList.contains('tile-placeholder')) {
                                placeholder.style.display = 'flex';
                                placeholder.textContent = generateInitials(link.name);
                            }
                        }

                    } catch (error) {
                        console.warn(`Failed to load icon for ${link.name}:`, error);

                        // Show placeholder on error
                        iconElement.style.display = 'none';
                        const placeholder = iconElement.nextElementSibling;
                        if (placeholder && placeholder.classList.contains('tile-placeholder')) {
                            placeholder.style.display = 'flex';
                            placeholder.textContent = generateInitials(link.name);
                        }
                    }
                })
            );

            // Small delay between batches to avoid overwhelming the network
            if (i + batchSize < links.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        const endTime = performance.now();
        console.log(`Icon loading completed in ${(endTime - startTime).toFixed(2)}ms`);

        // Log cache statistics
        const cacheStats = getCacheStats();
        console.log('Icon cache stats:', cacheStats);

    } catch (error) {
        console.error('Error in icon loading process:', error);

        // Fallback: show placeholders for all icons on error
        const iconElements = document.querySelectorAll('.tile-icon[data-link-id]');
        iconElements.forEach(iconElement => {
            const linkId = iconElement.dataset.linkId;
            const link = links.find(l => l.id === linkId);
            if (link) {
                iconElement.style.display = 'none';
                const placeholder = iconElement.nextElementSibling;
                if (placeholder && placeholder.classList.contains('tile-placeholder')) {
                    placeholder.style.display = 'flex';
                    placeholder.textContent = generateInitials(link.name);
                }
            }
        });
    }
}

/**
 * Generates initials from text for fallback icons
 * @param {string} text - Text to generate initials from
 * @returns {string} - Generated initials
 */
function generateInitials(text) {
    if (!text || !text.trim()) return '?';

    const words = text.trim().split(/\s+/);
    if (words.length === 1) {
        return words[0].substring(0, 2).toUpperCase();
    }

    return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}