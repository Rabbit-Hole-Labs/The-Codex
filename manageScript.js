import * as LinkManager from './linkManager.js';
import * as CategoryManager from './categoryManager.js';
import * as UIManager from './uiManager.js';
import * as StorageManager from './storageManager.js';

// State
let state = {
    links: [],
    categories: ['Default'],  // Initialize with Default category
    currentPage: 1,
    linksPerPage: 20,
    filteredLinks: [],
    editIndex: -1
};

// Initialize
async function init() {
    try {
        const elements = UIManager.getElements();
        
        state = await StorageManager.loadState(state);
        console.log('Initial state after loading:', state);
        
        // Ensure we have the Default category
        if (!state.categories.includes('Default')) {
            state.categories.unshift('Default');
            await StorageManager.saveCategories(state.categories);
        }
        
        UIManager.renderLinks(state);
        await CategoryManager.populateCategories(state);

        // Event Listeners
        elements.linkForm.addEventListener('submit', handleLinkFormSubmit);
        elements.filterCategory.addEventListener('change', () => UIManager.filterLinks(state));
        elements.selectAllCheckbox.addEventListener('change', UIManager.handleSelectAll);
        elements.bulkDeleteBtn.addEventListener('click', handleBulkDelete);
        elements.bulkMoveBtn.addEventListener('click', handleBulkMove);
        elements.createCategoryForm.addEventListener('submit', handleCreateCategory);
        elements.editCategoryForm.addEventListener('submit', handleEditCategory);
        elements.deleteCategoryForm.addEventListener('submit', handleDeleteCategory);
        elements.prevPageBtn.addEventListener('click', () => UIManager.changePage(state, -1));
        elements.nextPageBtn.addEventListener('click', () => UIManager.changePage(state, 1));
        elements.exportBtn.addEventListener('click', () => StorageManager.exportLinks(state));
        elements.importBtn.addEventListener('click', () => elements.importFile.click());
        elements.importFile.addEventListener('change', handleImport);
        elements.importBookmarksBtn.addEventListener('click', handleImportBookmarks);

        UIManager.setupModalListeners(state);
        setupTabs();

    } catch (error) {
        console.error('Error in init:', error);
        UIManager.showMessage('Failed to initialize application. Please refresh the page.', 'error');
    }
}

async function handleLinkFormSubmit(e) {
    e.preventDefault();
    try {
        const elements = UIManager.getElements();
        const name = elements.siteName.value.trim();
        const url = elements.siteUrl.value.trim();
        const category = elements.siteCategory.value.trim() || 'Default';
        
        if (name && url) {
            await LinkManager.addLink(state, name, url, category);
            e.target.reset();
            await CategoryManager.populateCategories(state);
            UIManager.filterLinks(state);
            UIManager.renderLinks(state);
            console.log('Link added, current state:', state);
        } else {
            UIManager.showMessage('Please fill in both name and URL.', 'error');
        }
    } catch (error) {
        console.error('Error in handleLinkFormSubmit:', error);
        UIManager.showMessage('Failed to add link. Please try again.', 'error');
    }
}

async function handleCreateCategory(e) {
    e.preventDefault();
    try {
        const newCategoryName = UIManager.getElements().newCategoryName.value.trim();
        if (!newCategoryName) {
            UIManager.showMessage('Please enter a category name.', 'error');
            return;
        }
        
        const created = await CategoryManager.createCategory(state, newCategoryName);
        if (created) {
            e.target.reset();
            await CategoryManager.populateCategories(state);
            UIManager.showMessage(`Category "${newCategoryName}" created successfully.`);
        }
    } catch (error) {
        console.error('Error in handleCreateCategory:', error);
        UIManager.showMessage('Failed to create category. Please try again.', 'error');
    }
}

