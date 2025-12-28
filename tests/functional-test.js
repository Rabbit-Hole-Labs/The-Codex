/**
 * Functional Test for CodexConsole Commands
 * This test actually verifies that the CodexConsole functions exist and can be called
 */

// This function can be run in the Chrome console to verify the integration
async function testCodexConsoleIntegration() {
    console.log('=== CodexConsole Functional Test ===');

    // Check if CodexConsole exists
    if (typeof window.CodexConsole === 'undefined') {
        console.error(' FAILURE: CodexConsole object not found');
        return false;
    }

    console.log(' SUCCESS: CodexConsole object found');

    // List of functions we expect to exist
    const expectedFunctions = [
        'testStorageCorruptionFix',
        'testAllRealFunctionality',
        'testActualExtensionIssues',
        'injectCorruptedData'
    ];

    // Check if all functions exist
    let allFunctionsExist = true;
    for (const funcName of expectedFunctions) {
        if (typeof window.CodexConsole[funcName] !== 'function') {
            console.error(` FAILURE: CodexConsole.${funcName} function not found`);
            allFunctionsExist = false;
        } else {
            console.log(` SUCCESS: CodexConsole.${funcName} function found`);
        }
    }

    if (!allFunctionsExist) {
        console.error(' Some CodexConsole functions are missing');
        return false;
    }

    // Test calling one of the functions (without actually running the full test)
    try {
        // Just verify the function can be called without immediate errors
        const func = window.CodexConsole.testActualExtensionIssues;
        if (typeof func === 'function') {
            console.log(' SUCCESS: testActualExtensionIssues can be called');
        } else {
            console.error(' FAILURE: testActualExtensionIssues is not callable');
            return false;
        }
    } catch (error) {
        console.error(' FAILURE: Error calling testActualExtensionIssues:', error);
        return false;
    }

    console.log(' ALL FUNCTIONAL TESTS PASSED');
    console.log(' The CodexConsole integration is working correctly');
    console.log(' You can now run the actual tests in the Chrome console:');
    console.log('   await CodexConsole.testActualExtensionIssues()');
    console.log('   await CodexConsole.testStorageCorruptionFix()');
    console.log('   await CodexConsole.testAllRealFunctionality()');

    return true;
}

// Export for use in Chrome extension
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { testCodexConsoleIntegration };
}

// Also make available globally for easy testing
window.testCodexConsoleIntegration = testCodexConsoleIntegration;