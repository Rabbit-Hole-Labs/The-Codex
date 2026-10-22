/**
 * Named locks for read-modify-writes of chrome.storage.local that several
 * extension contexts make (withStorageLock), and the one most of them use:
 * one lock around the local-storage writes that pending-sync markers depend on
 * (see storageFormat.js): a save's fallback write (its value plus marker) and
 * a manual sync's local phase (read the markers, write the kept copy, settle
 * the markers). Holding it, a fallback save can't land between the sync's
 * marker read and its settle, where the sync would overwrite the value or drop
 * the new marker.
 *
 * Uses the Web Locks API, which is shared by every extension page and the
 * service worker; where that isn't available, a queue within this page.
 */

const LOCK_NAME = 'codex-pending-sync';
const queues = new Map(); // lock name -> this page's fallback queue

/**
 * Run `task` while holding the named lock, across every extension context
 * where Web Locks are available (else within this page).
 * @param {string} name
 * @param {() => Promise<*>} task
 * @returns {Promise<*>} the task's result
 */
export function withStorageLock(name, task) {
    if (globalThis.navigator?.locks?.request) {
        return globalThis.navigator.locks.request(name, task);
    }
    const run = (queues.get(name) ?? Promise.resolve()).then(task, task);
    queues.set(name, run.catch(() => {}));
    return run;
}

/**
 * Run `task` while holding the pending-sync lock.
 * @param {() => Promise<*>} task
 * @returns {Promise<*>} the task's result
 */
export function withPendingSyncLock(task) {
    return withStorageLock(LOCK_NAME, task);
}
