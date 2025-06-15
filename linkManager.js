import * as StorageManager from './storageManager.js';

export async function addLink(state, name, url, category, icon) {
    const newLink = { name, url, category, icon };
    state.links.push(newLink);
    state.filteredLinks.push(newLink);
    await StorageManager.saveLinks(state.links);
    console.log('Link added:', newLink);
    console.log('Current state after adding:', state);
}

export async function deleteLink(state, index) {
    const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
    state.links.splice(actualIndex, 1);
    state.filteredLinks.splice(index, 1);
    await StorageManager.saveLinks(state.links);
}

export async function bulkDeleteLinks(state, indices) {
    indices.sort((a, b) => b - a);
    indices.forEach(index => {
        const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
        state.links.splice(actualIndex, 1);
        state.filteredLinks.splice(index, 1);
    });
    await StorageManager.saveLinks(state.links);
}

export async function bulkMoveLinks(state, indices, newCategory) {
    indices.forEach(index => {
        const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
        state.links[actualIndex].category = newCategory;
        state.filteredLinks[index].category = newCategory;
    });
    await StorageManager.saveLinks(state.links);
}

export async function editLink(state, index, name, url, category, icon) {
    const actualIndex = state.links.findIndex(link => link === state.filteredLinks[index]);
    const updatedLink = { name, url, category, icon };
    state.links[actualIndex] = updatedLink;
    state.filteredLinks[index] = updatedLink;
    await StorageManager.saveLinks(state.links);
}