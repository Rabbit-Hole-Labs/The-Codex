// Type declarations for iconPolicy.js, so the TypeScript design kit
// (design-kit/) can share the extension's icon policy.
export function validateDataUrl(dataUrl: string): boolean;
/** Whether a parsed URL is https on an allowed icon host (or a subdomain of one). */
export function isAllowedIconUrl(url: URL): boolean;
export function validateIconValue(
  value: unknown,
): { valid: true; value: string } | { valid: false; reason: string };
