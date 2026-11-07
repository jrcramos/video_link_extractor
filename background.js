// background.js - Service Worker with persistent session storage & stream sniffer

// Add-on: DRM-protected media URL recognizer (Spotify encrypted audio etc.). Optional - the sniffer works without it.
try { importScripts('drm-streams.js'); } catch (e) { console.warn('drm-streams.js not loaded:', e); }
const drm = self.__VLE_DRM__ || {
  isDrmUrl: () => false, keyFor: (u) => u, analyzeManifest: () => null, analyzeMp4Head: () => null,
  firstPlaylistUri: () => null, isLicenseRequest: () => false, stripQuery: () => '', mergeInfo: (a, b) => a || b || null,
  segmentInfo: () => null, parseSegmentManifest: () => null, genericSegment: () => null, isInitLike: () => false
};

// Storage backend: session storage preferred for tab-scoped data surviving SW idle termination
const storage = (chrome.storage && chrome.storage.session) ? chrome.storage.session : (chrome.storage ? chrome.storage.local : null);

// In-memory cache for fast synchronous lookups
const videoLinks = new Map(); // tabId -> Map of canonicalUrl -> { url, referer, poster, size, timestamp, isMobile }
const tabPageUrls = new Map(); // tabId -> string
const tabFrameUrls = new Map(); // tabId -> Map of frameId -> frameUrl
const mobileScanTimers = new Map(); // tabId -> timerId
const saveTimers = new Map(); // tabId -> timerId
const tabDrm = new Map(); // tabId -> page-level DRM evidence (EME usage, DRM manifests, license servers)
const drmSaveTimers = new Map(); // tabId -> timerId
const tabFamilies = new Map(); // tabId -> Map(familyKey -> numbered-request family), see groupGenericSegments
const tabInits = new Map(); // tabId -> init-file URLs seen (init.mp4, inits/mp4, ...)

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

// Settings (⚙ in the popup): the number of links on the toolbar icon. On unless turned off; turning it off or
// on again updates every tab's icon (a tab's count is read back from storage after a worker restart).
let showIconCount = true;
if (chrome.storage && chrome.storage.local) {
  const applyIconCount = (on) => {
    showIconCount = on;
    chrome.tabs.query({}, (tabs) => (tabs || []).forEach((t) => {
      if (!on) chrome.action.setBadgeText({ text: '', tabId: t.id }).catch(() => {});
      else getTabLinks(t.id).then(() => updateBadge(t.id)).catch(() => {});
    }));
  };
  chrome.storage.local.get({ showIconCount: true }, (res) => { if (res && res.showIconCount === false) applyIconCount(false); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.showIconCount) applyIconCount(changes.showIconCount.newValue !== false);
  });
}

