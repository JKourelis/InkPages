# InkPages

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Safari-like reader mode for Firefox with paginated, book-style display. Optimized for e-ink devices. No scrolling - tap or swipe to turn pages like a real book.

## Features

- **Safari-like article extraction** using [Mozilla Readability](https://github.com/mozilla/readability)
- **True pagination** with no scrolling - tap/click or swipe to turn pages like a book
- **E-ink optimizations** - no animations, high contrast themes, minimal repaints
- **Customizable typography** - font family, size, line height, page width
- **Multiple themes** - Light, Sepia, Dark, and E-ink high-contrast
- **Cross-browser support** - Firefox and Chromium-based browsers

## How It Differs from Firefox Reader View

| Feature | Firefox Reader View | InkPages |
|---------|---------------------|-------------------|
| Layout | Vertical scroll | Paginated pages |
| Navigation | Scrollbar | Tap zones + keyboard + swipe |
| E-ink support | Basic | Optimized (no animations, grayscale mode) |
| Typography | Firefox defaults | Safari-inspired (Georgia serif, generous spacing) |
| Settings sync | Local only | Cross-device via storage.sync |

## Installation

### Firefox (Temporary Add-on)

1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" in the left sidebar
3. Click "Load Temporary Add-on..."
4. Navigate to the extension folder and select `manifest.json`
5. The extension icon will appear in the toolbar

### Chrome/Chromium (Unpacked Extension)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the extension folder
5. The extension icon will appear in the toolbar

## Usage

1. Navigate to any article or webpage
2. Click the extension icon in the toolbar
3. The article will be extracted and displayed in paginated reader view

### Navigation

- **Tap/click right side** - Next page
- **Tap/click left side** - Previous page
- **Swipe left** - Next page
- **Swipe right** - Previous page
- **Right arrow / Space** - Next page
- **Left arrow / Shift+Space** - Previous page
- **Home** - First page
- **End** - Last page
- **Escape** - Close reader
- **S** - Open settings

### Settings

Click the gear icon to access settings:

- **Font** - Serif (Georgia), Sans-serif (System), Monospace
- **Font Size** - 14px to 32px
- **Line Spacing** - 1.4 to 2.2
- **Page Width** - 400px to 900px (useful for narrow e-ink devices)
- **Theme** - Light, Sepia, Dark, E-ink (high contrast)
- **E-ink Options**:
  - Bold text - Increases font weight for better e-ink visibility
  - Justify text - Full justification with hyphenation
  - Force grayscale - Applies CSS grayscale filter
  - Hide images - Removes all images for faster rendering

## Architecture

```
InkPages/
├── manifest.json          # Extension manifest (MV2)
├── icons/                 # Extension icons
├── src/
│   ├── background/
│   │   └── background.js  # Background script - handles toolbar clicks
│   ├── content/
│   │   └── content.js     # Content script - article extraction
│   ├── reader/
│   │   ├── reader.html    # Reader UI markup
│   │   ├── reader.css     # Styles with Safari-like typography
│   │   └── reader.js      # Pagination engine and settings
│   └── lib/
│       └── Readability.js # Mozilla Readability library
```

### Key Components

**Content Script (`content.js`)**
- Injects into the active tab when toolbar button is clicked
- Clones the DOM and runs Readability to extract article content
- Sends extracted data to background script

**Background Script (`background.js`)**
- Responds to toolbar button clicks
- Stores extracted article in extension storage
- Opens reader view in new tab

**Reader UI (`reader.js`)**
- Fetches article data from storage
- Renders content using CSS multi-column pagination
- Handles navigation via tap zones, keyboard, and swipe gestures
- Manages settings with storage.sync

### Pagination Implementation

Pagination works by:

1. Measuring the natural scroll height of the article content
2. Calculating how many pages are needed: `ceil(contentHeight / viewportHeight)`
3. Setting up CSS multi-column layout with the exact width needed
4. Using `translateX` to navigate between column "pages"

```javascript
// Calculate pages from content height
const naturalHeight = content.scrollHeight;
const pagesNeeded = Math.ceil(naturalHeight / viewportHeight);

// Set up columns
content.style.height = viewportHeight + 'px';
content.style.columnWidth = viewportWidth + 'px';
content.style.width = (pagesNeeded * viewportWidth) + 'px';
```

This approach avoids scroll events and minimizes repaints, which is ideal for e-ink displays.

### Typography Defaults (Safari-inspired)

- **Font**: Georgia serif (vs Firefox's system sans-serif)
- **Line height**: 1.8 (vs Firefox's ~1.5)
- **Letter spacing**: Slightly tightened on headings
- **Max width**: 680px (comfortable reading width)

## Testing

Test the extension on these types of pages:

### News Articles
- NYTimes, Guardian, BBC - should extract main article body, byline, title

### Blog Posts
- Medium, Dev.to, personal blogs - should handle various layouts

### Documentation
- MDN, GitHub docs - should work with technical content

### Edge Cases
- Pages without articles (e.g., homepages) - should show error message
- Very long articles - pagination should handle smoothly
- Pages with lots of images - "Hide images" option should work

## Known Limitations

1. Some heavily JavaScript-rendered pages may not extract properly (Readability needs DOM content)
2. Paywalled content cannot be extracted
3. Some complex layouts (multi-column, sidebars) may have extraction artifacts

## Credits

- Article extraction: [Mozilla Readability](https://github.com/mozilla/readability) (Apache 2.0 License)
- Inspired by Safari Reader and the [Eink Mode extension](https://addons.mozilla.org/en-GB/firefox/addon/eink-mode/) (behavior reference only, no code copied)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

Mozilla Readability is also licensed under Apache 2.0.
