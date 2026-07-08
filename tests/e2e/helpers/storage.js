/**
 * Storage reset utilities for Playwright E2E tests.
 * Ensures clean state between tests by clearing chrome.storage.
 */

/**
 * Clear all chrome.storage (sync + local) via the extension's background page.
 * Call in beforeEach/afterEach to prevent state leaking between tests.
 * @param {Page} page - A page in the extension context
 */
export async function clearExtensionStorage(page) {
    await page.evaluate(async () => {
        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();
    });
}

/**
 * Seed chrome.storage.sync with test data.
 * @param {Page} page - A page in the extension context
 * @param {object} data - Key-value pairs to set in sync storage
 */
export async function seedStorage(page, data) {
    await page.evaluate(async (d) => {
        await chrome.storage.sync.set(d);
    }, data);
}

/**
 * Read all data from chrome.storage.sync.
 * @param {Page} page - A page in the extension context
 * @returns {Promise<object>} All sync storage data
 */
export async function readStorage(page) {
    return await page.evaluate(async () => {
        return await chrome.storage.sync.get(null);
    });
}