// STRATEGY 1: CLEAN REGEX FILTER (video, audio, subtitles - excluding .ts / .m4s transport fragments)
const videoRegex = /\.(m3u8|mpd|m3u|mp4|webm|mkv|mov|avi|flv|m4v|ogv|wmv|3gp|f4v|mp3|aac|flac|wav|ogg|opus|m4a|vtt|srt|ttml|dfxp|sub)(\?|#|$)/i;

// STRATEGY 2: OBFUSCATED QUERY STRING & SIGNATURE DETECTION (DASH, HLS, Cloudflare, Akamai, Bitmovin, YouTube, Subtitles)
const videoQueryRegex = /(\?|&)(mime=video%2F|mime=video\/|mime=audio%2F|mime=audio\/|mime=text%2Fvtt|format=m3u8|format=mpd|format=hls|format=dash|format=vtt|format=srt|type=m3u8|type=mpd|type=hls|type=dash|type=vtt|type=srt|output=m3u8|stream_type=hls|stream_type=dash|protocol=hls|\/videoplayback\?|\/(?:manifest|playlist|master)\.(?:m3u8|mpd)|\/hls\/|\/dash\/|\/api\/timedtext\?|\/timedtext\?)[^\s"'<>]*/i;

// Comprehensive Canonical URL Normalizer:
// Eliminates duplicate variations, strips ephemeral chunk/slice parameters (e.g. YouTube &sq=... &range=...), and excludes fragments and blob: URLs.
const normalizeUrl = (rawUrl, keepChunks = false) => {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u = rawUrl.trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  if (!u.startsWith('http://') && !u.startsWith('https://')) return null;

  // Strictly exclude raw transport chunks and slice fragments
  if (!keepChunks && /\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i.test(u)) {
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
      if (val.includes('video/mp2t') || val.includes('video/iso.segment')) {
        return false;
      }
      // A generic binary type says nothing either way: a Content-Disposition naming a media file (checked on its own
      // header) still counts, whichever of the two headers the server sends first
      if (val.includes('application/octet-stream')) {
        continue;
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

// Helper to extract the full media size from headers. A 206 range response carries the whole-file size after
// the slash in Content-Range ("bytes 0-4095/12194432"), whereas its Content-Length is only the chunk size.
const getContentLength = (headers) => {
  if (!headers) return 0;
  let length = 0;
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name === 'content-range' && h.value) {
      const total = /\/(\d+)\s*$/.exec(h.value);
      if (total) return parseInt(total[1], 10) || 0;
    } else if (name === 'content-length' && h.value && !length) {
      length = parseInt(h.value, 10) || 0;
    }
  }
  return length;
};

// Chrome stops this worker after ~30 s without events; the in-memory maps are then empty while storage still
// holds each tab's list. A tab's stored list is merged back in (once per worker start) before anything is saved
// for it, so a link found right after a restart cannot overwrite the links found before.
const restoredTabs = new Set(); // tabIds whose stored list has been merged in, or that have nothing to restore
const restoreJobs = new Map(); // tabId -> pending restore
const tabGenerations = new Map(); // tabId -> counter, bumped whenever the tab's list is cleared

// Stored entries into the in-memory map: missing links are added, links already found again keep their newer
// data and take over what only the stored copy had (size, poster, DRM info, detection time, ...)
const mergeStoredLinks = (tabMap, items) => {
  (items || []).forEach((item) => {
    if (!item || !item.url) return;
    const norm = item.segmented ? item.url : normalizeUrl(item.url);
    const key = norm && (item.groupKey || drm.keyFor(norm));
    if (!norm) return;
    const cur = tabMap.get(key);
    if (!cur) {
      tabMap.set(key, { ...item, url: norm });
      return;
    }
    for (const [field, value] of Object.entries(item)) {
      if (value && !cur[field]) cur[field] = value;
    }
    if (item.timestamp && (!cur.timestamp || item.timestamp < cur.timestamp)) cur.timestamp = item.timestamp;
  });
};

const restoreTabLinks = (tabId) => {
  if (tabId < 0 || !storage || restoredTabs.has(tabId)) return Promise.resolve();
  if (restoreJobs.has(tabId)) return restoreJobs.get(tabId);
  const generation = tabGenerations.get(tabId) || 0;
  const key = `tab_videos_${tabId}`;
  const job = storage.get([key]).then((res) => {
    if ((tabGenerations.get(tabId) || 0) !== generation) return; // cleared meanwhile: the stored list is stale
    const stored = res && Array.isArray(res[key]) ? res[key] : [];
    if (!stored.length) return;
    let tabMap = videoLinks.get(tabId);
    if (!tabMap) {
      tabMap = new Map();
      videoLinks.set(tabId, tabMap);
    }
    mergeStoredLinks(tabMap, stored);
    updateBadge(tabId);
  }).catch(() => {}).then(() => {
    restoreJobs.delete(tabId);
    restoredTabs.add(tabId);
  });
  restoreJobs.set(tabId, job);
  return job;
};

// The tab's list was just emptied: nothing stored may be merged back into it
const markTabCleared = (tabId) => {
  tabGenerations.set(tabId, (tabGenerations.get(tabId) || 0) + 1);
  restoredTabs.add(tabId);
};

// Debounced save to storage to avoid concurrent write collisions
const saveTabLinksDebounced = (tabId) => {
  if (tabId < 0 || !storage) return;
  if (saveTimers.has(tabId)) {
    clearTimeout(saveTimers.get(tabId));
  }
  const timer = setTimeout(() => {
    saveTimers.delete(tabId);
    restoreTabLinks(tabId).then(() => {
      if (!videoLinks.has(tabId)) return;
      const list = Array.from(videoLinks.get(tabId).values());
      const key = `tab_videos_${tabId}`;
      storage.set({ [key]: list }).catch(() => {});
    });
  }, 100);
  saveTimers.set(tabId, timer);
};

// Helper to retrieve tab links with storage fallback across service worker sleep
const getTabLinks = async (tabId) => {
  if (tabId < 0) return [];
  await restoreTabLinks(tabId);
  return videoLinks.has(tabId) ? Array.from(videoLinks.get(tabId).values()) : [];
};

// Update badge count on toolbar icon
const updateBadge = (tabId) => {
  if (tabId < 0) return;
  const count = videoLinks.has(tabId) ? videoLinks.get(tabId).size : 0;
  const badgeText = count > 0 && showIconCount ? (count > 99 ? '99+' : `${count}`) : '';
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
const addLinkToTab = (tabId, rawUrl, referer, poster, isMobile = false, size = 0, reqType = '') => {
  if (tabId < 0 || !rawUrl || typeof rawUrl !== 'string' || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) return;
  const url = normalizeUrl(rawUrl);
  if (!url) return;
  restoreTabLinks(tabId); // after a worker restart: bring back the links found before it

  // Add-on: numbered pieces of one stream (seg_1.mp4, seg_2.mp4, ...) collapse into a single entry
  if (groupGenericSegments(tabId, url, reqType, referer || tabPageUrls.get(tabId) || '')) return;

  const segment = drm.segmentInfo(url); // one piece of a segmented stream: its size is not the stream's size
  let effectiveSize = segment ? 0 : (size || 0);
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
  // DRM URLs (same encrypted file, several hosts/tokens) share one key; all other URLs key on themselves
  const key = drm.keyFor(url);
  const existing = tabMap.get(key);
  
  // If exact canonical URL is already recorded, enhance metadata without duplicating
  if (existing) {
    let changed = false;
    if (!existing.poster && poster) { existing.poster = poster; changed = true; }
    if (!existing.referer && referer) { existing.referer = referer; changed = true; }
    if (!existing.size && effectiveSize) { existing.size = effectiveSize; changed = true; }
    if (segment && segment.isInit) {
      const current = drm.segmentInfo(existing.url);
      if (!current || !current.isInit) { existing.url = url; changed = true; }
    }
    if (changed) saveTabLinksDebounced(tabId); // keep it across a worker restart
    return;
  }

  const effectiveReferer = referer || tabPageUrls.get(tabId) || '';
  const effectivePoster = poster || '';

  tabMap.set(key, {
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

// Whole-URL patterns for the mobile page's HTML (same media types and signatures as inject.js). videoRegex /
// videoQueryRegex above only test a URL that is already known; on raw HTML they return fragments such as ".mp4?".
const htmlMediaUrlRegex = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|m3u|mp4|webm|mkv|mov|avi|flv|m4v|ogv|wmv|3gp|f4v|mp3|aac|flac|wav|ogg|opus|m4a|vtt|srt|ttml|dfxp)(?=[?#"'<>\s\\]|$)[^\s"'<>\\]*/gi;
const htmlSignatureUrlRegex = /https?:\/\/[^\s"'<>\\]+(?:mime=video|mime=audio|mime=text%2Fvtt|format=m3u8|format=mpd|format=hls|format=dash|format=vtt|format=srt|type=m3u8|type=mpd|type=hls|type=dash|type=vtt|type=srt|output=m3u8|stream_type=hls|stream_type=dash|protocol=hls|\/videoplayback\?|\/(?:manifest|playlist|master)\.(?:m3u8|mpd)|\/hls\/|\/dash\/|\/api\/timedtext\?|\/timedtext\?)[^\s"'<>\\]*/gi;

// fetch() cannot set User-Agent or Sec-CH-UA-* (Chrome drops them silently), so the probe request gets them from a
// short-lived session rule that only matches this worker's own requests to the page's site.
const MOBILE_UA_RULE_BASE = 1200;
let mobileUaRuleSeq = 0;
const withMobileUA = async (pageUrl, fn) => {
  const dnr = chrome.declarativeNetRequest;
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^(?:www|m|mobile)\./i, ''); } catch (e) {}
  if (!dnr || !dnr.updateSessionRules || !host) return fn();
  const id = MOBILE_UA_RULE_BASE + (mobileUaRuleSeq++ % 50);
  const ua = { header: 'User-Agent', operation: 'set', value: MOBILE_UA };
  const hints = [
    { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?1' },
    { header: 'Sec-CH-UA-Platform', operation: 'set', value: '"iOS"' },
    { header: 'Sec-CH-UA', operation: 'remove' }
  ];
  const rule = (requestHeaders) => ({
    id: id,
    priority: 5,
    action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
    condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id], tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ['xmlhttprequest'] }
  });
  let added = false;
  for (const headers of [[ua, ...hints], [ua]]) { // fall back to the User-Agent alone if a hint header is refused
    try {
      await dnr.updateSessionRules({ removeRuleIds: [id], addRules: [rule(headers)] });
      added = true;
      break;
    } catch (e) {}
  }
  try {
    return await fn();
  } finally {
    if (added) dnr.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
};

// Isolated Mobile User-Agent Probe: Scans page as Mobile Safari for direct MP4 fallbacks
const scanPageWithMobileUA = async (tabId, pageUrl) => {
  if (tabId < 0 || !pageUrl || !pageUrl.startsWith('http')) return [];
  try {
    const target = pageUrl.split('#')[0];
    const response = await withMobileUA(target, () => fetch(target, {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"iOS"'
      },
      credentials: 'omit'
    }));
    const raw = await response.text();
    if (!raw) return [];
    // URLs inside inline JSON / attributes: undo the usual escaping so whole URLs can be matched
    const html = raw.replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const baseUrl = response.url || target;

    const found = [];
    found.push(...(html.match(htmlMediaUrlRegex) || []), ...(html.match(htmlSignatureUrlRegex) || []));
    if (typeof drm.findDrmUrls === 'function') found.push(...drm.findDrmUrls(html));

    // Also scan standard media tags: <video src="...">, <source src="...">, <meta property="og:video">
    const tagSrcRegex = /<(?:video|source|track|meta)[^>]+(?:src|content)=["'](https?:\/\/[^"'>]+)["']/gi;
    let match;
    while ((match = tagSrcRegex.exec(html)) !== null) {
      if (match[1]) found.push(match[1]);
    }
    // Media tags with a relative src ("/media/clip.mp4")
    const relSrcRegex = /<(?:video|audio|source|track)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;
    while ((match = relSrcRegex.exec(html)) !== null) {
      try { if (match[1]) found.push(new URL(match[1], baseUrl).toString()); } catch (e) {}
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
      // (links only the newer add-on modules have found do not count: addon2-worker.js, addon.onlyNew)
      if (links.filter((l) => !(l && l.addon && l.addon.onlyNew)).length === 0) {
        scanPageWithMobileUA(tabId, pageUrl);
      }
    }, 5000);
    mobileScanTimers.set(tabId, timerId);
  }
};

// ---- One list per page -------------------------------------------------------------------------
// When the tab's page URL changes (a link, the address bar, or an in-page route change; not just the #hash),
// the list starts again for the new page. The previous page's list is kept in a short per-tab history, so
// going Back (or opening that page again in the tab) brings it back.
// The page URL is tracked here from tabs.onUpdated (the page that is actually shown), not from main_frame
// requests: those arrive before the new page replaces the old one, and may never replace it (downloads, 204s).
const tabTopUrls = new Map(); // tabId -> URL of the page shown in the tab
const tabHistory = new Map(); // tabId -> [{ page, links, drm }], most recent first
const tabPageJobs = new Map(); // tabId -> queue, so page changes of one tab are handled in order
const HISTORY_PAGES = 3;
const pageKey = (u) => String(u || '').split('#')[0];

const loadTabHistory = async (tabId) => {
  if (tabHistory.has(tabId)) return tabHistory.get(tabId);
  let list = [];
  if (storage) {
    try {
      const key = `tab_hist_${tabId}`;
      const res = await storage.get([key]);
      if (res && Array.isArray(res[key])) list = res[key];
    } catch (e) {}
  }
  if (!tabHistory.has(tabId)) tabHistory.set(tabId, list);
  return tabHistory.get(tabId);
};

const saveTabHistory = (tabId) => {
  if (!storage || !tabHistory.has(tabId)) return;
  storage.set({ [`tab_hist_${tabId}`]: tabHistory.get(tabId) }).catch(() => {});
};

// The tab now shows newUrl instead of prevUrl. Links found before navTime belong to the previous page.
const switchTabPage = async (tabId, prevUrl, newUrl, navTime) => {
  await restoreTabLinks(tabId); // after a worker restart, the previous page's list may only be in storage
  const prevDrm = await loadTabDrm(tabId);
  const history = await loadTabHistory(tabId);

  const tabMap = videoLinks.get(tabId) || new Map();
  const oldLinks = [];
  const nextMap = new Map();
  for (const [key, entry] of tabMap) {
    if ((entry.timestamp || 0) < navTime) oldLinks.push(entry);
    else nextMap.set(key, entry); // already found on the new page
  }

  const oldPage = pageKey(prevUrl);
  const newPage = pageKey(newUrl);
  const kept = history.filter((h) => h && h.page !== oldPage && h.page !== newPage);
  const comingBack = history.find((h) => h && h.page === newPage);
  if (oldLinks.length || (prevDrm && prevDrm.active)) kept.unshift({ page: oldPage, links: oldLinks, drm: prevDrm || null });
  tabHistory.set(tabId, kept.slice(0, HISTORY_PAGES));

  markTabCleared(tabId);
  videoLinks.set(tabId, nextMap);
  tabFrameUrls.delete(tabId);
  tabDrm.delete(tabId);
  tabFamilies.delete(tabId);
  tabInits.delete(tabId);
  if (storage) storage.remove([`tab_drm_${tabId}`]).catch(() => {});

  if (comingBack) {
    mergeStoredLinks(nextMap, comingBack.links);
    if (comingBack.drm) {
      tabDrm.set(tabId, { ...newTabDrm(), ...comingBack.drm });
      saveTabDrmDebounced(tabId);
    }
  }
  saveTabLinksDebounced(tabId);
  saveTabHistory(tabId);
  updateBadge(tabId);
};

const onTabShown = (tabId, shownUrl, navTime) => {
  const run = async () => {
    let prevUrl = tabTopUrls.get(tabId);
    if (prevUrl === undefined && storage) {
      // the worker was restarted since this tab's last page change: its page URL is only in storage
      try {
        const key = `tab_page_${tabId}`;
        const res = await storage.get([key]);
        if (res && typeof res[key] === 'string') prevUrl = res[key];
      } catch (e) {}
    }
    tabTopUrls.set(tabId, shownUrl);
    if (prevUrl === shownUrl) return;
    if (storage) storage.set({ [`tab_page_${tabId}`]: shownUrl }).catch(() => {});
    if (prevUrl && pageKey(prevUrl) !== pageKey(shownUrl)) await switchTabPage(tabId, prevUrl, shownUrl, navTime);
  };
  const job = (tabPageJobs.get(tabId) || Promise.resolve()).then(run).catch(() => {});
  tabPageJobs.set(tabId, job);
  job.then(() => { if (tabPageJobs.get(tabId) === job) tabPageJobs.delete(tabId); });
};

// Track main frame & sub_frame navigation URLs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab && tab.url && !tab.url.startsWith('chrome://')) {
    onTabShown(tabId, tab.url, Date.now());
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

// Add-on: some players fetch their (encrypted) media from a Worker / Service Worker, which Chrome reports with
// tabId -1. Attribute such requests, for recognised DRM URLs only, to the tab(s) of the requesting site.
const attributeWorkerRequest = async (details, size) => {
  try {
    let origin = '';
    try { origin = new URL(details.initiator || '').origin; } catch (e) {}
    if (!/^https?:/i.test(origin)) return;
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    const audible = tabs.filter((t) => t.audible);
    (audible.length ? audible : tabs).forEach((t) => {
      if (t.id >= 0) addLinkToTab(t.id, details.url, origin + '/', '', false, size || 0);
    });
  } catch (e) {}
};

// LISTENER 2: Catch URLs by Extension, Manifest format, or Query Signatures
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 && details.url && drm.isDrmUrl(details.url)) {
      attributeWorkerRequest(details, 0);
    }
    if (details.tabId >= 0 && details.url) {
      if (details.url.match(videoRegex) || details.url.match(videoQueryRegex) || drm.isDrmUrl(details.url)) {
        const referer = getRefererFromDetails(details);
        addLinkToTab(details.tabId, details.url, referer, '', false, 0, details.type);
      }
      if (CHUNK_URL_RE.test(details.url)) noteChunk(details.tabId, details.url, details.type, getRefererFromDetails(details));
      // Add-on: a POST to something that looks like a DRM license server (only shown once DRM playback is confirmed)
      if (details.method === 'POST' && details.type === 'xmlhttprequest' && drm.isLicenseRequest(details.url, details.method)) {
        noteLicenseCandidate(details.tabId, details.url);
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// LISTENER 3: Catch URLs by Response Content-Type & Disposition Headers (with Content-Length)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 && details.url && drm.isDrmUrl(details.url)) {
      attributeWorkerRequest(details, getContentLength(details.responseHeaders));
    }
    if (details.tabId >= 0 && details.url && !CHUNK_URL_RE.test(details.url) && isChunkHeader(details.responseHeaders)) {
      noteChunk(details.tabId, details.url, details.type, getRefererFromDetails(details));
    }
    if (details.tabId >= 0 && details.url && (isVideoHeader(details.responseHeaders) || drm.isDrmUrl(details.url))) {
      const referer = getRefererFromDetails(details);
      const size = getContentLength(details.responseHeaders);
      addLinkToTab(details.tabId, details.url, referer, '', false, size, details.type);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clean up storage & memory on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  markTabCleared(tabId);
  videoLinks.delete(tabId);
  tabPageUrls.delete(tabId);
  tabTopUrls.delete(tabId);
  tabHistory.delete(tabId);
  tabFrameUrls.delete(tabId);
  if (saveTimers.has(tabId)) {
    clearTimeout(saveTimers.get(tabId));
    saveTimers.delete(tabId);
  }
  if (mobileScanTimers.has(tabId)) {
    clearTimeout(mobileScanTimers.get(tabId));
    mobileScanTimers.delete(tabId);
  }
  tabDrm.delete(tabId);
  tabFamilies.delete(tabId);
  tabInits.delete(tabId);
  if (drmSaveTimers.has(tabId)) {
    clearTimeout(drmSaveTimers.get(tabId));
    drmSaveTimers.delete(tabId);
  }
  if (storage) {
    storage.remove([`tab_videos_${tabId}`, `tab_page_${tabId}`, `tab_drm_${tabId}`, `tab_hist_${tabId}`]).catch(() => {});
  }
});

// Earlier versions stored the preview rules as persistent dynamic rules that also applied to every tab.
// Remove any left over; they are now session rules (see setPreviewRefererRule).
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules) {
  chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1001, 1002] }).catch(() => {});
}

