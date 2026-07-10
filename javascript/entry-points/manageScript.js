import { initErrorCapture } from '../features/errorCapture.js';
import { debug } from '../core-systems/debug.js';
import * as LinkManager from '../core-systems/linkManager.js';
import * as CategoryManager from '../core-systems/categoryManager.js';
import * as UIManager from '../core-systems/uiManager.js';
import * as StorageManager from '../core-systems/storageManager.js';
import { getState, safeUpdateState } from '../core-systems/stateManager.js';
import { escapeHtml } from '../features/utils.js';
import { syncStatusIndicator } from '../features/syncStatusIndicator.js';
import { syncSettingsController } from '../features/syncSettingsController.js';
import * as IconPicker from '../features/iconPicker.js';
import '../features/consoleCommands.js';

// Register global error capture as early as possible (manage context).
initErrorCapture('manage');

// State is managed exclusively through stateManager — no local state object.
// Use getState() for reads, safeUpdateState() for writes.

// Early theme application function
async function applyInitialTheme() {
    try {
        const data = await chrome.storage.sync.get(['theme']);
        // Only dark/light — color themes were retired.
        document.body.className = data.theme === 'light' ? 'light' : 'dark';
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

        // Load state into stateManager singleton
        const loadedState = await StorageManager.loadState(getState());
        // Ensure categories is always an array before updating state
        if (loadedState.categories && !Array.isArray(loadedState.categories)) {
            console.warn('Categories loaded as non-array, resetting:', typeof loadedState.categories);
            loadedState.categories = ['Default'];
        }
        if (loadedState.filteredLinks && !Array.isArray(loadedState.filteredLinks)) {
            // Copy, don't alias: filteredLinks must be a distinct array from
            // links so a later single delete doesn't splice one shared array
            // twice. (getState() also deep-clones, but keep the invariant here.)
            loadedState.filteredLinks = [...(loadedState.links || [])];
        }
        safeUpdateState(loadedState, { validate: false, skipPersistence: true });
        debug('Initial state after loading:', getState());

        // Ensure we have the Default category for THIS session (in-memory only).
        // Do NOT persist here: on a fresh install the account's synced categories
        // may not have downloaded yet, so persisting ['Default'] would clobber the
        // user's real categories on every device. The service worker's
        // verifyStorage() heals a missing Default durably and non-destructively
        // (only when categories actually exist), and the next real category edit
        // persists the healed list.
        const currentCategories = getState().categories;
        if (!Array.isArray(currentCategories) || !currentCategories.includes('Default')) {
            const cats = ['Default', ...(Array.isArray(currentCategories) ? currentCategories : [])];
            safeUpdateState({ categories: cats }, { validate: false, skipPersistence: true });
        }

        UIManager.renderLinks(getState());
        // Load-time population must not persist — see populateCategories(persist).
        await CategoryManager.populateCategories(getState(), { persist: false });

        // Event Listeners
        elements.linkForm.addEventListener('submit', handleLinkFormSubmit);
        elements.filterCategory.addEventListener('change', () => UIManager.filterLinks(getState()));
        elements.selectAllCheckbox.addEventListener('change', UIManager.handleSelectAll);
        elements.bulkDeleteBtn.addEventListener('click', handleBulkDelete);
        elements.bulkMoveBtn.addEventListener('click', handleBulkMove);
        elements.bulkSizeBtn.addEventListener('click', handleBulkSizeChange);
        elements.createCategoryForm.addEventListener('submit', handleCreateCategory);
        // Rename and delete are now inline per-row actions in the category list
        // (wired in renderCategoryReorderList), not separate forms.
        elements.prevPageBtn.addEventListener('click', () => UIManager.changePage(getState(), -1));
        elements.nextPageBtn.addEventListener('click', () => UIManager.changePage(getState(), 1));
        elements.exportBtn.addEventListener('click', () => StorageManager.exportLinks(getState()));
        elements.importBtn.addEventListener('click', () => elements.importFile.click());
        elements.importFile.addEventListener('change', handleImport);
        elements.importBookmarksBtn.addEventListener('click', handleImportBookmarks);

        UIManager.setupModalListeners();
        setupTabs();
        setupIconPicker();
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
            await LinkManager.addLink(getState(), name, url, category, icon, size);
            e.target.reset();
            await CategoryManager.populateCategories(getState());
            UIManager.filterLinks(getState());
            UIManager.renderLinks(getState());
            debug('Link added, current state:', getState());
        } else {
            UIManager.showMessage('Please fill in both name and URL.', 'error');
        }
    } catch (error) {
        console.error('Error in handleLinkFormSubmit:', error);
        // Surface the actual reason (e.g. icon-source validation) instead of a
        // generic failure — otherwise a rejected save looks like a random bug.
        UIManager.showMessage(error?.message || 'Failed to add link. Please try again.', 'error');
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

        const created = await CategoryManager.createCategory(getState(), newCategoryName);
        if (created) {
            e.target.reset();
            await CategoryManager.populateCategories(getState());
            renderCategoryReorderList();
            UIManager.showMessage(`Category "${newCategoryName}" created successfully.`);
        }
    } catch (error) {
        console.error('Error in handleCreateCategory:', error);
        UIManager.showMessage('Failed to create category. Please try again.', 'error');
    }
}

