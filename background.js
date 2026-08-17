// Map to store links: tabId -> Map of url -> { url, referer, timestamp }
const videoLinks = new Map();
const tabPageUrls = new Map();

// STRATEGY 1: CLEAN REGEX FILTER (standard extensions)
const videoRegex = /\.(m3u8|mpd|m3u|mp4|webm|mkv|mov|avi|flv|m4v|ogv|wmv|3gp|f4v|mp3|aac|flac|wav|ogg|opus|m4a)(\?|#|$)/i;

// STRATEGY 2: QUERY STRING & SIGNATURE DETECTION (e.g. YouTube, Cloudflare, query-only CDNs)
const videoQueryRegex = /(\?|&)(mime=video%2F|mime=video\/|mime=audio%2F|mime=audio\/|format=m3u8|format=mpd|type=m3u8|type=mpd|ext=mp4)|\/videoplayback\?/i;

// STRATEGY 3: CONTENT-TYPE CHECK
const isVideoHeader = (headers) => {
  if (!headers) return false;
  
  for (const header of headers) {
    if (header.name.toLowerCase() === 'content-type') {
      const type = header.value.toLowerCase();
      
      // Exclude raw transport stream chunks from flooding
      if (type.includes('video/mp2t') || type.includes('video/iso.segment')) {
        return false;
      }
      
      if (
        type.startsWith('video/') ||
        type.startsWith('audio/') ||
        type.includes('application/x-mpegurl') ||
        type.includes('application/vnd.apple.mpegurl') ||
        type.includes('application/dash+xml')
      ) {
        return true;
      }
    }
  }
  return false;
};

// Update badge count on toolbar icon
const updateBadge = (tabId) => {
  if (tabId < 0) return;
  const count = videoLinks.has(tabId) ? videoLinks.get(tabId).size : 0;
  const badgeText = count > 0 ? (count > 99 ? '99+' : `${count}`) : '';
  
  chrome.action.setBadgeText({ text: badgeText, tabId: tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#667eea', tabId: tabId }).catch(() => {});
};

// Helper function to extract referer header from request details
const getRefererFromDetails = (details) => {
  if (details.requestHeaders) {
    for (const h of details.requestHeaders) {
      if (h.name.toLowerCase() === 'referer') return h.value;
    }
  }
  if (details.initiator && details.initiator !== 'null' && !details.initiator.startsWith('chrome-extension')) {
    return details.initiator;
  }
  return tabPageUrls.get(details.tabId) || '';
};

// Add detected link to storage
const addLinkToTab = (tabId, url, referer) => {
  if (tabId < 0 || !url) return;
  if (url.startsWith('data:') || url.startsWith('blob:')) return;

  if (!videoLinks.has(tabId)) {
    videoLinks.set(tabId, new Map());
  }
  
  const tabMap = videoLinks.get(tabId);
  const existing = tabMap.get(url);
  const effectiveReferer = referer || (existing ? existing.referer : '') || tabPageUrls.get(tabId) || '';

  tabMap.set(url, {
    url: url,
    referer: effectiveReferer,
    timestamp: Date.now()
  });
  
  updateBadge(tabId);
};

// Track main frame page URLs for referer fallback
chrome.webNavigation = chrome.webNavigation || {};
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab && tab.url && !tab.url.startsWith('chrome://')) {
    tabPageUrls.set(tabId, tab.url);
  }
});

// LISTENER 1: Catch URLs by Extension, Manifest format, or Query Signatures
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId >= 0 && details.url) {
      if (details.url.match(videoRegex) || details.url.match(videoQueryRegex)) {
        const referer = getRefererFromDetails(details);
        addLinkToTab(details.tabId, details.url, referer);
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// LISTENER 2: Catch URLs by Response Content-Type Header
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId >= 0 && details.url && isVideoHeader(details.responseHeaders)) {
      const referer = tabPageUrls.get(details.tabId) || details.initiator || '';
      addLinkToTab(details.tabId, details.url, referer);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clean up memory on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  videoLinks.delete(tabId);
  tabPageUrls.delete(tabId);
});

// Set dynamic declarativeNetRequest rule for in-popup video preview with custom referer
const setPreviewRefererRule = async (mediaUrl, refererUrl) => {
  if (!chrome.declarativeNetRequest) return;
  try {
    const parsedMedia = new URL(mediaUrl);
    const parsedRef = refererUrl ? new URL(refererUrl) : null;
    const origin = parsedRef ? parsedRef.origin : '';

    const requestHeaders = [
      { header: 'Referer', operation: 'set', value: refererUrl || origin || 'https://' + parsedMedia.hostname },
      { header: 'Origin', operation: 'set', value: origin || 'https://' + parsedMedia.hostname }
    ];

    const rule = {
      id: 1001,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: requestHeaders
      },
      condition: {
        urlFilter: `||${parsedMedia.hostname}*`,
        resourceTypes: ['media', 'xmlhttprequest', 'other']
      }
    };

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [rule]
    });
  } catch (err) {
    console.error('Failed to update preview referer rule:', err);
  }
};

// MESSAGE HANDLING
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // From popup: get links + referers
  if (request.action === 'getLinks') {
    const linksMap = videoLinks.get(request.tabId);
    const pageUrl = tabPageUrls.get(request.tabId) || '';
    const linksArray = linksMap ? Array.from(linksMap.values()) : [];
    sendResponse({ links: linksArray, pageUrl: pageUrl });
  } 
  // From popup: clear links
  else if (request.action === 'clearLinks') {
    if (videoLinks.has(request.tabId)) {
      videoLinks.delete(request.tabId);
      updateBadge(request.tabId);
    }
    sendResponse({ success: true });
  }
  // From content.js: add links (DOM scanner, JSON sniffer, fetch/XHR hooks)
  else if (request.action === 'addLinksFromContent') {
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    const pageUrl = sender.tab ? sender.tab.url : tabPageUrls.get(tabId) || '';
    if (tabId && Array.isArray(request.links)) {
      request.links.forEach((link) => addLinkToTab(tabId, link, pageUrl));
    }
    sendResponse({ success: true });
  }
  // From popup: enable preview referer rule
  else if (request.action === 'preparePreview') {
    setPreviewRefererRule(request.mediaUrl, request.refererUrl).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
  return true; 
});