// Set session declarativeNetRequest rules for in-popup video/image preview with custom referer and CORS headers
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
    // Session rules (gone on browser restart). Rule 1002 only matches requests made outside any tab (the popup
    // player, this worker), so the Referer / CORS headers never leak into the pages you browse.
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
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['media', 'image', 'xmlhttprequest', 'sub_frame', 'other', 'script']
        }
      }
    ];

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1001, 1002],
      addRules: rules
    });
  } catch (err) {
    console.error('Failed to update preview referer rule:', err);
  }
};

// ============================================================================================
// Add-on: generic segmented streams. Players that fetch a stream as numbered pieces (seg_1.mp4, seg_2.mp4, ...)
// would otherwise flood the list with one entry per piece. A family of requests becomes ONE entry only when:
//   - >= 3 distinct requests share folder + name pattern + query parameter names
//   - exactly one number in the name changes, in a steady step
//   - they were fetched by page code (fetch / XHR), not by a plain <video>/<audio> tag: files of a gallery
//     (clip1.mp4, clip2.mp4, clip3.mp4) are separate videos and always stay separate
// ============================================================================================
const SEG_REQ_TYPES = new Set(['xmlhttprequest', 'other']);
const CHUNK_URL_RE = /\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i;

// .ts / .m4s / .m4f pieces are never listed one by one. They only feed the grouping below, and show up as ONE
// entry when enough of them form a numbered stream.
const noteChunk = (tabId, rawUrl, reqType, referer) => {
  if (tabId < 0 || !SEG_REQ_TYPES.has(reqType)) return;
  const url = normalizeUrl(rawUrl, true);
  if (!url) return;
  restoreTabLinks(tabId);
  groupGenericSegments(tabId, url, reqType, referer || tabPageUrls.get(tabId) || '');
};
const isChunkHeader = (headers) => (headers || []).some((h) => h.name.toLowerCase() === 'content-type' && /video\/mp2t|audio\/mp2t|video\/iso\.segment/i.test(h.value || ''));
const SEG_MAX_MEMBERS = 5000;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const constSigOf = (digits, vary) => digits.map((d, i) => (i === vary ? '*' : d)).join('|');

