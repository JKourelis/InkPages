# InkPages - Development Context for Claude

## Project Overview

InkPages is a Firefox extension that provides Safari-like reader mode with paginated, book-style display optimized for e-ink devices (Kindle Scribe, Boox, reMarkable, etc.).

**Repository**: https://github.com/JKourelis/InkPages
**AMO Listing**: (pending approval, slug: `inkpages-reader` or similar)
**License**: Apache 2.0

## Architecture Decisions

### In-Page Rendering with Shadow DOM
- **Decision**: Render reader overlay in the current page using Shadow DOM, NOT in a new tab
- **Why**:
  - Back button works naturally (goes to previous page, not through reader history)
  - Safari-like behavior where reader mode is an overlay
  - Shadow DOM provides style isolation from the host page

### Manifest V2 (not V3)
- **Decision**: Use Manifest V2 for Firefox
- **Why**:
  - MV3 had issues with temporary add-on loading during development
  - MV2 is still fully supported on Firefox
  - Chrome version will need MV3 (see Chrome section below)

### Content Script Auto-Injection
- **Decision**: Content script loads on ALL pages via manifest `content_scripts`
- **Why**: Enables "sticky" reader mode - auto-activates on article pages for remembered sites

### Readability Bundling
- **Decision**: Include Readability.js directly in manifest's `content_scripts` array
- **Why**:
  - Original approach used `new Function()` (eval-like) which AMO rejects
  - Direct inclusion is cleaner and passes AMO validation

## Key Features

1. **True Pagination**: CSS multi-column layout with `translateX` navigation (no scrolling)
2. **Article Detection**: Heuristics to detect articles vs homepages/listing pages
3. **Site Memory**: Remembers which origins have reader mode enabled
4. **Auto-Activation**: On remembered sites, auto-activates only on detected article pages
5. **Reading Position Memory**: Saves position per URL (last 50 articles)
6. **Link Handling**: Same-origin links navigate normally, external links open in new tab
7. **HTML Sanitization**: Strips event handlers, javascript: URLs, scripts, forms, iframes
8. **Cookie/Embed Filtering**: Removes social media embed placeholders and cookie consent blocks

## Technical Details

### Pagination Engine (content.js)
```javascript
// Key approach: measure natural height, calculate pages, use CSS columns
content.style.width = 'max-content';  // Let browser calculate
content.style.columnWidth = viewportWidth + 'px';
content.style.columnGap = columnGap + 'px';
// Navigate with: content.style.transform = `translateX(-${offset}px)`;
```

### Article Detection (isArticlePage function)
- Rejects homepage (path === '/')
- Checks paragraph density (>2000 chars, >3 substantial paragraphs)
- Detects listing pages (many short items)
- Final check: Readability extraction must yield >200 words

### Settings Storage
- `storage.sync`: User preferences (font, theme, etc.) - syncs across devices
- `storage.local`: Enabled origins list, reading positions

## AMO Submission Notes

### Required Manifest Fields (as of Nov 2025)
```json
"browser_specific_settings": {
  "gecko": {
    "id": "{77d4cdb4-ab52-4e89-ba4b-db8a517a085f}",
    "strict_min_version": "140.0",
    "data_collection_permissions": {
      "required": ["none"]
    }
  },
  "gecko_android": {
    "strict_min_version": "140.0"
  }
}
```

### innerHTML Warnings (Expected)
AMO shows warnings for innerHTML usage. These are acceptable because:
- Our code has `sanitizeHTML()` (content.js ~line 219) that strips dangerous content
- Readability.js warnings are from Mozilla's own library

### Reviewer Notes
Submitted with notes explaining sanitization approach and that Readability is Mozilla's library.

## Chrome Version (TODO)

**Difficulty: Moderate** - mostly config changes, not a rewrite.

Chrome requires Manifest V3. Key changes needed:

### 1. Manifest Changes

