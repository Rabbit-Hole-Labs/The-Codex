/**
 * State Management Functionality Tests
 * This test suite verifies the state management features of the application
 * including state updates, validation, and rollback functionality
 */


describe('State Management Functionality', () => {
  beforeEach(() => {
    // Reset modules to ensure clean state for each test
    jest.resetModules();
  });

  describe('State Updates', () => {
    test('should update state with valid data', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Update state with valid data
      const updates = {
        theme: 'light',
        view: 'list',
        searchTerm: 'test'
      };

      const result = stateManager.updateState(updates);

      // Verify the update was successful
      expect(result.success).toBe(true);
      expect(result.newState.theme).toBe('light');
      expect(result.newState.view).toBe('list');
      expect(result.newState.searchTerm).toBe('test');
    });

    test('should reject state updates with invalid data', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Try to update with invalid theme
      const invalidUpdates = {
        theme: 'invalid-theme' // Not 'dark' or 'light'
      };

      const result = stateManager.updateState(invalidUpdates, { validate: true });

      // Verify the update was rejected
      expect(result.success).toBe(false);
      expect(result.error).toContain('State validation failed');
    });

    test('should handle batch updates atomically', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Batch update multiple properties
      const updates = {
        theme: 'light',
        view: 'list',
        searchTerm: 'test search'
      };

      const result = stateManager.batchUpdateState(updates);

      // Verify all updates were applied
      expect(result.success).toBe(true);
      expect(result.newState.theme).toBe('light');
      expect(result.newState.view).toBe('list');
      expect(result.newState.searchTerm).toBe('test search');
    });
  });

  describe('State Validation', () => {
    test('should validate link data structure', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Test with valid links (with all required fields including icon)
      const validLinks = [
        { name: 'Valid Link', url: 'https://example.com/', category: 'Test', icon: 'https://example.com/favicon.ico' }
      ];

      const validResult = stateManager.validateAllLinks(validLinks);
      expect(validResult.valid).toBe(true);

      // Test with invalid links
      const invalidLinks = [
        { name: 'Invalid Link', url: 'invalid-url' } // Missing category, invalid URL
      ];

      const invalidResult = stateManager.validateAllLinks(invalidLinks);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBeGreaterThan(0);
    });

    test('should validate individual state properties', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Test valid property values
      const validChanges = {
        theme: 'dark',
        view: 'grid',
        searchTerm: 'test'
      };

      const validResult = stateManager.validateStateChanges(validChanges);
      expect(validResult.valid).toBe(true);

      // Test invalid property values
      const invalidChanges = {
        theme: 'invalid-theme',
        view: 'invalid-view'
      };

      const invalidResult = stateManager.validateStateChanges(invalidChanges);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBeGreaterThan(0);
    });

    test('should handle links with undefined icon and size properties', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Test with undefined icon
      const linksWithUndefinedIcon = [
        { name: 'Test Link', url: 'https://example.com', category: 'Test', icon: undefined }
      ];
      const resultIcon = stateManager.validateAllLinks(linksWithUndefinedIcon);
      expect(resultIcon.valid).toBe(true);

      // Test with undefined size
      const linksWithUndefinedSize = [
        { name: 'Test Link', url: 'https://example.com', category: 'Test', size: undefined }
      ];
      const resultSize = stateManager.validateAllLinks(linksWithUndefinedSize);
      expect(resultSize.valid).toBe(true);

      // Test with both undefined
      const linksWithBothUndefined = [
        { name: 'Test Link', url: 'https://example.com', category: 'Test', icon: undefined, size: undefined }
      ];
      const resultBoth = stateManager.validateAllLinks(linksWithBothUndefined);
      expect(resultBoth.valid).toBe(true);
    });
  });

  describe('State Rollback', () => {
    test('should rollback to previous state', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Get initial state
      const initialState = stateManager.getState();
      
      // Make an update
      stateManager.updateState({ theme: 'light' });
      expect(stateManager.getState().theme).toBe('light');

      // Rollback the change
      const rollbackResult = stateManager.rollbackState();

      // Verify rollback was successful
      expect(rollbackResult.success).toBe(true);
      expect(stateManager.getState().theme).toBe(initialState.theme);
    });

    test('should maintain state history', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Make several updates
      stateManager.updateState({ theme: 'light' });
      stateManager.updateState({ view: 'list' });
      stateManager.updateState({ searchTerm: 'test' });

      // Check history
      const history = stateManager.getStateHistory();
      expect(history.length).toBeGreaterThan(0);
    });
  });

  describe('State Listeners', () => {
    test('should notify listeners of state changes', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Create a mock listener
      const mockListener = jest.fn();

      // Add the listener
      const unsubscribe = stateManager.addStateChangeListener(mockListener);

      // Make a state change
      stateManager.updateState({ theme: 'light' });

      // Verify listener was called
      expect(mockListener).toHaveBeenCalled();
      expect(mockListener.mock.calls[0][0]).toHaveProperty('changes');
      expect(mockListener.mock.calls[0][0]).toHaveProperty('newState');
      expect(mockListener.mock.calls[0][0]).toHaveProperty('previousState');

      // Unsubscribe and verify no more calls
      unsubscribe();
      stateManager.updateState({ view: 'list' });
      expect(mockListener.mock.calls.length).toBe(1);
    });

    test('should notify listeners of validation results', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Create a mock listener
      const mockListener = jest.fn();

      // Add the listener
      const unsubscribe = stateManager.addStateValidationListener(mockListener);

      // Make an invalid state change
      stateManager.updateState({ theme: 'invalid' }, { validate: true });

      // Verify listener was called with validation result
      expect(mockListener).toHaveBeenCalled();
      expect(mockListener.mock.calls[0][0]).toHaveProperty('valid');
      expect(mockListener.mock.calls[0][0]).toHaveProperty('errors');

      // Unsubscribe
      unsubscribe();
    });
  });

  describe('Safe State Updates', () => {
    test('should never throw errors during safe updates', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Try a valid update
      const validResult = await stateManager.safeUpdateState({ theme: 'light' });
      expect(validResult.success).toBe(true);

      // Try an invalid update
      const invalidResult = await stateManager.safeUpdateState({ theme: 'invalid-theme' });
      expect(invalidResult.success).toBe(false);
      expect(invalidResult).toHaveProperty('error');
      // Should not throw, just return error result
    });

    test('should provide rollback state on failures', async () => {
      // Import the state manager
      const stateManagerModule = await import('../javascript/core-systems/stateManager.js');
      const stateManager = stateManagerModule.default;

      // Try an invalid update
      const result = await stateManager.safeUpdateState({ theme: 'invalid-theme' });

      // Should provide rollback state
      expect(result.success).toBe(false);
      expect(result).toHaveProperty('rollbackState');
    });
  });
});