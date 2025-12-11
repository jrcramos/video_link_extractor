// Use a Map to store links, with tabId as the key and a Set of URLs as the value.
// A Map is better for arbitrary keys like tab IDs.
// A Set automatically handles uniqueness, preventing duplicate links.
const videoLinks = new Map();

// The improved regex that handles URLs with query parameters.
const videoRegex = /\.(m3u8|mpd|m3u|webm|gif|mov|avi|m4v|ogv|asf|opus|ts|divx|mpg|rm|mp3|aac|flac|wav|ogg|wmv|mpeg|mkv|3gp|vid|flv|mp4)(\?|$)/;

// Listen for network requests and capture matching URLs.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0 && details.url.match(videoRegex)) {
      // Ensure a Set exists for this tabId.
      if (!videoLinks.has(details.tabId)) {
        videoLinks.set(details.tabId, new Set());
      }
      // Add the URL to the Set. Duplicates will be ignored automatically.
      videoLinks.get(details.tabId).add(details.url);
    }
  },
  { urls: ["<all_urls>"] }
);

// MEMORY CLEANUP: Listen for when a tab is closed and remove its data.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (videoLinks.has(tabId)) {
    videoLinks.delete(tabId);
    console.log(`Cleaned up data for closed tab: ${tabId}`);
  }
});

// Listen for messages from the popup.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getLinks') {
    const links = videoLinks.get(request.tabId);
    // Convert the Set to an Array before sending.
    sendResponse({ links: links ? Array.from(links) : [] });
  } else if (request.action === 'clearLinks') {
    if (videoLinks.has(request.tabId)) {
      videoLinks.delete(request.tabId);
      sendResponse({ success: true });
    }
  }
  return true; // Indicates an asynchronous response.
});