// Type declarations for utils.js, so the TypeScript design kit
// (design-kit/) can import the extension's canonical helpers — notably
// validateAndSanitizeUrl() — instead of re-implementing their policy.
export function debounce<A extends unknown[]>(func: (...args: A) => void, wait: number): (...args: A) => void;
export function throttle<A extends unknown[]>(func: (...args: A) => void, limit: number): (...args: A) => void;
export function extractTextContent(str: string | null | undefined): string;
export { extractTextContent as sanitizeHTML };
export function escapeHtml(value: unknown): string;
/** Returns the normalized URL, or `'#'` when the scheme or domain is blocked. */
export function validateAndSanitizeUrl(url: unknown): string;
export function isValidUrlFormat(url: unknown): boolean;
export function extractDomain(url: string): string;