| Firefox (MV2) | Chrome (MV3) |
|---------------|--------------|
| `"manifest_version": 2` | `"manifest_version": 3` |
| `"browser_action": {...}` | `"action": {...}` |
| `"background": { "scripts": [...] }` | `"background": { "service_worker": "..." }` |
| Simple `"web_accessible_resources"` array | Object with `"resources"` and `"matches"` |

### 2. API Changes

| Firefox | Chrome MV3 |
|---------|------------|
| `browser.browserAction` | `chrome.action` |
| `browser.tabs.executeScript()` | `chrome.scripting.executeScript()` |
| Persistent background page | Service worker (non-persistent) |

### 3. Service Worker Considerations

The background script becomes a service worker in MV3:
- **No persistent state**: Variables reset when worker sleeps
- **No DOM access**: Can't use `document`, `window` in background
- **Event-driven**: Must re-register listeners on wake

For InkPages, background.js is simple (just handles toolbar click), so this is minimal work.

### 4. CSP Changes
- Stricter CSP in MV3
- No `eval()` or `new Function()` - **we already removed this**
- Remote code loading prohibited - **we don't use this**

### 5. Suggested Implementation

```bash
# File structure
InkPages/
├── manifest.json        # Firefox MV2
├── manifest.chrome.json # Chrome MV3
├── src/
│   ├── background/
│   │   ├── background.js         # Firefox
│   │   └── background.chrome.js  # Chrome service worker
│   └── ... (rest shared)
```

**Option A**: Maintain two manifest files manually
**Option B**: Build script that generates both from a template

### 6. Code Reuse Estimate

| Component | Reusable | Changes Needed |
|-----------|----------|----------------|
| content.js | 99% | Change `browser` to `chrome` (or use polyfill) |
| reader.html | 100% | None |
| reader.css | 100% | None |
| reader.js | 100% | None |
| background.js | 70% | Rewrite for service worker pattern |
| Readability.js | 100% | None |

### 7. Polyfill Option

Mozilla's `webextension-polyfill` allows using `browser.*` API in Chrome:
```html
<script src="browser-polyfill.min.js"></script>
```
This would minimize code changes but adds ~15KB.

## Safari iOS App (TODO)

**Difficulty: Higher** - not the code, but the tooling and distribution.

### Requirements

- Mac with Xcode (free)
- Apple Developer Account ($99/year)
- App Store review process (can take days)

### How Safari Web Extensions Work

Safari on iOS/macOS supports the WebExtensions API (same standard as Firefox/Chrome). However, extensions must be:
1. Wrapped in a native app container
2. Distributed via the App Store
3. Built with Xcode

### Implementation Steps

1. **Create Xcode Project**
   - File → New → Project → Safari Extension App
   - This creates an app wrapper + extension target

2. **Port Extension Code**
   - Copy `src/` folder into the extension target
   - Adapt manifest.json to Safari's format (similar to MV2)
   - Safari uses `browser.*` APIs like Firefox

3. **Handle Safari-Specific Differences**
   - Some APIs may be missing or behave differently
   - Test thoroughly on iOS Safari
   - Handle permissions prompts (Safari is stricter)

4. **App Store Submission**
   - App must have a minimal UI (even if just "Enable in Safari Settings")
   - Privacy policy required (we have PRIVACY.md)
   - Review can reject for various reasons

### Safari API Compatibility

| Feature | Safari Support |
|---------|----------------|
| Content scripts | ✅ Yes |
| Background scripts | ✅ Yes (non-persistent) |
| storage.local | ✅ Yes |
| storage.sync | ⚠️ Limited (uses iCloud) |
| Shadow DOM | ✅ Yes |
| CSS columns | ✅ Yes |

### Code Reuse Estimate

| Component | Reusable | Notes |
|-----------|----------|-------|
| content.js | 95% | Minor API adjustments |
| reader.html/css/js | 100% | Fully compatible |
| background.js | 80% | Similar to Chrome service worker |
| Readability.js | 100% | No changes |

