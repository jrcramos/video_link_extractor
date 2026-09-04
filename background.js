// background.js - Service Worker with persistent session storage & stream sniffer

// Storage backend: session storage preferred for tab-scoped data surviving SW idle termination
const storage = (chrome.storage && chrome.storage.session) ? chrome.storage.session : (chrome.storage ? chrome.storage.local : null);

// In-memory cache for fast synchronous lookups
const videoLinks = new Map(); // tabId -> Map of canonicalUrl -> { url, referer, poster, size, timestamp, isMobile }
const tabPageUrls = new Map(); // tabId -> string
const tabFrameUrls = new Map(); // tabId -> Map of frameId -> frameUrl
const mobileScanTimers = new Map(); // tabId -> timerId
const saveTimers = new Map(); // tabId -> timerId

// Mobile Safari UA for direct MP4 and mobile stream fallback extraction
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let mobileScanMode = 'smart'; // 'smart' (5s zero-video auto fallback), 'always', 'manual'

// Load saved mobile scan preference
if (chrome.storage && chrome.storage.local) {
  chrome.storage.local.get({ mobileScanMode: 'smart' }, (res) => {
    if (res && res.mobileScanMode) {
      mobileScanMode = res.mobileScanMode;
    }
  });
}

// STRATEGY 1: CLEAN REGEX FILTER (video, audio, subtitles - excluding .ts / .m4s transport fragments)
const videoRegex = /\.(m3u8|mpd|m3u|mp4|webm|mkv|mov|avi|flv|m4v|ogv|wmv|3gp|f4v|mp3|aac|flac|wav|ogg|opus|m4a|vtt|srt|ttml|dfxp|sub)(\?|#|$)/i;

// STRATEGY 2: OBFUSCATED QUERY STRING & SIGNATURE DETECTION (DASH, HLS, Cloudflare, Akamai, Bitmovin, YouTube, Subtitles)
const videoQueryRegex = /(\?|&)(mime=video%2F|mime=video\/|mime=audio%2F|mime=audio\/|mime=text%2Fvtt|format=m3u8|format=mpd|format=hls|format=dash|format=vtt|format=srt|type=m3u8|type=mpd|type=hls|type=dash|type=vtt|type=srt|output=m3u8|stream_type=hls|stream_type=dash|protocol=hls|\/videoplayback\?|\/(?:manifest|playlist|master)\.(?:m3u8|mpd)|\/hls\/|\/dash\/|\/api\/timedtext\?|\/timedtext\?)[^\s"'<>]*/i;

// Comprehensive Canonical URL Normalizer:
// Eliminates duplicate variations, strips ephemeral chunk/slice parameters (e.g. YouTube &sq=... &range=...), and excludes fragments and blob: URLs.
const normalizeUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u = rawUrl.trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  if (!u.startsWith('http://') && !u.startsWith('https://')) return null;

  // Strictly exclude raw transport chunks and slice fragments
  if (/\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i.test(u)) {
    return null;
  }

  try {
    const parsed = new URL(u);

    // List of ephemeral chunk/slice/sequence query parameters that cause duplicate streams for every chunk
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
};

// STRATEGY 3: CONTENT-TYPE & CONTENT-DISPOSITION CHECK (Comprehensive Stream & Subtitle Sniffing)
const isVideoHeader = (headers) => {
  if (!headers) return false;
  
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const val = (header.value || '').toLowerCase();

    if (name === 'content-type') {
      // Exclude raw transport stream chunks from flooding
      if (val.includes('video/mp2t') || val.includes('video/iso.segment') || val.includes('application/octet-stream')) {
        return false;
      }
      
      if (
        val.startsWith('video/') ||
        val.startsWith('audio/') ||
        val.includes('text/vtt') ||
        val.includes('application/x-subrip') ||
        val.includes('application/ttml+xml') ||
        val.includes('text/srt') ||
        val.includes('application/x-mpegurl') ||
        val.includes('application/vnd.apple.mpegurl') ||
        val.includes('audio/x-mpegurl') ||
        val.includes('application/dash+xml') ||
        val.includes('application/f4m+xml') ||
        val.includes('application/vnd.ms-sstr+xml')
      ) {
        return true;
      }
    }

    if (name === 'content-disposition') {
      if (/\.(m3u8|mpd|mp4|webm|mkv|mov|avi|flv|m4v|mp3|aac|wav|ogg|m4a|vtt|srt|ttml)/i.test(val)) {
        return true;
      }
    }
  }
  return false;
};

// Helper to extract content-length from headers
const getContentLength = (headers) => {
  if (!headers) return 0;
  for (const h of headers) {
    if (h.name.toLowerCase() === 'content-length' && h.value) {
      return parseInt(h.value, 10) || 0;
    }
  }
  return 0;
};

// Debounced save to storage to avoid concurrent write collisions
const saveTabLinksDebounced = (tabId) => {
  if (tabId < 0 || !storage) return;
  if (saveTimers.has(tabId)) {
    clearTimeout(saveTimers.get(tabId));
  }
  const timer = setTimeout(() => {
    saveTimers.delete(tabId);
    if (!videoLinks.has(tabId)) return;
    const list = Array.from(videoLinks.get(tabId).values());
    const key = `tab_videos_${tabId}`;
    storage.set({ [key]: list }).catch(() => {});
  }, 100);
  saveTimers.set(tabId, timer);
};

// Helper to retrieve tab links with storage fallback across service worker sleep
const getTabLinks = async (tabId) => {
  if (tabId < 0) return [];
  if (videoLinks.has(tabId) && videoLinks.get(tabId).size > 0) {
    return Array.from(videoLinks.get(tabId).values());
  }
  if (!storage) return [];
  try {
    const key = `tab_videos_${tabId}`;
    const res = await storage.get([key]);
    if (res && Array.isArray(res[key])) {
      let tabMap = videoLinks.get(tabId);
      if (!tabMap) {
        tabMap = new Map();
        videoLinks.set(tabId, tabMap);
      }
      res[key].forEach(item => {
        if (item && item.url) {
          const norm = normalizeUrl(item.url);
          if (norm && !tabMap.has(norm)) {
            tabMap.set(norm, { ...item, url: norm });
          }
        }
      });
      return Array.from(tabMap.values());
    }
  } catch (e) {}
  return [];
};

// Update badge count on toolbar icon
const updateBadge = (tabId) => {
  if (tabId < 0) return;
  const count = videoLinks.has(tabId) ? videoLinks.get(tabId).size : 0;
  const badgeText = count > 0 ? (count > 99 ? '99+' : `${count}`) : '';
  chrome.action.setBadgeText({ text: badgeText, tabId: tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#667eea', tabId: tabId }).catch(() => {});
};

// Helper function to extract referer header from request details with frame-level resolution
const getRefererFromDetails = (details) => {
  // 1. Explicit request Referer header (highest accuracy)
  if (details.requestHeaders) {
    for (const h of details.requestHeaders) {
      if (h.name.toLowerCase() === 'referer' && h.value) return h.value;
    }
  }
  // 2. Iframe origin/URL if the stream was requested inside a sub_frame
  if (details.tabId >= 0 && details.frameId > 0 && tabFrameUrls.has(details.tabId)) {
    const frameMap = tabFrameUrls.get(details.tabId);
    if (frameMap.has(details.frameId)) {
      return frameMap.get(details.frameId);
    }
  }
  // 3. Request initiator (e.g. embed player origin)
  if (details.initiator && details.initiator !== 'null' && !details.initiator.startsWith('chrome-extension')) {
    return details.initiator;
  }
  // 4. Top-level tab URL fallback
  return tabPageUrls.get(details.tabId) || '';
};

// Add detected link to storage with strict canonical deduplication and size metadata
const addLinkToTab = (tabId, rawUrl, referer, poster, isMobile = false, size = 0) => {
  if (tabId < 0 || !rawUrl || typeof rawUrl !== 'string' || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) return;
  const url = normalizeUrl(rawUrl);
  if (!url) return;

  let effectiveSize = size || 0;
  if (!effectiveSize) {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('clen')) {
        effectiveSize = parseInt(parsed.searchParams.get('clen'), 10) || 0;
      } else {
        const dur = parseFloat(parsed.searchParams.get('dur') || '0');
        const bitrate = parseInt(parsed.searchParams.get('bitrate') || '0', 10);
        if (dur > 0 && bitrate > 0) {
          effectiveSize = Math.round((bitrate / 8) * dur);
        }
      }
    } catch (e) {}
  }

  if (!videoLinks.has(tabId)) {
    videoLinks.set(tabId, new Map());
  }
  
  const tabMap = videoLinks.get(tabId);
  const existing = tabMap.get(url);
  
  // If exact canonical URL is already recorded, enhance metadata without duplicating
  if (existing) {
    if (!existing.poster && poster) existing.poster = poster;
    if (!existing.referer && referer) existing.referer = referer;
    if (!existing.size && effectiveSize) existing.size = effectiveSize;
    return;
  }

  const effectiveReferer = referer || tabPageUrls.get(tabId) || '';
  const effectivePoster = poster || '';

  tabMap.set(url, {
    url: url,
    referer: effectiveReferer,
    poster: effectivePoster,
    isMobile: isMobile || false,
    size: effectiveSize || 0,
    timestamp: Date.now()
  });
  
  saveTabLinksDebounced(tabId);
  updateBadge(tabId);
};

// Isolated Mobile User-Agent Probe: Scans page as Mobile Safari for direct MP4 fallbacks
const scanPageWithMobileUA = async (tabId, pageUrl) => {
  if (tabId < 0 || !pageUrl || !pageUrl.startsWith('http')) return [];
  try {
    const response = await fetch(pageUrl, {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"iOS"'
      },
      credentials: 'omit'
    });
    const html = await response.text();
    if (!html) return [];

    const found = [];
    const matches1 = html.match(videoRegex) || [];
    const matches2 = html.match(videoQueryRegex) || [];
    found.push(...matches1, ...matches2);

    // Also scan standard media tags: <video src="...">, <source src="...">, <meta property="og:video">
    const tagSrcRegex = /<(?:video|source|track|meta)[^>]+(?:src|content)=["'](https?:\/\/[^"'>]+)["']/gi;
    let match;
    while ((match = tagSrcRegex.exec(html)) !== null) {
      if (match[1]) found.push(match[1]);
    }

    const added = [];
    const unique = Array.from(new Set(found));
    for (const raw of unique) {
      const norm = normalizeUrl(raw);
      if (norm) {
        addLinkToTab(tabId, norm, pageUrl, '', true, 0);
        added.push(norm);
      }
    }

    return added;
  } catch (e) {
    return [];
  }
};

