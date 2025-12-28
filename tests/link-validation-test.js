/**
 * Test file to verify link validation fixes
 */

import { validateLink } from '../javascript/features/securityUtils.js';
import { validateAllLinks } from '../javascript/core-systems/stateManager.js';

// Test cases for link validation
const testLinks = [
    // Valid link with all properties
    {
        name: 'Test Link',
        url: 'https://example.com',
        category: 'Test',
        icon: 'https://example.com/icon.png',
        size: 'medium'
    },
    
    // Link with missing optional properties (should be valid)
    {
        name: 'Test Link 2',
        url: 'https://example2.com',
        category: 'Test'
        // icon and size are missing, which should be valid
    },
    
    // Link with null optional properties (should be valid)
    {
        name: 'Test Link 3',
        url: 'https://example3.com',
        category: 'Test',
        icon: null,
        size: null
    },
    
    // Link with invalid icon (should be fixed to null)
    {
        name: 'Test Link 4',
        url: 'https://example4.com',
        category: 'Test',
        icon: 'invalid-url',
        size: 'medium'
    },
    
    // Link with invalid size (should be fixed to null)
    {
        name: 'Test Link 5',
        url: 'https://example5.com',
        category: 'Test',
        icon: 'https://example.com/icon.png',
        size: 'invalid-size'
    }
];

console.log('Testing link validation with updated logic...\n');

testLinks.forEach((link, index) => {
    console.log(`Test link ${index + 1}:`, link);
    const result = validateLink(link);
    console.log(`Validation result:`, result);
    console.log('---');
});

console.log('\nTesting validateAllLinks function...\n');
const allLinksResult = validateAllLinks(testLinks);
console.log('All links validation result:', allLinksResult);

console.log('\nTest completed.');