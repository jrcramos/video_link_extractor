// addon2-content.js - The newer add-on modules in the content-script world, loaded after addon2-decode.js. Like
// addon-content.js, they only ADD links: content.js and addon-content.js keep scanning exactly as before.
//   Relay:     findings from addon2-page.js (page world) to the background worker (addon2-worker.js)
//   Module 6:  media URLs in the page's inline scripts that content.js does not hand to inject.js, or that
//              inject.js cannot read (escaped, encoded, relative, formats it does not list)
//   Module 7:  asks the page's players for their playlists when the popup opens (see addon2-page.js)
//   Module 9:  frames with no address of their own (about:blank, srcdoc, blob:, data:), which the existing scripts
//              do not enter. manifest.json loads the existing page scripts (inject.js, addon-page.js) and
//              addon-content.js there too; this file then does content.js's part for them: relaying what inject.js
//              finds and scanning <video> / <audio> / <source> / <track>, with the nearest web page as Referer.
//              In ordinary frames that part stays off (content.js does it).
//   Module 11: keeps the names a media session gave the files it played, for the popup's + Name
(function () {
  if (window.__VLE_ADDON2_CONTENT__) return;
  window.__VLE_ADDON2_CONTENT__ = true;
  const dec = window.__VLE_DECODE__;
  if (!dec) return;

  const BLANK = /^(?:about|blob|data|filesystem):$/i.test(location.protocol);

  // The web page this frame belongs to: its own address, else (frames with none) the nearest ancestor's / opener's
  function nearestWebUrl() {
    const isWeb = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
    let w = window;
    for (let i = 0; i < 12 && w; i++) {
      try { if (isWeb(w.location.href)) return w.location.href; } catch (e) { break; }
      let next = null;
      try { next = w.parent !== w ? w.parent : w.opener; } catch (e) {}
      if (!next || next === w) break;
      w = next;
    }
    try { if (isWeb(document.referrer)) return document.referrer; } catch (e) {}
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length && isWeb(ao[0])) return `${ao[0]}/`;
    } catch (e) {}
    return '';
  }
  const frameUrl = () => (BLANK ? nearestWebUrl() : location.href);
  const baseUrl = () => { try { return document.baseURI || frameUrl(); } catch (e) { return frameUrl(); } };

  // ---- to the background worker, in batches
  const pending = [];
  let timer = null;
  function flush() {
    timer = null;
    const items = pending.splice(0, 200);
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ action: 'addon2Detect', items: items, frameUrl: frameUrl() }, () => {
        void chrome.runtime.lastError; // the worker may be restarting: nothing to do
      });
    } catch (e) {
      // Extension context might be invalidated if updated
    }
    if (pending.length) timer = setTimeout(flush, 300);
  }
  function queueItem(item) {
    if (pending.length >= 1000) return;
    pending.push(item);
    if (!timer) timer = setTimeout(flush, 300);
  }

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const urlList = (list) => (Array.isArray(list) ? list : []).slice(0, 60)
    .filter((f) => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
    .map((f) => ({ url: f.url.slice(0, 4000), via: str(f.via, 20) }));

  // ---- Module 11: media-session names, read by the popup (readPageVideoName) from this world
  const sessionNames = [];
  window.__VLE_SESSION_NAMES__ = sessionNames;
  function keepSessionName(url, name) {
    if (!/^https?:\/\//i.test(url) || !name) return;
    const at = sessionNames.findIndex((e) => e.url === url);
    if (at >= 0) sessionNames[at] = { url: url, name: name };
    else if (sessionNames.length < 300) sessionNames.push({ url: url, name: name });
  }

  // ---- from addon2-page.js (untrusted page context: the background checks every field again)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== '__VLE_ADDON2__') return;
    const p = event.data.payload;
    if (!p || typeof p !== 'object') return;
    if (p.module === 'hidden') {
      const urls = urlList(p.urls);
      if (urls.length) queueItem({ module: 'hidden', urls: urls });
    } else if (p.module === 'message') {
      const urls = urlList(p.urls);
      if (urls.length) queueItem({ module: 'message', channel: str(p.channel, 20), urls: urls });
    } else if (p.module === 'player' && Array.isArray(p.items)) {
      const items = p.items.slice(0, 300).filter((i) => i && typeof i.url === 'string').map((i) => ({ url: i.url.slice(0, 4000), kind: str(i.kind, 10) }));
      if (items.length) queueItem({ module: 'player', items: items });
    } else if ((p.module === 'blob' || p.module === 'webaudio') && typeof p.url === 'string') {
      queueItem({ module: p.module, url: p.url.slice(0, 4000), kind: str(p.kind, 10), duration: Number(p.duration) || 0 });
    } else if (p.module === 'session' && typeof p.url === 'string' && typeof p.name === 'string') {
      keepSessionName(p.url.slice(0, 4000), p.name.replace(/\s+/g, ' ').trim().slice(0, 200));
    }
  });
  window.postMessage({ type: '__VLE_ADDON2_READY__' }, '*');

  // =============================================================================================
  // Module 6: inline scripts
  // content.js hands an inline <script> to inject.js only when it mentions .m3u8 / .mpd / YouTube keywords, so a
  // player set up with a plain .mp4 / .mp3 is never read. Every inline script is looked through here; for the
  // ones content.js does hand over, what inject.js finds in them is left out.
  // =============================================================================================
  const seenScripts = new WeakSet();
  const SCRIPT_MAX = 2000000;
  function scanScripts(root) {
    let scripts = [];
    try { scripts = Array.from((root || document).querySelectorAll('script:not([src])')); } catch (e) { return; }
    scripts.forEach((s) => {
      if (seenScripts.has(s)) return;
      seenScripts.add(s);
      const text = s.textContent || '';
      if (text.length < 10 || text.length > SCRIPT_MAX || !dec.mayHaveMedia(text)) return;
      const handedOver = dec.contentWouldScan(text, window.__VLE_DRM__);
      if (BLANK && handedOver) window.postMessage({ type: '__VLE_SCAN_TEXT__', text: text }, '*'); // module 9: content.js's part
      const found = dec.extract(text, baseUrl(), { exclude: handedOver, via: handedOver ? 'format' : 'script' });
      if (found.length) queueItem({ module: 'hidden', urls: urlList(found) });
    });
  }

  // =============================================================================================
  // Module 9: content.js's part in frames with no address of their own
  // =============================================================================================
  const frameSeen = new Set();
  const resolve = (raw) => {
    try {
      if (typeof raw !== 'string' || !raw.trim()) return '';
      const u = new URL(raw.trim(), baseUrl());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (/\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i.test(u.href)) return '';
      u.hash = '';
      return u.href;
    } catch (e) {
      return '';
    }
  };
  function reportFrame(raw, poster) {
    const url = resolve(raw);
    if (!url || frameSeen.has(url) || frameSeen.size >= 300) return;
    frameSeen.add(url);
    queueItem({ module: 'frame', url: url.slice(0, 4000), poster: (resolve(poster) || '').slice(0, 4000) });
  }
  function scanFrameMedia(root) {
    try {
      root.querySelectorAll('video, audio').forEach((el) => {
        const poster = el.poster || el.getAttribute('poster') || '';
        reportFrame(el.currentSrc || el.src, poster);
        el.querySelectorAll('source, track').forEach((s) => reportFrame(s.src || s.getAttribute('src'), poster));
      });
      root.querySelectorAll('source[src], track[src]').forEach((s) => reportFrame(s.src || s.getAttribute('src'), ''));
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) scanFrameMedia(el.shadowRoot); });
    } catch (e) {}
  }
  if (BLANK) {
    // what inject.js finds in this frame (it waits for content.js's "ready", which never comes here)
    const seenSignals = new Set();
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;
      const d = event.data;
      if (d.type === '__VLE_SNIFFED_MEDIA__' && Array.isArray(d.links)) {
        d.links.slice(0, 300).forEach((l) => reportFrame(typeof l === 'string' ? l : (l && l.url), l && l.poster));
      } else if (d.type === '__VLE_DRM_SIGNAL__' && d.payload && typeof d.payload === 'object') {
        let key;
        try { key = JSON.stringify(d.payload); } catch (e) { return; }
        if (seenSignals.has(key) || seenSignals.size > 300) return;
        seenSignals.add(key);
        try { chrome.runtime.sendMessage({ action: 'drmSignal', signal: d.payload, frameUrl: frameUrl() }, () => { void chrome.runtime.lastError; }); } catch (e) {}
      }
    });
    window.postMessage({ type: '__VLE_CONTENT_READY__' }, '*');
  }

  // ---- when: once loaded, for what the page adds, and each time the popup opens
  function scanAll() {
    try { scanScripts(document); } catch (e) {}
    if (BLANK) scanFrameMedia(document);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanAll);
  else scanAll();

  let addedTimer = null;
  try {
    new MutationObserver((mutations) => {
      if (addedTimer) return;
      for (const m of mutations) {
        for (let i = 0; i < m.addedNodes.length; i++) {
          const n = m.addedNodes[i];
          if (n.nodeType !== 1) continue;
          const tag = n.tagName;
          if (tag === 'SCRIPT' || (BLANK && /^(?:VIDEO|AUDIO|SOURCE|TRACK)$/.test(tag)) || (n.querySelector && n.querySelector(BLANK ? 'script, video, audio, source, track' : 'script'))) {
            addedTimer = setTimeout(() => { addedTimer = null; scanAll(); }, 500);
            return;
          }
        }
      }
    }).observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (e) {}

  try {
    chrome.runtime.onMessage.addListener((request) => {
      if (request && request.action === 'forceContentScan') {
        scanAll();
        window.postMessage({ type: '__VLE_ADDON2_PROBE__' }, '*'); // module 7
      }
      return false;
    });
  } catch (e) {}
})();
