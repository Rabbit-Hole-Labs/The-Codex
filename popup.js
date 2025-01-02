document.addEventListener('DOMContentLoaded', function() {
    const addSiteForm = document.getElementById('addSiteForm');
    const siteNameInput = document.getElementById('siteName');
    const siteUrlInput = document.getElementById('siteUrl');
    const siteCategorySelect = document.getElementById('siteCategory');
    const messageElement = document.getElementById('message');

    const defaultCategory = 'Default';

    // Populate the category select with proper JSON parsing
    function populateCategories() {
        chrome.storage.local.get(['categories'], function(data) {
            try {
                // Properly parse the JSON stored categories
                let categories = [];
                if (data.categories) {
                    categories = JSON.parse(data.categories);
                } else {
                    categories = [defaultCategory];
                }
                
                // Ensure default category is always present
                if (!categories.includes(defaultCategory)) {
                    categories.unshift(defaultCategory);
                }

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
                
                // Save back the categories if we modified them
                chrome.storage.local.set({ 
                    categories: JSON.stringify(categories) 
                });
                
            } catch (error) {
                console.error('Error populating categories:', error);
                messageElement.textContent = 'Error loading categories. Please try again.';
            }
        });
    }

    // Get the current tab's information
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        siteNameInput.value = currentTab.title;
        siteUrlInput.value = currentTab.url;
    });

    // Add site form submit handler
    addSiteForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const name = siteNameInput.value.trim();
        const url = siteUrlInput.value.trim();
        const category = siteCategorySelect.value || defaultCategory;

        if (name && url) {
            chrome.storage.local.get(['links', 'categories'], function(data) {
                try {
                    let links = JSON.parse(data.links || '[]');
                    let categories = JSON.parse(data.categories || '["Default"]');
                    
                    // Add the new link
                    links.push({ name, url, category });
                    
                    // Update categories if needed
                    if (!categories.includes(category)) {
                        categories.push(category);
                    }

                    // Save both links and categories
                    chrome.storage.local.set({
                        links: JSON.stringify(links),
                        categories: JSON.stringify(categories)
                    }, function() {
                        messageElement.textContent = 'Site added successfully!';
                        setTimeout(() => window.close(), 1500);
                    });
                } catch (error) {
                    console.error('Error adding site:', error);
                    messageElement.textContent = 'Error adding site. Please try again.';
                }
            });
        } else {
            messageElement.textContent = 'Please fill in all fields.';
        }
    });

    // Initial population of categories
    populateCategories();
});