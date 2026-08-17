// inject.js - Runs in the MAIN page context at document_start
// Safely sniffs JSON API responses, fetch/XHR requests, and MediaSource blobs for video links
(function() {
  if (window.__VLE_INJECTED__) return;
  window.__VLE_INJECTED__ = true;

  const urlRegex = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|mp4|webm|m4a|mkv|mov|flv|mp3|aac|wav|ogg)(?:[\w\d\-._~:/?#\[\]@!$&'()*+,;=%]*)/gi;
  const signatureRegex = /https?:\/\/[^\s"'<>]+(?:mime=video|mime=audio|format=m3u8|format=mpd|\/videoplayback\?)[^\s"'<>]*/gi;

  function emitLinks(urls) {
    if (!urls || urls.length === 0) return;
    const cleanUrls = [];
    urls.forEach(u => {
      if (typeof u === 'string') {
        const trimmed = u.trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          cleanUrls.push(trimmed);
        }
      }
    });

    if (cleanUrls.length > 0) {
      window.postMessage({
        type: '__VLE_SNIFFED_MEDIA__',
        links: cleanUrls
      }, '*');
    }
  }

  function scanTextForMedia(text) {
    if (!text || typeof text !== 'string' || text.length > 5000000) return;
    const matches1 = text.match(urlRegex) || [];
    const matches2 = text.match(signatureRegex) || [];
    const combined = Array.from(new Set([...matches1, ...matches2]));
    emitLinks(combined);
  }

  // 1. Hook window.fetch
  if (window.fetch) {
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = args[0] ? (typeof args[0] === 'string' ? args[0] : args[0].url) : '';
      if (url && typeof url === 'string') {
        scanTextForMedia(url);
      }

      return originalFetch.apply(this, args).then(response => {
        try {
          const contentType = (response.headers && response.headers.get('content-type')) || '';
          if (contentType.includes('application/json') || contentType.includes('text/plain') || contentType.includes('javascript')) {
            response.clone().text().then(text => {
              scanTextForMedia(text);
            }).catch(() => {});
          }
        } catch (e) {}
        return response;
      });
    };
  }

  // 2. Hook XMLHttpRequest
  if (window.XMLHttpRequest) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__vle_url = url;
      if (url && typeof url === 'string') {
        scanTextForMedia(url);
      }
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('load', function() {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('application/json') || ct.includes('text/plain') || ct.includes('javascript')) {
            if (this.responseText) {
              scanTextForMedia(this.responseText);
            }
          }
        } catch (e) {}
      });
      return originalSend.apply(this, args);
    };
  }

  // 3. Hook URL.createObjectURL for MediaSource / Blob Streams
  if (window.URL && window.URL.createObjectURL) {
    const originalCreateObjectURL = window.URL.createObjectURL;
    window.URL.createObjectURL = function(obj) {
      try {
        if (window.MediaSource && obj instanceof MediaSource) {
          // MediaSource stream initialized; fetch/XHR hooks will capture the incoming segments and manifests
        }
      } catch (e) {}
      return originalCreateObjectURL.apply(this, arguments);
    };
  }
})();
