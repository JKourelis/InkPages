/**
 * Reader View JavaScript
 *
 * This file handles:
 * 1. Loading article data from storage
 * 2. Rendering content with CSS column-based pagination
 * 3. Navigation via tap zones and keyboard
 * 4. Settings management and persistence
 *
 * PAGINATION APPROACH:
 * - #content-viewport is a fixed-size window (clips overflow)
 * - #article-content has a large width to allow CSS columns to expand
 * - We measure scrollWidth to determine how many columns were created
 * - We translate #article-content horizontally to show different pages
 */

(function() {
  'use strict';

  // Cross-browser compatibility
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // ============================================
  // State
  // ============================================
  let articleData = null;
  let currentPage = 0;
  let totalPages = 1;
  let elements = {};
  let pageWidth = 0; // Width of one page (column + gap)
  let settings = {
    fontFamily: 'serif',
    fontSize: 18,
    lineHeight: 1.8,
    pageWidth: 680,
    theme: 'light',
    boldText: false,
    justifyText: false,
    grayscale: false,
    noImages: false
  };

  // ============================================
  // DOM Elements - Initialize after DOM ready
  // ============================================
  function initElements() {
    elements = {
      loadingContainer: document.getElementById('loading-container'),
      errorContainer: document.getElementById('error-container'),
      errorMessage: document.getElementById('error-message'),
      errorSourceLink: document.getElementById('error-source-link'),
      articleContainer: document.getElementById('article-container'),
      articleTitle: document.getElementById('article-title'),
      articleByline: document.getElementById('article-byline'),
      articleReadingTime: document.getElementById('article-reading-time'),
      contentViewport: document.getElementById('content-viewport'),
      articleContent: document.getElementById('article-content'),
      siteName: document.getElementById('site-name'),
      pageIndicator: document.getElementById('page-indicator'),
      progressFill: document.getElementById('progress-fill'),
      tapZonePrev: document.getElementById('tap-zone-prev'),
      tapZoneNext: document.getElementById('tap-zone-next'),
      btnClose: document.getElementById('btn-close'),
      btnSettings: document.getElementById('btn-settings'),
      settingsPanel: document.getElementById('settings-panel'),
      settingsOverlay: document.getElementById('settings-overlay'),
      btnCloseSettings: document.getElementById('btn-close-settings'),
      btnCloseReader: document.getElementById('btn-close-reader'),
      // Settings controls
      fontBtns: document.querySelectorAll('.font-btn'),
      fontSizeSlider: document.getElementById('font-size-slider'),
      fontSizeValue: document.getElementById('font-size-value'),
      lineHeightSlider: document.getElementById('line-height-slider'),
      lineHeightValue: document.getElementById('line-height-value'),
      pageWidthSlider: document.getElementById('page-width-slider'),
      pageWidthValue: document.getElementById('page-width-value'),
      themeBtns: document.querySelectorAll('.theme-btn'),
      toggleBold: document.getElementById('toggle-bold'),
      toggleJustify: document.getElementById('toggle-justify'),
      toggleGrayscale: document.getElementById('toggle-grayscale'),
      toggleNoImages: document.getElementById('toggle-no-images'),
      sizeBtns: document.querySelectorAll('.size-btn')
    };

    console.log('Elements initialized:', {
      viewport: elements.contentViewport,
      content: elements.articleContent
    });
  }

  // ============================================
  // Initialization
  // ============================================
  async function init() {
    initElements();

    try {
      await loadSettings();
      applySettings();

      articleData = await getArticleData();

      if (!articleData) {
        showError('No article data found. Please try again.');
        return;
      }

      if (articleData.error) {
        showError(articleData.error, articleData.sourceUrl);
        return;
      }

      renderArticle();

      // Wait for content to render, then set up pagination
      // Use multiple frames to ensure layout is complete
      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          setupPagination();
          // Restore reading position if available
          const savedPage = await loadReadingPosition();
          if (savedPage > 0 && savedPage < totalPages) {
            currentPage = savedPage;
            updatePageDisplay();
          }
          hideLoading();
        });
      });

      setupEventListeners();

    } catch (error) {
      console.error('Reader initialization error:', error);
      showError('Failed to initialize reader: ' + error.message);
    }
  }

  function getArticleData() {
    return new Promise((resolve) => {
      browserAPI.runtime.sendMessage({ type: 'GET_ARTICLE_DATA' }, (response) => {
        resolve(response);
      });
    });
  }

  async function loadSettings() {
    try {
      const result = await browserAPI.storage.sync.get('readerSettings');
      if (result.readerSettings) {
        settings = { ...settings, ...result.readerSettings };
      }
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

  // ============================================
  // Reading Position Memory
  // ============================================
  function getArticleKey() {
    // Create a key from the source URL for storing reading position
    if (articleData && articleData.sourceUrl) {
      return 'pos_' + articleData.sourceUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
    }
    return null;
  }

  async function saveReadingPosition() {
    const key = getArticleKey();
    if (!key) return;

    try {
      const positions = (await browserAPI.storage.local.get('readingPositions')).readingPositions || {};
      positions[key] = {
        page: currentPage,
        totalPages: totalPages,
        timestamp: Date.now()
      };

      // Keep only last 50 articles to avoid storage bloat
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
    const key = getArticleKey();
    if (!key) return 0;

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

  // ============================================
  // Rendering
  // ============================================
  function renderArticle() {
    document.title = articleData.title || 'InkPages';
    elements.articleTitle.textContent = articleData.title || '';
    elements.articleByline.textContent = articleData.byline || '';
    elements.siteName.textContent = articleData.siteName || '';

    if (articleData.readingTime) {
      elements.articleReadingTime.textContent = `${articleData.readingTime} min read`;
    }

    elements.articleContent.innerHTML = articleData.content || '';
    processImages();
    processLinks();
  }

  function processImages() {
    const images = elements.articleContent.querySelectorAll('img');
    images.forEach(img => {
      if (img.dataset.src && !img.src) img.src = img.dataset.src;
      if (img.dataset.lazySrc && !img.src) img.src = img.dataset.lazySrc;
      img.loading = 'lazy';
      img.style.breakInside = 'avoid';
      img.style.pageBreakInside = 'avoid';
    });
  }

  function processLinks() {
    // Make all links open in new tab to avoid losing reader position
    const links = elements.articleContent.querySelectorAll('a[href]');
    links.forEach(link => {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    });
  }

  // ============================================
  // Pagination Engine
  //
  // Structure:
  // - content-viewport: clips overflow, fixed size
  // - article-content: wide container with CSS columns
  //
  // The content container is given a large width so CSS columns can
  // expand horizontally. We measure scrollWidth to count columns,
  // then translate horizontally to navigate.
  // ============================================

  function setupPagination() {
    const viewport = elements.contentViewport;
    const content = elements.articleContent;

    if (!viewport || !content) {
      console.error('Pagination elements not found');
      return;
    }

    // Get viewport dimensions
    const viewportRect = viewport.getBoundingClientRect();
    const viewportWidth = viewportRect.width;
    const viewportHeight = viewportRect.height;

    console.log('Viewport dimensions:', { viewportWidth, viewportHeight });

    // Column gap between pages
    const columnGap = 50;

    // Step 1: Reset all styles
    content.style.width = '';
    content.style.height = '';
    content.style.columnWidth = '';
    content.style.columnGap = '';
    content.style.transform = '';
    content.style.position = '';

    // Step 2: Measure natural content height by temporarily positioning absolutely
    // This removes it from the flex flow and gives accurate scrollHeight
    content.style.position = 'absolute';
    content.style.width = viewportWidth + 'px';
    content.style.visibility = 'hidden';
    void content.offsetHeight;
    const naturalHeight = content.scrollHeight;

    // Reset position
    content.style.position = '';
    content.style.visibility = '';

    console.log('Natural content height:', naturalHeight);

    // Step 3: Calculate initial page estimate (might need adjustment)
    let estimatedPages = Math.ceil(naturalHeight / viewportHeight);

    // Add some buffer for content reflow differences between single column and multi-column
    estimatedPages = Math.ceil(estimatedPages * 1.1) + 1;

    console.log('Estimated pages (with buffer):', estimatedPages);

    // Step 4: Set up columns with max-content width to measure actual content
    content.style.height = viewportHeight + 'px';
    content.style.width = 'max-content'; // Let browser calculate actual width needed
    content.style.columnWidth = viewportWidth + 'px';
    content.style.columnGap = columnGap + 'px';
    content.style.columnFill = 'auto';

    // Step 5: Force layout and measure actual scrollWidth
    void content.offsetHeight;
    const actualScrollWidth = content.scrollWidth;

    // Step 6: Calculate actual pages from scrollWidth
    pageWidth = viewportWidth + columnGap;

    // The actual content width tells us how many columns were created
    // scrollWidth with max-content = actual columns needed
    // Calculate: n columns take n*columnWidth + (n-1)*gap
    totalPages = Math.max(1, Math.ceil((actualScrollWidth + columnGap) / pageWidth));

    // Verify by checking if last page would be mostly empty
    const lastPageStart = (totalPages - 1) * pageWidth;
    if (lastPageStart >= actualScrollWidth) {
      totalPages = Math.max(1, totalPages - 1);
    }

    // Set exact width needed
    const exactWidth = totalPages * viewportWidth + (totalPages - 1) * columnGap;
    content.style.width = exactWidth + 'px';

    // Clamp current page
    currentPage = Math.min(currentPage, Math.max(0, totalPages - 1));

    console.log('Pagination result:', {
      naturalHeight,
      viewportHeight,
      estimatedPages,
      actualScrollWidth,
      exactWidth,
      pageWidth,
      totalPages,
      currentPage
    });

    updatePageDisplay();
  }

  function updatePageDisplay() {
    if (!elements.articleContent) return;

    // Translate to show current page
    const offset = currentPage * pageWidth;
    elements.articleContent.style.transform = `translateX(-${offset}px)`;

    // Update page indicator
    elements.pageIndicator.textContent = `${currentPage + 1} / ${totalPages}`;

    // Update progress bar
    const progress = totalPages > 1 ? ((currentPage + 1) / totalPages) * 100 : 100;
    elements.progressFill.style.width = `${progress}%`;

    // Save reading position (debounced)
    saveReadingPosition();
  }

  function goToPage(pageNum) {
    if (pageNum < 0 || pageNum >= totalPages) return;
    currentPage = pageNum;
    updatePageDisplay();
  }

  function nextPage() {
    console.log('nextPage:', currentPage, '/', totalPages);
    if (currentPage < totalPages - 1) {
      currentPage++;
      updatePageDisplay();
    }
  }

  function prevPage() {
    console.log('prevPage:', currentPage, '/', totalPages);
    if (currentPage > 0) {
      currentPage--;
      updatePageDisplay();
    }
  }

  // ============================================
  // Settings Application
  // ============================================
  function applySettings() {
    const root = document.documentElement;
    const body = document.body;

    root.setAttribute('data-theme', settings.theme);
    body.classList.remove('font-serif', 'font-sans-serif', 'font-monospace');
    body.classList.add(`font-${settings.fontFamily}`);
    root.style.setProperty('--font-size', `${settings.fontSize}px`);
    root.style.setProperty('--line-height', settings.lineHeight);
    root.style.setProperty('--page-width', `${settings.pageWidth}px`);

    body.classList.toggle('bold-text', settings.boldText);
    body.classList.toggle('justify-text', settings.justifyText);
    body.classList.toggle('grayscale', settings.grayscale);
    body.classList.toggle('no-images', settings.noImages);

    updateSettingsUI();

    // Recalculate pagination when settings change
    if (articleData && elements.articleContent) {
      setTimeout(() => {
        currentPage = 0; // Reset to first page on settings change
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
  }

  // ============================================
  // Event Listeners
  // ============================================
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

    // Swipe gestures for touch devices (especially e-ink)
    let touchStartX = 0;
    let touchStartY = 0;
    const minSwipeDistance = 50;

    document.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (!e.changedTouches.length) return;

      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartX;
      const deltaY = touchEndY - touchStartY;

      // Only trigger if horizontal swipe is dominant and long enough
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > minSwipeDistance) {
        if (deltaX < 0) {
          // Swipe left = next page
          nextPage();
        } else {
          // Swipe right = previous page
          prevPage();
        }
      }
    }, { passive: true });

    // Keyboard
    document.addEventListener('keydown', handleKeydown);

    // Close buttons
    if (elements.btnClose) elements.btnClose.addEventListener('click', closeReader);
    if (elements.btnCloseReader) elements.btnCloseReader.addEventListener('click', closeReader);

    // Settings panel
    if (elements.btnSettings) elements.btnSettings.addEventListener('click', openSettings);
    if (elements.btnCloseSettings) elements.btnCloseSettings.addEventListener('click', closeSettings);
    if (elements.settingsOverlay) elements.settingsOverlay.addEventListener('click', closeSettings);

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

    // Toggle switches
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

    // Window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        setupPagination();
      }, 150);
    });
  }

  function handleKeydown(e) {
    if (elements.settingsPanel && !elements.settingsPanel.classList.contains('hidden')) {
      if (e.key === 'Escape') closeSettings();
      return;
    }

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        nextPage();
        break;
      case ' ':
        e.preventDefault();
        if (e.shiftKey) {
          prevPage();
        } else {
          nextPage();
        }
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
        closeReader();
        break;
      case 's':
      case 'S':
        if (!e.ctrlKey && !e.metaKey) openSettings();
        break;
    }
  }

  // ============================================
  // UI State
  // ============================================
  function hideLoading() {
    if (elements.loadingContainer) elements.loadingContainer.classList.add('hidden');
  }

  function showError(message, sourceUrl) {
    if (elements.loadingContainer) elements.loadingContainer.classList.add('hidden');
    if (elements.errorContainer) elements.errorContainer.classList.remove('hidden');
    if (elements.errorMessage) elements.errorMessage.textContent = message;
    if (sourceUrl && elements.errorSourceLink) {
      elements.errorSourceLink.href = sourceUrl;
      elements.errorSourceLink.textContent = sourceUrl;
    }
  }

  function openSettings() {
    if (elements.settingsPanel) elements.settingsPanel.classList.remove('hidden');
  }

  function closeSettings() {
    if (elements.settingsPanel) elements.settingsPanel.classList.add('hidden');
  }

  function closeReader() {
    window.close();
  }

  // ============================================
  // Start
  // ============================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
