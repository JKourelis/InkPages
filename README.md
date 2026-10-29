# InkPages

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Firefox Add-on](https://img.shields.io/badge/Firefox-Add--on-orange.svg)](https://addons.mozilla.org/en-US/firefox/addon/inkpages-reader/)

InkPages transforms web content into a clean, paginated reading experience - like a real book.

## Two Modes

- **Article mode** - extracts and paginates article content
- **TOC mode** - shows organized links on news homepages

## Features

- **True pagination** - tap, swipe, or use arrow keys to turn pages
- **No scrolling** - perfect for e-ink devices (Kindle Scribe, Boox, reMarkable)
- **Smart detection** - automatically chooses article or TOC mode
- **Multiple themes** - Light, Dark, Sepia, and high-contrast E-ink
- **Customizable typography** - font, size, line spacing, page width
- **E-ink optimizations** - bold text, justify, grayscale, hide images (captions stay as a short note, photo credits go)
- **Text first** - images are kept to a third of the page by default (Small / Medium / Large), so a lead photo no longer pushes the text to page 2
- **EPUB export (new, beta)** - save any article as an e-book for your e-reader, with images scaled down and in grayscale if you chose that ([details below](#send-articles-to-your-e-reader-epub-beta)). HTML export is still available
- **Markdown export** - the whole article as plain text with simple formatting (headings, lists, links, tables), to paste into your notes or edit elsewhere
- **Link controls** - show links normally, as plain text, or hide link-heavy blocks ("Read more", related-story promos)
- **Floating button** - optional draggable "Ink" button to open the reader in one tap (on by default on Android)
- **Auto-open per site** - InkPages asks once per site whether it should open automatically: articles, and the homepage and section pages as a list of links, are separate choices (change them any time in Settings)
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

1. Open any article or news homepage
2. Click the InkPages icon in the toolbar (on Android: tap the floating "Ink" button)
3. Tap or click the right or left side of the page, or swipe, to turn pages
4. Tap ⋮ at the top right (or press S) for settings: fonts, theme, images, links, export format and the Ink button
5. Tap the download arrow at the top right to save the article. On a phone this opens the share sheet (e.g. to send it to an e-reader app); on a computer it downloads. Choose HTML, EPUB or Markdown under Settings → Export Format
6. Tap ✕ at the top left (or press Esc) to close the reader

The first time you open InkPages on a site, it asks about what you opened it on:
- On an article: *Open articles on this site in InkPages automatically?*
- On the homepage or a section page: *Open the homepage and section pages of this site in InkPages automatically?* (shown as a list of links)

Answer **Yes** for news sites you read a lot, **No** for sites where you only want it now and then. Each question is asked once per site. You can change both answers under ⋮ → Behavior

### On a phone

- Drag the "Ink" button to move it; it stays where you leave it
- Change its size or switch it off under ⋮ → Floating Button

## Send Articles to Your E-reader (EPUB, beta)

InkPages can save the article you are reading as an EPUB e-book, so you can read it on a Kindle, Kobo, Boox, reMarkable or in an e-reader app.

1. Open the article in InkPages
2. Settings → **Export Format** → **EPUB** (remembered from then on)
3. Tap the export button (download icon) in the top bar. On mobile the share sheet opens; on desktop the file is downloaded
4. Send the file to your device, e.g. with [Send to Kindle](https://www.amazon.com/sendtokindle) or by copying it over

What goes into the e-book:
- Title, author, source link and the full article text
- Images, scaled down for e-ink and in grayscale when **Force grayscale** is on; the first image becomes the cover
- With **Hide images** on: no images, captions kept as a short "Image:" note, photo credits left out
- Images that can't be downloaded are left out, and InkPages tells you how many

**Status:** the files pass [epubcheck](https://www.w3.org/publishing/epubcheck/), the official EPUB validator, with no errors or warnings. They have **not yet been tested on e-reader devices or with Send to Kindle**. If an export doesn't open or looks wrong on your device, please [open an issue](https://github.com/JKourelis/InkPages/issues) with the device or app and the article link.

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
| Site memory | None | Auto-opens articles and homepages on sites you choose |
| Position memory | None | Saves reading position per article |
| E-ink support | Basic | Optimized (no animations, grayscale mode) |
| Export | None | HTML, EPUB e-book or Markdown |

## Changelog

### v1.5.0
- Export as Markdown (.md): choose Markdown under Settings → Export Format. You get the whole article as one plain-text file with headings, lists, links and tables, ready to paste into your notes or edit (issue #6)
- Code examples on sites built from web components now show up in the reader and in exports; before they were silently left out
- Those sites' interactive widgets (live demos, lazily loaded tables) no longer appear as empty boxes in the reader
- On a phone, pages that fold their sections shut (as encyclopedia-style sites do in their mobile layout) now open in full instead of showing only the introduction
- A site logo placed inside the article no longer shows up as a large image at the top

### v1.4.0
- The homepage and section pages can open automatically again, as a list of links, but now as a separate choice per site. InkPages asks when you open it on a homepage; opening it on an article asks about articles only
- Sites saved by older versions (which saved every site you opened InkPages on) still open automatically, but InkPages asks once whether to keep that
- Settings → Behavior has two switches per site (articles; homepage and sections) instead of the global "Show TOC on homepages" switch. Opening InkPages yourself on a page that isn't an article always shows the list of links

### v1.3.0
- Opening InkPages on a site no longer turns on auto-open by itself. The first time, it asks whether that site's articles should open automatically (issue #3)
- Auto-open only opens articles. The list of links (TOC) now appears only when you open InkPages yourself, so a site's home page no longer opens in InkPages by itself
- Settings button is now the familiar ⋮ menu icon instead of a sun (issue #4)

### v1.2.2
- Sign-in and newsletter boxes placed between paragraphs are no longer shown as part of the article

### v1.2.1
- Fixed: on some paywalled sites the reader showed the subscription offer instead of the article. Forms (subscription, login, newsletter) are now removed before extraction
- Screen-reader-only labels ("Label: Analyse", "Gepubliceerd op") no longer show up in the article

### v1.2.0
- Export as EPUB: choose HTML or EPUB under Settings → Export Format; the export button uses that format. EPUB includes the images, scaled down (max 1600 px wide) and grayscale when "Force grayscale" is on
- Exports follow "Hide images": no images, captions kept as an "Image:" note, photo credits dropped
- Smaller images: by default at most a third of the page tall (Image size: Small / Medium / Large), so text comes first and a lead photo no longer leaves page 1 empty
- "Hide images" keeps informative captions as a short note and drops photo credits ("Photo: …") and credit-only figures
- Images load straight away and the pages are recounted when they arrive, so text no longer shifts while reading
- Fixed: tapping a Links button reset the font choice

### v1.1.4
- Auto-open now works on sites that switch articles without reloading the page. Before, with the TOC off, every article opened from the site's own links needed a tap on the InkPages icon
- Going back after such a switch closes the previous article's reader instead of leaving it on top
- Turning "Auto-open on this site" off now sticks; opening the reader by hand no longer switches it back on

### v1.1.3
- Closing the reader no longer turns off auto-open for the site. Use the new "Auto-open on this site" switch in Settings instead
- Articles whose text loads late (paywall checks, JavaScript-built pages) are retried before giving up on auto-open

### v1.1.2
- Closing the TOC view on a homepage no longer turns off auto-reading for the whole site; only closing an article does

### v1.1.1
- Short articles (reviews, news briefs) now open as articles instead of the TOC view, when the page marks itself as an article (og:type, article:published_time or JSON-LD)
- Fix duplicate ids when a site's article uses the same id as the reader

### v1.1.0
- Optional floating "Ink" button to open the reader, draggable and resizable (contributed by @AwesomeLemon, PR #1). On by default on Android, where the toolbar button is buried in the menu
- New "Links" setting: Normal / Plain text / Hide link blocks (issue #2)
- Fix reading position not being restored when reopening an article
- Changing font size, width or other settings keeps your place instead of jumping to page 1
- Stricter HTML sanitisation (all inline event handlers, URL scheme allowlist)
- Faster activation: the article is parsed once instead of twice
- Exported HTML keeps the article's language and text direction
- Removed temporary pagination debug panel and unused legacy code

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
- **More Export Formats** - PDF export (HTML, EPUB and Markdown available now)
- **Offline Reading** - Cache articles for offline access
- **Annotations** - Highlight and note-taking support
- **Reading Statistics** - Track reading time and articles read

## Support

If you find InkPages useful, consider [buying me a coffee](https://ko-fi.com/jkourelis)!

## Credits

- Article extraction: [Mozilla Readability](https://github.com/mozilla/readability) (Apache 2.0 License)

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
