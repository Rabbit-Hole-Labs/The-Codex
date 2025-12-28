# Project Debug Rules (Non-Obvious Only)

- Storage corruption is a common issue - check console for "Storage corruption detected" warnings
- State validation failures will show "State validation failed" errors in console
- Link validation issues will show "Link validation failed" messages
- Icon loading failures are handled gracefully but logged as warnings
- Event listener cleanup issues may cause memory leaks - check "Cleaning up event listeners" logs
- Sync failures will show in the sync status indicator UI and console
- Performance issues can be diagnosed with `CodexConsole.perf()` command
- State rollback functionality available with `CodexConsole.rollback()` command
- Error logs are stored in memory and can be accessed with `CodexConsole.errors()` command
- Check for "CRITICAL ERROR" or "ERROR" level console messages for serious issues
- DOM rendering performance can be monitored with performance marks in console
- Memory leaks can be detected by checking event listener count before/after operations