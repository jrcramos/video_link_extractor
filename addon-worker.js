// addon-worker.js - Add-on detection modules in the background worker, loaded at the end of background.js and
// sharing its functions (addLinkToTab, normalizeUrl, ...). They only ADD links, and labels on links: nothing in
// here changes how background.js detects, de-duplicates or stores what it already finds.
//   Findings sent by addon-content.js: module 1 (playlists recognised by their content), module 2 (media the page
//   links to or keeps in its player settings), module 3 (embedded video platform players)
//   Module 4: media requested by a page's service worker (Chrome reports those requests without a tab)
//   Module 5: streams traced through the page player's SourceBuffers (sent by addon-page.js)
(function () {
  const httpUrl = (u) => (typeof u === 'string' && u.length <= 4000 && /^https?:\/\//i.test(u) ? u : '');
  const entryFor = (tabId, url) => {
    const tabMap = videoLinks.get(tabId);
    const norm = normalizeUrl(url);
    return (tabMap && norm && tabMap.get(drm.keyFor(norm))) || null;
  };

  // The Referer each recent page request was sent with, so a link an add-on reports later gets the same Referer
  // the network sniffer would have used (the page's frame URL otherwise)
  const recentReferers = new Map(); // normalized url -> referer
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        if (details.tabId < 0 || !details.url) return;
        const ref = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'referer');
        if (!ref || !ref.value) return;
        const norm = normalizeUrl(details.url, true);
        if (!norm) return;
        recentReferers.delete(norm);
        recentReferers.set(norm, ref.value);
        if (recentReferers.size > 1500) recentReferers.delete(recentReferers.keys().next().value);
      } catch (e) {}
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
    ['requestHeaders', 'extraHeaders']
  );
  const refererFor = (url, frameUrl) => recentReferers.get(normalizeUrl(url, true) || '') || frameUrl || '';

  // Adds a link found by an add-on -> the entry. A link the existing detection already found keeps its entry as it
  // is; labelKnown lets a module still add its label to it (e.g. "this is an HLS playlist").
  const addFromAddon = async (tabId, url, frameUrl, label, labelKnown = true) => {
    await restoreTabLinks(tabId); // so a link already known (stored before a worker restart) is recognised
    const known = !!entryFor(tabId, url);
    if (known && !labelKnown) return entryFor(tabId, url);
    if (!known) addLinkToTab(tabId, url, refererFor(url, frameUrl), '', false, 0, '');
    const entry = entryFor(tabId, url);
    if (!entry) return null;
    const before = JSON.stringify(entry.addon || null);
    entry.addon = { ...(entry.addon || {}), ...label };
    if (!known && !entry.addon.source) entry.addon.source = label.found || 'addon';
    delete entry.addon.found;
    if (JSON.stringify(entry.addon) !== before) saveTabLinksDebounced(tabId);
    return entry;
  };

  const handlers = {
    // Module 1: a response whose body is an HLS / DASH playlist
    manifest: async (tabId, item, frameUrl) => {
      const url = httpUrl(item.url);
      const kind = item.manifest === 'hls' || item.manifest === 'dash' ? item.manifest : '';
      if (!url || !kind) return;
      await addFromAddon(tabId, url, frameUrl, { manifest: kind, found: 'content' });
    },
    // Module 2: media the page links to / keeps in its player settings (link, meta tag, data-* attribute, frame)
    page: async (tabId, item, frameUrl) => {
      const url = httpUrl(item.url);
      const via = ['link', 'meta', 'attr', 'frame'].includes(item.via) ? item.via : 'link';
      if (!url) return;
      await addFromAddon(tabId, url, frameUrl, { found: 'page', pageVia: via }, false);
    },
    // Module 3: an embedded video platform player (its address, with the page as Referer)
    embed: async (tabId, item, frameUrl) => {
      const url = httpUrl(item.url);
      const provider = typeof item.provider === 'string' ? item.provider.replace(/[^\w .-]/g, '').slice(0, 30) : '';
      if (!url || !provider) return;
      const entry = await addFromAddon(tabId, url, frameUrl, { found: 'embed', embed: provider }, false);
      // a YouTube player's thumbnail is at a fixed address
      const yt = /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/.exec(url);
      if (entry && yt && entry.addon && entry.addon.embed && !entry.poster) {
        entry.poster = `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`;
        saveTabLinksDebounced(tabId);
      }
    },
    // Module 5: the pieces one SourceBuffer of the page's player was fed (see addon-page.js)
    mse: async (tabId, item, frameUrl) => mseUpdate(tabId, item, frameUrl)
  };

  // =============================================================================================
  // Module 5: streams traced through the player's SourceBuffers
  // One entry per SourceBuffer, like a grouped segmented stream (⬇ .m3u8 export, ffmpeg): the first piece a
  // SourceBuffer gets is its initialisation segment, the rest follow in order. Listed only when the existing
  // detection has not got that stream already: not when a piece is listed or grouped already, not for Spotify's
  // player (grouped exactly elsewhere), and not when the page has a playlist (it describes the stream).
  // =============================================================================================
  const MSE_MIN_PIECES = 3;
  const mseStreams = new Map(); // `${tabId}|${stream}` -> { urls, mime, frameUrl, skip }

  // links only the newer add-on modules have found (addon2-worker.js) do not count: this decides as before
  const onlyNew = (e) => !!(e && e.addon && e.addon.onlyNew);

  const tabHasPlaylist = (tabMap) => {
    for (const e of tabMap.values()) {
      if (e && !onlyNew(e) && ((e.addon && e.addon.manifest) || e.variants || (!e.segmented && MANIFEST_URL_RE.test(e.url || '')))) return true;
    }
    return false;
  };

  const coveredAlready = (tabId, urls) => {
    const tabMap = videoLinks.get(tabId) || new Map();
    const fams = tabFamilies.get(tabId);
    return urls.some((u) => {
      if (drm.segmentInfo(u)) return true;
      const norm = normalizeUrl(u, true);
      if (!norm) return false;
      if (tabMap.has(drm.keyFor(norm)) && !onlyNew(tabMap.get(drm.keyFor(norm)))) return true;
      if (fams) for (const fam of fams.values()) if (fam.groupKey && fam.members.has(norm)) return true;
      return false;
    }) || tabHasPlaylist(tabMap);
  };

  const mseUpdate = async (tabId, item, frameUrl) => {
    const stream = typeof item.stream === 'string' ? item.stream.replace(/[^\w-]/g, '').slice(0, 60) : '';
    const incoming = (Array.isArray(item.urls) ? item.urls : []).map(httpUrl).filter(Boolean);
    if (!stream || !incoming.length) return;
    await restoreTabLinks(tabId);
    const groupKey = `mse:${stream}`;
    const key = `${tabId}|${stream}`;
    let state = mseStreams.get(key);
    if (!state) {
      state = { urls: [], mime: '', frameUrl: frameUrl, skip: false };
      mseStreams.set(key, state);
      if (mseStreams.size > 200) mseStreams.delete(mseStreams.keys().next().value);
    }
    if (item.mime) state.mime = String(item.mime).slice(0, 120);
    const from = Math.max(0, Number(item.from) || 0);
    // a batch may overlap what came before (resent after a worker restart): keep each position once
    incoming.forEach((u, i) => { if (from + i >= state.urls.length) state.urls.push(u); });
    if (state.urls.length > 3000) state.urls.length = 3000;

    let tabMap = videoLinks.get(tabId);
    let entry = tabMap && tabMap.get(groupKey);
    if (!entry) {
      if (state.skip || state.urls.length < MSE_MIN_PIECES) return;
      if (coveredAlready(tabId, state.urls)) { state.skip = true; return; }
      if (!tabMap) { tabMap = new Map(); videoLinks.set(tabId, tabMap); }
      entry = {
        url: state.urls[0], referer: refererFor(state.urls[0], state.frameUrl), poster: '', isMobile: false,
        size: 0, timestamp: Date.now(), groupKey: groupKey, addon: { source: 'mse', mime: state.mime }
      };
      tabMap.set(groupKey, entry);
    }
    const codec = (/codecs="?([^",]+)/i.exec(state.mime) || [])[1] || '';
    const pieces = state.urls.slice(1);
    let provider = '';
    try { provider = new URL(state.urls[0]).hostname; } catch (e) {}
    entry.segmented = {
      provider: provider, generic: true, kind: /^audio\//i.test(state.mime) ? 'audio' : 'video',
      mime: state.mime.split(';')[0], codec: codec, bitrate: 0, width: 0, height: 0,
      segLen: 0, endMs: 0, assumedDur: 4, first: 0, step: 1, pad: 0,
      count: pieces.length, observed: pieces.length, encrypted: false,
      initUrl: state.urls[0], urls: pieces
    };
    saveTabLinksDebounced(tabId);
    updateBadge(tabId);
  };

  // =============================================================================================
  // Module 4: media requested by a service worker / shared worker
  // Chrome reports those requests without a tab (tabId -1). background.js attributes only recognised DRM files to a
  // tab (attributeWorkerRequest); this does the same for every request its own filters would list (extension,
  // query signature, media Content-Type, numbered segments), using its own functions. The request goes to the
  // tab(s) showing that site, or a frame of it: the one playing sound, else the active one, else all of them.
  // Requests from extensions (this one's probes included) and from the browser itself carry no web origin and
  // are ignored.
  // =============================================================================================
  const workerTabCache = new Map(); // origin -> { at, tabs }
  const tabsShowingOrigin = async (origin) => {
    const cached = workerTabCache.get(origin);
    if (cached && Date.now() - cached.at < 2000) return cached.tabs;
    const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return ''; } };
    const all = await chrome.tabs.query({});
    const framed = new Set();
    tabFrameUrls.forEach((frames, tabId) => {
      for (const u of frames.values()) { if (originOf(u) === origin) { framed.add(tabId); break; } }
    });
    const matching = all.filter((t) => t.id >= 0 && (originOf(t.url || '') === origin || framed.has(t.id)));
    const audible = matching.filter((t) => t.audible);
    const active = matching.filter((t) => t.active);
    const tabs = (audible.length ? audible : (active.length ? active : matching)).map((t) => t.id);
    workerTabCache.set(origin, { at: Date.now(), tabs: tabs });
    if (workerTabCache.size > 50) workerTabCache.delete(workerTabCache.keys().next().value);
    return tabs;
  };

  const workerOrigin = (details) => {
    if (details.tabId >= 0 || !details.url || drm.isDrmUrl(details.url)) return ''; // tab requests / DRM: background.js
    try {
      const origin = new URL(details.initiator || '').origin;
      return /^https?:/i.test(origin) ? origin : '';
    } catch (e) {
      return '';
    }
  };

  const addFromWorker = (tabId, details, referer, size) => {
    const known = !!entryFor(tabId, details.url);
    addLinkToTab(tabId, details.url, referer, '', false, size, details.type);
    const entry = !known && entryFor(tabId, details.url);
    if (entry && !entry.addon) {
      entry.addon = { source: 'worker' };
      saveTabLinksDebounced(tabId);
    }
  };

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const origin = workerOrigin(details);
        if (!origin) return;
        const header = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'referer');
        const referer = (header && header.value) || `${origin}/`;
        const norm = normalizeUrl(details.url, true);
        if (norm) { // for the response step below (media known only by its Content-Type)
          recentReferers.delete(norm);
          recentReferers.set(norm, referer);
          if (recentReferers.size > 1500) recentReferers.delete(recentReferers.keys().next().value);
        }
        const chunk = CHUNK_URL_RE.test(details.url);
        if (!chunk && !videoRegex.test(details.url) && !videoQueryRegex.test(details.url)) return;
        tabsShowingOrigin(origin).then((tabs) => tabs.forEach((tabId) => {
          if (chunk) noteChunk(tabId, details.url, details.type, referer);
          else addFromWorker(tabId, details, referer, 0);
        })).catch(() => {});
      } catch (e) {}
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      try {
        const origin = workerOrigin(details);
        if (!origin) return;
        const chunkByType = !CHUNK_URL_RE.test(details.url) && isChunkHeader(details.responseHeaders);
        const media = isVideoHeader(details.responseHeaders);
        if (!chunkByType && !media) return;
        const size = getContentLength(details.responseHeaders);
        tabsShowingOrigin(origin).then((tabs) => tabs.forEach((tabId) => {
          const referer = refererFor(details.url, `${origin}/`);
          if (chunkByType) noteChunk(tabId, details.url, details.type, referer);
          else addFromWorker(tabId, details, referer, size);
        })).catch(() => {});
      } catch (e) {}
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
  );

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'addonDetect') return false;
    const tabId = sender && sender.tab ? sender.tab.id : -1;
    if (tabId >= 0 && Array.isArray(request.items)) {
      const frameUrl = httpUrl(request.frameUrl) || (sender.tab && sender.tab.url) || '';
      request.items.slice(0, 300).forEach((item) => {
        const handler = item && handlers[item.module];
        if (handler) handler(tabId, item, frameUrl).catch(() => {});
      });
    }
    sendResponse({ ok: true });
    return false;
  });

  // For the newer add-on modules (addon2-worker.js): the Referer a link found by an add-on gets
  self.__VLE_ADDON_WORKER__ = Object.freeze({ refererFor: refererFor });
})();
