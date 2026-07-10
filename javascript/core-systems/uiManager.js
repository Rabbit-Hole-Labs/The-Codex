import * as LinkManager from './linkManager.js';
import { escapeHtml, validateAndSanitizeUrl } from '../features/utils.js';
import { debug, debugError } from './debug.js';

export function getElements() {
    return {
        linkForm: document.getElementById('linkForm'),
        linksContainer: document.getElementById('linksContainer'),
        exportBtn: document.getElementById('exportBtn'),
        importBtn: document.getElementById('importBtn'),
        importFile: document.getElementById('importFile'),
        filterCategory: document.getElementById('filterCategory'),
        prevPageBtn: document.getElementById('prevPage'),
        nextPageBtn: document.getElementById('nextPage'),
        pageInfo: document.getElementById('pageInfo'),
        bulkDeleteBtn: document.getElementById('bulkDeleteBtn'),
        selectAllCheckbox: document.getElementById('selectAllCheckbox'),
        moveCategory: document.getElementById('moveCategory'),
        bulkMoveBtn: document.getElementById('bulkMoveBtn'),
        bulkSizeChange: document.getElementById('bulkSizeChange'),
        bulkSizeBtn: document.getElementById('bulkSizeBtn'),
        createCategoryForm: document.getElementById('createCategoryForm'),
        editCategoryForm: document.getElementById('editCategoryForm'),
        deleteCategoryForm: document.getElementById('deleteCategoryForm'),
        editCategorySelect: document.getElementById('editCategorySelect'),
        deleteCategorySelect: document.getElementById('deleteCategorySelect'),
        editModal: document.getElementById('editModal'),
        closeBtn: document.querySelector('.close-button'),
        editForm: document.getElementById('editForm'),
        editSiteName: document.getElementById('editSiteName'),
        editSiteUrl: document.getElementById('editSiteUrl'),
        editSiteIcon: document.getElementById('editSiteIcon'),
        editSiteCategory: document.getElementById('editSiteCategory'),
        editSiteSize: document.getElementById('editSiteSize'),
        importBookmarksBtn: document.getElementById('importBookmarksBtn'),
        siteName: document.getElementById('siteName'),
        siteUrl: document.getElementById('siteUrl'),
        siteIcon: document.getElementById('siteIcon'),
        siteCategory: document.getElementById('siteCategory'),
        siteSize: document.getElementById('siteSize'),
        newCategoryName: document.getElementById('newCategoryName'),
        editCategoryName: document.getElementById('editCategoryName')
    };
}

export function renderLinks(state) {
    const elements = getElements();
    elements.linksContainer.innerHTML = '';
    const start = (state.currentPage - 1) * state.linksPerPage;
    const end = start + state.linksPerPage;
    const linksToRender = state.filteredLinks.slice(start, end);

    debug('Rendering links:', linksToRender);

    // Pass the GLOBAL index into filteredLinks (start + offset), not the
    // page-relative offset — otherwise every checkbox on page 2+ carries the
    // same 0..N values as page 1, and delete/edit/bulk act on the wrong (first
    // page) links. Keep any active "Select all" reflected on freshly-rendered
    // pages too.
    const selectAllActive = elements.selectAllCheckbox && elements.selectAllCheckbox.checked;
    linksToRender.forEach((link, offset) => {
        const div = createLinkElement(link, start + offset, state);
        if (selectAllActive) {
            const cb = div.querySelector('.link-checkbox');
            if (cb) cb.checked = true;
        }
        elements.linksContainer.appendChild(div);
    });

    updatePaginationControls(state);
    updateLinksSummary(state);

}

// Dynamic "N links across M categories." line under the Manage Links heading.
function updateLinksSummary(state) {
    const summary = document.getElementById('linksSummary');
    if (!summary) return;
    const total = (state.links || []).length;
    const catCount = new Set((state.links || []).map(l => l.category || 'Default')).size;
    const linkWord = total === 1 ? 'link' : 'links';
    const catWord = catCount === 1 ? 'category' : 'categories';
    summary.textContent = `${total} ${linkWord} across ${catCount} ${catWord}.`;
}

