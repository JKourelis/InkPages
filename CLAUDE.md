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

Chrome requires Manifest V3. Key changes needed:

1. **Manifest Changes**:
   - `"manifest_version": 3`
   - `"action"` instead of `"browser_action"`
   - `"background": { "service_worker": "..." }` instead of `"scripts"`
   - Different `"web_accessible_resources"` format

2. **API Changes**:
   - `chrome.scripting.executeScript()` instead of `chrome.tabs.executeScript()`
   - Service worker lifecycle handling (no persistent background)
   - `chrome.action` instead of `chrome.browserAction`

3. **CSP Changes**:
   - Stricter CSP in MV3
   - No `eval()` or `new Function()` (we already removed this)

4. **Suggested Approach**:
   - Create separate `manifest.v3.json`
   - Minimal code changes needed (mostly API namespace)
   - Consider build script to generate both versions

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

**CSS locations** (`reader.css`):
- `.listing-item` line ~985: `break-inside: avoid`
- `.listing-main-link` line ~997: word-break properties
- `.listing-sub-links` line ~1015: reduced indentation
- `.listing-sub-links a` line ~1029: word-break properties

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

1. **Chrome Extension**: MV3 version (see above)
2. **Keyboard Shortcuts**: Customizable shortcuts via commands API
3. **Export Options**: Save article as PDF/EPUB
4. **Offline Reading**: Cache articles for offline access
5. **Better Mobile UI**: Optimize settings panel for touch
6. **Reading Statistics**: Track reading time, articles read
7. **Annotations**: Highlight and note-taking support

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
