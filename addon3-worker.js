// addon3-worker.js - The third set of add-on modules in the background worker, loaded after addon2-worker.js and
// sharing background.js's functions (addLinkToTab, normalizeUrl, probeFetch, withProbeReferer, ...). Same rules as
// the other add-on files: they only ADD links, and information about links. A link the existing detection has is
// never changed: what these modules learn about it is kept apart from the tab's link list (session storage key
// x3_tab_<tab>, x3_probe) and only shown by the popup (addon3-popup.js).
//   Module 12: the request headers the page sent for each link (Origin, Cookie, Authorization, tokens, ...)
//   Module 13: WebRTC / WHEP / WHIP and WebSocket media streams (found by addon3-page.js), page-level only
//   Module 14: WebTransport sessions and WebCodecs decoders (addon3-page.js), page-level only
//   Module 15: Smooth Streaming (.ism/Manifest) and HDS (.f4m) manifests by address; their qualities and length
//   Module 16: ads: files listed in VAST answers, files from ad servers, ad breaks marked inside a stream
//   Module 17: .pls / .asx / .xspf playlists and what they list, Icecast / SHOUTcast radio, RSS / Atom enclosures
//   Module 18: codec, HDR and audio format of a stream / file (from what the existing probe reads, no new request)
//   Module 19: HLS extras: I-frame and image playlists, session data, content steering, low latency
//   Module 20: the address of each DASH track (its file, or an .m3u8 of its segments for ffmpeg)
//   Module 21: embedded players resolved through their own service, on request (🔍 Resolve), and oEmbed
//   Module 22: when / how each link was first requested (type, status, server address), for the popup and HAR
(function () {
  const P = self.__VLE_X3_PARSE__;
  const T = self.__VLE_X3_TEXT__;
  if (!P || !T || typeof addLinkToTab !== 'function') return;

  const api = self.__VLE_ADDON_WORKER__ || {};
  const refererFor = typeof api.refererFor === 'function' ? api.refererFor : (u, frameUrl) => frameUrl || '';
  const httpUrl = (u) => (typeof u === 'string' && u.length <= 4000 && /^https?:\/\//i.test(u) ? u : '');
  const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const keyOf = (u) => normalizeUrl(u, true) || '';
  const entryFor = (tabId, url) => {
    const tabMap = videoLinks.get(tabId);
    const norm = normalizeUrl(url);
    return (tabMap && norm && tabMap.get(drm.keyFor(norm))) || null;
  };
  const dirOf = (url) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
    } catch (e) {
      return '';
    }
  };

  // ---- new links, labelled like addon2-worker.js does (addon.onlyNew): until an existing finder reaches the same
  // link, background.js's "nothing found yet" check and module 5 ignore it, and addon2-worker.js puts back what that
  // finder would have stored when it does
  const canAdd = (tabId, norm) => {
    if (CHUNK_URL_RE.test(norm) || drm.segmentInfo(norm) || drm.isInitLike(norm)) return false;
    const seg = drm.genericSegment(norm);
    const fams = tabFamilies.get(tabId);
    return !(seg && fams && fams.has(seg.famKey));
  };
  const addNew = async (tabId, rawUrl, frameUrl, source, label = {}, opts = {}) => {
    const url = httpUrl(rawUrl);
    if (tabId < 0 || !url) return null;
    await restoreTabLinks(tabId);
    const norm = normalizeUrl(url);
    if (!norm || !canAdd(tabId, norm) || entryFor(tabId, norm)) return null;
    addLinkToTab(tabId, norm, opts.referer || refererFor(norm, frameUrl), '', false, opts.size || 0, '');
    const entry = entryFor(tabId, norm);
    if (!entry || entry.addon || entry.segmented) return null;
    entry.addon = { ...label, source: source, onlyNew: true };
    saveTabLinksDebounced(tabId);
    return entry;
  };

  // =============================================================================================
  // What these modules know per tab, apart from the link list. Session storage (memory only, gone when the browser
  // closes), one small key per tab, with caps so it never crowds out the tab lists in the same storage.
  // =============================================================================================
  // Incognito windows run their own copy of this worker: its shared keys are its own (tab keys are unique anyway)
  const TABS_KEY = IN_INCOGNITO ? 'x3_tabs_incognito' : 'x3_tabs';
  const PROBE_KEY = IN_INCOGNITO ? 'x3_probe_incognito' : 'x3_probe';
  const MAX = { h: 400, d: 200, r: 600, ads: 300, radio: 100, feed: 150, bytes: 250000, tabs: 12 };
  const states = new Map(); // tabId -> state
  const loaded = new Set();
  const loadJobs = new Map();
  const saveTimers = new Map();
  const newPage = (key) => ({ key: key || '', rtc: [], sig: [], ws: [], wt: [], codecs: [], oembed: [], feeds: 0 });
  const newState = () => ({ h: new Map(), d: new Map(), r: new Map(), ads: new Map(), radio: new Map(), page: newPage(''), at: Date.now() });
  const stateOf = (tabId) => {
    let st = states.get(tabId);
    if (!st) { st = newState(); states.set(tabId, st); }
    st.at = Date.now();
    return st;
  };
  const putLimited = (map, key, value, max) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  };

  const loadState = (tabId) => {
    if (tabId < 0 || !storage || loaded.has(tabId)) return Promise.resolve(stateOf(tabId));
    if (loadJobs.has(tabId)) return loadJobs.get(tabId);
    const job = storage.get([`x3_tab_${tabId}`]).then((res) => {
      const saved = res && res[`x3_tab_${tabId}`];
      const st = stateOf(tabId);
      if (saved && typeof saved === 'object') {
        const sets = Array.isArray(saved.sets) ? saved.sets : [];
        const fill = (map, obj, conv) => Object.entries(obj || {}).forEach(([k, v]) => { if (!map.has(k)) map.set(k, conv(v)); });
        fill(st.h, saved.h, (i) => sets[i] || []);
        fill(st.d, saved.d, (i) => sets[i] || []);
        fill(st.r, saved.r, (v) => v);
        fill(st.ads, saved.ads, (v) => v);
        fill(st.radio, saved.radio, (v) => v);
        if (saved.page && typeof saved.page === 'object' && !st.page.key) st.page = { ...newPage(''), ...saved.page };
      }
      return st;
    }).catch(() => stateOf(tabId)).then((st) => {
      loadJobs.delete(tabId);
      loaded.add(tabId);
      return st;
    });
    loadJobs.set(tabId, job);
    return job;
  };

  // Stored tabs, most recent first: only the last few keep their data (a closed tab's is removed at once)
  let tabIndex = null;
  const touchIndex = async (tabId) => {
    if (!storage) return;
    if (!tabIndex) {
      try {
        const res = await storage.get([TABS_KEY]);
        tabIndex = Array.isArray(res && res[TABS_KEY]) ? res[TABS_KEY].filter((t) => Number.isInteger(t)) : [];
      } catch (e) {
        tabIndex = [];
      }
    }
    tabIndex = [tabId, ...tabIndex.filter((t) => t !== tabId)];
    const dropped = tabIndex.splice(MAX.tabs);
    const writes = { [TABS_KEY]: tabIndex };
    await storage.set(writes).catch(() => {});
    if (dropped.length) storage.remove(dropped.map((t) => `x3_tab_${t}`)).catch(() => {});
  };

  const serialize = (st) => {
    const sets = [];
    const setIds = new Map();
    const ref = (headers) => {
      const k = JSON.stringify(headers);
      if (!setIds.has(k)) { setIds.set(k, sets.length); sets.push(headers); }
      return setIds.get(k);
    };
    const obj = (map, conv) => {
      const o = {};
      map.forEach((v, k) => { o[k] = conv ? conv(v) : v; });
      return o;
    };
    return { sets: sets, h: obj(st.h, ref), d: obj(st.d, ref), r: obj(st.r), ads: obj(st.ads), radio: obj(st.radio), page: st.page };
  };

  const saveState = (tabId) => {
    if (tabId < 0 || !storage) return;
    clearTimeout(saveTimers.get(tabId));
    saveTimers.set(tabId, setTimeout(() => {
      saveTimers.delete(tabId);
      loadState(tabId).then((st) => {
        if (states.get(tabId) !== st) return; // cleared meanwhile
        let data = serialize(st);
        // over the size cap: the oldest headers / request details go first
        for (let i = 0; i < 6 && JSON.stringify(data).length > MAX.bytes; i++) {
          [st.h, st.r, st.d].forEach((map) => {
            const drop = Math.ceil(map.size / 3);
            for (let k = 0; k < drop; k++) map.delete(map.keys().next().value);
          });
          data = serialize(st);
        }
        storage.set({ [`x3_tab_${tabId}`]: data }).catch(() => {});
        touchIndex(tabId).catch(() => {});
      });
    }, 1500));
  };

  const dropState = (tabId) => {
    states.delete(tabId);
    loaded.add(tabId); // nothing stored to merge back
    clearTimeout(saveTimers.get(tabId));
    saveTimers.delete(tabId);
    if (storage) storage.remove([`x3_tab_${tabId}`]).catch(() => {});
    if (tabIndex) tabIndex = tabIndex.filter((t) => t !== tabId);
  };
  chrome.tabs.onRemoved.addListener((tabId) => dropState(tabId));

  // The page-level findings (modules 13, 14, 21) belong to the page shown in the tab
  const pageOf = (tabId, st, pageUrl) => {
    const key = pageKey(pageUrl || tabPageUrls.get(tabId) || '');
    if (st.page.key !== key) st.page = newPage(key);
    return st.page;
  };

  // =============================================================================================
  // Module 12 + 22: the request headers and the first request of each link
  // Headers the browser adds on its own (User-Agent, Accept-*, Sec-*, caching, Range, ...) are left out; the
  // Referer is the card's own. Kept for the tab's listed links, and per folder for the pieces of a stream.
  // =============================================================================================
  const SKIP_HEADER = /^(?:user-agent|accept|accept-encoding|accept-language|connection|host|referer|range|if-range|if-none-match|if-modified-since|if-match|if-unmodified-since|cache-control|pragma|dnt|upgrade-insecure-requests|priority|te|content-length|purpose|x-client-data|save-data|downlink|rtt|ect|device-memory|viewport-width|dpr|width|sec-.*|proxy-.*|x-browser-.*)$/i;
  const MEDIA_TYPES = new Set(['xmlhttprequest', 'media', 'other']);
  // Smooth Streaming: .ism/Manifest. Azure Media Services serves HLS / DASH at the same address with a format:
  // .ism/Manifest(format=m3u8-aapl) / (format=mpd-time-csf): those are labelled HLS / DASH instead.
  const SMOOTH_URL = /\.isml?\/manifest(?:\((?![^)]*(?:m3u8|mpd))[^)\/]*\))?(?:[?#]|$)/i;
  const AMS_URL = /\.isml?\/manifest\([^)\/]*?(m3u8|mpd)[^)\/]*\)/i;
  const HDS_URL = /\.f4m(?:[?#]|$)/i;
  const LIST_URL = /\.(pls|asx|xspf)(?:[?#]|$)/i;
  const LIST_TYPE = /audio\/x-scpls|application\/pls\+xml|application\/xspf\+xml|video\/x-ms-asx/i;
  const pending = new Map(); // requestId -> { tabId, url, headers, type, method, frameId, initiator, at }
  const committed = new Map(); // requestId -> { tabId, key } (for the server address, known a moment later)

  const pickHeaders = (list) => {
    const out = [];
    (list || []).forEach((h) => {
      if (!h || !h.name || typeof h.value !== 'string' || SKIP_HEADER.test(h.name) || out.length >= 30) return;
      out.push([h.name.slice(0, 100), h.value.slice(0, 8000)]);
    });
    return out;
  };
  const mediaUrl = (url) => videoRegex.test(url) || videoQueryRegex.test(url) || drm.isDrmUrl(url) || SMOOTH_URL.test(url) || AMS_URL.test(url) || HDS_URL.test(url) || LIST_URL.test(url);
  const headerOf = (list, name) => {
    const h = (list || []).find((x) => x.name.toLowerCase() === name);
    return h ? String(h.value || '') : '';
  };

  // the same headers come with every request of a link: each list is turned into text once, to compare
  const jsonCache = new WeakMap();
  const jsonOf = (list) => {
    if (!list) return '';
    let j = jsonCache.get(list);
    if (j === undefined) { j = JSON.stringify(list); jsonCache.set(list, j); }
    return j;
  };

  // a listed link (or a piece of a stream: its folder) -> its headers and first request; on its response
  const commit = (req, response) => {
    const st = stateOf(req.tabId);
    const entry = entryFor(req.tabId, req.url);
    let changed = false;
    const json = req.headers.length ? jsonOf(req.headers) : '';
    if (entry) {
      const key = keyOf(req.url);
      if (json && jsonOf(st.h.get(key)) !== json) { putLimited(st.h, key, req.headers, MAX.h); changed = true; }
      let rec = st.r.get(key);
      if (!rec) {
        const frames = tabFrameUrls.get(req.tabId);
        rec = {
          at: req.at, type: req.type, method: req.method, frameId: req.frameId,
          frameUrl: clip(frames && frames.get(req.frameId), 500), initiator: clip(req.initiator, 300), status: 0, ctype: '', clen: 0, ip: ''
        };
        putLimited(st.r, key, rec, MAX.r);
        changed = true;
      }
      if (response && !rec.status) {
        rec.status = response.statusCode || 0;
        rec.ctype = clip(headerOf(response.responseHeaders, 'content-type'), 100);
        rec.clen = getContentLength(response.responseHeaders) || 0;
        changed = true;
      }
      if (response && !rec.ip) watchAddress(response.requestId, req.tabId, key);
    } else if (json) {
      const dir = dirOf(req.url);
      if (dir && jsonOf(st.d.get(dir)) !== json) { putLimited(st.d, dir, req.headers, MAX.d); changed = true; }
    }
    if (changed) loadState(req.tabId).then(() => saveState(req.tabId));
  };

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        if (details.tabId < 0 || !details.url || !MEDIA_TYPES.has(details.type)) return;
        const req = {
          tabId: details.tabId, url: details.url, headers: pickHeaders(details.requestHeaders), type: details.type,
          method: details.method || 'GET', frameId: details.frameId, initiator: details.initiator || '', at: Date.now()
        };
        putLimited(pending, details.requestId, req, 800); // kept until its response (commit, below)
        // Module 15 / 17: manifests and playlists the existing filters do not know by their address
        const ams = AMS_URL.exec(details.url);
        if (SMOOTH_URL.test(details.url) || HDS_URL.test(details.url) || ams) {
          const kind = ams ? (ams[1].toLowerCase() === 'mpd' ? 'dash' : 'hls') : (SMOOTH_URL.test(details.url) ? 'mss' : 'hds');
          addNew(details.tabId, details.url, '', 'stream', { manifest: kind }, { referer: getRefererFromDetails(details) }).catch(() => {});
        } else if (LIST_URL.test(details.url)) {
          const kind = LIST_URL.exec(details.url)[1].toLowerCase();
          addNew(details.tabId, details.url, '', 'playlist', { playlist: kind }, { referer: getRefererFromDetails(details) }).catch(() => {});
        }
      } catch (e) {}
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
    ['requestHeaders', 'extraHeaders']
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      try {
        if (details.tabId < 0 || !details.url) return;
        const req = pending.get(details.requestId);
        if (req) pending.delete(details.requestId);
        const headers = details.responseHeaders || [];
        const ctype = headerOf(headers, 'content-type');
        const icy = headers.some((h) => /^(?:icy-|ice-audio-info$)/i.test(h.name));
        const listed = isVideoHeader(headers) || isChunkHeader(headers) || mediaUrl(details.url) || CHUNK_URL_RE.test(details.url) || icy || LIST_TYPE.test(ctype);
        if (req && listed) commit(req, details);

        // Module 17: Icecast / SHOUTcast radio (a stream that never ends; its station in icy- headers)
        if (icy) {
          const st = stateOf(details.tabId);
          const key = keyOf(details.url);
          const info = {
            name: clip(headerOf(headers, 'icy-name'), 120), genre: clip(headerOf(headers, 'icy-genre'), 80),
            br: parseInt(headerOf(headers, 'icy-br'), 10) || 0, desc: clip(headerOf(headers, 'icy-description'), 200),
            site: httpUrl(headerOf(headers, 'icy-url')).slice(0, 300)
          };
          if (key && JSON.stringify(st.radio.get(key) || null) !== JSON.stringify(info)) {
            putLimited(st.radio, key, info, MAX.radio);
            loadState(details.tabId).then(() => saveState(details.tabId));
          }
          // an Ogg / AAC+ station served with a type the existing filters do not list
          if (!isVideoHeader(headers)) addNew(details.tabId, details.url, '', 'radio', { mediaKind: 'audio' }, { referer: getRefererFromDetails(details) }).catch(() => {});
        } else if (LIST_TYPE.test(ctype) && !LIST_URL.test(details.url) && !isVideoHeader(headers)) {
          const kind = /xspf/i.test(ctype) ? 'xspf' : (/asx/i.test(ctype) ? 'asx' : 'pls');
          addNew(details.tabId, details.url, '', 'playlist', { playlist: kind }, { referer: getRefererFromDetails(details) }).catch(() => {});
        }
      } catch (e) {}
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
    ['responseHeaders']
  );

  // The server address comes with the next event of a request. That listener is only registered for a few seconds
  // after a listed link's response, so the worker is not woken for every request of every tab. (An address that
  // arrives before it is registered is taken from the link's next request.)
  let addressTimer = null;
  const onResponseStarted = (details) => {
    try {
      const c = committed.get(details.requestId);
      if (!c || !details.ip) return;
      committed.delete(details.requestId);
      const rec = stateOf(c.tabId).r.get(c.key);
      if (rec && !rec.ip) {
        rec.ip = clip(details.ip, 60);
        saveState(c.tabId);
      }
    } catch (e) {}
  };
  const watchAddress = (requestId, tabId, key) => {
    committed.set(requestId, { tabId: tabId, key: key });
    if (committed.size > 300) committed.delete(committed.keys().next().value);
    try {
      if (!chrome.webRequest.onResponseStarted.hasListener(onResponseStarted)) {
        chrome.webRequest.onResponseStarted.addListener(onResponseStarted, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] });
      }
      clearTimeout(addressTimer);
      addressTimer = setTimeout(() => {
        try { chrome.webRequest.onResponseStarted.removeListener(onResponseStarted); } catch (e) {}
        committed.clear();
      }, 5000);
    } catch (e) {}
  };

  // =============================================================================================
  // Modules 15, 16, 17, 18, 19, 20: what the existing probe reads (background.js probeUrlForDrm calls this with the
  // bytes it fetched: a playlist / manifest, or the first 64 KB of a file). No request of its own.
  // =============================================================================================
  const probes = new Map(); // normalized url -> what was read from it (all tabs: it describes the link itself)
  const dashFull = new Map(); // normalized url -> the whole DASH reading (memory only, for the .m3u8 export)
  const masterOf = new Map(); // first variant playlist url -> its master playlist's key
  const probeTab = new Map(); // normalized url -> tab whose popup asked for the probe
  let probesLoaded = false;
  let probesLoading = null;
  let probeSaveTimer = null;
  const loadProbes = () => {
    if (probesLoaded || !storage) return Promise.resolve();
    if (!probesLoading) {
      probesLoading = storage.get([PROBE_KEY]).then((res) => {
        const saved = res && res[PROBE_KEY];
        if (saved && typeof saved === 'object') Object.entries(saved).forEach(([k, v]) => { if (!probes.has(k)) probes.set(k, v); });
      }).catch(() => {}).then(() => { probesLoaded = true; });
    }
    return probesLoading;
  };
  const saveProbes = () => {
    if (!storage) return;
    clearTimeout(probeSaveTimer);
    probeSaveTimer = setTimeout(() => {
      loadProbes().then(() => {
        while (probes.size > 300) probes.delete(probes.keys().next().value);
        let data = Object.fromEntries(probes);
        while (JSON.stringify(data).length > 600000 && probes.size > 10) {
          for (let i = 0; i < 30; i++) probes.delete(probes.keys().next().value);
          data = Object.fromEntries(probes);
        }
        storage.set({ [PROBE_KEY]: data }).catch(() => {});
      });
    }, 800);
  };
  const setProbe = (key, patch) => {
    if (!key) return;
    const cur = probes.get(key) || {};
    putLimited(probes, key, { ...cur, ...patch }, 300);
    saveProbes();
  };

  const decodeText = (bytes) => {
    try { return new TextDecoder().decode(bytes); } catch (e) { return ''; }
  };
  const looksText = (u8) => {
    for (let i = 0; i < Math.min(u8.length, 64); i++) {
      const c = u8[i];
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xef || c === 0xbb || c === 0xbf) continue;
      return c === 0x23 || c === 0x3c || c === 0x5b; // '#', '<', '['
    }
    return false;
  };
  const dashSummary = (d) => ({
    live: d.live, periods: d.periods, thumbs: d.thumbs.slice(0, 6),
    tracks: d.tracks.slice(0, 40).map((t) => ({
      kind: t.kind, id: t.id, width: t.width, height: t.height, bandwidth: t.bandwidth, fps: t.fps, codecs: t.codecs,
      language: t.language, tags: t.tags, url: t.url,
      segs: t.parts.reduce((n, p) => n + (Array.isArray(p.urls) ? p.urls.length : (Array.isArray(p.tl) ? p.tl.reduce((s, r) => s + (r[2] < 0 ? 1 : r[2] + 1), 0) : p.n)), 0)
    }))
  });

  // Items a playlist / feed the popup had checked lists: added to the tab that asked
  const addListed = async (tabId, list, referer, source, via) => {
    if (tabId === undefined || tabId < 0) return;
    for (const it of list.slice(0, 60)) {
      const label = it.kind === 'audio' ? { mediaKind: 'audio', listVia: via } : { listVia: via };
      await addNew(tabId, it.url, '', source, label, { referer: referer }).catch(() => {});
    }
  };

  // run after the check has answered: reading a big manifest here never delays it
  self.__VLE_X3_PROBED__ = (url, got, hop) => { setTimeout(() => readProbed(url, got, hop), 0); };
  const readProbed = (url, got, hop) => {
    try {
      const bytes = got && got.bytes;
      if (!bytes || !bytes.length) return;
      const key = hop === 0 ? keyOf(url) : (masterOf.get(url) || '');
      if (!key) return;
      if (!looksText(bytes)) {
        if (hop === 0) {
          const tags = P.fileTech(bytes);
          if (tags.length) setProbe(key, { tech: tags });
        }
        return;
      }
      const text = decodeText(bytes);
      const base = got.url || url;
      const h = P.hls(text, base);
      if (h) {
        if (hop === 0 && h.master) {
          if (h.first) { masterOf.set(h.first, key); if (masterOf.size > 300) masterOf.delete(masterOf.keys().next().value); }
          setProbe(key, {
            kind: 'hls', tech: h.tech, vt: h.vt, iframes: h.iframes, images: h.images, session: h.session,
            steering: h.steering, pathways: h.pathways, ll: h.ll, ad: h.ad
          });
        } else {
          // a media playlist: its own, or the master's first quality (ad breaks and low latency show there)
          const cur = probes.get(key) || {};
          const patch = { ll: !!(cur.ll || h.ll), ad: cur.ad || h.ad };
          if (hop === 0) patch.kind = 'hls';
          setProbe(key, patch);
        }
        return;
      }
      if (hop !== 0) return;
      const d = P.dash(text, base);
      if (d) {
        putLimited(dashFull, key, d, 20);
        setProbe(key, { kind: 'dash', tech: d.tech, ad: d.ad || (d.periods > 1 ? { n: d.periods - 1, kind: 'period' } : null), dash: dashSummary(d) });
        return;
      }
      const s = P.smooth(text);
      if (s) { setProbe(key, { kind: 'mss', tech: s.tech, mss: { variants: s.variants, duration: s.duration, live: s.live } }); return; }
      const f = P.hds(text);
      if (f) { setProbe(key, { kind: 'hds', mss: { variants: f.variants, duration: f.duration, live: f.live } }); return; }
      // Module 17: a playlist / feed listed on the card
      const kind = T.kindOf(text);
      const tabId = probeTab.get(key);
      const entry = tabId !== undefined ? entryFor(tabId, key) : null;
      const referer = (entry && entry.referer) || '';
      if (kind === 'pls' || kind === 'asx' || kind === 'xspf') {
        const urls = T.playlistUrls(text, base, kind);
        setProbe(key, { kind: kind, listed: urls.length });
        addListed(tabId, urls.map((u) => ({ url: u, kind: T.AUDIO_PATH.test(u.split('?')[0]) ? 'audio' : '' })), referer, 'playlist', kind);
      } else if (kind === 'rss' || kind === 'atom') {
        const items = T.feedMedia(text, base, 60);
        setProbe(key, { kind: kind, listed: items.length });
        addListed(tabId, items, referer, 'feed', kind);
      } else if (kind === 'vast') {
        setProbe(key, { kind: 'vast' });
      }
    } catch (e) {}
  };

  // =============================================================================================
  // Modules 13, 14, 16, 17, 21: findings sent by addon3-content.js (untrusted page context: every field is checked)
  // =============================================================================================
  const listOf = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const pushUnique = (arr, item, max, same) => {
    const at = arr.findIndex((x) => same(x, item));
    if (at >= 0) { arr[at] = item; return true; }
    if (arr.length >= max) return false;
    arr.push(item);
    return true;
  };
  const handlers = {
    // Module 13: a WebRTC connection that receives media
    rtc: (tabId, item, page) => pushUnique(page.rtc, {
      id: Number(item.id) || 0, video: Math.min(99, Number(item.video) || 0), audio: Math.min(99, Number(item.audio) || 0),
      ice: listOf(item.ice, 6).map((h) => clip(h, 100)).filter(Boolean), codecs: listOf(item.codecs, 6).map((c) => clip(c, 30)).filter(Boolean),
      state: clip(item.state, 20), frame: clip(item.frame, 300)
    }, 10, (a, b) => a.id === b.id && a.frame === b.frame),
    sig: (tabId, item, page) => {
      const url = httpUrl(item.url);
      return !!url && pushUnique(page.sig, { url: url, kind: item.kind === 'whip' ? 'whip' : 'whep' }, 10, (a, b) => a.url === b.url);
    },
    ws: (tabId, item, page) => {
      const url = typeof item.url === 'string' && /^wss?:\/\//i.test(item.url) ? item.url.slice(0, 2000) : '';
      return !!url && pushUnique(page.ws, { url: url, format: clip(item.format, 20) }, 10, (a, b) => a.url === b.url);
    },
    // Module 14
    wt: (tabId, item, page) => {
      const url = httpUrl(item.url);
      return !!url && pushUnique(page.wt, { url: url }, 10, (a, b) => a.url === b.url);
    },
    codec: (tabId, item, page) => pushUnique(page.codecs, {
      kind: item.kind === 'audio' ? 'audio' : 'video', codec: clip(item.codec, 60), w: Number(item.w) || 0, h: Number(item.h) || 0,
      rate: Number(item.rate) || 0, ch: Number(item.ch) || 0
    }, 10, (a, b) => a.kind === b.kind && a.codec === b.codec && a.w === b.w && a.h === b.h),
    // Module 21: the page names an oEmbed description of itself
    oembed: (tabId, item, page) => {
      const url = httpUrl(item.url);
      return !!url && pushUnique(page.oembed, { url: url, title: clip(item.title, 120) }, 3, (a, b) => a.url === b.url);
    },
    // Module 16: the files a VAST answer lists are ads
    ad: (tabId, item) => {
      const st = stateOf(tabId);
      listOf(item.urls, 40).forEach((u) => { const k = httpUrl(u) && keyOf(u); if (k) putLimited(st.ads, k, 'vast', MAX.ads); });
      return true;
    },
    // Module 17: media an RSS / Atom feed or a .pls / .asx / .xspf playlist the page loaded lists
    feed: (tabId, item, page, frameUrl) => {
      const via = ['rss', 'atom', 'pls', 'asx', 'xspf'].includes(item.via) ? item.via : 'rss';
      const source = via === 'rss' || via === 'atom' ? 'feed' : 'playlist';
      const room = Math.max(0, MAX.feed - page.feeds);
      const list = listOf(item.items, Math.min(60, room)).filter((i) => i && httpUrl(i.url));
      page.feeds += list.length;
      list.reduce((chain, i) => chain.then(() => addNew(tabId, i.url, frameUrl, source, i.kind === 'audio' ? { mediaKind: 'audio', listVia: via } : { listVia: via }).catch(() => {})), Promise.resolve());
      return list.length > 0;
    }
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.action !== 'string') return false;
    const fromTab = sender && sender.tab ? sender.tab.id : -1;
    // the popup (or the popup page opened in a tab): never a content script, whose sender.url is the web page's
    const fromExtension = sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);

    if (request.action === 'x3Detect') {
      if (fromTab >= 0 && Array.isArray(request.items)) {
        const frameUrl = httpUrl(request.frameUrl) || (sender.tab && sender.tab.url) || '';
        loadState(fromTab).then((st) => {
          const page = pageOf(fromTab, st, sender.tab && sender.tab.url);
          let changed = false;
          request.items.slice(0, 100).forEach((item) => {
            const handler = item && handlers[item.module];
            if (!handler) return;
            try { if (handler(fromTab, item, page, frameUrl)) changed = true; } catch (e) {}
          });
          if (changed) saveState(fromTab);
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    // the popup checks a link (background.js answers): remember which tab, for what the check reads (module 17)
    if (request.action === 'probeDrm' && fromExtension && Number.isInteger(request.tabId) && typeof request.url === 'string') {
      const k = keyOf(request.url);
      if (k) { probeTab.set(k, request.tabId); if (probeTab.size > 300) probeTab.delete(probeTab.keys().next().value); }
      return false;
    }
    // Clear empties these modules' data for the tab too
    if (request.action === 'clearLinks' && fromExtension && Number.isInteger(request.tabId)) {
      dropState(request.tabId);
      return false;
    }

    if (!fromExtension) return false;

    // ---- the popup (addon3-popup.js) asks what these modules know about its links
    if (request.action === 'x3Info' && Number.isInteger(request.tabId)) {
      const tabId = request.tabId;
      Promise.all([loadState(tabId), loadProbes()]).then(([st]) => {
        const items = {};
        listOf(request.urls, 1000).forEach((u) => {
          if (typeof u !== 'string') return;
          const key = keyOf(u);
          if (!key) return;
          const out = {};
          const h = st.h.get(key) || st.d.get(dirOf(u));
          if (h && h.length) out.h = h;
          const r = st.r.get(key);
          if (r) out.r = r;
          const ad = st.ads.get(key) || adHost(u);
          if (ad) out.ad = ad;
          const radio = st.radio.get(key);
          if (radio) out.radio = radio;
          const probe = probes.get(key);
          if (probe) out.probe = probe;
          if (Object.keys(out).length) items[u] = out;
        });
        const page = st.page.key && st.page.key === pageKey(tabPageUrls.get(tabId) || st.page.key) ? st.page : null;
        sendResponse({ items: items, page: page });
      }).catch(() => sendResponse({ items: {}, page: null }));
      return true;
    }

    // ---- Module 20: one DASH track as an .m3u8 of its segments
    if (request.action === 'x3DashTrack' && Number.isInteger(request.tabId) && typeof request.url === 'string') {
      dashTrackPlaylist(request.tabId, request.url, Number(request.index), String(request.comment || '').slice(0, 2000))
        .then((res) => sendResponse(res)).catch(() => sendResponse({ error: 'failed' }));
      return true;
    }

    // ---- Module 21: an embedded player resolved through its own service / an oEmbed description
    if (request.action === 'x3Resolve' && Number.isInteger(request.tabId) && typeof request.url === 'string') {
      resolveEmbed(request.tabId, request.url).then((res) => sendResponse(res)).catch(() => sendResponse({ error: 'failed' }));
      return true;
    }
    if (request.action === 'x3Oembed' && Number.isInteger(request.tabId) && typeof request.url === 'string') {
      resolveOembed(request.tabId, request.url).then((res) => sendResponse(res)).catch(() => sendResponse({ error: 'failed' }));
      return true;
    }
    return false;
  });

  // =============================================================================================
  // Module 16: ad servers (files they serve are ads)
  // =============================================================================================
  const AD_HOST_RE = /(?:^|\.)(?:2mdn\.net|doubleclick\.net|googlesyndication\.com|imasdk\.googleapis\.com|innovid\.com|fwmrm\.net|adsrvr\.org|springserve\.com|tremorhub\.com|teads\.tv|serving-sys\.com|flashtalking\.com|spotxcdn\.com|spotx\.tv|adform\.net|smartadserver\.com|adnxs\.com|amazon-adsystem\.com|pubmatic\.com|rubiconproject\.com|yieldmo\.com|celtra\.com|jivox\.com|extremereach\.io|vidible\.tv|aniview\.com|connatix\.com|unrulymedia\.com)$/i;
  function adHost(url) {
    try { return AD_HOST_RE.test(new URL(url).hostname) ? 'host' : ''; } catch (e) { return ''; }
  }

  // =============================================================================================
  // Module 20: a DASH track's segments as an .m3u8 (the manifest is read again only if the worker restarted)
  // =============================================================================================
  async function dashTrackPlaylist(tabId, url, index, comment) {
    const key = keyOf(url);
    await restoreTabLinks(tabId);
    const entry = entryFor(tabId, url);
    if (!key || !entry) return { error: 'unknown link' };
    let d = dashFull.get(key);
    if (!d) {
      const got = await probeFetch(entry.url, entry.referer || tabPageUrls.get(tabId) || '', true);
      if (!got) return { error: 'manifest not readable' };
      if (!got.complete) return { error: 'manifest too big' };
      d = P.dash(decodeText(got.bytes), got.url || entry.url);
      if (!d) return { error: 'not a DASH manifest' };
      putLimited(dashFull, key, d, 20);
    }
    if (d.live) return { error: 'live stream' };
    const track = d.tracks[index];
    if (!track) return { error: 'unknown track' };
    const text = P.dashPlaylist(track, comment);
    return text ? { text: text } : { error: 'no segments' };
  }

  // =============================================================================================
  // Module 21: embedded players, resolved on request through the service behind them (the same requests their own
  // player makes), with the page as Referer. Only for an embed listed in that tab.
  // =============================================================================================
  const RESOLVE_TIMEOUT_MS = 10000;
  async function getText(url, referer, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
    try {
      return await withProbeReferer(url, referer, async () => {
        const res = await fetch(url, { credentials: 'include', cache: 'no-store', headers: headers || {}, signal: ctrl.signal });
        if (!res.ok) return null;
        const text = await res.text();
        return text.length > 3000000 ? null : text;
      });
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function getJson(url, referer, headers) {
    const text = await getText(url, referer, headers);
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  const abs = (u, base) => { try { const x = new URL(String(u), base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } };
  const arr = (v) => (Array.isArray(v) ? v : []);

  const PROVIDERS = [
    {
      name: 'Vimeo',
      re: /^https?:\/\/player\.vimeo\.com\/video\/(\d+)/i,
      run: async (m, url, ref) => {
        let h = '';
        try { h = new URL(url).searchParams.get('h') || ''; } catch (e) {}
        const cfg = await getJson(`https://player.vimeo.com/video/${m[1]}/config${h ? `?h=${encodeURIComponent(h)}` : ''}`, ref);
        const req = cfg && cfg.request;
        if (!req) return null;
        const out = [];
        const hls = req.files && req.files.hls;
        if (hls && hls.cdns) {
          const cdn = hls.cdns[hls.default_cdn] || Object.values(hls.cdns)[0];
          if (cdn) [cdn.url, cdn.avc_url].forEach((u) => u && out.push({ url: u }));
        }
        arr(req.files && req.files.progressive).forEach((p) => p && p.url && out.push({ url: p.url }));
        arr(req.text_tracks).forEach((t) => t && t.url && out.push({ url: abs(t.url, 'https://player.vimeo.com/') }));
        return out;
      }
    },
    {
      name: 'JW Player',
      re: /^https?:\/\/(?:cdn\.jwplayer\.com|content\.jwplatform\.com)\/(?:players|previews|manifests)\/([a-z0-9]{8})(?:[-.]|$)/i,
      run: async (m, url, ref) => {
        const data = await getJson(`https://cdn.jwplayer.com/v2/media/${m[1]}`, ref);
        if (!data) return null;
        const out = [];
        arr(data.playlist).forEach((item) => {
          arr(item && item.sources).forEach((s) => s && s.file && out.push({ url: abs(s.file, 'https://cdn.jwplayer.com/'), type: s.type }));
          arr(item && item.tracks).forEach((t) => t && t.file && /captions|subtitles/i.test(t.kind || '') && out.push({ url: abs(t.file, 'https://cdn.jwplayer.com/') }));
        });
        return out;
      }
    },
    {
      name: 'Wistia',
      re: /^https?:\/\/(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([a-z0-9]+)/i,
      run: async (m, url, ref) => {
        const data = await getJson(`https://fast.wistia.com/embed/medias/${m[1]}.json`, ref);
        const media = data && data.media;
        if (!media) return null;
        return arr(media.assets)
          .filter((a) => a && a.url && !/still|storyboard|image/i.test(String(a.type || '')))
          .map((a) => ({ url: abs(a.url, 'https://fast.wistia.com/'), type: /audio/i.test(String(a.type || '')) ? 'audio' : '' }));
      }
    },
    {
      name: 'Dailymotion',
      re: /^https?:\/\/(?:(?:www\.)?dailymotion\.com\/embed\/video\/([a-z0-9]+)|geo\.dailymotion\.com\/player(?:\/[\w-]+)?\.html\?(?:[^#]*&)?video=([a-z0-9]+))/i,
      run: async (m, url, ref) => {
        const data = await getJson(`https://www.dailymotion.com/player/metadata/video/${m[1] || m[2]}`, ref);
        if (!data || !data.qualities) return null;
        const out = [];
        Object.values(data.qualities).forEach((list) => arr(list).forEach((q) => q && q.url && out.push({ url: q.url, type: q.type })));
        const subs = data.subtitles && data.subtitles.data;
        if (subs && typeof subs === 'object') Object.values(subs).forEach((s) => arr(s && s.urls).forEach((u) => out.push({ url: u })));
        return out;
      }
    },
    {
      name: 'Streamable',
      re: /^https?:\/\/(?:www\.)?streamable\.com\/[eos]\/([\w-]+)/i,
      run: async (m, url, ref) => {
        const data = await getJson(`https://api.streamable.com/videos/${m[1]}`, ref);
        if (!data || !data.files) return null;
        return Object.values(data.files).filter((f) => f && f.url).map((f) => ({ url: abs(f.url, 'https://streamable.com/') }));
      }
    },
    {
      // the HLS manifest of an entry is at a fixed address built from the partner and entry ids: read once to check
      name: 'Kaltura',
      re: /^https?:\/\/(?:[\w-]+\.)*kaltura\.com(?=.*?(?:\/p\/|partner_id[\/=])(\d+))(?=.*?entry_?id[\/=]([\w-]+))/i,
      run: async (m, url, ref) => {
        const manifest = `https://cdnapisec.kaltura.com/p/${m[1]}/sp/${m[1]}00/playManifest/entryId/${m[2]}/format/applehttp/protocol/https/a.m3u8`;
        const text = await getText(manifest, ref);
        return text && text.trimStart().startsWith('#EXTM3U') ? [{ url: manifest, type: 'application/x-mpegURL' }] : null;
      }
    },
    {
      name: 'Brightcove',
      re: /^https?:\/\/players\.brightcove\.net\/(\d+)\/([\w-]+?)_([\w-]+)\/index\.html\?(?:[^#]*&)?videoId=([^&#]+)/i,
      run: async (m, url, ref) => {
        const cfg = await getJson(`https://players.brightcove.net/${m[1]}/${m[2]}_${m[3]}/config.json`, ref);
        const pk = cfg && cfg.video_cloud && cfg.video_cloud.policy_key;
        if (!pk || !/^[\w.-]+$/.test(pk)) return null;
        const data = await getJson(`https://edge.api.brightcove.com/playback/v1/accounts/${m[1]}/videos/${encodeURIComponent(decodeURIComponent(m[4]))}`, ref, { Accept: `application/json;pk=${pk}` });
        if (!data) return null;
        const out = [];
        // each source comes twice, over http and https: the https one only (when there is one)
        const sources = arr(data.sources).filter((s) => s && typeof s.src === 'string' && /^https?:/i.test(s.src));
        const secure = sources.some((s) => /^https:/i.test(s.src));
        sources.forEach((s) => { if (!secure || /^https:/i.test(s.src)) out.push({ url: s.src, type: s.type }); });
        arr(data.text_tracks).forEach((t) => t && t.src && /captions|subtitles/i.test(t.kind || '') && out.push({ url: abs(t.src, 'https://players.brightcove.net/') }));
        return out;
      }
    }
  ];
  const providerFor = (url) => {
    for (const p of PROVIDERS) {
      const m = p.re.exec(url);
      if (m) return { p: p, m: m };
    }
    return null;
  };
  self.__VLE_X3_RESOLVABLE__ = (url) => !!providerFor(url);

  const kindOfType = (type) => {
    const t = String(type || '').toLowerCase();
    if (/mpegurl|^hls$/.test(t)) return 'hls';
    if (/dash\+xml|^dash$/.test(t)) return 'dash';
    return '';
  };
  async function addResolved(tabId, found, referer, provider) {
    let added = 0;
    for (const f of arr(found).slice(0, 60)) {
      const url = f && httpUrl(f.url);
      if (!url) continue;
      const manifest = kindOfType(f.type);
      const label = { resolvedFrom: provider };
      if (manifest && !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url)) label.manifest = manifest;
      if (f.type === 'audio') label.mediaKind = 'audio';
      if (await addNew(tabId, url, '', 'resolved', label, { referer: referer })) added++;
    }
    return added;
  }

  // A player already resolved on this page is not asked again: its service signs every answer differently, so a
  // second answer would list the same video once more
  const resolvedPlayers = new Map(); // `${tabId}|${page}|${player id}` -> number of streams found
  const playerKey = (tabId, hit) => `${tabId}|${pageKey(tabPageUrls.get(tabId) || '')}|${hit.p.name}|${hit.m.slice(1).filter(Boolean).join('/')}`;
  async function resolvePlayer(tabId, hit, playerUrl, referer) {
    const key = playerKey(tabId, hit);
    if (resolvedPlayers.has(key)) return { found: resolvedPlayers.get(key), added: 0, already: true };
    const found = await hit.p.run(hit.m, playerUrl, referer);
    if (!found) return { error: `${hit.p.name} did not answer` };
    putLimited(resolvedPlayers, key, found.length, 200);
    return { found: found.length, added: await addResolved(tabId, found, referer, hit.p.name) };
  }

  async function resolveEmbed(tabId, url) {
    await restoreTabLinks(tabId);
    const entry = entryFor(tabId, url);
    if (!entry || !entry.addon || !entry.addon.embed) return { error: 'not an embed listed in this tab' };
    const hit = providerFor(entry.url);
    if (!hit) return { error: 'this player cannot be resolved here: use yt-dlp' };
    return resolvePlayer(tabId, hit, entry.url, entry.referer || tabPageUrls.get(tabId) || '');
  }

  async function resolveOembed(tabId, url) {
    const st = await loadState(tabId);
    const known = st.page && st.page.oembed.find((o) => o.url === url);
    if (!known) return { error: 'not named by this page' };
    const referer = tabPageUrls.get(tabId) || '';
    const data = await getJson(url, referer);
    if (!data) return { error: 'no answer' };
    const src = /<iframe\b[^>]*\ssrc=["']([^"']+)["']/i.exec(String(data.html || ''));
    const player = src ? abs(src[1].replace(/&amp;/g, '&'), url) : '';
    const out = { provider: clip(data.provider_name, 60), player: player, added: 0 };
    if (!player) return out;
    const hit = providerFor(player);
    if (hit) {
      const res = await resolvePlayer(tabId, hit, player, referer);
      out.added = res.added || 0;
      if (res.already) out.already = true;
    } else if (await addNew(tabId, player, '', 'resolved', { embed: (out.provider || 'oEmbed').replace(/[^\w .-]/g, '').slice(0, 30) }, { referer: referer })) {
      out.added = 1;
    }
    return out;
  }
})();
