/**
 * Regression tests for manage-page link mutations persisting correctly.
 *
 * getState() returns JSON.parse(JSON.stringify(currentState)), so state.links
 * and state.filteredLinks are disjoint object graphs. The mutation helpers used
 * to map a rendered row back to state.links by object reference (===), which
 * always failed against a cloned snapshot — so delete/bulk-delete/edit removed
 * the row from the on-screen list but silently re-saved the full, unchanged
 * list, and the change vanished on reload. These tests pin the fix.
 */
import {
    deleteLink,
    bulkDeleteLinks,
    bulkMoveLinks,
    editLink
} from '../../javascript/core-systems/linkManager.js';

describe('link mutations persist against JSON-cloned state', () => {
    let saved;

    beforeEach(() => {
        saved = {};
        const setter = (obj) => { Object.assign(saved, obj); return Promise.resolve(); };
        global.chrome = {
            storage: {
                sync: { set: setter, get: () => Promise.resolve({}) },
                local: { set: setter, get: () => Promise.resolve({}) }
            }
        };
    });

    afterEach(() => {
        delete global.chrome;
    });

    // Mimic getState(): links and filteredLinks share values but NOT references.
    function clonedState(links) {
        return JSON.parse(JSON.stringify({ links, filteredLinks: links }));
    }

    const withIds = () => ([
        { id: 'a', name: 'Alpha', url: 'https://a.example.com', category: 'Default', icon: 'default' },
        { id: 'b', name: 'Bravo', url: 'https://b.example.com', category: 'Default', icon: 'default' },
        { id: 'c', name: 'Charlie', url: 'https://c.example.com', category: 'Default', icon: 'default' }
    ]);

    it('deleteLink removes the row from state.links and persists the reduced list', async () => {
        const state = clonedState(withIds());
        await deleteLink(state, 1); // "Bravo"

        expect(state.links.map(l => l.id)).toEqual(['a', 'c']);
        expect(JSON.parse(saved.links).map(l => l.id)).toEqual(['a', 'c']);
    });

    it('bulkDeleteLinks removes multiple rows and persists', async () => {
        const state = clonedState(withIds());
        await bulkDeleteLinks(state, [0, 2]); // Alpha + Charlie

        expect(state.links.map(l => l.id)).toEqual(['b']);
        expect(JSON.parse(saved.links).map(l => l.id)).toEqual(['b']);
    });

    it('bulkMoveLinks re-categorizes the right stored entry', async () => {
        const state = clonedState(withIds());
        await bulkMoveLinks(state, [1], 'Work'); // move Bravo

        const persisted = JSON.parse(saved.links);
        expect(persisted.find(l => l.id === 'b').category).toBe('Work');
        expect(persisted.find(l => l.id === 'a').category).toBe('Default');
    });

    it('editLink updates the right stored entry and keeps its id', async () => {
        const state = clonedState(withIds());
        await editLink(state, 2, 'Charlie Renamed', 'https://c2.example.com', 'Default', 'default');

        const persisted = JSON.parse(saved.links);
        const edited = persisted.find(l => l.id === 'c');
        expect(edited.name).toBe('Charlie Renamed');
        expect(edited.url).toBe('https://c2.example.com/');
        expect(persisted).toHaveLength(3);
    });

    it('falls back to a value match when links have no id', async () => {
        const noIds = [
            { name: 'Alpha', url: 'https://a.example.com', category: 'Default' },
            { name: 'Bravo', url: 'https://b.example.com', category: 'Default' }
        ];
        const state = clonedState(noIds);
        await deleteLink(state, 0); // "Alpha"

        expect(state.links.map(l => l.name)).toEqual(['Bravo']);
        expect(JSON.parse(saved.links).map(l => l.name)).toEqual(['Bravo']);
    });
});
