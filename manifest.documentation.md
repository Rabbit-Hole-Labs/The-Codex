# Manifest Permissions Documentation

## Required Permissions

### storage
**Purpose**: Store user's links, themes, and preferences  
**Usage**: 
- `chrome.storage.sync` for cross-device synchronization (primary storage)
- `chrome.storage.local` for offline fallback
**Data Stored**:
- Links array (user bookmarks)
- Categories (user-defined organization)
- Theme preferences (dark/light mode)
- View settings (grid/list view)
- Tile size preferences

### bookmarks
**Purpose**: Import browser bookmarks into The Codex dashboard  
**Usage**: `chrome.bookmarks.getTree()` to read bookmark structure  
**Scope**: Read-only access, user-initiated imports only  
**User Control**: Only accessed when user explicitly clicks "Import Bookmarks" button

### tabs
**Purpose**: Get current tab URL for quick link addition from popup  
**Usage**: `chrome.tabs.query({active: true, currentWindow: true})`  
**Scope**: Only queries active tab, no access to browser history

### activeTab
**Purpose**: Alternative method to access current tab without broad tabs permission  
**Usage**: Grants temporary access to active tab when user clicks extension icon  
**Note**: Used in conjunction with `tabs` for reliability

## Host Permissions

**None required.** This extension does not require access to external websites except for:
- Loading icon images from allowed CDNs (managed by Content Security Policy)

## Web Accessible Resources

**Configuration**:
```json
{
  "web_accessible_resources": [{
    "resources": ["assets/icons/*"],
    "matches": []
  }]
}
```

**Rationale**: Icons are only used within extension pages (new tab override, popup, management page), not on external websites. Empty `matches` array restricts access to extension context only.

## Content Security Policy

```
script-src 'self'; 
object-src 'self'; 
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; 
font-src 'self' https://fonts.gstatic.com; 
img-src 'self' https://cdn.jsdelivr.net https://clearbit.com https://www.google.com data: http: https:; 
connect-src 'self' https://clearbit.com;
```

**Rationale**:
- `script-src 'self'`: No remote code execution
- `object-src 'self'`: No Flash/Java plugins
- `style-src 'unsafe-inline'`: Required for dynamic theme switching (consider nonce-based CSP in future)
- External resources limited to icon CDNs and fonts

## Background Service Worker

**File**: `javascript/background/service-worker.js`

**Responsibilities**:
- Extension installation/update handling
- Default settings initialization
- Storage integrity verification
- Extension lifecycle management

**Manifest V3 Compliance**:
- Uses persistent service worker (not persistent background page)
- Event-driven architecture
- No long-running operations

## Privacy

**No remote servers**: All data stored locally in Chrome Storage  
**No analytics**: No usage tracking or crash reporting  
**No external APIs**: Only public icon APIs (Clearbit, Google Favicon service)  
**Cross-device sync**: Uses Chrome's built-in sync (encrypted by Chrome)

## Chrome Web Store Compliance

- **Manifest V3**: Fully compliant
- **Single Purpose**: Dashboard for managing frequently used links
- **Permission Justification**: All permissions are necessary for core functionality
- **Data Handling**: All data stays local, no external transmission
- **Remote Code**: None - all scripts bundled with extension