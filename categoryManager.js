import * as StorageManager from './storageManager.js';
import * as UIManager from './uiManager.js';

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
        console.log('Categories after population:', state.categories);
        return state.categories;
    } catch (error) {
        console.error('Error in populateCategories:', error);
        UIManager.showMessage('Failed to update categories. Please try again.', 'error');
        return state.categories;
    }
}

export async function createCategory(state, categoryName) {
    try {
        console.log('Creating category:', categoryName);
        console.log('Current categories:', state.categories);

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
            
            console.log('Category created. New categories:', state.categories);
            
            // Update UI
            await populateCategories(state);
            UIManager.updateCategoryDropdowns(state.categories);
            UIManager.showMessage(`Category "${categoryName}" created successfully.`);
            return true;
        } else {
            console.log('Category already exists:', categoryName);
            UIManager.showMessage(`Category "${categoryName}" already exists.`, 'error');
            return false;
        }
    } catch (error) {
        console.error('Error creating category:', error);
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
        console.error('Error renaming category:', error);
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
        console.error('Error deleting category:', error);
        UIManager.showMessage('Failed to delete category. Please try again.', 'error');
        return false;
    }
}