### Distribution Considerations

- **App Store**: Primary distribution, reaches most users
- **TestFlight**: Beta testing before release
- **No sideloading**: Unlike Firefox/Chrome, users can't install from files

### Cost Analysis

| Item | Cost |
|------|------|
| Apple Developer Account | $99/year |
| Mac (if needed) | $600+ (or use Mac in Cloud) |
| Xcode | Free |
| Time to port | ~1-2 days |
| App Store review | 1-7 days |

## Intentional Design Decisions

### Article Header Hidden on Pages 2+
- **Decision**: Hide the full article header (title, byline, reading time) on pages 2 and beyond
- **Why**:
  - Maximizes reading space on e-ink devices where screen real estate is precious
  - Compact title is shown in the top bar, so context is preserved
  - Full screen height is used on pages 2+ (no wasted space)
- **Implementation**: `content.js` line ~1114 - header gets `.minimized` class (display: none)
- **DO NOT REMOVE THIS BEHAVIOR** - it was added intentionally in v1.0.3

### Solution: Absolute Header + Content Spacer (v1.0.4)
The content loss issue was solved by:
1. **Positioning header absolutely**: Header overlays content without affecting viewport height
2. **Injecting a spacer**: A div at the start of content with height matching the header
3. **Consistent column height**: Viewport height is always the same (full height)

**How it works**:
- Header is `position: absolute` with background color (covers content behind it)
- Spacer div (`#header-spacer`) is injected at start of `#article-content`
- Spacer height is measured dynamically from actual header height
- On page 0: spacer pushes content down, header overlays spacer area
- On pages 1+: header hidden, spacer is in column 0 only, full content visible

**Key functions**:
- `updateHeaderSpacer()`: Measures header, creates/updates spacer
- Called before `setupPagination()` in: renderArticle, renderListing, applySettings, resize handler

**Edge cases handled**:
- Long titles: larger spacer, less content on page 0 (correct behavior)
- Font size changes: spacer remeasured when settings change
- Viewport resize: spacer remeasured on window resize

### CSS Specificity Fix for TOC Mode (v1.0.7)

**Root Cause**: TOC/listing mode pagination was broken on narrow screens because of CSS specificity conflicts.

The article mode base styles used ID selectors:
```css
#article-content ul { padding-left: 1.5em; }  /* Specificity: 1-0-1 (101) */
#article-content li { margin-bottom: 0.5em; } /* Specificity: 1-0-1 (101) */
```

The listing mode styles used class selectors:
```css
.listing-items { padding: 0; }    /* Specificity: 0-1-0 (10) - LOSES */
.listing-item { margin-bottom: 0; } /* Specificity: 0-1-0 (10) - LOSES */
```

**Result**: Listing `<ul>` and `<li>` elements inherited article styles (extra padding/margins), causing:
1. Content shifted right, overflowing column boundaries
2. Column width calculations wrong (scrollWidth larger than expected)
3. Progressive misalignment when navigating pages ("drifting out of frame")

**v1.0.6 attempted fix (incomplete)**: Used `:not()` selectors to exclude listing classes from article styles. This failed because sub-link `<li>` elements have no class, so they still matched `li:not(.listing-item)`.

**v1.0.7 fix**: Prefix ALL listing selectors with `#article-content` to give them higher specificity:
```css
/* Article styles - specificity 101 */
#article-content ul { padding-left: 1.5em; }
#article-content li { margin-bottom: 0.5em; }

/* Listing styles - specificity 110-111 (wins!) */
#article-content .listing-items { padding: 0; }
#article-content .listing-item { margin-bottom: 0; }
#article-content .listing-sub-links { padding: 0 0 0.5em 0.75em; }
#article-content .listing-sub-links li { margin-bottom: 0; }
```

**CSS location**: `reader.css` lines ~945-1104

