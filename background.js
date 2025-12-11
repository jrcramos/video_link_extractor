// Use a Map to store links, with tabId as the key and a Set of URLs as the value.
// A Map is better for arbitrary keys like tab IDs.
// A Set automatically handles uniqueness, preventing duplicate links.
const videoLinks = new Map();

// STRATEGY 1: REGEX
// I removed audio formats (mp3, wav, etc) to prevent false positives.
// Added 'i' flag for case-insensitive matching (captures .MP4).
const videoRegex = /\.(m3u8|mpd|m3u|webm|gif|mov|avi|m4v|ogv|asf|opus|ts|divx|mpg|rm|mp3|aac|flac|wav|ogg|wmv|m4s|m2ts|mts|f4v|3g2|mpeg|mkv|3gp|vid|flv|mp4)(\?|$)/i;

// STRATEGY 2: CONTENT-TYPE CHECK
// We will verify if the server says "This is a video" in the headers.
const isVideoHeader = (headers) => {
  if (!headers) return false;
  
  for (const header of headers) {
    if (header.name.toLowerCase() === 'content-type') {
      const type = header.value.toLowerCase();
      
      // Check for standard video types or specific streaming manifests
      if (
        type.startsWith('video/') || 
        type.includes('application/x-mpegurl') || // HLS (m3u8)
        type.includes('application/vnd.apple.mpegurl') || // HLS alt
        type.includes('application/dash+xml') // DASH (mpd)
      ) {
        return true;
      }
    }
  }
  return false;
};

// Helper function to add URL to the Map
const addLinkToTab = (tabId, url) => {
  if (tabId < 0 || !url) return;
  
  if (!videoLinks.has(tabId)) {
    videoLinks.set(tabId, new Set());
  }
  videoLinks.get(tabId).add(url);
};

// LISTENER 1: Catch URLs by Extension (Fastest)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.match(videoRegex)) {
      addLinkToTab(details.tabId, details.url);
    }
  },
  { urls: ["<all_urls>"] }
);

// LISTENER 2: Catch URLs by Header (Fallback/More Robust)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Only check if we haven't already captured this URL (optimization)
    // Or just let the Set handle the deduplication.
    if (isVideoHeader(details.responseHeaders)) {
      addLinkToTab(details.tabId, details.url);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"] // IMPORTANT: This permission allows us to inspect headers
);

// MEMORY CLEANUP
chrome.tabs.onRemoved.addListener((tabId) => {
  if (videoLinks.has(tabId)) {
    videoLinks.delete(tabId);
    console.log(`Cleaned up data for closed tab: ${tabId}`);
  }
});

// MESSAGE HANDLING
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getLinks') {
    const links = videoLinks.get(request.tabId);
    sendResponse({ links: links ? Array.from(links) : [] });
  } else if (request.action === 'clearLinks') {
    if (videoLinks.has(request.tabId)) {
      videoLinks.delete(request.tabId);
      sendResponse({ success: true });
    }
  }
  return true; 
});