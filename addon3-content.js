// addon3-content.js - The third set of add-on modules in the content-script world, loaded after addon3-text.js.
// Like the other add-on content files they only ADD: content.js, addon-content.js and addon2-content.js keep
// scanning exactly as before.
//   Relay:     findings from addon3-page.js (page world) to the background worker (addon3-worker.js)
//   Module 16: a VAST answer opened as a document of its own (ads)
//   Module 17: an RSS / Atom feed or .xspf / .asx playlist opened as a document of its own (an address typed in the tab)
//   Module 21: the oEmbed description a page names for itself (top frame), for the popup's 🔍 Resolve
(function () {
  if (window.__VLE_X3_CONTENT__) return;
  window.__VLE_X3_CONTENT__ = true;
  const T = window.__VLE_X3_TEXT__;

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
    return '';
  }
  const frameUrl = () => (BLANK ? nearestWebUrl() : location.href);

  // ---- to the background worker, in batches
  const pending = [];
  let timer = null;
  function flush() {
    timer = null;
    const items = pending.splice(0, 100);
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ action: 'x3Detect', items: items, frameUrl: frameUrl() }, () => {
        void chrome.runtime.lastError; // the worker may be restarting: nothing to do
      });
    } catch (e) {
      // Extension context might be invalidated if updated
    }
    if (pending.length) timer = setTimeout(flush, 300);
  }
  function queueItem(item) {
    if (pending.length >= 300) return;
    pending.push(item);
    if (!timer) timer = setTimeout(flush, 300);
  }

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const urls = (list, max) => (Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, max).map((u) => u.slice(0, 4000));

  // ---- from addon3-page.js (untrusted page context: the background checks every field again)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== '__VLE_X3__') return;
    const p = event.data.payload;
    if (!p || typeof p !== 'object') return;
    switch (p.module) {
      case 'rtc':
        queueItem({ module: 'rtc', id: num(p.id), video: num(p.video), audio: num(p.audio), ice: (Array.isArray(p.ice) ? p.ice : []).slice(0, 6).map((h) => str(h, 100)), codecs: (Array.isArray(p.codecs) ? p.codecs : []).slice(0, 6).map((c) => str(c, 30)), state: str(p.state, 20), frame: str(p.frame, 300) });
        break;
      case 'sig':
      case 'wt':
        if (typeof p.url === 'string') queueItem({ module: p.module, url: p.url.slice(0, 4000), kind: str(p.kind, 10) });
        break;
      case 'ws':
        if (typeof p.url === 'string') queueItem({ module: 'ws', url: p.url.slice(0, 2000), format: str(p.format, 20) });
        break;
      case 'codec':
        queueItem({ module: 'codec', kind: str(p.kind, 10), codec: str(p.codec, 60), w: num(p.w), h: num(p.h), rate: num(p.rate), ch: num(p.ch) });
        break;
      case 'ad':
        queueItem({ module: 'ad', urls: urls(p.urls, 40) });
        break;
      case 'feed':
        if (Array.isArray(p.items)) {
          const items = p.items.filter((i) => i && typeof i.url === 'string' && /^https?:\/\//i.test(i.url)).slice(0, 60).map((i) => ({ url: i.url.slice(0, 4000), kind: i.kind === 'audio' ? 'audio' : '' }));
          if (items.length) queueItem({ module: 'feed', via: str(p.via, 10), items: items });
        }
        break;
      default:
        break;
    }
  });
  window.postMessage({ type: '__VLE_X3_READY__' }, '*');

  // =============================================================================================
  // Modules 16 + 17: this frame's document is itself a VAST answer, a feed or a playlist (Chrome shows XML files
  // as a tree; the original text is read back from the document)
  // =============================================================================================
  let docDone = false;
  function scanDocument() {
    if (docDone || !T) return;
    const type = String(document.contentType || '').toLowerCase();
    if (!/xml/.test(type) || /xhtml|svg/.test(type)) return;
    // Chrome's XML viewer turns the document into a tree view and keeps the original nodes in a hidden element
    const viewer = document.getElementById('webkit-xml-viewer-source-xml');
    const nodes = viewer ? Array.from(viewer.children) : [document.documentElement];
    const root = nodes[0];
    const name = root ? String(root.nodeName || '').replace(/^[\w-]+:/, '') : '';
    if (!/^(?:VAST|rss|feed|asx|playlist)$/i.test(name)) return;
    docDone = true;
    let text = '';
    try { text = nodes.map((n) => new XMLSerializer().serializeToString(n)).join(''); } catch (e) { return; }
    if (text.length > 2000000) return;
    const kind = T.kindOf(text);
    const base = location.href;
    if (kind === 'vast') {
      const list = T.vastMedia(text, base);
      if (list.length) queueItem({ module: 'ad', urls: list });
    } else if (kind === 'rss' || kind === 'atom') {
      const items = T.feedMedia(text, base, 60);
      if (items.length) queueItem({ module: 'feed', via: kind, items: items });
    } else if (kind === 'asx' || kind === 'xspf') {
      const list = T.playlistUrls(text, base, kind);
      if (list.length) queueItem({ module: 'feed', via: kind, items: list.map((u) => ({ url: u, kind: T.AUDIO_PATH.test(u.split('?')[0]) ? 'audio' : '' })) });
    }
  }

  // =============================================================================================
  // Module 21: the page's oEmbed description of itself (a video page whose player is not on it yet: a picture with
  // a play button that loads it on click). Only named here; the popup fetches it when you press 🔍 Resolve.
  // =============================================================================================
  const oembedSent = new Set();
  function scanOembed() {
    if (window !== window.top) return;
    try {
      document.querySelectorAll('link[type="application/json+oembed"][href]').forEach((l) => {
        if (oembedSent.size >= 3) return;
        let url = '';
        try { url = new URL(l.getAttribute('href'), location.href).href; } catch (e) { return; }
        if (!/^https?:\/\//i.test(url) || oembedSent.has(url)) return;
        oembedSent.add(url);
        queueItem({ module: 'oembed', url: url.slice(0, 4000), title: str(l.getAttribute('title') || '', 120) });
      });
    } catch (e) {}
  }

  function scanAll() {
    try { scanDocument(); } catch (e) {}
    try { scanOembed(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanAll);
  else scanAll();
  try {
    chrome.runtime.onMessage.addListener((request) => {
      if (request && request.action === 'forceContentScan') scanAll();
      return false;
    });
  } catch (e) {}
})();
