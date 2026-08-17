// content.js - Injected into pages & all frames to detect embedded media elements & poster thumbnails
(function() {
  const detectedUrls = new Set();

  // Helper to extract absolute URLs from an element or string
  function resolveUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
      return null;
    }
    try {
      return new URL(trimmed, window.location.href).href;
    } catch (e) {
      return null;
    }
  }

  // Helper to find page poster/thumbnail fallback
  function getPageThumbnail() {
    const metaPoster = document.querySelector('meta[property="og:image"], meta[name="twitter:image"], link[rel="image_src"]');
    if (metaPoster) {
      return resolveUrl(metaPoster.getAttribute('content') || metaPoster.getAttribute('href'));
    }
    return '';
  }

  // Send found links to background worker
  function reportNewLinks(items) {
    if (!items || items.length === 0) return;
    const toSend = [];
    const pagePoster = getPageThumbnail();

    items.forEach(item => {
      const url = typeof item === 'string' ? item : item.url;
      const poster = (typeof item === 'object' && item.poster) ? resolveUrl(item.poster) : pagePoster;
      const resolved = resolveUrl(url);

      if (resolved && !detectedUrls.has(resolved)) {
        detectedUrls.add(resolved);
        toSend.push({
          url: resolved,
          poster: poster || ''
        });
      }
    });

    if (toSend.length > 0) {
      try {
        chrome.runtime.sendMessage({
          action: 'addLinksFromContent',
          links: toSend
        });
      } catch (e) {
        // Extension context might be invalidated if updated
      }
    }
  }

  // 1. Listen for sniffed media from inject.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__VLE_SNIFFED_MEDIA__' && Array.isArray(event.data.links)) {
      reportNewLinks(event.data.links);
    }
  });

  // 2. Deep scan function that traverses normal DOM and open Shadow Roots
  function scanRoot(root) {
    if (!root) return;
    const newItems = [];
    const defaultPoster = getPageThumbnail();

    // Check all <video> and <audio> elements
    const mediaElements = root.querySelectorAll ? root.querySelectorAll('video, audio') : [];
    mediaElements.forEach((el) => {
      const src = resolveUrl(el.src) || resolveUrl(el.currentSrc);
      const poster = resolveUrl(el.poster) || resolveUrl(el.getAttribute('poster')) || defaultPoster;

      if (src && !detectedUrls.has(src)) {
        newItems.push({ url: src, poster: poster || '' });
      }

      // Check child <source> tags
      const sources = el.querySelectorAll ? el.querySelectorAll('source') : [];
      sources.forEach((s) => {
        const sourceSrc = resolveUrl(s.src) || resolveUrl(s.getAttribute('src'));
        if (sourceSrc && !detectedUrls.has(sourceSrc)) {
          newItems.push({ url: sourceSrc, poster: poster || '' });
        }
      });
    });

    // Check standalone <source> tags
    const standaloneSources = root.querySelectorAll ? root.querySelectorAll('source[src]') : [];
    standaloneSources.forEach((s) => {
      const src = resolveUrl(s.src) || resolveUrl(s.getAttribute('src'));
      if (src && !detectedUrls.has(src)) {
        newItems.push({ url: src, poster: defaultPoster || '' });
      }
    });

    // Send newly found media links
    if (newItems.length > 0) {
      reportNewLinks(newItems);
    }

    // Recursively scan open Shadow Roots for modern Web Components
    const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    allElements.forEach((el) => {
      if (el.shadowRoot) {
        scanRoot(el.shadowRoot);
      }
    });
  }

  // Initial Scan
  function runScan() {
    scanRoot(document);
  }

  // Run on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runScan);
  } else {
    runScan();
  }

  // Observe DOM changes for dynamically inserted video players / AJAX updates
  try {
    const observer = new MutationObserver(() => {
      runScan();
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'poster']
    });
  } catch (e) {}

  // Also listen for manual triggers from the popup if requested
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'forceContentScan') {
      runScan();
      sendResponse({ status: 'scanned', links: Array.from(detectedUrls) });
    }
  });
})();