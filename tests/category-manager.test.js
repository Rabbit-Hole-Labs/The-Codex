/**
 * Comprehensive Category Manager Tests
 * Tests category creation, renaming, deletion, reordering, and population
 */

import { jest } from '@jest/globals';

// Mock chrome.storage globally
const mockStorage = {
    get: jest.fn(),
    set: jest.fn()
};

global.chrome = {
    storage: {
        local: mockStorage,
        sync: mockStorage
    }
};

// Mock UIManager functions globally
const populateCategoryDropdowns = jest.fn();
const updateCategoryDropdowns = jest.fn();
const showMessage = jest.fn();

// Mock window.confirm
global.confirm = jest.fn(() => true);

// Mock debug functions
const debug = jest.fn();
const debugError = jest.fn();

// Mock the modules that categoryManager depends on
jest.unstable_mockModule('../javascript/core-systems/storageManager.js', () => ({
    loadCategories: jest.fn(),
    saveCategories: jest.fn(),
    saveLinks: jest.fn()
}));

jest.unstable_mockModule('../javascript/core-systems/uiManager.js', () => ({
    populateCategoryDropdowns: populateCategoryDropdowns,
    updateCategoryDropdowns: updateCategoryDropdowns,
    showMessage: showMessage,
    filterLinks: jest.fn()
}));

jest.unstable_mockModule('../javascript/core-systems/debug.js', () => ({
    debug: debug,
    debugError: debugError,
    setDebugEnabled: jest.fn(),
    isDebugEnabled: jest.fn()
}));

describe('Category Manager', () => {
    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();
    });

    describe('populateCategories', () => {
        test('should populate categories from storage', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [
                    { id: '1', url: 'https://example1.com', category: 'Work' },
                    { id: '2', url: 'https://example2.com', category: 'Personal' }
                ],
                categories: ['Default']
            };

            storageModule.loadCategories.mockResolvedValue(['Default', 'Work']);
            storageModule.saveCategories.mockResolvedValue(['Default', 'Work', 'Personal']);

            const result = await categoryModule.populateCategories(state);

            expect(storageModule.saveCategories).toHaveBeenCalled();
            expect(populateCategoryDropdowns).toHaveBeenCalled();
        });

        test('should always include Default category', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [
                    { id: '1', url: 'https://example1.com', category: 'Work' }
                ],
                categories: []
            };

            storageModule.loadCategories.mockResolvedValue(['Work']);
            storageModule.saveCategories.mockResolvedValue(['Default', 'Work']);

            await categoryModule.populateCategories(state);

            expect(state.categories).toContain('Default');
        });
    });

    describe('createCategory', () => {
        test('should create new category successfully', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default']
            };

            storageModule.loadCategories.mockResolvedValue(['Default']);
            storageModule.saveCategories.mockResolvedValue(['Default', 'New Category']);

            const result = await categoryModule.createCategory(state, 'New Category');

            expect(result).toBe(true);
            expect(state.categories).toContain('New Category');
            expect(showMessage).toHaveBeenCalledWith('Category "New Category" created successfully.');
        });

        test('should reject duplicate category name', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default', 'Work']
            };

            storageModule.loadCategories.mockResolvedValue(['Default', 'Work']);
            storageModule.saveCategories.mockResolvedValue(['Default', 'Work']);

            const result = await categoryModule.createCategory(state, 'Work');

            expect(result).toBe(false);
            expect(showMessage).toHaveBeenCalledWith('Category "Work" already exists.', 'error');
        });

        test('should reject empty category name', async () => {
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default']
            };

            const result = await categoryModule.createCategory(state, '');

            expect(result).toBe(false);
            expect(showMessage).toHaveBeenCalledWith('Category name cannot be empty.', 'error');
        });
    });

    describe('renameCategory', () => {
        test('should rename category successfully', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default', 'Work']
            };

            storageModule.saveCategories.mockResolvedValue(['Default', 'Office']);
            populateCategoryDropdowns.mockResolvedValue();

            const result = await categoryModule.renameCategory(state, 'Work', 'Office');

            expect(result).toBe(true);
            expect(state.categories).toContain('Office');
            expect(state.categories).not.toContain('Work');
        });

        test('should reject renaming to existing category name', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default', 'Work', 'Personal']
            };

            storageModule.saveCategories.mockResolvedValue(['Default', 'Work', 'Personal']);

            const result = await categoryModule.renameCategory(state, 'Work', 'Personal');

            expect(result).toBe(false);
            expect(showMessage).toHaveBeenCalledWith('Category name already exists.', 'error');
        });
    });

    describe('deleteCategory', () => {
        test('should delete category and move links to Default', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [
                    { id: '1', url: 'https://example1.com', category: 'Work' }
                ],
                categories: ['Default', 'Work']
            };

            // Mock loadCategories to return different values on subsequent calls
            storageModule.loadCategories
                .mockResolvedValueOnce(['Default', 'Work'])  // First call in deleteCategory
                .mockResolvedValueOnce(['Default', 'Work']);  // Second call in populateCategories
            storageModule.saveCategories.mockResolvedValue(['Default']);
            storageModule.saveLinks.mockResolvedValue(true);
            populateCategoryDropdowns.mockResolvedValue();

            const result = await categoryModule.deleteCategory(state, 'Work');

            expect(result).toBe(true);
            // After delete, the link should be moved to Default
            expect(state.links[0].category).toBe('Default');
        });

        test('should not delete Default category', async () => {
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default']
            };

            const result = await categoryModule.deleteCategory(state, 'Default');

            expect(result).toBe(false);
            expect(showMessage).toHaveBeenCalledWith('Cannot delete the default category.', 'error');
        });
    });

    describe('reorderCategories', () => {
        test('should reorder categories successfully', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default', 'Work', 'Personal', 'Music']
            };

            // Mock loadCategories to return current state
            storageModule.loadCategories.mockResolvedValue(['Default', 'Work', 'Personal', 'Music']);
            storageModule.saveCategories.mockResolvedValue(['Music', 'Work', 'Personal', 'Default']);
            populateCategoryDropdowns.mockResolvedValue();

            // Pass actual category names, not indices
            const result = await categoryModule.reorderCategories(state, ['Music', 'Work', 'Personal', 'Default']);

            expect(result).toBe(true);
            expect(storageModule.saveCategories).toHaveBeenCalled();
        });

        test('should reject invalid order array', async () => {
            const storageModule = await import('../javascript/core-systems/storageManager.js');
            const categoryModule = await import('../javascript/core-systems/categoryManager.js');

            const state = {
                links: [],
                categories: ['Default', 'Work']
            };

            storageModule.loadCategories.mockResolvedValue(['Default', 'Work']);
            storageModule.saveCategories.mockResolvedValue(['Default', 'Work']);

            // Pass incomplete order (missing Work)
            const result = await categoryModule.reorderCategories(state, ['Default']);

            expect(result).toBe(false);
        });
    });
});