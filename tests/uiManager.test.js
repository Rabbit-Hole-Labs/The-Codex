/**
 * Unit tests for uiManager.js
 * Covers: pagination, category dropdown population, link rendering
 */

function createLinks(count, category = 'Default') {
    return Array.from({ length: count }, (_, i) => ({
        id: `link-${i}`,
        name: `Site ${i}`,
        url: `https://site${i}.com`,
        category,
        icon: null,
        size: null
    }));
}

function makeState(overrides = {}) {
    const links = overrides.links || createLinks(5);
    return {
        links,
        filteredLinks: overrides.filteredLinks || links,
        currentPage: overrides.currentPage || 1,
        linksPerPage: overrides.linksPerPage || 20,
        categories: overrides.categories || ['Default'],
        theme: 'dark',
        colorTheme: 'default',
        view: 'grid',
        searchTerm: '',
        defaultTileSize: 'medium'
    };
}

function setupTestDOM() {
    const ids = {
        linkForm: 'form', linksContainer: 'div', exportBtn: 'button',
        importBtn: 'button', filterCategory: 'select',
        prevPage: 'button', nextPage: 'button', pageInfo: 'span',
        bulkDeleteBtn: 'button', selectAllCheckbox: 'input', moveCategory: 'select',
        bulkMoveBtn: 'button', bulkSizeChange: 'select', bulkSizeBtn: 'button',
        newCategoryName: 'input', editCategoryName: 'input',
        editCategorySelect: 'select', deleteCategorySelect: 'select',
        editSiteName: 'input', editSiteUrl: 'input', editSiteIcon: 'input',
        editSiteCategory: 'select', editSiteSize: 'select',
        siteName: 'input', siteUrl: 'input', siteIcon: 'input',
        siteCategory: 'select', siteSize: 'select',
        importBookmarksBtn: 'button', importFile: 'input'
    };
    document.body.textContent = '';
    for (const [id, tag] of Object.entries(ids)) {
        const el = document.createElement(tag);
        el.id = id;
        if (id === 'selectAllCheckbox') el.type = 'checkbox';
        if (id === 'importFile') el.type = 'file';
        document.body.appendChild(el);
    }
    // Filter default option
    const opt = document.createElement('option');
    opt.value = 'all';
    document.getElementById('filterCategory').appendChild(opt);
    // Forms
    ['createCategoryForm', 'editCategoryForm', 'deleteCategoryForm'].forEach(id => {
        const f = document.createElement('form');
        f.id = id;
        document.body.appendChild(f);
    });
    // Edit modal
    const modal = document.createElement('div');
    modal.id = 'editModal';
    modal.className = 'hidden';
    const close = document.createElement('button');
    close.className = 'close-button';
    modal.appendChild(close);
    const ef = document.createElement('form');
    ef.id = 'editForm';
    modal.appendChild(ef);
    document.body.appendChild(modal);
}

