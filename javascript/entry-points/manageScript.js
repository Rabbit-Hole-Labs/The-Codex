import * as LinkManager from '../core-systems/linkManager.js';
import * as CategoryManager from '../core-systems/categoryManager.js';
import * as UIManager from '../core-systems/uiManager.js';
import * as StorageManager from '../core-systems/storageManager.js';
import { syncStatusIndicator } from '../features/syncStatusIndicator.js';
import { syncSettingsController } from '../features/syncSettingsController.js';
import '../features/consoleCommands.js';

// State
let state = {
    links: [],
    categories: ['Default'],  // Initialize with Default category
    currentPage: 1,
    linksPerPage: 20,
    filteredLinks: [],
    editIndex: -1
};

// Early theme application function
async function applyInitialTheme() {
    try {
        const data = await chrome.storage.sync.get(['theme', 'colorTheme']);
        const theme = data.theme || 'dark';
        const colorTheme = data.colorTheme || 'default';

        let classes = theme;
        if (colorTheme !== 'default') {
            classes += ` ${colorTheme}`;
        }

        document.body.className = classes;
    } catch (error) {
        console.error('Error applying initial theme:', error);
        document.body.className = 'dark'; // Fallback
    }
}

// Initialize
async function init() {
    try {
        // Apply theme immediately
        await applyInitialTheme();

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
        elements.bulkSizeBtn.addEventListener('click', handleBulkSizeChange);
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
        setupIconHelperListeners();
        setupLinksViewToggle();
        setupCategoryReorder();

        // Initialize sync status indicator
        syncStatusIndicator.init('sync-status-container');

        // Load and apply current theme settings to management page
        loadCurrentSettings();

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
        const icon = elements.siteIcon.value.trim();
        const category = elements.siteCategory.value.trim() || 'Default';
        const size = elements.siteSize?.value || 'default';

        if (name && url) {
            try { new URL(url); } catch { UIManager.showMessage('Invalid URL.', 'error'); return; }
            await LinkManager.addLink(state, name, url, category, icon, size);
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
            renderCategoryReorderList();
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
            renderCategoryReorderList();
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
            renderCategoryReorderList();
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

async function handleBulkSizeChange() {
    try {
        const elements = UIManager.getElements();
        const selectedIndices = UIManager.getSelectedIndices();
        const newSize = elements.bulkSizeChange.value;

        if (selectedIndices.length === 0) {
            UIManager.showMessage('Please select links to change size.', 'error');
            return;
        }

        if (!newSize) {
            UIManager.showMessage('Please select a size to apply.', 'error');
            return;
        }

        await LinkManager.bulkChangeSizeLinks(state, selectedIndices, newSize);
        elements.selectAllCheckbox.checked = false;
        elements.bulkSizeChange.value = '';
        UIManager.filterLinks(state);
        UIManager.renderLinks(state);

        const sizeLabel = newSize === 'default' ? 'default size' : newSize;
        UIManager.showMessage(`${selectedIndices.length} link(s) changed to ${sizeLabel}.`);
    } catch (error) {
        console.error('Error in handleBulkSizeChange:', error);
        UIManager.showMessage('Failed to change link sizes. Please try again.', 'error');
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
        // Provide more specific error messages based on the error type
        let errorMessage = 'Failed to import links. ';
        if (error.message.includes('Invalid file format')) {
            errorMessage += 'The file format is invalid. Please ensure the file contains either a "links" array property or is a root-level array of link objects.';
        } else if (error.message.includes('Invalid link at index')) {
            errorMessage += error.message;
        } else if (error.message.includes('URL')) {
            errorMessage += 'One or more links have invalid URLs. Please check the URL format in your file.';
        } else {
            errorMessage += 'Please check the file format and try again.';
        }
        UIManager.showMessage(errorMessage, 'error');
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

// Settings Tab Functions
function setupSettingsTab() {
    loadCurrentSettings();
    setupThemeControls();
    setupViewControls();
    setupTileSizeControls();
}

async function loadCurrentSettings() {
    try {
        const data = await chrome.storage.sync.get(['theme', 'colorTheme', 'view', 'defaultTileSize']);
        const theme = data.theme || 'dark';
        const colorTheme = data.colorTheme || 'default';
        const view = data.view || 'grid';
        const defaultTileSize = data.defaultTileSize || 'medium';

        // Update mode toggle
        const modeToggle = document.getElementById('modeToggle');
        const modeLabel = document.getElementById('modeLabel');
        if (modeToggle && modeLabel) {
            modeToggle.classList.toggle('light', theme === 'light');
            modeLabel.textContent = theme === 'light' ? 'Light Mode' : 'Dark Mode';
        }

        // Update default tile size selector
        const defaultTileSizeSelect = document.getElementById('defaultTileSize');
        if (defaultTileSizeSelect) {
            defaultTileSizeSelect.value = defaultTileSize;
        }

        // Update theme preview cards
        updateThemePreviewCards(colorTheme);

        // Update view toggle
        updateViewToggle(view);

        // Apply current theme to management page
        applyTheme(theme, colorTheme);

    } catch (error) {
        console.error('Error loading current settings:', error);
    }
}

function setupThemeControls() {
    // Mode toggle (dark/light)
    const modeToggle = document.getElementById('modeToggle');
    if (modeToggle) {
        modeToggle.addEventListener('click', toggleMode);
    }

    // Color theme select - removed (using cards only)

    // Theme preview cards
    const themeCards = document.querySelectorAll('.theme-preview-card');
    themeCards.forEach(card => {
        card.addEventListener('click', () => {
            const theme = card.dataset.theme;
            setColorTheme(theme);
        });
    });
}

function setupViewControls() {
    const viewToggle = document.getElementById('viewToggle');
    if (viewToggle) {
        const viewOptions = viewToggle.querySelectorAll('.view-option');
        viewOptions.forEach(option => {
            option.addEventListener('click', () => {
                const view = option.dataset.view;
                setView(view);
            });
        });
    }
}

function setupTileSizeControls() {
    const defaultTileSizeSelect = document.getElementById('defaultTileSize');
    if (defaultTileSizeSelect) {
        defaultTileSizeSelect.addEventListener('change', async (e) => {
            const newSize = e.target.value;
            await setDefaultTileSize(newSize);
        });
    }
}

async function toggleMode() {
    try {
        const currentData = await chrome.storage.sync.get(['theme']);
        const currentTheme = currentData.theme || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        await chrome.storage.sync.set({ theme: newTheme });

        // Update UI
        const modeToggle = document.getElementById('modeToggle');
        const modeLabel = document.getElementById('modeLabel');
        if (modeToggle && modeLabel) {
            modeToggle.classList.toggle('light', newTheme === 'light');
            modeLabel.textContent = newTheme === 'light' ? 'Light Mode' : 'Dark Mode';
        }

        // Apply theme
        const colorData = await chrome.storage.sync.get(['colorTheme']);
        const colorTheme = colorData.colorTheme || 'default';
        applyTheme(newTheme, colorTheme);

    } catch (error) {
        console.error('Error toggling mode:', error);
    }
}

async function setColorTheme(theme) {
    try {
        await chrome.storage.sync.set({ colorTheme: theme });

        // Update preview cards
        updateThemePreviewCards(theme);

        // Apply theme
        const themeData = await chrome.storage.sync.get(['theme']);
        const currentMode = themeData.theme || 'dark';
        applyTheme(currentMode, theme);

    } catch (error) {
        console.error('Error setting color theme:', error);
    }
}

async function setView(view) {
    try {
        await chrome.storage.sync.set({ view: view });
        updateViewToggle(view);
    } catch (error) {
        console.error('Error setting view:', error);
    }
}

async function setDefaultTileSize(size) {
    try {
        await chrome.storage.sync.set({ defaultTileSize: size });
        console.log('Default tile size set to:', size);
        // Show confirmation message
        UIManager.showMessage(`Default tile size changed to ${size}`);
    } catch (error) {
        console.error('Error setting default tile size:', error);
        UIManager.showMessage('Failed to save tile size setting', 'error');
    }
}

function updateThemePreviewCards(activeTheme) {
    const cards = document.querySelectorAll('.theme-preview-card');
    cards.forEach(card => {
        card.classList.toggle('active', card.dataset.theme === activeTheme);
    });
}

function updateViewToggle(activeView) {
    const viewOptions = document.querySelectorAll('.view-option');
    viewOptions.forEach(option => {
        option.classList.toggle('active', option.dataset.view === activeView);
    });
}

function applyTheme(theme, colorTheme) {
    // Build class string
    let classes = theme;
    if (colorTheme !== 'default') {
        classes += ` ${colorTheme}`;
    }

    // Apply to body
    document.body.className = classes;
    console.log('Applied theme classes to management page:', classes);
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

            // Initialize controllers when tabs are shown
            if (tabId === 'sync-settings') {
                syncSettingsController.init();
            } else if (tabId === 'settings') {
                setupSettingsTab();
            }
        });
    });
}

// Icon Helper Functions
let currentIconTarget = 'siteIcon';

function setupIconHelperListeners() {
    // Set up event listeners for icon helper buttons
    const iconHelperBtns = document.querySelectorAll('.icon-helper-btn');
    iconHelperBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = btn.getAttribute('data-target') || 'siteIcon';
            showIconHelper(targetId);
        });
    });

    // Set up event listeners for icon source buttons
    const iconSourceBtns = document.querySelectorAll('.icon-source-btn');
    iconSourceBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const source = btn.getAttribute('data-source');
            useIconSource(source);
        });
    });

    // Set up event listener for custom icon button
    const useCustomBtn = document.getElementById('useCustomIconBtn');
    if (useCustomBtn) {
        useCustomBtn.addEventListener('click', (e) => {
            e.preventDefault();
            useCustomIcon();
        });
    }

    // Set up event listener for close button
    const closeBtn = document.getElementById('iconHelperClose');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            closeIconHelper();
        });
    }

    // Set up event listener to close modal when clicking outside
    const modal = document.getElementById('iconHelperModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeIconHelper();
            }
        });
    }
}

