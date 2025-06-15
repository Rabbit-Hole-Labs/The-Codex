import { sanitizeHTML } from '../utils.js';

describe('sanitizeHTML', () => {
  test('removes script tags', () => {
    const unsafe = '<script>alert(1)</script><b>bold</b>';
    expect(sanitizeHTML(unsafe)).toBe('alert(1)bold');
  });
});
