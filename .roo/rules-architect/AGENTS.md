# Project Architecture Rules (Non-Obvious Only)

- Storage corruption handling is critical - always validate that `links` is an array, never trust storage data directly
- State management uses immutable patterns with `safeUpdateState()` and validation for all changes
- Error handling follows a centralized approach with `CodexError` class and `handleError()` function
- Event listeners must use `addTrackedEventListener()` for proper cleanup to prevent memory leaks
- Async operations must be wrapped with `safeAsync()` for automatic error handling and recovery
- Icon loading uses progressive enhancement with caching via `loadIconWithCache()`
- State updates trigger automatic re-rendering through state change listeners
- Storage operations have dual fallback strategy: sync (primary) then local (fallback)
- Link validation happens at multiple levels: input, state update, and rendering
- Drag and drop functionality uses tracked event listeners with proper cleanup
- Theme system applies CSS custom properties with `!important` to override default styles
- Performance optimization uses debouncing for search and batch loading for icons
- Data integrity is maintained through validation schemas in state manager
- Extension initialization has multiple fallback layers for robust startup