async function handleEditCategory(e) {
    e.preventDefault();
    try {
        const elements = UIManager.getElements();
        const oldCategory = elements.editCategorySelect.value;
        const newCategory = elements.editCategoryName.value.trim();
        
        if (!oldCategory || !newCategory) {
            UIManager.showMessage('Please select a category and enter a new name.', 'error');
            return;
        }

        const success = await CategoryManager.renameCategory(state, oldCategory, newCategory);
        if (success) {
            e.target.reset();
            UIManager.showMessage(`Category "${oldCategory}" renamed to "${newCategory}".`);
        }
    } catch (error) {
        console.error('Error in handleEditCategory:', error);
        UIManager.showMessage('Failed to edit category. Please try again.', 'error');
    }
}

async function handleDeleteCategory(e) {
    e.preventDefault();
    try {
        const categoryToDelete = UIManager.getElements().deleteCategorySelect.value;
        if (!categoryToDelete) {
            UIManager.showMessage('Please select a category to delete.', 'error');
            return;
        }

        const success = await CategoryManager.deleteCategory(state, categoryToDelete);
        if (success) {
            e.target.reset();
            UIManager.showMessage(`Category "${categoryToDelete}" deleted successfully.`);
        }
    } catch (error) {
        console.error('Error in handleDeleteCategory:', error);
        UIManager.showMessage('Failed to delete category. Please try again.', 'error');
    }
}

async function handleBulkDelete() {
    try {
        const selectedIndices = UIManager.getSelectedIndices();
        if (selectedIndices.length === 0) {
            UIManager.showMessage('Please select links to delete.', 'error');
            return;
        }

        if (confirm(`Are you sure you want to delete ${selectedIndices.length} link(s)?`)) {
            await LinkManager.bulkDeleteLinks(state, selectedIndices);
            UIManager.getElements().selectAllCheckbox.checked = false;
            UIManager.filterLinks(state);
            UIManager.showMessage('Selected links deleted successfully.');
        }
    } catch (error) {
        console.error('Error in handleBulkDelete:', error);
        UIManager.showMessage('Failed to delete links. Please try again.', 'error');
    }
}

async function handleBulkMove() {
    try {
        const elements = UIManager.getElements();
        const selectedIndices = UIManager.getSelectedIndices();
        const newCategory = elements.moveCategory.value;

        if (selectedIndices.length === 0) {
            UIManager.showMessage('Please select links to move.', 'error');
            return;
        }

        if (!newCategory) {
            UIManager.showMessage('Please select a category to move the links to.', 'error');
            return;
        }

        await LinkManager.bulkMoveLinks(state, selectedIndices, newCategory);
        elements.selectAllCheckbox.checked = false;
        UIManager.filterLinks(state);
        UIManager.showMessage(`${selectedIndices.length} link(s) moved to "${newCategory}".`);
    } catch (error) {
        console.error('Error in handleBulkMove:', error);
        UIManager.showMessage('Failed to move links. Please try again.', 'error');
    }
}

async function handleImport(event) {
    try {
        const file = event.target.files[0];
        if (file) {
            await StorageManager.importLinks(state, file);
            await CategoryManager.populateCategories(state);
            UIManager.filterLinks(state);
            UIManager.showMessage('Links imported successfully.');
            event.target.value = ''; // Reset file input
        }
    } catch (error) {
        console.error('Error in handleImport:', error);
        UIManager.showMessage('Failed to import links. Please check the file format and try again.', 'error');
    }
}

async function handleImportBookmarks() {
    try {
        await StorageManager.importBookmarks(state);
        await CategoryManager.populateCategories(state);
        UIManager.filterLinks(state);
        UIManager.showMessage('Bookmarks imported successfully.');
    } catch (error) {
        console.error('Error in handleImportBookmarks:', error);
        UIManager.showMessage('Failed to import bookmarks. Please try again.', 'error');
    }
}

function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.getAttribute('data-tab');
            
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            button.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        });
    });
}

// Start the application
document.addEventListener('DOMContentLoaded', init);