async function handleBulkDelete() {
    try {
        const selectedIndices = UIManager.getSelectedIndices(getState());
        if (selectedIndices.length === 0) {
            UIManager.showMessage('Please select links to delete.', 'error');
            return;
        }

        if (confirm(`Are you sure you want to delete ${selectedIndices.length} link(s)?`)) {
            await LinkManager.bulkDeleteLinks(getState(), selectedIndices);
            UIManager.getElements().selectAllCheckbox.checked = false;
            UIManager.filterLinks(getState());
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
        const selectedIndices = UIManager.getSelectedIndices(getState());
        const newCategory = elements.moveCategory.value;

        if (selectedIndices.length === 0) {
            UIManager.showMessage('Please select links to move.', 'error');
            return;
        }

        if (!newCategory) {
            UIManager.showMessage('Please select a category to move the links to.', 'error');
            return;
        }

        await LinkManager.bulkMoveLinks(getState(), selectedIndices, newCategory);
        elements.selectAllCheckbox.checked = false;
        UIManager.filterLinks(getState());
        UIManager.showMessage(`${selectedIndices.length} link(s) moved to "${newCategory}".`);
    } catch (error) {
        console.error('Error in handleBulkMove:', error);
        UIManager.showMessage('Failed to move links. Please try again.', 'error');
    }
}

async function handleBulkSizeChange() {
    try {
        const elements = UIManager.getElements();
        const selectedIndices = UIManager.getSelectedIndices(getState());
        const newSize = elements.bulkSizeChange.value;

        if (selectedIndices.length === 0) {
            UIManager.showMessage('Please select links to change size.', 'error');
            return;
        }

        if (!newSize) {
            UIManager.showMessage('Please select a size to apply.', 'error');
            return;
        }

        await LinkManager.bulkChangeSizeLinks(getState(), selectedIndices, newSize);
        elements.selectAllCheckbox.checked = false;
        elements.bulkSizeChange.value = '';
        UIManager.filterLinks(getState());
        UIManager.renderLinks(getState());

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
            await StorageManager.importLinks(getState(), file);
            await CategoryManager.populateCategories(getState());
            UIManager.filterLinks(getState());
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
        await StorageManager.importBookmarks(getState());
        await CategoryManager.populateCategories(getState());
        UIManager.filterLinks(getState());
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
        const data = await chrome.storage.sync.get(['theme', 'view', 'defaultTileSize', 'colorTheme']);
        const theme = data.theme || 'dark';
        const view = data.view || 'grid';
        const defaultTileSize = data.defaultTileSize || 'medium';

        // Update base-theme segmented control (Dark / Light)
        updateModeToggle(theme);

        // Update default tile size selector
        const defaultTileSizeSelect = document.getElementById('defaultTileSize');
        if (defaultTileSizeSelect) {
            defaultTileSizeSelect.value = defaultTileSize;
        }

        // Update view toggle
        updateViewToggle(view);

        // Apply current theme (dark/light) + accent to management page
        applyTheme(theme);
        applyAccent(data.colorTheme);
        updateAccentPicker(data.colorTheme);

    } catch (error) {
        console.error('Error loading current settings:', error);
    }
}

function setupThemeControls() {
    // Base-theme segmented control (Dark / Light) — each option sets the mode.
    document.querySelectorAll('#modeToggle .view-option[data-mode]').forEach(opt => {
        opt.addEventListener('click', () => setMode(opt.dataset.mode));
    });
    // Accent color swatches
    document.querySelectorAll('#accentPicker .accent-swatch').forEach(btn => {
        btn.addEventListener('click', () => setAccent(btn.dataset.accent));
    });
}

// ---- Accent color (stored in the dormant `colorTheme` field) ----
const ACCENTS = ['slate', 'blue', 'teal', 'violet', 'amber'];
function normalizeAccent(a) { return ACCENTS.includes(a) ? a : 'slate'; }

function applyAccent(accent) {
    const a = normalizeAccent(accent);
    if (a === 'slate') document.body.removeAttribute('data-accent');
    else document.body.setAttribute('data-accent', a);
}

function updateAccentPicker(accent) {
    const a = normalizeAccent(accent);
    document.querySelectorAll('#accentPicker .accent-swatch').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.accent === a);
    });
}