function showIconHelper(targetId = 'siteIcon') {
    currentIconTarget = targetId;
    const modal = document.getElementById('iconHelperModal');
    if (modal) {
        // Get the title/name and URL of the item being edited
        const titleText = getTitleForIconHelper(targetId);
        const urlText = getUrlForIconHelper(targetId);

        // Update the modal title to show which item we're selecting an icon for
        const modalTitle = modal.querySelector('h2');
        const contextElement = document.getElementById('iconHelperContext');

        if (modalTitle && titleText) {
            modalTitle.textContent = `Select Icon for: ${titleText}`;
        } else if (modalTitle) {
            modalTitle.textContent = 'Icon Helper';
        }

        // Show additional context information
        if (contextElement) {
            if (titleText && urlText) {
                contextElement.innerHTML = `<strong>Service:</strong> ${titleText}<br><strong>URL:</strong> ${urlText}`;
                contextElement.style.display = 'block';
            } else if (titleText) {
                contextElement.innerHTML = `<strong>Service:</strong> ${titleText}`;
                contextElement.style.display = 'block';
            } else {
                contextElement.style.display = 'none';
            }
        }

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
}

function getTitleForIconHelper(targetId) {
    if (targetId === 'siteIcon') {
        // For the main add form, get the site name input value
        const siteNameInput = document.getElementById('siteName');
        return siteNameInput ? siteNameInput.value.trim() : null;
    } else if (targetId === 'editSiteIcon') {
        // For the edit form, get the edit site name input value
        const editSiteNameInput = document.getElementById('editSiteName');
        return editSiteNameInput ? editSiteNameInput.value.trim() : null;
    }
    return null;
}

function getUrlForIconHelper(targetId) {
    if (targetId === 'siteIcon') {
        // For the main add form, get the site URL input value
        const siteUrlInput = document.getElementById('siteUrl');
        return siteUrlInput ? siteUrlInput.value.trim() : null;
    } else if (targetId === 'editSiteIcon') {
        // For the edit form, get the edit site URL input value
        const editSiteUrlInput = document.getElementById('editSiteUrl');
        return editSiteUrlInput ? editSiteUrlInput.value.trim() : null;
    }
    return null;
}

function closeIconHelper() {
    const modal = document.getElementById('iconHelperModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        // Clear the custom URL input
        const customUrlInput = document.getElementById('customIconUrl');
        if (customUrlInput) {
            customUrlInput.value = '';
        }
    }
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

function useIconSource(source) {
    const targetInput = document.getElementById(currentIconTarget);
    if (targetInput) {
        if (source === 'selfh') {
            // Generate icon URL from title
            const titleText = getTitleForIconHelper(currentIconTarget);
            if (titleText) {
                const iconName = cleanTitleForIcon(titleText);
                if (iconName) {
                    const iconUrl = `https://cdn.jsdelivr.net/gh/selfhst/icons/svg/${iconName}.svg`;
                    targetInput.value = iconUrl;
                    console.log(`Generated icon URL for "${titleText}": ${iconUrl}`);
                } else {
                    targetInput.value = '';
                }
            } else {
                targetInput.value = '';
            }
        } else if (source === 'clear') {
            targetInput.value = '';
        }
        closeIconHelper();
    }
}

function useCustomIcon() {
    const customUrl = document.getElementById('customIconUrl');
    const targetInput = document.getElementById(currentIconTarget);
    if (customUrl && targetInput && customUrl.value) {
        targetInput.value = customUrl.value;
        closeIconHelper();
    }
}

// Links View Toggle Functions
function setupLinksViewToggle() {
    const linksViewToggle = document.getElementById('linksViewToggle');
    if (linksViewToggle) {
        const viewOptions = linksViewToggle.querySelectorAll('.view-option');
        viewOptions.forEach(option => {
            option.addEventListener('click', () => {
                const view = option.dataset.view;
                setLinksView(view);
            });
        });
    }
}

function setLinksView(view) {
    // Update active state
    const viewOptions = document.querySelectorAll('#linksViewToggle .view-option');
    viewOptions.forEach(option => {
        option.classList.toggle('active', option.dataset.view === view);
    });

    // Apply view to links container
    const linksContainer = document.getElementById('linksContainer');
    if (linksContainer) {
        linksContainer.classList.toggle('grid-view', view === 'grid');
        linksContainer.classList.toggle('list-view', view === 'list');
    }

    // Save preference
    try {
        chrome.storage.sync.set({ linksView: view });
    } catch (error) {
        console.error('Error saving links view preference:', error);
    }
}

// Category Reorder Functions
let pendingCategoryOrder = null;
let draggedCategoryItem = null;

function renderCategoryReorderList() {
    const container = document.getElementById('categoryReorderList');
    if (!container) return;

    // Count links per category
    const categoryCounts = {};
    state.links.forEach(link => {
        const cat = link.category || 'Default';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });

    container.innerHTML = state.categories.map((category, index) => `
        <div class="category-reorder-item"
             data-category="${category}"
             draggable="true"
             data-index="${index}">
            <div class="drag-handle">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="9" cy="5" r="1"></circle>
                    <circle cx="9" cy="12" r="1"></circle>
                    <circle cx="9" cy="19" r="1"></circle>
                    <circle cx="15" cy="5" r="1"></circle>
                    <circle cx="15" cy="12" r="1"></circle>
                    <circle cx="15" cy="19" r="1"></circle>
                </svg>
            </div>
            <span class="category-name">${category}</span>
            <span class="category-count">${categoryCounts[category] || 0} links</span>
            <div class="reorder-actions">
                <button type="button" class="reorder-btn move-up" data-category="${category}" ${index === 0 ? 'disabled' : ''}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="18 15 12 9 6 15"></polyline>
                    </svg>
                </button>
                <button type="button" class="reorder-btn move-down" data-category="${category}" ${index === state.categories.length - 1 ? 'disabled' : ''}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    // Clear pending order when re-rendering from storage
    pendingCategoryOrder = null;

    // Setup drag and drop
    setupCategoryDragDrop();

    // Setup arrow buttons
    setupCategoryReorderButtons();
}

function setupCategoryDragDrop() {
    const items = document.querySelectorAll('.category-reorder-item');

    items.forEach(item => {
        item.addEventListener('dragstart', handleCategoryDragStart);
        item.addEventListener('dragend', handleCategoryDragEnd);
        item.addEventListener('dragover', handleCategoryDragOver);
        item.addEventListener('drop', handleCategoryDrop);
        item.addEventListener('dragenter', handleCategoryDragEnter);
        item.addEventListener('dragleave', handleCategoryDragLeave);
    });
}

function handleCategoryDragStart(e) {
    draggedCategoryItem = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.category);
}

function handleCategoryDragEnd() {
    this.classList.remove('dragging');
    document.querySelectorAll('.category-reorder-item').forEach(item => {
        item.classList.remove('drag-over');
    });
    draggedCategoryItem = null;
}

function handleCategoryDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleCategoryDragEnter(e) {
    e.preventDefault();
    if (this !== draggedCategoryItem) {
        this.classList.add('drag-over');
    }
}

function handleCategoryDragLeave() {
    this.classList.remove('drag-over');
}

function handleCategoryDrop(e) {
    e.preventDefault();
    this.classList.remove('drag-over');

    if (this === draggedCategoryItem) return;

    const fromCategory = e.dataTransfer.getData('text/plain');
    const toCategory = this.dataset.category;

    // Get current order
    const currentOrder = pendingCategoryOrder || [...state.categories];
    const fromIndex = currentOrder.indexOf(fromCategory);
    const toIndex = currentOrder.indexOf(toCategory);

    if (fromIndex !== -1 && toIndex !== -1) {
        // Remove from current position
        currentOrder.splice(fromIndex, 1);
        // Insert at new position
        currentOrder.splice(toIndex, 0, fromCategory);

        // Update pending order
        pendingCategoryOrder = currentOrder;

        // Re-render the list
        renderCategoryReorderListWithOrder(currentOrder);
    }
}

function renderCategoryReorderListWithOrder(order) {
    const container = document.getElementById('categoryReorderList');
    if (!container) return;

    // Count links per category
    const categoryCounts = {};
    state.links.forEach(link => {
        const cat = link.category || 'Default';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });

    container.innerHTML = order.map((category, index) => `
        <div class="category-reorder-item"
             data-category="${category}"
             draggable="true"
             data-index="${index}">
            <div class="drag-handle">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="9" cy="5" r="1"></circle>
                    <circle cx="9" cy="12" r="1"></circle>
                    <circle cx="9" cy="19" r="1"></circle>
                    <circle cx="15" cy="5" r="1"></circle>
                    <circle cx="15" cy="12" r="1"></circle>
                    <circle cx="15" cy="19" r="1"></circle>
                </svg>
            </div>
            <span class="category-name">${category}</span>
            <span class="category-count">${categoryCounts[category] || 0} links</span>
            <div class="reorder-actions">
                <button type="button" class="reorder-btn move-up" data-category="${category}" ${index === 0 ? 'disabled' : ''}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="18 15 12 9 6 15"></polyline>
                    </svg>
                </button>
                <button type="button" class="reorder-btn move-down" data-category="${category}" ${index === order.length - 1 ? 'disabled' : ''}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    // Re-setup drag and drop
    setupCategoryDragDrop();
    setupCategoryReorderButtons();
}

function setupCategoryReorderButtons() {
    const moveUpBtns = document.querySelectorAll('.reorder-btn.move-up');
    const moveDownBtns = document.querySelectorAll('.reorder-btn.move-down');

    moveUpBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const category = btn.dataset.category;
            const currentOrder = pendingCategoryOrder || [...state.categories];
            const index = currentOrder.indexOf(category);

            if (index > 0) {
                // Swap with previous
                [currentOrder[index - 1], currentOrder[index]] = [currentOrder[index], currentOrder[index - 1]];
                pendingCategoryOrder = currentOrder;
                renderCategoryReorderListWithOrder(currentOrder);
            }
        });
    });

    moveDownBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const category = btn.dataset.category;
            const currentOrder = pendingCategoryOrder || [...state.categories];
            const index = currentOrder.indexOf(category);

            if (index < currentOrder.length - 1) {
                // Swap with next
                [currentOrder[index], currentOrder[index + 1]] = [currentOrder[index + 1], currentOrder[index]];
                pendingCategoryOrder = currentOrder;
                renderCategoryReorderListWithOrder(currentOrder);
            }
        });
    });
}

async function handleSaveCategoryOrder() {
    const orderToSave = pendingCategoryOrder || state.categories;

    if (pendingCategoryOrder) {
        const success = await CategoryManager.reorderCategories(state, orderToSave);
        if (success) {
            pendingCategoryOrder = null;
            renderCategoryReorderList();
        }
    } else {
        UIManager.showMessage('No changes to save.', 'info');
    }
}

function setupCategoryReorder() {
    const saveBtn = document.getElementById('saveCategoryOrderBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', handleSaveCategoryOrder);
    }

    // Initial render
    renderCategoryReorderList();
}

// Start the application
document.addEventListener('DOMContentLoaded', init);