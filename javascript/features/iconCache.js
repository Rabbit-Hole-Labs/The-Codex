/**
 * Icon Caching and Optimization System for The Codex
 * Provides intelligent icon loading, caching, fallback mechanisms, and performance optimization
 */

import { debug } from '../core-systems/debug.js';
import { loadStoredIcon } from './iconStore.js';

// Icon cache storage
let iconCache = new Map();
let cacheStats = {
    hits: 0,
    misses: 0,
    failures: 0,
    cspBlocks: 0,
    totalRequests: 0
};

// Cache configuration
const CACHE_CONFIG = {
    maxSize: 100, // Maximum number of icons to cache
    ttl: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
    retryAttempts: 3,
    retryDelay: 1000,
    timeout: 5000, // 5 seconds timeout
    fallbackTimeout: 2000 // 2 seconds for fallback
};

// Icon sources priority
const ICON_SOURCES = {
    CUSTOM: 'custom', // User-provided data: URI or selfh.st/jsDelivr URL
    SELFHST: 'selfhst', // selfh.st/icons library (self-hosted app logos)
    GOOGLE: 'google', // Google favicon proxy (public sites)
    GENERATED: 'generated' // Generated from domain/name
};

// selfh.st/icons — a curated library of self-hosted app logos, served via
// jsDelivr from the selfhst/icons GitHub repo. WebP covers every icon.
// Icons resolve to a single known host (cdn.jsdelivr.net), which is why this
// approach lets the CSP drop the img-src wildcard.
const SELFHST_ICONS_BASE = 'https://cdn.jsdelivr.net/gh/selfhst/icons';

// Hosts allowed for user-provided custom icons (besides data: URIs). Kept in
// lockstep with the manifest CSP img-src.
const ALLOWED_ICON_HOSTS = ['cdn.jsdelivr.net', 'selfh.st'];

// Domain labels too generic to reliably identify an app on selfh.st.
const GENERIC_DOMAIN_LABELS = new Set(['www', 'app', 'apps', 'home', 'dashboard', 'dash', 'portal', 'web', 'admin', 'my']);

// Fallback icon generation
const FALLBACK_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#84cc16', '#f97316', '#ec4899', '#6366f1'
];

/**
 * Intelligent icon loading with caching and fallbacks
 * @param {Object} link - Link object with name, url, and optional icon
 * @param {Object} options - Loading options
 * @returns {Promise<string>} - Promise resolving to icon URL
 */
export async function loadIconWithCache(link, options = {}) {
    // Handle null or undefined link
    if (!link) {
        return null;
    }

    const {
        preferCustom = true,
        allowSelfhst = true,
        allowFavicon = true,
        allowGenerated = true,
        timeout = CACHE_CONFIG.timeout,
        respectCSP = true
    } = options;

    cacheStats.totalRequests++;

    // Get CSP-compliant options if respectCSP is enabled
    const compliantOptions = respectCSP ? getCSPCompliantOptions(options) : {
        allowSelfhst, allowFavicon, allowGenerated, timeout
    };

    try {
        // Generate cache key
        const cacheKey = generateCacheKey(link);

        // Check cache first
        const cachedIcon = getCachedIcon(cacheKey);
        if (cachedIcon) {
            cacheStats.hits++;
            debug(`Icon cache hit for: ${link.name}`);
            return cachedIcon.url;
        }

        cacheStats.misses++;

        // Try to load icon from various sources
        let iconUrl = null;

        // 1. Try custom icon if available (data: URI or selfh.st/jsDelivr URL)
        if (preferCustom && link.icon) {
            iconUrl = await loadCustomIcon(link.icon, compliantOptions.timeout);
            if (iconUrl) {
                await cacheIcon(cacheKey, iconUrl, ICON_SOURCES.CUSTOM);
                return iconUrl;
            }
        }

        // 2. Match against the selfh.st/icons library (self-hosted app logos).
        //    This is the primary source and works for internal/homelab apps
        //    without ever contacting the internal host.
        if (compliantOptions.allowSelfhst !== false) {
            iconUrl = await loadSelfhstIcon(link, compliantOptions.timeout);
            if (iconUrl) {
                await cacheIcon(cacheKey, iconUrl, ICON_SOURCES.SELFHST);
                return iconUrl;
            }
        }

        // 3. Fall back to the Google favicon proxy for public sites with no
        //    selfh.st match. One known host; no per-site fetch, no wildcard.
        if (compliantOptions.allowFavicon) {
            iconUrl = await loadGoogleFaviconIcon(link.url, compliantOptions.timeout);
            if (iconUrl) {
                await cacheIcon(cacheKey, iconUrl, ICON_SOURCES.GOOGLE);
                return iconUrl;
            }
        }

        // 4. Generate a text-initials fallback icon
        if (compliantOptions.allowGenerated) {
            iconUrl = generateFallbackIcon(link);
            if (iconUrl) {
                await cacheIcon(cacheKey, iconUrl, ICON_SOURCES.GENERATED);
                return iconUrl;
            }
        }

        // If all attempts failed, return null
        cacheStats.failures++;
        console.warn(`Failed to load icon for: ${link?.name || 'unknown'}`);
        return null;

    } catch (error) {
        cacheStats.failures++;
        console.error(`Error loading icon for ${link?.name || 'unknown'}:`, error);
        return null;
    }
}

