# Project Coding Rules (Non-Obvious Only)

## Core Project Patterns
- Always use `safeUpdateState()` from `javascript/core-systems/stateManager.js` for all state changes (not direct assignment)
- Storage corruption handling: Always validate that `links` is an array, never trust storage data directly - see `javascript/core-systems/storageManager.js`
- Error handling: Use `CodexError` class with `handleError()` for all errors - see `javascript/features/errorHandler.js`
- Event listeners: Use `addTrackedEventListener()` for proper cleanup - see `javascript/entry-points/script.js`
- Async operations: Wrap with `safeAsync()` for automatic error handling - see `javascript/features/errorHandler.js`
- Icon loading: Use `loadIconWithCache()` from `javascript/features/iconCache.js` for all icon loading
- URL validation: Always use `validateAndSanitizeUrl()` from `javascript/features/utils.js` before rendering
- HTML sanitization: Use `sanitizeHTML()` from `javascript/features/utils.js` for all user-generated content
- Link validation: Use `validateLink()` from `javascript/features/securityUtils.js` for link objects
- State updates: Never modify state directly, always use `updateState()` or `safeUpdateState()` with validation
- DOM manipulation: Prefer `optimizedRender()` from `javascript/features/domOptimizer.js` for complex updates

## Chrome Extension Development Standards
- Write clear, modular JavaScript code with proper documentation
- Follow functional programming patterns; avoid classes
- Use descriptive variable names (e.g., isLoading, hasPermission)
- Structure files logically: popup, background scripts, content scripts, utils
- Implement proper error handling and logging
- Document code with JSDoc comments

## Architecture and Best Practices
- Strictly follow Manifest V3 specifications
- Divide responsibilities between background service worker, content scripts, and popup
- Configure permissions following the principle of least privilege
- Implement proper version control and change management

## Chrome API Usage
- Use chrome.* APIs correctly (storage, tabs, runtime, bookmarks, etc.)
- Handle asynchronous operations with Promises and async/await
- Use Service Worker for background scripts (MV3 requirement)
- Implement chrome.alarms for scheduled tasks when needed
- Use chrome.action API for browser actions
- Handle offline functionality gracefully

## Security and Privacy
- Implement Content Security Policy (CSP) as defined in manifest.json
- Handle user data securely with proper encryption
- Prevent XSS and injection attacks using sanitizeHTML()
- Use secure messaging between extension components
- Handle cross-origin requests safely
- Follow web_accessible_resources best practices

## Performance and Optimization
- Minimize resource usage and avoid memory leaks
- Optimize background script performance
- Implement proper caching mechanisms for icons and data
- Handle asynchronous operations efficiently
- Monitor and optimize CPU/memory usage

## Code Style and Structure
- ES6 modules with import/export
- JSDoc comments for all functions
- Console logs for debugging (removed in production)
- Strict validation of all user inputs and storage data
- Defensive programming - never assume data structure

## Security Guidelines (CodeGuard Rules)

### No Hardcoded Credentials
- NEVER store secrets, passwords, API keys, tokens or any other credentials directly in source code
- Treat your codebase as public and untrusted
- Variable names containing: `password`, `secret`, `key`, `token`, `auth` are flagged
- Long random-looking strings that are not clear what they are should be avoided
- Base64 encoded strings near authentication code are suspicious

### Cryptographic Security
- Banned (Insecure) Algorithms - NEVER USE:
  - Hash: MD2, MD4, MD5, SHA-0
  - Symmetric: RC2, RC4, Blowfish, DES, 3DES
  - Key Exchange: Static RSA, Anonymous Diffie-Hellman
- Deprecated (Legacy/Weak) Algorithms - AVOID:
  - Hash: SHA-1
  - Symmetric: AES-CBC, AES-ECB
  - Signature: RSA with PKCS#1 v1.5 padding
- Use Instead:
  - Hash: SHA-256, SHA-384, SHA-512
  - Symmetric: AES-128, AES-256, ChaCha20
  - Key Exchange: ECDHE, DHE with proper validation

### Client-Side Web Security
- XSS Prevention:
  - HTML context: prefer `textContent`. If HTML is required, sanitize with a vetted library (e.g., DOMPurify) and strict allow-lists
  - Attribute context: always quote attributes and encode values
  - JavaScript context: do not build JS from untrusted strings; avoid inline event handlers; use `addEventListener`
  - URL context: validate protocol/domain and encode; block `javascript:` and data URLs
