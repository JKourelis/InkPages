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
      // never opens as a TOC: its text may just not have rendered yet.
      if (isArticle) {
        if (openArticles) activateReaderMode();
      } else if (openLinkPages && !isDeclaredArticle()) {
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

    // Pages that declare themselves an article (og:type, article:published_time, JSON-LD)
    // can be short, e.g. reviews and news briefs, so they get lower thresholds
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

  /**
   * Check whether the page declares itself as a single article in its metadata.
   * Only the page's own top-level JSON-LD type counts: listing pages often embed
   * ItemLists of NewsArticle entries, which must not match.
   */
  function isDeclaredArticle() {
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

    if (readerOverlay) {
      readerOverlay.style.display = 'none';
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

    doc.body.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();

        // Remove every inline event handler (onclick, onpointerdown, ontoggle, ...)
        if (name.startsWith('on') || name === 'srcdoc') {
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
      // Screen-reader-only labels ("v-plus. Label: Analyse", "Gepubliceerd op"):
      // invisible on the site, noise in the reader
      '.sr-only',
      '.visually-hidden',
      '.visuallyhidden',
      '.screen-reader-text',
    ];

    // Remove elements matching selectors
    selectorsToRemove.forEach(selector => {
      try {
        doc.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // Selector might not be supported, ignore
      }
    });

    // Remove forms (paywall purchase, login, newsletter): never article text, but a
    // paywall form full of plans and conditions can outscore a short article
    // (volkskrant.nl). A form wrapping most of the page (ASP.NET sites) is kept.
    const pageTextLength = (doc.body && doc.body.textContent || '').length;
    doc.querySelectorAll('form').forEach(form => {
      if (form.textContent.length < pageTextLength * 0.5) form.remove();
    });

    removeSignInGates(doc);

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

  // Sign-in / subscribe gates placed between article paragraphs (the Guardian's
  // "This is not a paywall" box): a link to a sign-in, register or subscribe page
  // whose own text is a call to action.
  const GATE_HREF = /sign-?in|log-?in|register|registr|sign-?up|subscri|abonne|account|profile|inloggen|anmeld|connexion/i;
  const GATE_LINK_TEXT = /\b(sign(ed)? ?in|log ?in|create (an|a free|your) account|register|subscribe|sign ?up|inloggen|registreer|abonneer|word abonnee|account aanmaken|anmelden|registrieren|abonnieren|se connecter|s'abonner|abonnez|créer un compte|s'inscrire)\b/i;

  /**
   * Remove the outermost small box around each gate link that sits among the
   * article's paragraphs (its parent has 2+ other paragraphs of 100+ chars).
   * Links inside a paragraph never qualify: the climb stops at the article body,
   * which is over 1500 chars or has no paragraph siblings.
   */
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
    // A gate is a box (heading, button or several links), not a sentence with a link
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
      exportFormat: 'html',  // 'html' | 'epub'
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
        elements.btnExport.title = settings.exportFormat === 'epub' ? 'Export as EPUB' : 'Export as HTML';
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

    // Export article as self-contained HTML file
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
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  // Initialize floating button and check auto-activation for sticky mode
  initializeFloatingButton();
  watchForNavigation();
  checkAutoActivation();
})();
