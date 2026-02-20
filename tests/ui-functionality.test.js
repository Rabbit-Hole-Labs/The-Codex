/**
 * UI Functionality Tests
 * This test suite verifies the user interface functionality of the application
 * including DOM interactions, event handling, and user experience features
 */

import { jest } from '@jest/globals';

// Mock DOM APIs for JSDOM environment
const mockDocument = {
  createElement: jest.fn().mockImplementation((tagName) => {
    return {
      tagName: tagName.toUpperCase(),
      innerHTML: '',
      textContent: '',
      className: '',
      style: {},
      appendChild: jest.fn(),
      addEventListener: jest.fn(),
      setAttribute: jest.fn(),
      getAttribute: jest.fn(),
      querySelector: jest.fn().mockReturnThis(),
      querySelectorAll: jest.fn().mockReturnValue([]),
      remove: jest.fn()
    };
  }),
  getElementById: jest.fn().mockImplementation((id) => {
    return {
      innerHTML: '',
      value: '',
      style: {},
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      querySelector: jest.fn().mockReturnThis(),
      querySelectorAll: jest.fn().mockReturnValue([]),
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        contains: jest.fn().mockReturnValue(false)
      }
    };
  }),
  querySelector: jest.fn().mockImplementation((selector) => {
    return {
      innerHTML: '',
      value: '',
      style: {},
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      querySelector: jest.fn().mockReturnThis(),
      querySelectorAll: jest.fn().mockReturnValue([]),
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        contains: jest.fn().mockReturnValue(false)
      }
    };
  }),
  addEventListener: jest.fn(),
  querySelectorAll: jest.fn().mockReturnValue([])
};

const mockWindow = {
  location: { reload: jest.fn() },
  addEventListener: jest.fn()
};

global.document = mockDocument;
global.window = mockWindow;
global.HTMLElement = class {};

