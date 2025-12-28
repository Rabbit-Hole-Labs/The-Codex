# The Codex Chrome Extension

## Overview
The Codex is a powerful Chrome extension designed to enhance your browsing experience by providing advanced link management and organization capabilities. Built with a modular architecture, it offers robust functionality while maintaining high performance and reliability.

## Key Features
- **Link Management**: Organize and manage your favorite links with ease
- **Category Organization**: Group related links into customizable categories
- **Synchronized Data**: Seamlessly sync your links across devices using Chrome's storage APIs
- **Fast Search**: Quickly find links with our optimized search functionality
- **Customizable UI**: Personalize the appearance with theme options
- **Performance Optimized**: Efficiently handles large numbers of links without slowing down your browser

## Architecture
The extension follows a modular architecture with clearly defined components:

### Core Systems
- **Storage Manager**: Handles data persistence with sync and local storage strategies
- **State Manager**: Manages application state with validation and immutable update patterns
- **Sync Manager**: Coordinates data synchronization across devices
- **UI Manager**: Handles user interface rendering and updates
- **Link Manager**: Manages link data structures and operations
- **Category Manager**: Organizes links into categories for better organization

### Entry Points
- **Main Page**: Initializes core systems for the main extension interface
- **Popup**: Provides quick access to your links from the Chrome toolbar
- **Management Page**: Offers advanced configuration and organization options

### Feature Modules
- **Error Handler**: Centralized error handling for consistent user experience
- **Security Utils**: Input sanitization and URL validation for safety
- **Icon Cache**: Efficient icon loading and caching system
- **Utils**: General utility functions
- **DOM Optimizer**: Performance optimizations for DOM operations
- **Console Commands**: Development and debugging utilities
- **Data Verification**: Data integrity checking tools
- **Sync Status Indicator**: Visual feedback for sync operations
- **Sync Settings Controller**: UI controller for sync configuration

## Installation
1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the project directory
5. The extension will be installed and ready to use

## Usage
1. Click the extension icon in the Chrome toolbar to open the popup
2. Add new links using the "+" button
3. Organize links into categories using the management page
4. Search for links using the search bar
5. Access your links from any device with Chrome sync enabled

## Development
### Build/Run Commands
- Test suite: `npm test` (runs all tests with Jest)
- Critical bug tests: `npm run test:critical-bugs`
- Unit tests: `npm run test:unit`
- Integration tests: `npm run test:integration`
- Watch mode: `npm run test:watch`
- Linting: `npm run lint` or `npm run lint:fix`

### Code Style
- ES6 modules with import/export
- JSDoc comments for all functions
- Strict validation of all user inputs and data
- Defensive programming practices

### Testing
- Comprehensive test suite with Jest
- Real Chrome extension tests for actual functionality verification
- Mock Chrome APIs for consistent testing environment

## Contributing
We welcome contributions to improve The Codex! Please follow these steps:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for your changes
5. Run the test suite to ensure everything works
6. Submit a pull request

## License
This project is licensed under the MIT License - see the LICENSE file for details.

## Support
For support, please open an issue on the GitHub repository or contact the development team.