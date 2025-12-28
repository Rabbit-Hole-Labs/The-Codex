# The Codex - AI Coding Instructions

## Project Overview

The Codex is a sophisticated Chrome extension that transforms the new tab page into a customizable dashboard with drag-and-drop tile management, advanced sync capabilities, and intelligent icon loading. Built with vanilla JavaScript and Chrome Extension Manifest V3.

## Architecture & Core Systems

### Modular Architecture
The codebase follows a strict modular pattern with clear separation of concerns:

```
javascript/
├── entry-points/          # Page-specific controllers (script.js, manageScript.js, popup.js)
├── core-systems/          # Core business logic (storage, sync, link, category, UI managers)
└── features/              # Specific feature implementations (sync status, console commands)
```

### Key Architectural Patterns

1. **State Management**: Global state object in entry points with reactive updates
   - Links array with category and size properties
   - Theme system supporting dark/light modes + 11 color themes
   - View modes (grid/list) with responsive layouts

2. **Storage Strategy**: Dual storage with Chrome Sync API
   - Primary: `chrome.storage.sync` for cross-device sync
   - Fallback: `chrome.storage.local` for offline access
   - Automatic sync with debounced operations

3. **Sync System**: Advanced conflict resolution with versioning
   - Conflict strategies: merge, local-wins, remote-wins
   - Data verification and integrity checks
   - Storage quota management and monitoring

## Critical Developer Workflows

### Testing & Debugging
```bash
# Load extension in Chrome
1. Open chrome://extensions/
2. Enable Developer mode
3. Click "Load unpacked" and select project folder

# Access console commands for data verification
CodexConsole.help()              # Show all commands
CodexConsole.compare()           # Compare local vs cloud data
CodexConsole.sync('local')       # Force sync with local wins
```

### Development Commands
```bash
# Install dependencies (if package.json exists)
npm install

# Run tests (if Jest configured)
npm test
```

### Icon System Development
The icon system uses progressive enhancement with quality assessment:
1. Custom icons (user-uploaded)
2. Clearbit logos (external service)
3. High-resolution favicons
4. Standard favicons
5. Text-based fallbacks

## Project-Specific Conventions

### CSS Architecture
- **Theme System**: CSS custom properties with `!important` for theme overrides
- **Tile Sizes**: 8 predefined sizes (compact, small, medium, large, square, wide, tall, giant)
- **Responsive Design**: Mobile-first with breakpoints at 768px and 1024px
- **Animation Guidelines**: Sub-300ms transitions, prefer transform/opacity

### JavaScript Patterns
- **ES6 Modules**: Strict import/export usage
- **Error Handling**: Try-catch blocks around all async operations
- **Event Management**: Proper cleanup with removeEventListener
- **State Updates**: Always save to storage after state mutations

