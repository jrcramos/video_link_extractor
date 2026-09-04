// inject.js - Runs in the MAIN page context at document_start
// Safely sniffs JSON API responses, fetch/XHR requests, inline script configs, and DOM media setters
(function() {
  if (window.__VLE_INJECTED__) return;
  window.__VLE_INJECTED__ = true;

  const urlRegex = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|m3u|mp4|webm|m4a|mkv|mov|flv|mp3|aac|wav|ogg|vtt|srt|ttml)(?:[\w\d\-._~:/?#\[\]@!$&'()*+,;=%]*)/gi;
  const signatureRegex = /https?:\/\/[^\s"'<>]+(?:mime=video|mime=audio|mime=text%2Fvtt|format=m3u8|format=mpd|format=hls|format=dash|format=vtt|format=srt|type=m3u8|type=mpd|type=hls|type=dash|type=vtt|type=srt|output=m3u8|stream_type=hls|stream_type=dash|protocol=hls|\/videoplayback\?|\/(?:manifest|playlist|master)\.(?:m3u8|mpd)|\/hls\/|\/dash\/|\/api\/timedtext\?|\/timedtext\?)[^\s"'<>]*/gi;

  // Normalizer that eliminates duplicate parameter variations (e.g. range slices) and blocks .ts/.m4s chunks and blob URLs
  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let u = rawUrl.trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      return null;
    }
    // Strictly block transport stream chunk fragments
    if (/\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i.test(u)) {
      return null;
    }
    try {
      const parsed = new URL(u);
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
      return parsed.toString();
    } catch (e) {
      return u;
    }
  }

  function emitLinks(items) {
    if (!items || items.length === 0) return;
    const cleanMap = new Map();
    items.forEach(item => {
      const u = typeof item === 'string' ? item : (item ? item.url : '');
      const size = (typeof item === 'object' && item.size) ? item.size : 0;
      const poster = (typeof item === 'object' && item.poster) ? item.poster : '';
      const norm = normalizeUrl(u);
      if (norm) {
        let finalSize = size;
        if (!finalSize) {
          try {
            const parsed = new URL(norm);
            if (parsed.searchParams.has('clen')) {
              finalSize = parseInt(parsed.searchParams.get('clen'), 10) || 0;
            } else {
              const dur = parseFloat(parsed.searchParams.get('dur') || '0');
              const bitrate = parseInt(parsed.searchParams.get('bitrate') || '0', 10);
              if (dur > 0 && bitrate > 0) {
                finalSize = Math.round((bitrate / 8) * dur);
              }
            }
          } catch (e) {}
        }
        if (!cleanMap.has(norm)) {
          cleanMap.set(norm, { url: norm, size: finalSize || 0, poster: poster || '' });
        }
      }
    });

    if (cleanMap.size > 0) {
      window.postMessage({
        type: '__VLE_SNIFFED_MEDIA__',
        links: Array.from(cleanMap.values())
      }, '*');
    }
  }

  function scanTextForMedia(text) {
    if (!text || typeof text !== 'string' || text.length > 5000000) return;
    const found = [];

    // 1. YouTube streamingData JSON Parser
    if (text.includes('streamingData') || text.includes('adaptiveFormats') || text.includes('captionTracks')) {
      try {
        const jsonMatch = text.match(/\{[\s\S]*"streamingData"[\s\S]*\}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          if (data && data.streamingData) {
            const formats = [
              ...(data.streamingData.formats || []),
              ...(data.streamingData.adaptiveFormats || [])
            ];
            formats.forEach(f => {
              if (f.url) {
                const size = parseInt(f.contentLength || '0', 10);
                found.push({ url: f.url, size: size });
              }
            });
          }
          if (data && data.captions && data.captions.playerCaptionsTracklistRenderer) {
            const tracks = data.captions.playerCaptionsTracklistRenderer.captionTracks || [];
            tracks.forEach(t => {
              if (t.baseUrl) found.push({ url: t.baseUrl });
            });
          }
        }
      } catch (e) {}
    }

    const matches1 = text.match(urlRegex) || [];
    const matches2 = text.match(signatureRegex) || [];
    found.push(...matches1, ...matches2);

    if (found.length > 0) {
      emitLinks(found);
    }
  }

  // Listen for text scan requests from content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__VLE_SCAN_TEXT__' && event.data.text) {
      scanTextForMedia(event.data.text);
    }
  });

  // 1. Hook fetch API safely without interrupting errors or double-fetching
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      try {
        const input = args[0];
        let requestUrl = '';
        if (typeof input === 'string') {
          requestUrl = input;
        } else if (input && typeof input.url === 'string') {
          requestUrl = input.url;
        }
        if (requestUrl) scanTextForMedia(requestUrl);
      } catch (e) {}

      return originalFetch.apply(this, args).then(response => {
        try {
          if (response && typeof response.clone === 'function') {
            const clone = response.clone();
            const contentType = (clone.headers && typeof clone.headers.get === 'function' && clone.headers.get('content-type')) || '';
            
            if (
              contentType.includes('json') ||
              contentType.includes('text') ||
              contentType.includes('javascript') ||
              contentType.includes('mpegurl') ||
              contentType.includes('dash+xml')
            ) {
              clone.text().then(text => {
                scanTextForMedia(text);
              }).catch(() => {});
            }
          }
        } catch (e) {
          // Response cloning or reading failed; ignore safely so the webpage's fetch is untouched
        }
        return response;
      });
    };
  }

  // 2. Hook XMLHttpRequest
  if (window.XMLHttpRequest) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try {
        this._vle_url = url;
        if (typeof url === 'string') scanTextForMedia(url);
      } catch (e) {}
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      try {
        this.addEventListener('load', () => {
          try {
            const type = this.responseType;
            if (type === '' || type === 'text') {
              if (this.responseText) scanTextForMedia(this.responseText);
            } else if (type === 'json' && this.response) {
              scanTextForMedia(typeof this.response === 'string' ? this.response : JSON.stringify(this.response));
            }
          } catch (e) {}
        });
      } catch (e) {}
      return originalSend.apply(this, args);
    };
  }

  // 3. Hook HTMLMediaElement prototype setters (video/audio src)
  try {
    if (window.HTMLMediaElement) {
      const originalSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      if (originalSrcDesc && originalSrcDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          set: function(val) {
            try {
              if (typeof val === 'string' && val) {
                const poster = this.poster || this.getAttribute('poster') || '';
                emitLinks([{ url: val, poster: poster }]);
              }
            } catch (e) {}
            return originalSrcDesc.set.apply(this, arguments);
          },
          get: originalSrcDesc.get,
          configurable: true
        });
      }
    }
  } catch (e) {}

  // 4. Hook hls.js Hls.prototype.loadSource
  function hookHlsPrototype(HlsObj) {
    try {
      if (HlsObj && HlsObj.prototype && HlsObj.prototype.loadSource && !HlsObj.prototype.__vle_hooked) {
        HlsObj.prototype.__vle_hooked = true;
        const origLoadSource = HlsObj.prototype.loadSource;
        HlsObj.prototype.loadSource = function(url) {
          try {
            if (typeof url === 'string') {
              scanTextForMedia(url);
            }
          } catch (e) {}
          return origLoadSource.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  try {
    if (window.Hls) {
      hookHlsPrototype(window.Hls);
    } else {
      let _hls = window.Hls;
      Object.defineProperty(window, 'Hls', {
        set: function(val) {
          _hls = val;
          hookHlsPrototype(val);
        },
        get: function() {
          return _hls;
        },
        configurable: true
      });
    }
  } catch (e) {}

  // 5. Hook dashjs MediaPlayer.prototype.attachSource
  function hookDashPrototype(dashjsObj) {
    try {
      if (dashjsObj && dashjsObj.MediaPlayer && !dashjsObj.__vle_hooked) {
        dashjsObj.__vle_hooked = true;
        const origCreate = dashjsObj.MediaPlayer;
        dashjsObj.MediaPlayer = function() {
          const player = origCreate.apply(this, arguments);
          if (player && typeof player.attachSource === 'function' && !player.__vle_hooked) {
            player.__vle_hooked = true;
            const origAttach = player.attachSource;
            player.attachSource = function(url) {
              try {
                if (typeof url === 'string') {
                  scanTextForMedia(url);
                }
              } catch (e) {}
              return origAttach.apply(this, arguments);
            };
          }
          return player;
        };
      }
    } catch (e) {}
  }

  try {
    if (window.dashjs) {
      hookDashPrototype(window.dashjs);
    } else {
      let _dashjs = window.dashjs;
      Object.defineProperty(window, 'dashjs', {
        set: function(val) {
          _dashjs = val;
          hookDashPrototype(val);
        },
        get: function() {
          return _dashjs;
        },
        configurable: true
      });
    }
  } catch (e) {}
})();