function createLinkElement(link, index, state) {
    const div = document.createElement('div');
    div.className = 'link-item';
    div.innerHTML = `
        <div class="link-checkbox-container">
            <input type="checkbox" class="link-checkbox" value="${index}">
        </div>
        <div class="link-details">
            <span class="link-title">${escapeHtml(link.name)}</span>
            <span class="link-category">${escapeHtml(link.category || 'Default')}</span>
        </div>
        <div class="link-actions">
            <button class="visit-button">Visit</button>
            <button class="edit-button">Edit</button>
            <button class="delete-button">Delete</button>
        </div>
    `;

    div.querySelector('.visit-button').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        // Validate the scheme before opening (blocks javascript:/data:); use
        // noopener so the opened tab cannot reach back via window.opener.
        const safeUrl = validateAndSanitizeUrl(link.url);
        if (safeUrl !== '#') {
            window.open(safeUrl, '_blank', 'noopener');
        }
    });
    div.querySelector('.edit-button').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.stopImmediatePropagation();
        openEditModal(state, index);
    });
    div.querySelector('.delete-button').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        deleteLink(state, index);
    });

    // Unchecking any row drops out of the all-pages "Select all" selection.
    div.querySelector('.link-checkbox').addEventListener('change', (e) => {
        const master = getElements().selectAllCheckbox;
        if (master && !e.target.checked) master.checked = false;
    });

    return div;
}

export function filterLinks(state) {
    const elements = getElements();
    const selectedCategory = elements.filterCategory.value;
    // filteredLinks must always be a DISTINCT array from links. The 'all' case
    // used to assign `state.links` directly, aliasing the two arrays; a later
    // single delete then spliced both state.links and state.filteredLinks — the
    // same object — twice, removing two links instead of one (data loss). The
    // filter() branch already returns a fresh array; spread the 'all' branch so
    // it does too.
    state.filteredLinks = selectedCategory === 'all'
        ? [...state.links]
        : state.links.filter(link => link.category === selectedCategory);
    state.currentPage = 1;
    debug('Filtered links:', state.filteredLinks);
    renderLinks(state);
}

export function updatePaginationControls(state) {
    const elements = getElements();
    const totalPages = Math.ceil(state.filteredLinks.length / state.linksPerPage);
    elements.pageInfo.textContent = `Page ${state.currentPage} of ${totalPages}`;
    elements.prevPageBtn.disabled = state.currentPage === 1;
    elements.nextPageBtn.disabled = state.currentPage === totalPages;
}

export function changePage(state, direction) {
    state.currentPage += direction;
    renderLinks(state);
}

export function handleSelectAll() {
    const elements = getElements();
    document.querySelectorAll('.link-checkbox').forEach(checkbox => {
        checkbox.checked = elements.selectAllCheckbox.checked;
    });
}

export function getSelectedIndices(state) {
    const elements = getElements();
    // "Select all" means every filtered link across ALL pages, not just the
    // checkboxes rendered on the current page.
    if (state && elements.selectAllCheckbox && elements.selectAllCheckbox.checked) {
        return state.filteredLinks.map((_, i) => i);
    }
    return Array.from(document.querySelectorAll('.link-checkbox:checked'))
                 .map(checkbox => parseInt(checkbox.value, 10));
}

export function populateCategoryDropdowns(categories) {
    const elements = getElements();
    const categoryElements = [
        elements.siteCategory,
        elements.editSiteCategory,
        elements.filterCategory,
        elements.moveCategory,
        elements.editCategorySelect,
        elements.deleteCategorySelect
    ];

    categoryElements.forEach(element => {
        if (element) {
            element.innerHTML = getDefaultOptionForElement(element);
            categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                element.appendChild(option);
            });
        }
    });
}

function getDefaultOptionForElement(element) {
    const elements = getElements();
    // Some category selects (edit/delete) were removed when the Categories tab
    // moved to inline per-row actions, so guard against missing elements.
    const defaultOptions = {};
    if (elements.filterCategory) defaultOptions[elements.filterCategory.id] = '<option value="all">All Categories</option>';
    if (elements.moveCategory) defaultOptions[elements.moveCategory.id] = '<option value="">Move selected to…</option>';
    if (elements.editCategorySelect) defaultOptions[elements.editCategorySelect.id] = '<option value="">Select Category to Edit</option>';
    if (elements.deleteCategorySelect) defaultOptions[elements.deleteCategorySelect.id] = '<option value="">Select Category to Delete</option>';
    return defaultOptions[element.id] || '';
}