- DOM-based XSS Protection:
  - Prohibit `innerHTML`, `outerHTML`, `document.write` with untrusted data
  - Prohibit `eval`, `new Function`, string-based `setTimeout/Interval`
  - Use strict mode and explicit variable declarations
- Content Security Policy (CSP):
  - Baseline: `default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; upgrade-insecure-requests`

### Input Validation & Injection Defense
- SQL Injection Prevention:
  - Always use parameterized queries/prepared statements
  - Never concatenate user input into SQL strings
  - Validate and sanitize all user inputs
- Command Injection Prevention:
  - Never pass user input directly to system commands
  - Use safe APIs that avoid shell execution
  - Validate input against strict allow-lists
- Path Traversal Prevention:
  - Validate file paths and normalize them
  - Use allow-lists for acceptable file extensions
  - Never use user input directly in file system operations

### Authentication & Session Management
- Password Security:
  - Use bcrypt, scrypt, or Argon2 for password hashing
  - Minimum 12 character passwords with complexity requirements
  - Implement account lockout after failed attempts
- Session Management:
  - Use secure, HTTPOnly, SameSite cookies
  - Implement session timeout and rotation
  - Store session data server-side, not in JWT tokens
- Multi-Factor Authentication:
  - Implement TOTP/SMS as second factor
  - Use WebAuthn/FIDO2 for strong authentication
  - Provide backup codes for account recovery

### API & Web Services Security
- REST/GraphQL Security:
  - Implement proper authentication and authorization
  - Use rate limiting and throttling
  - Validate all input parameters and payloads
  - Implement proper error handling without information leakage
- SSRF Prevention:
  - Validate and sanitize URLs in webhooks and API calls
  - Use allow-lists for acceptable domains/IPs
  - Implement network segmentation for internal services

### File Handling & Uploads
- File Upload Security:
  - Validate file types using content-type, not just extensions
  - Scan uploaded files for malware
  - Store uploads outside web root with random filenames
  - Implement size limits and quota management
- File Delivery:
  - Use secure headers (Content-Disposition, X-Content-Type-Options)
  - Implement access controls for file downloads
  - Use CDN for static content with proper caching headers

### Data & Storage Security
- Database Security:
  - Use TLS for database connections
  - Implement principle of least privilege for database users
  - Use Row Level Security (RLS) and Column Level Security (CLS)
  - Enable audit logging for sensitive operations
- Data Encryption:
  - Encrypt sensitive data at rest and in transit
  - Use proper key management and rotation
  - Implement data classification and handling procedures

### Additional Cryptography & TLS
- Algorithms and Modes:
  - Symmetric: AES-GCM or ChaCha20-Poly1305 preferred. Avoid ECB. CBC/CTR only with encrypt-then-MAC
  - Asymmetric: RSA ≥2048 or modern ECC (Curve25519/Ed25519). Use OAEP for RSA encryption
  - Hashing: SHA-256+ for integrity; avoid MD5/SHA-1
  - RNG: Use CSPRNG appropriate to platform (e.g., SecureRandom, crypto.randomBytes, secrets module)
- Key Management:
  - Generate keys within validated modules (HSM/KMS) and never from passwords or predictable inputs
  - Separate keys by purpose (encryption, signing, wrapping)
  - Store keys in KMS/HSM or vault; never hardcode; avoid plain env vars
- TLS Configuration:
  - Protocols: TLS 1.3 preferred; allow TLS 1.2 only for legacy compatibility
  - Ciphers: prefer AEAD suites; disable NULL/EXPORT/anon
  - Key exchange groups: prefer x25519/secp256r1

### Authorization & Access Control
- Core Principles:
  - Deny by Default: The default for any access request should be 'deny'
  - Principle of Least Privilege: Grant users the minimum level of access required
  - Validate Permissions on Every Request: Check authorization for every single request
- Preventing IDOR:
  - Never trust user-supplied identifiers alone
  - Always verify access to each object instance
- Preventing Mass Assignment:
  - Do not bind request bodies directly to domain objects containing sensitive fields
  - Expose only safe, editable fields via DTOs

