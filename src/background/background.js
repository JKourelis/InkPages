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
 * One-time migration (v1.4.0). Before v1.3.0 opening the reader once saved the site, and its
 * link pages (homepage, sections) then opened as a TOC too while "Show TOC on homepages" was
 * on (the default). Those sites keep opening automatically but are marked legacy, so the
 * reader asks once whether to keep that, separately for articles and link pages.
 */
async function migrateAutoOpen() {
  const local = await browserAPI.storage.local.get(['autoOpenMigrated', 'readerEnabledOrigins']);
  if (local.autoOpenMigrated) return;

  const sites = local.readerEnabledOrigins || [];
  const sync = await browserAPI.storage.sync.get('readerSettings');
  const tocWasOn = (sync.readerSettings || {}).listingModeEnabled !== false;

  await browserAPI.storage.local.set({
    readerLegacyOrigins: sites,
    tocEnabledOrigins: tocWasOn ? sites : [],
    tocLegacyOrigins: tocWasOn ? sites : [],
    autoOpenMigrated: true
  });
}

migrateAutoOpen().catch(error => {
  console.warn('Auto-open migration failed:', error);
});

console.log('InkPages background script loaded');