### Chrome Extension Specifics
- **Manifest V3**: Service worker background scripts
- **Permissions**: storage, bookmarks, activeTab, tabs
- **Content Security Policy**: script-src 'self'; object-src 'self'
- **Web Accessible Resources**: assets/icons/* for all URLs

## Integration Points & External Dependencies

### Chrome APIs
- **chrome.storage**: Primary data persistence
- **chrome.bookmarks**: Import functionality
- **chrome.tabs**: New tab override and popup interactions
- **chrome.runtime**: Extension lifecycle management

### External Services
- **Clearbit Logo API**: For automatic icon fetching
- **Favicon Services**: Multiple fallback sources for icons

### Cross-Component Communication
- **Storage Events**: Chrome storage change listeners for real-time updates
- **Sync Events**: Custom event system for sync status notifications
- **State Propagation**: Reactive rendering based on state changes

## Data Structures & Schemas

### Link Object
```javascript
{
  name: string,           // Site name
  url: string,            // Full URL
  category: string,       // Category name
  icon: string,           // Icon URL or 'default'
  size: string,           // Tile size (optional, uses default if missing)
  id: string              // Auto-generated unique ID
}
```

### Theme Configuration
```javascript
{
  theme: 'dark' | 'light',
  colorTheme: 'default' | 'ocean' | 'cosmic' | 'sunset' | 'forest' | 'fire' | 'aurora',
  view: 'grid' | 'list',
  defaultTileSize: string
}
```

## Common Development Tasks

### Adding New Tile Shapes
1. Add CSS class `.link-tile.size-newshape` in styles.css
2. Update HTML select options in manage.html
3. Add responsive rules for mobile

### Adding New Themes
1. Define CSS custom properties with `!important`
2. Add theme preview card in manage.html
3. Update theme switcher logic

### Extending Drag & Drop
- Add event listeners to new drop zones
- Implement custom drop handlers
- Update visual feedback system

## Performance & Security Considerations

### Storage Limits
- Chrome sync: 100KB total, 8KB per item
- Always handle quota exceeded errors
- Implement data compression for large datasets

### Security Requirements
- Sanitize all user inputs with sanitizeHTML()
- Use CSP-compliant external resources only
- Validate all URLs before storage

### Performance Optimization
- Debounce frequent storage operations
- Use CSS transforms for animations
- Implement progressive icon loading

## Error Handling Patterns

### Storage Operations
```javascript
try {
  await chrome.storage.sync.set(data);
} catch (error) {
  if (error.message.includes('QUOTA_BYTES')) {
    // Handle quota exceeded
    await chrome.storage.local.set(data);
  }
  console.error('Storage error:', error);
}
```

### Sync Operations
```javascript
try {
  await syncManager.sync();
} catch (error) {
  console.error('Sync failed:', error);
  // Notify user, fallback to local storage
}
```

## Code Quality Standards

### Naming Conventions
- **Functions**: camelCase, descriptive verbs (e.g., `renderLinks`, `saveSettings`)
- **Variables**: camelCase, clear intent (e.g., `isDragging`, `filteredLinks`)
- **CSS Classes**: kebab-case, BEM-inspired (e.g., `link-tile`, `theme-preview-card`)

### Documentation
- JSDoc comments for public functions
- Inline comments for complex logic
- Console logs for debugging (remove in production)

### Testing Requirements
- Manual testing checklist in DEVELOPMENT.md
- Console commands for data verification
- Cross-device sync testing

This guide ensures consistent development practices and helps AI agents understand the unique architectural decisions and patterns specific to The Codex project.

## Security Rules & Guidelines

### Chrome Extension Development

**Code Style and Structure:**
- Write clear, modular JavaScript code with proper documentation
- Follow functional programming patterns; avoid unnecessary classes
- Use descriptive variable names (e.g., `isLoading`, `hasPermission`)
- Structure files logically: popup, background scripts, content scripts, utils
- Implement proper error handling and logging
- Document code with JSDoc comments

**Architecture and Best Practices:**
- Strictly follow Manifest V3 specifications (currently using v3)
- Divide responsibilities between background service worker, content scripts, and popup
- Configure permissions following the principle of least privilege
- Use modern build tools when needed for development
- Implement proper version control and change management

**Chrome API Usage:**
- Use chrome.* APIs correctly (storage, tabs, runtime, bookmarks, etc.)
- Handle asynchronous operations with Promises and async/await
- Use Service Worker for background scripts (MV3 requirement)
- Implement chrome.alarms for scheduled tasks when needed
- Use chrome.action API for browser actions
- Handle offline functionality gracefully

**Security and Privacy:**
- Implement Content Security Policy (CSP) as defined in manifest.json
- Handle user data securely with proper encryption
- Prevent XSS and injection attacks using sanitizeHTML()
- Use secure messaging between extension components
- Handle cross-origin requests safely
- Follow web_accessible_resources best practices

**Performance and Optimization:**
- Minimize resource usage and avoid memory leaks
- Optimize background script performance
- Implement proper caching mechanisms for icons and data
- Handle asynchronous operations efficiently
- Monitor and optimize CPU/memory usage

**UI and User Experience:**
- Implement responsive design for popup windows
- Provide clear user feedback for all operations
- Support keyboard navigation and shortcuts
- Ensure proper loading states and animations
- Follow accessibility guidelines (ARIA labels, color contrast)

**Testing and Debugging:**
- Use Chrome DevTools effectively for extension debugging
- Test cross-browser compatibility where applicable
- Monitor performance metrics and storage usage
- Handle error scenarios gracefully

**Publishing and Maintenance:**
- Prepare store listings and screenshots when needed
- Write clear privacy policies for user data handling
- Implement update mechanisms for extension updates
- Handle user feedback and maintain documentation

### General Security Rules

### 1. No Hardcoded Credentials

### 1. No Hardcoded Credentials
**NEVER store secrets, passwords, API keys, tokens or any other credentials directly in source code.**

**Banned Patterns:**
- AWS Keys: `AKIA`, `AGPA`, `AIDA`, `AROA`, `AIPA`, `ANPA`, `ANVA`, `ASIA`
- Stripe Keys: `sk_live_`, `pk_live_`, `sk_test_`, `pk_test_`
- Google API: `AIza` followed by 35 characters
- GitHub Tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`
- JWT Tokens: Three base64 sections separated by dots, starts with `eyJ`
- Private Key Blocks: Any text between `-----BEGIN` and `-----END PRIVATE KEY-----`
- Connection Strings: URLs with credentials like `mongodb://user:pass@host`

**Warning Signs:**
- Variable names containing: `password`, `secret`, `key`, `token`, `auth`
- Long random-looking strings that are not clear what they are
- Base64 encoded strings near authentication code

### 2. Cryptographic Security
**Banned (Insecure) Algorithms - NEVER USE:**
- Hash: `MD2`, `MD4`, `MD5`, `SHA-0`
- Symmetric: `RC2`, `RC4`, `Blowfish`, `DES`, `3DES`
- Key Exchange: Static RSA, Anonymous Diffie-Hellman

**Deprecated (Legacy/Weak) Algorithms - AVOID:**
- Hash: `SHA-1`
- Symmetric: `AES-CBC`, `AES-ECB`
- Signature: RSA with `PKCS#1 v1.5` padding

**Use Instead:**
- Hash: SHA-256, SHA-384, SHA-512
- Symmetric: AES-128, AES-256, ChaCha20
- Key Exchange: ECDHE, DHE with proper validation

### 3. Client-Side Web Security
**XSS Prevention:**
- HTML context: prefer `textContent`. If HTML is required, sanitize with a vetted library (e.g., DOMPurify) and strict allow-lists
- Attribute context: always quote attributes and encode values
- JavaScript context: do not build JS from untrusted strings; avoid inline event handlers; use `addEventListener`
- URL context: validate protocol/domain and encode; block `javascript:` and data URLs

**DOM-based XSS Protection:**
- Prohibit `innerHTML`, `outerHTML`, `document.write` with untrusted data
- Prohibit `eval`, `new Function`, string-based `setTimeout/Interval`
- Use strict mode and explicit variable declarations

**Content Security Policy (CSP):**
- Baseline: `default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; upgrade-insecure-requests`

### 4. Input Validation & Injection Defense
**SQL Injection Prevention:**
- Always use parameterized queries/prepared statements
- Never concatenate user input into SQL strings
- Validate and sanitize all user inputs

**Command Injection Prevention:**
- Never pass user input directly to system commands
- Use safe APIs that avoid shell execution
- Validate input against strict allow-lists

**Path Traversal Prevention:**
- Validate file paths and normalize them
- Use allow-lists for acceptable file extensions
- Never use user input directly in file system operations

### 5. Authentication & Session Management
**Password Security:**
- Use bcrypt, scrypt, or Argon2 for password hashing
- Minimum 12 character passwords with complexity requirements
- Implement account lockout after failed attempts

**Session Management:**
- Use secure, HTTPOnly, SameSite cookies
- Implement session timeout and rotation
- Store session data server-side, not in JWT tokens

**Multi-Factor Authentication:**
- Implement TOTP/SMS as second factor
- Use WebAuthn/FIDO2 for strong authentication
- Provide backup codes for account recovery

### 6. API & Web Services Security
**REST/GraphQL Security:**
- Implement proper authentication and authorization
- Use rate limiting and throttling
- Validate all input parameters and payloads
- Implement proper error handling without information leakage

**SSRF Prevention:**
- Validate and sanitize URLs in webhooks and API calls
- Use allow-lists for acceptable domains/IPs
- Implement network segmentation for internal services

### 7. File Handling & Uploads
**File Upload Security:**
- Validate file types using content-type, not just extensions
- Scan uploaded files for malware
- Store uploads outside web root with random filenames
- Implement size limits and quota management

**File Delivery:**
- Use secure headers (Content-Disposition, X-Content-Type-Options)
- Implement access controls for file downloads
- Use CDN for static content with proper caching headers

### 8. Data & Storage Security
**Database Security:**
- Use TLS for database connections
- Implement principle of least privilege for database users
- Use Row Level Security (RLS) and Column Level Security (CLS)
- Enable audit logging for sensitive operations

**Data Encryption:**
- Encrypt sensitive data at rest and in transit
- Use proper key management and rotation
- Implement data classification and handling procedures

### 9. Logging & Monitoring
**Security Logging:**
- Log authentication attempts, authorization failures, and data access
- Implement structured logging with correlation IDs
- Protect log integrity and implement log retention policies

**Monitoring & Alerting:**
- Monitor for suspicious activities and anomalies
- Implement real-time alerting for security events
- Use SIEM tools for centralized log analysis

### 10. DevOps & CI/CD Security
**Pipeline Security:**
- Scan dependencies for vulnerabilities
- Implement SAST/DAST in CI/CD pipeline
- Use signed commits and verify artifact integrity
- Implement proper secret management in CI/CD

**Container Security:**
- Use minimal base images and scan for vulnerabilities
- Implement proper container isolation and resource limits
- Use secrets management systems, not environment variables
- Implement runtime security monitoring

### 11. Mobile App Security
**Secure Storage:**
- Use platform-specific secure storage (Keychain, Keystore)
- Implement certificate pinning for API communications
- Use biometric authentication where appropriate
- Implement anti-tampering and anti-debugging measures

### 12. Infrastructure as Code Security
**Terraform/CloudFormation:**
- Scan IaC templates for security misconfigurations
- Implement proper access controls for infrastructure
- Use encryption for data at rest and in transit
- Implement network segmentation and security groups

### 13. XML & Serialization Security
**XXE Prevention:**
- Disable external entity processing in XML parsers
- Use safe deserialization libraries and validate schemas
- Implement proper input validation for serialized data
- Avoid unsafe native deserialization

### 14. Privacy & Data Protection
**Data Minimization:**
- Collect only necessary data and implement data retention policies
- Provide user consent mechanisms and data subject rights
- Implement data anonymization and pseudonymization
- Ensure compliance with GDPR, CCPA, and other privacy regulations

### 15. Supply Chain Security
**Dependency Management:**
- Pin dependency versions and use lock files
- Scan dependencies for vulnerabilities regularly
- Use private registries and implement software composition analysis
- Verify package integrity and implement dependency provenance

### 16. Cloud Orchestration Security
**Kubernetes Security:**
- Implement RBAC and admission controllers
- Use network policies and pod security policies
- Secure container images and implement runtime security
- Use secrets management systems and encrypt etcd

### 17. Framework & Language Security
**Framework-Specific Guidelines:**
- Follow security best practices for your framework (Django, Rails, .NET, etc.)
- Use built-in security features and avoid custom implementations
- Keep frameworks updated and monitor security advisories
- Implement proper configuration management

### 18. Certificate Management
**X.509 Certificate Validation:**
- Check expiration dates (CRITICAL if expired)
- Validate public key strength (minimum RSA 2048-bit or ECDSA P-256)
- Verify signature algorithms (avoid MD5, SHA-1)
- Identify self-signed certificates and ensure intentional usage

### 19. Safe C Functions
**Memory Safety:**
- Use safe string functions (strncpy, snprintf, strlcpy)
- Implement proper bounds checking and buffer overflow protection
- Use memory-safe languages where possible
- Implement proper error handling and resource cleanup

### 20. Authorization & Access Control
**RBAC/ABAC Implementation:**
- Implement principle of least privilege
- Use role-based or attribute-based access control
- Prevent IDOR (Insecure Direct Object References)
- Implement proper authorization checks at every layer

### 21. Session Management
**Secure Session Handling:**
- Implement secure session generation and rotation
- Use proper session timeout and invalidation
- Prevent session fixation attacks
- Implement CSRF protection for state-changing operations

### 22. Additional Cryptography
**Advanced Crypto Guidelines:**
- Use established cryptographic libraries (OpenSSL, BoringSSL)
- Implement proper random number generation
- Use appropriate key sizes and algorithms for the use case
- Implement proper key derivation and stretching

### 23. Safe Functions & Memory Safety
**General Security Practices:**
- Validate all inputs and outputs
- Implement proper error handling without information leakage
- Use defense in depth and layered security
- Implement proper logging and monitoring for security events