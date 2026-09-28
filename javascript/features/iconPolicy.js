/**
 * Icon value policy — dependency-free so both the extension (iconCache.js)
 * and the TypeScript design kit (design-kit/) enforce the exact same rules
 * for what an icon may be. Keep in lockstep with the manifest CSP img-src.
 */

// Hosts allowed for user-provided custom icons (besides data: URIs). Kept in
// lockstep with the manifest CSP img-src.
export const ALLOWED_ICON_HOSTS = ['cdn.jsdelivr.net', 'selfh.st'];

/**
 * Validates an icon value before it is persisted on a link. This is the single
 * source of truth for what may be SAVED as link.icon — kept in lockstep with
 * loadCustomIcon (what renders) and the manifest CSP img-src (what the browser
 * will actually fetch). Anything else used to be silently persisted and then
 * silently refused at render time, which is how "saved but broken" icons
 * happened.
 *
 * @param {string|null|undefined} value - Raw icon value from a form or import
 * @returns {{valid: boolean, value?: string, reason?: string}}
 *   valid:true with the normalized value to store ('default' for empty), or
 *   valid:false with a user-facing reason.
 */
export function validateIconValue(value) {
    const trimmed = String(value ?? '').trim();

    // Empty / 'default' → automatic resolution (selfh.st match, favicon, initials).
    if (!trimmed || trimmed === 'default') {
        return { valid: true, value: 'default' };
    }

    if (/^data:/i.test(trimmed)) {
        return validateDataUrl(trimmed)
            ? { valid: true, value: trimmed }
            : { valid: false, reason: 'Data-URI icons must be base64 PNG, JPEG, GIF, or SVG under 100KB.' };
    }

    let url;
    try {
        url = new URL(trimmed);
    } catch {
        return { valid: false, reason: 'Icon must be a full https:// URL or a data: image URI.' };
    }

    const host = url.hostname.toLowerCase();
    const hostAllowed = url.protocol === 'https:' &&
        ALLOWED_ICON_HOSTS.some(h => host === h || host.endsWith('.' + h));
    if (!hostAllowed) {
        return {
            valid: false,
            reason: `Icons can only load from selfh.st or jsDelivr — "${host}" would be blocked by the extension's security policy. Use the Icon picker, or paste a data: image URI.`
        };
    }

    return { valid: true, value: trimmed };
}

/**
 * Validates data URL format
 * @param {string} dataUrl - Data URL to validate
 * @returns {boolean} - Whether URL is valid
 */
export function validateDataUrl(dataUrl) {
    try {
        // Basic data URL validation
        const dataUrlRegex = /^data:image\/(png|jpg|jpeg|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
        return dataUrlRegex.test(dataUrl) && dataUrl.length < 100000; // Max 100KB
    } catch {
        return false;
    }
}