async function setAccent(accent) {
    const a = normalizeAccent(accent);
    try {
        await chrome.storage.sync.set({ colorTheme: a });
        applyAccent(a);
        updateAccentPicker(a);
    } catch (error) {
        console.error('Error setting accent:', error);
    }
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

async function setMode(mode) {
    try {
        await chrome.storage.sync.set({ theme: mode });
        updateModeToggle(mode);
        applyTheme(mode);
    } catch (error) {
        console.error('Error setting mode:', error);
    }
}

function updateModeToggle(mode) {
    document.querySelectorAll('#modeToggle .view-option[data-mode]').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.mode === mode);
    });
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
        debug('Default tile size set to:', size);
        // Show confirmation message
        UIManager.showMessage(`Default tile size changed to ${size}`);
    } catch (error) {
        console.error('Error setting default tile size:', error);
        UIManager.showMessage('Failed to save tile size setting', 'error');
    }
}

function updateViewToggle(activeView) {
    const viewOptions = document.querySelectorAll('.view-option');
    viewOptions.forEach(option => {
        option.classList.toggle('active', option.dataset.view === activeView);
    });
}

function applyTheme(theme) {
    // Only dark/light — color themes were retired.
    document.body.className = theme === 'light' ? 'light' : 'dark';
    debug('Applied theme class to management page:', document.body.className);
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

// Icon Picker — search the selfh.st library with verified previews; only
// icons that actually loaded can be chosen (see features/iconPicker.js).
function setupIconPicker() {
    IconPicker.init({
        getContext: (targetId) => {
            const nameInput = document.getElementById(targetId === 'editSiteIcon' ? 'editSiteName' : 'siteName');
            const urlInput = document.getElementById(targetId === 'editSiteIcon' ? 'editSiteUrl' : 'siteUrl');
            return {
                name: nameInput ? nameInput.value : '',
                url: urlInput ? urlInput.value : ''
            };
        }
    });
    IconPicker.attachPreview('siteIcon', 'siteIconPreview');
    IconPicker.attachPreview('editSiteIcon', 'editSiteIconPreview');
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

// Category list drag state
let draggedCategoryItem = null;

function renderCategoryReorderList() {
    const container = document.getElementById('categoryReorderList');
    if (!container) return;

    const categories = getState().categories;
    if (!Array.isArray(categories)) {
        console.warn('Categories not an array in renderCategoryReorderList:', typeof categories);
        return;
    }

    // Count links per category
    const counts = {};
    getState().links.forEach(link => {
        const cat = link.category || 'Default';
        counts[cat] = (counts[cat] || 0) + 1;
    });

    const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const grip = svg('<circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="19" r="1"></circle>');
    const up = svg('<polyline points="18 15 12 9 6 15"></polyline>');
    const down = svg('<polyline points="6 9 12 15 18 9"></polyline>');
    const pencil = svg('<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>');
    const trash = svg('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>');
    const last = categories.length - 1;

    container.innerHTML = categories.map((rawCategory, index) => {
        const category = escapeHtml(rawCategory);
        const isDefault = rawCategory === 'Default';
        const n = counts[rawCategory] || 0;
        return `
        <li class="cat-row" data-category="${category}" data-index="${index}" draggable="true">
            <span class="grip" title="Drag to reorder">${grip}</span>
            <span class="cat-name" title="Click to rename">${category}${isDefault ? '<span class="default-badge">default</span>' : ''}</span>
            <input type="text" class="mc-field cat-rename" value="${category}" hidden aria-label="Rename category">
            <span class="cat-count">${n} ${n === 1 ? 'link' : 'links'}</span>
            <span class="cat-acts">
                <button type="button" class="mc-icon-btn act-up" title="Move up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${up}</button>
                <button type="button" class="mc-icon-btn act-down" title="Move down" aria-label="Move down" ${index === last ? 'disabled' : ''}>${down}</button>
                <button type="button" class="mc-icon-btn act-rename" title="Rename" aria-label="Rename">${pencil}</button>
                ${isDefault ? '' : `<button type="button" class="mc-icon-btn danger act-delete" title="Delete" aria-label="Delete">${trash}</button>`}
            </span>
        </li>`;
    }).join('');

    wireCategoryRows();
    setupCategoryDragDrop();
}

// Per-row inline rename, delete, and immediate move on the category list.
function wireCategoryRows() {
    const container = document.getElementById('categoryReorderList');
    if (!container) return;

    container.querySelectorAll('.cat-row').forEach(row => {
        const category = row.dataset.category;
        const nameEl = row.querySelector('.cat-name');
        const field = row.querySelector('.cat-rename');

        const startRename = () => { nameEl.hidden = true; field.hidden = false; field.focus(); field.select(); };
        const cancelRename = () => { field.hidden = true; nameEl.hidden = false; };
        const commitRename = () => {
            if (field.hidden) return;
            const newName = field.value.trim();
            field.hidden = true; nameEl.hidden = false;
            if (newName && newName !== category) handleInlineRename(category, newName);
        };

        nameEl.addEventListener('click', startRename);
        row.querySelector('.act-rename').addEventListener('click', startRename);
        field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
        });
        field.addEventListener('blur', commitRename);

        row.querySelector('.act-up').addEventListener('click', () => moveCategoryImmediate(category, -1));
        row.querySelector('.act-down').addEventListener('click', () => moveCategoryImmediate(category, 1));
        const del = row.querySelector('.act-delete');
        if (del) del.addEventListener('click', () => handleInlineDelete(category));
    });
}

