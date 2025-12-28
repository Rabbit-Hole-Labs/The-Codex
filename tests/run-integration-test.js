#!/usr/bin/env node

/**
 * Codex Console Integration Test Runner
 * This script verifies that the CodexConsole functions are properly integrated
 */

const fs = require('fs');
const path = require('path');

console.log('=== Codex Console Integration Test Runner ===');

// Check if the consoleCommands.js file exists
const consoleCommandsPath = path.join(__dirname, '..', 'javascript', 'features', 'consoleCommands.js');

if (!fs.existsSync(consoleCommandsPath)) {
    console.error(' FAILURE: consoleCommands.js file not found');
    process.exit(1);
}

console.log(' SUCCESS: consoleCommands.js file found');

// Try to parse the file to check for syntax errors
try {
    const fileContent = fs.readFileSync(consoleCommandsPath, 'utf8');

    // Check for our new functions
    const requiredFunctions = [
        'testStorageCorruptionFix',
        'testAllRealFunctionality',
        'testActualExtensionIssues',
        'injectCorruptedData'
    ];

    let allFound = true;
    for (const funcName of requiredFunctions) {
        if (!fileContent.includes(funcName)) {
            console.error(` FAILURE: Function ${funcName} not found in consoleCommands.js`);
            allFound = false;
        } else {
            console.log(` SUCCESS: Function ${funcName} found in consoleCommands.js`);
        }
    }

    if (allFound) {
        console.log(' ALL INTEGRATION CHECKS PASSED');
        console.log(' The CodexConsole integration appears to be correct');
        console.log(' However, this is still just a static analysis');
        console.log(' Actual functionality must be tested in Chrome console:');
        console.log('   await CodexConsole.testActualExtensionIssues()');
    } else {
        console.error(' SOME INTEGRATION CHECKS FAILED');
        process.exit(1);
    }

} catch (error) {
    console.error(' FAILURE: Error reading or parsing consoleCommands.js:', error.message);
    process.exit(1);
}

console.log('\n  IMPORTANT: This is only a static analysis test');
console.log('  Actual functionality testing requires running in Chrome console');
console.log('  Use: await CodexConsole.testActualExtensionIssues() in the browser console');