const qualifyFamily = (fam) => {
  if (fam.members.size < 3) return false;
  const rows = Array.from(fam.members.values(), (m) => m.digits);
  let vary = -1;
  for (let i = 0; i < rows[0].length; i++) {
    if (new Set(rows.map((r) => r[i])).size > 1) {
      if (vary !== -1) return false; // two numbers change: not a simple numbered stream
      vary = i;
    }
  }
  if (vary < 0) return false;
  const nums = Array.from(new Set(rows.map((r) => parseInt(r[vary], 10)))).sort((a, b) => a - b);
  if (nums.length < 3) return false;
  let step = 0;
  for (const n of nums) step = gcd(step, n - nums[0]);
  if (step < 1 || (nums[nums.length - 1] - nums[0]) / step > 20000) return false;
  fam.vary = vary;
  fam.step = step;
  fam.constSig = constSigOf(rows[0], vary);
  fam.groupKey = `segfam:${fam.famKey}|${fam.constSig}`;
  return true;
};

// URL of the piece with the changing number replaced by a placeholder
const familyTemplate = (fam, url) => {
  const t = drm.genericSegment(url);
  if (!t) return '';
  let i = 0;
  const stem = t.stem.replace(/\d+/g, (d) => (i++ === fam.vary ? '{{segment_timestamp}}' : d));
  return t.origin + t.dir + stem + (t.ext ? `.${t.ext}` : '') + t.search;
};

