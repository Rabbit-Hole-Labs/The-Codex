import { loadLinks, saveLinks, saveSettings } from './storageManager.js';
import { debounce, sanitizeHTML } from './utils.js';

// State
let state = {
    links: [],
    theme: 'dark',
    view: 'grid',
    searchTerm: '',
};

// DOM Elements
let themeToggle, viewToggle, searchInput, searchSuggestions, linksContainer;

// Functions
async function initializeState() {
    try {
        const loadedState = await loadLinks();
        state = { ...state, ...loadedState };
        applyTheme();
        applyView();
        renderLinks();
        updateSearchSuggestions();
    } catch (error) {
        console.error('Error initializing state:', error);
    }
}

function renderLinks() {
    if (!linksContainer) {
        console.error('Links container not found');
        return;
    }

    const filteredLinks = state.links.filter(link => 
        link.name.toLowerCase().includes(state.searchTerm.toLowerCase()) ||
        link.url.toLowerCase().includes(state.searchTerm.toLowerCase())
    );

    const groupedLinks = groupBy(filteredLinks, 'category');
    
    linksContainer.innerHTML = '';
    
    Object.entries(groupedLinks).forEach(([category, links]) => {
        const section = document.createElement('section');
        section.className = 'category-section fade-in';
        section.innerHTML = `
            <h2>${sanitizeHTML(category)}</h2>
            <div class="links-grid ${state.view === 'list' ? 'list-view' : ''}">
                ${links.map(link => `
                    <a href="${sanitizeHTML(link.url)}" class="link-tile" target="_blank">
                        <img src="${sanitizeHTML(link.icon || 'https://www.google.com/s2/favicons?domain='+link.url)}" alt="" class="link-icon">
                        <h3>${sanitizeHTML(link.name)}</h3>
                    </a>
                `).join('')}
            </div>
        `;
        linksContainer.appendChild(section);
    });

    if (filteredLinks.length === 0) {
        linksContainer.innerHTML = '<p class="no-results">No links found. Try a different search term or <a href="manage.html">add some links</a>.</p>';
    }
}

function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveSettings({ theme: state.theme });
}

function applyTheme() {
    document.body.className = state.theme;
}

function toggleView() {
    state.view = state.view === 'grid' ? 'list' : 'grid';
    applyView();
    saveSettings({ view: state.view });
}

function applyView() {
    const grids = document.querySelectorAll('.links-grid');
    grids.forEach(grid => {
        grid.classList.toggle('list-view', state.view === 'list');
    });
}

// Utility function to group links by category
function groupBy(array, key) {
    return array.reduce((result, currentValue) => {
        (result[currentValue[key]] = result[currentValue[key]] || []).push(currentValue);
        return result;
    }, {});
}

function updateSearchSuggestions() {
    if (!searchSuggestions) return;
    searchSuggestions.innerHTML = '';
    state.links.forEach(link => {
        const option = document.createElement('option');
        option.value = link.name;
        searchSuggestions.appendChild(option);
    });
}

// Initialize DOM elements
function initializeDOMElements() {
    themeToggle = document.getElementById('themeToggle');
    viewToggle = document.getElementById('viewToggle');
    searchInput = document.getElementById('searchInput');
    searchSuggestions = document.getElementById('searchSuggestions');
    linksContainer = document.getElementById('linksContainer');

    console.log('DOM Elements:', { themeToggle, viewToggle, searchInput, searchSuggestions, linksContainer });

    if (!themeToggle) console.warn('Theme toggle button not found');
    if (!viewToggle) console.warn('View toggle button not found');
    if (!searchInput) console.warn('Search input not found');
    if (!searchSuggestions) console.warn('Search suggestions datalist not found');
    if (!linksContainer) console.warn('Links container not found');
}

// Event Listeners
function setupEventListeners() {
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
    if (viewToggle) viewToggle.addEventListener('click', toggleView);
    if (searchInput) {
        searchInput.addEventListener('input', debounce(function(event) {
            console.log('Search input event:', event);
            if (event && event.target) {
                state.searchTerm = event.target.value;
                renderLinks();
            } else {
                console.error('Invalid event object:', event);
            }
        }, 300));
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== searchInput) {
            e.preventDefault();
            searchInput.focus();
        }
    });
}

// Initialize the application
function init() {
    console.log('Initializing application...');
    initializeDOMElements();
    initializeState();
    setupEventListeners();
    console.log('Application initialized.');
}

// Start the application when the DOM is fully loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Log any unhandled errors
window.addEventListener('error', function(event) {
    console.error('Unhandled error:', event.error);
});