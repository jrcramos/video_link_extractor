// content.js - Injected into pages & all frames to detect embedded media elements, subtitle tracks & poster thumbnails
(function() {
  const detectedUrls = new Set();

  // Helper to extract absolute canonical URLs from an element or string (strictly excluding blob: and data: URLs)
  function resolveUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let trimmed = url.trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed.startsWith('blob:')) {
      return null;
    }
    // Strictly block transport stream chunk fragments
    if (/\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i.test(trimmed)) {
      return null;
    }
    try {
      const parsed = new URL(trimmed, window.location.href);
      if (!parsed.protocol.startsWith('http')) return null;

      const sliceParams = [
        'range', 'rn', 'sq', 'segment', 'seg', 'chunk', 'slice', 
        'part', 'frag', 'fragment', 'rbuf', 'alr', 'keepalive', 
        'sgoap', 'cpn', 'cver', 'bypass_hfr'
      ];
      sliceParams.forEach(p => {
        if (parsed.searchParams.has(p)) {
          parsed.searchParams.delete(p);
        }
      });
      parsed.hash = '';
      return parsed.href;
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
    const frameReferer = window.location.href;

    items.forEach(item => {
      const url = typeof item === 'string' ? item : item.url;
      const poster = (typeof item === 'object' && item.poster) ? resolveUrl(item.poster) : pagePoster;
      const resolved = resolveUrl(url);

      if (resolved && !detectedUrls.has(resolved)) {
        detectedUrls.add(resolved);
        toSend.push({
          url: resolved,
          poster: poster || '',
          referer: frameReferer
        });
      }
    });

    if (toSend.length > 0) {
      try {
        chrome.runtime.sendMessage({
          action: 'addLinksFromContent',
          links: toSend,
          frameUrl: frameReferer
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

  // 1b. Add-on: relay DRM signals (EME usage, DRM manifests) from inject.js to the background worker.
  // inject.js queues signals until it receives __VLE_CONTENT_READY__, so nothing fired at document_start is lost.
  const seenDrmSignals = new Set();
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== '__VLE_DRM_SIGNAL__' || !data.payload || typeof data.payload !== 'object') return;
    let key;
    try { key = JSON.stringify(data.payload); } catch (e) { return; }
    if (seenDrmSignals.has(key) || seenDrmSignals.size > 300) return;
    seenDrmSignals.add(key);
    try {
      chrome.runtime.sendMessage({ action: 'drmSignal', signal: data.payload, frameUrl: window.location.href });
    } catch (e) {
      // Extension context might be invalidated if updated
    }
  });
  window.postMessage({ type: '__VLE_CONTENT_READY__' }, '*');

  // 2. Scan inline scripts on page for embedded player configs
  function scanInlineScripts(root) {
    try {
      const scripts = (root || document).querySelectorAll('script:not([src])');
      scripts.forEach(s => {
        const text = s.textContent;
        if (text && ((window.__VLE_DRM__ && window.__VLE_DRM__.mayContainDrmUrl(text)) || text.includes('videoplayback') || text.includes('.m3u8') || text.includes('.mpd') || text.includes('mime=video') || text.includes('mime=audio') || text.includes('streamingData') || text.includes('captionTracks') || text.includes('timedtext'))) {
          window.postMessage({
            type: '__VLE_SCAN_TEXT__',
            text: text
          }, '*');
        }
      });
    } catch (e) {}
  }

  // 3. Deep scan function that traverses normal DOM and open Shadow Roots
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

      // Check child <track> tags (subtitles / closed captions)
      const tracks = el.querySelectorAll ? el.querySelectorAll('track') : [];
      tracks.forEach((t) => {
        const trackSrc = resolveUrl(t.src) || resolveUrl(t.getAttribute('src'));
        if (trackSrc && !detectedUrls.has(trackSrc)) {
          newItems.push({ url: trackSrc, poster: defaultPoster || '' });
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

    // Check standalone <track> tags
    const standaloneTracks = root.querySelectorAll ? root.querySelectorAll('track[src]') : [];
    standaloneTracks.forEach((t) => {
      const src = resolveUrl(t.src) || resolveUrl(t.getAttribute('src'));
      if (src && !detectedUrls.has(src)) {
        newItems.push({ url: src, poster: defaultPoster || '' });
      }
    });

    // Send newly found media links
    if (newItems.length > 0) {
      reportNewLinks(newItems);
    }

    // Scan inline scripts
    scanInlineScripts(root);

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runScan);
  } else {
    runScan();
  }

  // 4. MutationObserver to capture dynamically injected videos (e.g. SPAs, React/Vue, YouTube navigation)
  let scanDebounceTimer = null;
  const observer = new MutationObserver((mutations) => {
    let hasMedia = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            if (tagName === 'video' || tagName === 'audio' || tagName === 'source' || tagName === 'track' || tagName === 'script' || (node.querySelector && node.querySelector('video, audio, source, track, script'))) {
              hasMedia = true;
              break;
            }
          }
        }
      }
      if (hasMedia) break;
    }
    if (hasMedia) {
      clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(runScan, 200);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Listen for manual scan trigger from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'forceContentScan') {
      runScan();
      sendResponse({ status: 'scanned' });
    }
  });
})();