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

  // ---- Add-on: DRM signal channel to content.js -------------------------------------------------
  // inject.js runs at document_start but content.js only at document_idle, so signals are queued until
  // content.js announces itself (__VLE_CONTENT_READY__) and are then delivered in order.
  let drmChannelReady = false;
  const drmQueue = [];
  const seenManifests = new Set();

  function postDrmSignal(payload) {
    window.postMessage({ type: '__VLE_DRM_SIGNAL__', payload: payload }, '*');
  }

  function emitDrmSignal(payload) {
    try {
      if (drmChannelReady) postDrmSignal(payload);
      else if (drmQueue.length < 100) drmQueue.push(payload);
    } catch (e) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== '__VLE_CONTENT_READY__' || drmChannelReady) return;
    drmChannelReady = true;
    drmQueue.splice(0).forEach((p) => { try { postDrmSignal(p); } catch (e) {} });
  });

  // Streaming manifests (DASH / HLS / Smooth) the page downloads: report DRM / encryption they declare
  function reportManifestDrm(text, url) {
    try {
      const drm = window.__VLE_DRM__;
      if (!drm || typeof text !== 'string' || text.length > 3000000) return;
      // Segmented-stream manifest (Spotify player): describes the whole episode so it can be grouped / exported
      const segmented = drm.parseSegmentManifest(text);
      if (segmented) {
        const segKey = `seg|${url}|${segmented.endMs}`;
        if (!seenManifests.has(segKey)) {
          seenManifests.add(segKey);
          emitDrmSignal({ kind: 'segmented', url: url || '', manifest: segmented });
        }
        return;
      }
      const info = drm.analyzeManifest(text);
      if (!info) return;
      const key = `${url}|${text.length}`;
      if (seenManifests.has(key) || seenManifests.size > 300) return;
      seenManifests.add(key);
      emitDrmSignal({ kind: 'manifest', url: url || '', info: info });
    } catch (e) {}
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
    // Add-on: DRM-protected media URLs with no extension (e.g. Spotify's encrypted audio files)
    const drmMatches = window.__VLE_DRM__ ? window.__VLE_DRM__.findDrmUrls(text) : [];
    found.push(...matches1, ...matches2, ...drmMatches);

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
              contentType.includes('dash+xml') ||
              (contentType.includes('xml') && !contentType.includes('svg')) ||
              /\.(?:mpd|m3u8|m3u)(?:[?#]|$)/i.test(response.url || '')
            ) {
              clone.text().then(text => {
                scanTextForMedia(text);
                reportManifestDrm(text, response.url);
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
              if (this.responseText) {
                scanTextForMedia(this.responseText);
                reportManifestDrm(this.responseText, this.responseURL);
              }
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

  // 6. Add-on: Encrypted Media Extensions (EME) observer - tells us the page really plays DRM content.
  // Only real usage counts (a key request / keys attached to a player); merely probing which key systems the
  // browser supports does not. Every wrapper calls straight through to the original and returns its result untouched.
  (function hookEme() {
    const drm = window.__VLE_DRM__;
    if (!drm) return;
    const meta = new WeakMap(); // MediaKeys / MediaKeySession -> { keySystem, robustness }

    function toBytes(data) {
      try {
        if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0, 65536));
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 65536));
      } catch (e) {}
      return new Uint8Array(0);
    }

    function wrap(proto, name, make) {
      try {
        if (!proto || typeof proto[name] !== 'function') return;
        const original = proto[name];
        proto[name] = make(original);
      } catch (e) {}
    }

    // MediaKeySystemAccess.createMediaKeys(): remember which key system (and robustness) the keys belong to
    wrap(window.MediaKeySystemAccess && MediaKeySystemAccess.prototype, 'createMediaKeys', function(original) {
      return function() {
        const promise = original.apply(this, arguments);
        try {
          let robustness = '';
          try {
            const cfg = this.getConfiguration();
            const caps = [].concat(cfg.videoCapabilities || [], cfg.audioCapabilities || []);
            robustness = (caps.find((c) => c && c.robustness) || {}).robustness || '';
          } catch (e) {}
          const info = { keySystem: this.keySystem, robustness: robustness };
          promise.then((keys) => { try { meta.set(keys, info); } catch (e) {} }, () => {});
        } catch (e) {}
        return promise;
      };
    });

    wrap(window.MediaKeys && MediaKeys.prototype, 'createSession', function(original) {
      return function() {
        const session = original.apply(this, arguments);
        try {
          const info = meta.get(this);
          if (info && session) meta.set(session, info);
        } catch (e) {}
        return session;
      };
    });

    // A license request is being generated for real content: init data carries the PSSH / key ids
    wrap(window.MediaKeySession && MediaKeySession.prototype, 'generateRequest', function(original) {
      return function(initDataType, initData) {
        try {
          const info = meta.get(this) || {};
          const parsed = drm.initDataInfo(initDataType, toBytes(initData));
          emitDrmSignal({
            kind: 'eme',
            event: 'generateRequest',
            keySystem: info.keySystem || '',
            system: drm.systemFromKeySystem(info.keySystem),
            robustness: info.robustness || '',
            initDataType: String(initDataType || ''),
            systems: parsed.systems,
            kids: parsed.kids
          });
        } catch (e) {}
        return original.apply(this, arguments);
      };
    });

    // Keys attached to a <video>/<audio> element
    wrap(window.HTMLMediaElement && HTMLMediaElement.prototype, 'setMediaKeys', function(original) {
      return function(keys) {
        try {
          const info = keys && meta.get(keys);
          if (info) {
            emitDrmSignal({
              kind: 'eme',
              event: 'setMediaKeys',
              keySystem: info.keySystem || '',
              system: drm.systemFromKeySystem(info.keySystem),
              robustness: info.robustness || '',
              initDataType: '',
              systems: [],
              kids: []
            });
          }
        } catch (e) {}
        return original.apply(this, arguments);
      };
    });
  })();
})();
