# InkPages - Development Context for Claude

## Project Overview

InkPages is a Firefox extension that provides Safari-like reader mode with paginated, book-style display optimized for e-ink devices (Kindle Scribe, Boox, reMarkable, etc.).

**Repository**: https://github.com/JKourelis/InkPages
**AMO Listing**: https://addons.mozilla.org/firefox/addon/inkpages-reader/ (live; add-on ID `{77d4cdb4-ab52-4e89-ba4b-db8a517a085f}`)
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
3. **Site Memory (per site, two choices; v1.4.0)**: articles and link pages (homepage, sections, shown as TOC) are separate per-origin choices, each stored as enabled / disabled / legacy (`AUTO_OPEN_KEYS` in content.js: `readerEnabledOrigins`/`readerDisabledOrigins`/`readerLegacyOrigins` and `tocEnabledOrigins`/`tocDisabledOrigins`/`tocLegacyOrigins`). Opening the reader never saves a choice by itself: `askAutoOpenOnce(kind)` asks about what is on screen (article view asks "Open articles on <site> in InkPages automatically?", TOC asks "Open the homepage and section pages of <site> ...?") unless that kind is already enabled/disabled for the origin. Yes/No = `setAutoOpen(kind, bool)`, also used by the two Settings → Behavior switches. Unanswered changes nothing and is asked again next time; opening Settings hides it. Legacy sites still auto-open but the question reads "Keep opening ...?" until answered. History: before v1.3.0 one manual open silently enabled the whole site, and with the global "Show TOC on homepages" switch (default on) its non-article pages auto-opened as TOC too (a Reddit user got every post and the home screen in InkPages, issue #3). v1.3.0 asked about articles only and stopped all automatic TOC; that made the global TOC switch nearly meaningless (it only chose TOC vs article for manual opens on non-article pages), so v1.4.0 replaced it with the per-site TOC choice. Migration (`migrateAutoOpen()` in background.js, once, flag `autoOpenMigrated`): every origin in `readerEnabledOrigins` becomes legacy for articles, and also enabled+legacy for TOC unless the old global `listingModeEnabled` was false. Origins answered "No" (`readerDisabledOrigins`, since v1.1.4) stay off. Since v1.1.3 closing the reader never forgets the origin (it only hides the reader for that page)
4. **Auto-Activation**: On an origin with articles enabled, detected article pages open as articles; with link pages enabled, non-article pages open as TOC, except pages that declare themselves articles (`isDeclaredArticle()`: their text may not have rendered yet). Manual open on a non-article page always shows the TOC; if no list of links is found it falls back to article mode. Declared articles that fail detection at 500ms are re-checked after +1s and +2s (late-rendered text) before giving up (v1.1.3)
5. **Client-Side Navigation (v1.1.4)**: Single-page sites (volkskrant.nl is Next.js) change the URL with `history.pushState`, so the content script never re-runs. `watchForNavigation()` checks `location.href` every 500ms and on `popstate`, and re-runs `checkAutoActivation({previousFingerprint})`. `waitForNewPage()` first waits (up to ~4.5s) until the page fingerprint (`h1` in article/main, canonical href, og:url, first paragraph over 100 chars; not the title, which some routers change before the content) differs from the previous page and is stable for one 250ms sample, so neither the previous article nor a page shown only briefly is detected. The fingerprint is recorded at load, when the reader opens and when a check settles (not every tick: a tick between a content swap and the URL change would record the new page). If the fingerprint never changes: back/forward still proceeds, other URL changes are the site rewriting its own URL and are ignored (otherwise a reader the user closed reopens). An open reader closes on back/forward. A run counter cancels checks for pages already left. Known gap: a router that briefly renders a superseded page for longer than one sample (~250ms) at the new URL can get that page detected; Next.js-style routers cancel superseded navigations, so this was only seen with a synthetic router
   - Why: with TOC on, users navigated via TOC links, which sit in the reader's shadow DOM and cause full loads, and failed detections still showed the TOC. With TOC off they tap the site's own links, so auto-open silently never ran. Tests with only full-load pages missed this (v1.1.2/v1.1.3 fixed real but different bugs)
6. **Reading Position Memory**: Saves position per URL (last 50 articles)
7. **Link Handling**: Same-origin links navigate normally, external links open in new tab
8. **HTML Sanitization**: Strips event handlers, javascript: URLs, scripts, forms, iframes, and unwraps the page's web components (v1.5.0)
9. **Cookie/Embed Filtering**: Removes social media embed placeholders and cookie consent blocks
10. **Link Modes**: Links shown normally, as plain text, or link-heavy blocks hidden
11. **Floating Button**: Optional draggable button to open the reader (default on Android)

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
- **Declared articles (v1.1.1)**: if `isDeclaredArticle()` finds `og:type=article`, `article:published_time`, or a top-level JSON-LD `*Article`/`BlogPosting`/`Review` type, thresholds drop to >500 chars, >=2 substantial paragraphs, >80 words, and the listing-structure check is skipped. Only top-level JSON-LD counts: section pages embed `ItemList`s of `NewsArticle`s
- Why: short reviews (e.g. Volkskrant album reviews, ~180 words) fell through to TOC mode, so all article text "disappeared"
- Known gap: undeclared section pages with many long teaser paragraphs can still be misread as articles (pre-existing)

### Pre-extraction Cleanup (preprocessDOM)
- Removes social embed placeholders, cookie/consent blocks, screen-reader-only text (`.sr-only`, `.visually-hidden`, `.visuallyhidden`, `.screen-reader-text`) and forms
- Forms (v1.2.1): volkskrant.nl paywall pages carry a purchase form (plans, prices, conditions, ~5k chars) twice; Readability scored it above the article and the reader showed only the subscription offer. Forms holding less than half the page text are removed; a form wrapping most of the page (ASP.NET WebForms) is kept
- Sign-in gates (v1.2.2, `removeSignInGates`): the Guardian inserts a "This is not a paywall" sign-in box (`#sign-in-gate`, no form) between paragraphs, and it ended up in the text. Detected generically: a link whose href points to sign-in/register/subscribe/account AND whose own text is a call to action ("Sign in", "Create an account", "Sign up", Dutch/German/French variants). The outermost block around it (div/aside/section, at most 1500 chars) is removed if it is a box (heading, button or 2+ links) and sits among the article's paragraphs (parent has 2+ other `<p>` of 100+ chars). Links inside paragraphs and one-link sentences in a div are kept; the article body itself never qualifies (too long, or no paragraph siblings). Known gap: sites that wrap every paragraph in its own div give the gate no `<p>` siblings, so it is not caught
- On a paywalled Volkskrant page (not logged in) the intro paragraph exists only as a truncated teaser inside the paywall module, so the reader starts at the first body paragraph
- Collapsed sections (v1.5.0): Wikipedia's mobile layout (phone-width windows, also with a desktop UA) folds every section with `hidden="until-found"`, and Readability skips hidden elements, so on a phone the reader showed only the introduction (Markdown article: 1,238 chars instead of 19,633). preprocessDOM removes `hidden` where it is `until-found` (content find-in-page can open); other `hidden` stays hidden
- Logo links (v1.5.0): a link to a home page (path `/`, no query) holding only img/svg/picture and no text is removed. volkskrant.nl "kijkverder" longreads have the site logo in a `<nav>` inside `<article>`; Readability kept it (no link text, so no link density) and the reader opened with a full-width logo
- Volkskrant "kijkverder" longreads (Nuxt, `/kijkverder/...`) when not logged in render the intro and first paragraph, then the paywall; the whole article is in `window.__NUXT__` (`content_blocks`). InkPages reads only what the page shows and must not take hidden text from that state (paywall). Their lead photo sits in a `header`-class block (Readability drops it) as a lazy `data-src` image, so the reader has no lead photo there

### Web Components (v1.5.0)
- Shadow-DOM code (`copyShadowCodeBlocks()`, called in `extractArticle()` before `preprocessDOM`): developer.mozilla.org renders every code example inside `<mdn-code-example>` with the `<pre>` only in its shadow root (light DOM empty, 0 `<pre>` in the page). `document.cloneNode()` copies no shadow roots, so Readability never saw the code and the reader showed headings with nothing under them. Elements of the page and the clone are paired by index (`querySelectorAll('*')`, same length and tag checked); a host whose shadow root (also nested ones; `openOrClosedShadowRoot` sees closed roots in Firefox) holds `<pre>` and whose light DOM has none is replaced in the clone by those `<pre>` plus its own children. Only `<pre>`: the rest of a shadow root is mostly controls (copy/run buttons, menus). Other shadow-only content is still not extracted
- Unwrapping in `sanitizeHTML()`: the reader lives in the page, so custom elements left in the article (MDN's `<interactive-example>`, `<mdn-compat-table-lazy>`) were upgraded by the page's own registry and rendered inside the reader as empty widgets (a 378px "JavaScript Demo / Reset / Output" box on page 1), with page code running inside the closed reader root. HTML-namespace elements with a hyphen are replaced by their children; elements with `is` become plain copies (serialization re-adds an element's `is` value even after `removeAttribute('is')`)

### Settings Storage
- `storage.sync`: User preferences (font, theme, etc.) - syncs across devices
- `storage.local`: per-site auto-open lists (see Key Features 3; `autoOpenMigrated` flag), floating button position, reading positions
- `readerSettings.listingModeEnabled` (old global TOC switch) is no longer used; it may still sit in users' synced settings and is read once by the migration

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
- Our code has `sanitizeHTML()` (content.js ~line 1130) that strips dangerous content
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
- **Implementation**: `content.js` line ~1618 - header gets `.minimized` class (display: none)
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
- `content.js`: `exportArticle()`, `generateExportHTML()`, `prepareExportDocument()`
- `reader.html`: Export button in header-right

### EPUB Export (v1.2.0)

Settings → Export Format (`settings.exportFormat`: `'html'` | `'epub'`, default html) picks what the export button produces; its title says which.
- `src/content/epub.js` (content script loaded before content.js, global `InkPagesEpub.build()`): EPUB 3 with an EPUB 2 NCX, first image as cover. No library: a stored (uncompressed) zip writer with CRC32, ~70 lines; EPUB needs the mimetype entry stored anyway and JPEGs don't compress
- Images are fetched by the content script (Firefox MV2 content scripts with `<all_urls>` fetch cross-origin without CORS), decoded with `createImageBitmap`, scaled to max 1600x2400, drawn on white (JPEG has no alpha), grayscale via `ctx.filter` when "Force grayscale" is on, re-encoded JPEG q0.82. Failed images are dropped and counted in a notice; images under 40px (icons, tracking pixels) are dropped silently. srcset: smallest candidate >= 1200w, else largest
- `cleanForXhtml()` makes the article valid XHTML: element whitelist (unknown elements unwrapped, media/forms/svg dropped), attribute whitelist, phrasing elements holding blocks unwrapped, unique ids, `#fragment` links only to existing ids, relative links made absolute, comments and XML-invalid characters removed. Serialized with `XMLSerializer` inside one wrapper div
- `crypto.randomUUID()` only exists on https pages, so the identifier comes from `getRandomValues`
- Exports follow the image settings: `prepareExportDocument()` builds an inert copy of the article; with "Hide images" it drops images, credits and bare figures and prefixes captions with a real `<b>Image: </b>` (no CSS `::before` in exports). HTML export gets grayscale/max-height CSS; its images stay external URLs
- Share sheet after a multi-second EPUB build may have lost user activation; the code falls back to a download. Object URLs are revoked after 10s (straight away could cancel a large download)
- Verified with epubcheck 5.1.0 (0 errors/warnings) on mock articles (cross-origin images, srcset, webp, transparent PNG, 404, 1px, custom elements, control chars), Wikipedia and The Guardian. Not yet verified on real volkskrant.nl markup or on Send to Kindle / Boox / KOReader

### Markdown Export (v1.5.0, issue #6)

Third Export Format option (`settings.exportFormat: 'markdown'`, file `.md`, type `text/markdown`). Asked for by a desktop user who copied the article text into a text editor; that doesn't work across paginated columns.
- `src/content/markdown.js` (content script before content.js, global `InkPagesMarkdown.build()`), no library: converts `prepareExportDocument().body`, so it follows "Hide images" like the other exports (images become `![alt](url)` links; hidden images leave `**Image:** caption`)
- Output: `# title`, byline · site, `Source: <url>`, then the article. GitHub-style tables (first row as header; one-column tables or tables holding lists/quotes/code/tables are layout tables and give their content as blocks), fenced code blocks (fence longer than any backtick run inside), tight nested lists (a nested list follows the item text without a blank line only when it starts with "- " or "1. "), `**`/`*`/`~~`, `<br>` as a hard line break, two `<br>` as a new paragraph
- Escaping: backslash, backtick and `*` always; `_` unless inside a word; `<` before a tag-like letter; `&` before an entity; line starts that would make a heading, quote, list or rule. Brackets are escaped only in link/image text or as `](`/`]:`, so citations like [18] stay readable
- Links: absolute (relative ones resolved against the page), parentheses and spaces percent-encoded; `#fragment` links become plain text; a link whose text is its URL becomes `<url>`. `data:` image URLs are skipped (lazy-load placeholders); the next of `src`, `data-src`, srcset is used
- Readability strips class names, so code block languages are not known
- Verified: rendered back with markdown-it-py, the text equals the reader text character for character (whitespace ignored) on a mock article and on two Wikipedia articles and an MDN page

### Image Sizing and Captions (v1.2.0)

- Text first: images are capped at a share of the page height: `--page-height` (set in `setupPagination()` from the viewport) x `--image-fraction` (Small 0.33 default, Medium 0.5, Large 0.7; `settings.imageSize`, host classes `.images-medium` / `.images-large`). Before, images could be 70vh and figures 80vh, so a lead photo didn't fit under the title and page 1 stayed empty
- The figure `max-height: 80vh` was removed: with `overflow: visible` it only made the box shorter than its content
- Images load eagerly (lazy images in later columns loaded only when reached and shifted the text while reading) and a debounced `repaginate()` runs after loads. With "Hide images" on they stay lazy (not fetched); `applySettings()` switches them to eager when shown again
- `markCaptions()` tags `figcaption`/`.caption`: `.inkpages-caption` (informative; shown as an "Image:" note when images are hidden), `.inkpages-credit` (whole-caption credit, a trailing credit element, or trailing credit text split into a span), `.inkpages-bare-figure` (image figure without a real caption). Figures without images (tables, quotes) are left alone
- Credit detection: a credit word (Foto, Beeld, Photo, Image, Credit, Illustratie, Bron, ...) followed by a name (capital/digit/©), ©, or an agency name alone (ANP, Reuters, Getty Images, "AFP via Getty Images"), max 60 chars. Trailing credits need a separator before them (full stop, | / – —, bracket). Requiring the capital keeps "Images of the protest" and "a photo of her mother" as captions
- Bug fixed: `.link-btn` (and now the image size/export buttons) share the `.font-btn` style, and the font handler bound to every `.font-btn`, so tapping a Links button set `fontFamily` to undefined. `fontBtns` is now `.font-btn[data-font]`

### Reading Position Restore (v1.1.0)

**Root Cause**: Before v1.1.0 the saved position was never actually restored. `applySettings()` (run once settings load) reset `currentPage = 0` on a 50ms timer, which fired after the restore and also saved page 0 over the stored position. Every settings change also jumped back to page 1.

**Fix**:
- `paginateNewContent()` paginates freshly rendered content and restores the saved position; saving is blocked (`positionRestored` flag) until the restore has happened
- `repaginate()` re-runs pagination after settings changes and resizes at the same *fraction* of the article
- Positions are stored as `{page, totalPages}` and restored proportionally, so they survive font/width changes
- Key is `pos_` + URL without `#fragment` and `utm_*` params (the old key truncated to 100 chars, so long URLs collided)

Verified in headless Firefox: before the fix, page 4/25 came back as 1/25 after a reload.

### Link Modes (v1.1.0, issue #2)

Setting `linkMode`: `'normal'` | `'plain'` | `'hide'`, applied as `.links-plain` / `.links-hide` classes on the shadow host.
- **Plain**: links styled as text and made inert (`pointer-events: none`)
- **Hide**: plain links, plus blocks tagged by `markLinkBlocks()` are hidden. A block (p, li, ul, div, aside, ...) is tagged when link text is >= 60% of its text; a short heading directly above a tagged block goes with it. A block holding more than half the article's text is never tagged
- Hiding whole links inside sentences was rejected: it deletes words mid-sentence
- CSS excludes `.listing-content` so TOC/listing mode (all links) is unaffected

### Floating Button (v1.1.0, PR #1 by AwesomeLemon)

Optional draggable "Ink" button that toggles the reader. On by default when the UA contains "Android" (Firefox Android hides the toolbar button in the menu), off elsewhere.
- Lives in a `<inkpages-button>` custom element with its own closed shadow root, so page CSS can't restyle it
- Tap is handled on `pointerup` (to tell taps from drags); keyboard activation comes through `click` with `detail === 0`
- Position saved in `storage.local` (`floatingButtonPosition`); enabled/size are in `readerSettings` and synced to open tabs via `storage.onChanged`

### Debug Options (removed in v1.1.0)

The temporary pagination debug panel from v1.0.9 was removed after the pagination fix was confirmed. Its default code paths (floor viewport width, use `scrollWidth`) are what `setupPagination()` now always does.

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
- `.listing-item` line ~1005: `break-inside: avoid`
- `.listing-main-link` line ~1017: word-break properties
- `.listing-sub-links` line ~1035: reduced indentation
- `.listing-sub-links a` line ~1050: word-break properties

## Known Limitations

1. JavaScript-rendered pages may not extract properly (Readability needs DOM content)
2. Paywalled content cannot be extracted
3. Complex layouts may have extraction artifacts
4. Firefox Android: the toolbar button is in the menu; the floating "Ink" button (on by default on Android) gives one-tap access

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
    │   └── background.js   # Toolbar click handling
    ├── content/
    │   ├── epub.js         # EPUB export (zip writer, XHTML cleanup, image packing)
    │   ├── markdown.js     # Markdown export (HTML to Markdown converter)
    │   └── content.js      # Main logic: extraction, rendering, pagination
    ├── lib/
    │   └── Readability.js  # Mozilla Readability (Apache 2.0)
    └── reader/
        ├── reader.html     # Reader UI template
        └── reader.css      # Styles with theme support
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

1. Bump `version` in `manifest.json`; add a README changelog entry
   - README (and changelog) never name specific websites ("some paywalled sites", not the site); site names belong only in CLAUDE.md and commit messages
2. Lint: `npx --yes web-ext@8 lint --source-dir . --ignore-files '*.zip'` (expect 0 errors; 5 innerHTML/Readability warnings are known). Delete the web-ext entry from `~/.npm/_npx` afterwards
3. Build the versioned zip in the project folder (zips are gitignored) and copy it to OneDrive:
```bash
cd /mnt/fastdata/Bioinformatics/InkPages
zip -qr InkPages_vX.Y.Z.zip manifest.json README.md PRIVACY.md LICENSE icons/ src/background/ src/content/ src/lib/ src/reader/
cp InkPages_vX.Y.Z.zip ~/OneDrive/
```
4. Commit, and push only when the user says so. The user uploads the zip to AMO themselves
   - AMO "Do you need to submit source code?": **No** (no build step; Readability.js is unminified)
   - Release notes: 1-2 lines
5. Open the project via `/mnt/fastdata/Bioinformatics/InkPages`, not the `~/Bioinformatics` symlink: VS Code's file watcher misses new files through the symlink

### Testing
- Headless Firefox via selenium: binary `/snap/firefox/current/usr/lib/firefox/firefox` (`/usr/bin/firefox` is a snap wrapper), geckodriver from the snap, `driver.install_addon(path, temporary=True)`, test pages from a local `python -m http.server`
- Use a test copy with shadow roots `'open'` so WebDriver can see inside; WebDriver can't open `moz-extension://` pages
- An Android UA (`general.useragent.override`) shows the floating button, the easiest way to toggle the reader
- Test sites must include client-side (pushState) navigation, not just full page loads: v1.1.2-v1.1.3 passed full-load tests but sticky mode was still broken on volkskrant.nl
- Don't visit real sites that need a consent click to be automated; ask the user to save the page instead
- Testing the auto-open migration: in the test copy, prepend a `seedForTest()` to background.js that writes old-version storage (`readerEnabledOrigins`, `readerSettings.listingModeEnabled`) and replace the call with `seedForTest().then(migrateAutoOpen)`
- Clean up afterwards: kill http.server/geckodriver/firefox, delete scratch files, `/tmp/rust_mozprofile*` and `~/.cache/selenium`

## Important Code Locations

- **Floating Button**: `content.js` line ~234 (`ensureFloatingButton` function)
- **Auto-open choices**: `content.js` `AUTO_OPEN_KEYS`, `getAutoOpenState()`, `setAutoOpen()` (before `toggleReaderMode`), `askAutoOpenOnce(kind)` / `hideAutoOpenPrompt()` (after `activateReaderMode`); question markup `#auto-open-prompt` in `reader.html`, styles in `reader.css` ("Auto-open Question"); Settings switches `#toggle-site-auto` / `#toggle-site-toc` (site name in `.setting-site`, not `.site-name`, which is the top bar label); one-time migration `migrateAutoOpen()` in `background.js`
- **Settings button**: `reader.html` `#btn-settings`, a vertical three-dot (⋮) icon since v1.3.0 (issue #4: the old sun-like icon read as a brightness/theme control)
- **Auto-Activation / SPA navigation watcher**: `content.js` line ~365 (`checkAutoActivation`), ~501 (`watchForNavigation`)
- **Article Detection**: `content.js` line ~511 (`isArticlePage` function; caches the parse in `detectedArticle`)
- **Sanitization**: `content.js` line ~1130 (`sanitizeHTML` function, URL scheme allowlist)
- **Cookie/Embed Filtering**: `content.js` line ~1188 (`preprocessDOM` function)
- **Repaginate keeping position**: `content.js` line ~1527 (`repaginate` function)
- **Pagination Setup**: `content.js` line ~1633 (`setupPagination` function; sets `--page-height` for image sizing)
- **Descender Buffer**: `content.js` line ~1672 (small buffer to prevent text touching progress bar)
- **Header Minimize**: `content.js` line ~1618 (header hidden on pages 2+)
- **Reading Position Restore**: `content.js` line ~1792 (`paginateNewContent` function)
- **Export (HTML/EPUB/Markdown)**: `content.js` line ~2118 (`exportArticle`), ~2195 (`prepareExportDocument`); EPUB packaging in `epub.js`, Markdown conversion in `markdown.js`
- **Link Block Detection**: `content.js` line ~2512 (`markLinkBlocks` function)
- **Caption/Credit Tagging**: `content.js` line ~2571 (`markCaptions` function)
- **Link Mode CSS**: `reader.css` line ~171
- **Hide Images CSS**: `reader.css` line ~128
- **Image Sizing**: `reader.css` line ~485 (`#article-content img`, `--image-fraction`)
