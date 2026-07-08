/**
 * Extension testing utilities for Playwright E2E tests.
 * Handles extension loading, ID resolution, and page navigation.
 */
import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..', '..', '..');

/**
 * Reads the loaded extension's ID from its service worker URL
 * (chrome-extension://<id>/...). The unpacked extension ships no manifest
 * "key", so Chrome assigns the ID at load time and we read it back here.
 * @param {import('@playwright/test').BrowserContext} context
 * @returns {string} 32-character extension ID
 */
export function getExtensionId(context) {
    const [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
        throw new Error('Extension service worker not found — is the extension loaded?');
    }
    return new URL(serviceWorker.url()).host;
}

/**
 * Build a chrome-extension:// URL for a given page.
 * @param {string} extensionId - The loaded extension's ID
 * @param {string} [page='index.html'] - Page within the extension
 * @returns {string} Full extension URL
 */
export function getExtensionUrl(extensionId, page = 'index.html') {
    return `chrome-extension://${extensionId}/${page}`;
}

/**
 * Launch a persistent browser context with the extension loaded.
 * Required because Chrome extensions cannot run in headless mode.
 * @param {object} [options] - Additional launch options
 * @returns {Promise<{context: import('@playwright/test').BrowserContext, extensionId: string, serviceWorker: import('@playwright/test').Worker}>}
 */
export async function launchWithExtension(options = {}) {
    const context = await chromium.launchPersistentContext('', {
        headless: false,
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-first-run',
            '--disable-default-apps',
        ],
        ...options,
    });

    // Wait for the service worker to register so we can read the extension ID.
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
        try {
            serviceWorker = await context.waitForEvent('serviceworker', { timeout: 5000 });
        } catch {
            serviceWorker = context.serviceWorkers()[0];
        }
    }

    const extensionId = serviceWorker ? new URL(serviceWorker.url()).host : null;
    return { context, extensionId, serviceWorker };
}

/**
 * Navigate to an extension page in the given context.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} [page='index.html']
 * @returns {Promise<import('@playwright/test').Page>}
 */
export async function navigateToExtensionPage(context, page = 'index.html') {
    const extensionId = getExtensionId(context);
    const p = await context.newPage();
    await p.goto(getExtensionUrl(extensionId, page), { waitUntil: 'domcontentloaded' });
    return p;
}
