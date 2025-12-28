import { loadCategories, saveCategories, loadLinks, saveLinks } from '../core-systems/storageManager.js';

document.addEventListener('DOMContentLoaded', function() {
    const addSiteForm = document.getElementById('addSiteForm');
    const siteNameInput = document.getElementById('siteName');
    const siteUrlInput = document.getElementById('siteUrl');
    const siteCategorySelect = document.getElementById('siteCategory');
    const messageElement = document.getElementById('message');

    const defaultCategory = 'Default';

    // Apply saved theme
    function applyTheme() {
        chrome.storage.sync.get(['theme', 'colorTheme'], function(data) {
            const theme = data.theme || 'dark';
            const colorTheme = data.colorTheme || 'default';

            let classes = theme;
            if (colorTheme !== 'default') {
                classes += ` ${colorTheme}`;
            }

            document.body.className = classes;
        });
    }

    // Populate the category select using storage manager
    async function populateCategories() {
        try {
            const categories = await loadCategories();

            // Clear existing options
            siteCategorySelect.innerHTML = '<option value="">Select Category</option>';

            // Add categories to select
            categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                siteCategorySelect.appendChild(option);
            });

            // Set default category
            siteCategorySelect.value = defaultCategory;

        } catch (error) {
            console.error('Error populating categories:', error);
            messageElement.textContent = 'Error loading categories. Please try again.';
        }
    }

    // Get the current tab's information
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        siteNameInput.value = currentTab.title;
        siteUrlInput.value = currentTab.url;
    });

    // Add site form submit handler using storage manager
    addSiteForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        const name = siteNameInput.value.trim();
        const url = siteUrlInput.value.trim();
        const category = siteCategorySelect.value || defaultCategory;

        if (name && url) {
            try {
                // Load current links and categories
                const links = await loadLinks();
                const categories = await loadCategories();

                // Add the new link
                links.links.push({ name, url, category });

                // Update categories if needed
                if (!categories.includes(category)) {
                    categories.push(category);
                    await saveCategories(categories);
                }

                // Save the updated links
                await saveLinks(links.links);

                messageElement.textContent = 'Site added successfully!';
                setTimeout(() => window.close(), 1500);

            } catch (error) {
                console.error('Error adding site:', error);
                messageElement.textContent = 'Error adding site. Please try again.';
            }
        } else {
            messageElement.textContent = 'Please fill in all fields.';
        }
    });

    // Initial setup
    applyTheme();
    populateCategories();
});