// Schedule Mobile Scan according to user mode
const scheduleMobileScan = (tabId, pageUrl) => {
  if (mobileScanTimers.has(tabId)) {
    clearTimeout(mobileScanTimers.get(tabId));
    mobileScanTimers.delete(tabId);
  }

  if (mobileScanMode === 'always') {
    scanPageWithMobileUA(tabId, pageUrl);
  } else if (mobileScanMode === 'smart') {
    const timerId = setTimeout(async () => {
      mobileScanTimers.delete(tabId);
      const links = await getTabLinks(tabId);
      // If 0 videos found via standard desktop sniffing in 5 seconds, fire mobile fallback probe
      if (links.length === 0) {
        scanPageWithMobileUA(tabId, pageUrl);
      }
    }, 5000);
    mobileScanTimers.set(tabId, timerId);
  }
};

// Track main frame & sub_frame navigation URLs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab && tab.url && !tab.url.startsWith('chrome://')) {
    const prevUrl = tabPageUrls.get(tabId);
    if (changeInfo.url && prevUrl && changeInfo.url.split('#')[0] !== prevUrl.split('#')[0]) {
      // Top level URL changed: clear old tab links
      videoLinks.delete(tabId);
      tabFrameUrls.delete(tabId);
      if (storage) {
        storage.remove([`tab_videos_${tabId}`]).catch(() => {});
      }
      updateBadge(tabId);
    }
    tabPageUrls.set(tabId, tab.url);
    if (changeInfo.status === 'complete') {
      scheduleMobileScan(tabId, tab.url);
    }
  }
});

