import * as StorageManager from './storageManager.js';
import * as UIManager from './uiManager.js';
import { debug, debugError } from './debug.js';

const defaultCategory = 'Default';

export async function populateCategories(state) {
    try {
        // Get fresh categories from storage to ensure we're up to date
        const savedCategories = await StorageManager.loadCategories();
        state.categories = savedCategories;

        const categories = [...new Set(state.links.map(link => link.category || defaultCategory))];
        if (!categories.includes(defaultCategory)) {
            categories.unshift(defaultCategory);
        }
        state.categories = Array.from(new Set([...state.categories, ...categories]));
        await StorageManager.saveCategories(state.categories);
        UIManager.populateCategoryDropdowns(state.categories);
        debug('Categories after population:', state.categories);
        return state.categories;
    } catch (error) {
        debugError('Error in populateCategories:', error);
        UIManager.showMessage('Failed to update categories. Please try again.', 'error');
        return state.categories;
    }
}

export async function createCategory(state, categoryName) {
    try {
        debug('Creating category:', categoryName);
        debug('Current categories:', state.categories);

        if (!categoryName) {
            UIManager.showMessage('Category name cannot be empty.', 'error');
            return false;
        }

        if (!state.categories.includes(categoryName)) {
            // Get fresh categories from storage first
            const currentCategories = await StorageManager.loadCategories();
            state.categories = currentCategories;

            // Add the new category
            state.categories.push(categoryName);

            // Save to storage
            const savedCategories = await StorageManager.saveCategories(state.categories);
            state.categories = savedCategories;  // Update state with saved categories

            debug('Category created. New categories:', state.categories);

            // Update UI
            await populateCategories(state);
            UIManager.updateCategoryDropdowns(state.categories);
            UIManager.showMessage(`Category "${categoryName}" created successfully.`);
            return true;
        } else {
            debug('Category already exists:', categoryName);
            UIManager.showMessage(`Category "${categoryName}" already exists.`, 'error');
            return false;
        }
    } catch (error) {
        debugError('Error creating category:', error);
        UIManager.showMessage('Failed to create category. Please try again.', 'error');
        return false;
    }
}

export async function renameCategory(state, oldCategory, newCategory) {
    try {
        if (oldCategory === defaultCategory) {
            UIManager.showMessage('Cannot rename the default category.', 'error');
            return false;
        }
        if (state.categories.includes(newCategory)) {
            UIManager.showMessage('Category name already exists.', 'error');
            return false;
        }

        // Get fresh state from storage
        const currentCategories = await StorageManager.loadCategories();
        state.categories = currentCategories;

        const index = state.categories.indexOf(oldCategory);
        if (index !== -1) {
            state.categories[index] = newCategory;
            state.links = state.links.map(link => {
                if (link.category === oldCategory) {
                    return { ...link, category: newCategory };
                }
                return link;
            });
            await StorageManager.saveCategories(state.categories);
            await StorageManager.saveLinks(state.links);
            await populateCategories(state);
            UIManager.filterLinks(state);
            return true;
        }
        return false;
    } catch (error) {
        debugError('Error renaming category:', error);
        UIManager.showMessage('Failed to rename category. Please try again.', 'error');
        return false;
    }
}

export async function deleteCategory(state, categoryToDelete) {
    try {
        if (categoryToDelete === defaultCategory) {
            UIManager.showMessage('Cannot delete the default category.', 'error');
            return false;
        }

        if (confirm(`Are you sure you want to delete the category "${categoryToDelete}"? All links in this category will be moved to the default category.`)) {
            // Get fresh state from storage
            const currentCategories = await StorageManager.loadCategories();
            state.categories = currentCategories;

            state.categories = state.categories.filter(category => category !== categoryToDelete);
            state.links = state.links.map(link => {
                if (link.category === categoryToDelete) {
                    return { ...link, category: defaultCategory };
                }
                return link;
            });

            await StorageManager.saveCategories(state.categories);
            await StorageManager.saveLinks(state.links);
            await populateCategories(state);
            UIManager.filterLinks(state);
            return true;
        }
        return false;
    } catch (error) {
        debugError('Error deleting category:', error);
        UIManager.showMessage('Failed to delete category. Please try again.', 'error');
        return false;
    }
}

/**
 * Reorder categories to a new order
 * @param {Object} state - Application state
 * @param {string[]} newOrder - New category order array
 * @returns {Promise<boolean>} - Success status
 */
export async function reorderCategories(state, newOrder) {
    try {
        // Validate that all categories are included
        const currentCategories = await StorageManager.loadCategories();

        if (newOrder.length !== currentCategories.length) {
            debugError('Category reorder: length mismatch', {
                newOrder: newOrder.length,
                current: currentCategories.length
            });
            UIManager.showMessage('Category order is incomplete.', 'error');
            return false;
        }

        // Check all categories are present
        const missingCategories = currentCategories.filter(c => !newOrder.includes(c));
        if (missingCategories.length > 0) {
            debugError('Category reorder: missing categories', missingCategories);
            UIManager.showMessage('Some categories are missing from the new order.', 'error');
            return false;
        }

        // Save the new order
        state.categories = [...newOrder];
        await StorageManager.saveCategories(state.categories);
        await populateCategories(state);

        debug('Categories reordered successfully:', state.categories);
        UIManager.showMessage('Category order saved successfully.');
        return true;
    } catch (error) {
        debugError('Error reordering categories:', error);
        UIManager.showMessage('Failed to reorder categories. Please try again.', 'error');
        return false;
    }
}

/**
 * Move a category up or down in the order
 * @param {Object} state - Application state
 * @param {string} categoryName - Category to move
 * @param {number} direction - -1 for up, 1 for down
 * @returns {Promise<string[]>} - New category order
 */
export async function moveCategory(state, categoryName, direction) {
    try {
        const currentCategories = await StorageManager.loadCategories();
        const index = currentCategories.indexOf(categoryName);

        if (index === -1) {
            debugError('Category not found for move:', categoryName);
            return currentCategories;
        }

        const newIndex = index + direction;

        // Check bounds
        if (newIndex < 0 || newIndex >= currentCategories.length) {
            return currentCategories;
        }

        // Swap categories
        const newOrder = [...currentCategories];
        [newOrder[index], newOrder[newIndex]] = [newOrder[newIndex], newOrder[index]];

        // Don't save automatically - let the user save
        return newOrder;
    } catch (error) {
        debugError('Error moving category:', error);
        return state.categories;
    }
}