// (Re)build the single entry of a qualified family from every member seen so far
const syncFamilyEntry = (tabId, fam, referer) => {
  let tabMap = videoLinks.get(tabId);
  if (!tabMap) { tabMap = new Map(); videoLinks.set(tabId, tabMap); }
  const rows = [];
  for (const [u, m] of fam.members) {
    if (constSigOf(m.digits, fam.vary) !== fam.constSig) continue;
    rows.push({ u: u, n: parseInt(m.digits[fam.vary], 10), search: m.search, digits: m.digits });
  }
  rows.sort((a, b) => a.n - b.n);
  if (!rows.length) return;

  let inheritedReferer = '';
  for (const r of rows) { // absorb the individual entries created before the family was recognised
    const old = tabMap.get(r.u);
    if (old) { inheritedReferer = inheritedReferer || old.referer || ''; tabMap.delete(r.u); }
  }
  const initUrl = (tabInits.get(tabId) || []).find((u) => {
    try { const p = new URL(u); return p.origin === fam.origin && p.pathname.startsWith(fam.dir); } catch (e) { return false; }
  }) || '';
  if (initUrl) tabMap.delete(initUrl);

  let entry = tabMap.get(fam.groupKey);
  const sameSearch = rows.every((r) => r.search === rows[0].search);
  const template = sameSearch ? familyTemplate(fam, rows[0].u) : '';
  let first = rows[0].n;
  let last = rows[rows.length - 1].n;
  const prev = entry && entry.segmented;
  if (prev && prev.generic && template && prev.segmentUrlTemplate === template) { // e.g. restored after a service worker sleep
    first = Math.min(first, prev.first);
    last = Math.max(last, prev.first + (prev.count - 1) * prev.step);
  }
  const digitText = rows[0].digits[fam.vary];
  const meta = {
    provider: (() => { try { return new URL(fam.origin).hostname; } catch (e) { return ''; } })(),
    generic: true,
    kind: fam.kind,
    mime: '', codec: '', bitrate: 0, width: 0, height: 0,
    segLen: 0, endMs: 0,            // real durations are unknown for a generic stream
    assumedDur: fam.step >= 2 ? fam.step : 4,
    first: first, step: fam.step, pad: digitText.length > 1 && digitText[0] === '0' ? digitText.length : 0,
    count: Math.round((last - first) / fam.step) + 1,
    observed: rows.length,
    encrypted: false,
    initUrl: initUrl
  };
  if (template) meta.segmentUrlTemplate = template;
  else { meta.urls = rows.map((r) => r.u).slice(0, 2000); meta.count = meta.urls.length; }

  if (!entry) {
    entry = {
      url: '', referer: referer || inheritedReferer || tabPageUrls.get(tabId) || '', poster: '', isMobile: false,
      size: 0, timestamp: Date.now(), groupKey: fam.groupKey
    };
    tabMap.set(fam.groupKey, entry);
  }
  entry.url = initUrl || rows[0].u;
  entry.segmented = meta;
  saveTabLinksDebounced(tabId);
  updateBadge(tabId);
};

// true when this URL was absorbed into a segmented-stream entry (the caller then must not add it on its own)
const groupGenericSegments = (tabId, url, reqType, referer) => {
  if (drm.segmentInfo(url)) return false; // Spotify: exact grouping elsewhere

  if (drm.isInitLike(url)) {
    let inits = tabInits.get(tabId);
    if (!inits) { inits = []; tabInits.set(tabId, inits); }
    if (!inits.includes(url) && inits.length < 60) inits.push(url);
    const fams = tabFamilies.get(tabId);
    if (fams) {
      for (const fam of fams.values()) {
        if (!fam.groupKey) continue;
        let p;
        try { p = new URL(url); } catch (e) { continue; }
        if (p.origin === fam.origin && p.pathname.startsWith(fam.dir)) { syncFamilyEntry(tabId, fam, referer); return true; }
      }
    }
    return false;
  }

  const seg = drm.genericSegment(url);
  if (!seg) return false;
  let fams = tabFamilies.get(tabId);
  if (!fams) { fams = new Map(); tabFamilies.set(tabId, fams); }
  let fam = fams.get(seg.famKey);
  if (!fam) {
    if (!SEG_REQ_TYPES.has(reqType)) return false; // only page code (fetch / XHR) starts a family
    if (fams.size >= 200) return false;
    fam = { famKey: seg.famKey, origin: seg.origin, dir: seg.dir, kind: seg.kind, members: new Map(), groupKey: '' };
    fams.set(seg.famKey, fam);
  }

  if (fam.groupKey) {
    if (constSigOf(seg.digits, fam.vary) !== fam.constSig) return false; // another rendition using the same name pattern
    if (!fam.members.has(url)) {
      if (fam.members.size >= SEG_MAX_MEMBERS) return true;
      fam.members.set(url, { digits: seg.digits, search: seg.search });
    }
    syncFamilyEntry(tabId, fam, referer);
    return true;
  }

  if (!SEG_REQ_TYPES.has(reqType)) return false;
  if (!fam.members.has(url)) {
    if (fam.members.size >= SEG_MAX_MEMBERS) return false;
    fam.members.set(url, { digits: seg.digits, search: seg.search });
  }
  if (qualifyFamily(fam)) {
    syncFamilyEntry(tabId, fam, referer);
    return true;
  }
  return false;
};

// ============================================================================================
// Add-on: DRM detection. Labels only - nothing here decrypts media or requests a license.
//   1. page-level evidence  (EME usage reported by inject.js, DRM manifests, license-server requests)
//   2. per-link annotation  (manifest / MP4 header analysis -> entry.drm)
//   3. on-demand probing    (popup asks; we read a manifest or the first 64 KB of a listed file)
// ============================================================================================
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, maxLen)).slice(0, maxItems) : []);
const isKid = (k) => /^[0-9a-f]{32}$/.test(k);
const addAll = (target, items, max) => {
  for (const it of items) {
    if (it && !target.includes(it) && target.length < max) target.push(it);
  }
};

