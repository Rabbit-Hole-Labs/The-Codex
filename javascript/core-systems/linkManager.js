import * as StorageManager from './storageManager.js';
import { sanitizeUserInput, validateLink } from '../features/securityUtils.js';
import { validateAndSanitizeUrl } from '../features/utils.js';

export async function addLink(state, name, url, category, icon, size = 'medium') {
    try {
        // Validate and sanitize inputs
        const sanitizedName = sanitizeUserInput(name, { maxLength: 100 });
        const sanitizedUrl = validateAndSanitizeUrl(url);
        const sanitizedCategory = sanitizeUserInput(category, { maxLength: 50 });
        const sanitizedIcon = icon ? sanitizeUserInput(icon, { maxLength: 500 }) : 'default';

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

        // Create new link with sanitized data
        const newLink = {
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
    const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
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
        const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
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
        const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
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
        const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
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
    const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
    if (actualIndex !== -1) {
        // Validate and sanitize inputs
        const sanitizedName = sanitizeUserInput(name, { maxLength: 100 });
        const sanitizedUrl = validateAndSanitizeUrl(url);
        const sanitizedCategory = sanitizeUserInput(category, { maxLength: 50 });
        const sanitizedIcon = icon ? sanitizeUserInput(icon, { maxLength: 500 }) : 'default';
        
        // Create updated link with sanitized data
        const updatedLink = {
            name: sanitizedName,
            url: sanitizedUrl,
            category: sanitizedCategory,
            icon: sanitizedIcon
        };
        
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