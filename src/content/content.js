/**
 * Content Script - Article Extraction & In-Page Reader
 *
 * This script:
 * 1. Extracts article content using Mozilla Readability
 * 2. Creates an in-page reader overlay using Shadow DOM
 * 3. Handles toggle between reader mode and original page
 * 4. Auto-activates reader on article pages for sites where reader was previously enabled
 *    (Safari-like behavior: remembers sites, but only activates on actual articles)
 */

(function() {
  'use strict';

  // Guard against re-injection
  if (window.__einkReaderInjected) {
    return;
  }
  window.__einkReaderInjected = true;

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // State
  let isReaderActive = false;
  let isListingMode = false;
  let readerOverlay = null;
  let shadowRoot = null;
  let originalTitle = document.title;
  let articleData = null;
  let listingData = null;

  // Listen for messages from background script
  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_READER') {
      // toggleReaderMode is async - wait for it to complete
      toggleReaderMode().then(() => {
        sendResponse({ success: true, isActive: isReaderActive });
      }).catch(err => {
        console.error('Toggle reader error:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open for async response
    }
    if (message.type === 'CHECK_READER_STATE') {
      sendResponse({ isActive: isReaderActive });
      return true;
    }
  });

  // Check if we should auto-activate reader mode
  // Activates if this origin has reader mode enabled:
  // - Article pages: show reader mode
  // - Non-article pages: show listing/TOC mode (if enabled in settings)
  async function checkAutoActivation() {
    try {
      const origin = window.location.origin;

      // Check if this origin has reader mode enabled
      const result = await browserAPI.storage.local.get('readerEnabledOrigins');
      const enabledOrigins = result.readerEnabledOrigins || [];

      if (!enabledOrigins.includes(origin)) {
        // This origin doesn't have reader mode enabled
        return;
      }

      // Load settings to check if listing mode is enabled
      const settingsResult = await browserAPI.storage.sync.get('readerSettings');
      const savedSettings = settingsResult.readerSettings || {};
      const listingModeEnabled = savedSettings.listingModeEnabled !== false; // Default true

      // Small delay to let page fully load before checking content
      setTimeout(async () => {
        // Check if this page is actually an article
        if (await isArticlePage()) {
          activateReaderMode();
        } else if (listingModeEnabled) {
          // Not an article - show listing/TOC mode (if enabled)
          activateListingMode();
        }
      }, 500);
    } catch (e) {
      console.warn('Failed to check auto-activation:', e);
    }
  }

  /**
   * Detect if the current page is an article (not a homepage/listing/category page)
   * Uses multiple heuristics similar to Safari Reader
   */
  async function isArticlePage() {
    // Quick checks first

    // 1. Check URL patterns that typically indicate non-article pages
    const path = window.location.pathname;
    if (path === '/' || path === '') {
      // Homepage
      return false;
    }

    // 2. Check for article-like DOM structure
    const article = document.querySelector('article');
    const mainContent = document.querySelector('main, [role="main"], .article, .post, .entry-content');

    // 3. Look for a single prominent heading (articles usually have one main h1)
    const h1Elements = document.querySelectorAll('h1');
    const hasSingleMainHeading = h1Elements.length >= 1 && h1Elements.length <= 3;

    // 4. Check paragraph density - articles have substantial paragraphs
    const paragraphs = document.querySelectorAll('p');
    let substantialParagraphs = 0;
    let totalTextLength = 0;

    paragraphs.forEach(p => {
      const text = p.textContent.trim();
      if (text.length > 100) {
        substantialParagraphs++;
      }
      totalTextLength += text.length;
    });

    // 5. Check for multiple short snippets (listing pages have many small items)
    const listItems = document.querySelectorAll('li, .card, .teaser, .item, .snippet');
    const hasListingStructure = listItems.length > 10;

    // Decision logic
    // An article should have:
    // - Substantial text content (> 2000 chars)
    // - Multiple substantial paragraphs (> 3)
    // - Not have a listing structure with many items
    // - Preferably have article-like elements

    const hasSubstantialContent = totalTextLength > 2000 && substantialParagraphs > 3;
    const hasArticleStructure = (article || mainContent) && hasSingleMainHeading;
    const isNotListingPage = !hasListingStructure || substantialParagraphs > 5;

    // Final check: try to extract with Readability and see if we get good content
    if (hasSubstantialContent && isNotListingPage) {
      try {
        const documentClone = document.cloneNode(true);
        const reader = new Readability(documentClone, { charThreshold: 500 });
        const parsed = reader.parse();

        if (parsed && parsed.textContent) {
          const wordCount = parsed.textContent.trim().split(/\s+/).length;
          // Article should have at least 200 words of extracted content
          return wordCount > 200;
        }
      } catch (e) {
        console.warn('Readability check failed:', e);
      }
    }

    return false;
  }

  /**
   * Remember this origin as having reader mode enabled
   */
  async function enableReaderForOrigin() {
    try {
      const origin = window.location.origin;
      const result = await browserAPI.storage.local.get('readerEnabledOrigins');
      const enabledOrigins = result.readerEnabledOrigins || [];

      if (!enabledOrigins.includes(origin)) {
        enabledOrigins.push(origin);
        await browserAPI.storage.local.set({ readerEnabledOrigins: enabledOrigins });
        console.log('Reader mode enabled for origin:', origin);
      }
    } catch (e) {
      console.warn('Failed to save enabled origin:', e);
    }
  }

  /**
   * Toggle reader mode on/off
   * On first activation, detects whether page is article or listing
   */
  async function toggleReaderMode() {
    if (isReaderActive) {
      deactivateReaderMode();
    } else {
      // Detect whether this is an article or listing page
      const isArticle = await isArticlePage();

      if (isArticle) {
        activateReaderMode();
      } else {
        // Check if listing mode is enabled in settings
        const settingsResult = await browserAPI.storage.sync.get('readerSettings');
        const savedSettings = settingsResult.readerSettings || {};
        const listingModeEnabled = savedSettings.listingModeEnabled !== false; // Default true

        if (listingModeEnabled) {
          activateListingMode();
        } else {
          // Listing mode disabled, try article mode anyway
          activateReaderMode();
        }
      }
    }
  }

  /**
   * Activate reader mode - extract article and show overlay
   */
  async function activateReaderMode() {
    if (isReaderActive) return;

    try {
      // Extract article
      articleData = extractArticle();

      if (!articleData) {
        console.warn('Could not extract article from this page');
        showNotification('Could not extract article from this page');
        return;
      }

      // Create and show reader overlay
      await createReaderOverlay();
      isReaderActive = true;

      // Remember this origin as having reader mode enabled
      await enableReaderForOrigin();

    } catch (error) {
      console.error('Failed to activate reader mode:', error);
      showNotification('Failed to activate reader mode');
    }
  }

  /**
   * Activate listing/TOC mode - show clean links view
   */
  async function activateListingMode() {
    if (isReaderActive) return;

    try {
      // Extract listing structure
      listingData = extractListing();

      if (!listingData || listingData.sections.length === 0) {
        console.warn('Could not extract listing from this page');
        return;
      }

      // Create and show reader overlay (reuse the same overlay)
      isListingMode = true;
      await createReaderOverlay();
      isReaderActive = true;

      // Remember this origin as having reader mode enabled
      await enableReaderForOrigin();

    } catch (error) {
      console.error('Failed to activate listing mode:', error);
    }
  }

  /**
   * Deactivate reader mode - hide overlay and restore page
   */
  async function deactivateReaderMode() {
    if (!isReaderActive) return;

    if (readerOverlay) {
      readerOverlay.style.display = 'none';
    }

    document.title = originalTitle;
    document.body.style.overflow = '';
    isReaderActive = false;
    isListingMode = false;

    // Remove this origin from enabled origins list
    await disableReaderForOrigin();
  }

  /**
   * Remove this origin from the enabled origins list
   */
  async function disableReaderForOrigin() {
    try {
      const origin = window.location.origin;
      const result = await browserAPI.storage.local.get('readerEnabledOrigins');
      const enabledOrigins = result.readerEnabledOrigins || [];

      const index = enabledOrigins.indexOf(origin);
      if (index !== -1) {
        enabledOrigins.splice(index, 1);
        await browserAPI.storage.local.set({ readerEnabledOrigins: enabledOrigins });
        console.log('Reader mode disabled for origin:', origin);
      }
    } catch (e) {
      console.warn('Failed to remove enabled origin:', e);
    }
  }


  /**
   * Extract listing/TOC structure from a non-article page
   * Preserves sections AND nested main/sub article hierarchy
   *
   * Output structure:
   * {
   *   sections: [
   *     {
   *       title: "News",
   *       level: 2,
   *       items: [
   *         {
   *           main: { href, text, isExternal },
   *           subs: [{ href, text, isExternal }, ...]
   *         }
   *       ]
   *     }
   *   ]
   * }
   */
  function extractListing() {
    const sections = [];
    let currentSection = { title: null, level: null, items: [] };
    const seenHrefs = new Set();
    const processedContainers = new WeakSet();

    // Find main content area
    const mainContent = document.querySelector('main, [role="main"], .content, #content, .main') || document.body;

    // Selectors for elements to skip entirely
    const skipSelectors = [
      'nav', 'footer', '.sidebar', '.advertisement', '.ad',
      '.social', '.share', '.comment', '.cookie', '.popup', '.modal',
      'script', 'style', 'noscript', 'iframe', 'form', '[role="search"]',
      '.newsletter', '.subscribe', '.promo', '.banner', '[hidden]',
      '.sr-only', '.visually-hidden'
    ].join(', ');

    // Container selectors - elements that group a main article with sub-links
    const containerSelectors = [
      'article',
      '[data-link-name]',           // Guardian uses this
      '[class*="card"]',
      '[class*="story"]',
      '[class*="teaser"]',
      '[class*="item"]',
      'li'
    ].join(', ');

    /**
     * Check if element should be skipped
     */
    function shouldSkip(el) {
      if (!el || !el.matches) return false;
      try {
        return el.matches(skipSelectors) || el.closest(skipSelectors);
      } catch (e) {
        return false;
      }
    }

    /**
     * Validate and create a link object
     */
    function createLink(href, text) {
      if (!href || !text) return null;
      text = stripHtmlTags(text).trim();
      if (text.length < 5 || text.length > 400) return null;
      if (href.startsWith('javascript:')) return null;

      try {
        const url = new URL(href, window.location.origin);
        // Skip same-page anchors
        if (url.hash && url.pathname === window.location.pathname && url.origin === window.location.origin) {
          return null;
        }
        // Skip common non-article links
        if (text.match(/^(home|about|contact|login|sign in|sign up|subscribe|more\.{0,3}|menu|search|privacy|terms|cookie|skip to)/i)) {
          return null;
        }
        return {
          href: url.href,
          text,
          isExternal: url.origin !== window.location.origin
        };
      } catch (e) {
        return null;
      }
    }

    /**
     * Add link if not already seen
     */
    function addIfNew(link) {
      if (!link || seenHrefs.has(link.href)) return null;
      seenHrefs.add(link.href);
      return link;
    }

    /**
     * Find the "main" link in a container (the primary headline link)
     */
    function findMainLink(container) {
      // Priority 1: Link with aria-label (modern overlay pattern)
      const ariaLink = container.querySelector('a[aria-label][href]');
      if (ariaLink && !shouldSkip(ariaLink)) {
        const link = createLink(ariaLink.href, ariaLink.getAttribute('aria-label'));
        if (link) return { link, element: ariaLink };
      }

      // Priority 2: Link containing a heading
      const headingInLink = container.querySelector('a[href] h1, a[href] h2, a[href] h3, a[href] h4');
      if (headingInLink) {
        const linkEl = headingInLink.closest('a');
        if (linkEl && !shouldSkip(linkEl)) {
          const link = createLink(linkEl.href, headingInLink.textContent);
          if (link) return { link, element: linkEl };
        }
      }

      // Priority 3: Heading that's inside a link
      const heading = container.querySelector('h1, h2, h3, h4');
      if (heading) {
        const parentLink = heading.closest('a');
        if (parentLink && !shouldSkip(parentLink)) {
          const link = createLink(parentLink.href, heading.textContent);
          if (link) return { link, element: parentLink };
        }
        // Heading contains a link
        const childLink = heading.querySelector('a[href]');
        if (childLink && !shouldSkip(childLink)) {
          const link = createLink(childLink.href, heading.textContent);
          if (link) return { link, element: childLink };
        }
      }

      // Priority 4: First prominent link (with substantial text)
      const allLinks = container.querySelectorAll('a[href]');
      for (const a of allLinks) {
        if (shouldSkip(a)) continue;
        const text = a.textContent.trim();
        if (text.length >= 20) {
          const link = createLink(a.href, text);
          if (link) return { link, element: a };
        }
      }

      return null;
    }

    /**
     * Find sub-links in a container (secondary/related links)
     */
    function findSubLinks(container, mainLinkEl) {
      const subs = [];

      // Look for explicit sublinks containers
      const sublinksContainer = container.querySelector('ul.sublinks, .sublinks, .related-links, .more-links');
      const searchIn = sublinksContainer || container;

      const allLinks = searchIn.querySelectorAll('a[href]');
      for (const a of allLinks) {
        // Skip the main link itself
        if (a === mainLinkEl) continue;
        // Skip if contains the main link
        if (mainLinkEl && a.contains(mainLinkEl)) continue;
        // Skip if contained by main link
        if (mainLinkEl && mainLinkEl.contains(a)) continue;
        // Skip aria-label links (already used as main)
        if (a.hasAttribute('aria-label')) continue;
        if (shouldSkip(a)) continue;

        const link = createLink(a.href, a.textContent);
        const added = addIfNew(link);
        if (added) subs.push(added);
      }

      return subs;
    }

    /**
     * Check if element is a section header
     * Returns { isSection: boolean, href: string|null }
     * Section headers are SHORT text (like "News", "Sport") - NOT headlines
     * They CAN be links (to the section page)
     */
    function checkSectionHeader(heading) {
      const text = stripHtmlTags(heading.textContent).trim();

      // Section headers must be very short (max 25 chars) - things like "News", "Sport", "Opinion"
      // Headlines are longer - "Trump says 'no comment' when asked..."
      if (!text || text.length > 25) {
        return { isSection: false, href: null };
      }

      // Check if this heading is a link or contains a link
      const parentLink = heading.closest('a');
      const childLink = heading.querySelector('a[href]');
      const linkEl = parentLink || childLink;

      // It's a section if it's short text
      return {
        isSection: true,
        href: linkEl ? linkEl.href : null,
        text: text
      };
    }

    /**
     * Process a container element to extract main + sub links
     */
    function processContainer(container) {
      if (processedContainers.has(container)) return null;
      if (shouldSkip(container)) return null;

      const mainResult = findMainLink(container);
      if (!mainResult) return null;

      const main = addIfNew(mainResult.link);
      if (!main) return null;

      processedContainers.add(container);

      const subs = findSubLinks(container, mainResult.element);

      return { main, subs };
    }

    /**
     * Start new section if current has content
     * Sections can have a titleHref (making them clickable)
     */
    function startNewSection(title, level, titleHref = null) {
      if (currentSection.items.length > 0) {
        sections.push(currentSection);
      }
      currentSection = { title, level, titleHref, items: [] };
    }

    // === Main extraction logic ===

    // Walk the DOM in document order to preserve structure
    const walker = document.createTreeWalker(
      mainContent,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (shouldSkip(node)) return NodeFilter.FILTER_SKIP; // SKIP, not REJECT - check children
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
      // Check for section headers (H1-H2 with SHORT text like "News", "Sport")
      // H3+ are typically article headlines, not sections
      if (node.tagName && node.tagName.match(/^H[1-2]$/)) {
        const sectionInfo = checkSectionHeader(node);
        if (sectionInfo.isSection) {
          startNewSection(sectionInfo.text, parseInt(node.tagName[1]), sectionInfo.href);
          continue;
        }
      }

      // Check for <section> elements with headings
      if (node.tagName === 'SECTION') {
        const sectionHeading = node.querySelector(':scope > h1, :scope > h2, :scope > header h1, :scope > header h2');
        if (sectionHeading) {
          const sectionInfo = checkSectionHeader(sectionHeading);
          if (sectionInfo.isSection) {
            startNewSection(sectionInfo.text, 2, sectionInfo.href);
          }
        }
      }

      // Check for containers (cards, articles, list items)
      try {
        if (node.matches && node.matches(containerSelectors)) {
          // Only process if this container has links
          if (node.querySelector('a[href]')) {
            const item = processContainer(node);
            if (item) {
              currentSection.items.push(item);
            }
          }
        }
      } catch (e) {
        // matches() might throw for invalid selectors
      }
    }

    // Save last section
    if (currentSection.items.length > 0) {
      sections.push(currentSection);
    }

    // Fallback: if we got very few results, do a simpler extraction
    const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
    if (totalItems < 5) {
      // Simple fallback: just get all links with substantial text
      const fallbackItems = [];
      const allLinks = mainContent.querySelectorAll('a[href]');

      for (const a of allLinks) {
        if (shouldSkip(a)) continue;
        const link = createLink(a.href, a.textContent);
        const added = addIfNew(link);
        if (added && added.text.length >= 15) {
          fallbackItems.push({ main: added, subs: [] });
        }
      }

      if (fallbackItems.length > 0) {
        if (sections.length === 0) {
          sections.push({ title: null, level: null, items: fallbackItems });
        } else {
          // Merge into existing sections
          sections[sections.length - 1].items.push(...fallbackItems);
        }
      }
    }

    return {
      siteName: extractSiteName(),
      pageTitle: document.title,
      sections,
      sourceUrl: window.location.href
    };
  }

  /**
   * Sanitize HTML content to remove potentially dangerous elements
   * This provides security similar to Firefox Reader
   */
  function sanitizeHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Remove all inline event handlers
    const allElements = doc.body.querySelectorAll('*');
    const eventAttributes = [
      'onabort', 'onblur', 'onchange', 'onclick', 'ondblclick', 'onerror',
      'onfocus', 'oninput', 'onkeydown', 'onkeypress', 'onkeyup', 'onload',
      'onmousedown', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup',
      'onreset', 'onresize', 'onscroll', 'onselect', 'onsubmit', 'onunload',
      'onbeforeunload', 'onhashchange', 'onmessage', 'onoffline', 'ononline',
      'onpagehide', 'onpageshow', 'onpopstate', 'onstorage', 'onanimationend',
      'onanimationiteration', 'onanimationstart', 'ontransitionend', 'onwheel',
      'oncopy', 'oncut', 'onpaste', 'ondrag', 'ondragend', 'ondragenter',
      'ondragleave', 'ondragover', 'ondragstart', 'ondrop', 'oncontextmenu'
    ];

    allElements.forEach(el => {
      // Remove event handler attributes
      eventAttributes.forEach(attr => {
        el.removeAttribute(attr);
      });

      // Remove javascript: URLs from href and src
      ['href', 'src', 'action', 'formaction', 'xlink:href'].forEach(attr => {
        const value = el.getAttribute(attr);
        if (value && value.trim().toLowerCase().startsWith('javascript:')) {
          el.removeAttribute(attr);
        }
      });

      // Remove data: URLs from links (but keep in img src for base64 images)
      if (el.tagName !== 'IMG') {
        const href = el.getAttribute('href');
        if (href && href.trim().toLowerCase().startsWith('data:')) {
          el.removeAttribute('href');
        }
      }
    });

    // Remove script and style elements (Readability should have done this, but double-check)
    doc.body.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    // Remove forms and form elements
    doc.body.querySelectorAll('form, input, button, select, textarea').forEach(el => el.remove());

    // Remove iframes, objects, embeds
    doc.body.querySelectorAll('iframe, object, embed, applet').forEach(el => el.remove());

    return doc.body.innerHTML;
  }

  /**
   * Pre-process DOM to remove unwanted elements before Readability extraction
   * This mimics Safari Reader's behavior of filtering out social embeds, cookie notices, etc.
   */
  function preprocessDOM(doc) {
    // Remove social media embed placeholders and cookie consent blocks
    const selectorsToRemove = [
      // Social media embeds and placeholders
      '[data-embed-type]',
      '[data-social-embed]',
      '.social-embed',
      '.social-embed-placeholder',
      '.embed-placeholder',
      '.twitter-embed',
      '.instagram-embed',
      '.facebook-embed',
      '.tiktok-embed',
      '.social-media-embed',
      '.embedded-content-placeholder',
      // Cookie consent related
      '.cookie-consent',
      '.cookie-notice',
      '.cookie-banner',
      '.consent-placeholder',
      '.gdpr-placeholder',
      // Generic embed containers that are placeholders
      '.embed-container:not(:has(iframe))',
      // iframes without src (placeholder state)
      'iframe:not([src])',
      'iframe[src=""]',
      'iframe[src="about:blank"]',
    ];

    // Remove elements matching selectors
    selectorsToRemove.forEach(selector => {
      try {
        doc.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // Selector might not be supported, ignore
      }
    });

    // Remove elements containing cookie/consent text patterns (multi-language)
    const consentPatterns = [
      /cookie[s]?.*(?:accepte|toestemming|consent|akzeptieren|accetta)/i,
      /(?:accepte|toestemming|consent|akzeptieren|accetta).*cookie/i,
      /sociale?\s*media.*(?:cookie|consent|toestemming)/i,
      /(?:twitter|facebook|instagram|tiktok).*(?:cookie|consent|toestemming)/i,
      /om\s+(?:deze|u|je)\s+content.*cookie/i,  // Dutch pattern
      /pour\s+afficher\s+ce\s+contenu/i,  // French pattern
      /um\s+diesen\s+inhalt.*cookie/i,  // German pattern
    ];

    // Find and remove placeholder divs with consent text
    const allDivs = doc.querySelectorAll('div, aside, section, figure');
    allDivs.forEach(el => {
      const text = el.textContent || '';
      // Only check smaller elements (placeholders are usually not huge)
      if (text.length < 1000) {
        for (const pattern of consentPatterns) {
          if (pattern.test(text)) {
            el.remove();
            break;
          }
        }
      }
    });

    return doc;
  }

  /**
   * Extract article using Readability
   */
  function extractArticle() {
    const documentClone = document.cloneNode(true);

    // Pre-process to remove social embeds and cookie placeholders (Safari-like behavior)
    preprocessDOM(documentClone);

    const reader = new Readability(documentClone, {
      charThreshold: 500,
      classesToPreserve: ['caption', 'figcaption']
    });

    const article = reader.parse();
    if (!article) return null;

    const wordCount = article.textContent.trim().split(/\s+/).length;
    const readingTime = Math.ceil(wordCount / 200);

    return {
      title: article.title || document.title,
      byline: article.byline || '',
      content: sanitizeHTML(article.content),
      textContent: article.textContent,
      excerpt: article.excerpt || '',
      siteName: article.siteName || extractSiteName(),
      length: article.length,
      wordCount: wordCount,
      readingTime: readingTime,
      sourceUrl: window.location.href,
      dir: article.dir || 'ltr',
      lang: article.lang || document.documentElement.lang || 'en'
    };
  }

  /**
   * Extract site name from meta tags or domain
   */
  function extractSiteName() {
    const ogSiteName = document.querySelector('meta[property="og:site_name"]');
    if (ogSiteName) return ogSiteName.getAttribute('content');

    const appName = document.querySelector('meta[name="application-name"]');
    if (appName) return appName.getAttribute('content');

    try {
      return new URL(window.location.href).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  /**
   * Create reader overlay with Shadow DOM
   */
  async function createReaderOverlay() {
    // Create overlay if it doesn't exist
    if (!readerOverlay) {
      readerOverlay = document.createElement('div');
      readerOverlay.id = 'inkpages-overlay';
      readerOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 2147483647;
        background: white;
      `;

      // Create shadow root for style isolation
      shadowRoot = readerOverlay.attachShadow({ mode: 'closed' });

      // Load CSS
      const cssUrl = browserAPI.runtime.getURL('src/reader/reader.css');
      const cssResponse = await fetch(cssUrl);
      const cssText = await cssResponse.text();

      // Load HTML template
      const htmlUrl = browserAPI.runtime.getURL('src/reader/reader.html');
      const htmlResponse = await fetch(htmlUrl);
      const htmlText = await htmlResponse.text();

      // Parse HTML and extract body content
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');
      const bodyContent = doc.body.innerHTML;

      // Inject into shadow DOM with a wrapper that acts as body
      shadowRoot.innerHTML = `
        <style>${cssText}</style>
        <div id="reader-wrapper">${bodyContent}</div>
      `;

      document.body.appendChild(readerOverlay);

      // Initialize reader functionality
      initializeReader();
    }

    // Show overlay
    readerOverlay.style.display = 'block';
    document.body.style.overflow = 'hidden';

    // Render content based on mode
    if (isListingMode && listingData) {
      document.title = listingData.pageTitle + ' - InkPages';
      renderListing();
    } else if (articleData) {
      document.title = articleData.title + ' - InkPages';
      renderArticle();
    }
  }

  /**
   * Initialize reader UI and functionality
   */
  function initializeReader() {
    // Elements
    const elements = {
      loadingContainer: shadowRoot.getElementById('loading-container'),
      errorContainer: shadowRoot.getElementById('error-container'),
      articleContainer: shadowRoot.getElementById('article-container'),
      articleTitle: shadowRoot.getElementById('article-title'),
      articleByline: shadowRoot.getElementById('article-byline'),
      articleReadingTime: shadowRoot.getElementById('article-reading-time'),
      contentViewport: shadowRoot.getElementById('content-viewport'),
      articleContent: shadowRoot.getElementById('article-content'),
      siteName: shadowRoot.getElementById('site-name'),
      compactTitle: shadowRoot.getElementById('compact-title'),
      headerCenter: shadowRoot.querySelector('.header-center'),
      articleHeader: shadowRoot.getElementById('article-header'),
      pageIndicator: shadowRoot.getElementById('page-indicator'),
      progressFill: shadowRoot.getElementById('progress-fill'),
      tapZonePrev: shadowRoot.getElementById('tap-zone-prev'),
      tapZoneNext: shadowRoot.getElementById('tap-zone-next'),
      btnClose: shadowRoot.getElementById('btn-close'),
      btnSettings: shadowRoot.getElementById('btn-settings'),
      settingsPanel: shadowRoot.getElementById('settings-panel'),
      settingsOverlay: shadowRoot.getElementById('settings-overlay'),
      btnCloseSettings: shadowRoot.getElementById('btn-close-settings'),
      btnCloseReader: shadowRoot.getElementById('btn-close-reader'),
      fontBtns: shadowRoot.querySelectorAll('.font-btn'),
      fontSizeSlider: shadowRoot.getElementById('font-size-slider'),
      fontSizeValue: shadowRoot.getElementById('font-size-value'),
      lineHeightSlider: shadowRoot.getElementById('line-height-slider'),
      lineHeightValue: shadowRoot.getElementById('line-height-value'),
      pageWidthSlider: shadowRoot.getElementById('page-width-slider'),
      pageWidthValue: shadowRoot.getElementById('page-width-value'),
      themeBtns: shadowRoot.querySelectorAll('.theme-btn'),
      toggleBold: shadowRoot.getElementById('toggle-bold'),
      toggleJustify: shadowRoot.getElementById('toggle-justify'),
      toggleGrayscale: shadowRoot.getElementById('toggle-grayscale'),
      toggleNoImages: shadowRoot.getElementById('toggle-no-images'),
      toggleListingMode: shadowRoot.getElementById('toggle-listing-mode'),
      sizeBtns: shadowRoot.querySelectorAll('.size-btn'),
      safeAreaSlider: shadowRoot.getElementById('safe-area-slider'),
      safeAreaValue: shadowRoot.getElementById('safe-area-value')
    };

    // Store elements for later use
    window.__einkReaderElements = elements;

    // State
    let currentPage = 0;
    let totalPages = 1;
    let pageWidth = 0;
    let settings = {
      fontFamily: 'serif',
      fontSize: 18,
      lineHeight: 1.8,
      pageWidth: 680,
      theme: 'light',
      boldText: false,
      justifyText: false,
      grayscale: false,
      noImages: false,
      safeAreaManual: 0,
      listingModeEnabled: true
    };

    // Store state for later use
    window.__einkReaderState = { currentPage, totalPages, pageWidth, settings };

    // Load settings
    loadSettings();

    // Set up event listeners
    setupEventListeners();

    async function loadSettings() {
      try {
        const result = await browserAPI.storage.sync.get('readerSettings');
        if (result.readerSettings) {
          settings = { ...settings, ...result.readerSettings };
          window.__einkReaderState.settings = settings;
        }
        applySettings();
      } catch (error) {
        console.warn('Failed to load settings:', error);
      }
    }

    async function saveSettings() {
      try {
        await browserAPI.storage.sync.set({ readerSettings: settings });
      } catch (error) {
        console.warn('Failed to save settings:', error);
      }
    }

    function applySettings() {
      const root = shadowRoot.host;
      root.setAttribute('data-theme', settings.theme);
      root.classList.remove('font-serif', 'font-sans-serif', 'font-monospace');
      root.classList.add(`font-${settings.fontFamily}`);
      root.style.setProperty('--font-size', `${settings.fontSize}px`);
      root.style.setProperty('--line-height', settings.lineHeight);
      root.style.setProperty('--page-width', `${settings.pageWidth}px`);
      root.style.setProperty('--safe-area-manual', `${settings.safeAreaManual}px`);

      root.classList.toggle('bold-text', settings.boldText);
      root.classList.toggle('justify-text', settings.justifyText);
      root.classList.toggle('grayscale', settings.grayscale);
      root.classList.toggle('no-images', settings.noImages);

      updateSettingsUI();

      if (articleData && elements.articleContent) {
        setTimeout(() => {
          currentPage = 0;
          window.__einkReaderState.currentPage = 0;
          setupPagination();
        }, 50);
      }
    }

    function updateSettingsUI() {
      elements.fontBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === settings.fontFamily);
      });

      elements.themeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === settings.theme);
      });

      if (elements.fontSizeSlider) {
        elements.fontSizeSlider.value = settings.fontSize;
        elements.fontSizeValue.textContent = `${settings.fontSize}px`;
      }

      if (elements.lineHeightSlider) {
        elements.lineHeightSlider.value = settings.lineHeight;
        elements.lineHeightValue.textContent = settings.lineHeight.toFixed(1);
      }

      if (elements.pageWidthSlider) {
        elements.pageWidthSlider.value = settings.pageWidth;
        elements.pageWidthValue.textContent = `${settings.pageWidth}px`;
      }

      if (elements.toggleBold) elements.toggleBold.checked = settings.boldText;
      if (elements.toggleJustify) elements.toggleJustify.checked = settings.justifyText;
      if (elements.toggleGrayscale) elements.toggleGrayscale.checked = settings.grayscale;
      if (elements.toggleNoImages) elements.toggleNoImages.checked = settings.noImages;

      if (elements.safeAreaSlider) {
        elements.safeAreaSlider.value = settings.safeAreaManual;
        elements.safeAreaValue.textContent = `${settings.safeAreaManual}px`;
      }

      if (elements.toggleListingMode) {
        elements.toggleListingMode.checked = settings.listingModeEnabled;
      }
    }

    function setupPagination() {
      const viewport = elements.contentViewport;
      const content = elements.articleContent;

      if (!viewport || !content) return;

      const viewportRect = viewport.getBoundingClientRect();
      const viewportWidth = viewportRect.width;
      const viewportHeight = viewportRect.height;
      const columnGap = 50;

      // Reset styles
      content.style.width = '';
      content.style.height = '';
      content.style.columnWidth = '';
      content.style.columnGap = '';
      content.style.transform = '';
      content.style.position = '';

      // Measure natural height
      content.style.position = 'absolute';
      content.style.width = viewportWidth + 'px';
      content.style.visibility = 'hidden';
      void content.offsetHeight;
      const naturalHeight = content.scrollHeight;

      content.style.position = '';
      content.style.visibility = '';

      // Set up columns
      content.style.height = viewportHeight + 'px';
      content.style.width = 'max-content';
      content.style.columnWidth = viewportWidth + 'px';
      content.style.columnGap = columnGap + 'px';
      content.style.columnFill = 'auto';

      void content.offsetHeight;
      const actualScrollWidth = content.scrollWidth;

      pageWidth = viewportWidth + columnGap;
      totalPages = Math.max(1, Math.ceil((actualScrollWidth + columnGap) / pageWidth));

      const lastPageStart = (totalPages - 1) * pageWidth;
      if (lastPageStart >= actualScrollWidth) {
        totalPages = Math.max(1, totalPages - 1);
      }

      const exactWidth = totalPages * viewportWidth + (totalPages - 1) * columnGap;
      content.style.width = exactWidth + 'px';

      currentPage = Math.min(currentPage, Math.max(0, totalPages - 1));

      // Store state
      window.__einkReaderState.currentPage = currentPage;
      window.__einkReaderState.totalPages = totalPages;
      window.__einkReaderState.pageWidth = pageWidth;

      updatePageDisplay();
    }

    function updatePageDisplay() {
      if (!elements.articleContent) return;

      const offset = currentPage * pageWidth;
      elements.articleContent.style.transform = `translateX(-${offset}px)`;
      elements.pageIndicator.textContent = `${currentPage + 1} / ${totalPages}`;

      const progress = totalPages > 1 ? ((currentPage + 1) / totalPages) * 100 : 100;
      elements.progressFill.style.width = `${progress}%`;

      // Hide full article header on pages 2+ (compact title in header bar is always visible)
      const isFirstPage = currentPage === 0;
      if (elements.articleHeader) {
        elements.articleHeader.classList.toggle('minimized', !isFirstPage);
      }

      saveReadingPosition();
    }

    function nextPage() {
      if (currentPage < totalPages - 1) {
        currentPage++;
        window.__einkReaderState.currentPage = currentPage;
        updatePageDisplay();
      }
    }

    function prevPage() {
      if (currentPage > 0) {
        currentPage--;
        window.__einkReaderState.currentPage = currentPage;
        updatePageDisplay();
      }
    }

    function goToPage(pageNum) {
      if (pageNum >= 0 && pageNum < totalPages) {
        currentPage = pageNum;
        window.__einkReaderState.currentPage = currentPage;
        updatePageDisplay();
      }
    }

    async function saveReadingPosition() {
      if (!articleData || !articleData.sourceUrl) return;
      const key = 'pos_' + articleData.sourceUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);

      try {
        const positions = (await browserAPI.storage.local.get('readingPositions')).readingPositions || {};
        positions[key] = { page: currentPage, totalPages, timestamp: Date.now() };

        const keys = Object.keys(positions);
        if (keys.length > 50) {
          const sorted = keys.sort((a, b) => positions[a].timestamp - positions[b].timestamp);
          sorted.slice(0, keys.length - 50).forEach(k => delete positions[k]);
        }

        await browserAPI.storage.local.set({ readingPositions: positions });
      } catch (error) {
        console.warn('Failed to save reading position:', error);
      }
    }

    async function loadReadingPosition() {
      if (!articleData || !articleData.sourceUrl) return 0;
      const key = 'pos_' + articleData.sourceUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);

      try {
        const positions = (await browserAPI.storage.local.get('readingPositions')).readingPositions || {};
        if (positions[key]) {
          return positions[key].page;
        }
      } catch (error) {
        console.warn('Failed to load reading position:', error);
      }
      return 0;
    }

    function setupEventListeners() {
      // Tap zones
      function addTapHandler(element, handler) {
        if (!element) return;
        element.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handler();
        });
        element.addEventListener('touchend', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handler();
        }, { passive: false });
      }

      addTapHandler(elements.tapZonePrev, prevPage);
      addTapHandler(elements.tapZoneNext, nextPage);

      // Swipe gestures
      let touchStartX = 0;
      let touchStartY = 0;
      const minSwipeDistance = 50;

      shadowRoot.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });

      shadowRoot.addEventListener('touchend', (e) => {
        if (!e.changedTouches.length) return;
        const deltaX = e.changedTouches[0].clientX - touchStartX;
        const deltaY = e.changedTouches[0].clientY - touchStartY;

        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > minSwipeDistance) {
          if (deltaX < 0) nextPage();
          else prevPage();
        }
      }, { passive: true });

      // Keyboard
      document.addEventListener('keydown', handleKeydown);

      // Close buttons
      if (elements.btnClose) {
        elements.btnClose.addEventListener('click', () => deactivateReaderMode());
      }
      if (elements.btnCloseReader) {
        elements.btnCloseReader.addEventListener('click', () => deactivateReaderMode());
      }

      // Settings
      if (elements.btnSettings) {
        elements.btnSettings.addEventListener('click', () => {
          elements.settingsPanel.classList.remove('hidden');
        });
      }
      if (elements.btnCloseSettings) {
        elements.btnCloseSettings.addEventListener('click', () => {
          elements.settingsPanel.classList.add('hidden');
        });
      }
      if (elements.settingsOverlay) {
        elements.settingsOverlay.addEventListener('click', () => {
          elements.settingsPanel.classList.add('hidden');
        });
      }

      // Font buttons
      elements.fontBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          settings.fontFamily = btn.dataset.font;
          applySettings();
          saveSettings();
        });
      });

      // Font size slider
      if (elements.fontSizeSlider) {
        elements.fontSizeSlider.addEventListener('input', (e) => {
          settings.fontSize = parseInt(e.target.value, 10);
          elements.fontSizeValue.textContent = `${settings.fontSize}px`;
          applySettings();
        });
        elements.fontSizeSlider.addEventListener('change', saveSettings);
      }

      // Size buttons
      elements.sizeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'increase' && settings.fontSize < 32) {
            settings.fontSize += 2;
          } else if (action === 'decrease' && settings.fontSize > 14) {
            settings.fontSize -= 2;
          }
          applySettings();
          saveSettings();
        });
      });

      // Line height slider
      if (elements.lineHeightSlider) {
        elements.lineHeightSlider.addEventListener('input', (e) => {
          settings.lineHeight = parseFloat(e.target.value);
          elements.lineHeightValue.textContent = settings.lineHeight.toFixed(1);
          applySettings();
        });
        elements.lineHeightSlider.addEventListener('change', saveSettings);
      }

      // Page width slider
      if (elements.pageWidthSlider) {
        elements.pageWidthSlider.addEventListener('input', (e) => {
          settings.pageWidth = parseInt(e.target.value, 10);
          elements.pageWidthValue.textContent = `${settings.pageWidth}px`;
          applySettings();
        });
        elements.pageWidthSlider.addEventListener('change', saveSettings);
      }

      // Theme buttons
      elements.themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          settings.theme = btn.dataset.theme;
          applySettings();
          saveSettings();
        });
      });

      // Toggles
      if (elements.toggleBold) {
        elements.toggleBold.addEventListener('change', (e) => {
          settings.boldText = e.target.checked;
          applySettings();
          saveSettings();
        });
      }
      if (elements.toggleJustify) {
        elements.toggleJustify.addEventListener('change', (e) => {
          settings.justifyText = e.target.checked;
          applySettings();
          saveSettings();
        });
      }
      if (elements.toggleGrayscale) {
        elements.toggleGrayscale.addEventListener('change', (e) => {
          settings.grayscale = e.target.checked;
          applySettings();
          saveSettings();
        });
      }
      if (elements.toggleNoImages) {
        elements.toggleNoImages.addEventListener('change', (e) => {
          settings.noImages = e.target.checked;
          applySettings();
          saveSettings();
        });
      }

      // Safe area slider
      if (elements.safeAreaSlider) {
        elements.safeAreaSlider.addEventListener('input', (e) => {
          settings.safeAreaManual = parseInt(e.target.value, 10);
          elements.safeAreaValue.textContent = `${settings.safeAreaManual}px`;
          applySettings();
        });
        elements.safeAreaSlider.addEventListener('change', saveSettings);
      }

      // Listing mode toggle
      if (elements.toggleListingMode) {
        elements.toggleListingMode.addEventListener('change', (e) => {
          settings.listingModeEnabled = e.target.checked;
          saveSettings();
        });
      }

      // Window resize
      let resizeTimeout;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(setupPagination, 150);
      });
    }

    function handleKeydown(e) {
      if (!isReaderActive) return;

      if (elements.settingsPanel && !elements.settingsPanel.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          elements.settingsPanel.classList.add('hidden');
        }
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          nextPage();
          break;
        case ' ':
          e.preventDefault();
          if (e.shiftKey) prevPage();
          else nextPage();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          prevPage();
          break;
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault();
          nextPage();
          break;
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault();
          prevPage();
          break;
        case 'Home':
          e.preventDefault();
          goToPage(0);
          break;
        case 'End':
          e.preventDefault();
          goToPage(totalPages - 1);
          break;
        case 'Escape':
          deactivateReaderMode();
          break;
        case 's':
        case 'S':
          if (!e.ctrlKey && !e.metaKey) {
            elements.settingsPanel.classList.remove('hidden');
          }
          break;
      }
    }

    // Expose functions for external use
    window.__einkReaderFunctions = {
      nextPage,
      prevPage,
      goToPage,
      setupPagination,
      applySettings,
      loadReadingPosition
    };
  }

  /**
   * Render article content
   */
  function renderArticle() {
    const elements = window.__einkReaderElements;
    if (!elements || !articleData) return;

    // Hide loading, show content
    if (elements.loadingContainer) {
      elements.loadingContainer.classList.add('hidden');
    }

    // Set article data
    elements.articleTitle.textContent = articleData.title || '';
    elements.articleByline.textContent = articleData.byline || '';
    elements.siteName.textContent = articleData.siteName || '';

    // Set compact title for pages 2+
    if (elements.compactTitle) {
      elements.compactTitle.textContent = articleData.title || '';
    }

    if (articleData.readingTime) {
      elements.articleReadingTime.textContent = `${articleData.readingTime} min read`;
    }

    // Render content
    elements.articleContent.innerHTML = articleData.content || '';

    // Process images
    const images = elements.articleContent.querySelectorAll('img');
    images.forEach(img => {
      if (img.dataset.src && !img.src) img.src = img.dataset.src;
      if (img.dataset.lazySrc && !img.src) img.src = img.dataset.lazySrc;
      img.loading = 'lazy';
      img.style.breakInside = 'avoid';
    });

    // Process links - intercept for sticky reader mode
    const links = elements.articleContent.querySelectorAll('a[href]');
    links.forEach(link => {
      link.addEventListener('click', handleLinkClick);
    });

    // Set up pagination after content is rendered
    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        const funcs = window.__einkReaderFunctions;
        if (funcs) {
          funcs.setupPagination();
          const savedPage = await funcs.loadReadingPosition();
          if (savedPage > 0) {
            funcs.goToPage(savedPage);
          }
        }
      });
    });
  }

  /**
   * Render listing/TOC content
   */
  function renderListing() {
    const elements = window.__einkReaderElements;
    if (!elements || !listingData) return;

    // Hide loading, show content
    if (elements.loadingContainer) {
      elements.loadingContainer.classList.add('hidden');
    }

    // Set header data
    elements.articleTitle.textContent = listingData.pageTitle || 'Contents';
    elements.articleByline.textContent = '';
    elements.siteName.textContent = listingData.siteName || '';
    elements.articleReadingTime.textContent = `${countTotalLinks()} links`;

    // Set compact title
    if (elements.compactTitle) {
      elements.compactTitle.textContent = listingData.pageTitle || 'Contents';
    }

    // Generate listing HTML with nested structure
    let html = '<div class="listing-content">';

    for (const section of listingData.sections) {
      // Section title (can be a link if titleHref exists)
      if (section.title) {
        const level = section.level || 2;
        if (section.titleHref) {
          html += `<h${level} class="listing-section-title"><a href="${escapeHtml(section.titleHref)}">${escapeHtml(section.title)}</a></h${level}>`;
        } else {
          html += `<h${level} class="listing-section-title">${escapeHtml(section.title)}</h${level}>`;
        }
      }

      // Section items (main + subs)
      if (section.items && section.items.length > 0) {
        html += '<ul class="listing-items">';

        for (const item of section.items) {
          const mainExternal = item.main.isExternal ? ' <span class="external-indicator">↗</span>' : '';
          html += '<li class="listing-item">';

          // Main link
          html += `<a href="${escapeHtml(item.main.href)}" class="listing-main-link">${escapeHtml(item.main.text)}${mainExternal}</a>`;

          // Sub-links (if any)
          if (item.subs && item.subs.length > 0) {
            html += '<ul class="listing-sub-links">';
            for (const sub of item.subs) {
              const subExternal = sub.isExternal ? ' <span class="external-indicator">↗</span>' : '';
              html += `<li><a href="${escapeHtml(sub.href)}">${escapeHtml(sub.text)}${subExternal}</a></li>`;
            }
            html += '</ul>';
          }

          html += '</li>';
        }

        html += '</ul>';
      }
    }

    html += '</div>';

    // Render content
    elements.articleContent.innerHTML = html;

    // Process links - external open in new tab
    const links = elements.articleContent.querySelectorAll('a[href]');
    links.forEach(link => {
      link.addEventListener('click', handleLinkClick);
    });

    // Set up pagination after content is rendered
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const funcs = window.__einkReaderFunctions;
        if (funcs) {
          funcs.setupPagination();
        }
      });
    });
  }

  /**
   * Count total links in listing data (main + subs)
   */
  function countTotalLinks() {
    if (!listingData) return 0;
    return listingData.sections.reduce((total, section) => {
      return total + (section.items || []).reduce((sectionTotal, item) => {
        return sectionTotal + 1 + (item.subs ? item.subs.length : 0);
      }, 0);
    }, 0);
  }

  /**
   * Escape HTML special characters
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Strip HTML tags from text (for cleaning extracted content)
   */
  function stripHtmlTags(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>/g, '').trim();
  }

  /**
   * Handle link clicks - external links open in new tab
   */
  function handleLinkClick(e) {
    const link = e.currentTarget;
    const href = link.href;

    // Only modify external links - open them in new tab
    try {
      const url = new URL(href);
      if (url.origin !== window.location.origin) {
        // External link - open in new tab
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
      // Same-origin links navigate normally
      // Auto-activation will check if the new page is an article
    } catch {
      return;
    }
  }

  /**
   * Show notification
   */
  function showNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #333;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  // Check if we should auto-activate reader mode on this page
  checkAutoActivation();
})();
