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
  let readerDialog = null;
  let readerOverlay = null;
  let shadowRoot = null;
  function isReaderFullscreen() {
    return Boolean(
      document.fullscreenElement &&
      (document.fullscreenElement === readerDialog || document.fullscreenElement === readerOverlay)
    );
  }
  // Full screen (v1.6.0): the user left fullscreen themselves on this page (do not re-enter on the next tap),
  // and when fullscreen last ended (an Escape that ended it must not also close the reader)
  let fullscreenUserExited = false;
  let lastFullscreenExit = 0;
  // Page title to restore when the reader closes, and the title the reader set
  let originalTitle = document.title;
  let readerTitle = null;
  let articleData = null;
  let listingData = null;
  // Article parsed by isArticlePage(), reused on activation so Readability only runs once
  let detectedArticle = null;
  const isLikelyAndroid = /Android/i.test(navigator.userAgent);
  const floatingButtonPositionKey = 'floatingButtonPosition';
  let floatingButtonEnabled = isLikelyAndroid;
  let floatingButtonSize = 50;
  let floatingButtonElement = null;
  let floatingButtonInner = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeFloatingButtonSize(value) {
    const numericValue = Number(value);
    const fallback = 50;
    return clamp(Number.isFinite(numericValue) ? numericValue : fallback, 32, 84);
  }

  function setFloatingButtonSize(size) {
    floatingButtonSize = normalizeFloatingButtonSize(size);
    if (!floatingButtonInner) return;

    const sizePx = Math.round(floatingButtonSize);
    const fontSizePx = Math.max(11, Math.round(sizePx * 0.26));
    floatingButtonInner.style.width = `${sizePx}px`;
    floatingButtonInner.style.height = `${sizePx}px`;
    floatingButtonInner.style.fontSize = `${fontSizePx}px`;
  }

  // Styles live inside the button's own shadow root so host page CSS can't restyle it
  const floatingButtonStyles = `
    button {
      width: 50px;
      height: 50px;
      margin: 0;
      padding: 0;
      border: 2px solid #111;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.35);
      color: #111;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.2px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      backdrop-filter: blur(1px);
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-user-drag: none;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }

    button:hover {
      opacity: 0.95;
    }

    button.dragging {
      opacity: 0.98;
      transform: scale(1.05);
    }
  `;

  function updateFloatingButtonVisibility() {
    if (!floatingButtonElement) return;
    const shouldShow = floatingButtonEnabled && !isReaderActive;
    floatingButtonElement.style.display = shouldShow ? 'block' : 'none';
  }

  async function loadFloatingButtonPosition() {
    try {
      const result = await browserAPI.storage.local.get(floatingButtonPositionKey);
      return result[floatingButtonPositionKey] || null;
    } catch (error) {
      console.warn('Failed to load floating button position:', error);
      return null;
    }
  }

  async function saveFloatingButtonPosition(left, top) {
    try {
      await browserAPI.storage.local.set({
        [floatingButtonPositionKey]: {
          left: Math.round(left),
          top: Math.round(top)
        }
      });
    } catch (error) {
      console.warn('Failed to save floating button position:', error);
    }
  }

  function setFloatingButtonPosition(left, top) {
    if (!floatingButtonElement) return;

    const margin = 8;
    const width = floatingButtonElement.offsetWidth || 50;
    const height = floatingButtonElement.offsetHeight || 50;
    const clampedLeft = clamp(left, margin, Math.max(margin, window.innerWidth - width - margin));
    const clampedTop = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin));

    floatingButtonElement.style.left = `${Math.round(clampedLeft)}px`;
    floatingButtonElement.style.top = `${Math.round(clampedTop)}px`;
    floatingButtonElement.style.right = 'auto';
    floatingButtonElement.style.bottom = 'auto';
  }

  function setupFloatingButtonInteractions(button) {
    let dragState = null;

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Pointer taps are handled on pointerup; keyboard activation (Enter/Space) arrives as a click with detail 0
      if (event.detail === 0) {
        toggleReaderMode().catch(error => {
          console.error('Floating button toggle failed:', error);
        });
      }
    });

    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const rect = button.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        moved: false
      };

      button.classList.add('dragging');
      if (button.setPointerCapture) {
        button.setPointerCapture(event.pointerId);
      }

      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const nextLeft = event.clientX - dragState.offsetX;
      const nextTop = event.clientY - dragState.offsetY;
      setFloatingButtonPosition(nextLeft, nextTop);

      if (!dragState.moved) {
        const dx = Math.abs(event.clientX - dragState.startX);
        const dy = Math.abs(event.clientY - dragState.startY);
        if (dx > 4 || dy > 4) {
          dragState.moved = true;
        }
      }

      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('pointerup', async (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const wasMoved = dragState.moved;
      dragState = null;
      button.classList.remove('dragging');

      if (button.releasePointerCapture) {
        try {
          button.releasePointerCapture(event.pointerId);
        } catch (e) {
          // Ignore if capture is already released
        }
      }

      if (wasMoved) {
        const rect = button.getBoundingClientRect();
        await saveFloatingButtonPosition(rect.left, rect.top);
      } else {
        try {
          await toggleReaderMode();
        } catch (error) {
          console.error('Floating button toggle failed:', error);
        }
      }

      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('pointercancel', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState = null;
      button.classList.remove('dragging');
    });
  }

  async function ensureFloatingButton() {
    if (floatingButtonElement) return floatingButtonElement;

    // Remove a stale host left behind by a previous injection (its closed shadow root can't be reused)
    document.querySelectorAll('inkpages-button').forEach(el => el.remove());

    // Custom element name so generic page selectors (div, button, ...) don't match the host
    const host = document.createElement('inkpages-button');
    host.style.cssText = `
      all: initial;
      position: fixed;
      right: 16px;
      bottom: 96px;
      z-index: 2147483646;
      display: none;
    `;
    const buttonRoot = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = floatingButtonStyles;

    const button = document.createElement('button');
    button.type = 'button';
    button.draggable = false;
    button.textContent = 'Ink';
    button.title = 'Open InkPages';
    button.setAttribute('aria-label', 'Open InkPages reader');
    setupFloatingButtonInteractions(button);

    buttonRoot.append(style, button);
    document.body.appendChild(host);
    floatingButtonElement = host;
    floatingButtonInner = button;
    setFloatingButtonSize(floatingButtonSize);

    const savedPosition = await loadFloatingButtonPosition();
    if (
      savedPosition &&
      Number.isFinite(savedPosition.left) &&
      Number.isFinite(savedPosition.top)
    ) {
      setFloatingButtonPosition(savedPosition.left, savedPosition.top);
    }

    updateFloatingButtonVisibility();
    return floatingButtonElement;
  }

  function removeFloatingButton() {
    if (!floatingButtonElement) return;
    floatingButtonElement.remove();
    floatingButtonElement = null;
    floatingButtonInner = null;
  }

  function setFloatingButtonEnabled(enabled) {
    floatingButtonEnabled = !!enabled;
    if (floatingButtonEnabled) {
      ensureFloatingButton().catch(error => {
        console.warn('Failed to create floating button:', error);
      });
    } else {
      removeFloatingButton();
    }
  }

  async function initializeFloatingButton() {
    try {
      const result = await browserAPI.storage.sync.get('readerSettings');
      const savedSettings = result.readerSettings || {};
      if (typeof savedSettings.floatingButtonEnabled === 'boolean') {
        floatingButtonEnabled = savedSettings.floatingButtonEnabled;
      }
      if (savedSettings.floatingButtonSize !== undefined) {
        floatingButtonSize = normalizeFloatingButtonSize(savedSettings.floatingButtonSize);
      }
    } catch (error) {
      console.warn('Failed to load floating button setting:', error);
    }

    if (floatingButtonEnabled) {
      await ensureFloatingButton();
    }

    // Apply setting changes made in another tab without needing a reload
    browserAPI.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes.readerSettings) return;
      const newSettings = changes.readerSettings.newValue || {};
      if (newSettings.floatingButtonSize !== undefined) {
        setFloatingButtonSize(newSettings.floatingButtonSize);
      }
      if (typeof newSettings.floatingButtonEnabled === 'boolean' &&
          newSettings.floatingButtonEnabled !== floatingButtonEnabled) {
        setFloatingButtonEnabled(newSettings.floatingButtonEnabled);
      }
    });

    window.addEventListener('resize', () => {
      if (!floatingButtonElement) return;
      if (window.getComputedStyle(floatingButtonElement).display === 'none') return;
      const rect = floatingButtonElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setFloatingButtonPosition(rect.left, rect.top);
    });
  }

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
  //
  // After client-side navigation (previousFingerprint given) it first waits for the site
  // to swap in the new page, so the previous article isn't detected again.
  async function checkAutoActivation({ previousFingerprint, historyNavigation = false } = {}) {
    const run = ++autoActivationRun;
    // A newer navigation started its own check; this one is for a page that's gone
    const superseded = () => run !== autoActivationRun;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    try {
      const origin = window.location.origin;

      // Articles and link pages (homepage, sections) are separate choices per site
      const result = await browserAPI.storage.local.get(['readerEnabledOrigins', 'tocEnabledOrigins']);
      const openArticles = (result.readerEnabledOrigins || []).includes(origin);
      const openLinkPages = (result.tocEnabledOrigins || []).includes(origin);

      if (!openArticles && !openLinkPages) {
        // Nothing opens automatically on this origin
        return;
      }

      // Small delay to let page fully load before checking content
      await wait(500);

      if (previousFingerprint !== undefined) {
        const changed = await waitForNewPage(previousFingerprint, superseded);
        if (superseded()) return;
        // The site only rewrote the URL of the page it's showing (e.g. added a parameter).
        // Not a new page, and the user may have closed the reader here on purpose.
        if (!changed && !historyNavigation) return;
        lastPageFingerprint = pageFingerprint();
      }

      // Check if this page is actually an article. Pages that declare themselves an article
      // but render their text late (hydration, paywall checks) get a few more tries.
      if (superseded()) return;
      let isArticle = await isArticlePage();
      const retryDelays = isDeclaredArticle() ? [1000, 2000] : [];
      for (const delay of retryDelays) {
        if (isArticle || isReaderActive || superseded()) break;
        await wait(delay);
        if (superseded()) return;
        isArticle = await isArticlePage();
      }

      // The user may have opened the reader themselves while we were waiting
      if (isReaderActive || superseded()) return;

      // The TOC used to open on every non-article page of a remembered site (Reddit's home
      // screen, issue #3); it now needs its own Yes. A page that declares itself an article
      // never opens as a TOC unless it is clearly a multi-card link feed.
      if (isArticle) {
        if (openArticles) activateReaderMode();
      } else if (openLinkPages && (!isDeclaredArticle() || isMultiCardFeed())) {
        activateListingMode();
      }
    } catch (e) {
      console.warn('Failed to check auto-activation:', e);
    }
  }

  // Client-side navigation (history.pushState on single-page sites, e.g. volkskrant.nl)
  // changes the URL without reloading the page, so the content script doesn't run again.
  // Watch the URL and re-run auto-activation for each new page.
  let autoActivationRun = 0;
  let lastHref = window.location.href;
  let lastPageUrl = pageUrlKey(lastHref);
  let lastPageFingerprint = '';

  // URL without the #fragment and utm_* tracking parameters
  function pageUrlKey(href) {
    try {
      const url = new URL(href);
      url.hash = '';
      for (const param of Array.from(url.searchParams.keys())) {
        if (param.startsWith('utm_')) url.searchParams.delete(param);
      }
      return url.href;
    } catch {
      return href;
    }
  }

  // Cheap marker of which page the site is showing (the title is unusable: the reader sets it).
  // Recorded when the reader opens and when a navigation check settles, in lastPageFingerprint.
  function pageFingerprint() {
    const h1 = document.querySelector('article h1, main h1, [role="main"] h1') ||
      document.querySelector('h1');
    const canonical = document.querySelector('link[rel="canonical"]');
    const ogUrl = document.querySelector('meta[property="og:url"]');
    // Some sites have only a logo h1 and no canonical link; the text itself still differs
    const isLong = p => p.textContent.length > 100;
    const paragraph = Array.from(document.querySelectorAll('article p, main p')).find(isLong) ||
      Array.from(document.querySelectorAll('p')).find(isLong);
    return [
      h1 ? h1.textContent.trim().slice(0, 200) : '',
      canonical ? canonical.getAttribute('href') : '',
      ogUrl ? ogUrl.getAttribute('content') : '',
      paragraph ? paragraph.textContent.trim().slice(0, 200) : ''
    ].join('\n');
  }

  // Wait (up to ~4.5s) until the page differs from the previous one and has stopped
  // changing for one sample, so a page the site shows only briefly isn't picked up
  async function waitForNewPage(previousFingerprint, superseded) {
    let sample = null;
    for (let elapsed = 0; elapsed <= 4500; elapsed += 250) {
      if (superseded()) return false;
      const fingerprint = pageFingerprint();
      if (fingerprint !== previousFingerprint && fingerprint === sample) return true;
      sample = fingerprint;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }

  function onPossibleNavigation(event) {
    if (window.location.href === lastHref) return;
    lastHref = window.location.href;

    const url = pageUrlKey(lastHref);
    if (url === lastPageUrl) return; // Only the #fragment or tracking parameters changed
    lastPageUrl = url;

    const previousFingerprint = lastPageFingerprint;
    const historyNavigation = Boolean(event && event.type === 'popstate');
    if (isReaderActive) {
      // Back/forward always leaves the page the reader shows. Other URL changes while the
      // reader covers the page come from the site's own scripts (e.g. adding a parameter)
      // and only count when the page content changed as well.
      if (!historyNavigation && pageFingerprint() === previousFingerprint) return;
      deactivateReaderMode();
    }
    checkAutoActivation({ previousFingerprint, historyNavigation });
  }

  function watchForNavigation() {
    lastPageFingerprint = pageFingerprint();
    window.addEventListener('popstate', onPossibleNavigation);
    setInterval(onPossibleNavigation, 500);
  }

  function isMultiCardFeed() {
    const mainEl = document.querySelector('main, [role="main"]');
    const root = mainEl || document;
    const EXCLUDE_CARD_ANCESTORS = 'aside, nav, footer, [role="complementary"], [role="navigation"]';
    const cards = Array.from(root.querySelectorAll('article'))
      .filter(a => !a.closest(EXCLUDE_CARD_ANCESTORS));
    if (cards.length < 6) return false;
    const hasSubstantialCard = cards.some(card => {
      let cardProse = 0;
      for (const p of card.querySelectorAll('p, [role="paragraph"]')) {
        if (!p.closest(EXCLUDE_CARD_ANCESTORS)) {
          cardProse += p.textContent.trim().length;
        }
      }
      return cardProse >= 500;
    });
    if (hasSubstantialCard) return false;
    const ps = Array.from(root.querySelectorAll('p, [role="paragraph"]'))
      .filter(p => !p.closest(EXCLUDE_CARD_ANCESTORS));
    return !ps.some(p => p.textContent.trim().length > 240);
  }

  /**
   * Detect if the current page is an article (not a homepage/listing/category page)
   * Uses multiple heuristics similar to Safari Reader
   */
  async function isArticlePage() {
    // Quick checks first

    // 1. Check URL patterns and multi-card teaser grids that indicate non-article pages
    const path = window.location.pathname;
    if (path === '/' || path === '') {
      // Homepage
      return false;
    }
    if (isMultiCardFeed()) {
      return false;
    }

    // 2. Check for article-like DOM structure
    const article = document.querySelector('article');
    const mainContent = document.querySelector('main, [role="main"], .article, .post, .entry-content');

    // 3. Look for a single prominent heading (articles usually have one main h1)
    const h1Elements = document.querySelectorAll('h1');
    const hasSingleMainHeading = h1Elements.length >= 1 && h1Elements.length <= 3;

    // 4. Check paragraph density - articles have substantial paragraphs (including ARIA role="paragraph")
    const paragraphs = document.querySelectorAll('p, [role="paragraph"]');
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

    // Pages that declare themselves an article (og:type, article:published_time, JSON-LD, scholarly citation meta)
    // can be short, e.g. reviews, abstracts, and news briefs, so they get lower thresholds
    const declaredArticle = isDeclaredArticle();

    const hasSubstantialContent = declaredArticle
      ? totalTextLength > 500 && substantialParagraphs >= 2
      : totalTextLength > 2000 && substantialParagraphs > 3;
    const hasArticleStructure = (article || mainContent) && hasSingleMainHeading;
    const isNotListingPage = declaredArticle || !hasListingStructure || substantialParagraphs > 5;
    const minWords = declaredArticle ? 80 : 200;

    // Final check: try to extract with Readability and see if we get good content
    detectedArticle = null;
    if (hasSubstantialContent && isNotListingPage) {
      try {
        const extracted = extractArticle();
        if (extracted) {
          detectedArticle = extracted;
          return extracted.wordCount > minWords;
        }
      } catch (e) {
        console.warn('Readability check failed:', e);
      }
    }

    return false;
  }

  const ARTICLE_SCHEMA_TYPES = /^(\w*Article|BlogPosting|Review|Report)$/;
  const SCHOLARLY_SCHEMA_TYPES = /ScholarlyArticle/i;

  function isScholarlyPage(doc = document) {
    if (doc.querySelector('meta[name="citation_title"], meta[name="citation_doi"], meta[name="citation_pmid"], meta[name="dc.Identifier"], meta[name="DC.Identifier"]')) {
      return true;
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const node of nodes) {
          const types = [].concat(node && node['@type'] || []);
          if (types.some(type => SCHOLARLY_SCHEMA_TYPES.test(type))) return true;
        }
      } catch {
        // Malformed JSON-LD is common; ignore it
      }
    }
    return false;
  }

  /**
   * Check whether the page declares itself as a single article in its metadata.
   * Only the page's own top-level JSON-LD type counts: listing pages often embed
   * ItemLists of NewsArticle entries, which must not match.
   */
  function isDeclaredArticle() {
    if (isScholarlyPage(document)) return true;
    const ogType = document.querySelector('meta[property="og:type"]');
    if (ogType && ogType.getAttribute('content') === 'article') return true;
    if (document.querySelector('meta[property="article:published_time"]')) return true;

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const node of nodes) {
          const types = [].concat(node && node['@type'] || []);
          if (types.some(type => ARTICLE_SCHEMA_TYPES.test(type))) return true;
        }
      } catch {
        // Malformed JSON-LD is common; ignore it
      }
    }
    return false;
  }

  // Per-site auto-open, one choice for articles and one for link pages (homepage and
  // sections, shown as a TOC). "enabled" opens automatically, "disabled" was answered No or
  // switched off. "legacy" sites were saved before v1.4.0, when opening the reader once saved
  // the site: they still open automatically, but the reader asks once whether to keep that.
  // The legacy lists are filled once by background.js.
  const AUTO_OPEN_KEYS = {
    article: { enabled: 'readerEnabledOrigins', disabled: 'readerDisabledOrigins', legacy: 'readerLegacyOrigins' },
    toc: { enabled: 'tocEnabledOrigins', disabled: 'tocDisabledOrigins', legacy: 'tocLegacyOrigins' }
  };

  // 'enabled' | 'legacy' | 'disabled' | 'unknown' for this origin
  async function getAutoOpenState(kind) {
    const keys = AUTO_OPEN_KEYS[kind];
    const origin = window.location.origin;
    const result = await browserAPI.storage.local.get([keys.enabled, keys.disabled, keys.legacy]);
    if ((result[keys.enabled] || []).includes(origin)) {
      return (result[keys.legacy] || []).includes(origin) ? 'legacy' : 'enabled';
    }
    if ((result[keys.disabled] || []).includes(origin)) return 'disabled';
    return 'unknown';
  }

  /**
   * Save a Yes/No for this origin: the auto-open question or a Settings switch.
   * Opening the reader never does this by itself (issue #3).
   */
  async function setAutoOpen(kind, on) {
    const keys = AUTO_OPEN_KEYS[kind];
    const origin = window.location.origin;
    try {
      const result = await browserAPI.storage.local.get([keys.enabled, keys.disabled, keys.legacy]);
      const without = list => (list || []).filter(o => o !== origin);
      const enabled = without(result[keys.enabled]);
      const disabled = without(result[keys.disabled]);
      (on ? enabled : disabled).push(origin);
      await browserAPI.storage.local.set({
        [keys.enabled]: enabled,
        [keys.disabled]: disabled,
        [keys.legacy]: without(result[keys.legacy])
      });
    } catch (e) {
      console.warn('Failed to save auto-open choice:', e);
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
        await activateListingMode();
        // No list of links found: try article mode anyway
        if (!isReaderActive) activateReaderMode();
      }
    }
  }

  /**
   * Activate reader mode - extract article and show overlay
   */
  async function activateReaderMode() {
    if (isReaderActive) return;

    try {
      // Extract article (reuse the parse from article detection if it was for this URL)
      const detected = detectedArticle;
      detectedArticle = null;
      articleData = (detected && detected.sourceUrl === window.location.href)
        ? detected
        : extractArticle();

      if (!articleData) {
        console.warn('Could not extract article from this page');
        showNotification('Could not extract article from this page');
        return;
      }

      // Create and show reader overlay
      await createReaderOverlay();
      isReaderActive = true;
      updateFloatingButtonVisibility();
      lastPageFingerprint = pageFingerprint();

      await askAutoOpenOnce('article');

    } catch (error) {
      console.error('Failed to activate reader mode:', error);
      showNotification('Failed to activate reader mode');
    }
  }

  // Which choice the open question is about ('article' | 'toc'), for its Yes/No buttons
  let autoOpenPromptKind = null;

  /**
   * Ask whether this site should open automatically, about what is on screen: an article
   * asks about articles, the TOC about link pages. Not asked once answered. Legacy sites
   * (saved before v1.4.0) already open automatically and are asked whether to keep that.
   * Leaving the question unanswered changes nothing; it comes back next time.
   */
  async function askAutoOpenOnce(kind) {
    const elements = window.__einkReaderElements;
    if (!elements || !elements.autoOpenPrompt) return;
    try {
      const state = await getAutoOpenState(kind);
      if (state === 'enabled' || state === 'disabled') return;
      if (!isReaderActive) return;
      const site = window.location.hostname.replace(/^www\./, '');
      const what = kind === 'toc' ? 'the homepage and section pages of' : 'articles on';
      const verb = state === 'legacy' ? 'Keep opening' : 'Open';
      elements.autoOpenQuestion.textContent = `${verb} ${what} ${site} in InkPages automatically?`;
      autoOpenPromptKind = kind;
      elements.autoOpenPrompt.classList.remove('hidden');
    } catch (e) {
      console.warn('Failed to read auto-open state:', e);
    }
  }

  function hideAutoOpenPrompt() {
    autoOpenPromptKind = null;
    const elements = window.__einkReaderElements;
    if (elements && elements.autoOpenPrompt) elements.autoOpenPrompt.classList.add('hidden');
  }

  /**
   * Activate listing/TOC mode - show clean links view
   */
  async function activateListingMode() {
    if (isReaderActive) return;

    detectedArticle = null;

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
      updateFloatingButtonVisibility();
      lastPageFingerprint = pageFingerprint();

      await askAutoOpenOnce('toc');

    } catch (error) {
      console.error('Failed to activate listing mode:', error);
    }
  }

  /**
   * Deactivate reader mode - hide overlay and restore page
   */
  async function deactivateReaderMode() {
    if (!isReaderActive) return;

    // Leave fullscreen with the reader (the host is the fullscreen element, not the page)
    if (isReaderFullscreen()) {
      document.exitFullscreen().catch(() => {});
    }
    fullscreenUserExited = false;

    if (readerOverlay) {
      readerOverlay.style.display = 'none';
    }
    if (readerDialog && readerDialog.open) {
      try {
        readerDialog.close();
      } catch (e) {
        readerDialog.removeAttribute('open');
      }
    }

    // Leave the title alone if the site changed it meanwhile (client-side navigation)
    if (document.title === readerTitle) document.title = originalTitle;
    readerTitle = null;
    document.body.style.overflow = '';
    isReaderActive = false;
    isListingMode = false;
    updateFloatingButtonVisibility();
    hideAutoOpenPrompt();

    // Closing only hides the reader for this page; the site stays remembered.
    // Auto-open is turned off for a site with the switches in Settings → Behavior.
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

    // Remove script and style elements (Readability should have done this, but double-check)
    doc.body.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    // Remove forms and form elements
    doc.body.querySelectorAll('form, input, button, select, textarea').forEach(el => el.remove());

    // Remove iframes, objects, embeds
    doc.body.querySelectorAll('iframe, object, embed, applet, frame, frameset').forEach(el => el.remove());

    // Remove elements that can change navigation or rewrite attributes (SVG <set>/<animate> can set href)
    doc.body.querySelectorAll('base, meta, link, set, animate').forEach(el => el.remove());

    // Unwrap the page's web components (MDN's <interactive-example>): the reader lives in the
    // page, so the page's scripts would bring them back to life inside it, as empty widgets
    // with their own buttons. Their children (server-rendered content) stay. <p is="..."> is a
    // component too; serializing keeps an element's "is" even without the attribute, so it
    // becomes a plain copy
    doc.body.querySelectorAll('*').forEach(el => {
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
      if (el.localName.includes('-')) {
        el.replaceWith(...el.childNodes);
      } else if (el.hasAttribute('is')) {
        const plain = doc.createElement(el.localName);
        for (const attr of el.attributes) {
          if (attr.name !== 'is') plain.setAttribute(attr.name, attr.value);
        }
        plain.append(...el.childNodes);
        el.replaceWith(plain);
      }
    });

    doc.body.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();

        // Remove every inline event handler (onclick, onpointerdown, ontoggle, ...)
        // ... and the notes annotateClone() left for restoreDropped()
        if (name.startsWith('on') || name === 'srcdoc' || name.startsWith('data-inkpages-')) {
          el.removeAttribute(attr.name);
          continue;
        }

        // Only allow safe URL schemes; data: only for media sources (base64 images)
        if (URL_ATTRIBUTES.includes(name)) {
          const allowData = name === 'src' || name === 'poster';
          if (!isSafeUrl(attr.value, allowData)) {
            el.removeAttribute(attr.name);
          }
        }
      }
    });

    return doc.body.innerHTML;
  }

  const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'cite'];
  const SAFE_URL_PROTOCOLS = ['http:', 'https:', 'mailto:'];

  /**
   * Check a URL attribute value against the allowed schemes.
   * Parsing with URL normalises tricks like "java\tscript:" the same way the browser would.
   */
  function isSafeUrl(value, allowData) {
    try {
      const protocol = new URL(value, document.baseURI).protocol;
      return SAFE_URL_PROTOCOLS.includes(protocol) || (allowData && protocol === 'data:');
    } catch {
      return false;
    }
  }

  // Internal annotations stamped on the Readability clone before extraction; sanitizeHTML() removes them
  const NOTE_ID = 'data-inkpages-n';
  const NOTE_HIDDEN = 'data-inkpages-hidden';
  const NOTE_BOLD = 'data-inkpages-bold';
  const ADDED_BOLD = 'data-inkpages-b';
  const NOTE_COL = 'data-inkpages-col';
  const NOTE_PROSE_STYLE = 'data-inkpages-prose';
  const NOTE_LEAD_BAND = 'data-inkpages-lead';
  const NOTE_TOP = 'data-inkpages-top';
  const NOTE_UNFOLDED = 'data-inkpages-unfolded';
  const NO_ACCORDION_UNFOLD = /(?:^|[^a-z])(paywall|locked|metered|subscri|modal|dialog|popup|cookie|consent|author|affil|loa|citation|share|qrcode|menu|nav|secondary|comment|promo|newsletter|temptation|offer|purchase)(?:[^a-z]|$)/i;

  const BLOCK_ELEMENTS = 'p,div,ul,ol,li,dl,table,h1,h2,h3,h4,h5,h6,blockquote,pre,figure,section,article,header,footer,nav,aside,form,hr';
  const NO_BOLD_NOTE = 'h1,h2,h3,h4,h5,h6,b,strong,th,td,dt,a,button,label,summary,nav,footer,header,figcaption,caption,pre,code,cite,time,sup,sub,select,textarea,script,style,noscript,svg';
  const NO_BOLD_CONTAINERS = /(?:^|[^a-z])(author|byline|contributor|correspond|reference|ref-list|biblio|citation|figure|figcaption|caption|access|license|recommended|related|promo|newsletter)(?:[^a-z]|$)/i;
  const NEVER_HIDE_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|BR|WBR|HR|SOURCE|TRACK|PICTURE|IMG|SVG|PATH|G|DEFS|CLIPPATH|LINEARGRADIENT|STOP|USE|SYMBOL|MATH|COL|COLGROUP|TBODY|THEAD|TFOOT|TR|TD|TH|OPTION|OPTGROUP|DATALIST|PARAM)$/i;

  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function linkDensity(el) {
    const t = normText(el.textContent);
    if (!t) return 0;
    let linked = 0;
    el.querySelectorAll('a').forEach(a => { linked += normText(a.textContent).length; });
    return linked / t.length;
  }

  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()) return true;
    }
    return false;
  }

  /**
   * Detect the primary visible reading column and stamp live layout/visibility/style
   * annotations onto the clone before Readability parses, without mutating the live DOM.
   */
  function analyzePageAndAnnotateClone(clone) {
    if (!document.body || !clone.body) return null;
    const originals = Array.from(document.body.querySelectorAll('*'));
    const copies = Array.from(clone.body.querySelectorAll('*'));
    if (originals.length !== copies.length) return null;

    const copyOf = new Map();
    const styleCache = new Map();
    const rectCache = new Map();
    const getCS = (el) => {
      let cs = styleCache.get(el);
      if (!cs) { cs = getComputedStyle(el); styleCache.set(el, cs); }
      return cs;
    };
    const getRect = (el) => {
      let r = rectCache.get(el);
      if (!r) { r = el.getBoundingClientRect(); rectCache.set(el, r); }
      return r;
    };

    originals.forEach((el, i) => copyOf.set(el, copies[i]));
    const vw = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
    const sx = window.scrollX || 0;
    const phrasingOnly = (el) => el.querySelector(BLOCK_ELEMENTS) === null;
    const inNoBoldContainer = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const names = (typeof n.className === 'string' ? n.className : '') + ' ' + (n.id || '');
        if (names.trim() && NO_BOLD_CONTAINERS.test(names)) return true;
      }
      return false;
    };

    // Unfold collapsed mobile article accordions and <details> inside article/main without touching paywalls or chrome drawers
    const unfoldedPanels = new Set();
    const insideUnfolded = new Set();
    const unfoldedAncestors = new Set();
    const elAttrText = (el) => [
      typeof el.className === 'string' ? el.className : '',
      el.id || '',
      el.getAttribute('data-test-id') || '',
      el.getAttribute('data-testid') || ''
    ].join(' ');
    const hasSubstantialProse = (node) =>
      normText(node.textContent).length >= 500 &&
      linkDensity(node) < 0.25 &&
      Array.from(node.querySelectorAll('p, [role="paragraph"]')).filter(p => normText(p.textContent).length >= 120).length >= 2;

    const rawPanels = [];
    for (const el of originals) {
      if (!/^(SECTION|DIV|DETAILS)$/.test(el.tagName)) continue;
      const mainRoot = el.closest('article, main, [role="main"]');
      if (!mainRoot) continue;
      if (el.closest('nav, header, footer, aside, dialog, form, [role="navigation"], [role="complementary"], [role="dialog"], [aria-modal="true"], [hidden], [aria-hidden="true"]')) continue;
      let blocked = false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (NO_ACCORDION_UNFOLD.test(elAttrText(n))) { blocked = true; break; }
        if (n === mainRoot) break;
      }
      if (blocked) continue;
      const isClosedDetails = el.tagName === 'DETAILS' && !el.open;
      const cs = getCS(el);
      const prev = el.previousElementSibling;
      const hasAccordionCue = /\b(accordion|collapsible|collapse)\b/i.test(
        (typeof el.className === 'string' ? el.className : '') + ' ' +
        (el.parentElement && typeof el.parentElement.className === 'string' ? el.parentElement.className : '')
      ) || Boolean(prev && prev.matches('button, summary, a[class*="expand" i], a[class*="toggle" i], a[class*="accordion" i], [aria-expanded="false"]'));
      if (!isClosedDetails && !(cs.display === 'none' && hasAccordionCue)) continue;
      rawPanels.push(el);
    }
    for (const el of rawPanels) {
      let accept = hasSubstantialProse(el);
      if (!accept && el.parentElement && el.parentElement.parentElement &&
          /^(UL|OL|DIV|ARTICLE|MAIN|SECTION)$/.test(el.parentElement.parentElement.tagName) &&
          normText(el.textContent).length >= 300) {
        accept = Array.from(el.parentElement.parentElement.children).some(
          sib => sib !== el.parentElement && hasSubstantialProse(sib)
        );
      }
      if (!accept) continue;
      unfoldedPanels.add(el);
      const cp = copyOf.get(el);
      if (cp) cp.setAttribute(NOTE_UNFOLDED, '');
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) unfoldedAncestors.add(n);
      const walkDesc = (node) => {
        if (node !== el && ((node.hasAttribute && node.hasAttribute('hidden') && node.getAttribute('hidden') !== 'until-found') ||
            (node.getAttribute && node.getAttribute('aria-hidden') === 'true') ||
            (node.matches && node.matches('.sr-only, .visually-hidden, .visuallyhidden, .screen-reader-text')) ||
            (node.tagName && NO_ACCORDION_UNFOLD.test(elAttrText(node))))) {
          return;
        }
        insideUnfolded.add(node);
        for (const ch of node.children || []) walkDesc(ch);
      };
      walkDesc(el);
    }

    const isVisuallyHiddenRaw = (el, cs, r) => {
      if (el.closest('[hidden="until-found"]') || insideUnfolded.has(el)) return false;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
      const hasMedia = el.matches('img,picture,svg,video,canvas,math') || !!el.querySelector('img,picture,svg,video,canvas,math');
      if (!hasMedia && parseFloat(cs.fontSize) === 0) return true;
      if (cs.opacity === '0' && !hasMedia && (r.height < 80 || el.matches('button,nav,aside,dialog,[role="dialog"],[aria-hidden="true"]'))) return true;
      const fixed = cs.position === 'fixed' || cs.position === 'sticky';
      const docLeft = fixed ? r.left : r.left + sx;
      const docRight = fixed ? r.right : r.right + sx;
      if ((r.width > 0 || cs.position === 'absolute' || fixed) &&
          (docRight <= 0 || (docLeft >= vw + 20 && !el.closest('table, pre, code, math')))) {
        return true;
      }
      if (!hasMedia) {
        if (cs.clip === 'rect(0px, 0px, 0px, 0px)' ||
            /inset\(\s*(?:50%|100%)|circle\(\s*0(?:px|%)?|polygon\(\s*0(?:px|%)?\s+0/.test(cs.clipPath || '')) {
          return true;
        }
        const ovClip = cs.overflow === 'hidden' || cs.overflow === 'clip' || (cs.overflowX === 'hidden' && cs.overflowY === 'hidden');
        if (ovClip && (r.width <= 2 || r.height <= 2)) return true;
        if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && r.height <= 2 && parseFloat(cs.maxHeight) === 0) return true;
      }
      return false;
    };

    // 1. Identify primary reading column via weighted clustering over visible prose blocks
    const proseCandidates = [];
    for (const el of originals) {
      if (!(el.tagName === 'P' || el.getAttribute('role') === 'paragraph')) continue;
      if (el.closest('nav, header, footer, aside, form, dialog, [role="navigation"], [role="complementary"], [role="dialog"], [aria-modal="true"], [hidden], [aria-hidden="true"]')) continue;
      const txt = normText(el.textContent);
      if (txt.length < 120 || linkDensity(el) >= 0.35) continue;
      const cs = getCS(el);
      const r = getRect(el);
      if (r.width < 160 || r.height < 12 || isVisuallyHiddenRaw(el, cs, r)) continue;
      let fixedAnc = false;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const pcs = getCS(p);
        if (pcs.position === 'fixed' || pcs.position === 'sticky') { fixedAnc = true; break; }
      }
      if (!fixedAnc) proseCandidates.push({ el, left: Math.round(r.left), right: Math.round(r.right), top: r.top, bottom: r.bottom, weight: Math.min(txt.length, 800), fs: parseFloat(cs.fontSize) || 16 });
    }

    let col = null;
    if (proseCandidates.length) {
      const clusters = [];
      for (const item of proseCandidates) {
        const mid = (item.left + item.right) / 2;
        const w = item.right - item.left;
        let match = clusters.find(c => {
          const ov = Math.min(item.right, c.right) - Math.max(item.left, c.left);
          const minW = Math.min(w, c.right - c.left);
          return Math.abs(mid - (c.left + c.right) / 2) <= 90 && (minW > 0 && ov / minW >= 0.55);
        });
        if (!match) {
          match = { left: item.left, right: item.right, items: [], score: 0 };
          clusters.push(match);
        }
        match.items.push(item);
        match.score += item.weight * (w >= 260 ? 1 : 0.3);
        // Track median bounds dynamically on cluster push later
        match.left = Math.min(match.left, item.left);
        match.right = Math.max(match.right, item.right);
      }
      clusters.sort((a, b) => b.score - a.score);
      const best = clusters[0];
      const lefts = best.items.map(i => i.left).sort((a, b) => a - b);
      const rights = best.items.map(i => i.right).sort((a, b) => a - b);
      const sizes = best.items.map(i => i.fs).sort((a, b) => a - b);
      const tops = best.items.map(i => i.top).sort((a, b) => a - b);
      const m = Math.floor(best.items.length / 2);
      col = {
        left: lefts[m],
        right: rights[m],
        width: rights[m] - lefts[m],
        bodyFontSize: sizes[m] || 16,
        firstTop: tops[0],
        items: best.items
      };
    }

    const ancestorsOfProse = new Set();
    if (col) {
      for (const item of col.items) {
        for (let n = item.el; n && n !== document.documentElement; n = n.parentElement) {
          ancestorsOfProse.add(n);
        }
      }
    }

    const h1 = document.querySelector('article h1, main h1, [role="main"] h1, h1');
    const h1Rect = h1 && !isVisuallyHiddenRaw(h1, getCS(h1), getRect(h1)) ? getRect(h1) : null;
    if (h1Rect && clone.body) {
      clone.body.setAttribute('data-inkpages-h1-bottom', String(Math.round(h1Rect.bottom)));
    }
    const protectedAncestors = new Set([...ancestorsOfProse, ...unfoldedAncestors]);
    if (h1) {
      for (let n = h1; n && n !== document.documentElement; n = n.parentElement) {
        protectedAncestors.add(n);
      }
    }

    const bodyBg = getCS(document.body).backgroundColor;
    const inStyledCallout = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        if (ancestorsOfProse.has(n) || n.matches('article, main, section, blockquote')) break;
        if (!/^(DIV|ASIDE)$/.test(n.tagName)) continue;
        if (normText(n.textContent).length >= 500) continue;
        const ncs = getCS(n);
        const bg = ncs.backgroundColor;
        const hasDistinctBg = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)' && bg !== bodyBg;
        const hasLeftAccent = parseFloat(ncs.borderLeftWidth) >= 3 && ncs.borderLeftStyle !== 'none';
        if (hasDistinctBg || hasLeftAccent) return true;
      }
      return false;
    };

    const hideCopy = (copy) => {
      if (!copy) return;
      copy.setAttribute('hidden', '');
      copy.setAttribute(NOTE_HIDDEN, '');
    };

    // 2. Single-pass Rule 1 (visibility), Rule 2 (geometric/functional chrome), and block/bold annotations
    for (let i = 0; i < originals.length; i++) {
      const el = originals[i];
      const copy = copies[i];
      if (!copy || copy.tagName !== el.tagName) continue;
      if (NEVER_HIDE_TAGS.test(el.tagName)) continue;

      const cs = getCS(el);
      const r = getRect(el);
      const protectedEl = ancestorsOfProse.has(el);
      const ancestorProtected = protectedAncestors.has(el) || (h1 && h1.contains(el));

      let hidden = !protectedEl && isVisuallyHiddenRaw(el, cs, r);

      // Rule 2: Geometric & functional non-article chrome (never hide protected prose/h1 ancestors)
      if (!hidden && !ancestorProtected) {
        // 2.1 Fixed/sticky widgets & explicit ARIA UI chrome (dialogs, nav, toolbars, banner, search)
        if (cs.position === 'fixed' || cs.position === 'sticky' ||
            el.matches('dialog, nav, [role="dialog"], [aria-modal="true"], [role="toolbar"], [role="navigation"], [role="search"], [role="banner"], [role="contentinfo"]')) {
          hidden = true;
        }
        // 2.2 Off-column horizontal sidebars / rails outside the main prose column
        else if (col && col.width < vw * 0.82 && r.width > 20 && r.height > 20 &&
                 (r.right <= col.left + 8 || r.left >= col.right - 8)) {
          const isFigure = el.matches('figure') && el.querySelector('img, svg') && linkDensity(el) < 0.35;
          const isByline = el.matches('address, [rel="author"], [itemprop="author"]');
          if (!isFigure && !isByline) hidden = true;
        }
        // 2.3 Horizontal scroll strips / overflowing carousels (preserving real tables, pre, code, math)
        else if (/^(DIV|SECTION|ASIDE|UL|OL|NAV)$/.test(el.tagName) && !el.querySelector('table, pre, code, math')) {
          const scrollCarousel = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 40;
          const clippedCarousel = (cs.overflowX === 'hidden' || cs.overflowX === 'clip') &&
                                  el.scrollWidth > el.clientWidth * 1.5 && el.clientWidth > 150 &&
                                  el.querySelectorAll('li, a[href]').length >= 3;
          if (scrollCarousel || clippedCarousel) {
            hidden = true;
            // Also hide an immediately preceding orphan label (e.g. standalone carousel title without links/prose)
            const prev = el.previousElementSibling;
            if (prev && !prev.querySelector('p, article, img, figure, a[href]') && normText(prev.textContent).length <= 30) {
              hideCopy(copyOf.get(prev));
            }
          }
        }
        // 2.4 In-page #fragment jump lists
        if (!hidden && /^(NAV|UL|OL|DIV|SECTION|ASIDE)$/.test(el.tagName)) {
          const t = normText(el.textContent);
          if (t && t.length < 1500) {
            const links = el.querySelectorAll('a[href]');
            if (links.length >= 3 && links.length <= 60) {
              let fragCount = 0;
              let linkChars = 0;
              links.forEach(a => {
                const href = a.getAttribute('href') || '';
                if (href.startsWith('#') || (href.includes('#') && href.split('#')[0] === location.href.split('#')[0])) fragCount++;
                linkChars += normText(a.textContent).length;
              });
              if (fragCount / links.length >= 0.7 && linkChars / t.length >= 0.45) hidden = true;
            }
          }
        }
      }

      if (hidden) {
        hideCopy(copy);
      }

      // Block-level annotations for visual stitching & Readability fallback
      const isBlock = /^(P|H[2-6]|LI|PRE|FIGURE|TABLE|BLOCKQUOTE)$/.test(el.tagName) || el.getAttribute('role') === 'paragraph';
      if (isBlock) {
        copy.setAttribute(NOTE_ID, i);
        const inFolded = insideUnfolded.has(el) || Boolean(el.closest('[hidden="until-found"]'));
        if (hidden || (!el.getClientRects().length && !inFolded)) {
          copy.setAttribute(NOTE_HIDDEN, '');
        } else {
          copy.setAttribute(NOTE_TOP, String(Math.round(r.top)));
          if (col && r.width > 60) {
            const ov = Math.min(r.right, col.right) - Math.max(r.left, col.left);
            const minW = Math.min(r.width, col.width);
            if (ov >= 0.5 * minW && r.left >= col.left - 80 && r.right <= col.right + 80) {
              copy.setAttribute(NOTE_COL, '');
              const fs = parseFloat(cs.fontSize) || 16;
              if (!inStyledCallout(el) && fs >= col.bodyFontSize * 0.88) {
                copy.setAttribute(NOTE_PROSE_STYLE, '');
              }
              if (h1Rect && r.top >= h1Rect.bottom - 15 && r.top <= col.firstTop + 15 && fs >= col.bodyFontSize * 0.90) {
                copy.setAttribute(NOTE_LEAD_BAND, '');
              }
            }
          }
        }
      }

      if (hidden) continue;

      // Computed CSS bold annotation (> 2 chars, skipping drop-caps, timestamps, metadata, refs, and figures; applied post-Readability)
      const weight = parseInt(cs.fontWeight, 10) || 400;
      if (!hasDirectText(el) || el.closest(NO_BOLD_NOTE) || !phrasingOnly(el) || weight < 600 || inNoBoldContainer(el) || el.querySelector('time')) continue;

      let target = el;
      for (let p = el.parentElement; p && p !== document.body && !p.matches(NO_BOLD_NOTE) && phrasingOnly(p) &&
           (parseInt(getCS(p).fontWeight, 10) || 400) >= 600 && !inNoBoldContainer(p) && !p.querySelector('time'); p = p.parentElement) {
        target = p;
      }
      if (normText(target.textContent).length <= 2) continue;
      const targetCopy = copyOf.get(target);
      if (targetCopy && targetCopy.tagName === target.tagName) targetCopy.setAttribute(NOTE_BOLD, '');
    }

    return { col, h1Rect };
  }

  function wrapBoldNotes(doc) {
    const owner = doc.ownerDocument || doc;
    doc.querySelectorAll('[' + NOTE_BOLD + ']').forEach(el => {
      if (el.tagName === 'B' || el.tagName === 'STRONG' || el.closest('b, strong, [' + ADDED_BOLD + ']')) return;
      const bold = owner.createElement('b');
      bold.setAttribute(ADDED_BOLD, '');
      bold.append(...el.childNodes);
      el.append(bold);
    });
  }

  const MEDIA_ACTION_TEXT = /^(open in (figure viewer|a? ?new tab)|view large(r image)?|full size( image| table)?|download:?|powerpoint|ppt|pptx|png|tiff?|pdf|csv|xlsx?|docx?|zip|click here for additional data file\.?)$/i;
  const MEDIA_ACTION_HREF = /download|powerpoint|openurl|figure-?viewer/i;

  /**
   * Generic pre-extraction DOM hygiene (zero site- or publisher-specific selectors).
   */
  function preprocessDOM(doc, scholarly = false) {
    // Collapsed sections openable via find-in-page (Wikipedia mobile) and unfolded body accordions become visible before parsing
    doc.querySelectorAll('[hidden="until-found"]').forEach(el => el.removeAttribute('hidden'));
    doc.querySelectorAll('[' + NOTE_UNFOLDED + ']').forEach(panel => {
      if (!panel.isConnected) return;
      if (panel.tagName === 'DETAILS') {
        panel.setAttribute('open', '');
        return;
      }
      const prev = panel.previousElementSibling;
      if (prev && /^(A|BUTTON|DIV|SPAN|SUMMARY)$/.test(prev.tagName) && !prev.querySelector('p, img, figure, table')) {
        const rawLabel = normText(prev.textContent).replace(/^(?:expand|collapse|show|hide|open)\s+/i, '').trim();
        if (rawLabel.length >= 3 && rawLabel.length <= 120) {
          const firstH = panel.querySelector('h1, h2, h3');
          if (!firstH || normText(firstH.textContent).toLowerCase() !== rawLabel.toLowerCase()) {
            const h2 = doc.createElement('h2');
            h2.textContent = rawLabel;
            panel.prepend(h2);
          }
          prev.remove();
        }
      }
      const li = panel.parentElement;
      if (li && li.tagName === 'LI' && li.parentElement && /^(UL|OL)$/.test(li.parentElement.tagName)) {
        li.parentElement.setAttribute('data-inkpages-unwrap-list', '');
      }
    });
    doc.querySelectorAll('[data-inkpages-unwrap-list]').forEach(list => {
      if (!list.isConnected) return;
      const wrapper = doc.createElement('div');
      Array.from(list.children).forEach(li => {
        if (li.tagName === 'LI') wrapper.append(...li.childNodes);
        else wrapper.appendChild(li);
      });
      list.replaceWith(wrapper);
    });

    // Normalise WAI-ARIA role="paragraph" elements to <p> so Readability scores them consistently
    doc.querySelectorAll('div[role="paragraph"], span[role="paragraph"]').forEach(el => {
      const p = doc.createElement('p');
      for (const attr of Array.from(el.attributes)) {
        if (attr.name !== 'role') p.setAttribute(attr.name, attr.value);
      }
      p.append(...el.childNodes);
      el.replaceWith(p);
    });

    const selectorsToRemove = [
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
      '.cookie-consent',
      '.cookie-notice',
      '.cookie-banner',
      '.consent-placeholder',
      '.gdpr-placeholder',
      '.embed-container:not(:has(iframe))',
      'iframe:not([src])',
      'iframe[src=""]',
      'iframe[src="about:blank"]',
      '.sr-only',
      '.visually-hidden',
      '.visuallyhidden',
      '.screen-reader-text',
      '[role="toolbar"]',
      'input[type="checkbox"]'
    ];

    selectorsToRemove.forEach(selector => {
      try {
        doc.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // Ignore unsupported CSS selectors
      }
    });

    // Remove generic media/download action links and toolbars inside figures/tables (or on scholarly articles)
    doc.querySelectorAll('a[href]').forEach(link => {
      if (!link.isConnected) return;
      const inMediaBox = !!link.closest('figure, table');
      if (!inMediaBox && !scholarly) return;
      const href = link.getAttribute('href') || '';
      const t = normText(link.textContent);
      const isAction = link.hasAttribute('download') ||
        (inMediaBox && href === '#' && t.length < 40) ||
        (MEDIA_ACTION_TEXT.test(t) && (href === '#' || MEDIA_ACTION_HREF.test(href) || !href.startsWith('http'))) ||
        (MEDIA_ACTION_HREF.test(href) && t.length < 45);
      if (!isAction) return;
      const hostBox = link.closest('div, ul, p, span');
      link.remove();
      if (hostBox && !hostBox.matches('figure, figcaption, table, td, th') &&
          !normText(hostBox.textContent).replace(/^download:?\s*/i, '') &&
          !hostBox.querySelector('img, svg')) {
        hostBox.remove();
      }
    });

    // Remove pre-prose author-bio mini-cards and standalone header timestamps on non-scholarly pages
    if (!scholarly) {
      doc.querySelectorAll('[rel="author"], [itemprop="author"], address').forEach(el => {
        if (!el.isConnected) return;
        let card = null;
        for (let n = el.parentElement; n && n !== doc.body; n = n.parentElement) {
          if (/^(MAIN|ARTICLE)$/.test(n.tagName) || n.getAttribute('role') === 'main') break;
          if (n.textContent.trim().length >= 350 || n.querySelector('h1, figure, main, article')) break;
          if (/^(DIV|ASIDE|HEADER|SECTION)$/.test(n.tagName)) {
            const ps = Array.from(n.querySelectorAll('p'));
            if (ps.length && ps.every(p => p.textContent.trim().length < 150)) card = n;
          }
        }
        if (card) card.remove();
      });

      const firstProse = Array.from(doc.querySelectorAll('p')).find(
        p => normText(p.textContent).length > 100 && !p.closest('header, nav, footer, aside, form')
      );
      if (firstProse) {
        doc.querySelectorAll('time').forEach(t => {
          if (t.closest('p, li, blockquote, figcaption')) return;
          if (normText(t.textContent).length >= 60) return;
          if (t.compareDocumentPosition(firstProse) & Node.DOCUMENT_POSITION_FOLLOWING) t.remove();
        });
      }
    }

    // Remove forms holding under half of page text (e.g. paywall purchase/login/newsletter forms)
    const pageTextLength = (doc.body && doc.body.textContent || '').length;
    doc.querySelectorAll('form').forEach(form => {
      if (form.textContent.length < pageTextLength * 0.5) form.remove();
    });

    removeSignInGates(doc);

    // Site logos: a link to "/" holding only an image/svg with no link text
    doc.querySelectorAll('a[href]').forEach(link => {
      if (link.textContent.trim() || !link.querySelector('img, svg, picture')) return;
      try {
        const url = new URL(link.getAttribute('href'), document.baseURI);
        if (url.pathname === '/' && !url.search) link.remove();
      } catch {
        // Ignore invalid URL
      }
    });

    // Strip inert HTML5 <video>/<audio> fallback notices
    doc.querySelectorAll('video, audio').forEach(media => media.replaceChildren());
    doc.querySelectorAll('p, div, span').forEach(el => {
      if (!el.isConnected || el.querySelector('img, figure, table')) return;
      const t = normText(el.textContent);
      if (t && t.length < 240 && /^to view this (?:video|audio) please enable javascript\b/i.test(t)) {
        el.remove();
      }
    });

    // Multi-language cookie/social-embed consent placeholders and self-contained CTA/follow promo cards
    if (!scholarly) {
      doc.querySelectorAll('div, aside, section').forEach(el => {
        if (!el.isConnected || el.closest('blockquote, figure')) return;
        const t = normText(el.textContent);
        if (!t || t.length >= 500) return;
        if (el.querySelector('article, main, img, picture, figure, video, table, pre, code, blockquote')) return;
        const h = el.querySelector('h2, h3, h4, h5');
        if (!h) return;
        const ps = Array.from(el.querySelectorAll('p'));
        const pTexts = ps.map(p => normText(p.textContent));
        if (!ps.length || ps.length > 2 || pTexts.every(pt => pt.length < 25) || pTexts.some(pt => pt.length >= 240)) return;
        const links = Array.from(el.querySelectorAll('a[href]'));
        if (!links.length || links.length > 3) return;
        const lastP = ps[ps.length - 1];
        const ctaAfterProse = links.every(a =>
          !a.closest('p') &&
          (lastP.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (a.matches('[role="button"], [class*="button" i], [class*="btn" i], [class*="cta" i]') ||
           Boolean(a.closest('[class*="button" i], [class*="btn" i], [class*="cta" i]')))
        );
        if (!ctaAfterProse) return;
        const hasPromoAttr = [el, ...el.querySelectorAll('*')].some(n => {
          const attrs = [
            typeof n.className === 'string' ? n.className : '',
            n.id || '',
            n.getAttribute('data-testid') || '',
            n.getAttribute('data-component') || ''
          ].join(' ');
          return /\b(follow|promo|cta|newsletter|subscribe)\b/i.test(attrs) || /(?:follow|promo|cta|newsletter|subscribe)-box/i.test(attrs);
        });
        if (hasPromoAttr || el.querySelector('button')) el.remove();
      });
    }

    const consentPatterns = [
      /cookie[s]?.*(?:accepte|toestemming|consent|akzeptieren|accetta)/i,
      /(?:accepte|toestemming|consent|akzeptieren|accetta).*cookie/i,
      /sociale?\s*media.*(?:cookie|consent|toestemming)/i,
      /(?:twitter|facebook|instagram|tiktok).*(?:cookie|consent|toestemming)/i,
      /om\s+(?:deze|u|je)\s+content.*cookie/i,
      /pour\s+afficher\s+ce\s+contenu/i,
      /um\s+diesen\s+inhalt.*cookie/i
    ];
    doc.querySelectorAll('div, aside, section, figure').forEach(el => {
      const text = el.textContent || '';
      if (text.length < 1000 && consentPatterns.some(pat => pat.test(text))) {
        el.remove();
      }
    });

    return doc;
  }

  const GATE_HREF = /sign-?in|log-?in|register|registr|sign-?up|subscri|abonne|account|profile|inloggen|anmeld|connexion/i;
  const GATE_LINK_TEXT = /\b(sign(ed)? ?in|log ?in|create (an|a free|your) account|register|subscribe|sign ?up|inloggen|registreer|abonneer|word abonnee|account aanmaken|anmelden|registrieren|abonnieren|se connecter|s'abonner|abonnez|créer un compte|s'inscrire)\b/i;

  function removeSignInGates(doc) {
    const hasProseSiblings = (el) => {
      const parent = el.parentElement;
      if (!parent) return false;
      let prose = 0;
      for (const child of parent.children) {
        if (child !== el && child.tagName === 'P' && child.textContent.trim().length >= 100) prose++;
      }
      return prose >= 2;
    };
    const looksLikeBox = (el) =>
      el.querySelector('h2, h3, h4, h5, h6, button') !== null || el.querySelectorAll('a[href]').length >= 2;

    doc.querySelectorAll('a[href]').forEach(link => {
      if (!link.isConnected) return;
      if (!GATE_HREF.test(link.getAttribute('href')) || !GATE_LINK_TEXT.test(link.textContent)) return;
      let gate = null;
      for (let el = link.parentElement; el && el !== doc.body; el = el.parentElement) {
        if (el.textContent.length > 1500) break;
        if (/^(DIV|ASIDE|SECTION)$/.test(el.tagName) && looksLikeBox(el) && hasProseSiblings(el)) gate = el;
      }
      if (gate) gate.remove();
    });
  }

  /**
   * Copy <pre> blocks out of closed/open component shadow roots before preprocessDOM alters nodes.
   */
  function copyShadowCodeBlocks(clone) {
    if (!document.body || !clone.body) return;
    const originals = Array.from(document.body.querySelectorAll('*'));
    const copies = Array.from(clone.body.querySelectorAll('*'));
    if (originals.length !== copies.length) return;

    const shadowCode = (root) => {
      const found = Array.from(root.querySelectorAll('pre'));
      root.querySelectorAll('*').forEach(el => {
        const inner = el.openOrClosedShadowRoot || el.shadowRoot;
        if (inner) found.push(...shadowCode(inner));
      });
      return found;
    };

    originals.forEach((host, i) => {
      const root = host.openOrClosedShadowRoot || host.shadowRoot;
      const copy = copies[i];
      if (!root || copy.localName !== host.localName || host.querySelector('pre')) return;
      const code = shadowCode(root);
      if (code.length) copy.replaceWith(...code.map(pre => pre.cloneNode(true)), ...copy.childNodes);
    });
  }

  const RESTORE_UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|newsletter|promo|share|affil|author|byline|correspond|bibliog|reference|suppl|appendix|funding|conflict|competing|disclos|acknowledge?ment|metric|citation|license|copyright|callout|read-?more|lees-?ook|interstitial|recommend|most-?(read|popular|viewed)/i;
  const RESTORE_NEVER_INSIDE = 'nav,aside,footer,figure,figcaption,a,button,form,noscript,address,table,blockquote,[hidden],[aria-hidden="true"]';
  const LEDE_NAME = /standfirst|lede|\bdek\b|\bdeck\b|sub-?head|sub-?title|intro|chapeau|excerpt|strapline|\blead\b/i;
  const LEDE_NOT = /author|byline|\bbio\b|affil|correspond|caption|credit|meta|date|\btags?\b|share|social|related|newsletter|promo|subscri|paywall|consent|cookie|comment|breadcrumb/i;
  const LEDE_UNLIKELY = /banner|breadcrumbs|comment|community|disqus|extra|footer|gdpr|menu|related|replies|rss|sidebar|social|sponsor|ad-break|agegate|pagination|pager|popup|newsletter|promo|share|cookie|consent|paywall|author|byline|affil|correspond/i;

  const ABSTRACT_HEADING = /^(abstract|structured abstract|summary|author summary|significance|key points)$/i;
  const SCHOLARLY_CORE_HEADING = /^(abstract|structured abstract|summary|author summary|significance|highlights|main|main text|introduction|background|(?:\d+(?:\.\d+)*\.?\s+)(?:abstract|introduction|background|main|results))$/i;
  const SCHOLARLY_BACKMATTER_HEADING = /^(references|references and notes|literature cited|cited literature|bibliography|abbreviations|list of abbreviations|supporting information|supplementary (information|materials?|data|figures?|tables?|files?)|associated data|data (and materials? )?availability( statement)?|code availability|funding( statement| information)?|grant support|conflicts? of interest( statement)?|competing interests?( statement)?|declaration of interests?|ethics statement|ethical approval|ethics declarations?|reporting summary|peer review( information)?|additional information|rights and permissions|about this article|cite this article|statements?|generative ai( statement)?|publisher[’']?s\s+note|extended data( figures and tables)?|author contributions?|contributions|acknowledge?ments?|contributor information|authors?'? information|recommended|related( articles?)?|similar articles|cited by|article (information|metrics)|publication types|mesh terms|substances|open research|figures|information|affiliations|linkout\s*[-–]\s*more resources|full text sources|other literature sources)$/i;
  const SCHOLARLY_KEEP_HEADING = /^(abstract|structured abstract|author summary|main|main text|introduction|background|results|findings|discussion|conclusions?|methods|materials and methods|experimental procedures?)$/i;
  const METADATA_PREFIX = /^(citation|academic editor|section editor|handling editor|editor|reviewed by|received|accepted|published( online)?|first published|copyright|license|permissions|funding|competing interests?|conflicts? of interest|data availability|code availability|keywords?|abbreviations?|correspondence|corresponding authors?)\s*:/i;

  /**
   * Stage 3: Visually stitch detached abstracts, lead standfirsts, and dropped same-column prose blocks.
   */
  function stitchVisualColumn(out, pristine, title, description, scholarly) {
    if (!pristine) return;
    const id = (el) => el.getAttribute(NOTE_ID);
    const outOf = new Map();
    out.body.querySelectorAll('[' + NOTE_ID + ']').forEach(el => outOf.set(id(el), el));
    const all = Array.from(pristine.querySelectorAll('[' + NOTE_ID + ']'));
    const firstKept = all.findIndex(el => outOf.has(id(el)));

    const isUsable = (el, top, isLead, maxLD) => {
      if (el.hasAttribute(NOTE_HIDDEN)) return false;
      const text = normText(el.textContent);
      if (!text) return false;
      if (linkDensity(el) > maxLD) return false;
      if (el.closest(RESTORE_NEVER_INSIDE)) return false;
      const boundary = el.closest('article, main, [role="main"]') || top;
      for (let n = el; n && n !== top; n = n.parentElement) {
        const names = (typeof n.className === 'string' ? n.className : '') + ' ' + (n.id || '');
        if (isLead ? LEDE_UNLIKELY.test(names) : RESTORE_UNLIKELY.test(names)) return false;
        if (n === boundary) break;
      }
      return true;
    };

    const sanitizeRestored = (el) => {
      const copy = out.importNode(el, true);
      [copy, ...copy.querySelectorAll('*')].forEach(n => {
        const keepCaps = ['caption', 'figcaption'].filter(c => n.classList && n.classList.contains(c));
        n.removeAttribute('class');
        if (keepCaps.length) n.setAttribute('class', keepCaps.join(' '));
        n.removeAttribute('style');
        n.removeAttribute('id');
      });
      return copy;
    };

    const anchorOf = (el) => {
      while (el.parentElement && el.parentElement !== out.body &&
             !/^(DIV|SECTION|ARTICLE|MAIN)$/.test(el.parentElement.tagName)) {
        el = el.parentElement;
      }
      return el;
    };

    if (scholarly) {
      // Recover detached scholarly Abstract / Summary blocks sitting before the main body start
      const hasAbstract = Array.from(out.body.querySelectorAll('h2, h3')).some(h => ABSTRACT_HEADING.test(normText(h.textContent)));
      if (!hasAbstract) {
        const bodyText = normText(out.body.textContent);
        const h1 = pristine.querySelector('article h1, main h1, [role="main"] h1, h1');
        const coreIdx = all.findIndex(el =>
          outOf.has(id(el)) && (
            (/^H[2-3]$/.test(el.tagName) && SCHOLARLY_CORE_HEADING.test(normText(el.textContent))) ||
            (el.tagName === 'P' && normText(el.textContent).length >= 160 && linkDensity(el) < 0.25 && !METADATA_PREFIX.test(normText(el.textContent)))
          )
        );
        const scanEnd = coreIdx >= 0 ? coreIdx : (firstKept > 0 ? firstKept : all.length);
        const absBlocks = [];
        let activeHeading = null;
        for (let i = 0; i < scanEnd; i++) {
          const el = all[i];
          if (outOf.has(id(el))) continue;
          if (h1 && (!(h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || h1.contains(el))) continue;
          if (/^H[2-4]$/.test(el.tagName)) {
            const label = normText(el.textContent);
            activeHeading = ABSTRACT_HEADING.test(label) && isUsable(el, pristine, true, 0.3) ? el : null;
          } else if (activeHeading && el.tagName === 'P') {
            const pt = normText(el.textContent);
            if (pt.length >= 60 && !METADATA_PREFIX.test(pt) && !bodyText.includes(pt.slice(0, 60)) &&
                isUsable(el, pristine, true, 0.3) &&
                (el.hasAttribute(NOTE_COL) || activeHeading.parentElement === el.parentElement)) {
              if (!absBlocks.includes(activeHeading)) absBlocks.push(activeHeading);
              absBlocks.push(el);
            }
          }
        }
        if (absBlocks.length >= 2) {
          const frag = out.createDocumentFragment();
          absBlocks.forEach(el => frag.appendChild(sanitizeRestored(el)));
          const anchor = scanEnd < all.length ? outOf.get(id(all[scanEnd])) : null;
          if (anchor) anchorOf(anchor).before(frag);
          else out.body.prepend(frag);
        }
      }
      return;
    }

    const keptParagraphs = all.filter(el => el.tagName === 'P' && outOf.has(id(el)));
    if (keptParagraphs.length < 2) return;

    let common = keptParagraphs[0].parentElement;
    while (common && !keptParagraphs.every(p => common.contains(p))) common = common.parentElement;
    if (!common) return;
    const scope = common.closest('article') || common.closest('main, [role="main"]') || common;

    const signature = (el) => {
      const parts = [];
      for (let n = el, depth = 0; n && n !== scope && depth < 5; n = n.parentElement, depth++) {
        parts.push(n.tagName + '.' + Array.from(n.classList).sort().join('.'));
      }
      return parts.join('>');
    };
    const keptSignatures = new Set(keptParagraphs.map(signature).filter(s => /\.[\w-]/.test(s)));

    const restore = new Set();

    // Recover dropped main-column sibling paragraphs (visual geometry primary, class-signature fallback)
    all.forEach(el => {
      if (el.tagName !== 'P' || outOf.has(id(el)) || !scope.contains(el)) return;
      const len = normText(el.textContent).length;
      const inVisualCol = len >= 35 && el.hasAttribute(NOTE_COL) && el.hasAttribute(NOTE_PROSE_STYLE);
      const inClassChain = len >= 25 && keptSignatures.has(signature(el));
      if ((inVisualCol || inClassChain) && isUsable(el, scope, false, 0.35)) {
        restore.add(el);
      }
    });

    // Walk backwards so dropped parent H2 headings above kept/restored child H3 subheadings recover together
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      if (!/^H[2-4]$/.test(el.tagName) || outOf.has(id(el)) || !scope.contains(el)) continue;
      const next = all[i + 1];
      if (!next || !(outOf.has(id(next)) || restore.has(next))) continue;
      const nextIsBody = !/^H[1-6]$/.test(next.tagName);
      const nextIsChildHeading = /^H[3-6]$/.test(next.tagName) && parseInt(next.tagName[1], 10) > parseInt(el.tagName[1], 10);
      if ((nextIsBody || nextIsChildHeading) && normText(el.textContent).length <= 200 && isUsable(el, scope, false, 0.35)) {
        restore.add(el);
      }
    }

    // Recover up to 3 lead/standfirst blocks between h1 and Readability's first kept node
    const h1 = pristine.querySelector('article h1, main h1, [role="main"] h1, h1');
    if (h1 && firstKept > 0) {
      const h1BottomAttr = pristine.getAttribute('data-inkpages-h1-bottom');
      const h1Bottom = h1BottomAttr !== null ? Number(h1BottomAttr) : null;
      const firstKeptTopAttr = all[firstKept] ? all[firstKept].getAttribute(NOTE_TOP) : null;
      const firstKeptTop = firstKeptTopAttr !== null ? Number(firstKeptTopAttr) : null;
      const articleText = normText(out.body.textContent);
      const desc = normText(description).toLowerCase();
      let ledes = 0;
      all.slice(0, firstKept).forEach(el => {
        if (ledes >= 3 || !/^(P|H2|H3)$/.test(el.tagName) || restore.has(el)) return;
        if (!(h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || h1.contains(el)) return;
        const text = normText(el.textContent);
        if (text.length < 40 || text.length > 600 || text === normText(title)) return;
        if (articleText.includes(text.slice(0, 60))) return;

        let excluded = false;
        let named = false;
        for (let n = el, depth = 0; n && n !== pristine && depth < 4; n = n.parentElement, depth++) {
          const names = [n.className, n.id, n.getAttribute('itemprop'), n.getAttribute('data-testid'), n.getAttribute('data-component')].join(' ');
          if (LEDE_NAME.test(names)) named = true;
          if (LEDE_NOT.test(names)) excluded = true;
        }
        const elTopAttr = el.getAttribute(NOTE_TOP);
        const elTop = elTopAttr !== null ? Number(elTopAttr) : null;
        const inLeadBand = el.hasAttribute(NOTE_LEAD_BAND) || (
          el.hasAttribute(NOTE_COL) && h1Bottom !== null && firstKeptTop !== null && elTop !== null &&
          elTop >= h1Bottom - 15 && elTop <= firstKeptTop + 15
        );
        const visuallyAligned = inLeadBand && el.hasAttribute(NOTE_PROSE_STYLE) && !excluded;
        const lower = text.toLowerCase();
        const described = desc.length >= 40 && (lower.startsWith(desc.slice(0, 60)) || desc.startsWith(lower.slice(0, 60)));
        if ((visuallyAligned || described || (named && !excluded)) && isUsable(el, pristine, true, 0.3)) {
          restore.add(el);
          ledes++;
        }
      });
    }

    if (!restore.size) return;

    all.forEach((el, i) => {
      if (!restore.has(el)) return;
      const copy = sanitizeRestored(el);
      for (let j = i - 1; j >= 0; j--) {
        const before = outOf.get(id(all[j]));
        if (before) { anchorOf(before).after(copy); outOf.set(id(el), copy); return; }
      }
      for (let j = i + 1; j < all.length; j++) {
        const after = outOf.get(id(all[j]));
        if (after) { anchorOf(after).before(copy); outOf.set(id(el), copy); return; }
      }
    });
  }

  /**
   * Stage 4: Clean scholarly front-matter metadata, duplicate figure previews, badges, and back-matter by heading hierarchy.
   */
  function cleanScholarlyArticle(out, cleanTitle) {
    const nt = normText(cleanTitle);

    // 1. Remove duplicate leading paper title if embedded at start of article body
    const firstHeading = out.body.querySelector('h1, h2');
    if (firstHeading && nt && normText(firstHeading.textContent) === nt &&
        out.body.textContent.indexOf(firstHeading.textContent) < 250) {
      firstHeading.remove();
    }

    // 2. Find article body start anchor (earlier of core section heading or first genuine prose block),
    //    stripping non-editorial metadata cards before that anchor
    let coreHeading = null;
    for (const h of out.body.querySelectorAll('h2, h3')) {
      if (SCHOLARLY_CORE_HEADING.test(normText(h.textContent))) { coreHeading = h; break; }
    }
    const firstSubstantialP = Array.from(out.body.querySelectorAll('p')).find(p => {
      const t = normText(p.textContent);
      return t.length >= 160 && linkDensity(p) < 0.25 && !METADATA_PREFIX.test(t) &&
             !/^(open access|research article|short communication|brief communication)/i.test(t);
    });

    let startAnchor = coreHeading || firstSubstantialP;
    if (coreHeading && firstSubstantialP &&
        (firstSubstantialP.compareDocumentPosition(coreHeading) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      // Preserve an editorial summary heading+prose sitting before coreHeading (e.g. Science Editor's Summary)
      const prevH = Array.from(out.body.querySelectorAll('h2, h3')).reverse().find(h =>
        (h.compareDocumentPosition(firstSubstantialP) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      startAnchor = prevH || firstSubstantialP;
    }

    if (startAnchor) {
      Array.from(out.body.querySelectorAll('h1, h2, h3, h4, p, ul, ol, div, span')).forEach(el => {
        if (!el.isConnected || el.contains(startAnchor) || startAnchor.contains(el)) return;
        if (el.compareDocumentPosition(startAnchor) & Node.DOCUMENT_POSITION_FOLLOWING) {
          if (!el.querySelector('figure, img, table')) el.remove();
        }
      });
    }

    // 3. Remove standalone file badges and metadata/footer boilerplate lines anywhere in scholarly body
    out.body.querySelectorAll('p, div, span, li').forEach(el => {
      if (!el.isConnected || el.closest('table, figcaption') || el.querySelector('img, svg, table, figure')) return;
      const t = normText(el.textContent);
      if (!t || t.length >= 1200) return;
      if (/^\((PDF|TIF|TIFF|DOCX?|XLSX?|ZIP|CSV|EPS|PPTX?)\)$/i.test(t) ||
          /^(affiliations?|author information|article notes|pubmed disclaimer|open access|research article|short communication|brief communication|letter|volume|updates|disclaimer|copyright|\d+\s*[-–]\s*(?:19|20)\d{2})$/i.test(t) ||
          /^(?:\*+\s*)?correspondence\s*:/i.test(t) ||
          /^[†‡§*]\s*these authors (?:have )?contributed equally/i.test(t) ||
          /^©\s*(?:19|20)\d{2}\b/.test(t) ||
          /^this is an open-access article distributed under the terms of the creative commons/i.test(t) ||
          /^all claims expressed in this article are solely those of the authors/i.test(t) ||
          METADATA_PREFIX.test(t)) {
        el.remove();
      }
    });

    // 4. Remove early pre-Introduction "Figures" preview strip when its images duplicate images later in the article
    const introHeading = Array.from(out.body.querySelectorAll('h2, h3')).find(h =>
      /^(introduction|background|\d+\.?\s+(introduction|background))$/i.test(normText(h.textContent))
    );
    if (introHeading) {
      for (const h of Array.from(out.body.querySelectorAll('h2, h3'))) {
        if (!h.isConnected || !(h.compareDocumentPosition(introHeading) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (!/^figures$/i.test(normText(h.textContent))) continue;
        const level = parseInt(h.tagName[1], 10);
        const stripNodes = [];
        const stripSrcs = [];
        let cur = h.nextElementSibling;
        while (cur && cur !== introHeading && !(/^H[1-6]$/.test(cur.tagName) && parseInt(cur.tagName[1], 10) <= level)) {
          stripNodes.push(cur);
          cur.querySelectorAll('img').forEach(img => { const s = img.getAttribute('src'); if (s) stripSrcs.push(s); });
          cur = cur.nextElementSibling;
        }
        const laterSrcs = new Set();
        Array.from(out.body.querySelectorAll('img')).forEach(img => {
          if (introHeading.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING) {
            const s = img.getAttribute('src');
            if (s) laterSrcs.add(s);
          }
        });
        const stripId = (s) => (s || '').replace(/^.*\/|\?.*$/g, '');
        const allDuplicated = stripSrcs.length > 0 && stripSrcs.every(s => laterSrcs.has(s) || Array.from(laterSrcs).some(ls => stripId(ls).split('.')[0] === stripId(s).split('.')[0]));
        if (!stripSrcs.length || allDuplicated) {
          stripNodes.forEach(n => n.remove());
          h.remove();
        }
      }
    }

    // 5. Remove scholarly back-matter and empty Figures headings by heading hierarchy
    const headings = Array.from(out.body.querySelectorAll('h2, h3, h4'));
    for (const h of headings) {
      if (!h.isConnected) continue;
      const label = normText(h.textContent);
      if (!SCHOLARLY_BACKMATTER_HEADING.test(label)) continue;

      const level = parseInt(h.tagName[1], 10);
      if (/^(figures|extended data(?: figures and tables)?)$/i.test(label)) {
        let hasMedia = false;
        let cur = h.nextElementSibling;
        while (cur && !(/^H[1-6]$/.test(cur.tagName) && parseInt(cur.tagName[1], 10) <= level)) {
          if (cur.matches('img, figure') || cur.querySelector('img, figure')) { hasMedia = true; break; }
          cur = cur.nextElementSibling;
        }
        if (hasMedia) continue;
      }

      const parent = h.parentElement;
      if (parent && parent !== out.body && parent.id !== 'readability-page-1' &&
          /^(DIV|SECTION|ASIDE)$/.test(parent.tagName)) {
        const parentHeadings = Array.from(parent.querySelectorAll('h1, h2, h3, h4'));
        const holdsCore = parentHeadings.some(ph => SCHOLARLY_KEEP_HEADING.test(normText(ph.textContent)));
        const allSubordinateOrBackmatter = parentHeadings.every(ph =>
          ph === h || parseInt(ph.tagName[1], 10) > level || SCHOLARLY_BACKMATTER_HEADING.test(normText(ph.textContent))
        );
        if (!holdsCore && parentHeadings[0] === h && allSubordinateOrBackmatter) {
          parent.remove();
          continue;
        }
      }

      let cur = h.nextElementSibling;
      while (cur) {
        if (/^H[1-6]$/.test(cur.tagName) && parseInt(cur.tagName[1], 10) <= level) break;
        const nxt = cur.nextElementSibling;
        cur.remove();
        cur = nxt;
      }
      h.remove();
    }

    out.body.querySelectorAll('section, div').forEach(el => {
      if (!el.isConnected || el.id === 'readability-page-1') return;
      if (!normText(el.textContent) && !el.querySelector('img, figure, table, pre, svg')) el.remove();
    });
  }

  function cleanArticleTitle(rawTitle, doc, scholarly) {
    let title = (rawTitle || doc.title || '').trim();
    if (/<\/?[a-z][a-z0-9:-]*>/i.test(title)) {
      const h1 = doc.querySelector('article h1, main h1, [role="main"] h1, h1');
      const h1Text = h1 ? normText(h1.textContent) : '';
      title = h1Text && !/<\/?[a-z][a-z0-9:-]*>/i.test(h1Text)
        ? h1Text
        : normText(title.replace(/<\/?[a-z][a-z0-9:-]*>/gi, ''));
    }
    if (scholarly) {
      title = title.replace(/\s+-\s+PubMed$/i, '').trim();
    }
    return title;
  }

  function extractArticleByline(doc, rawByline, scholarly, domFallbackByline) {
    const cleaned = (rawByline || '').replace(/[\s,]+$/, '').trim();
    if (scholarly) {
      let authors = Array.from(doc.querySelectorAll('meta[name="citation_author"]'))
        .map(m => (m.getAttribute('content') || '').trim())
        .filter(Boolean);
      if (!authors.length) {
        const grouped = doc.querySelector('meta[name="citation_authors"]');
        if (grouped) {
          authors = (grouped.getAttribute('content') || '').split(';').map(s => s.trim()).filter(Boolean);
        }
      }
      if (authors.length >= 2) {
        return authors.length <= 3 ? authors.join(', ') : `${authors[0]} et al.`;
      }
      if (cleaned) return cleaned;
      if (authors.length === 1) return authors[0];
    }
    if (cleaned) return cleaned;
    const metaAuthor = doc.querySelector('meta[name="author"]');
    if (metaAuthor && metaAuthor.getAttribute('content')) return metaAuthor.getAttribute('content').trim();
    return domFallbackByline || '';
  }

  /**
   * Extract article using live geometric/typographic analysis, Readability, column stitching, and post-parse bold.
   */
  function extractArticle() {
    const scholarly = isScholarlyPage(document);
    const authorEl = document.querySelector('[rel="author"], [itemprop="author"]');
    const domFallbackByline = authorEl && normText(authorEl.textContent).length > 0 && normText(authorEl.textContent).length < 80
      ? normText(authorEl.textContent) : '';

    const documentClone = document.cloneNode(true);
    analyzePageAndAnnotateClone(documentClone);
    copyShadowCodeBlocks(documentClone);

    preprocessDOM(documentClone, scholarly);
    const pristine = documentClone.body ? documentClone.body.cloneNode(true) : null;

    const reader = new Readability(documentClone, {
      charThreshold: scholarly ? 250 : 500,
      classesToPreserve: ['caption', 'figcaption']
    });

    const article = reader.parse();
    if (!article) return null;

    const cleanTitle = cleanArticleTitle(article.title, document, scholarly);
    const cleanByline = extractArticleByline(document, article.byline, scholarly, domFallbackByline);

    const out = new DOMParser().parseFromString(article.content, 'text/html');
    const metaDescEl = document.querySelector('meta[property="og:description"], meta[name="description"]');
    stitchVisualColumn(out, pristine, cleanTitle, metaDescEl ? metaDescEl.content : '', scholarly);
    if (scholarly) cleanScholarlyArticle(out, cleanTitle);

    wrapBoldNotes(out);
    const marks = out.body.querySelectorAll('b[' + ADDED_BOLD + ']');
    let bolded = 0;
    marks.forEach(b => { bolded += b.textContent.length; });
    if (bolded / (out.body.textContent.length || 1) > 0.3) {
      marks.forEach(b => b.replaceWith(...b.childNodes));
    }

    const bodyText = out.body.textContent || '';
    const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length;
    const readingTime = Math.ceil(wordCount / 200);

    return {
      title: cleanTitle || document.title,
      byline: cleanByline,
      content: sanitizeHTML(out.body.innerHTML),
      textContent: bodyText,
      excerpt: article.excerpt || '',
      siteName: article.siteName || extractSiteName(),
      length: bodyText.length,
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
    // Create top-layer modal host and reader overlay if they do not exist
    if (!readerOverlay) {
      readerDialog = document.createElement('dialog');
      readerDialog.id = 'inkpages-dialog';
      readerDialog.style.cssText = [
        'position: fixed',
        'inset: 0',
        'width: 100%',
        'height: 100%',
        'max-width: none',
        'max-height: none',
        'min-width: 0',
        'min-height: 0',
        'margin: 0',
        'padding: 0',
        'border: none',
        'outline: none',
        'box-shadow: none',
        'background: transparent',
        'overflow: hidden',
        'transform: none',
        'opacity: 1',
        'visibility: visible',
        'z-index: 2147483647'
      ].join(' !important; ') + ' !important;';
      // Cancel native dialog Escape so handleKeydown handles fullscreen-exit and close cleanly
      readerDialog.addEventListener('cancel', (e) => {
        e.preventDefault();
      });

      readerOverlay = document.createElement('div');
      readerOverlay.id = 'inkpages-overlay';
      readerOverlay.style.cssText = `
        position: fixed;
        inset: 0;
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

      readerDialog.appendChild(readerOverlay);
      document.body.appendChild(readerDialog);

      // Initialize reader functionality
      initializeReader();
    }

    // Show top-layer dialog (re-invoking showModal places InkPages above any site <dialog>)
    if (readerDialog) {
      try {
        if (readerDialog.open && !isReaderFullscreen()) readerDialog.close();
        if (!readerDialog.open) readerDialog.showModal();
      } catch (e) {
        readerDialog.setAttribute('open', '');
      }
    }
    readerOverlay.style.display = 'block';
    document.body.style.overflow = 'hidden';

    // Render content based on mode
    if (isListingMode && listingData) {
      setReaderTitle(listingData.pageTitle);
      renderListing();
    } else if (articleData) {
      setReaderTitle(articleData.title);
      renderArticle();
    }
  }

  function setReaderTitle(title) {
    if (document.title !== readerTitle) originalTitle = document.title;
    readerTitle = title + ' - InkPages';
    document.title = readerTitle;
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
      btnExport: shadowRoot.getElementById('btn-export'),
      btnFullscreen: shadowRoot.getElementById('btn-fullscreen'),
      toggleFullscreen: shadowRoot.getElementById('toggle-fullscreen'),
      settingsPanel: shadowRoot.getElementById('settings-panel'),
      settingsOverlay: shadowRoot.getElementById('settings-overlay'),
      btnCloseSettings: shadowRoot.getElementById('btn-close-settings'),
      btnCloseReader: shadowRoot.getElementById('btn-close-reader'),
      // Only buttons with data-font: the link/image size/export buttons share the .font-btn style
      fontBtns: shadowRoot.querySelectorAll('.font-btn[data-font]'),
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
      toggleSiteAuto: shadowRoot.getElementById('toggle-site-auto'),
      toggleSiteToc: shadowRoot.getElementById('toggle-site-toc'),
      siteNames: shadowRoot.querySelectorAll('.setting-site'),
      autoOpenPrompt: shadowRoot.getElementById('auto-open-prompt'),
      autoOpenQuestion: shadowRoot.getElementById('auto-open-question'),
      autoOpenYes: shadowRoot.getElementById('auto-open-yes'),
      autoOpenNo: shadowRoot.getElementById('auto-open-no'),
      toggleFloatingButton: shadowRoot.getElementById('toggle-floating-button'),
      floatingButtonSizeSlider: shadowRoot.getElementById('floating-button-size-slider'),
      floatingButtonSizeValue: shadowRoot.getElementById('floating-button-size-value'),
      sizeBtns: shadowRoot.querySelectorAll('.size-btn'),
      linkBtns: shadowRoot.querySelectorAll('.link-btn'),
      imageSizeBtns: shadowRoot.querySelectorAll('.image-size-btn'),
      exportBtns: shadowRoot.querySelectorAll('.export-btn'),
      safeAreaSlider: shadowRoot.getElementById('safe-area-slider'),
      safeAreaValue: shadowRoot.getElementById('safe-area-value')
    };

    // Store elements for later use
    window.__einkReaderElements = elements;

    // State
    let currentPage = 0;
    let totalPages = 1;
    let pageWidth = 0;
    // Don't save reading position until the saved one has been restored, or the initial page 0 overwrites it
    let positionRestored = false;
    const EXPORT_NAMES = { html: 'HTML', epub: 'EPUB', markdown: 'Markdown' };
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
      linkMode: 'normal',  // 'normal' | 'plain' | 'hide'
      imageSize: 'small',  // 'small' | 'medium' | 'large' (share of the page height)
      exportFormat: 'html',  // 'html' | 'epub' | 'markdown'
      fullscreen: false,  // enter fullscreen on the first tap after the reader opens
      floatingButtonEnabled: isLikelyAndroid,
      floatingButtonSize: 50
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
        settings.floatingButtonSize = normalizeFloatingButtonSize(settings.floatingButtonSize);
        setFloatingButtonSize(settings.floatingButtonSize);
        setFloatingButtonEnabled(settings.floatingButtonEnabled);
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
      root.classList.toggle('links-plain', settings.linkMode === 'plain');
      root.classList.toggle('links-hide', settings.linkMode === 'hide');
      root.classList.toggle('images-medium', settings.imageSize === 'medium');
      root.classList.toggle('images-large', settings.imageSize === 'large');

      // Images not loaded while hidden (see renderArticle) are needed once they show again
      if (!settings.noImages && elements.articleContent) {
        elements.articleContent.querySelectorAll('img[loading="lazy"]').forEach(img => {
          img.loading = 'eager';
        });
      }

      updateSettingsUI();

      if ((articleData || listingData) && elements.articleContent) {
        setTimeout(repaginate, 50);
      }
    }

    // Re-run pagination after a layout change, staying at the same relative position in the text
    function repaginate() {
      const progress = totalPages > 1 ? currentPage / totalPages : 0;
      updateHeaderSpacer();
      setupPagination();
      goToPage(Math.min(totalPages - 1, Math.round(progress * totalPages)));
    }

    function updateSettingsUI() {
      elements.fontBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === settings.fontFamily);
      });

      elements.themeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === settings.theme);
      });

      elements.linkBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.links === settings.linkMode);
      });

      elements.imageSizeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.imageSize === settings.imageSize);
      });

      elements.exportBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.export === settings.exportFormat);
      });
      if (elements.btnExport) {
        elements.btnExport.title = `Export as ${EXPORT_NAMES[settings.exportFormat] || 'HTML'}`;
      }

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

      if (elements.toggleFullscreen) elements.toggleFullscreen.checked = !!settings.fullscreen;
      updateFullscreenUI();

      if (elements.toggleFloatingButton) {
        elements.toggleFloatingButton.checked = settings.floatingButtonEnabled;
      }

      if (elements.floatingButtonSizeSlider) {
        elements.floatingButtonSizeSlider.value = settings.floatingButtonSize;
      }
      if (elements.floatingButtonSizeValue) {
        elements.floatingButtonSizeValue.textContent = `${settings.floatingButtonSize}px`;
      }
    }

    // Full screen (v1.6.0). The dialog host is the fullscreen element; fullscreen needs a user gesture
    // and ends on every page load, so the setting only arms the first tap in the reader.
    function enterFullscreen() {
      const fsHost = readerDialog || readerOverlay;
      if (!fsHost || document.fullscreenElement || !document.fullscreenEnabled) return;
      try {
        const p = fsHost.requestFullscreen();
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* not allowed here */ }
    }

    function exitFullscreen() {
      if (!isReaderFullscreen()) return;
      document.exitFullscreen().catch(() => {});
    }

    function updateFullscreenUI() {
      const on = isReaderFullscreen();
      if (!elements.btnFullscreen) return;
      elements.btnFullscreen.setAttribute('aria-pressed', on ? 'true' : 'false');
      const label = on ? 'Exit full screen' : 'Full screen';
      elements.btnFullscreen.title = label;
      elements.btnFullscreen.setAttribute('aria-label', label);
    }

    /**
     * Update the header spacer to match the current header height.
     * The spacer compensates for the absolutely-positioned header on page 0,
     * ensuring content continuity when navigating between pages.
     */
    function updateHeaderSpacer() {
      if (!elements.articleHeader || !elements.articleContent) return;

      // Temporarily show header to measure its height (if it's hidden)
      const wasMinimized = elements.articleHeader.classList.contains('minimized');
      if (wasMinimized) {
        elements.articleHeader.classList.remove('minimized');
      }

      // Measure actual header height (varies with title length, font size, viewport width)
      const headerHeight = elements.articleHeader.getBoundingClientRect().height;

      // Restore header state
      if (wasMinimized) {
        elements.articleHeader.classList.add('minimized');
      }

      // Find or create spacer
      let spacer = elements.articleContent.querySelector('#header-spacer');
      if (!spacer) {
        spacer = document.createElement('div');
        spacer.id = 'header-spacer';
        elements.articleContent.insertBefore(spacer, elements.articleContent.firstChild);
      }

      // Set spacer height to match header
      spacer.style.height = headerHeight + 'px';
    }

    function setupPagination() {
      const viewport = elements.contentViewport;
      const content = elements.articleContent;

      if (!viewport || !content) return;

      const viewportRect = viewport.getBoundingClientRect();

      // Always round pixel values to prevent sub-pixel drift on narrow screens (v1.0.8 fix)
      const viewportWidth = Math.floor(viewportRect.width);
      const viewportHeight = Math.floor(viewportRect.height);
      const columnGap = 50;

      // Images are sized as a share of the page height (reader.css)
      content.style.setProperty('--page-height', viewportHeight + 'px');

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
      // Subtract a small buffer for text descenders (p, g, y, j, q extend below baseline)
      // This prevents the very last line from touching the progress bar
      const computedStyle = getComputedStyle(content);
      const fontSize = parseFloat(computedStyle.fontSize) || 18;
      const descenderBuffer = Math.ceil(fontSize * 0.25);
      content.style.height = (viewportHeight - descenderBuffer) + 'px';
      content.style.width = 'max-content';

      content.style.columnWidth = viewportWidth + 'px';
      content.style.columnGap = columnGap + 'px';
      content.style.columnFill = 'auto';

      void content.offsetHeight;
      const actualScrollWidth = content.scrollWidth;

      // pageWidth is already integer since viewportWidth is floored and columnGap is integer
      pageWidth = viewportWidth + columnGap;

      totalPages = Math.max(1, Math.ceil((actualScrollWidth + columnGap) / pageWidth));

      const lastPageStart = (totalPages - 1) * pageWidth;
      if (lastPageStart >= actualScrollWidth) {
        totalPages = Math.max(1, totalPages - 1);
      }

      content.style.width = actualScrollWidth + 'px';

      currentPage = Math.min(currentPage, Math.max(0, totalPages - 1));

      // Store state
      window.__einkReaderState.currentPage = currentPage;
      window.__einkReaderState.totalPages = totalPages;
      window.__einkReaderState.pageWidth = pageWidth;

      updatePageDisplay();
    }

    function updatePageDisplay() {
      if (!elements.articleContent) return;

      // Offset is always integer since currentPage and pageWidth are integers
      const offset = currentPage * pageWidth;
      elements.articleContent.style.transform = `translateX(-${offset}px)`;
      elements.pageIndicator.textContent = `${currentPage + 1} / ${totalPages}`;

      const progress = totalPages > 1 ? ((currentPage + 1) / totalPages) * 100 : 100;
      elements.progressFill.style.width = `${progress}%`;

      // Hide full article header on pages 2+ (compact title in header bar is always visible)
      // Note: No recalculation needed because header is positioned absolutely
      // and a spacer in the content compensates for it on page 0
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

    // Key on the URL without the #fragment and utm_* tracking parameters
    function readingPositionKey() {
      return 'pos_' + pageUrlKey(articleData.sourceUrl);
    }

    async function saveReadingPosition() {
      if (!positionRestored || isListingMode || !articleData || !articleData.sourceUrl) return;
      const key = readingPositionKey();

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
      if (!articleData || !articleData.sourceUrl) return null;

      try {
        const positions = (await browserAPI.storage.local.get('readingPositions')).readingPositions || {};
        return positions[readingPositionKey()] || null;
      } catch (error) {
        console.warn('Failed to load reading position:', error);
      }
      return null;
    }

    /**
     * Paginate freshly rendered content, starting from page 0 (articles: the saved position).
     * Saved as a fraction so it survives font/width changes between sessions.
     */
    async function paginateNewContent() {
      positionRestored = false;
      currentPage = 0;
      updateHeaderSpacer();
      setupPagination();

      if (!isListingMode) {
        const saved = await loadReadingPosition();
        if (saved && saved.page > 0) {
          const progress = saved.totalPages > 1 ? saved.page / saved.totalPages : 0;
          goToPage(Math.min(totalPages - 1, Math.round(progress * totalPages)));
        }
      }
      positionRestored = true;
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

      // Full screen: first tap or key press in the reader enters it (when the setting is on and the user has not left it on this page)
      function armedForFullscreen(e) {
        if (!settings.fullscreen || !isReaderActive || fullscreenUserExited || document.fullscreenElement) return false;
        if (e.type === 'keydown') return e.key !== 'Escape';
        // The buttons that open/close/toggle fullscreen do their own thing
        const path = e.composedPath ? e.composedPath() : [];
        const own = [elements.btnFullscreen, elements.btnClose, elements.btnCloseReader,
          elements.toggleFullscreen && elements.toggleFullscreen.closest('label')];
        return !own.some(el => el && path.includes(el));
      }
      const firstGesture = (e) => { if (armedForFullscreen(e)) enterFullscreen(); };
      ['pointerup', 'click', 'touchend'].forEach(type => shadowRoot.addEventListener(type, firstGesture, true));
      document.addEventListener('keydown', firstGesture, true);

      if (elements.btnFullscreen) {
        elements.btnFullscreen.addEventListener('click', () => {
          if (isReaderFullscreen()) exitFullscreen();
          else enterFullscreen();
        });
      }

      // Close buttons
      if (elements.btnClose) {
        elements.btnClose.addEventListener('click', () => deactivateReaderMode());
      }
      if (elements.btnCloseReader) {
        elements.btnCloseReader.addEventListener('click', () => deactivateReaderMode());
      }

      // Settings
      if (elements.btnSettings) {
        elements.btnSettings.addEventListener('click', openSettingsPanel);
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

      // Export button
      if (elements.btnExport) {
        elements.btnExport.addEventListener('click', () => exportArticle());
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

      // Link mode buttons
      elements.linkBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          settings.linkMode = btn.dataset.links;
          applySettings();
          saveSettings();
        });
      });

      elements.imageSizeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          settings.imageSize = btn.dataset.imageSize;
          applySettings();
          saveSettings();
        });
      });

      elements.exportBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          settings.exportFormat = btn.dataset.export;
          updateSettingsUI();
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

      // Per-site auto-open switches (articles, and link pages shown as a TOC)
      [[elements.toggleSiteAuto, 'article'], [elements.toggleSiteToc, 'toc']].forEach(([toggle, kind]) => {
        if (!toggle) return;
        toggle.addEventListener('change', (e) => {
          setAutoOpen(kind, e.target.checked);
          hideAutoOpenPrompt();
        });
      });

      // Auto-open question: both answers are remembered, so it isn't asked again
      [[elements.autoOpenYes, true], [elements.autoOpenNo, false]].forEach(([button, answer]) => {
        if (!button) return;
        button.addEventListener('click', () => {
          if (autoOpenPromptKind) setAutoOpen(autoOpenPromptKind, answer);
          hideAutoOpenPrompt();
        });
      });

      // Full screen switch: the click is a user gesture, so turning it on enters right away
      if (elements.toggleFullscreen) {
        elements.toggleFullscreen.addEventListener('change', (e) => {
          settings.fullscreen = e.target.checked;
          if (settings.fullscreen) {
            fullscreenUserExited = false;
            enterFullscreen();
          } else {
            exitFullscreen();
          }
          saveSettings();
        });
      }

      if (elements.toggleFloatingButton) {
        elements.toggleFloatingButton.addEventListener('change', (e) => {
          settings.floatingButtonEnabled = e.target.checked;
          setFloatingButtonEnabled(settings.floatingButtonEnabled);
          saveSettings();
        });
      }

      if (elements.floatingButtonSizeSlider) {
        elements.floatingButtonSizeSlider.addEventListener('input', (e) => {
          settings.floatingButtonSize = normalizeFloatingButtonSize(parseInt(e.target.value, 10));
          setFloatingButtonSize(settings.floatingButtonSize);
          if (elements.floatingButtonSizeValue) {
            elements.floatingButtonSizeValue.textContent = `${settings.floatingButtonSize}px`;
          }
        });
        elements.floatingButtonSizeSlider.addEventListener('change', saveSettings);
      }

      // Window resize
      let resizeTimeout;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(repaginate, 150);
      });

      // Entering/leaving fullscreen resizes the page; repaginate (same position) once the size has settled.
      // Shares the resize timer, so a resize event arriving later pushes it back.
      let wasFullscreen = false;
      document.addEventListener('fullscreenchange', () => {
        const isFs = isReaderFullscreen();
        if (wasFullscreen && !isFs) {
          lastFullscreenExit = Date.now();
          // Left it ourselves via Settings or by closing the reader: not "the user left"; the latter has isReaderActive false
          if (isReaderActive) {
            fullscreenUserExited = true;
            if (readerDialog && !readerDialog.open) {
              try { readerDialog.showModal(); } catch (e) {}
            }
          }
        }
        wasFullscreen = isFs;
        updateFullscreenUI();
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => { if (isReaderActive) repaginate(); }, 250);
      });
    }

    // Show the settings panel with the per-site auto-open state refreshed from storage
    async function openSettingsPanel() {
      // Settings has the same choice as the auto-open question
      hideAutoOpenPrompt();
      elements.settingsPanel.classList.remove('hidden');
      const site = window.location.hostname.replace(/^www\./, '');
      elements.siteNames.forEach(el => { el.textContent = site; });
      for (const [toggle, kind] of [[elements.toggleSiteAuto, 'article'], [elements.toggleSiteToc, 'toc']]) {
        if (!toggle) continue;
        try {
          const state = await getAutoOpenState(kind);
          toggle.checked = state === 'enabled' || state === 'legacy';
        } catch (e) {
          console.warn('Failed to read auto-open state:', e);
        }
      }
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
          // The same Escape that ended fullscreen must not also close the reader
          if (document.fullscreenElement || Date.now() - lastFullscreenExit < 400) break;
          deactivateReaderMode();
          break;
        case 's':
        case 'S':
          if (!e.ctrlKey && !e.metaKey) {
            openSettingsPanel();
          }
          break;
      }
    }

    // Export the article as an HTML, EPUB or Markdown file (Settings → Export Format)
    async function exportArticle() {
      if (!articleData) {
        console.error('InkPages: No article data to export');
        return;
      }

      // Generate clean filename from title
      const cleanTitle = (articleData.title || 'article')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50)
        .toLowerCase() || 'article';

      let blob;
      let filename;
      if (settings.exportFormat === 'epub') {
        showNotification('Preparing EPUB…');
        try {
          const result = await InkPagesEpub.build({
            title: articleData.title,
            byline: articleData.byline,
            siteName: articleData.siteName,
            lang: articleData.lang,
            dir: articleData.dir,
            sourceUrl: articleData.sourceUrl,
            contentRoot: prepareExportDocument().body,
            grayscale: settings.grayscale
          });
          blob = result.blob;
          if (result.skippedImages) {
            const count = result.skippedImages;
            showNotification(`${count} image${count === 1 ? '' : 's'} could not be included`);
          }
        } catch (error) {
          console.error('InkPages: EPUB export failed', error);
          showNotification('EPUB export failed');
          return;
        }
        filename = `${cleanTitle}.epub`;
      } else if (settings.exportFormat === 'markdown') {
        const markdown = InkPagesMarkdown.build({
          title: articleData.title,
          byline: articleData.byline,
          siteName: articleData.siteName,
          sourceUrl: articleData.sourceUrl,
          contentRoot: prepareExportDocument().body
        });
        blob = new Blob([markdown], { type: 'text/markdown' });
        filename = `${cleanTitle}.md`;
      } else {
        blob = new Blob([generateExportHTML()], { type: 'text/html' });
        filename = `${cleanTitle}.html`;
      }
      const file = new File([blob], filename, { type: blob.type });

      // Try Web Share API first (mobile-friendly, opens share sheet)
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: articleData.title
          });
          return;
        } catch (err) {
          // User cancelled or share failed, fall through to download
          if (err.name !== 'AbortError') {
            console.log('InkPages: Share failed, falling back to download', err);
          }
        }
      }

      // Fallback: direct download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoking straight away can cancel a large download before it starts
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    /**
     * The article as an inert document for export, following the image settings:
     * with "Hide images" the images go, captions stay as an "Image:" note and credits go
     */
    function prepareExportDocument() {
      // Inert document: nothing loads or runs
      const doc = new DOMParser().parseFromString(articleData.content || '', 'text/html');
      doc.body.querySelectorAll('img').forEach(img => {
        if (img.dataset.src && !img.getAttribute('src')) img.setAttribute('src', img.dataset.src);
        if (img.dataset.lazySrc && !img.getAttribute('src')) img.setAttribute('src', img.dataset.lazySrc);
      });
      markCaptions(doc.body);

      if (settings.noImages) {
        doc.body.querySelectorAll('img, picture, video, audio, iframe, svg, .inkpages-credit, .inkpages-bare-figure')
          .forEach(el => el.remove());
        doc.body.querySelectorAll('.inkpages-caption').forEach(caption => {
          const label = doc.createElement('b');
          label.textContent = 'Image: ';
          caption.insertBefore(label, caption.firstChild);
        });
      }
      return doc;
    }

    function generateExportHTML() {
      const title = articleData.title || 'Untitled';
      const byline = articleData.byline || '';
      const siteName = articleData.siteName || '';
      const content = prepareExportDocument().body.innerHTML;
      const sourceUrl = articleData.sourceUrl || '';

      // Clean, readable styles for the exported HTML
      const styles = `
        * { box-sizing: border-box; }
        body {
          max-width: 680px;
          margin: 0 auto;
          padding: 20px;
          font-family: Georgia, 'Times New Roman', serif;
          font-size: 18px;
          line-height: 1.8;
          color: #1a1a1a;
          background: #fff;
        }
        header {
          margin-bottom: 2em;
          padding-bottom: 1em;
          border-bottom: 1px solid #e0e0e0;
        }
        h1 {
          font-size: 1.8em;
          line-height: 1.3;
          margin: 0 0 0.5em 0;
        }
        .meta {
          color: #666;
          font-size: 0.9em;
        }
        .meta a { color: #666; }
        .source {
          margin-top: 0.5em;
          font-size: 0.85em;
        }
        .source a { color: #0066cc; }
        img {
          max-width: 100%;
          max-height: 50vh;
          width: auto;
          height: auto;
          display: block;
          margin: 1em auto;
          ${settings.grayscale ? 'filter: grayscale(100%);' : ''}
        }
        figure { margin: 1em 0; }
        figure img { margin: 0 auto; }
        figcaption, .inkpages-caption {
          font-size: 0.875em;
          font-style: italic;
          color: #555;
        }
        a { color: #0066cc; }
        blockquote {
          margin: 1em 0;
          padding-left: 1em;
          border-left: 3px solid #ccc;
          color: #555;
        }
        pre, code {
          background: #f5f5f5;
          font-family: monospace;
          font-size: 0.9em;
        }
        pre {
          padding: 1em;
          overflow-x: auto;
        }
        code { padding: 0.2em 0.4em; }
        pre code { padding: 0; }
        footer {
          margin-top: 3em;
          padding-top: 1em;
          border-top: 1px solid #e0e0e0;
          font-size: 0.85em;
          color: #888;
        }
      `;

      return `<!DOCTYPE html>
<html lang="${escapeHtml(articleData.lang || 'en')}" dir="${escapeHtml(articleData.dir || 'ltr')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
  <article>
    <header>
      <h1>${escapeHtml(title)}</h1>
      ${byline ? `<p class="meta">${escapeHtml(byline)}</p>` : ''}
      ${siteName ? `<p class="meta">${escapeHtml(siteName)}</p>` : ''}
      ${sourceUrl ? `<p class="source">Source: <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a></p>` : ''}
    </header>
    <main>${content}</main>
    <footer>
      Saved with InkPages
    </footer>
  </article>
</body>
</html>`;
    }

    // Expose functions for external use
    window.__einkReaderFunctions = {
      nextPage,
      prevPage,
      goToPage,
      setupPagination,
      updateHeaderSpacer,
      applySettings,
      paginateNewContent,
      repaginate
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

    // Drop article ids that clash with the reader's own (e.g. a site's <article id="article-content">)
    const readerIds = new Set(Array.from(shadowRoot.querySelectorAll('[id]'))
      .filter(el => el === elements.articleContent || !elements.articleContent.contains(el))
      .map(el => el.id));
    elements.articleContent.querySelectorAll('[id]').forEach(el => {
      if (readerIds.has(el.id)) el.removeAttribute('id');
    });

    // Process images. Load them straight away (unless hidden): lazy images in later columns
    // would only load when reached and shift the text while reading. Each load changes the
    // layout, so repaginate (keeping the position) once they settle.
    const imagesHidden = shadowRoot.host.classList.contains('no-images');
    let imageRepaginateTimer = null;
    const repaginateAfterImageLoad = () => {
      clearTimeout(imageRepaginateTimer);
      imageRepaginateTimer = setTimeout(() => {
        const funcs = window.__einkReaderFunctions;
        if (funcs && isReaderActive) funcs.repaginate();
      }, 150);
    };
    const images = elements.articleContent.querySelectorAll('img');
    images.forEach(img => {
      if (img.dataset.src && !img.src) img.src = img.dataset.src;
      if (img.dataset.lazySrc && !img.src) img.src = img.dataset.lazySrc;
      img.loading = imagesHidden ? 'lazy' : 'eager';
      img.style.breakInside = 'avoid';
      if (!img.complete) {
        img.addEventListener('load', repaginateAfterImageLoad, { once: true });
        img.addEventListener('error', repaginateAfterImageLoad, { once: true });
      }
    });

    // Tag captions and photo credits for the "Hide images" setting
    markCaptions(elements.articleContent);

    // Tag link-dominated blocks so the "Hide link blocks" setting can hide them
    markLinkBlocks(elements.articleContent);

    // Process links - intercept for sticky reader mode
    const links = elements.articleContent.querySelectorAll('a[href]');
    links.forEach(link => {
      link.addEventListener('click', handleLinkClick);
    });

    // Set up pagination after content is rendered
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const funcs = window.__einkReaderFunctions;
        if (funcs) {
          funcs.paginateNewContent();
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
          funcs.paginateNewContent();
        }
      });
    });
  }

  /**
   * Mark blocks that are mostly link text ("Read more: ...", "Related: ...", promo link lists)
   * with .inkpages-link-block. CSS hides them when the link mode is 'hide'.
   */
  function markLinkBlocks(container) {
    const blockSelector = 'p, li, ul, ol, dl, div, section, aside, blockquote, figure, table';
    const linkDensityThreshold = 0.6;
    const totalLength = normalizedTextLength(container);
    if (!totalLength) return;

    // querySelectorAll returns ancestors before descendants, so marked containers skip their children
    for (const block of container.querySelectorAll(blockSelector)) {
      if (block.closest('.inkpages-link-block')) continue;

      const textLength = normalizedTextLength(block);
      // Never hide a block holding most of the article, even on link-heavy pages
      if (!textLength || textLength > totalLength * 0.5) continue;

      let linkLength = 0;
      block.querySelectorAll('a[href]').forEach(a => {
        linkLength += normalizedTextLength(a);
      });

      if (linkLength / textLength >= linkDensityThreshold) {
        block.classList.add('inkpages-link-block');
      }
    }

    // A short heading directly above a hidden block ("Related stories") goes with it
    container.querySelectorAll('h2, h3, h4, h5, h6').forEach(heading => {
      const next = heading.nextElementSibling;
      if (next && next.classList.contains('inkpages-link-block') && normalizedTextLength(heading) < 80) {
        heading.classList.add('inkpages-link-block');
      }
    });
  }

  function normalizedTextLength(el) {
    return el.textContent.replace(/\s+/g, ' ').trim().length;
  }

  // Photo credits: "Foto ANP", "Beeld Getty Images", "Photo: Jane Doe/Reuters", "© AFP".
  // The credit word must be followed by a name (capital, digit or ©), so a caption such as
  // "Images of the protest" is not mistaken for one.
  const CREDIT_WORD = "(?:[Ff]oto'?s?|FOTO|[Pp]hotos?|PHOTO|[Bb]eeld|BEELD|[Ii]mages?|[Cc]redits?|" +
    '[Cc]opyright|[Ii]llustrati(?:e|on)|[Bb]ron|[Ss]ource)';
  const CREDIT_START = new RegExp(`^(?:©|\\(c\\)|${CREDIT_WORD}\\s*:?\\s+[A-Z0-9©])`);
  const CREDIT_AGENCY = /^(getty images|anp|reuters|ap|afp|epa|dpa|shutterstock|istock|alamy|hollandse hoogte|unsplash)((\s*[/|,]|\s+via|\s+-)\s*[^.!?]{1,50})?$/i;
  // A credit after the caption text: after a full stop, a separator (| / – —), in brackets, or ©
  const TRAILING_CREDIT = new RegExp(
    `(?:(?<=[.!?])\\s*|\\s+[|/–—-]\\s*|\\s*\\(|\\s+(?=©))(?:${CREDIT_WORD}\\s*:?\\s+(?=[A-Z0-9©])|©)[^.!?]{1,60}$`);

  function isCreditText(text) {
    return text.length <= 60 && (CREDIT_START.test(text) || CREDIT_AGENCY.test(text));
  }

  /**
   * Tag captions for the "Hide images" setting and exports without images:
   * - .inkpages-caption: a caption that says something; shown as an "Image:" note
   * - .inkpages-credit: a photo credit (a whole caption, or its trailing part); dropped
   * - .inkpages-bare-figure: an image figure with no caption, or only a credit; dropped
   * Figures without images (tables, quotes, code) are left alone.
   */
  function markCaptions(container) {
    const clean = text => text.replace(/\s+/g, ' ').trim();

    container.querySelectorAll('figcaption, .caption').forEach(caption => {
      if (caption.parentElement && caption.parentElement.closest('figcaption, .caption')) return;
      const text = clean(caption.textContent);
      if (!text) return;
      if (isCreditText(text)) {
        caption.classList.add('inkpages-credit');
        return;
      }
      caption.classList.add('inkpages-caption');

      // A trailing credit is often its own element...
      const last = caption.lastElementChild;
      if (last && isCreditText(clean(last.textContent))) {
        last.classList.add('inkpages-credit');
        return;
      }
      // ...or plain text after the caption ("Protesters in The Hague. Beeld ANP")
      const lastNode = caption.lastChild;
      if (lastNode && lastNode.nodeType === Node.TEXT_NODE) {
        const match = lastNode.data.match(TRAILING_CREDIT);
        const captionText = caption.textContent;
        const before = match && captionText.slice(0, captionText.length - lastNode.data.length + match.index);
        if (match && clean(before)) {
          const credit = lastNode.splitText(match.index);
          const span = container.ownerDocument.createElement('span');
          span.className = 'inkpages-credit';
          credit.replaceWith(span);
          span.appendChild(credit);
        }
      }
    });

    container.querySelectorAll('figure').forEach(figure => {
      if (!figure.querySelector('img, picture, video, iframe, svg')) return;
      if (figure.querySelector('.inkpages-caption')) return;
      // Caption text in a plain element rather than a <figcaption>
      const copy = figure.cloneNode(true);
      copy.querySelectorAll('.inkpages-credit').forEach(credit => credit.remove());
      const text = clean(copy.textContent);
      figure.classList.add(text && !isCreditText(text) ? 'inkpages-caption' : 'inkpages-bare-figure');
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
    const host = (readerDialog && readerDialog.open) ? readerDialog : document.body;
    host.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  // Initialize floating button and check auto-activation for sticky mode
  initializeFloatingButton();
  watchForNavigation();
  checkAutoActivation();
})();