const newTabDrm = () => ({ active: false, systems: [], robustness: [], kids: [], license: [], licenseCandidates: [], sources: [], events: 0, updated: 0 });

// Untrusted input (it comes from page scripts via content.js): clamp shapes and sizes
const sanitizeInfo = (info) => {
  if (!info || typeof info !== 'object') return null;
  return {
    type: info.type === 'aes' ? 'aes' : 'drm',
    systems: strList(info.systems, 10, 40),
    scheme: str(info.scheme, 30) || null,
    kids: strList(info.kids, 20, 32).filter(isKid),
    license: strList(info.license, 5, 300).filter((u) => /^https?:\/\//i.test(u)),
    sources: strList(info.sources, 6, 20)
  };
};

const saveTabDrmDebounced = (tabId) => {
  if (tabId < 0 || !storage) return;
  if (drmSaveTimers.has(tabId)) clearTimeout(drmSaveTimers.get(tabId));
  drmSaveTimers.set(tabId, setTimeout(() => {
    drmSaveTimers.delete(tabId);
    if (!tabDrm.has(tabId)) return;
    storage.set({ [`tab_drm_${tabId}`]: tabDrm.get(tabId) }).catch(() => {});
  }, 100));
};

// Page-level record for a tab, restored from storage after a service worker sleep. Callers mutate the shared
// object synchronously after this resolves, so concurrent signals cannot overwrite each other.
const loadTabDrm = async (tabId) => {
  if (tabDrm.has(tabId)) return tabDrm.get(tabId);
  let rec = null;
  if (storage) {
    try {
      const key = `tab_drm_${tabId}`;
      const res = await storage.get([key]);
      if (res && res[key] && typeof res[key] === 'object') rec = { ...newTabDrm(), ...res[key] };
    } catch (e) {}
  }
  if (tabDrm.has(tabId)) return tabDrm.get(tabId);
  if (rec) tabDrm.set(tabId, rec);
  return rec;
};

const ensureTabDrm = async (tabId) => {
  let rec = await loadTabDrm(tabId);
  if (!rec) {
    rec = tabDrm.get(tabId) || newTabDrm();
    tabDrm.set(tabId, rec);
  }
  return rec;
};

// Summary for the popup; null unless DRM playback / DRM content was actually confirmed on the page
const getTabDrmSummary = async (tabId) => {
  if (tabId < 0) return null;
  const rec = await loadTabDrm(tabId);
  if (!rec || !rec.active) return null;
  const license = [];
  addAll(license, [...rec.license, ...rec.licenseCandidates], 5);
  return { systems: rec.systems, robustness: rec.robustness, kids: rec.kids, license: license, sources: rec.sources, events: rec.events };
};

const noteLicenseCandidate = async (tabId, url) => {
  const clean = drm.stripQuery(url);
  if (!clean) return;
  const rec = await ensureTabDrm(tabId);
  addAll(rec.licenseCandidates, [clean.slice(0, 300)], 5);
  saveTabDrmDebounced(tabId);
};

// Attach encryption info to a listed link (creating the entry if the URL was not sniffed by extension / header)
const annotateLink = async (tabId, rawUrl, info, frameUrl) => {
  if (tabId < 0 || !info) return;
  await getTabLinks(tabId); // restore the map first if the service worker was asleep
  const url = normalizeUrl(rawUrl);
  if (!url) return;
  const key = drm.keyFor(url);
  let tabMap = videoLinks.get(tabId);
  if (!tabMap || !tabMap.has(key)) {
    addLinkToTab(tabId, url, frameUrl || '', '', false, 0);
    tabMap = videoLinks.get(tabId);
  }
  const entry = tabMap && tabMap.get(key);
  if (!entry) return;
  entry.drm = drm.mergeInfo(entry.drm, info);
  entry.drmChecked = true;
  saveTabLinksDebounced(tabId);
};

// Segmented stream (Spotify player): the manifest describes the whole episode. Attach it to the one grouped
// entry per stream (best audio + best video) so the popup can show it as a single item and export an .m3u8.
const applySegmentedSignal = async (tabId, signal, frameUrl) => {
  if (tabId < 0) return;
  const m = signal && signal.manifest;
  if (!m || typeof m !== 'object') return;
  const baseUrl = str(m.baseUrl, 500);
  const initTemplate = str(m.initTemplate, 4000);
  const segmentTemplate = str(m.segmentTemplate, 4000);
  const segLen = Number(m.segLen);
  const endMs = Number(m.endMs);
  if (!/^https?:\/\//i.test(baseUrl) || !initTemplate || !segmentTemplate.includes('{{segment_timestamp}}')) return;
  if (!(segLen >= 1 && segLen <= 60) || !(endMs > 0 && endMs < 86400000)) return;
  const profiles = (Array.isArray(m.profiles) ? m.profiles : []).slice(0, 30).map((p) => ({
    id: Number(p && p.id),
    mime: str(p && p.mime, 30),
    maxBitrate: Number(p && p.maxBitrate) || 0,
    codec: str(p && p.codec, 30),
    w: Number(p && p.w) || 0,
    h: Number(p && p.h) || 0
  })).filter((p) => Number.isInteger(p.id) && p.id >= 0);

  const audio = profiles.filter((p) => p.mime.startsWith('audio/')).sort((a, b) => b.maxBitrate - a.maxBitrate)[0];
  const video = profiles.filter((p) => p.mime.startsWith('video/')).sort((a, b) => (b.h - a.h) || (b.maxBitrate - a.maxBitrate))[0];
  const wanted = new Set([audio, video].filter(Boolean).map((p) => p.id));

  await getTabLinks(tabId); // restore the map first if the service worker was asleep
  for (const p of profiles) {
    const fill = (t) => (baseUrl + t).split('{{profile_id}}').join(String(p.id)).split('{{file_type}}').join('mp4');
    const initUrl = fill(initTemplate);
    const info = drm.segmentInfo(initUrl);
    if (!info) continue;
    const key = drm.keyFor(initUrl);
    let tabMap = videoLinks.get(tabId);
    let entry = tabMap && tabMap.get(key);
    if (!entry && wanted.has(p.id)) {
      addLinkToTab(tabId, initUrl, frameUrl || '', '', false, 0);
      tabMap = videoLinks.get(tabId);
      entry = tabMap && tabMap.get(key);
    }
    if (!entry) continue; // a quality the player never used: not listed
    entry.url = normalizeUrl(initUrl) || initUrl;
    entry.segmented = {
      provider: 'Spotify',
      kind: p.mime.startsWith('audio/') ? 'audio' : 'video',
      mime: p.mime,
      codec: p.codec,
      bitrate: p.maxBitrate,
      width: p.w,
      height: p.h,
      segLen: segLen,
      endMs: endMs,
      count: Math.ceil(endMs / 1000 / segLen),
      first: 0,
      step: segLen,
      pad: 0,
      encrypted: !!m.encrypted,
      initUrl: initUrl,
      segmentUrlTemplate: fill(segmentTemplate)
    };
    if (p.maxBitrate) entry.size = Math.round((p.maxBitrate / 8) * (endMs / 1000)); // estimate, from the peak bitrate
  }
  saveTabLinksDebounced(tabId);
};

// Signals relayed by content.js from inject.js
const applyDrmSignal = async (tabId, signal, frameUrl) => {
  if (tabId < 0 || !signal || typeof signal !== 'object') return;
  if (signal.kind === 'segmented') {
    await applySegmentedSignal(tabId, signal, frameUrl);
  } else if (signal.kind === 'eme') {
    const rec = await ensureTabDrm(tabId);
    rec.active = true;
    rec.events = (rec.events || 0) + 1;
    addAll(rec.systems, [str(signal.system, 40), ...strList(signal.systems, 10, 40)], 10);
    addAll(rec.robustness, [str(signal.robustness, 40)], 6);
    addAll(rec.kids, strList(signal.kids, 20, 32).filter(isKid), 20);
    addAll(rec.sources, ['eme'], 6);
    rec.updated = Date.now();
    saveTabDrmDebounced(tabId);
  } else if (signal.kind === 'manifest') {
    const info = sanitizeInfo(signal.info);
    if (!info) return;
    if (info.type === 'drm') {
      const rec = await ensureTabDrm(tabId);
      rec.active = true;
      addAll(rec.systems, info.systems, 10);
      addAll(rec.kids, info.kids, 20);
      addAll(rec.license, info.license, 5);
      addAll(rec.sources, ['manifest'], 6);
      rec.updated = Date.now();
      saveTabDrmDebounced(tabId);
    }
    const url = str(signal.url, 2000);
    if (/^https?:\/\//i.test(url)) await annotateLink(tabId, url, info, frameUrl);
  }
};

// ---- on-demand probing ---------------------------------------------------------------------
const DRM_HEAD_BYTES = 65536;        // enough for an MP4 init segment (ftyp + moov with pssh / schm / tenc)
const DRM_TEXT_MAX = 1048576;        // manifests can be bigger; stop reading here
const DRM_PROBE_TIMEOUT_MS = 9000;
const DRM_PROBE_MAX_ATTEMPTS = 2;
const DRM_PROBE_SKIP = /\.(mp3|wav|aac|flac|ogg|opus|vtt|srt|ttml|dfxp|sub|jpe?g|png|gif|webp|svg|ts|mp2t)(\?|#|$)/i;
let probeRuleSeq = 0;
let probesRunning = 0;
const probeWaiters = [];

const acquireProbeSlot = () => new Promise((resolve) => {
  if (probesRunning < 3) { probesRunning++; resolve(); } else { probeWaiters.push(resolve); }
});
const releaseProbeSlot = () => {
  const next = probeWaiters.shift();
  if (next) next(); else probesRunning--;
};

// Text-looking payload (manifest) vs binary (MP4): '#', '<', a UTF-8 BOM or leading whitespace
const looksTextual = (u8) => !!u8 && u8.length > 0 && (u8[0] === 0x23 || u8[0] === 0x3c || u8[0] === 0xef || u8[0] === 0x20 || u8[0] === 0x0a || u8[0] === 0x0d);

// -> { bytes, complete } (complete = the body ended before the read limit)
const readProbeBody = async (res) => {
  if (!res.body) return { bytes: new Uint8Array(0), complete: true };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let limit = DRM_HEAD_BYTES;
  let complete = false;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      chunks.push(value);
      total += value.length;
      if (limit === DRM_HEAD_BYTES && looksTextual(chunks[0])) limit = DRM_TEXT_MAX;
    }
  } finally {
    try { await reader.cancel(); } catch (e) {}
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return { bytes: out, complete: complete };
};

// Some hosts only answer with the page's Referer / Origin: send them for this one request via a session rule
const withProbeReferer = async (url, referer, fn) => {
  const dnr = chrome.declarativeNetRequest;
  let origin = '';
  try { origin = new URL(referer).origin; } catch (e) {}
  if (!dnr || !dnr.updateSessionRules || !origin || !/^https?:/i.test(referer) || /[*^|]/.test(url)) return fn();
  const id = 9000 + (probeRuleSeq++ % 900);
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id: id,
        priority: 3,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: referer },
            { header: 'Origin', operation: 'set', value: origin }
          ]
        },
        condition: { urlFilter: `|${url}`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] }
      }]
    });
  } catch (e) {
    return fn();
  }
  try {
    return await fn();
  } finally {
    dnr.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
};

