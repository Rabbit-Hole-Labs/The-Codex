/**
 * Service Worker initialization guard for E2E tests.
 * Ensures the extension's service worker has completed onInstalled
 * before tests begin asserting, preventing timing-dependent flakiness.
 */

/**
 * Wait for the extension's service worker to be active and ready.
 * Polls chrome.runtime to confirm the service worker has initialized.
 * @param {BrowserContext} context - Playwright browser context with extension loaded
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - Max wait time in ms
 * @param {number} [options.pollInterval=200] - Poll interval in ms
 * @returns {Promise<ServiceWorker>} The active service worker
 */
export async function waitForServiceWorker(context, options = {}) {
    const { timeout = 10000, pollInterval = 200 } = options;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const workers = context.serviceWorkers();
        if (workers.length > 0) {
            return workers[0];
        }

        // Wait for service worker event
        try {
            const sw = await Promise.race([
                context.waitForEvent('serviceworker', { timeout: pollInterval }),
                new Promise(resolve => setTimeout(() => resolve(null), pollInterval))
            ]);
            if (sw) return sw;
        } catch {
            // Timeout on waitForEvent is expected — continue polling
        }
    }

    throw new Error(`Service worker did not become active within ${timeout}ms`);
}

/**
 * Wait for the service worker to finish its onInstalled initialization.
 * After the SW is active, verifies that default storage values have been set
 * (which the SW does in its onInstalled handler).
 * @param {Page} page - An extension page
 * @param {object} [options]
 * @param {number} [options.timeout=5000] - Max wait time in ms
 * @param {number} [options.pollInterval=100] - Poll interval in ms
 */
export async function waitForServiceWorkerInit(page, options = {}) {
    const { timeout = 5000, pollInterval = 100 } = options;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const hasDefaults = await page.evaluate(async () => {
            const data = await chrome.storage.sync.get(['theme']);
            return data.theme !== undefined;
        });
        if (hasDefaults) return;
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Service worker onInstalled did not complete within ${timeout}ms`);
}
