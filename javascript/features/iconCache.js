/**
 * Icon Caching and Optimization System for The Codex
 * Provides intelligent icon loading, caching, fallback mechanisms, and performance optimization
 */

// CSP-aware icon loading configuration
const CSP_CONFIG = {
    // Removed domain allowlist - extension needs to load favicons from any domain
    // Manifest permissions control which domains are accessible
    blockedSchemes: [], // Don't block HTTP - many sites only have HTTP favicons
    allowLocalIPs: true, // Allow local IP addresses for home lab environments
    allowDataUrls: true,
    fallbackOnCSPBlock: true,
    // Only block known dangerous protocols
    dangerousProtocols: ['javascript:', 'vbscript:', 'file:']
};

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
    CUSTOM: 'custom', // User-uploaded icons
    CLEARBIT: 'clearbit', // Clearbit logo API
    FAVICON: 'favicon', // Site favicon
    GENERATED: 'generated' // Generated from domain/name
};

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
        allowClearbit = true,
        allowFavicon = true,
        allowGenerated = true,
        timeout = CACHE_CONFIG.timeout,
        respectCSP = true
    } = options;

    cacheStats.totalRequests++;

    // Get CSP-compliant options if respectCSP is enabled
    const compliantOptions = respectCSP ? getCSPCompliantOptions(options) : {
        allowClearbit, allowFavicon, allowGenerated, timeout
    };

    try {
        // Generate cache key
        const cacheKey = generateCacheKey(link);

        // Check cache first
        const cachedIcon = getCachedIcon(cacheKey);
        if (cachedIcon) {
            cacheStats.hits++;
            console.log(`Icon cache hit for: ${link.name}`);
            return cachedIcon.url;
        }

        cacheStats.misses++;

        // Try to load icon from various sources
        let iconUrl = null;

        // 1. Try custom icon if available
        if (preferCustom && link.icon) {
            iconUrl = await loadCustomIcon(link.icon, compliantOptions.timeout);
            if (iconUrl) {
                await cacheIcon(cacheKey, iconUrl, ICON_SOURCES.CUSTOM);
                return iconUrl;
            }
        }

        // 2. Try favicon (with CSP validation) - Skip Clearbit due to DNS resolution issues
        if (compliantOptions.allowFavicon) {
            iconUrl = await loadFaviconIconCSP(link.url, compliantOptions.timeout);
            if (iconUrl) {
                await cacheIcon(cacheKey, iconUrl, ICON_SOURCES.FAVICON);
                return iconUrl;
            }
        }

        // 4. Generate fallback icon
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
        // Validate URL
        const url = new URL(iconUrl);

        // Check if it's a data URL (base64 image)
        if (url.protocol === 'data:') {
            return validateDataUrl(iconUrl) ? iconUrl : null;
        }

        // For HTTP(S) URLs, test if image loads
        return await testImageLoad(iconUrl, timeout);

    } catch (error) {
        console.warn('Invalid custom icon URL:', iconUrl, error);
        return null;
    }
}

/**
 * Loads icon from Clearbit logo API
 * @param {string} siteUrl - Site URL
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} - Icon URL or null
 */
async function loadClearbitIcon(siteUrl, timeout) {
    try {
        const domain = extractDomain(siteUrl);
        if (!domain) return null;

        // Skip Clearbit for local IP addresses (they can't be resolved)
        if (isLocalIP(domain)) {
            console.log(`Skipping Clearbit for local IP: ${domain}`);
            return null;
        }

        // Skip Clearbit for complex subdomains (they often can't be resolved)
        // Complex subdomains have 3 or more dots: e.g., us-east-2.console.aws.amazon.com
        const dotCount = (domain.match(/\./g) || []).length;
        if (dotCount >= 3) {
            console.log(`Skipping Clearbit for complex subdomain: ${domain}`);
            return null;
        }

        const clearbitUrl = `https://logo.clearbit.com/${domain}?size=128`;

        return await testImageLoad(clearbitUrl, timeout);

    } catch (error) {
        console.warn('Failed to load Clearbit icon:', error);
        return null;
    }
}

/**
 * Loads favicon with CSP validation and multiple fallback attempts
 * @param {string} siteUrl - Site URL
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} - Favicon URL or null
 */
async function loadFaviconIconCSP(siteUrl, timeout) {
    try {
        const url = new URL(siteUrl);
        const baseUrl = `${url.protocol}//${url.host}`;

        // Try multiple favicon locations with CSP validation
        const faviconUrls = [
            `${baseUrl}/favicon.ico`,
            `${baseUrl}/favicon.png`,
            `${baseUrl}/apple-touch-icon.png`,
            `${baseUrl}/apple-touch-icon-precomposed.png`
        ];

        // Add Google favicon service for HTTPS sites only
        if (url.protocol === 'https:') {
            const googleFaviconUrl = `https://www.google.com/s2/favicons?domain=${url.host}&sz=128`;
            if (isCSPCompliant(googleFaviconUrl)) {
                faviconUrls.push(googleFaviconUrl);
            }
        }

        // Filter URLs by CSP compliance
        const compliantUrls = faviconUrls.filter(url => isCSPCompliant(url));

        if (compliantUrls.length === 0) {
            console.warn('No CSP-compliant favicon URLs available');
            return null;
        }

        // Try each compliant URL
        for (const faviconUrl of compliantUrls) {
            const result = await testImageLoad(faviconUrl, timeout / compliantUrls.length);
            if (result) {
                return result;
            }
        }

        return null;

    } catch (error) {
        console.warn('Failed to load CSP-compliant favicon:', error);
        return null;
    }
}

/**
 * Tests if an image loads successfully
 * @param {string} imageUrl - Image URL to test
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string|null>} - URL if successful, null otherwise
 */
function testImageLoad(imageUrl, timeout) {
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

        console.log(`Cached icon from ${source}: ${iconUrl}`);

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

// Periodic cache cleanup
setInterval(clearExpiredCache, 60 * 60 * 1000); // Clean every hour

/**
 * Checks if a URL is allowed by CSP policies
 * @param {string} url - URL to check
 * @returns {boolean} - Whether URL is CSP compliant
 */
function isCSPCompliant(url) {
    try {
        const urlObj = new URL(url);

        // Check for dangerous protocols (XSS prevention)
        if (CSP_CONFIG.dangerousProtocols.includes(urlObj.protocol)) {
            console.warn(`CSP Block: Dangerous protocol ${urlObj.protocol} not allowed`);
            return false;
        }

        // Check for data URLs
        if (urlObj.protocol === 'data:') {
            return CSP_CONFIG.allowDataUrls;
        }

        // Allow all HTTP/HTTPS URLs for favicon loading
        // The manifest permissions control actual network access
        if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
            // Check for local IP addresses if needed
            if (isLocalIP(urlObj.hostname) && !CSP_CONFIG.allowLocalIPs) {
                console.warn(`CSP Block: Local IP ${urlObj.hostname} not allowed`);
                return false;
            }
            return true;
        }

        // Allow other protocols (like chrome-extension://)
        return true;

    } catch (error) {
        console.error('CSP validation error:', error);
        return false;
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
        allowClearbit: options.allowClearbit && isCSPCompliant('https://clearbit.com'),
        allowFavicon: options.allowFavicon, // Favicon compliance is checked per-URL in loadFaviconIconCSP
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