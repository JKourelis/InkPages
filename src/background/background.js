/**
 * Background Script (Manifest V2)
 *
 * Handles toolbar button clicks to toggle reader mode in the current tab.
 * The content script handles all the in-page rendering via Shadow DOM.
 */

// Cross-browser compatibility: Firefox uses 'browser', Chrome uses 'chrome'
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

/**
 * Handle toolbar button click - toggle reader mode
 */
browserAPI.browserAction.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) {
    console.error('No valid tab to process');
    return;
  }

  // Skip non-http(s) pages
  if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
    console.log('Skipping non-HTTP page:', tab.url);
    return;
  }

  // Skip reader.html pages (our own reader page)
  if (tab.url.includes('reader.html')) {
    console.log('Skipping reader page');
    return;
  }

  try {
    // Content script is automatically injected via manifest
    // Just send the toggle message
    browserAPI.tabs.sendMessage(tab.id, { type: 'TOGGLE_READER' }, (response) => {
      if (browserAPI.runtime.lastError) {
        console.error('Failed to send toggle message:', browserAPI.runtime.lastError.message);
      } else {
        console.log('Reader mode toggled:', response);
      }
    });
  } catch (error) {
    console.error('Failed to toggle reader mode:', error);
  }
});

/**
 * Listen for messages from content script
 */
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_READER_RESOURCES') {
    // Content script requesting URLs for reader resources
    sendResponse({
      readerHtml: browserAPI.runtime.getURL('src/reader/reader.html'),
      readerCss: browserAPI.runtime.getURL('src/reader/reader.css'),
      readabilityJs: browserAPI.runtime.getURL('src/lib/Readability.js')
    });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    // Get saved settings
    browserAPI.storage.sync.get('readerSettings').then(result => {
      sendResponse(result.readerSettings || null);
    });
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    // Save settings
    browserAPI.storage.sync.set({ readerSettings: message.settings }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'GET_READING_POSITION') {
    // Get saved reading position for a URL
    browserAPI.storage.local.get('readingPositions').then(result => {
      const positions = result.readingPositions || {};
      sendResponse(positions[message.url] || null);
    });
    return true;
  }

  if (message.type === 'SAVE_READING_POSITION') {
    // Save reading position
    browserAPI.storage.local.get('readingPositions').then(result => {
      const positions = result.readingPositions || {};
      positions[message.url] = message.position;

      // Keep only last 100 positions
      const urls = Object.keys(positions);
      if (urls.length > 100) {
        const toRemove = urls.slice(0, urls.length - 100);
        toRemove.forEach(url => delete positions[url]);
      }

      browserAPI.storage.local.set({ readingPositions: positions }).then(() => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

});

console.log('InkPages background script loaded');
