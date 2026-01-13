# Privacy Policy for InkPages

**Last Updated:** January 2025

## Overview

InkPages is a browser extension that converts web articles into a paginated, book-style format optimized for e-ink devices and comfortable reading. This privacy policy explains what data the extension collects and how it is used.

## Data Collection

### What We Store Locally

The extension stores the following data **locally on your device** using your browser's built-in storage APIs:

1. **Reading Preferences** (synced across devices if browser sync is enabled)
   - Font family, size, and line height settings
   - Theme selection (light, dark, sepia, e-ink)
   - Page width preferences
   - E-ink optimization toggles (bold text, justify, grayscale, hide images)

2. **Enabled Origins** (stored locally)
   - List of websites where you have activated reader mode
   - Used to auto-activate reader on article pages for those sites

3. **Reading Positions** (stored locally)
   - Your last reading position for recently read articles
   - Limited to the last 50 articles
   - Stored by URL to resume where you left off

### What We Do NOT Collect

- **No personal information**: We do not collect names, emails, or any identifying information
- **No browsing history**: We do not track which pages you visit
- **No analytics**: We do not use any analytics or tracking services
- **No external servers**: All data stays on your device; nothing is sent to external servers
- **No third-party sharing**: We do not share any data with third parties

## Data Storage Location

All data is stored using:
- `browser.storage.sync` - For preferences (synced via your browser account if enabled)
- `browser.storage.local` - For enabled origins and reading positions (device-only)

## How to Clear Your Data

You can clear all extension data through your browser:

### Firefox
1. Go to `about:addons`
2. Find "InkPages"
3. Click the three-dot menu → "Remove Extension"

Or clear specific data:
1. Go to `about:debugging#/runtime/this-firefox`
2. Find the extension and click "Inspect"
3. In the console, run: `browser.storage.local.clear()` and `browser.storage.sync.clear()`

### Chrome
1. Go to `chrome://extensions`
2. Find "InkPages"
3. Click "Remove"

## Permissions Explained

The extension requests the following permissions:

- **`activeTab`**: To access the current page content for article extraction
- **`storage`**: To save your preferences and reading positions locally
- **`<all_urls>`**: To enable reader mode on any website you choose

## Third-Party Libraries

This extension uses:
- **Mozilla Readability** (Apache 2.0 License): For extracting article content from web pages. This library runs entirely locally and does not communicate with external services.

## Open Source

This extension is open source. You can review the complete source code to verify these privacy practices.

## Changes to This Policy

If we make changes to this privacy policy, we will update the "Last Updated" date above.

## Contact

If you have questions about this privacy policy, please open an issue at: https://github.com/JKourelis/InkPages/issues
