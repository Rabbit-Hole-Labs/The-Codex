/**
 * Automatic logo matches saved to the link, so they sync.
 *
 * A link without a picked icon gets one matched by name from the selfh.st
 * library on each device (iconCache.js). That match used to stay on the device
 * (iconSourcesV1), so every other device had to match it again — and could
 * end up with a different icon, or none while selfh.st was unreachable. The
 * new tab now writes each selfh.st match into the link's `icon`, which syncs:
 * from then on it is that link's icon everywhere, exactly like a picked one.
 * Google favicons and generated initials are not saved: they aren't icons a
 * link may store (validateIconValue), and every device derives them alike.
 *
 * Matches are queued and written in one save a moment later. The write is
 * skipped while this device has a links save waiting for Sync now (writing
 * the cloud would make Sync now set that edit aside instead of uploading it),
 * and it never falls back to local storage: a match that can't be saved now
 * is simply queued again on a later new tab.
 */

import { debug } from '../core-systems/debug.js';
import { saveLinks } from '../core-systems/storageManager.js';
import { readSyncLinks } from '../core-systems/syncStorage.js';
import { parseStoredArray, pendingSyncKey } from '../core-systems/storageFormat.js';
import { withStorageLock } from '../core-systems/storageLock.js';
import { validateIconValue } from './iconPolicy.js';

const FLUSH_DELAY_MS = 2000; // one save for a page of tiles
// Two new tabs flushing at once read and write the links one after the other.
const AUTO_ICONS_LOCK = 'codex-auto-icons';

let pending = new Map(); // link id -> { name, url, icon }
let flushTimer = null;

/** Whether a link's icon is chosen automatically ('default' or none). */
export function hasAutomaticIcon(link) {
    const icon = String(link?.icon ?? '').trim();
    return icon === '' || icon === 'default';
}

/**
 * Queue a selfh.st match to be saved as the link's icon.
 * @param {Object} link - the link as matched (id, name, url, icon)
 * @param {string} iconUrl - the matched selfh.st icon URL
 */
export function queueAutoIcon(link, iconUrl) {
    if (!link?.id || !hasAutomaticIcon(link)) return;
    const checked = validateIconValue(iconUrl);
    if (!checked.valid || checked.value === 'default' || /^data:/i.test(checked.value)) return;
    pending.set(link.id, { name: link.name, url: link.url, icon: checked.value });
    if (!flushTimer) flushTimer = setTimeout(() => { flushAutoIcons(); }, FLUSH_DELAY_MS);
}

/**
 * Save the queued matches: each onto the cloud's link with the same id, if
 * that link still has the name and URL it was matched for and no picked icon.
 * @returns {Promise<number>} how many links got an icon
 */
export async function flushAutoIcons() {
    clearTimeout(flushTimer);
    flushTimer = null;
    const matches = pending;
    pending = new Map();
    if (matches.size === 0) return 0;
    try {
        return await withStorageLock(AUTO_ICONS_LOCK, async () => {
            const markerKey = pendingSyncKey('links');
            const { [markerKey]: marker } = await chrome.storage.local.get(markerKey);
            if (marker) return 0;
            const { value, consistent } = await readSyncLinks();
            const links = consistent ? parseStoredArray(value) : null;
            if (!links) return 0;

            let changed = 0;
            const updated = links.map(link => {
                const match = link && matches.get(link.id);
                if (!match || link.name !== match.name || link.url !== match.url || !hasAutomaticIcon(link)) return link;
                changed++;
                return { ...link, icon: match.icon };
            });
            if (changed === 0) return 0;
            if (!await saveLinks(updated, { fallback: false })) return 0;
            debug(`Saved ${changed} automatic icon match(es) to their links`);
            return changed;
        });
    } catch (error) {
        debug('Could not save automatic icon matches:', error);
        return 0;
    }
}
