/**
 * stateManager.updateState / applyStorageValues: the centralized state core.
 * Pins the result shapes, error messages, which options skip which step, and
 * the order validation listeners, history, change listeners and persistence
 * are touched in — including the quirks (a link-validation failure has
 * already recorded history; a throwing change listener leaves the new state
 * applied and reports it as the rollback state).
 *
 * Runs against the real module with the quota-faithful chrome.storage fake.
 */
import { jest } from '@jest/globals';
import { installChromeStorageFake } from '../helpers/chromeStorageFake.js';

const site = (overrides = {}) => ({
    name: 'Plex', url: 'https://plex.example.com/', category: 'Media', ...overrides
});
// Passes the state schema but fails validateLink (control character in name).
const badLink = () => site({ name: 'Bad\u0007' });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

let sm;

beforeEach(async () => {
    installChromeStorageFake();
    jest.resetModules();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    sm = await import('../../javascript/core-systems/stateManager.js');
});

afterEach(() => {
    jest.restoreAllMocks();
});

const syncSets = () => jest.spyOn(chrome.storage.sync, 'set');

describe('updateState', () => {
    test('schema failure: notifies validation listeners, records nothing, returns the rollback state', () => {
        const validation = jest.fn();
        const change = jest.fn();
        sm.default.addStateValidationListener(validation);
        sm.addStateChangeListener(change);
        const updates = { theme: 'neon', view: 'list' };

        const result = sm.updateState(updates);

        expect(result.success).toBe(false);
        expect(result.error).toBe(`State validation failed: theme: Value must be one of: ${['dark', 'light'].join(', ')}`);
        expect(result.rollbackState).toEqual(sm.getState());
        expect(validation).toHaveBeenCalledTimes(1);
        expect(validation).toHaveBeenCalledWith({ valid: false, errors: [expect.stringMatching(/^theme: /)], updates });
        expect(change).not.toHaveBeenCalled();
        expect(sm.default.getStateHistory()).toHaveLength(0);
        expect(sm.getState().view).toBe('grid');
        expect(console.error).not.toHaveBeenCalled();
    });

    test('schema failure without rollbackOnError: throws inside, reported with a null rollback state', () => {
        const validation = jest.fn();
        sm.default.addStateValidationListener(validation);

        const result = sm.updateState({ theme: 'neon' }, { rollbackOnError: false });

        expect(result).toEqual({
            success: false,
            error: expect.stringMatching(/^State validation failed: theme: /),
            rollbackState: null
        });
        expect(validation).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledWith('State update failed:', expect.any(Error));
        expect(sm.default.getStateHistory()).toHaveLength(0);
    });

    test('link validation failure: history is already recorded, state and listeners untouched', () => {
        const validation = jest.fn();
        const change = jest.fn();
        sm.default.addStateValidationListener(validation);
        sm.addStateChangeListener(change);
        const set = syncSets();

        const result = sm.updateState({ links: [site(), badLink()] });

        expect(result.success).toBe(false);
        expect(result.error.startsWith('Link validation failed: Link 1 (Bad\u0007): ')).toBe(true);
        expect(result.rollbackState.links).toEqual([]);
        expect(validation).not.toHaveBeenCalled();
        expect(change).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
        expect(sm.default.getStateHistory()).toHaveLength(1);
        expect(sm.getState().links).toEqual([]);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('link validation failure without rollbackOnError: logged, null rollback state, history recorded', () => {
        const result = sm.updateState({ links: [badLink()] }, { rollbackOnError: false });

        expect(result).toEqual({
            success: false,
            error: expect.stringMatching(/^Link validation failed: Link 0 /),
            rollbackState: null
        });
        expect(console.error).toHaveBeenCalledWith('State update failed:', expect.any(Error));
        expect(sm.default.getStateHistory()).toHaveLength(1);
    });

    test('validate: false skips both schema and link validation', () => {
        const validation = jest.fn();
        sm.default.addStateValidationListener(validation);

        const result = sm.updateState({ theme: 'neon', links: [badLink()] }, { validate: false, skipPersistence: true });

        expect(result.success).toBe(true);
        expect(result.newState.theme).toBe('neon');
        expect(result.newState.links).toEqual([badLink()]);
        expect(validation).not.toHaveBeenCalled();
    });

    test('valid links pass link validation and are applied', () => {
        const result = sm.updateState({ links: [site()] }, { skipPersistence: true });
        expect(result.success).toBe(true);
        expect(sm.getState().links).toEqual([site()]);
    });

    test('success: history first, then change listeners with the full event, then the result', () => {
        const seen = [];
        sm.addStateChangeListener(event => {
            seen.push({ event, historyLength: sm.default.getStateHistory().length });
        });
        const before = sm.getState();

        const result = sm.updateState({ view: 'list', searchTerm: 'x' });

        expect(seen).toHaveLength(1);
        expect(seen[0].historyLength).toBe(1);
        expect(seen[0].event).toEqual({
            previousState: before,
            newState: { ...before, view: 'list', searchTerm: 'x' },
            changes: { view: 'list', searchTerm: 'x' },
            timestamp: expect.any(Number)
        });
        expect(result).toEqual({
            success: true,
            newState: { ...before, view: 'list', searchTerm: 'x' },
            rollbackState: before
        });
        expect(sm.default.getStateHistory()[0].state).toEqual(before);
    });

    test('trackHistory: false records no history', () => {
        sm.updateState({ view: 'list' }, { trackHistory: false, skipPersistence: true });
        expect(sm.default.getStateHistory()).toHaveLength(0);
    });

    test('history keeps the newest 50 entries', () => {
        for (let i = 0; i < 55; i++) sm.updateState({ searchTerm: `s${i}` });
        const history = sm.default.getStateHistory();
        expect(history).toHaveLength(50);
        expect(history[0].state.searchTerm).toBe('s4');
        expect(history[49].state.searchTerm).toBe('s53');
    });

    test('persists only persistent fields, and not with skipPersistence', async () => {
        const set = syncSets();

        sm.updateState({ searchTerm: 'only transient' });
        await flush();
        expect(set).not.toHaveBeenCalled();

        sm.updateState({ theme: 'light' }, { skipPersistence: true });
        await flush();
        expect(set).not.toHaveBeenCalled();

        sm.updateState({ view: 'list', searchTerm: 'y' });
        await flush();
        expect(set).toHaveBeenCalledTimes(1);
        expect(await chrome.storage.sync.get('view')).toEqual({ view: 'list' });
        expect(await chrome.storage.sync.get('searchTerm')).toEqual({});
    });

    test('persistence runs after the change listeners', async () => {
        const order = [];
        const set = syncSets().mockImplementation(async () => { order.push('set'); });
        sm.addStateChangeListener(() => order.push('listener'));

        sm.updateState({ view: 'list' });
        await flush();

        expect(set).toHaveBeenCalled();
        expect(order).toEqual(['listener', 'set']);
    });

    test('a throwing change listener: new state stays applied and is reported as the rollback state', async () => {
        const set = syncSets();
        sm.addStateChangeListener(() => { throw new Error('listener boom'); });
        const later = jest.fn();
        sm.addStateChangeListener(later);

        const result = sm.updateState({ view: 'list' });
        await flush();

        expect(result.success).toBe(false);
        expect(result.error).toBe('listener boom');
        expect(result.rollbackState.view).toBe('list');
        expect(sm.getState().view).toBe('list');
        expect(later).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
        expect(sm.default.getStateHistory()).toHaveLength(1);
        expect(console.error).toHaveBeenCalledWith('State update failed:', expect.any(Error));
    });

    test('a throwing change listener without rollbackOnError reports a null rollback state', () => {
        sm.addStateChangeListener(() => { throw new Error('boom'); });
        const result = sm.updateState({ view: 'list' }, { rollbackOnError: false });
        expect(result).toEqual({ success: false, error: 'boom', rollbackState: null });
    });
});

describe('applyStorageValues', () => {
    test('parses JSON-encoded arrays, passes other persistent values, ignores the rest', () => {
        const updates = sm.applyStorageValues({
            links: JSON.stringify([site()]),
            categories: ['Media'],
            theme: 'light',
            searchTerm: 'ignored',
            somethingElse: 1
        });
        expect(updates).toEqual({ links: [site()], categories: ['Media'], theme: 'light' });
        expect(sm.getState()).toMatchObject({ links: [site()], categories: ['Media'], theme: 'light', searchTerm: '' });
    });

    test('skips a corrupt JSON string', () => {
        expect(sm.applyStorageValues({ links: '{nope', view: 'list' })).toEqual({ view: 'list' });
    });

    test('removed links/categories reset; removed settings and unknown keys are ignored', () => {
        sm.updateState({ links: [site()], categories: ['Media'] }, { skipPersistence: true });
        const updates = sm.applyStorageValues({ links: undefined, categories: undefined, theme: undefined, toString: undefined });
        expect(updates).toEqual({ links: [], categories: ['Default'] });
        expect(sm.getState()).toMatchObject({ links: [], categories: ['Default'], theme: 'dark' });
    });

    test('no updates: no state change and no applied listeners', () => {
        const change = jest.fn();
        const applied = jest.fn();
        sm.addStateChangeListener(change);
        sm.addStorageAppliedListener(applied);

        expect(sm.applyStorageValues({ searchTerm: 'x', theme: undefined })).toEqual({});
        expect(change).not.toHaveBeenCalled();
        expect(applied).not.toHaveBeenCalled();
    });

    test('applies unvalidated, without persisting, with history; then applied listeners get (updates, source)', async () => {
        const set = syncSets();
        const order = [];
        sm.addStateChangeListener(() => order.push('change'));
        sm.addStorageAppliedListener(() => { order.push('throwing'); throw new Error('applied boom'); });
        const applied = jest.fn(() => order.push('applied'));
        sm.addStorageAppliedListener(applied);

        const updates = sm.applyStorageValues({ theme: 'neon' }, { source: 'reload' });
        await flush();

        expect(updates).toEqual({ theme: 'neon' });
        expect(sm.getState().theme).toBe('neon');
        expect(set).not.toHaveBeenCalled();
        expect(sm.default.getStateHistory()).toHaveLength(1);
        expect(order).toEqual(['change', 'throwing', 'applied']);
        expect(applied).toHaveBeenCalledWith({ theme: 'neon' }, 'reload');
        expect(console.error).toHaveBeenCalledWith('Storage-applied listener failed:', expect.any(Error));
    });

    test('source defaults to sync', () => {
        const applied = jest.fn();
        sm.addStorageAppliedListener(applied);
        sm.applyStorageValues({ view: 'list' });
        expect(applied).toHaveBeenCalledWith({ view: 'list' }, 'sync');
    });

    test('claimed fields go, as stored, to their handler grouped per handler; its changes win', () => {
        const linksHandler = jest.fn(() => ({ links: [site()], theme: 'light' }));
        const viewHandler = jest.fn(() => 'not an object');
        sm.claimStorageFields(['links', 'categories'], linksHandler);
        sm.claimStorageFields(['view'], viewHandler);
        sm.claimStorageFields(['colorTheme']); // claimed with no handler: dropped

        const updates = sm.applyStorageValues({
            view: 'list',
            links: '[raw]',
            theme: 'dark',
            categories: undefined,
            colorTheme: 'default'
        }, { source: 'reload' });

        expect(viewHandler).toHaveBeenCalledWith({ view: 'list' }, 'reload');
        expect(linksHandler).toHaveBeenCalledWith({ links: '[raw]', categories: undefined }, 'reload');
        expect(viewHandler.mock.invocationCallOrder[0]).toBeLessThan(linksHandler.mock.invocationCallOrder[0]);
        expect(updates).toEqual({ theme: 'light', links: [site()] });
        expect(Object.keys(updates)).toEqual(['theme', 'links']);
    });

    test('a throwing claimed handler is logged and the rest still apply', () => {
        sm.claimStorageFields(['links'], () => { throw new Error('handler boom'); });
        const updates = sm.applyStorageValues({ links: '[]', view: 'list' });
        expect(updates).toEqual({ view: 'list' });
        expect(console.error).toHaveBeenCalledWith('Claimed storage handler failed:', expect.any(Error));
    });
});
