# InkPages

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Firefox Add-on](https://img.shields.io/badge/Firefox-Add--on-orange.svg)](https://addons.mozilla.org/en-US/firefox/addon/inkpages-reader/)

InkPages transforms web content into a clean, paginated reading experience - like a real book.

## Two Modes

- **Article mode** - extracts and paginates article content
- **TOC mode** - shows organized links on news homepages (Guardian, BBC, etc.)

## Features

- **True pagination** - tap, swipe, or use arrow keys to turn pages
- **No scrolling** - perfect for e-ink devices (Kindle Scribe, Boox, reMarkable)
- **Smart detection** - automatically chooses article or TOC mode
- **Multiple themes** - Light, Dark, Sepia, and high-contrast E-ink
- **Customizable typography** - font, size, line spacing, page width
- **E-ink optimizations** - bold text, justify, grayscale, hide images
- **Site memory** - auto-activates on sites you've used it on
- **Reading position memory** - resume where you left off

## Installation

### Firefox

Install from [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/inkpages-reader/)

### Firefox (Debug Mode)

For development or testing the latest changes:

1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox" in the left sidebar
4. Click "Load Temporary Add-on..."
5. Navigate to the extension folder and select `manifest.json`
6. The extension icon will appear in the toolbar

Note: Temporary add-ons are removed when Firefox closes.

## How to Use

1. Navigate to any article or news homepage
2. Click the InkPages icon
3. Tap sides or swipe to turn pages
4. Press 'S' for settings, 'Esc' to exit

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow keys / Space | Navigate pages |
| Home/End | First/last page |
| S | Settings |
| Escape | Close reader |

## How It Differs from Firefox Reader View

| Feature | Firefox Reader View | InkPages |
|---------|---------------------|----------|
| Layout | Vertical scroll | Paginated pages |
| Navigation | Scrollbar | Tap zones + keyboard + swipe |
| Non-article pages | Error message | TOC/listing mode with structured links |
| Site memory | None | Remembers sites, auto-activates |
| Position memory | None | Saves reading position per article |
| E-ink support | Basic | Optimized (no animations, grayscale mode) |

## Changelog

### v1.0.9
- Fix sub-pixel pagination drift on narrow e-reader screens (always round viewport dimensions)
- Add HTML export feature - share articles to e-reader apps on mobile or download on desktop

### v1.0.7
- Fix CSS specificity conflict between article and TOC/listing mode once and for all
- All listing selectors now use `#article-content` prefix for higher specificity (110-111 vs 101)
- Fixes progressive page drift and content cut-off on narrow screens

### v1.0.6
- Attempted fix for TOC mode pagination using `:not()` selectors (incomplete fix, superseded by v1.0.7)

### v1.0.5
- Fix TOC mode layout on narrow/phone-sized e-reader screens
- Prevent text from being cut off on right edge (added word-break handling)
- Reduce sub-link indentation for better use of limited screen width
- Keep listing items on one page where possible (prevent titles spanning across pages)

### v1.0.4
- Fix content continuity bug where text could disappear when navigating from page 1 to page 2
- Article header now uses absolute positioning with dynamic spacer for consistent pagination

### v1.0.3
- Fix pagination bug where pages 2+ only used half the screen height (recalculate layout when article header hides)

### v1.0.2
- Fix header title truncation
- Update README

### v1.0.1
- Add Ko-fi support link

### v1.0.0
- Initial release with article mode and TOC/listing mode

## Known Limitations

1. JavaScript-rendered pages may not extract properly (Readability needs DOM content)
2. Paywalled content cannot be extracted
3. Complex layouts may have extraction artifacts

## Future Improvements

- **Chrome Extension** - Manifest V3 version for Chrome/Edge
- **Customizable Shortcuts** - User-configurable keyboard shortcuts
- **More Export Formats** - EPUB/PDF export (HTML export available now)
- **Offline Reading** - Cache articles for offline access
- **Annotations** - Highlight and note-taking support
- **Reading Statistics** - Track reading time and articles read

## Support

If you find InkPages useful, consider [buying me a coffee](https://ko-fi.com/jkourelis)!

## Credits

- Article extraction: [Mozilla Readability](https://github.com/mozilla/readability) (Apache 2.0 License)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