/**
 * Loads custom icon with validation and timeout
 * @param {string} iconUrl - Custom icon URL
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} - Validated icon URL or null
 */
async function loadCustomIcon(iconUrl, timeout) {
    try {
        const trimmed = String(iconUrl).trim();

        // Data URIs (base64 images) — validated and size-limited.
        if (/^data:/i.test(trimmed)) {
            return validateDataUrl(trimmed) ? trimmed : null;
        }

        // Otherwise only https URLs on an allowed icon host (jsDelivr/selfh.st).
        // Arbitrary external hosts are rejected so the CSP can drop the
        // img-src wildcard; users wanting a bespoke icon can paste a data: URI.
        const url = new URL(trimmed);
        const host = url.hostname.toLowerCase();
        const hostAllowed = url.protocol === 'https:' &&
            ALLOWED_ICON_HOSTS.some(h => host === h || host.endsWith('.' + h));
        if (!hostAllowed) {
            console.warn('Custom icon rejected — only data: URIs and selfh.st/jsDelivr URLs are allowed:', host);
            return null;
        }

        // The stored value renders verbatim — nothing is ever substituted for
        // it. Users pick -light/-dark recolors explicitly in the picker.
        // Prefer the persistent byte-store (instant + offline); fall back to
        // a plain network probe when byte-fetching isn't possible (CORS).
        const stored = await loadStoredIcon(trimmed, timeout);
        if (stored.data) return stored.data;
        if (stored.notFound) return null;
        return await testImageLoad(trimmed, timeout);

    } catch (error) {
        console.warn('Invalid custom icon URL:', iconUrl, error);
        return null;
    }
}

/**
 * Normalizes a string into a selfh.st icon slug (lowercase, hyphenated).
 * @param {string} value - Source text (app name or domain label)
 * @returns {string} - Slug, e.g. "Home Assistant" -> "home-assistant"
 */
export function toIconSlug(value) {
    return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/['"’.]/g, '')  // drop apostrophes/quotes/dots inside words
        .replace(/[^a-z0-9]+/g, '-')  // any other run of non-alphanumerics -> hyphen
        .replace(/^-+|-+$/g, '');     // trim leading/trailing hyphens
}

/**
 * Builds candidate selfh.st slugs for a link, most specific first.
 * The tile name is the primary signal (users name tiles after the app);
 * hostname labels are secondary and cover app-as-subdomain / app-as-domain.
 * @param {Object} link - Link object
 * @returns {string[]} - Ordered, de-duplicated candidate slugs
 */
export function selfhstCandidateSlugs(link) {
    const candidates = [];
    const push = (slug) => {
        if (slug && slug.length >= 2 && !candidates.includes(slug)) {
            candidates.push(slug);
        }
    };

    push(toIconSlug(link.name));

    try {
        const host = extractDomain(link.url); // hostname without www
        // Skip IP addresses — their octets never identify an app.
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
            const labels = host.split('.').filter(Boolean);
            const usable = (label) => label && !GENERIC_DOMAIN_LABELS.has(label) && !/^\d+$/.test(label);
            if (labels.length) {
                if (usable(labels[0])) push(toIconSlug(labels[0]));
                if (labels.length >= 2 && usable(labels[labels.length - 2])) {
                    push(toIconSlug(labels[labels.length - 2]));
                }
            }
        }
    } catch {
        // link.url isn't a parseable URL — name-based matching still applies.
    }

    return candidates;
}