describe('uiManager', () => {
    let UIManager;

    beforeEach(async () => {
        setupTestDOM();
        jest.resetModules();
        UIManager = await import('../javascript/core-systems/uiManager.js');
    });

    describe('Pagination', () => {
        test('renderLinks renders correct number of links for a page', () => {
            const state = makeState({ links: createLinks(25), filteredLinks: createLinks(25), linksPerPage: 10, currentPage: 1 });
            UIManager.renderLinks(state);
            const container = document.getElementById('linksContainer');
            expect(container.children.length).toBe(10);
        });

        test('renderLinks renders remaining links on last page', () => {
            const links = createLinks(25);
            const state = makeState({ links, filteredLinks: links, linksPerPage: 10, currentPage: 3 });
            UIManager.renderLinks(state);
            expect(document.getElementById('linksContainer').children.length).toBe(5);
        });

        // Regression: checkboxes on page 2+ must carry the GLOBAL filteredLinks
        // index (start + offset), not a page-relative 0..N. Previously they
        // reset to 0 each page, so bulk-delete on a later page hit the first
        // page's links and the "last set" could never be deleted.
        test('link checkboxes carry the global filtered index on later pages', () => {
            const links = createLinks(25);
            const state = makeState({ links, filteredLinks: links, linksPerPage: 10, currentPage: 3 });
            UIManager.renderLinks(state);
            const values = Array.from(document.querySelectorAll('.link-checkbox'))
                .map(cb => parseInt(cb.value, 10));
            expect(values).toEqual([20, 21, 22, 23, 24]);
        });

        test('getSelectedIndices with "Select all" spans every page, not just the visible one', () => {
            const links = createLinks(25);
            const state = makeState({ links, filteredLinks: links, linksPerPage: 10, currentPage: 3 });
            UIManager.renderLinks(state);
            document.getElementById('selectAllCheckbox').checked = true;
            const indices = UIManager.getSelectedIndices(state);
            expect(indices).toHaveLength(25);
            expect(indices).toEqual(Array.from({ length: 25 }, (_, i) => i));
        });

        test('getSelectedIndices without "Select all" returns the checked rows by global index', () => {
            const links = createLinks(25);
            const state = makeState({ links, filteredLinks: links, linksPerPage: 10, currentPage: 3 });
            UIManager.renderLinks(state);
            document.getElementById('selectAllCheckbox').checked = false;
            const boxes = document.querySelectorAll('.link-checkbox');
            boxes[0].checked = true; // global 20
            boxes[2].checked = true; // global 22
            expect(UIManager.getSelectedIndices(state).sort((a, b) => a - b)).toEqual([20, 22]);
        });

        test('updatePaginationControls shows correct page info', () => {
            const state = makeState({ filteredLinks: createLinks(50), linksPerPage: 10, currentPage: 3 });
            UIManager.updatePaginationControls(state);
            expect(document.getElementById('pageInfo').textContent).toBe('Page 3 of 5');
        });

        test('updatePaginationControls disables prev on first page', () => {
            const state = makeState({ filteredLinks: createLinks(50), linksPerPage: 10, currentPage: 1 });
            UIManager.updatePaginationControls(state);
            expect(document.getElementById('prevPage').disabled).toBe(true);
            expect(document.getElementById('nextPage').disabled).toBe(false);
        });

        test('updatePaginationControls disables next on last page', () => {
            const state = makeState({ filteredLinks: createLinks(50), linksPerPage: 10, currentPage: 5 });
            UIManager.updatePaginationControls(state);
            expect(document.getElementById('nextPage').disabled).toBe(true);
        });

        test('changePage increments currentPage', () => {
            const state = makeState({ filteredLinks: createLinks(30), linksPerPage: 10, currentPage: 1 });
            UIManager.changePage(state, 1);
            expect(state.currentPage).toBe(2);
        });
    });

    describe('Category Dropdown Population', () => {
        test('populateCategoryDropdowns fills select elements', () => {
            UIManager.populateCategoryDropdowns(['Default', 'Work', 'Social']);
            const siteCategory = document.getElementById('siteCategory');
            expect(siteCategory.options.length).toBeGreaterThanOrEqual(3);
        });

        test('populateCategoryDropdowns handles empty categories', () => {
            expect(() => UIManager.populateCategoryDropdowns([])).not.toThrow();
        });

        test('populateCategoryDropdowns populates filter with All option', () => {
            UIManager.populateCategoryDropdowns(['Default', 'Work']);
            const filter = document.getElementById('filterCategory');
            expect(filter.options.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('Link Rendering', () => {
        test('renderLinks creates link-item elements', () => {
            const state = makeState();
            UIManager.renderLinks(state);
            expect(document.querySelectorAll('.link-item').length).toBe(5);
        });

        test('rendered links have action buttons', () => {
            const state = makeState({ links: createLinks(1), filteredLinks: createLinks(1) });
            UIManager.renderLinks(state);
            const item = document.querySelector('.link-item');
            expect(item.querySelector('.visit-button')).toBeTruthy();
            expect(item.querySelector('.edit-button')).toBeTruthy();
            expect(item.querySelector('.delete-button')).toBeTruthy();
        });

        test('rendered links display name and category', () => {
            const links = [{ id: '1', name: 'Test Site', url: 'https://test.com', category: 'Work', icon: null, size: null }];
            const state = makeState({ links, filteredLinks: links });
            UIManager.renderLinks(state);
            expect(document.querySelector('.link-item').textContent).toContain('Test Site');
        });

        test('filterLinks filters by category', () => {
            const links = [...createLinks(3, 'Work'), ...createLinks(2, 'Social')];
            const state = makeState({ links, filteredLinks: links });
            const filter = document.getElementById('filterCategory');
            filter.textContent = '';
            const opt = document.createElement('option');
            opt.value = 'Work';
            filter.appendChild(opt);
            filter.value = 'Work';
            UIManager.filterLinks(state);
            expect(state.filteredLinks.length).toBe(3);
        });

        // Regression: with the "All Categories" filter, filteredLinks must be a
        // DISTINCT array from links. Aliasing them caused a single delete (which
        // splices both) to remove two links — a data-loss bug triggered after any
        // bulk action or after selecting "All Categories" (both call filterLinks).
        test('filterLinks("all") does not alias filteredLinks to links', () => {
            const links = createLinks(5, 'Work');
            const state = makeState({ links, filteredLinks: links });
            document.getElementById('filterCategory').value = 'all';

            UIManager.filterLinks(state);

            // Same contents...
            expect(state.filteredLinks.map(l => l.id)).toEqual(links.map(l => l.id));
            // ...but NOT the same array object.
            expect(state.filteredLinks).not.toBe(state.links);

            // Proof the two are decoupled: removing one row from filteredLinks
            // must not also remove it from links.
            state.filteredLinks.splice(0, 1);
            expect(state.links.length).toBe(5);
            expect(state.filteredLinks.length).toBe(4);
        });

        test('renderLinks handles empty links', () => {
            const state = makeState({ links: [], filteredLinks: [] });
            expect(() => UIManager.renderLinks(state)).not.toThrow();
        });

        // Regression: Save in the edit modal was a silent no-op. getState()
        // returns a fresh JSON clone per call, so openEditModal stashed
        // editIndex on one clone while the submit handler read it from the
        // init-time clone (undefined → resolveLinkIndex -1 → nothing saved).
        // The modal must operate on the state captured when it was opened.
        test('edit modal Save updates the link captured at open time', async () => {
            const links = createLinks(3);
            const state = makeState({ links, filteredLinks: links });
            const editCategory = document.getElementById('editSiteCategory');
            const opt = document.createElement('option');
            opt.value = 'Default';
            editCategory.appendChild(opt);

            UIManager.setupModalListeners();
            UIManager.renderLinks(state);
            document.querySelectorAll('.link-item')[1]
                .querySelector('.edit-button').click();

            document.getElementById('editSiteName').value = 'Renamed Site';
            document.getElementById('editSiteUrl').value = 'https://site1.com';
            document.getElementById('editSiteIcon').value = '';
            editCategory.value = 'Default';
            document.getElementById('editForm')
                .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(state.links[1].name).toBe('Renamed Site');
            expect(state.filteredLinks[1].name).toBe('Renamed Site');
        });

        test('getSelectedIndices returns checked indices', () => {
            const state = makeState({ links: createLinks(3), filteredLinks: createLinks(3) });
            UIManager.renderLinks(state);
            const checkboxes = document.querySelectorAll('.link-checkbox');
            checkboxes[0].checked = true;
            checkboxes[2].checked = true;
            expect(UIManager.getSelectedIndices()).toEqual([0, 2]);
        });
    });
});
