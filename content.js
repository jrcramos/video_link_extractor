// content.js - Injected into pages & all frames to detect embedded media elements
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

  // Deep scan function that traverses normal DOM and open Shadow Roots
  function scanRoot(root) {
    if (!root) return;
    const newLinks = [];

    // 1. Check all <video> and <audio> elements
    const mediaElements = root.querySelectorAll ? root.querySelectorAll('video, audio') : [];
    mediaElements.forEach((el) => {
      const src = resolveUrl(el.src) || resolveUrl(el.currentSrc);
      if (src && !detectedUrls.has(src)) {
        detectedUrls.add(src);
        newLinks.push(src);
      }

      // Check child <source> tags
      const sources = el.querySelectorAll ? el.querySelectorAll('source') : [];
      sources.forEach((s) => {
        const sourceSrc = resolveUrl(s.src) || resolveUrl(s.getAttribute('src'));
        if (sourceSrc && !detectedUrls.has(sourceSrc)) {
          detectedUrls.add(sourceSrc);
          newLinks.push(sourceSrc);
        }
      });
    });

    // 2. Check standalone <source> tags
    const standaloneSources = root.querySelectorAll ? root.querySelectorAll('source[src]') : [];
    standaloneSources.forEach((s) => {
      const src = resolveUrl(s.src) || resolveUrl(s.getAttribute('src'));
      if (src && !detectedUrls.has(src)) {
        detectedUrls.add(src);
        newLinks.push(src);
      }
    });

    // 3. Send newly found media links to background worker
    if (newLinks.length > 0) {
      try {
        chrome.runtime.sendMessage({
          action: 'addLinksFromContent',
          links: newLinks
        });
      } catch (e) {
        // Extension context might be invalidated if updated
      }
    }

    // 4. Recursively scan open Shadow Roots for modern Web Components
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
      attributeFilter: ['src']
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