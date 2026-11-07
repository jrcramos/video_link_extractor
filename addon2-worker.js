// addon2-worker.js - The newer add-on modules in the background worker, loaded after addon-worker.js and sharing
// background.js's functions (addLinkToTab, normalizeUrl, getRefererFromDetails, ...). Like addon-worker.js they only
// ADD links: a link the existing detection already has is never touched.
//
// A link only these modules have found is marked addon.onlyNew. While it is, background.js's "nothing found yet"
// mobile fallback and module 5's "stream already covered" check ignore it, so both decide exactly as before. When
// one of the existing finders reaches the same link later (the network sniffer, content.js, add-on modules 1-3),
// the entry is set back to what that finder would have stored had it been first (its Referer, its add-on label,
// no label of ours), and from then on it counts like any other link.
(function () {
  const api = self.__VLE_ADDON_WORKER__ || {};
  const refererFor = typeof api.refererFor === 'function' ? api.refererFor : (u, frameUrl) => frameUrl || '';
  const httpUrl = (u) => (typeof u === 'string' && u.length <= 4000 && /^https?:\/\//i.test(u) ? u : '');
  const entryFor = (tabId, url) => {
    const tabMap = videoLinks.get(tabId);
    const norm = normalizeUrl(url);
    return (tabMap && norm && tabMap.get(drm.keyFor(norm))) || null;
  };
  const isOnlyNew = (e) => !!(e && e.addon && e.addon.onlyNew);

  // Links an existing finder reported in the last minute (some of them add it a moment later, after a storage
  // read): these modules never add those themselves
  const oldSeen = new Map(); // `${tabId}|${normalized url}` -> time
  const noteOld = (tabId, url) => {
    const norm = normalizeUrl(url);
    if (!norm) return;
    const key = `${tabId}|${drm.keyFor(norm)}`;
    oldSeen.delete(key);
    oldSeen.set(key, Date.now());
    if (oldSeen.size > 3000) oldSeen.delete(oldSeen.keys().next().value);
  };
  const seenByOld = (tabId, norm) => {
    const at = oldSeen.get(`${tabId}|${drm.keyFor(norm)}`);
    return !!at && Date.now() - at < 60000;
  };

  // Pieces / init files of a segmented stream are left to the existing grouping, and nothing joins a family it
  // has already formed
  const canAdd = (tabId, norm) => {
    if (CHUNK_URL_RE.test(norm) || drm.segmentInfo(norm) || drm.isInitLike(norm)) return false;
    const seg = drm.genericSegment(norm);
    const fams = tabFamilies.get(tabId);
    return !(seg && fams && fams.has(seg.famKey));
  };

  // A link found by one of these modules -> a new entry labelled with its module; null when the link is known
  const addNew = async (tabId, rawUrl, frameUrl, source, label = {}, opts = {}) => {
    const url = httpUrl(rawUrl);
    if (tabId < 0 || !url) return null;
    await restoreTabLinks(tabId); // a link stored before a worker restart is known too
    const norm = normalizeUrl(url);
    if (!norm || !canAdd(tabId, norm) || entryFor(tabId, norm) || seenByOld(tabId, norm)) return null;
    addLinkToTab(tabId, norm, opts.referer || refererFor(norm, frameUrl), opts.poster || '', false, opts.size || 0, '');
    const entry = entryFor(tabId, norm);
    if (!entry || entry.addon || entry.segmented) return null;
    entry.addon = { ...label, source: source, onlyNew: true };
    if (opts.duration > 0 && !entry.duration) {
      entry.duration = opts.duration;
      entry.addon.ownDuration = true;
    }
    saveTabLinksDebounced(tabId);
    return entry;
  };

  // ---- an existing finder reached a link one of these modules listed first: store what it would have stored
  const confirmOld = (tabId, url, view) => {
    noteOld(tabId, url);
    const entry = entryFor(tabId, url);
    if (!isOnlyNew(entry)) return;
    if (view.referer) entry.referer = view.referer;
    if (view.isMobile) entry.isMobile = true;
    if (entry.addon.ownDuration) delete entry.duration;
    if (view.addon) entry.addon = view.addon;
    else delete entry.addon;
    saveTabLinksDebounced(tabId);
  };

  // the network sniffer (background.js listeners 2 and 3, same conditions)
  const confirmByNetwork = (details) => {
    try {
      if (details.tabId < 0 || !details.url) return;
      confirmOld(details.tabId, details.url, { referer: getRefererFromDetails(details) || tabPageUrls.get(details.tabId) || '' });
    } catch (e) {}
  };
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (details.tabId >= 0 && details.url && (videoRegex.test(details.url) || videoQueryRegex.test(details.url) || drm.isDrmUrl(details.url))) confirmByNetwork(details);
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
  );

  // the mobile fallback (background.js scanPageWithMobileUA): it fetches the page as an iPhone and lists the media
  // that HTML names. Its request is recognised by that User-Agent and passed through untouched; a copy of the HTML is
  // read with the same patterns, so a link it lists that one of these modules listed first gets its entry
  // (📱 Mobile Direct, the page as Referer).
  const mobileLinksIn = (raw, baseUrl) => {
    const html = raw.replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const found = [...(html.match(htmlMediaUrlRegex) || []), ...(html.match(htmlSignatureUrlRegex) || [])];
    if (typeof drm.findDrmUrls === 'function') found.push(...drm.findDrmUrls(html));
    const tagSrcRegex = /<(?:video|source|track|meta)[^>]+(?:src|content)=["'](https?:\/\/[^"'>]+)["']/gi;
    let m;
    while ((m = tagSrcRegex.exec(html)) !== null) if (m[1]) found.push(m[1]);
    const relSrcRegex = /<(?:video|audio|source|track)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;
    while ((m = relSrcRegex.exec(html)) !== null) {
      try { if (m[1]) found.push(new URL(m[1], baseUrl).toString()); } catch (e) {}
    }
    return Array.from(new Set(found));
  };
  try {
    const previousFetch = self.fetch;
    if (typeof previousFetch === 'function' && typeof MOBILE_UA === 'string') {
      self.fetch = function (input, init) {
        const pending = previousFetch.apply(this, arguments);
        try {
          const headers = init && init.headers;
          if (typeof input === 'string' && headers && typeof headers === 'object' && !(headers instanceof Headers) && headers['User-Agent'] === MOBILE_UA) {
            pending.then((res) => res.clone().text().then((raw) => {
              const links = mobileLinksIn(raw, res.url || input);
              tabPageUrls.forEach((pageUrl, tabId) => {
                if (typeof pageUrl !== 'string' || pageUrl.split('#')[0] !== input) return;
                links.forEach((u) => {
                  const norm = normalizeUrl(u);
                  if (norm) confirmOld(tabId, norm, { referer: pageUrl, isMobile: true });
                });
              });
            })).catch(() => {});
          }
        } catch (e) {}
        return pending;
      };
    }
  } catch (e) {}

  // =============================================================================================
  // Module 6 (network part): a download whose Content-Disposition names a .flac / .opus / .ogv / .wmv / .3gp /
  // .f4v file (formats background.js lists by URL and type, but not by that header), served with a type that
  // says nothing (application/octet-stream, ...)
  // =============================================================================================
  const DISPOSITION_EXT = /\.(?:flac|opus|ogv|wmv|3gp|f4v)(?=["';\s]|$)/i;
  const dispositionName = (headers) => {
    const h = (headers || []).find((x) => x.name.toLowerCase() === 'content-disposition');
    if (!h || !h.value) return '';
    let v = h.value;
    try { v = decodeURIComponent(v); } catch (e) {}
    return DISPOSITION_EXT.test(v) ? v : '';
  };
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      try {
        if (details.tabId < 0 || !details.url) return;
        if (isVideoHeader(details.responseHeaders) || drm.isDrmUrl(details.url)) { confirmByNetwork(details); return; }
        if (CHUNK_URL_RE.test(details.url) || videoRegex.test(details.url) || videoQueryRegex.test(details.url)) return;
        const named = dispositionName(details.responseHeaders);
        if (!named) return;
        const label = /\.(?:flac|opus)(?=["';\s]|$)/i.test(named) ? { hiddenVia: 'download', mediaKind: 'audio' } : { hiddenVia: 'download' };
        addNew(details.tabId, details.url, '', 'hidden', label, {
          referer: getRefererFromDetails(details), size: getContentLength(details.responseHeaders)
        }).catch(() => {});
      } catch (e) {}
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
  );

  // ---- findings sent by addon2-content.js (untrusted page context: every field is checked again)
  const str = (v, max) => (typeof v === 'string' ? v.replace(/[^\w .:/-]/g, '').slice(0, max) : '');
  const MANIFEST_EXT = /\.(?:m3u8|m3u|mpd)(?:[?#]|$)/i;
  const handlers = {
    // Module 6: escaped / encoded / relative URLs and formats inject.js does not list
    hidden: async (tabId, item, frameUrl) => {
      for (const f of (Array.isArray(item.urls) ? item.urls : []).slice(0, 60)) {
        if (f && typeof f.url === 'string') await addNew(tabId, f.url, frameUrl, 'hidden', { hiddenVia: str(f.via, 20) || 'text' });
      }
    },
    // Module 7: a player's playlist / sources
    player: async (tabId, item, frameUrl) => {
      for (const i of (Array.isArray(item.items) ? item.items : []).slice(0, 300)) {
        if (!i || typeof i.url !== 'string') continue;
        const kind = i.kind === 'hls' || i.kind === 'dash' ? i.kind : '';
        // a playlist at an address that does not say so: labelled like module 1 does, so it gets qualities / Play
        const label = kind && !MANIFEST_EXT.test(i.url) ? { manifest: kind } : {};
        await addNew(tabId, i.url, frameUrl, 'player', label);
      }
    },
    // Module 8: a whole file played from memory / decoded by Web Audio
    blob: async (tabId, item, frameUrl) => {
      await addNew(tabId, item.url, frameUrl, 'blob', item.kind === 'audio' ? { mediaKind: 'audio' } : {});
    },
    webaudio: async (tabId, item, frameUrl) => {
      const d = Number(item.duration);
      await addNew(tabId, item.url, frameUrl, 'webaudio', { mediaKind: 'audio' }, { duration: d > 0 && d < 86400 ? d : 0 });
    },
    // Module 9: found by content.js's / inject.js's checks inside a frame with no address of its own
    frame: async (tabId, item, frameUrl) => {
      await addNew(tabId, item.url, frameUrl, 'frame', {}, { referer: frameUrl, poster: httpUrl(item.poster) });
    },
    // Module 10: named in a message the page received
    message: async (tabId, item, frameUrl) => {
      const channel = ['websocket', 'eventsource', 'worker', 'window', 'other'].includes(item.channel) ? item.channel : 'other';
      for (const f of (Array.isArray(item.urls) ? item.urls : []).slice(0, 60)) {
        if (f && typeof f.url === 'string') await addNew(tabId, f.url, frameUrl, 'message', { messageVia: channel });
      }
    }
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.action !== 'string') return false;
    const tabId = sender && sender.tab ? sender.tab.id : -1;

    if (request.action === 'addon2Detect') {
      if (tabId >= 0 && Array.isArray(request.items)) {
        const frameUrl = httpUrl(request.frameUrl) || (sender.tab && sender.tab.url) || '';
        // one item after another: two modules reporting the same link never add it twice
        request.items.slice(0, 300).reduce((chain, item) => chain.then(() => {
          const handler = item && handlers[item.module];
          return handler ? handler(tabId, item, frameUrl).catch(() => {}) : null;
        }), Promise.resolve());
      }
      sendResponse({ ok: true });
      return false;
    }

    // ---- the existing finders, watched (never answered: background.js / addon-worker.js answer them)
    try {
      if (request.action === 'addLinksFromContent' && tabId >= 0 && Array.isArray(request.links)) {
        // content.js: the Referer background.js's handler passes for a new link
        const fallback = (sender.tab && sender.tab.url) || '';
        request.links.forEach((item) => {
          const url = typeof item === 'string' ? item : (item && item.url);
          const referer = (typeof item === 'object' && item && item.referer) || request.frameUrl || fallback;
          if (typeof url === 'string') confirmOld(tabId, url, { referer: referer || tabPageUrls.get(tabId) || '' });
        });
      } else if (request.action === 'addonDetect' && tabId >= 0 && Array.isArray(request.items)) {
        // add-on modules 1-3: the entry addon-worker.js would have made
        const frameUrl = httpUrl(request.frameUrl) || (sender.tab && sender.tab.url) || '';
        request.items.slice(0, 300).forEach((item) => {
          const url = item && httpUrl(item.url);
          if (!url) return;
          let addon = null;
          if (item.module === 'manifest' && (item.manifest === 'hls' || item.manifest === 'dash')) addon = { manifest: item.manifest, source: 'content' };
          else if (item.module === 'page') addon = { pageVia: ['link', 'meta', 'attr', 'frame'].includes(item.via) ? item.via : 'link', source: 'page' };
          else if (item.module === 'embed' && typeof item.provider === 'string') addon = { embed: item.provider.replace(/[^\w .-]/g, '').slice(0, 30), source: 'embed' };
          if (addon) confirmOld(tabId, url, { referer: refererFor(url, frameUrl), addon: addon });
        });
      }
    } catch (e) {}
    return false;
  });
})();