/**
 * Builds the jsDelivr URL for a selfh.st icon (WebP covers every icon).
 * @param {string} slug - Icon slug
 * @returns {string} - Full CDN URL
 */
export function selfhstIconUrl(slug) {
    return `${SELFHST_ICONS_BASE}/webp/${slug}.webp`;
}

/**
 * Matches a link to an icon in the selfh.st/icons library by probing candidate
 * slugs; the first that resolves to a real icon wins. Works for internal/homelab
 * apps by name without ever contacting the internal host.
 * @param {Object} link - Link object
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} - Icon URL or null
 */
async function loadSelfhstIcon(link, timeout) {
    if (!link) return null;
    const slugs = selfhstCandidateSlugs(link);
    for (const slug of slugs) {
        const url = selfhstIconUrl(slug);
        // Byte-store first: instant + offline once seen. A definite upstream
        // 404 skips the probe (it would just repeat the miss); indeterminate
        // failures (CORS/offline-but-HTTP-cached) still get the probe.
        const stored = await loadStoredIcon(url, timeout);
        if (stored.data) return stored.data;
        if (stored.notFound) continue;
        const result = await testImageLoad(url, timeout);
        if (result) return result;
    }
    return null;
}

/**
 * Loads a favicon via Google's favicon proxy (public sites only). A single
 * known host — no per-site fetch, so no img-src wildcard is required.
 * Private/local hosts are skipped since Google's proxy cannot reach them.
 * @param {string} siteUrl - Site URL
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} - Icon URL or null
 */