// Update badge count on tab switch
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (activeInfo.tabId >= 0) {
    if (!videoLinks.has(activeInfo.tabId)) {
      await getTabLinks(activeInfo.tabId);
    }
    updateBadge(activeInfo.tabId);
  }
});

// LISTENER 1: Frame Navigation Tracker
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId >= 0 && details.url) {
      if (details.type === 'main_frame') {
        tabPageUrls.set(details.tabId, details.url);
      }
      if (details.frameId >= 0) {
        if (!tabFrameUrls.has(details.tabId)) {
          tabFrameUrls.set(details.tabId, new Map());
        }
        tabFrameUrls.get(details.tabId).set(details.frameId, details.url);
      }
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
  ["requestHeaders", "extraHeaders"]
);

// LISTENER 2: Catch URLs by Extension, Manifest format, or Query Signatures
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId >= 0 && details.url) {
      if (details.url.match(videoRegex) || details.url.match(videoQueryRegex)) {
        const referer = getRefererFromDetails(details);
        addLinkToTab(details.tabId, details.url, referer, '', false, 0);
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// LISTENER 3: Catch URLs by Response Content-Type & Disposition Headers (with Content-Length)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId >= 0 && details.url && isVideoHeader(details.responseHeaders)) {
      const referer = getRefererFromDetails(details);
      const size = getContentLength(details.responseHeaders);
      addLinkToTab(details.tabId, details.url, referer, '', false, size);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clean up storage & memory on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  videoLinks.delete(tabId);
  tabPageUrls.delete(tabId);
  tabFrameUrls.delete(tabId);
  if (saveTimers.has(tabId)) {
    clearTimeout(saveTimers.get(tabId));
    saveTimers.delete(tabId);
  }
  if (mobileScanTimers.has(tabId)) {
    clearTimeout(mobileScanTimers.get(tabId));
    mobileScanTimers.delete(tabId);
  }
  if (storage) {
    storage.remove([`tab_videos_${tabId}`, `tab_page_${tabId}`]).catch(() => {});
  }
});

