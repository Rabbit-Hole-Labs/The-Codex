import * as StorageManager from './storageManager.js';
import { sanitizeUserInput, validateLink } from '../features/securityUtils.js';
import { validateAndSanitizeUrl } from '../features/utils.js';
import { validateIconValue } from '../features/iconCache.js';

/**
 * Resolve a rendered link (an entry of state.filteredLinks) back to its index
 * in state.links.
 *
 * state is a JSON-cloned snapshot (see stateManager.getState → JSON.parse/
 * stringify), so state.links and state.filteredLinks no longer share object
 * references even when they hold the "same" link. Matching purely by reference
 * (link === target) therefore always fails, and every mutation below would
 * splice/update nothing and silently re-save the unchanged list. Prefer a
 * stable id, fall back to reference identity, then to a value match.
 *
 * @param {Array} links - state.links
 * @param {Object} target - the link object from state.filteredLinks
 * @returns {number} index into links, or -1
 */
function resolveLinkIndex(links, target) {
    if (!target || !Array.isArray(links)) return -1;

    if (target.id != null) {
        const byId = links.findIndex(link => link && link.id === target.id);
        if (byId !== -1) return byId;
    }

    const byRef = links.indexOf(target);
    if (byRef !== -1) return byRef;

    return links.findIndex(link => link
        && link.name === target.name
        && link.url === target.url
        && link.category === target.category
        && (link.size ?? null) === (target.size ?? null)
        && (link.icon ?? null) === (target.icon ?? null));
}

export async function addLink(state, name, url, category, icon, size = 'medium') {
    try {
        // Validate and sanitize inputs
        const sanitizedName = sanitizeUserInput(name, { maxLength: 100 });
        const sanitizedUrl = validateAndSanitizeUrl(url);
        const sanitizedCategory = sanitizeUserInput(category, { maxLength: 50 });

        // Validate required fields
        if (!sanitizedName || sanitizedName.length === 0) {
            throw new Error('Link name is required and cannot be empty');
        }

        if (sanitizedUrl === '#') {
            throw new Error('Invalid or unsafe URL provided');
        }

        if (!sanitizedCategory || sanitizedCategory.length === 0) {
            throw new Error('Category is required and cannot be empty');
        }

        // Icons must be loadable under the extension CSP (selfh.st/jsDelivr
        // https URLs or data: images) — reject at save time instead of
        // persisting a value that render would silently refuse.
        const iconCheck = validateIconValue(icon ? sanitizeUserInput(icon, { maxLength: 500 }) : 'default');
        if (!iconCheck.valid) {
            throw new Error(iconCheck.reason);
        }
        const sanitizedIcon = iconCheck.value;

        // Create new link with sanitized data and a stable id.
        const newLink = {
            id: `link_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: sanitizedName,
            url: sanitizedUrl,
            category: sanitizedCategory,
            icon: sanitizedIcon
        };

        // Only set size if it's not 'default' - let it use global default
        if (size && size !== 'default') {
            newLink.size = size;
        }

        // Validate the complete link object
        const validation = validateLink(newLink);
        if (!validation.valid) {
            throw new Error(`Link validation failed: ${validation.errors.join(', ')}`);
        }

        // Add to state
        state.links.push(newLink);
        state.filteredLinks.push(newLink);

        // Save to storage
        await StorageManager.saveLinks(state.links);

        console.log('Link added:', newLink);
        return newLink;

    } catch (error) {
        console.error('Error adding link:', error);
        throw new Error(`Failed to add link: ${error.message}`);
    }
}

export async function deleteLink(state, index) {
    const actualIndex = resolveLinkIndex(state.links, state.filteredLinks[index]);
    if (actualIndex !== -1) {
        state.links.splice(actualIndex, 1);
    }
    state.filteredLinks.splice(index, 1);
    await StorageManager.saveLinks(state.links);
}

export async function bulkDeleteLinks(state, indices) {
    // Sort indices in descending order to avoid index shifting issues
    const sortedIndices = [...indices].sort((a, b) => b - a);
    
    // Collect the actual indices to delete
    const deletionPairs = [];
    sortedIndices.forEach(index => {
        const actualIndex = resolveLinkIndex(state.links, state.filteredLinks[index]);
        if (actualIndex !== -1) {
            deletionPairs.push({ filteredIndex: index, actualIndex });
        }
    });
    
    // Sort by actual indices in descending order to avoid index shifting
    deletionPairs.sort((a, b) => b.actualIndex - a.actualIndex);
    
    // Remove from both arrays
    deletionPairs.forEach(({ filteredIndex, actualIndex }) => {
        state.links.splice(actualIndex, 1);
        state.filteredLinks.splice(filteredIndex, 1);
    });
    
    await StorageManager.saveLinks(state.links);
}

export async function bulkMoveLinks(state, indices, newCategory) {
    // Process indices in reverse order to avoid index shifting issues
    const sortedIndices = [...indices].sort((a, b) => b - a);
    
    for (const index of sortedIndices) {
        const actualIndex = resolveLinkIndex(state.links, state.filteredLinks[index]);
        if (actualIndex !== -1) {
            state.links[actualIndex].category = newCategory;
            state.filteredLinks[index].category = newCategory;
        }
    }
    
    await StorageManager.saveLinks(state.links);
}

export async function bulkChangeSizeLinks(state, indices, newSize) {
    // Process indices in reverse order to avoid index shifting issues
    const sortedIndices = [...indices].sort((a, b) => b - a);
    
    for (const index of sortedIndices) {
        const actualIndex = resolveLinkIndex(state.links, state.filteredLinks[index]);
        if (actualIndex !== -1) {
            if (newSize === 'default') {
                // Remove size property to use global default
                delete state.links[actualIndex].size;
                delete state.filteredLinks[index].size;
            } else {
                // Set specific size
                state.links[actualIndex].size = newSize;
                state.filteredLinks[index].size = newSize;
            }
        }
    }
    
    await StorageManager.saveLinks(state.links);
}

export async function editLink(state, index, name, url, category, icon, size = 'medium') {
    const actualIndex = resolveLinkIndex(state.links, state.filteredLinks[index]);
    if (actualIndex !== -1) {
        // Validate and sanitize inputs
        const sanitizedName = sanitizeUserInput(name, { maxLength: 100 });
        const sanitizedUrl = validateAndSanitizeUrl(url);
        const sanitizedCategory = sanitizeUserInput(category, { maxLength: 50 });

        // Same save-time icon rule as addLink — see validateIconValue.
        const iconCheck = validateIconValue(icon ? sanitizeUserInput(icon, { maxLength: 500 }) : 'default');
        if (!iconCheck.valid) {
            throw new Error(iconCheck.reason);
        }
        const sanitizedIcon = iconCheck.value;

        // Create updated link with sanitized data, preserving the stable id.
        const updatedLink = {
            name: sanitizedName,
            url: sanitizedUrl,
            category: sanitizedCategory,
            icon: sanitizedIcon
        };
        const existingId = state.links[actualIndex] && state.links[actualIndex].id;
        if (existingId != null) {
            updatedLink.id = existingId;
        }

        // Only set size if it's not 'default' - let it use global default
        if (size && size !== 'default') {
            updatedLink.size = size;
        }
        
        // Validate the complete link object
        const validation = validateLink(updatedLink);
        if (!validation.valid) {
            throw new Error(`Link validation failed: ${validation.errors.join(', ')}`);
        }
        
        // Update both arrays
        state.links[actualIndex] = updatedLink;
        state.filteredLinks[index] = updatedLink;
        
        await StorageManager.saveLinks(state.links);
    }
}