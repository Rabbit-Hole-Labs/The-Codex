# The Codex Privacy Policy

**Last Updated**: March 2026

## Overview

The Codex is committed to protecting your privacy. This extension operates entirely within your browser and does not collect, transmit, or store any personal data externally.

## Data Collection

**The Codex does NOT collect, transmit, or store any personal data externally.**

### What We Store Locally

All data remains in your browser's Chrome Storage:
- **Your Links**: URLs and names of websites you save
- **Categories**: Custom categories you create
- **Theme Preferences**: Your chosen theme and color settings
- **View Settings**: Grid or list view preference
- **Tile Sizes**: Custom tile size configurations

### Chrome Storage Characteristics
- Encrypted by Chrome automatically
- Syncs across your devices (if Chrome Sync is enabled)
- Never leaves your browser without your explicit action
- Can be cleared by you at any time through Chrome settings

## What We DO NOT Collect

- Personally identifiable information
- Browsing history (except bookmarks you explicitly import)
- Usage analytics
- Crash reports
- Device information
- Location data
- Demographic data

## Data Storage Location

All data is stored locally in Chrome's encrypted storage:
- **Primary**: Chrome Storage Sync (for cross-device synchronization)
- **Fallback**: Chrome Storage Local (for offline access)

## Third-Party Services

The Codex uses the following external services for icon loading:

### Clearbit Logo API
- **Purpose**: Fetches website logos for tile icons
- **When Accessed**: When loading tile icons
- **Authentication**: Public API, no authentication required
- **Data Sent**: Domain name only (e.g., "github.com")
- **Privacy Policy**: [Clearbit Privacy Policy](https://clearbit.com/privacy)

### Google Favicon Service
- **Purpose**: Fetches website favicons as icon fallbacks
- **When Accessed**: When Clearbit logos unavailable
- **Authentication**: Public service, no authentication required
- **Privacy Policy**: [Google Privacy Policy](https://policies.google.com/privacy)

### Content Delivery Networks (CDNs)
- **jsDelivr**: Icon library loading
- **Google Fonts**: Font loading

**No personal data is sent to these services.** Only public domain names are queried for icon retrieval.

## Permissions Explained

| Permission | Purpose | Data Accessed |
|------------|---------|---------------|
| `storage` | Save links and preferences | Local Chrome storage only |
| `bookmarks` | Import bookmarks (you initiate) | Read-only bookmark access |
| `tabs` | Get current tab URL from popup | Active tab URL only |
| `activeTab` | Alternative tab access method | Active tab URL only |

### How Permissions Are Used

1. **storage**: Essential for saving your links and settings
   - No external transmission
   - Encrypted by Chrome

2. **bookmarks**: Optional feature for importing existing browser bookmarks
   - Only accessed when you click "Import Bookmarks"
   - Read-only operation
   - No modification of your browser bookmarks

3. **tabs** & **activeTab**: Used together for quick link addition
   - Only accesses the URL of your currently active tab
   - No access to tab history
   - Only when popup is open

## Your Rights

You have complete control over your data:

1. **Export**: Use the export feature to download your links as JSON
   - Accessible from the management page
   - Fully portable format

2. **Delete**: Clear extension data from Chrome settings
   - Go to `chrome://extensions/`
   - Find "The Codex"
   - Click "Remove"
   - Or clear storage from Chrome DevTools

3. **View All Stored Data**: All stored data is visible in:
   - Chrome DevTools → Application → Storage
   - No hidden data collection

4. **Opt Out of Sync**: Disable Chrome Sync to keep data local

## Data Security

- **Encryption**: Chrome encrypts storage at rest
- **Transmission**: No data transmitted to external servers
- **Access**: Only your Chrome profile can access the data
- **Third Party**: No third-party services have access to your data

## Children's Privacy

The Codex does not knowingly collect any data from anyone, including children under 13. Since we don't collect any personal data, our extension is suitable for all ages.

## Changes to This Policy

This policy may be updated for:
- New features that change data handling patterns
- Clarifications based on user feedback
- Chrome Web Store policy updates

**You will be notified of changes via extension update.**

**Significant Changes**:
- Version history available in extension management page
- Breaking changes documented in CHANGELOG.md

## Contact

For privacy concerns or questions:
- **GitHub Issues**: [Repository URL]
- **Chrome Web Store Listing**: [Extension URL]

## Compliance

- **GDPR**: Compliant - no personal data processed
- **CCPA**: Compliant - no personal information sold
- **Chrome Web Store**: Compliant with Developer Program Policies
- **COPPA**: Compliant - no data collected from children

## Open Source

The Codex is open source software. You can:
- Review the source code on GitHub
- Audit all data handling practices
- Verify no hidden data collection
- Submit privacy-related issues

## Summary

**The Codex respects your privacy by default:**
- ✓ No personal data collection
- ✓ No analytics or tracking
- ✓ No external servers
- ✓ All data stays in your browser
- ✓ You control export and deletion
- ✓ Open for audit

**Your data belongs to you.**