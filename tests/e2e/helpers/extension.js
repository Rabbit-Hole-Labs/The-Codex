/**
 * Extension testing utilities for Playwright E2E tests.
 * Handles extension loading, ID resolution, and page navigation.
 */
import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..', '..', '..');

/**
 * Compute the deterministic extension ID from the manifest key.
 * Chrome derives the ID by hashing the key's raw bytes and encoding
 * the first 16 bytes as lowercase a-p (base-16 with offset 'a').
 * @returns {string} 32-character extension ID
 */
export function getExtensionId() {
    // Read the public key from manifest.json — the single source of truth.
    // (This is the extension's public key, not a secret; Chrome uses it to
    // derive the stable extension ID.)
    const manifest = JSON.parse(readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf8'));
    const KEY = manifest.key;
    if (!KEY) {
        throw new Error('manifest.json is missing the "key" field required to derive a stable extension ID for E2E tests');
    }
    const keyBytes = Buffer.from(KEY, 'base64');
    const hash = crypto.createHash('sha256').update(keyBytes).digest();
    return Array.from(hash.slice(0, 16))
        .map(b => String.fromCharCode((b >> 4) + 97) + String.fromCharCode((b & 0xf) + 97))
        .join('');
}

/**
 * Build a chrome-extension:// URL for a given page.
 * @param {string} [page='index.html'] - Page within the extension
 * @returns {string} Full extension URL
 */
export function getExtensionUrl(page = 'index.html') {
    return `chrome-extension://${getExtensionId()}/${page}`;
}

/**
 * Launch a persistent browser context with the extension loaded.
 * Required because Chrome extensions cannot run in headless mode.
 * @param {object} [options] - Additional launch options
 * @returns {Promise<{context: BrowserContext, extensionId: string}>}
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

    // Wait for service worker to register
    let serviceWorker;
    try {
        serviceWorker = context.serviceWorkers()[0] ||
            await context.waitForEvent('serviceworker', { timeout: 5000 });
    } catch {
        // Service worker may already be active
        serviceWorker = context.serviceWorkers()[0];
    }

    const extensionId = getExtensionId();
    return { context, extensionId, serviceWorker };
}

/**
 * Navigate to an extension page in the given context.
 * @param {BrowserContext} context
 * @param {string} [page='index.html']
 * @returns {Promise<Page>}
 */
export async function navigateToExtensionPage(context, page = 'index.html') {
    const p = await context.newPage();
    await p.goto(getExtensionUrl(page), { waitUntil: 'domcontentloaded' });
    return p;
}