describe('UI Functionality', () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Reset DOM mocks
    mockDocument.createElement.mockClear();
    mockDocument.getElementById.mockClear();
    mockDocument.querySelector.mockClear();
    mockDocument.addEventListener.mockClear();
    mockDocument.querySelectorAll.mockClear();
    mockWindow.addEventListener.mockClear();
  });

  describe('Element Retrieval', () => {
    test('should retrieve all required UI elements', async () => {
      // Import the UI manager
      const { getElements } = await import('../javascript/core-systems/uiManager.js');

      // Mock all element IDs
      const elementIds = [
        'linkForm', 'linksContainer', 'exportBtn', 'importBtn', 'importFile',
        'filterCategory', 'prevPage', 'nextPage', 'pageInfo', 'bulkDeleteBtn',
        'selectAllCheckbox', 'moveCategory', 'bulkMoveBtn', 'bulkSizeChange',
        'bulkSizeBtn', 'createCategoryForm', 'editCategoryForm', 'deleteCategoryForm',
        'editCategorySelect', 'deleteCategorySelect', 'editModal', 'close-button',
        'editForm', 'editSiteName', 'editSiteUrl', 'editSiteIcon', 'editSiteCategory',
        'editSiteSize', 'importBookmarksBtn', 'siteName', 'siteUrl', 'siteIcon',
        'siteCategory', 'siteSize', 'newCategoryName', 'editCategoryName'
      ];

      // Mock getElementById to return mock elements for all IDs
      mockDocument.getElementById.mockImplementation((id) => {
        return elementIds.includes(id) ? {
          innerHTML: '',
          value: '',
          style: {},
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          querySelector: jest.fn().mockReturnThis(),
          querySelectorAll: jest.fn().mockReturnValue([]),
          classList: {
            add: jest.fn(),
            remove: jest.fn(),
            contains: jest.fn().mockReturnValue(false)
          }
        } : null;
      });

      // Get elements
      const elements = getElements();

      // Verify all elements are retrieved
      expect(elements).toBeDefined();
      expect(Object.keys(elements).length).toBe(elementIds.length);
    });
  });

  describe('Link Rendering', () => {
    test('should render links with correct structure', async () => {
      // Import the UI manager
      const { renderLinks } = await import('../javascript/core-systems/uiManager.js');

      // Mock container element
      const mockContainer = {
        innerHTML: '',
        appendChild: jest.fn()
      };
      mockDocument.getElementById.mockReturnValueOnce(mockContainer);

      // Create mock state
      const mockState = {
        links: [
          { name: 'Test Link', url: 'https://example.com', category: 'Test' }
        ],
        filteredLinks: [
          { name: 'Test Link', url: 'https://example.com', category: 'Test' }
        ],
        currentPage: 1,
        linksPerPage: 20
      };

      // Render links
      renderLinks(mockState);

      // Verify links were rendered
      expect(mockContainer.innerHTML).toBe('');
      expect(mockContainer.appendChild).toHaveBeenCalled();
    });

    test('should create link elements with correct structure', async () => {
      // Import the UI manager
      const { createLinkElement } = await import('../javascript/core-systems/uiManager.js');

      // Create a mock link
      const mockLink = {
        name: 'Test Link',
        url: 'https://example.com',
        category: 'Test'
      };

      // Mock the document.createElement to return a proper element structure
      mockDocument.createElement.mockImplementation((tagName) => {
        if (tagName === 'div') {
          return {
            tagName: 'DIV',
            className: '',
            innerHTML: '',
            querySelector: jest.fn().mockImplementation((selector) => {
              return {
                addEventListener: jest.fn()
              };
            }),
            querySelectorAll: jest.fn().mockReturnValue([])
          };
        }
        return {
          tagName: tagName.toUpperCase(),
          innerHTML: '',
          textContent: '',
          className: '',
          style: {},
          appendChild: jest.fn(),
          addEventListener: jest.fn(),
          setAttribute: jest.fn(),
          getAttribute: jest.fn(),
          querySelector: jest.fn().mockReturnThis(),
          querySelectorAll: jest.fn().mockReturnValue([])
        };
      });

      // Create the element
      const element = createLinkElement(mockLink, 0);

      // Verify element structure
      expect(element).toBeDefined();
      expect(element.tagName).toBe('DIV');
      expect(element.className).toBe('link-item');
    });
  });

  describe('Pagination Controls', () => {
    test('should update pagination controls correctly', async () => {
      // Import the UI manager
      const { updatePaginationControls } = await import('../javascript/core-systems/uiManager.js');

      // Mock pagination elements
      const mockPageInfo = { textContent: '' };
      const mockPrevBtn = { disabled: false };
      const mockNextBtn = { disabled: false };

      mockDocument.getElementById.mockImplementation((id) => {
        switch (id) {
          case 'pageInfo': return mockPageInfo;
          case 'prevPage': return mockPrevBtn;
          case 'nextPage': return mockNextBtn;
          default: return null;
        }
      });

      // Create mock state
      const mockState = {
        currentPage: 2,
        filteredLinks: Array(50).fill().map((_, i) => ({ 
          name: `Link ${i}`, 
          url: `https://example${i}.com`, 
          category: 'Test' 
        })),
        linksPerPage: 20
      };

      // Update pagination controls
      updatePaginationControls(mockState);

      // Verify pagination controls were updated
      expect(mockPageInfo.textContent).toBe('Page 2 of 3');
      expect(mockPrevBtn.disabled).toBe(false);
      expect(mockNextBtn.disabled).toBe(false);
    });

    test('should handle edge cases in pagination', async () => {
      // Import the UI manager
      const { updatePaginationControls } = await import('../javascript/core-systems/uiManager.js');

      // Mock pagination elements
      const mockPageInfo = { textContent: '' };
      const mockPrevBtn = { disabled: false };
      const mockNextBtn = { disabled: false };

      mockDocument.getElementById.mockImplementation((id) => {
        switch (id) {
          case 'pageInfo': return mockPageInfo;
          case 'prevPage': return mockPrevBtn;
          case 'nextPage': return mockNextBtn;
          default: return null;
        }
      });

      // Create mock state with no links
      const mockState = {
        currentPage: 1,
        filteredLinks: [],
        linksPerPage: 20
      };

      // Update pagination controls
      updatePaginationControls(mockState);

      // Verify pagination controls for empty state
      expect(mockPageInfo.textContent).toBe('Page 1 of 1');
      expect(mockPrevBtn.disabled).toBe(true);
      expect(mockNextBtn.disabled).toBe(true);
    });
  });

  describe('Category Management UI', () => {
    test('should populate category dropdowns correctly', async () => {
      // Import the UI manager
      const { populateCategoryDropdowns } = await import('../javascript/core-systems/uiManager.js');

      // Mock category dropdown elements
      const mockCategoryElements = [
        { innerHTML: '', appendChild: jest.fn() },
        { innerHTML: '', appendChild: jest.fn() },
        { innerHTML: '', appendChild: jest.fn() }
      ];

      mockDocument.getElementById.mockImplementation((id) => {
        switch (id) {
          case 'siteCategory':
          case 'editSiteCategory':
          case 'filterCategory':
          case 'moveCategory':
          case 'editCategorySelect':
          case 'deleteCategorySelect':
            return mockCategoryElements.shift();
          default:
            return null;
        }
      });

      // Populate category dropdowns
      const categories = ['Default', 'Work', 'Personal'];
      populateCategoryDropdowns(categories);

      // Verify dropdowns were populated
      expect(mockCategoryElements[0].appendChild).toHaveBeenCalledTimes(4); // Default option + 3 categories
    });

    test('should handle empty category list', async () => {
      // Import the UI manager
      const { populateCategoryDropdowns } = await import('../javascript/core-systems/uiManager.js');

      // Mock category dropdown elements
      const mockCategoryElements = [
        { innerHTML: '', appendChild: jest.fn() }
      ];

      mockDocument.getElementById.mockImplementation((id) => {
        switch (id) {
          case 'siteCategory':
          case 'editSiteCategory':
          case 'filterCategory':
          case 'moveCategory':
          case 'editCategorySelect':
          case 'deleteCategorySelect':
            return mockCategoryElements.shift();
          default:
            return null;
        }
      });

      // Populate with empty categories
      populateCategoryDropdowns([]);

      // Should still add default options
      expect(mockCategoryElements[0].appendChild).toHaveBeenCalled();
    });
  });

  describe('User Messages', () => {
    test('should display info messages to user', async () => {
      // Import the UI manager
      const { showMessage } = await import('../javascript/core-systems/uiManager.js');

      // Mock document body
      const mockBody = { appendChild: jest.fn() };
      mockDocument.querySelector.mockReturnValue(mockBody);

      // Show an info message
      showMessage('Test info message', 'info');

      // Verify message was displayed
      expect(mockBody.appendChild).toHaveBeenCalled();
    });

    test('should display error messages with appropriate styling', async () => {
      // Import the UI manager
      const { showMessage } = await import('../javascript/core-systems/uiManager.js');

      // Mock document body
      const mockBody = { appendChild: jest.fn() };
      mockDocument.querySelector.mockReturnValue(mockBody);

      // Show an error message
      showMessage('Test error message', 'error');

      // Verify error message was displayed
      expect(mockBody.appendChild).toHaveBeenCalled();
    });
  });

  describe('Modal Functionality', () => {
    test('should open edit modal with correct data', async () => {
      // Import the UI manager
      const { setupModalListeners } = await import('../javascript/core-systems/uiManager.js');

      // Mock modal elements
      const mockCloseBtn = { addEventListener: jest.fn() };
      const mockEditModal = { 
        addEventListener: jest.fn(),
        querySelector: jest.fn().mockReturnValue({
          addEventListener: jest.fn()
        }),
        classList: {
          remove: jest.fn(),
          add: jest.fn(),
          contains: jest.fn().mockReturnValue(false)
        },
        style: { display: '' }
      };
      const mockEditForm = { addEventListener: jest.fn() };

      mockDocument.getElementById.mockImplementation((id) => {
        switch (id) {
          case 'close-button': return mockCloseBtn;
          case 'editModal': return mockEditModal;
          case 'editForm': return mockEditForm;
          default: return {
            value: '',
            addEventListener: jest.fn()
          };
        }
      });

      mockDocument.addEventListener.mockImplementation((event, handler) => {
        // Mock escape key handling
        if (event === 'keydown') {
          handler({ key: 'Escape', preventDefault: jest.fn() });
        }
      });

      // Setup modal listeners
      const mockState = {};
      setupModalListeners(mockState);

      // Verify listeners were set up
      expect(mockCloseBtn.addEventListener).toHaveBeenCalled();
      expect(mockEditModal.addEventListener).toHaveBeenCalled();
      expect(mockEditForm.addEventListener).toHaveBeenCalled();
    });
  });

  describe('Selection Management', () => {
    test('should handle select all functionality', async () => {
      // Import the UI manager
      const { handleSelectAll } = await import('../javascript/core-systems/uiManager.js');

      // Mock select all checkbox and link checkboxes
      const mockSelectAllCheckbox = { checked: true };
      const mockLinkCheckboxes = [
        { checked: false },
        { checked: false },
        { checked: false }
      ];

      mockDocument.getElementById.mockReturnValue(mockSelectAllCheckbox);
      mockDocument.querySelectorAll.mockReturnValue(mockLinkCheckboxes);

      // Handle select all
      handleSelectAll();

      // Verify all checkboxes were selected
      mockLinkCheckboxes.forEach(checkbox => {
        expect(checkbox.checked).toBe(true);
      });
    });

    test('should get selected indices correctly', async () => {
      // Import the UI manager
      const { getSelectedIndices } = await import('../javascript/core-systems/uiManager.js');

      // Mock checked checkboxes
      const mockCheckedCheckboxes = [
        { value: '0' },
        { value: '2' },
        { value: '5' }
      ];

      mockDocument.querySelectorAll.mockReturnValue(mockCheckedCheckboxes);

      // Get selected indices
      const indices = getSelectedIndices();

      // Verify indices were retrieved correctly
      expect(indices).toEqual([0, 2, 5]);
    });
  });
});