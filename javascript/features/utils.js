export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

export function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}

/**
 * Extract plain text from a string that may contain HTML markup.
 * Parses the HTML and returns only the text content with all tags stripped.
 * NOTE: This is a text EXTRACTOR, not an HTML sanitizer.
 * For safe HTML output that preserves allowed tags, use purifyHTML() from securityUtils.js.
 * @param {string} str - Input string possibly containing HTML
 * @returns {string} Plain text with all HTML stripped
 */
export function extractTextContent(str) {
    if (!str) return '';
    // Use DOMParser to safely parse HTML and extract text
    const doc = new DOMParser().parseFromString(str, 'text/html');
    return doc.body.textContent || '';
}

// Backwards-compatible alias
export { extractTextContent as sanitizeHTML };

/**
 * Escape a string for safe interpolation into HTML text or double-quoted
 * attribute contexts. Encodes the five characters that can break out of
 * markup (& < > " ') so an untrusted value can never inject elements or
 * attributes.
 *
 * Use this — NOT extractTextContent/sanitizeHTML — whenever an untrusted
 * value is placed into an innerHTML template string. (extractTextContent
 * DECODES entities, so it must only ever feed textContent, never innerHTML.)
 *
 * @param {*} value - The value to escape (coerced to string)
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Validates and sanitizes URLs to prevent security vulnerabilities
 * Blocks javascript:, data:, and other dangerous URL schemes
 * @param {string} url - The URL to validate
 * @returns {string} - Sanitized URL or '#' if invalid
 */
export function validateAndSanitizeUrl(url) {
    if (!url || typeof url !== 'string') {
        return '#';
    }

    try {
        // Remove any whitespace and normalize
        const trimmedUrl = url.trim();

        // Create URL object to parse and validate
        const urlObj = new URL(trimmedUrl);

        // Allow only HTTP and HTTPS schemes
        const allowedSchemes = ['http:', 'https:'];
        if (!allowedSchemes.includes(urlObj.protocol)) {
            console.warn(`Blocked dangerous URL scheme: ${urlObj.protocol}`);
            return '#';
        }

        // Block known malicious/suspicious domains
        const suspiciousDomains = [
            'bit.ly', 'tinyurl.com', 'short.link', 'suspicious-domain.com',
            'malware.com', 'phishing.com', 'fake-site.com'
        ];

        const hostname = urlObj.hostname.toLowerCase();
        if (suspiciousDomains.some(domain => hostname.includes(domain))) {
            console.warn(`Blocked suspicious domain: ${hostname}`);
            return '#';
        }

        // Note: Private IP addresses (192.168.x.x, 10.x.x.x, 172.x.x.x) and localhost
        // are allowed for local network services (Jellyfin, SABnzbd, Radarr, etc.)
        // This is intentional for home lab environments

        // Return the validated URL
        return urlObj.href;

    } catch (error) {
        // If URL parsing fails, it's likely malformed
        console.warn(`Invalid URL format: ${url}`, error);
        return '#';
    }
}

/**
 * Validates URL format without full security checks
 * Used for internal validation and user feedback
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if URL format is valid
 */
export function isValidUrlFormat(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    try {
        new URL(url.trim());
        return true;
    } catch {
        return false;
    }
}

/**
 * Extracts domain from URL for display purposes
 * @param {string} url - The URL to extract domain from
 * @returns {string} - The domain name or empty string
 */
export function extractDomain(url) {
    try {
        const urlObj = new URL(url.trim());
        return urlObj.hostname;
    } catch {
        return '';
    }
}