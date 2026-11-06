// addon-content.js - Add-on detection modules in the content-script world, loaded right after content.js.
// They only ADD links: content.js keeps scanning exactly as before.
//   Relay: findings from addon-page.js (page world) to the background worker
//   Module 2: media the page links to or keeps in its player settings, played or not
//   Module 3: embedded players of video platforms (YouTube, Vimeo, ...)
(function () {
  if (window.__VLE_ADDON_CONTENT__) return;
  window.__VLE_ADDON_CONTENT__ = true;

  const MODULES = new Set(['manifest', 'mse']); // what addon-page.js may send
  const pending = [];
  let timer = null;

  function flush() {
    timer = null;
    const items = pending.splice(0, 200);
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ action: 'addonDetect', items: items, frameUrl: window.location.href }, () => {
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

  // From addon-page.js (untrusted page context: the background checks every field again)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== '__VLE_ADDON__') return;
    const p = event.data.payload;
    if (!p || typeof p !== 'object' || !MODULES.has(p.module)) return;
    if (p.module === 'manifest' && typeof p.url === 'string') {
      queueItem({ module: 'manifest', url: p.url.slice(0, 4000), manifest: p.manifest, via: p.via }); // module 1
    } else if (p.module === 'mse' && typeof p.stream === 'string' && Array.isArray(p.urls)) {
      const urls = p.urls.filter((u) => typeof u === 'string').slice(0, 3000).map((u) => u.slice(0, 4000));
      queueItem({ module: 'mse', stream: p.stream.slice(0, 60), mime: String(p.mime || '').slice(0, 120), from: Number(p.from) || 0, urls: urls }); // module 5
    }
  });
  window.postMessage({ type: '__VLE_ADDON_READY__' }, '*');

  // =============================================================================================
  // Module 2: media the page links to or keeps in its player settings
  // content.js lists <video> / <audio> / <source> / <track> and what the page loads. This adds what the page only
  // points at: download links (<a href="...mp4">), og:video / og:audio / twitter:player:stream tags, frames and
  // objects showing a media file, and media URLs kept in data-* attributes (click-to-play players, JSON configs).
  // Only URLs whose path ends in a media extension count (or that a meta tag types as media), and a bare file
  // name without a path ("clip.mp4" as a label) is never taken for a link.
  // =============================================================================================
  const PAGE_MAX = 150; // per frame: a long directory listing does not flood the list
  const pageReported = new Set();
  const MEDIA_EXT = 'm3u8|mpd|m3u|mp4|webm|mkv|mov|m4v|ogv|flv|avi|wmv|3gp|mp3|m4a|aac|flac|wav|ogg|opus';
  const MEDIA_PATH = new RegExp(`\\.(?:${MEDIA_EXT})$`, 'i');
  const MEDIA_HINT = new RegExp(`\\.(?:${MEDIA_EXT})(?=$|[?#"'\\s&;,)\\]}])`, 'i');
  const ABSOLUTE_IN_TEXT = new RegExp(`(?:https?:)?\\/\\/[^\\s"'<>\\\\()]+?\\.(?:${MEDIA_EXT})(?:\\?[^\\s"'<>\\\\()]*)?(?=$|[\\s"'<>\\\\(),;\\]}])`, 'gi');
  const QUOTED_ROOT_PATH = new RegExp(`["'](\\/[^"'\\s<>]+?\\.(?:${MEDIA_EXT})(?:\\?[^"'\\s<>]*)?)["']`, 'gi');
  const WHOLE_PATH = new RegExp(`^(?:\\.{0,2}\\/)?[^\\s"'<>:]*\\/[^\\s"'<>:]*\\.(?:${MEDIA_EXT})(?:\\?[^\\s"'<>]*)?$`, 'i');

  function toMediaUrl(raw, needExt) {
    try {
      const u = new URL(String(raw).trim().replace(/&amp;/g, '&'), window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (needExt && !MEDIA_PATH.test(u.pathname)) return '';
      u.hash = '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function reportPage(raw, via, needExt = true) {
    if (pageReported.size >= PAGE_MAX || !raw) return;
    const url = toMediaUrl(raw, needExt);
    if (!url || pageReported.has(url)) return;
    pageReported.add(url);
    queueItem({ module: 'page', url: url.slice(0, 4000), via: via });
  }

  // Media URLs inside one attribute value: an absolute URL anywhere in it (JSON configs, with \/ escapes undone),
  // a quoted root-relative path ('"/v/a.mp4"'), or a value that is a relative path as a whole ("videos/a.mp4")
  function urlsInAttribute(raw) {
    const v = String(raw || '');
    if (v.length < 5 || v.length > 20000 || !MEDIA_HINT.test(v)) return [];
    const text = v.replace(/\\\//g, '/');
    const out = [];
    if (WHOLE_PATH.test(text.trim())) out.push(text.trim());
    (text.match(ABSOLUTE_IN_TEXT) || []).forEach((u) => out.push(u));
    QUOTED_ROOT_PATH.lastIndex = 0;
    let m;
    while ((m = QUOTED_ROOT_PATH.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  // OpenGraph groups its tags: og:video (= og:video:url) starts one video, the og:video:secure_url / og:video:type
  // that follow belong to it. A type naming a media format vouches for that video's URLs even without an
  // extension; anything else (text/html: an embed page) still needs one.
  const MEDIA_TYPE = /^(?:video|audio)\/|mpegurl|dash\+xml/i;
  function scanMeta() {
    const groups = [];
    const current = {};
    const take = (kind, key, value) => {
      if (key === `og:${kind}` || key === `og:${kind}:url`) {
        const last = current[kind];
        if (!last || (last.urls[0] && last.urls[0] !== value)) { current[kind] = { urls: [], type: '' }; groups.push(current[kind]); }
        if (!current[kind].urls.includes(value)) current[kind].urls.push(value);
      } else if (key === `og:${kind}:secure_url`) {
        if (!current[kind]) { current[kind] = { urls: [], type: '' }; groups.push(current[kind]); }
        current[kind].urls.push(value);
      } else if (key === `og:${kind}:type` && current[kind]) {
        current[kind].type = value;
      }
    };
    let stream = null;
    document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
      const key = String(m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      const value = String(m.getAttribute('content') || '').trim();
      if (!value) return;
      if (key.startsWith('og:video')) take('video', key, value);
      else if (key.startsWith('og:audio')) take('audio', key, value);
      else if (key === 'twitter:player:stream') { stream = { urls: [value], type: '' }; groups.push(stream); }
      else if (key === 'twitter:player:stream:content_type' && stream) stream.type = value;
    });
    groups.forEach((g) => g.urls.forEach((u) => {
      const media = MEDIA_TYPE.test(g.type);
      reportPage(u, 'meta', !media);
      if (!media) reportEmbed(u, 'meta'); // og:video pointing at a player page (module 3)
    }));
  }

  // One element: a link, a frame / object, data-* attributes holding a media URL
  function scanElement(el) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') reportPage(el.getAttribute('href'), 'link');
    else if (tag === 'IFRAME' || tag === 'EMBED') {
      reportPage(el.getAttribute('src'), 'frame');
      // module 3: embedded players, including lazy frames that keep their address in data-src until scrolled to
      ['src', 'data-src', 'data-lazy-src'].forEach((name) => reportEmbed(el.getAttribute(name), 'frame'));
    } else if (tag === 'OBJECT') reportPage(el.getAttribute('data'), 'frame');
    if (el.hasAttributes()) {
      const names = el.getAttributeNames();
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (name.length <= 5 || !name.startsWith('data-')) continue;
        const value = el.getAttribute(name);
        if (value && value.length >= 5 && MEDIA_HINT.test(value)) urlsInAttribute(value).forEach((u) => reportPage(u, 'attr'));
      }
    }
  }

  // =============================================================================================
  // Module 3: embedded players
  // A frame showing a known video platform's player often never exposes a direct stream to the page. Its player
  // address, with this page as Referer, is what yt-dlp (or a downloader using it) needs; some (Vimeo) refuse to
  // play without that Referer. YouTube players are listed by their watch URL.
  // =============================================================================================
  const EMBED_MAX = 50;
  const embedReported = new Set();
  const EMBEDS = [
    { name: 'YouTube', re: /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})(?:[?#/]|$)/i, url: (m) => `https://www.youtube.com/watch?v=${m[1]}` },
    { name: 'Vimeo', re: /^https?:\/\/player\.vimeo\.com\/video\/\d+/i },
    { name: 'Dailymotion', re: /^https?:\/\/(?:www\.)?dailymotion\.com\/embed\/video\/[a-z0-9]+/i },
    { name: 'Dailymotion', re: /^https?:\/\/geo\.dailymotion\.com\/player(?:\/[\w-]+)?\.html\?(?:[^#]*&)?video=[a-z0-9]+/i },
    { name: 'Wistia', re: /^https?:\/\/(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/[a-z0-9]+/i },
    { name: 'Brightcove', re: /^https?:\/\/players\.brightcove\.net\/\d+\/[\w-]+\/index\.html\?(?:[^#]*&)?videoId=/i },
    { name: 'JW Player', re: /^https?:\/\/(?:cdn\.jwplayer\.com|content\.jwplatform\.com)\/players\/[\w-]+\.html/i },
    { name: 'Streamable', re: /^https?:\/\/(?:www\.)?streamable\.com\/[eos]\/[\w-]+/i },
    { name: 'Twitch', re: /^https?:\/\/(?:player\.twitch\.tv\/\?(?:[^#]*&)?(?:video|channel|collection)=|clips\.twitch\.tv\/embed\?(?:[^#]*&)?clip=)/i },
    { name: 'Kaltura', re: /^https?:\/\/(?:[\w-]+\.)*kaltura\.com\/(?:p\/\d+\/|index\.php\/extwidget\/preview)/i },
    { name: 'Rumble', re: /^https?:\/\/(?:www\.)?rumble\.com\/embed\/[\w.-]+/i },
    { name: 'Odysee', re: /^https?:\/\/(?:www\.)?odysee\.com\/\$\/embed\//i },
    { name: 'Bilibili', re: /^https?:\/\/player\.bilibili\.com\/player\.html\?/i },
    { name: 'Facebook', re: /^https?:\/\/(?:www\.)?facebook\.com\/plugins\/video\.php\?/i },
    { name: 'TikTok', re: /^https?:\/\/(?:www\.)?tiktok\.com\/(?:embed(?:\/v2)?|player\/v1)\/\d+/i },
    { name: 'SoundCloud', re: /^https?:\/\/w\.soundcloud\.com\/player\/\?(?:[^#]*&)?url=/i }
  ];

  function reportEmbed(raw, via) {
    if (!raw || embedReported.size >= EMBED_MAX) return;
    let abs;
    try {
      const u = new URL(String(raw).trim().replace(/&amp;/g, '&'), window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      abs = u.href;
    } catch (e) {
      return;
    }
    for (const e of EMBEDS) {
      const m = e.re.exec(abs);
      if (!m) continue;
      const url = e.url ? e.url(m) : abs.split('#')[0];
      if (embedReported.has(url)) return;
      embedReported.add(url);
      queueItem({ module: 'embed', url: url.slice(0, 4000), provider: e.name, via: via });
      return;
    }
  }

  // ---- when modules 2 and 3 look: the whole page once loaded and each time the popup opens; in between, only
  // the elements the page adds. The work is cut into slices of a few milliseconds, so even a huge page that keeps
  // changing (an endless feed) never freezes on it.
  const SLICE_MS = 8;
  const MAX_QUEUE = 300000;
  let queue = [];
  let head = 0;
  let sliceTimer = null;
  const enqueue = (elements) => {
    if (queue.length - head + elements.length > MAX_QUEUE) return;
    for (let i = 0; i < elements.length; i++) queue.push(elements[i]);
    if (!sliceTimer) sliceTimer = setTimeout(runSlice, 0);
  };
  function runSlice() {
    sliceTimer = null;
    const until = performance.now() + SLICE_MS;
    while (head < queue.length && performance.now() < until) {
      for (let n = 0; n < 200 && head < queue.length; n++) {
        const el = queue[head++];
        try {
          scanElement(el);
          if (el.shadowRoot) enqueue(el.shadowRoot.querySelectorAll('*')); // open Shadow DOM
        } catch (e) {}
      }
    }
    if (head < queue.length) sliceTimer = setTimeout(runSlice, 0);
    else { queue = []; head = 0; }
  }

  let lastFullScan = 0;
  function fullScan() {
    if (Date.now() - lastFullScan < 2000) return;
    lastFullScan = Date.now();
    try { scanMeta(); } catch (e) {}
    try { enqueue(document.querySelectorAll('*')); } catch (e) {}
  }

  const added = new Set();
  let addedTimer = null;
  function flushAdded() {
    addedTimer = null;
    const roots = Array.from(added);
    added.clear();
    roots.forEach((el) => {
      if (!el.isConnected) return;
      try {
        enqueue([el]);
        enqueue(el.querySelectorAll('*'));
        if (el.tagName === 'META') scanMeta();
      } catch (e) {}
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fullScan);
  else fullScan();
  try {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        const nodes = m.addedNodes;
        for (let i = 0; nodes && i < nodes.length; i++) {
          if (nodes[i].nodeType === 1 && added.size < 5000) added.add(nodes[i]);
        }
      }
      if (added.size && !addedTimer) addedTimer = setTimeout(flushAdded, 500);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  // The popup asks content.js for a fresh scan when it opens: look at the whole page again too (catches attributes
  // a player changed in place)
  try {
    chrome.runtime.onMessage.addListener((request) => {
      if (request && request.action === 'forceContentScan') fullScan();
      return false;
    });
  } catch (e) {}
})();