// Set dynamic declarativeNetRequest rule for in-popup video/image preview with custom referer and CORS headers
const setPreviewRefererRule = async (mediaUrl, refererUrl) => {
  if (!chrome.declarativeNetRequest) return;
  if (!mediaUrl || typeof mediaUrl !== 'string' || mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) return;
  try {
    const parsedMedia = new URL(mediaUrl);
    if (!parsedMedia.hostname) return;

    let refOrigin = '';
    let refUrl = refererUrl || '';
    if (refererUrl && (refererUrl.startsWith('http://') || refererUrl.startsWith('https://'))) {
      try {
        const parsedRef = new URL(refererUrl);
        refOrigin = parsedRef.origin;
        refUrl = refererUrl;
      } catch (e) {}
    }
    if (!refOrigin) {
      refOrigin = 'https://' + parsedMedia.hostname;
      refUrl = refOrigin + '/';
    }

    const requestHeaders = [
      { header: 'Referer', operation: 'set', value: refUrl },
      { header: 'Origin', operation: 'set', value: refOrigin }
    ];

    const responseHeaders = [
      { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
      { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS, POST' },
      { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
    ];

    const extId = (chrome.runtime && chrome.runtime.id) ? chrome.runtime.id : '';
    const rules = [
      {
        id: 1001,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: requestHeaders,
          responseHeaders: responseHeaders
        },
        condition: {
          urlFilter: '*',
          ...(extId ? { initiatorDomains: [extId] } : {}),
          resourceTypes: ['media', 'image', 'xmlhttprequest', 'sub_frame', 'other', 'script']
        }
      },
      {
        id: 1002,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: requestHeaders,
          responseHeaders: responseHeaders
        },
        condition: {
          urlFilter: `||${parsedMedia.hostname}`,
          resourceTypes: ['media', 'image', 'xmlhttprequest', 'sub_frame', 'other', 'script']
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002],
      addRules: rules
    });
  } catch (err) {
    console.error('Failed to update preview referer rule:', err);
  }
};

// MESSAGE HANDLING
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // From popup: get links + referers + posters + sizes
  if (request.action === 'getLinks') {
    const tabId = request.tabId;
    Promise.all([
      getTabLinks(tabId),
      new Promise((resolve) => {
        if (tabPageUrls.has(tabId) && tabPageUrls.get(tabId)) {
          resolve(tabPageUrls.get(tabId));
        } else if (tabId >= 0) {
          chrome.tabs.get(tabId, (tab) => {
            if (!chrome.runtime.lastError && tab && tab.url) {
              tabPageUrls.set(tabId, tab.url);
              resolve(tab.url);
            } else {
              resolve('');
            }
          });
        } else {
          resolve('');
        }
      })
    ]).then(([linksArray, pageUrl]) => {
      sendResponse({ links: linksArray, pageUrl: pageUrl, mobileScanMode: mobileScanMode });
    });
    return true;
  } 
  // From popup: clear links
  else if (request.action === 'clearLinks') {
    const tabId = request.tabId;
    videoLinks.delete(tabId);
    if (storage) {
      storage.remove([`tab_videos_${tabId}`]).catch(() => {});
    }
    updateBadge(tabId);
    sendResponse({ success: true });
  }
  // From content.js: add links (with optional poster, size, and frame referer)
  else if (request.action === 'addLinksFromContent') {
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    const fallbackPageUrl = sender.tab ? sender.tab.url : tabPageUrls.get(tabId) || '';
    if (tabId >= 0 && Array.isArray(request.links)) {
      request.links.forEach((item) => {
        if (typeof item === 'string') {
          addLinkToTab(tabId, item, request.frameUrl || fallbackPageUrl, '', false, 0);
        } else if (item && item.url) {
          addLinkToTab(tabId, item.url, item.referer || request.frameUrl || fallbackPageUrl, item.poster || '', false, item.size || 0);
        }
      });
      sendResponse({ success: true });
      return false;
    }
    sendResponse({ success: true });
  }
  // From popup: trigger manual Mobile Fallback probe
  else if (request.action === 'scanMobileFallback') {
    const tabId = request.tabId;
    const pageUrl = tabPageUrls.get(tabId) || '';
    scanPageWithMobileUA(tabId, pageUrl).then(async (added) => {
      const linksArray = await getTabLinks(tabId);
      sendResponse({ success: true, addedCount: added.length, links: linksArray });
    });
    return true;
  }
  // From popup: update mobile scan mode setting
  else if (request.action === 'setMobileMode') {
    mobileScanMode = request.mode || 'smart';
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ mobileScanMode: mobileScanMode });
    }
    sendResponse({ success: true, mode: mobileScanMode });
  }
  // From popup: enable preview referer and CORS rules
  else if (request.action === 'preparePreview') {
    setPreviewRefererRule(request.mediaUrl, request.refererUrl).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
  // From popup: probe size via HEAD request if not already known
  else if (request.action === 'probeMediaSize') {
    const mediaUrl = request.mediaUrl;
    if (!mediaUrl || mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
      sendResponse({ size: 0 });
      return true;
    }
    // Check if clen or dur*bitrate is already in URL
    try {
      const parsed = new URL(mediaUrl);
      if (parsed.searchParams.has('clen')) {
        const clen = parseInt(parsed.searchParams.get('clen'), 10);
        if (clen > 0) {
          sendResponse({ size: clen });
          return true;
        }
      }
      const dur = parseFloat(parsed.searchParams.get('dur') || '0');
      const bitrate = parseInt(parsed.searchParams.get('bitrate') || '0', 10);
      if (dur > 0 && bitrate > 0) {
        sendResponse({ size: Math.round((bitrate / 8) * dur) });
        return true;
      }
    } catch (e) {}

    fetch(mediaUrl, { method: 'HEAD' })
      .then(res => {
        const len = res.headers.get('content-length');
        const size = len ? parseInt(len, 10) : 0;
        sendResponse({ size: size });
      })
      .catch(() => sendResponse({ size: 0 }));
    return true;
  }
  return true; 
});