export function showMessage(message, type = 'info') {
    const messageElement = document.createElement('div');
    messageElement.textContent = message;
    messageElement.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: ${type === 'error' ? '#ff4444' : '#333'};
        color: #fff;
        border: 1px solid ${type === 'error' ? '#cc0000' : '#555'};
        padding: 10px;
        border-radius: 5px;
        z-index: 1000;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    `;
    document.body.appendChild(messageElement);
    setTimeout(() => {
        messageElement.remove();
    }, 3000);
}


export function setupModalListeners() {
    const elements = getElements();

    // Close button
    elements.closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeEditModal();
    });

    // Clicking the backdrop deliberately does NOT close the modal — an
    // accidental click outside the dialog was dismissing it and silently
    // discarding the user's edits. Closing is explicit: ×, Escape, or Save.

    // Form submission — operates on the state captured by openEditModal, not
    // the init-time snapshot passed to setupModalListeners.
    elements.editForm.addEventListener('submit', (e) => handleEditFormSubmit(e));

    // Escape closes one layer at a time: when the icon picker is open on top
    // of this modal, its own handler closes it and the edit modal stays.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || elements.editModal.classList.contains('hidden')) {
            return;
        }
        const picker = document.getElementById('iconHelperModal');
        if (picker && !picker.classList.contains('hidden')) {
            return;
        }
        e.preventDefault();
        closeEditModal();
    });
}

// The state snapshot and row index the edit modal is operating on. These must
// be captured at open time: getState() returns a fresh JSON clone per call,
// so stashing editIndex on one clone (openEditModal) and reading it from
// another (the init-time clone captured by setupModalListeners) left
// state.editIndex undefined at submit — Save silently edited nothing.
let editModalState = null;
let editModalIndex = -1;

function openEditModal(state, index) {
    const elements = getElements();
    editModalState = state;
    editModalIndex = index;
    const link = state.filteredLinks[index];

    debug('Opening edit modal for link:', link);

    elements.editSiteName.value = link.name;
    elements.editSiteUrl.value = link.url;
    elements.editSiteIcon.value = link.icon || '';
    // Programmatic value changes don't fire 'input' — nudge the live icon
    // preview chip so it reflects the link being edited.
    elements.editSiteIcon.dispatchEvent(new Event('input', { bubbles: true }));
    elements.editSiteCategory.value = link.category || 'Default';
    if (elements.editSiteSize) {
        elements.editSiteSize.value = link.size || 'default';
    }

    elements.editModal.classList.remove('hidden');
    elements.editModal.style.display = 'flex';

    // Focus the first input
    setTimeout(() => {
        elements.editSiteName.focus();
    }, 150);
}

function closeEditModal() {
    const elements = getElements();
    debug('Closing edit modal');

    // Add hidden class and hide
    elements.editModal.classList.add('hidden');
    elements.editModal.style.display = 'none';

    // Clear form
    elements.editForm.reset();
}

async function handleEditFormSubmit(e) {
    e.preventDefault();
    const state = editModalState;
    if (!state || editModalIndex < 0) {
        closeEditModal();
        return;
    }
    const elements = getElements();
    const name = elements.editSiteName.value;
    const url = elements.editSiteUrl.value;
    const icon = elements.editSiteIcon.value;
    const category = elements.editSiteCategory.value;
    const size = elements.editSiteSize?.value || 'default';
    try { new URL(url); } catch { showMessage('Invalid URL.', 'error'); return; }
    try {
        await LinkManager.editLink(state, editModalIndex, name, url, category, icon, size);
    } catch (error) {
        // Keep the modal open and show the actual reason (e.g. icon-source
        // validation) — previously a rejected save failed silently.
        showMessage(error?.message || 'Failed to save changes.', 'error');
        return;
    }
    closeEditModal();
    renderLinks(state);
    showMessage('Link updated.');
}

export function deleteLink(state, index) {
    if (confirm('Are you sure you want to delete this link?')) {
        LinkManager.deleteLink(state, index);
        renderLinks(state);
    }
}



export function updateCategoryDropdowns(categories) {
    const elements = getElements();
    const categoryDropdowns = [
        elements.siteCategory,
        elements.editSiteCategory,
        elements.filterCategory,
        elements.moveCategory,
        elements.editCategorySelect,
        elements.deleteCategorySelect
    ];

    categoryDropdowns.forEach(dropdown => {
        if (dropdown) {
            const currentValue = dropdown.value;
            dropdown.innerHTML = getDefaultOptionForElement(dropdown);
            categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                dropdown.appendChild(option);
            });
            dropdown.value = currentValue || '';
        }
    });
}