### Session Management & Cookies
- Session ID Generation:
  - Generate session IDs with a CSPRNG; ≥64 bits of entropy
  - Opaque, unguessable, and free of meaning
- Cookie Security:
  - Set `Secure`, `HttpOnly`, `SameSite=Strict` (or `Lax` if necessary for flows)
  - Scope cookies narrowly with `Path` and `Domain`
- Session Lifecycle:
  - Regenerate session ID on authentication, password changes, and any privilege elevation
  - Idle timeout: 2-5 minutes for high-value, 15-30 minutes for lower risk

### Logging & Monitoring
- What to Log:
  - Authn/authz events; admin actions; config changes; sensitive data access
  - Include correlation/request IDs, user/session IDs (non-PII), source IP, user agent
- How to Log:
  - Structured logs (JSON) with stable field names
  - Sanitize all log inputs to prevent log injection
  - Redact/tokenize secrets and sensitive fields

### DevOps & CI/CD Security
- Pipeline Security:
  - Scan dependencies for vulnerabilities
  - Implement SAST/DAST in CI/CD pipeline
  - Use signed commits and verify artifact integrity
  - Implement proper secret management in CI/CD
- Container Security:
  - Use minimal base images and scan for vulnerabilities
  - Implement proper container isolation and resource limits
  - Use secrets management systems, not environment variables

### Mobile App Security
- Secure Storage:
  - Use platform-specific secure storage (Keychain, Keystore)
  - Implement certificate pinning for API communications
  - Use biometric authentication where appropriate
- Runtime Protection:
  - Implement anti-tampering and anti-debugging measures
  - Check for debugging, hooking, or code injection
  - Detect emulator or rooted/jailbroken devices

### Infrastructure as Code Security
- Network security:
  - Restrict access to remote administrative services and databases
  - Security Group and ACL inbound rules should NEVER allow `0.0.0.0/0` to sensitive ports
- Data protection:
  - Configure data encryption at rest for all storage services
  - Configure encryption in transit for all data communications
- Access control:
  - NEVER use wildcard permissions in IAM policies
  - NEVER overprivilege service accounts with Owner/Admin roles when not necessary

### XML & Serialization Security
- XXE Prevention:
  - Disable external entity processing in XML parsers
  - Use safe deserialization libraries and validate schemas
  - Avoid unsafe native deserialization
- Safe Deserialization:
  - Never deserialize untrusted native objects
  - Prefer JSON with schema validation
  - Enforce size/structure limits before parsing

### Privacy & Data Protection
- Data Minimization:
  - Collect only necessary data and implement data retention policies
  - Provide user consent mechanisms and data subject rights
  - Implement data anonymization and pseudonymization
- Strong Cryptography:
  - Implement strong cryptography, enforce HTTPS with HSTS
  - Enable certificate pinning to prevent man-in-the-middle attacks
  - Minimize IP address leakage by blocking third-party external content loading

### Supply Chain Security
- Dependency Management:
  - Pin dependency versions and use lock files
  - Scan dependencies for vulnerabilities regularly
  - Use private registries and implement software composition analysis
- Artifact Integrity:
  - Verify package integrity and implement dependency provenance
  - Sign artifacts; verify signatures at deploy

### Cloud Orchestration Security
- Kubernetes Security:
  - Implement RBAC and admission controllers
  - Use network policies and pod security policies
  - Secure container images and implement runtime security
  - Use secrets management systems and encrypt etcd

### Framework & Language Security
- Framework-Specific Guidelines:
  - Follow security best practices for your framework (Django, Rails, .NET, etc.)
  - Use built-in security features and avoid custom implementations
  - Keep frameworks updated and monitor security advisories

### Certificate Management
- X.509 Certificate Validation:
  - Check expiration dates (CRITICAL if expired)
  - Validate public key strength (minimum RSA 2048-bit or ECDSA P-256)
  - Verify signature algorithms (avoid MD5, SHA-1)
  - Identify self-signed certificates and ensure intentional usage

### Safe C Functions & Memory Safety
- Memory Safety:
  - Use safe string functions (strncpy, snprintf, strlcpy)
  - Implement proper bounds checking and buffer overflow protection
  - Use memory-safe languages where possible
- Banned Functions:
  - `gets()`, `strcpy()`, `strcat()`, `sprintf()` without bounds checking
  - Unsafe memory functions without proper size parameters