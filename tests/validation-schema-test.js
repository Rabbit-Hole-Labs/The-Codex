/**
 * Test file to verify the validation schema fix in securityUtils.js
 * Tests that null values for icon and size properties are properly handled
 */

import { validateLink } from '../javascript/features/securityUtils.js';

console.log('=== Testing validateLink function with null values ===\n');

// Test 1: Valid link with null icon and size
console.log('Test 1: Valid link with null icon and size');
const testLink1 = {
    name: 'Test Link',
    url: 'https://example.com',
    category: 'Test Category',
    icon: null,
    size: null
};

const result1 = validateLink(testLink1);
console.log('Result:', result1);
console.log('Expected: valid=true, errors=[]\n');

// Test 2: Valid link with string icon and size
console.log('Test 2: Valid link with string icon and size');
const testLink2 = {
    name: 'Test Link 2',
    url: 'https://example2.com',
    category: 'Test Category 2',
    icon: 'https://example.com/icon.png',
    size: 'medium'
};

const result2 = validateLink(testLink2);
console.log('Result:', result2);
console.log('Expected: valid=true, errors=[]\n');

// Test 3: Valid link with undefined icon and size (should be treated as null)
console.log('Test 3: Valid link with undefined icon and size');
const testLink3 = {
    name: 'Test Link 3',
    url: 'https://example3.com',
    category: 'Test Category 3'
    // icon and size are undefined
};

const result3 = validateLink(testLink3);
console.log('Result:', result3);
console.log('Expected: valid=true, errors=[]\n');

// Test 4: Invalid link with wrong type for icon
console.log('Test 4: Invalid link with wrong type for icon (number)');
const testLink4 = {
    name: 'Test Link 4',
    url: 'https://example4.com',
    category: 'Test Category 4',
    icon: 123, // Wrong type - should be string or null
    size: 'medium'
};

const result4 = validateLink(testLink4);
console.log('Result:', result4);
console.log('Expected: valid=false, errors should include icon validation error\n');

// Test 5: Invalid link with wrong type for size
console.log('Test 5: Invalid link with wrong type for size (number)');
const testLink5 = {
    name: 'Test Link 5',
    url: 'https://example5.com',
    category: 'Test Category 5',
    icon: 'https://example.com/icon.png',
    size: 123 // Wrong type - should be string or null
};

const result5 = validateLink(testLink5);
console.log('Result:', result5);
console.log('Expected: valid=false, errors should include size validation error\n');

// Test 6: Invalid link with invalid size value
console.log('Test 6: Invalid link with invalid size value');
const testLink6 = {
    name: 'Test Link 6',
    url: 'https://example6.com',
    category: 'Test Category 6',
    icon: 'https://example.com/icon.png',
    size: 'invalid-size' // Invalid size value
};

const result6 = validateLink(testLink6);
console.log('Result:', result6);
console.log('Expected: valid=false, errors should include size enum validation error\n');

// Summary
console.log('=== Test Summary ===');
console.log('All tests completed. Check the console output above to verify that:');
console.log('1. Null values for icon and size are properly handled');
console.log('2. Undefined values for icon and size are properly handled');
console.log('3. String values for icon and size are properly handled');
console.log('4. Invalid types and values are properly rejected');
console.log('5. Comprehensive logging is present for debugging');