async function loadGoogleFaviconIcon(siteUrl, timeout) {
    try {
        let raw = String(siteUrl || '').trim();
        if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
        const url = new URL(raw);
        if (isLocalIP(url.hostname)) {
            return null;
        }
        const googleUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`;
        // Google's favicon service may refuse cross-origin byte-fetches; the
        // probe fallback keeps favicons working network-only in that case.
        const stored = await loadStoredIcon(googleUrl, timeout);
        if (stored.data) return stored.data;
        return await testImageLoad(googleUrl, timeout);
    } catch (error) {
        console.warn('Failed to build Google favicon URL:', error);
        return null;
    }
}

/**
 * Tests if an image loads successfully
 * @param {string} imageUrl - Image URL to test
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} - URL if successful, null otherwise
 */
export function testImageLoad(imageUrl, timeout = CACHE_CONFIG.timeout) {
    return new Promise((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => {
            img.src = ''; // Cancel loading
            resolve(null);
        }, timeout);

        img.onload = () => {
            clearTimeout(timer);
            resolve(imageUrl);
        };

        img.onerror = () => {
            clearTimeout(timer);
            resolve(null);
        };

        img.src = imageUrl;
    });
}

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
function validateDataUrl(dataUrl) {
    try {
        // Basic data URL validation
        const dataUrlRegex = /^data:image\/(png|jpg|jpeg|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
        return dataUrlRegex.test(dataUrl) && dataUrl.length < 100000; // Max 100KB
    } catch (error) {
        return false;
    }
}

/**
 * Generates fallback icon from site information
 * @param {Object} link - Link object
 * @returns {string} - Data URL for generated icon
 */
function generateFallbackIcon(link) {
    try {
        const domain = extractDomain(link.url);
        const name = link.name || domain;

        // Generate deterministic color based on domain
        const colorIndex = hashString(domain) % FALLBACK_COLORS.length;
        const backgroundColor = FALLBACK_COLORS[colorIndex];

        // Generate initials
        const initials = generateInitials(name);

        // Create SVG icon
        const svg = createSVGIcon(initials, backgroundColor);

        // Convert to data URL
        return 'data:image/svg+xml;base64,' + btoa(svg);

    } catch (error) {
        console.warn('Failed to generate fallback icon:', error);
        return null;
    }
}

/**
 * Creates SVG icon with initials
 * @param {string} initials - Initials to display
 * @param {string} backgroundColor - Background color
 * @returns {string} - SVG string
 */
function createSVGIcon(initials, backgroundColor) {
    const textColor = getContrastColor(backgroundColor);

    return `
        <svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
            <rect width="64" height="64" fill="${backgroundColor}" rx="8"/>
            <text x="32" y="40" font-family="Arial, sans-serif" font-size="24" font-weight="bold"
                  text-anchor="middle" fill="${textColor}" dominant-baseline="middle">
                ${initials}
            </text>
        </svg>
    `.trim();
}

/**
 * Generates initials from text
 * @param {string} text - Text to generate initials from
 * @returns {string} - Generated initials
 */
function generateInitials(text) {
    if (!text || !text.trim()) return '?';

    const words = text.trim().split(/\s+/);
    if (words.length === 1) {
        return words[0].substring(0, 2).toUpperCase();
    }

    return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

/**
 * Gets contrast color for text
 * @param {string} hexColor - Hex color
 * @returns {string} - Contrast color (black or white)
 */
function getContrastColor(hexColor) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);

    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 128 ? '#000000' : '#ffffff';
}

/**
 * Simple hash function for string
 * @param {string} str - String to hash
 * @returns {number} - Hash value
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

/**
 * Extracts domain from URL
 * @param {string} url - URL to extract domain from
 * @returns {string} - Domain name
 */
function extractDomain(url) {
    try {
        // Add default protocol if missing (for local IPs and hostnames without protocol)
        let urlWithProtocol = url.trim();
        if (!urlWithProtocol.match(/^https?:\/\//)) {
            urlWithProtocol = 'http://' + urlWithProtocol;
        }
        
        const urlObj = new URL(urlWithProtocol);
        return urlObj.hostname.replace('www.', '');
    } catch (error) {
        // Fallback: try to extract hostname from various formats
        console.warn('Failed to parse URL, using fallback extraction:', url, error);
        const cleaned = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
        return cleaned.split(':')[0].replace('www.', '');
    }
}

/**
 * Generates cache key for icon
 * @param {Object} link - Link object
 * @returns {string} - Cache key
 */
function generateCacheKey(link) {
    return `${link.url}:${link.name}:${link.icon || ''}`;
}

/**
 * Gets cached icon
 * @param {string} cacheKey - Cache key
 * @returns {Object|null} - Cached icon or null
 */
function getCachedIcon(cacheKey) {
    const cached = iconCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_CONFIG.ttl) {
        return cached;
    }

    // Remove expired cache entry
    if (cached) {
        iconCache.delete(cacheKey);
    }

    return null;
}

/**
 * Caches icon
 * @param {string} cacheKey - Cache key
 * @param {string} iconUrl - Icon URL
 * @param {string} source - Icon source
 */
async function cacheIcon(cacheKey, iconUrl, source) {
    try {
        // Maintain cache size limit
        if (iconCache.size >= CACHE_CONFIG.maxSize) {
            // Remove oldest entry
            const keys = Array.from(iconCache.keys());
            if (keys.length > 0) {
                const oldestKey = keys[0];
                iconCache.delete(oldestKey);
            }
        }

        iconCache.set(cacheKey, {
            url: iconUrl,
            source: source,
            timestamp: Date.now()
        });

        debug(`Cached icon from ${source}: ${iconUrl}`);

    } catch (error) {
        console.warn('Failed to cache icon:', error);
    }
}

/**
 * Clears expired cache entries
 */
function clearExpiredCache() {
    const now = Date.now();
    let removedCount = 0;

    for (const [key, cached] of iconCache.entries()) {
        if (now - cached.timestamp > CACHE_CONFIG.ttl) {
            iconCache.delete(key);
            removedCount++;
        }
    }

    if (removedCount > 0) {
        console.log(`Cleared ${removedCount} expired cache entries`);
    }
}

/**
 * Clears entire icon cache
 */
export function clearIconCache() {
    iconCache.clear();
    console.log('Icon cache cleared');
}

/**
 * Gets cache statistics
 * @returns {Object} - Cache statistics
 */
export function getCacheStats() {
    return {
        ...cacheStats,
        cacheSize: iconCache.size,
        hitRate: cacheStats.totalRequests > 0 ?
            (cacheStats.hits / cacheStats.totalRequests * 100).toFixed(2) : 0,
        missRate: cacheStats.totalRequests > 0 ?
            (cacheStats.misses / cacheStats.totalRequests * 100).toFixed(2) : 0,
        failureRate: cacheStats.totalRequests > 0 ?
            (cacheStats.failures / cacheStats.totalRequests * 100).toFixed(2) : 0
    };
}

/**
 * Resets cache statistics
 */
export function resetCacheStats() {
    cacheStats = {
        hits: 0,
        misses: 0,
        failures: 0,
        totalRequests: 0
    };
}

/**
 * Preloads icons for better performance with CSP compliance option
 * @param {Array} links - Array of link objects
 * @param {Object} options - Preloading options
 * @param {number} concurrency - Number of concurrent loads
 * @returns {Promise<void>}
 */
export async function preloadIcons(links, options = {}, concurrency = 5) {
    const { respectCSP = true } = options;

    console.log(`Preloading icons for ${links.length} links...`);

    const startTime = performance.now();

    // Create batches for concurrent loading with CSP compliance
    const batches = [];
    for (let i = 0; i < links.length; i += concurrency) {
        batches.push(links.slice(i, i + concurrency));
    }

    // Process batches with CSP compliance
    for (const batch of batches) {
        const promises = batch.map(link => loadIconWithCache(link, { respectCSP }));
        await Promise.allSettled(promises);
    }

    const endTime = performance.now();
    console.log(`Icon preloading completed in ${(endTime - startTime).toFixed(2)}ms`);

    // Log cache stats
    const stats = getCacheStats();
    console.log('Cache stats after preloading:', stats);
}

/**
 * Optimized icon loading for batch operations
 * @param {Array} links - Array of link objects
 * @param {Object} options - Loading options
 * @returns {Promise<Array>} - Array of icon URLs
 */
export async function batchLoadIcons(links, options = {}) {
    const {
        batchSize = 10,
        delayBetweenBatches = 100,
        onProgress = null
    } = options;

    const results = [];
    const total = links.length;
    let processed = 0;

    for (let i = 0; i < links.length; i += batchSize) {
        const batch = links.slice(i, i + batchSize);

        // Process batch
        const batchResults = await Promise.allSettled(
            batch.map(link => loadIconWithCache(link))
        );

        // Collect results
        batchResults.forEach((result, index) => {
            results.push(result.status === 'fulfilled' ? result.value : null);
        });

        processed += batch.length;

        // Report progress
        if (onProgress) {
            onProgress(processed, total);
        }

        // Delay between batches to avoid overwhelming the network
        if (i + batchSize < links.length) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
    }

    return results;
}

// Periodic cache cleanup — handle stored for lifecycle management
let cacheCleanupInterval = setInterval(clearExpiredCache, 60 * 60 * 1000);

/**
 * Stop the periodic cache cleanup interval.
 * Call during page teardown to prevent resource leaks.
 */
export function stopCacheCleanup() {
    if (cacheCleanupInterval !== null) {
        clearInterval(cacheCleanupInterval);
        cacheCleanupInterval = null;
    }
}

/**
 * Checks if hostname is a local IP address
 * @param {string} hostname - Hostname to check
 * @returns {boolean} - Whether it's a local IP
 */
function isLocalIP(hostname) {
    // Check for localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;

    // Check for private IP ranges
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Regex);

    if (match) {
        const [, a, b, c, d] = match.map(Number);

        // Check for private IP ranges
        if (a === 10) return true; // 10.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true; // 192.168.0.0/16
        if (a === 127) return true; // 127.0.0.0/8
    }

    return false;
}

/**
 * Filters icon sources based on CSP compliance
 * @param {Object} options - Original options
 * @returns {Object} - CSP-compliant options
 */
function getCSPCompliantOptions(options) {
    return {
        ...options,
        allowSelfhst: options.allowSelfhst !== false,
        allowFavicon: options.allowFavicon,
        timeout: Math.min(options.timeout || CACHE_CONFIG.timeout, 3000) // Shorter timeout for external resources
    };
}

// Export the icon caching system
export default {
    loadIconWithCache,
    preloadIcons,
    batchLoadIcons,
    clearIconCache,
    getCacheStats,
    resetCacheStats,
    testImageLoad,
    generateFallbackIcon,
    extractDomain
};