async function handleInlineRename(oldName, newName) {
    try {
        const success = await CategoryManager.renameCategory(getState(), oldName, newName);
        if (success) {
            await CategoryManager.populateCategories(getState());
            UIManager.filterLinks(getState());
            UIManager.renderLinks(getState());
            UIManager.showMessage(`Renamed "${oldName}" to "${newName}".`);
        }
    } catch (error) {
        console.error('Inline rename failed:', error);
        UIManager.showMessage('Failed to rename category. Please try again.', 'error');
    }
    renderCategoryReorderList();
}

async function handleInlineDelete(category) {
    if (category === 'Default') return;
    if (!confirm(`Delete the "${category}" category? Its links will move to Default.`)) return;
    try {
        const success = await CategoryManager.deleteCategory(getState(), category);
        if (success) {
            await CategoryManager.populateCategories(getState());
            UIManager.filterLinks(getState());
            UIManager.renderLinks(getState());
            renderCategoryReorderList();
            UIManager.showMessage(`Deleted the "${category}" category.`);
        }
    } catch (error) {
        console.error('Inline delete failed:', error);
        UIManager.showMessage('Failed to delete category. Please try again.', 'error');
    }
}

async function moveCategoryImmediate(category, delta) {
    const order = [...getState().categories];
    const i = order.indexOf(category);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await persistCategoryOrder(order);
}

async function persistCategoryOrder(order) {
    try {
        await CategoryManager.reorderCategories(getState(), order);
    } catch (error) {
        console.error('Reorder failed:', error);
    }
    renderCategoryReorderList();
}

function setupCategoryDragDrop() {
    const items = document.querySelectorAll('#categoryReorderList .cat-row');

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
    document.querySelectorAll('#categoryReorderList .cat-row').forEach(item => {
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

    const order = [...getState().categories];
    const fromIndex = order.indexOf(fromCategory);
    const toIndex = order.indexOf(toCategory);

    if (fromIndex !== -1 && toIndex !== -1) {
        order.splice(fromIndex, 1);
        order.splice(toIndex, 0, fromCategory);
        persistCategoryOrder(order);
    }
}

function setupCategoryReorder() {
    // Reorder, rename and delete are all handled inline in the list; just render.
    renderCategoryReorderList();
}

// Start the application
document.addEventListener('DOMContentLoaded', init);