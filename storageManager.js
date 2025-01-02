export async function loadLinks() {
    try {
        const data = await chrome.storage.local.get(['links', 'theme', 'view']);
        console.log('Loaded data from local storage:', data);
        return {
            links: JSON.parse(data.links || '[]'),
            theme: data.theme || 'dark',
            view: data.view || 'grid'
        };
    } catch (error) {
        console.error('Error loading links:', error);
        return { links: [], theme: 'dark', view: 'grid' };
    }
}

export async function saveLinks(links) {
    try {
        const linksString = JSON.stringify(links);
        await chrome.storage.local.set({ links: linksString });
        console.log('Links saved to local storage:', linksString);
        return links;
    } catch (error) {
        console.error('Error saving links:', error);
        throw error;
    }
}

export async function saveSettings(settings) {
    try {
        await chrome.storage.local.set(settings);
        console.log('Settings saved to local storage:', settings);
        return settings;
    } catch (error) {
        console.error('Error saving settings:', error);
        throw error;
    }
}

export async function loadState(state) {
    try {
        const data = await chrome.storage.local.get(['links', 'categories']);
        console.log('Raw data from storage:', data); // Debug log
        
        // Parse links with error handling
        try {
            state.links = JSON.parse(data.links || '[]');
        } catch (e) {
            console.error('Error parsing links:', e);
            state.links = [];
        }

        // Parse categories with error handling
        try {
            state.categories = JSON.parse(data.categories || '["Default"]');
        } catch (e) {
            console.error('Error parsing categories:', e);
            state.categories = ['Default'];
        }

        // Ensure Default category exists
        if (!state.categories.includes('Default')) {
            state.categories.unshift('Default');
        }

        state.filteredLinks = state.links;
        console.log('Processed state:', state);
        return state;
    } catch (error) {
        console.error('Error loading state:', error);
        return {
            links: [],
            categories: ['Default'],
            filteredLinks: []
        };
    }
}

export async function saveCategories(categories) {
    try {
        console.log('Saving categories:', categories); // Debug log
        
        // Ensure we have an array
        if (!Array.isArray(categories)) {
            throw new Error('Categories must be an array');
        }

        // Ensure Default category exists
        if (!categories.includes('Default')) {
            categories.unshift('Default');
        }

        // Remove duplicates
        const uniqueCategories = [...new Set(categories)];
        
        // Save as JSON string
        const categoriesString = JSON.stringify(uniqueCategories);
        console.log('Saving categories as string:', categoriesString); // Debug log
        
        await chrome.storage.local.set({ categories: categoriesString });
        
        // Verify save
        const verification = await chrome.storage.local.get(['categories']);
        console.log('Verification of saved categories:', verification); // Debug log
        
        return uniqueCategories;
    } catch (error) {
        console.error('Error saving categories:', error);
        throw error;
    }
}

export async function loadCategories() {
    try {
        const data = await chrome.storage.local.get(['categories']);
        console.log('Loading categories, raw data:', data); // Debug log
        
        let categories;
        try {
            categories = JSON.parse(data.categories || '["Default"]');
        } catch (e) {
            console.error('Error parsing categories:', e);
            categories = ['Default'];
        }

        if (!categories.includes('Default')) {
            categories.unshift('Default');
        }

        console.log('Processed categories:', categories); // Debug log
        return categories;
    } catch (error) {
        console.error('Error loading categories:', error);
        return ['Default'];
    }
}

export function exportLinks(state) {
    try {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.links));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "links.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    } catch (error) {
        console.error('Error exporting links:', error);
        throw error;
    }
}

export async function importLinks(state, file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const importedLinks = JSON.parse(e.target.result);
                state.links = importedLinks;
                await saveLinks(state.links);
                console.log('Links imported:', state.links);
                resolve();
            } catch (error) {
                console.error('Failed to import links:', error);
                reject(error);
            }
        };
        reader.readAsText(file);
    });
}

export async function importBookmarks(state) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.getTree(async function(bookmarkTreeNodes) {
            try {
                processBookmarks(bookmarkTreeNodes, state.links);
                await saveLinks(state.links);
                console.log('Bookmarks imported:', state.links);
                resolve();
            } catch (error) {
                console.error('Error importing bookmarks:', error);
                reject(error);
            }
        });
    });
}

function processBookmarks(nodes, links, parentCategory = 'Imported') {
    nodes.forEach(node => {
        if (node.url) {
            links.push({
                name: node.title,
                url: node.url,
                category: parentCategory
            });
        }
        if (node.children) {
            processBookmarks(node.children, links, node.title);
        }
    });
}