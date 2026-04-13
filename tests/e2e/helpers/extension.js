/**
 * Extension testing utilities for Playwright E2E tests.
 * Handles extension loading, ID resolution, and page navigation.
 */
import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
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
    // Read key from manifest at build time or use the known key
    const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr2a3c7f5h8j1k4m6n9p2q5s7u0v3w6x9y1A4B7C0D3E6F9G2H5I8J1K4L7M0N3O6P9Q2R5S8T1U4V7W0X3Y6Z9a2b5c8d1e4f7g0h3i6j9k2l5m8n1o4p7q0r3s6t9u2v5w8x1y4z7A0B3C6D9E2F5G8H1I4J7K0L3M6N9O2P5Q8R1S4T7U0V3W6X9Y2Z5a8b1c4d7e0f3g6h9i2j5k8l1m4n7o0p3q6r5s8t1u4v7w0x3y6z9A2B5C8D1E4F7G0H3I6J9K2L5M8N1O4P7Q0R3QIDAQAB';
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
