/**
 * One lock around the local-storage writes that pending-sync markers depend on
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
let queue = Promise.resolve();

/**
 * Run `task` while holding the pending-sync lock.
 * @param {() => Promise<*>} task
 * @returns {Promise<*>} the task's result
 */
export function withPendingSyncLock(task) {
    if (globalThis.navigator?.locks?.request) {
        return globalThis.navigator.locks.request(LOCK_NAME, task);
    }
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}