**Why this works**: Specificity 110 (ID + class) always beats 101 (ID + element), so listing styles correctly override article styles regardless of source order or nested elements.

### Sub-Pixel Pagination Fix (v1.0.9)

**Root Cause**: On narrow e-reader screens, viewport dimensions could have fractional pixels (e.g., 359.5px), causing progressive drift when navigating pages.

**The Problem**:
- `getBoundingClientRect()` returns fractional values
- Column calculations used these fractional values
- Each page navigation accumulated small errors
- After several pages, content would "drift out of frame"

**The Fix**: Always round viewport dimensions to integers:
```javascript
// Before (v1.0.8-debug, conditional)
if (dbg.roundPixels) {
  viewportWidth = Math.floor(viewportWidth);
  viewportHeight = Math.floor(viewportHeight);
}

// After (v1.0.9, always applied)
const viewportWidth = Math.floor(viewportRect.width);
const viewportHeight = Math.floor(viewportRect.height);
```

**Why Math.floor()**: Rounding down ensures content never overflows the viewport. Rounding up could cause content to be cut off.

**Code location**: `content.js` `setupPagination()` function

### HTML Export Feature (v1.0.9)

Added ability to export articles as self-contained HTML files.

**Implementation**:
- Export button in header bar (download icon)
- `exportArticle()` function generates clean HTML
- Uses Web Share API on mobile (opens native share sheet)
- Falls back to direct download on desktop

**How sharing works on mobile**:
```javascript
const file = new File([html], 'article.html', { type: 'text/html' });
if (navigator.canShare && navigator.canShare({ files: [file] })) {
  await navigator.share({ files: [file], title: articleData.title });
}
```

**Export HTML structure**:
- Inline CSS (no external dependencies)
- Article title, byline, source URL
- Full article content with images (external URLs)
- "Saved with InkPages" footer

**Code locations**:
- `content.js`: `exportArticle()`, `generateExportHTML()`
- `reader.html`: Export button in header-right

### Debug Options (v1.0.9 - Temporary)

Debug options are currently visible in Settings for testing pagination fixes:
1. Zero all ul/li styles
2. Force listing !important
3. Round pixel values (now always on, shown as disabled)
4. Use calculated width
5. Integer column width

**TODO**: Remove debug panel in next release if v1.0.9 pagination fix is confirmed working.

**Location**: `reader.html` settings panel, `content.js` `setupDebugControls()`

### TOC Mode Layout Fixes for Narrow Screens (v1.0.5)
The TOC/listing mode had issues on phone-sized e-reader screens (320-400px width):

**Problem 1: Text cut off on right edge**
- Long words/URLs would overflow column boundaries
- **Fix**: Added `overflow-wrap: break-word` and `word-break: break-word` to `.listing-main-link` and `.listing-sub-links a`

**Problem 2: Excessive sub-link indentation**
- Original indentation: `padding-left: 1.25em` + `margin-left: 0.5em` = ~32px
- On narrow screens, this wasted ~10% of available width
- **Fix**: Reduced to `padding-left: 0.75em` + `margin-left: 0.25em` = ~20px

**Problem 3: Titles spanning across pages**
- Listing items could break mid-title across column boundaries
- **Fix**: Added `break-inside: avoid` to `.listing-item`
- CSS gracefully degrades for extremely long titles (allows breaking if necessary)

**Note**: v1.0.5 fixes were insufficient because the root cause (CSS specificity) wasn't addressed until v1.0.6.

**CSS locations** (`reader.css`):
- `.listing-item` line ~988: `break-inside: avoid`
- `.listing-main-link` line ~1000: word-break properties
- `.listing-sub-links` line ~1018: reduced indentation
- `.listing-sub-links a` line ~1032: word-break properties

## Known Limitations

1. JavaScript-rendered pages may not extract properly (Readability needs DOM content)
2. Paywalled content cannot be extracted
3. Complex layouts may have extraction artifacts
4. Firefox Android: Works but UI accessed via menu, not toolbar

