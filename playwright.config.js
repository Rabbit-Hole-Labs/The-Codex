import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 30000,
    retries: 0,
    use: {
        headless: false, // Extensions require headed mode
        viewport: { width: 1280, height: 720 },
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'extension',
            use: {
                // Extension loading requires launchPersistentContext
                // Tests use the helper in tests/e2e/helpers/extension.js
                // to launch with the correct flags
                browserName: 'chromium',
            },
        },
    ],
});
