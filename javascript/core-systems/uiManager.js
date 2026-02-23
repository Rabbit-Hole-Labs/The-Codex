import * as LinkManager from './linkManager.js';
import { sanitizeHTML } from '../features/utils.js';
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

    linksToRender.forEach((link, index) => {
        const div = createLinkElement(link, index, state);
        elements.linksContainer.appendChild(div);
    });

    updatePaginationControls(state);

}

function createLinkElement(link, index, state) {
    const div = document.createElement('div');
    div.className = 'link-item';
    div.innerHTML = `
        <div class="link-checkbox-container">
            <input type="checkbox" class="link-checkbox" value="${index}">
        </div>
        <div class="link-details">
            <span class="link-title">${sanitizeHTML(link.name)}</span>
            <span class="link-category">(${sanitizeHTML(link.category || 'Default')})</span>
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
        window.open(link.url, '_blank');
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

    return div;
}

export function filterLinks(state) {
    const elements = getElements();
    const selectedCategory = elements.filterCategory.value;
    state.filteredLinks = selectedCategory === 'all' ? state.links : state.links.filter(link => link.category === selectedCategory);
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

export function getSelectedIndices() {
    return Array.from(document.querySelectorAll('.link-checkbox:checked'))
                 .map(checkbox => parseInt(checkbox.value));
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
    const defaultOptions = {
        [elements.filterCategory.id]: '<option value="all">All Categories</option>',
        [elements.moveCategory.id]: '<option value="">Select New Category</option>',
        [elements.editCategorySelect.id]: '<option value="">Select Category to Edit</option>',
        [elements.deleteCategorySelect.id]: '<option value="">Select Category to Delete</option>'
    };
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


let modalJustOpened = false;

export function setupModalListeners(state) {
    const elements = getElements();

    // Close button
    elements.closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeEditModal();
    });

    // Click outside modal content to close
    elements.editModal.addEventListener('click', (event) => {
        // Prevent closing if modal was just opened
        if (modalJustOpened) {
            debug('Modal just opened, ignoring click');
            modalJustOpened = false;
            return;
        }

        const modalContent = elements.editModal.querySelector('.modal-content');

        // Check if the click was inside the modal content
        const isInsideContent = modalContent && modalContent.contains(event.target);

        debug('Modal clicked:', {
            target: event.target.className || event.target.tagName,
            targetElement: event.target,
            modalElement: elements.editModal,
            modalContent: modalContent,
            isDirectBackground: event.target === elements.editModal,
            isInsideContent: isInsideContent
        });

        // Only close if clicking outside the modal content (i.e., on the backdrop)
        if (!isInsideContent) {
            debug('Closing modal - clicked outside content');
            closeEditModal();
        }
    });

    // Prevent modal content clicks from bubbling up
    const modalContent = elements.editModal.querySelector('.modal-content');
    if (modalContent) {
        modalContent.addEventListener('click', (e) => {
            debug('Clicked inside modal content - preventing close');
            e.stopPropagation();
        });
    }

    // Form submission
    elements.editForm.addEventListener('submit', (e) => handleEditFormSubmit(e, state));

    // Escape key to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !elements.editModal.classList.contains('hidden')) {
            e.preventDefault();
            closeEditModal();
        }
    });
}

function openEditModal(state, index) {
    const elements = getElements();
    state.editIndex = index;
    const link = state.filteredLinks[state.editIndex];

    debug('Opening edit modal for link:', link);

    elements.editSiteName.value = link.name;
    elements.editSiteUrl.value = link.url;
    elements.editSiteIcon.value = link.icon || '';
    elements.editSiteCategory.value = link.category || 'Default';
    if (elements.editSiteSize) {
        elements.editSiteSize.value = link.size || 'default';
    }

    // Set flag to prevent immediate closing due to event bubbling
    modalJustOpened = true;
    debug('Modal opened, setting flag to prevent immediate close');

    // Remove hidden class and add show class
    elements.editModal.classList.remove('hidden');
    elements.editModal.style.display = 'flex';

    // Reset the flag after a longer delay to ensure all events have settled
    setTimeout(() => {
        modalJustOpened = false;
        debug('Modal flag reset, click-to-close now enabled');
    }, 500);

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

async function handleEditFormSubmit(e, state) {
    e.preventDefault();
    const elements = getElements();
    const name = elements.editSiteName.value;
    const url = elements.editSiteUrl.value;
    const icon = elements.editSiteIcon.value;
    const category = elements.editSiteCategory.value;
    const size = elements.editSiteSize?.value || 'default';
    try { new URL(url); } catch { showMessage('Invalid URL.', 'error'); return; }
    await LinkManager.editLink(state, state.editIndex, name, url, category, icon, size);
    closeEditModal();
    renderLinks(state);
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