## File Structure

```
InkPages/
├── manifest.json           # MV2 manifest for Firefox
├── LICENSE                 # Apache 2.0
├── README.md
├── PRIVACY.md             # Privacy policy
├── CLAUDE.md              # This file
├── .gitignore
├── icons/
│   ├── icon.svg           # Source SVG
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
└── src/
    ├── background/
    │   └── background.js   # Toolbar click handling, message passing
    ├── content/
    │   └── content.js      # Main logic: extraction, rendering, pagination
    ├── lib/
    │   └── Readability.js  # Mozilla Readability (Apache 2.0)
    └── reader/
        ├── reader.html     # Reader UI template
        ├── reader.css      # Styles with theme support
        └── reader.js       # Original reader (now mostly in content.js)
```

## Future Improvements

### High Priority Features

1. **Send to Kindle** - Email article directly to user's Kindle email address
   - Implementation: Add settings field for Kindle email, use mailto: or email API
   - Format: Could send HTML or generate MOBI/EPUB

2. **EPUB Export** - More universal for dedicated e-readers than HTML
   - EPUB is a zip file with specific XML structure
   - Libraries: JSZip + custom EPUB generator, or epub-gen
   - More complex than HTML but better e-reader compatibility

3. **Offline Reading** - Cache articles for reading without internet
   - Use IndexedDB or Cache API to store article content
   - Add "Save for offline" button
   - Show saved articles list

4. **Annotations/Highlights** - Mark important passages, export notes
   - Store highlights in storage.local keyed by URL
   - Render highlight overlays on text
   - Export as markdown or JSON

5. **Sync Across Devices** - Reading position sync via Firefox Sync
   - Already using storage.sync for settings
   - Could extend to reading positions (currently in storage.local)

### Nice to Have Features

6. **Text-to-Speech** - Read articles aloud
   - Use Web Speech API (speechSynthesis)
   - Controls for play/pause, speed, voice selection

7. **Search Within Article** - Find text in current article
   - Ctrl+F style overlay
   - Highlight matches, navigate between them

8. **Table of Contents** - For long articles
   - Extract headings (h1-h6) from article
   - Sidebar or dropdown navigation

9. **Auto Page-Turn** - Timed automatic page advancement
   - Configurable interval (e.g., 30 seconds)
   - Useful for hands-free reading

10. **Reading Statistics** - Track reading habits
    - Time spent reading, articles completed
    - Words read, reading speed estimates
    - Store in storage.local, show in settings

11. **Custom Fonts** - Allow font file upload
    - Store font in IndexedDB
    - Use FontFace API to load

12. **Pocket/Instapaper Integration** - Save to read-later services
    - OAuth integration with services
    - One-click save button

### Platform Expansion

13. **Chrome Extension** - See detailed section below
14. **Safari iOS App** - See detailed section below
15. **Edge Extension** - Same as Chrome (Chromium-based)

## Build/Release Process

```bash
# Create release zip
cd /home/jkourelis/Bioinformatics/InkPages
rm -f ../InkPages.zip
zip -r ../InkPages.zip manifest.json README.md PRIVACY.md LICENSE icons/ src/background/ src/content/ src/lib/ src/reader/

# Push to GitHub
git add -A
git commit -m "Description"
git push
```

## Important Code Locations

- **Sanitization**: `content.js` line ~219 (`sanitizeHTML` function)
- **Article Detection**: `content.js` line ~73 (`isArticlePage` function)
- **Pagination Setup**: `content.js` line ~1037 (`setupPagination` function)
- **Descender Buffer**: `content.js` line ~1070 (small buffer to prevent text touching progress bar)
- **Header Recalc Fix**: `content.js` line ~1119 (recalculates pagination when header visibility changes)
- **Cookie/Embed Filtering**: `content.js` line ~275 (`preprocessDOM` function)
- **Image Scaling Fix**: `reader.css` line ~387 (`#article-content img`)
