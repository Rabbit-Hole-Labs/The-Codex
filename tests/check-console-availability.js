/**
 * Test to verify that CodexConsole is properly defined
 * This test can be run in the Chrome console to check if CodexConsole exists
 */

console.log('=== CodexConsole Availability Test ===');

// Check if CodexConsole exists
if (typeof window.CodexConsole !== 'undefined') {
    console.log(' SUCCESS: CodexConsole is defined');
    console.log('CodexConsole object:', window.CodexConsole);

    // Check if our new functions exist
    const testFunctions = [
        'testStorageCorruptionFix',
        'testAllRealFunctionality',
        'testActualExtensionIssues',
        'injectCorruptedData'
    ];

    for (const funcName of testFunctions) {
        if (typeof window.CodexConsole[funcName] === 'function') {
            console.log(` Function ${funcName} exists`);
        } else {
            console.log(` Function ${funcName} does not exist`);
        }
    }
} else {
    console.log(' FAILURE: CodexConsole is not defined');
    console.log('window object keys:', Object.keys(window).filter(key => key.includes('Codex')));

    // Check if the module was loaded
    console.log('Checking if consoleCommands module was loaded...');

    // Try to manually import and initialize
    try {
        // This won't work in browser console, but let's see what we can find
        console.log('Looking for CodexConsole in global scope...');
    } catch (error) {
        console.log('Error during manual check:', error);
    }
}

console.log('=== End of Availability Test ===');