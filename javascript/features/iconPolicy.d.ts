// Type declarations for iconPolicy.js, so the TypeScript design kit
// (design-kit/) can share the extension's icon policy.
export const ALLOWED_ICON_HOSTS: readonly string[];
export function validateDataUrl(dataUrl: string): boolean;
export function validateIconValue(
  value: unknown,
): { valid: true; value: string } | { valid: false; reason: string };
