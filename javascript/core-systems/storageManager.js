import { syncManager } from './syncManager.js';
import { handleError, CodexError } from '../features/errorHandler.js';
import errorHandler from '../features/errorHandler.js';
const { ERROR_TYPES, ERROR_SEVERITY } = errorHandler;

export async function loadLinks() {
    try {
        console.log('STORAGE_MANAGER: Starting to load links from storage');
        let data = await chrome.storage.sync.get(['links', 'theme', 'view', 'colorTheme', 'defaultTileSize', 'categories']);
        console.log('STORAGE_MANAGER: Raw data loaded from sync storage', {
            hasLinks: !!data.links,
            linksType: data.links ? typeof data.links : 'undefined',
            linksLength: Array.isArray(data.links) ? data.links.length : (typeof data.links === 'string' ? data.links.length : 'N/A'),
            hasCategories: !!data.categories
        });

        if (!data || Object.keys(data).length === 0) {
            console.log('STORAGE_MANAGER: No data in sync storage, trying local storage');
            data = await chrome.storage.local.get(['links', 'theme', 'view', 'colorTheme', 'defaultTileSize', 'categories']);
            console.log('STORAGE_MANAGER: Data loaded from local storage', {
                hasLinks: !!data.links,
                linksType: data.links ? typeof data.links : 'undefined',
                hasCategories: !!data.categories
            });
        }

        // Validate data.links before parsing to handle corruption
        let links = [];
        try {
            if (data.links) {
                console.log('STORAGE_MANAGER: Processing links data', {
                    dataType: typeof data.links,
                    isArray: Array.isArray(data.links)
                });
                
                // Check if links is already an object (corrupted) before trying to parse
                if (typeof data.links === 'object' && !Array.isArray(data.links)) {
                    console.warn('STORAGE_MANAGER: Storage corruption detected: links data is an object instead of string or array', {
                        dataType: typeof data.links,
                        dataKeys: Object.keys(data.links),
                        sampleData: JSON.stringify(data.links).substring(0, 200)
                    });
                    links = [];
                } else if (typeof data.links === 'string') {
                    // Only try to parse if it's a string
                    try {
                        console.log('STORAGE_MANAGER: Attempting to parse links string');
                        const parsedLinks = JSON.parse(data.links);
                        if (Array.isArray(parsedLinks)) {
                            links = parsedLinks;
                            console.log('STORAGE_MANAGER: Successfully parsed links array', {
                                linksCount: links.length
                            });
                        } else {
                            console.warn('STORAGE_MANAGER: Storage corruption detected: parsed links data is not an array', {
                                dataType: typeof parsedLinks,
                                dataValue: typeof parsedLinks === 'object' ? JSON.stringify(parsedLinks).substring(0, 200) : parsedLinks
                            });
                            links = [];
                        }
                    } catch (parseError) {
                        console.error('STORAGE_MANAGER: Storage corruption detected: failed to parse links JSON', {
                            errorMessage: parseError.message,
                            errorStack: parseError.stack,
                            rawData: data.links.substring(0, 100) + (data.links.length > 100 ? '...' : '')
                        });
                        links = [];
                    }
                } else if (Array.isArray(data.links)) {
                    // If it's already an array, use it directly
                    links = data.links;
                    console.log('STORAGE_MANAGER: Links data is already an array', {
                        linksCount: links.length
                    });
                } else {
                    console.warn('STORAGE_MANAGER: Storage corruption detected: links data is of unexpected type', {
                        dataType: typeof data.links,
                        dataValue: typeof data.links === 'object' ? JSON.stringify(data.links).substring(0, 200) : data.links
                    });
                    links = [];
                }
            } else {
                console.log('STORAGE_MANAGER: No links data found in storage');
            }
        } catch (validationError) {
            console.error('STORAGE_MANAGER: Storage validation error: unexpected error during links validation', {
                errorMessage: validationError.message,
                errorStack: validationError.stack
            });
            links = [];
        }

        // Parse categories with similar corruption handling
        let categories = ['Default'];
        try {
            if (data.categories) {
                if (typeof data.categories === 'object' && !Array.isArray(data.categories)) {
                    console.warn('STORAGE_MANAGER: Categories corruption - is object instead of array');
                    categories = ['Default'];
                } else if (typeof data.categories === 'string') {
                    try {
                        const parsedCategories = JSON.parse(data.categories);
                        categories = Array.isArray(parsedCategories) ? parsedCategories : ['Default'];
                    } catch {
                        console.warn('STORAGE_MANAGER: Failed to parse categories JSON');
                        categories = ['Default'];
                    }
                } else if (Array.isArray(data.categories)) {
                    categories = data.categories;
                }
            }
            // Ensure Default category exists
            if (!categories.includes('Default')) {
                categories.unshift('Default');
            }
        } catch (catError) {
            console.error('STORAGE_MANAGER: Categories validation error', catError);
            categories = ['Default'];
        }

        console.log('STORAGE_MANAGER: Final links data ready for return', {
            linksCount: links.length,
            categoriesCount: categories.length,
            hasInvalidLinks: links.some(link => !link || typeof link !== 'object')
        });

        return {
            links: links,
            theme: data.theme || 'dark',
            view: data.view || 'grid',
            colorTheme: data.colorTheme || 'default',
            defaultTileSize: data.defaultTileSize || 'medium',
            categories: categories
        };
    } catch (error) {
        console.error('STORAGE_MANAGER: Storage load error: failed to load data from storage', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return { links: [], theme: 'dark', view: 'grid', colorTheme: 'default', defaultTileSize: 'medium', categories: ['Default'] };
    }
}

export async function saveLinks(links) {
    try {
        // Validate links is an array before saving
        if (!Array.isArray(links)) {
            const validationError = new CodexError(
                'Links validation failed: data must be an array',
                ERROR_TYPES.VALIDATION,
                ERROR_SEVERITY.HIGH,
                {
                    receivedType: typeof links,
                    receivedValue: links
                }
            );
            handleError(validationError, {
                context: 'storage-save-links',
                showUserNotification: true,
                logToConsole: true
            });
            throw validationError;
        }

        const linksString = JSON.stringify(links);

        // Validate data before saving
        if (!linksString) {
            const dataError = new CodexError(
                'Links serialization failed: resulting string is empty',
                ERROR_TYPES.STORAGE,
                ERROR_SEVERITY.HIGH,
                {
                    linksLength: links.length
                }
            );
            handleError(dataError, {
                context: 'storage-save-links',
                showUserNotification: true,
                logToConsole: true
            });
            throw dataError;
        }

        if (linksString.length > 8000) { // Chrome sync item size limit
            const quotaError = new CodexError(
                'Links data exceeds storage quota limit',
                ERROR_TYPES.QUOTA,
                ERROR_SEVERITY.HIGH,
                {
                    dataSize: linksString.length,
                    limit: 8000
                }
            );
            handleError(quotaError, {
                context: 'storage-save-links',
                showUserNotification: true,
                logToConsole: true
            });
            throw quotaError;
        }

        // Try sync storage first (primary storage)
        try {
            await chrome.storage.sync.set({ links: linksString });
        } catch (syncError) {
            console.warn('Sync storage failed, falling back to local storage', {
                errorMessage: syncError.message,
                errorStack: syncError.stack
            });
            
            // Fallback to local storage
            try {
                await chrome.storage.local.set({ links: linksString });
                console.info('Successfully saved to local storage as fallback');
            } catch (localError) {
                const storageError = new CodexError(
                    'Failed to save links to both sync and local storage',
                    ERROR_TYPES.STORAGE,
                    ERROR_SEVERITY.CRITICAL,
                    {
                        syncError: syncError.message,
                        localError: localError.message
                    }
                );
                handleError(storageError, {
                    context: 'storage-save-links',
                    showUserNotification: true,
                    logToConsole: true
                });
                throw storageError;
            }
        }

        return true;
    } catch (error) {
        console.error('Storage save error: failed to save links data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

export async function saveSettings(settings) {
    try {
        const dataToSave = {};

        // Only save valid settings
        if (settings.theme && ['dark', 'light'].includes(settings.theme)) {
            dataToSave.theme = settings.theme;
        }
        if (settings.colorTheme && [
            'default', 'ocean', 'cosmic', 'sunset', 'forest', 'fire', 'aurora',
            'theme-purple', 'theme-pink', 'theme-green', 'theme-orange', 'theme-teal',
            'theme-dark-orange', 'theme-dark-purple', 'theme-dark-emerald', 
            'theme-dark-crimson', 'theme-dark-sapphire'
        ].includes(settings.colorTheme)) {
            dataToSave.colorTheme = settings.colorTheme;
        }
        if (settings.view && ['grid', 'list'].includes(settings.view)) {
            dataToSave.view = settings.view;
        }
        if (settings.defaultTileSize && ['compact', 'small', 'medium', 'large', 'square', 'wide', 'tall', 'giant'].includes(settings.defaultTileSize)) {
            dataToSave.defaultTileSize = settings.defaultTileSize;
        }

        // Validate that we have something to save
        if (Object.keys(dataToSave).length === 0) {
            console.warn('Settings save warning: no valid settings to save', {
                receivedSettings: settings
            });
            return true; // Not an error, just nothing to save
        }

        // Try sync storage first, fallback to local
        try {
            await chrome.storage.sync.set(dataToSave);
        } catch (syncError) {
            console.warn('Sync storage failed for settings, falling back to local storage', {
                errorMessage: syncError.message,
                errorStack: syncError.stack
            });
            
            try {
                await chrome.storage.local.set(dataToSave);
                console.info('Successfully saved settings to local storage as fallback');
            } catch (localError) {
                const storageError = new CodexError(
                    'Failed to save settings to both sync and local storage',
                    ERROR_TYPES.STORAGE,
                    ERROR_SEVERITY.HIGH,
                    {
                        syncError: syncError.message,
                        localError: localError.message
                    }
                );
                handleError(storageError, {
                    context: 'storage-save-settings',
                    showUserNotification: true,
                    logToConsole: true
                });
                throw storageError;
            }
        }

        return true;
    } catch (error) {
        console.error('Storage save error: failed to save settings data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

export async function loadSettings() {
    try {
        let data = await chrome.storage.sync.get(['theme', 'colorTheme', 'view', 'defaultTileSize']);
        if (!data || Object.keys(data).length === 0) {
            data = await chrome.storage.local.get(['theme', 'colorTheme', 'view', 'defaultTileSize']);
        }

        return {
            theme: data.theme || 'dark',
            colorTheme: data.colorTheme || 'default',
            view: data.view || 'grid',
            defaultTileSize: data.defaultTileSize || 'medium'
        };
    } catch (error) {
        console.error('Storage load error: failed to load settings data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return { theme: 'dark', colorTheme: 'default', view: 'grid', defaultTileSize: 'medium' };
    }
}

export async function clearStorage() {
    try {
        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();
        console.info('Storage cleared successfully from both sync and local storage');
        return true;
    } catch (error) {
        console.error('Storage clear error: failed to clear storage', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

// Category management functions
export async function loadCategories() {
    try {
        let data = await chrome.storage.sync.get(['categories']);
        if (!data || !data.categories) {
            data = await chrome.storage.local.get(['categories']);
        }

        let categories = ['Default'];
        try {
            if (data.categories) {
                // Check if categories is already an object (corrupted) before trying to parse
                if (typeof data.categories === 'object' && !Array.isArray(data.categories)) {
                    console.warn('Storage corruption detected: categories data is an object instead of string or array', {
                        dataType: typeof data.categories,
                        dataKeys: Object.keys(data.categories)
                    });
                    categories = ['Default'];
                } else if (typeof data.categories === 'string') {
                    // Only try to parse if it's a string
                    try {
                        const parsedCategories = JSON.parse(data.categories);
                        if (Array.isArray(parsedCategories)) {
                            categories = parsedCategories;
                        } else {
                            console.warn('Storage corruption detected: parsed categories data is not an array', {
                                dataType: typeof parsedCategories,
                                dataValue: parsedCategories
                            });
                            categories = ['Default'];
                        }
                    } catch (parseError) {
                        console.error('Storage corruption detected: failed to parse categories JSON', {
                            errorMessage: parseError.message,
                            errorStack: parseError.stack,
                            rawData: data.categories.substring(0, 100) + (data.categories.length > 100 ? '...' : '')
                        });
                        categories = ['Default'];
                    }
                } else if (Array.isArray(data.categories)) {
                    // If it's already an array, use it directly
                    categories = data.categories;
                } else {
                    console.warn('Storage corruption detected: categories data is of unexpected type', {
                        dataType: typeof data.categories,
                        dataValue: data.categories
                    });
                    categories = ['Default'];
                }
            }
        } catch (validationError) {
            console.error('Storage validation error: unexpected error during categories validation', {
                errorMessage: validationError.message,
                errorStack: validationError.stack
            });
            categories = ['Default'];
        }

        // Ensure Default category exists
        if (!categories.includes('Default')) {
            categories.unshift('Default');
        }

        return categories;
    } catch (error) {
        console.error('Storage load error: failed to load categories from storage', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return ['Default'];
    }
}

export async function saveCategories(categories) {
    try {
        // Validate categories is an array before saving
        if (!Array.isArray(categories)) {
            const validationError = new CodexError(
                'Categories validation failed: data must be an array',
                ERROR_TYPES.VALIDATION,
                ERROR_SEVERITY.HIGH,
                {
                    receivedType: typeof categories,
                    receivedValue: categories
                }
            );
            handleError(validationError, {
                context: 'storage-save-categories',
                showUserNotification: true,
                logToConsole: true
            });
            throw validationError;
        }

        const categoriesString = JSON.stringify(categories);

        // Validate data before saving
        if (!categoriesString) {
            const dataError = new CodexError(
                'Categories serialization failed: resulting string is empty',
                ERROR_TYPES.STORAGE,
                ERROR_SEVERITY.HIGH,
                {
                    categoriesLength: categories.length
                }
            );
            handleError(dataError, {
                context: 'storage-save-categories',
                showUserNotification: true,
                logToConsole: true
            });
            throw dataError;
        }

        if (categoriesString.length > 8000) { // Chrome sync item size limit
            const quotaError = new CodexError(
                'Categories data exceeds storage quota limit',
                ERROR_TYPES.QUOTA,
                ERROR_SEVERITY.HIGH,
                {
                    dataSize: categoriesString.length,
                    limit: 8000
                }
            );
            handleError(quotaError, {
                context: 'storage-save-categories',
                showUserNotification: true,
                logToConsole: true
            });
            throw quotaError;
        }

        // Try sync storage first (primary storage)
        try {
            await chrome.storage.sync.set({ categories: categoriesString });
        } catch (syncError) {
            console.warn('Sync storage failed, falling back to local storage', {
                errorMessage: syncError.message,
                errorStack: syncError.stack
            });
            
            // Fallback to local storage
            try {
                await chrome.storage.local.set({ categories: categoriesString });
                console.info('Successfully saved to local storage as fallback');
            } catch (localError) {
                const storageError = new CodexError(
                    'Failed to save categories to both sync and local storage',
                    ERROR_TYPES.STORAGE,
                    ERROR_SEVERITY.CRITICAL,
                    {
                        syncError: syncError.message,
                        localError: localError.message
                    }
                );
                handleError(storageError, {
                    context: 'storage-save-categories',
                    showUserNotification: true,
                    logToConsole: true
                });
                throw storageError;
            }
        }

        return categories;
    } catch (error) {
        console.error('Storage save error: failed to save categories data', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return ['Default'];
    }
}

// Load complete application state
export async function loadState(initialState = {}) {
    try {
        // Load links and settings
        const linksData = await loadLinks();
        
        // Load categories
        const categories = await loadCategories();
        
        // Merge all data into state
        return {
            ...initialState,
            ...linksData,
            categories: categories,
            filteredLinks: linksData.links || []
        };
    } catch (error) {
        console.error('Storage load error: failed to load complete state', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return {
            ...initialState,
            links: [],
            categories: ['Default'],
            filteredLinks: [],
            theme: 'dark',
            view: 'grid',
            colorTheme: 'default',
            defaultTileSize: 'medium'
        };
    }
}

// Export links as JSON file
export async function exportLinks(state) {
    try {
        const data = {
            links: state.links,
            categories: state.categories,
            theme: state.theme,
            view: state.view,
            colorTheme: state.colorTheme,
            defaultTileSize: state.defaultTileSize,
            exportDate: new Date().toISOString()
        };

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `the-codex-export-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log('Links exported successfully');
        return true;
    } catch (error) {
        console.error('Export error: failed to export links', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return false;
    }
}

// Import links from JSON file
export async function importLinks(state, file) {
    try {
        const reader = new FileReader();
        const fileContent = await new Promise((resolve, reject) => {
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });

        const data = JSON.parse(fileContent);
        
        // Validate imported data - more flexible approach
        let linksToImport = [];
        
        // Check if data.links exists and is an array
        if (data.links && Array.isArray(data.links)) {
            linksToImport = data.links;
        }
        // Check if data itself is an array (root-level links)
        else if (Array.isArray(data)) {
            linksToImport = data;
        }
        // Invalid format
        else {
            throw new Error('Invalid file format: Expected either a "links" array property or root-level array of link objects');
        }

        // Validate each link object
        for (let i = 0; i < linksToImport.length; i++) {
            const link = linksToImport[i];
            if (!link || typeof link !== 'object') {
                throw new Error(`Invalid link at index ${i}: Link must be an object`);
            }
            
            // Check required properties
            if (!link.name || typeof link.name !== 'string') {
                throw new Error(`Invalid link at index ${i}: Link must have a "name" property (string)`);
            }
            
            if (!link.url || typeof link.url !== 'string') {
                throw new Error(`Invalid link at index ${i}: Link must have a "url" property (string)`);
            }
            
            if (!link.category || typeof link.category !== 'string') {
                throw new Error(`Invalid link at index ${i}: Link must have a "category" property (string)`);
            }
            
            // Validate URL format
            try {
                new URL(link.url);
            } catch (urlError) {
                throw new Error(`Invalid link at index ${i}: Link has an invalid URL format`);
            }
        }

        // Update state with imported data
        state.links = linksToImport;
        state.categories = data.categories || ['Default'];
        state.theme = data.theme || 'dark';
        state.view = data.view || 'grid';
        state.colorTheme = data.colorTheme || 'default';
        state.defaultTileSize = data.defaultTileSize || 'medium';

        // Save to storage
        await saveLinks(state.links);
        await saveCategories(state.categories);
        await saveSettings({
            theme: state.theme,
            view: state.view,
            colorTheme: state.colorTheme,
            defaultTileSize: state.defaultTileSize
        });

        console.log('Links imported successfully');
        return true;
    } catch (error) {
        console.error('Import error: failed to import links', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        throw error;
    }
}

// Import bookmarks from browser
export async function importBookmarks(state) {
    try {
        // Get all bookmarks
        const bookmarkTree = await new Promise((resolve) => {
            chrome.bookmarks.getTree(resolve);
        });

        // Extract bookmarks from tree
        const bookmarks = [];
        
        function extractBookmarks(nodes) {
            for (const node of nodes) {
                if (node.url && !node.url.startsWith('javascript:')) {
                    bookmarks.push({
                        name: node.title || 'Untitled',
                        url: node.url,
                        category: 'Bookmarks'
                    });
                }
                if (node.children) {
                    extractBookmarks(node.children);
                }
            }
        }
        
        extractBookmarks(bookmarkTree);

        // Add bookmarks to existing links
        const existingUrls = new Set(state.links.map(link => link.url));
        const newLinks = bookmarks.filter(bookmark => !existingUrls.has(bookmark.url));
        
        state.links = [...state.links, ...newLinks];
        
        // Ensure Bookmarks category exists
        if (!state.categories.includes('Bookmarks')) {
            state.categories.push('Bookmarks');
        }
        
        // Save to storage
        await saveLinks(state.links);
        await saveCategories(state.categories);

        console.log(`Imported ${newLinks.length} bookmarks`);
        return true;
    } catch (error) {
        console.error('Import bookmarks error: failed to import bookmarks', {
            errorMessage: error.message,
            errorStack: error.stack
        });
        throw error;
    }
}