// First bytes of a URL (or the whole manifest, capped) and the URL it came from after redirects.
// whole = no Range header (a playlist the server cut to the first 64 KB is read again in full).
// -> { bytes, url, complete, cutByRange }, null on network / HTTP failure.
const probeFetch = async (url, referer, whole = false) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DRM_PROBE_TIMEOUT_MS);
  try {
    return await withProbeReferer(url, referer, async () => {
      const res = await fetch(url, {
        method: 'GET',
        headers: whole ? {} : { Range: `bytes=0-${DRM_HEAD_BYTES - 1}` },
        credentials: 'include',
        cache: 'no-store',
        signal: ctrl.signal
      });
      if (!res.ok && res.status !== 206) return null;
      const body = await readProbeBody(res);
      const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      const cutByRange = res.status === 206 && !!total && Number(total[1]) > body.bytes.length;
      return { bytes: body.bytes, url: res.url || url, complete: body.complete && !cutByRange, cutByRange: cutByRange };
    });
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// -> { ok: false } on failure, else { ok: true, info, variants, duration, live } (info null = looked, found no
// encryption; variants = the qualities a master playlist / MPD lists, or null; duration in seconds, 0 = unknown;
// live = a stream without an end)
const probeUrlForDrm = async (url, referer, hop) => {
  let got = await probeFetch(url, referer);
  if (!got) return { ok: false };
  if (looksTextual(got.bytes) && got.cutByRange) {
    // the server answered the Range request with only the start of a playlist: read it whole for its length
    const whole = await probeFetch(url, referer, true);
    if (whole) got = whole;
  }
  const bytes = got.bytes;
  const lengthOf = (d) => ({ duration: d && d.seconds ? d.seconds : 0, live: !!(d && d.live) });
  if (looksTextual(bytes)) {
    let text = '';
    try { text = new TextDecoder().decode(bytes); } catch (e) {}
    const variants = hop === 0 && typeof drm.parseVariants === 'function' ? drm.parseVariants(text, got.url) : null;
    const own = lengthOf(typeof drm.manifestDuration === 'function' ? drm.manifestDuration(text, got.complete) : null);
    const info = drm.analyzeManifest(text);
    if (hop >= 1) return { ok: true, info: info, variants: null, ...own };
    // HLS master playlists keep their keys and their length in the media playlists: follow one hop
    const next = (!info || (!own.duration && !own.live)) ? drm.firstPlaylistUri(text) : null;
    if (next) {
      try {
        const follow = await probeUrlForDrm(new URL(next, got.url).toString(), referer, hop + 1);
        if (follow.ok) {
          return {
            ok: true,
            info: info || follow.info,
            variants: variants,
            duration: own.duration || follow.duration || 0,
            live: own.live || (!own.duration && !!follow.live)
          };
        }
      } catch (e) {}
    }
    return { ok: true, info: info, variants: variants, ...own };
  }
  const fileDuration = typeof drm.mediaFileDuration === 'function' ? drm.mediaFileDuration(bytes) : 0;
  return { ok: true, info: drm.analyzeMp4Head(bytes), variants: null, duration: fileDuration, live: false };
};

// A manifest by its URL: worth reading for the qualities it lists even when its DRM status is already known
const MANIFEST_URL_RE = /\.(?:m3u8|m3u|mpd)(?:[?#]|$)|[?&](?:format|type|output)=(?:m3u8|mpd|hls|dash)\b/i;

const probeLinkDrm = async (tabId, rawUrl) => {
  await getTabLinks(tabId);
  const url = normalizeUrl(rawUrl, true);
  const tabMap = videoLinks.get(tabId);
  const entry = url && tabMap && tabMap.get(drm.keyFor(url));
  if (!entry) return { checked: false };
  const done = () => entry.drmChecked && (entry.variantsChecked || entry.segmented || (!MANIFEST_URL_RE.test(entry.url) && !(entry.addon && entry.addon.manifest)));
  const answer = (checked) => ({
    checked: checked, drm: entry.drm || null, variants: entry.variants || null, variantsChecked: !!entry.variantsChecked,
    duration: entry.duration || 0, live: !!entry.live
  });
  if (done()) return answer(true);
  if (DRM_PROBE_SKIP.test(entry.url)) {
    entry.drmChecked = true;
    return answer(true);
  }
  if ((entry.drmProbeAttempts || 0) >= DRM_PROBE_MAX_ATTEMPTS) return answer(false);

  await acquireProbeSlot();
  try {
    if (done()) return answer(true);
    const result = await probeUrlForDrm(entry.url, entry.referer || tabPageUrls.get(tabId) || '', 0);
    if (!result.ok) {
      entry.drmProbeAttempts = (entry.drmProbeAttempts || 0) + 1;
      saveTabLinksDebounced(tabId);
      return answer(false);
    }
    entry.variantsChecked = true;
    if (result.variants) entry.variants = result.variants;
    if (result.duration > 0) entry.duration = result.duration;
    if (result.live) entry.live = true;
    entry.drmChecked = true;
    if (result.info) {
      entry.drm = drm.mergeInfo(entry.drm, result.info);
      if (result.info.type === 'drm') {
        const rec = await ensureTabDrm(tabId);
        rec.active = true;
        addAll(rec.systems, result.info.systems, 10);
        addAll(rec.kids, result.info.kids, 20);
        addAll(rec.license, result.info.license, 5);
        addAll(rec.sources, result.info.sources, 6);
        rec.updated = Date.now();
        saveTabDrmDebounced(tabId);
      }
    }
    saveTabLinksDebounced(tabId);
    return answer(true);
  } finally {
    releaseProbeSlot();
  }
};

// MESSAGE HANDLING
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // From popup: get links + referers + posters + sizes
  if (request.action === 'getLinks') {
    const tabId = request.tabId;
    Promise.all([
      getTabLinks(tabId),
      getTabDrmSummary(tabId).catch(() => null),
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
    ]).then(([linksArray, drmSummary, pageUrl]) => {
      sendResponse({ links: linksArray, pageUrl: pageUrl, mobileScanMode: mobileScanMode, drm: drmSummary });
    });
    return true;
  } 
  // From popup: clear links
  else if (request.action === 'clearLinks') {
    const tabId = request.tabId;
    markTabCleared(tabId);
    videoLinks.delete(tabId);
    tabDrm.delete(tabId);
    tabFamilies.delete(tabId);
    tabInits.delete(tabId);
    tabHistory.set(tabId, []); // Clear empties the tab, including the lists kept for its earlier pages
    if (storage) {
      storage.remove([`tab_videos_${tabId}`, `tab_drm_${tabId}`, `tab_hist_${tabId}`]).catch(() => {});
    }
    updateBadge(tabId);
    sendResponse({ success: true });
  }
  // From content.js: DRM evidence found by inject.js (EME usage, DRM manifests)
  else if (request.action === 'drmSignal') {
    const tabId = sender.tab ? sender.tab.id : -1;
    applyDrmSignal(tabId, request.signal, request.frameUrl || (sender.tab && sender.tab.url) || '')
      .catch(() => {})
      .then(() => sendResponse({ success: true }));
    return true;
  }
  // From popup: check one listed link for DRM / encryption (reads a manifest or the first 64 KB of the file)
  else if (request.action === 'probeDrm') {
    probeLinkDrm(request.tabId, request.url)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ checked: false }));
    return true;
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
        // An error or login page answering instead of the file: its length is not the media size
        const type = (res.headers.get('content-type') || '').toLowerCase();
        if (!res.ok || type.startsWith('text/html')) {
          sendResponse({ size: 0 });
          return;
        }
        const len = res.headers.get('content-length');
        const size = len ? parseInt(len, 10) : 0;
        sendResponse({ size: size });
      })
      .catch(() => sendResponse({ size: 0 }));
    return true;
  }
  return true; 
});

// Add-on detection modules (addon-worker.js): they only add links and labels, using the functions above.
// Optional: if the file is missing or fails, everything above works as before.
try { importScripts('addon-worker.js'); } catch (e) { console.warn('addon-worker.js not loaded:', e); }
// The newer add-on modules (addon2-worker.js), same rules. Optional too.
try { importScripts('addon2-worker.js'); } catch (e) { console.warn('addon2-worker.js not loaded:', e); }
// The player tab that ▶ Play opens when the ⚙ setting asks for it (player.html). Optional too.
try { importScripts('player-worker.js'); } catch (e) { console.warn('player-worker.js not loaded:', e); }
