// content.js - Injected into every webpage
(function() {
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'getVideoLinks') {
      const videos = document.querySelectorAll('video');
      const videoLinks = Array.from(videos).map(video => video.src).filter(src => src !== '');

      if (videoLinks.length > 0) {
        console.log('Detected video links from content script:', videoLinks);
        chrome.runtime.sendMessage({
          action: 'addLinksFromContentScript',
          tabId: event.data.tabId,
          links: videoLinks
        });
      }
    }
  });

  // Request video links from the content script
  chrome.runtime.sendMessage({ action: 'injectContentScript' });
})();

// Listen for messages from background script to add video links from content script
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'addLinksFromContentScript') {
    const tabId = request.tabId;
    const links = request.links;

    if (!chrome.runtime.lastError) {
      if (tabId && links && links.length > 0) {
        if (typeof videoLinks[tabId] === 'undefined') {
          videoLinks[tabId] = new Set();
        }

        for (const link of links) {
          if (!videoLinks[tabId].has(link)) {
            videoLinks[tabId].add(link);
            console.log('Added video link from content script:', link);
          }
        }
      }
    }
  }
});