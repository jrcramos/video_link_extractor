// addon-page.js - Add-on detection modules that run in the page (MAIN world), loaded right after inject.js.
// They only ADD links: inject.js, content.js and background.js keep detecting exactly as before. Every hook calls
// straight through to the original and returns its result; any error in here is swallowed.
//   Module 1: playlists recognised by their content (#EXTM3U / <MPD) when neither the URL nor the server says so
//   Module 5: the pieces a video player feeds the browser (Media Source Extensions), traced back to their requests
(function () {
  if (window.__VLE_ADDON_PAGE__) return;
  window.__VLE_ADDON_PAGE__ = true;

  // ---- channel to addon-content.js. This file runs at document_start, addon-content.js at document_idle:
  // findings are queued until it says it is ready.
  let ready = false;
  const queue = [];
  const post = (payload) => window.postMessage({ type: '__VLE_ADDON__', payload: payload }, '*');
  const emit = (payload) => {
    try {
      if (ready) post(payload);
      else if (queue.length < 500) queue.push(payload);
    } catch (e) {}
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== '__VLE_ADDON_READY__' || ready) return;
    ready = true;
    queue.splice(0).forEach((p) => { try { post(p); } catch (e) {} });
  });

  // =============================================================================================
  // Module 1: playlists recognised by their content
  // A response whose body starts with #EXTM3U (HLS) or an <MPD> element (DASH) is a playlist, whatever its URL
  // (/api/stream?id=7) or the type the server labels it with (text/plain, application/octet-stream, ...).
  // URLs ending in .m3u8 / .mpd are left alone: the existing detection already lists and labels those.
  // =============================================================================================
  const manifestReported = new Set();
  const KNOWN_MANIFEST_URL = /\.(?:m3u8|m3u|mpd)(?:[?#]|$)/i;
  // types worth a look: unlabelled / generic ones, and the playlist types (an extension-less URL served as
  // application/x-mpegurl is listed by the background already, but shown as a plain video without this label)
  const PEEK_TYPES = /^(?:|text\/plain|text\/html|text\/xml|application\/xml|application\/octet-stream|binary\/octet-stream|application\/binary|application\/force-download|application\/download|application\/x-mpegurl|application\/vnd\.apple\.mpegurl|audio\/x-mpegurl|audio\/mpegurl|application\/dash\+xml)$/;
  const PEEK_BYTES = 2048;
  const MAX_PEEK_LENGTH = 20 * 1024 * 1024; // a body this big is not a playlist

  function manifestKindOf(head) {
    const s = String(head || '').replace(/^﻿/, '').trimStart();
    if (s.startsWith('#EXTM3U')) return 'hls';
    if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w-]+:)?MPD[\s>]/i.test(s)) return 'dash';
    return '';
  }

  function shouldPeek(url, contentType) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || manifestReported.has(url) || KNOWN_MANIFEST_URL.test(url)) return false;
    const type = String(contentType || '').toLowerCase().split(';')[0].trim();
    return PEEK_TYPES.test(type);
  }

  function reportManifest(url, kind, via) {
    if (!kind || manifestReported.has(url)) return;
    manifestReported.add(url);
    emit({ module: 'manifest', url: url, manifest: kind, via: via });
  }

  // fetch(): reads at most the first 2 KB of a copy of the response, then lets that copy go. The page's own
  // response is untouched.
  function peekFetchResponse(res) {
    if (!res || res.type === 'opaque' || res.bodyUsed || typeof res.clone !== 'function' || !res.headers) return;
    const url = res.url;
    if (!shouldPeek(url, res.headers.get('content-type'))) return;
    if (Number(res.headers.get('content-length') || 0) > MAX_PEEK_LENGTH) return;
    const copy = res.clone();
    const reader = copy.body && typeof copy.body.getReader === 'function' ? copy.body.getReader() : null;
    if (!reader) return;
    let head = new Uint8Array(0);
    const finish = () => {
      try { reader.cancel().catch(() => {}); } catch (e) {}
      try { reportManifest(url, manifestKindOf(new TextDecoder().decode(head)), 'fetch'); } catch (e) {}
    };
    const step = () => reader.read().then(({ done, value }) => {
      if (value && value.length && head.length < PEEK_BYTES) {
        const take = value.subarray(0, PEEK_BYTES - head.length);
        const merged = new Uint8Array(head.length + take.length);
        merged.set(head);
        merged.set(take, head.length);
        head = merged;
      }
      // the first bytes already rule most responses out: only '#' or '<' (after a BOM / blanks) can start a playlist
      const start = new TextDecoder().decode(head.subarray(0, 64)).replace(/^﻿/, '').trimStart();
      if (done || head.length >= PEEK_BYTES || (start && start[0] !== '#' && start[0] !== '<')) return finish();
      return step();
    });
    step().catch(() => { try { reader.cancel().catch(() => {}); } catch (e) {} });
  }

  if (typeof window.fetch === 'function') {
    const previousFetch = window.fetch;
    window.fetch = function (...args) {
      return previousFetch.apply(this, args).then((res) => {
        try { peekFetchResponse(res); } catch (e) {}
        return res;
      });
    };
  }

  // XMLHttpRequest: the body is already in memory once loaded; only its first 2 KB are looked at
  function onXhrLoad() {
    try { if (this.responseType === 'arraybuffer') rememberBuffer(this.response, this.responseURL); } catch (e) {} // module 5
    try {
      const url = this.responseURL;
      if (!shouldPeek(url, this.getResponseHeader('content-type'))) return;
      const type = this.responseType;
      let head = '';
      if (type === '' || type === 'text') head = String(this.responseText || '').slice(0, PEEK_BYTES);
      else if (type === 'arraybuffer' && this.response) head = new TextDecoder().decode(new Uint8Array(this.response, 0, Math.min(PEEK_BYTES, this.response.byteLength)));
      else return;
      reportManifest(url, manifestKindOf(head), 'xhr');
    } catch (e) {}
  }

  if (window.XMLHttpRequest && XMLHttpRequest.prototype && typeof XMLHttpRequest.prototype.send === 'function') {
    const previousSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      try { this.addEventListener('load', onXhrLoad); } catch (e) {}
      return previousSend.apply(this, args);
    };
  }

  // =============================================================================================
  // Module 5: what the video player feeds the browser (Media Source Extensions)
  // Players that build the stream themselves append each downloaded piece to a SourceBuffer. Remembering which
  // response every ArrayBuffer came from shows which requests really were that stream, in order, however their URLs
  // look. Each SourceBuffer is reported as one stream (its MIME type, its pieces' URLs); the background lists it
  // only when the existing detection has not got it already. Pieces a player rewrites before appending (TS turned
  // into MP4, decrypted, ...) cannot be traced back and are simply not reported.
  // =============================================================================================
  const bufferOrigin = new WeakMap(); // ArrayBuffer -> URL of the response it came from
  const sourceBuffers = new WeakMap(); // SourceBuffer -> { id, mime, urls, sent, timer }
  const MSE_MAX_PIECES = 3000;
  let streamSeq = 0;

  function rememberBuffer(buf, url) {
    try {
      if (buf instanceof ArrayBuffer && typeof url === 'string' && /^https?:\/\//i.test(url)) bufferOrigin.set(buf, url);
    } catch (e) {}
  }

  function streamOf(sb, mime) {
    let info = sourceBuffers.get(sb);
    if (!info) {
      info = { id: `${Date.now().toString(36)}-${++streamSeq}-${Math.random().toString(36).slice(2, 8)}`, mime: String(mime || '').slice(0, 120), urls: [], sent: 0, timer: null };
      sourceBuffers.set(sb, info);
    }
    return info;
  }

  function noteAppend(sb, data) {
    const buf = data instanceof ArrayBuffer ? data : (data && data.buffer instanceof ArrayBuffer ? data.buffer : null);
    const url = buf && bufferOrigin.get(buf);
    if (!url) return;
    const info = streamOf(sb, '');
    if (info.urls[info.urls.length - 1] === url || info.urls.length >= MSE_MAX_PIECES) return;
    info.urls.push(url);
    if (info.timer) return;
    info.timer = setTimeout(() => { // in batches: only the pieces not sent yet
      info.timer = null;
      const from = info.sent;
      info.sent = info.urls.length;
      emit({ module: 'mse', stream: info.id, mime: info.mime, from: from, urls: info.urls.slice(from) });
    }, 1500);
  }

  // fetch(): the ArrayBuffer a response resolves to
  try {
    if (window.Response && Response.prototype && typeof Response.prototype.arrayBuffer === 'function') {
      const previousArrayBuffer = Response.prototype.arrayBuffer;
      Response.prototype.arrayBuffer = function (...args) {
        const pending = previousArrayBuffer.apply(this, args);
        let url = '';
        try { url = this.url; } catch (e) {}
        return pending.then((buf) => { rememberBuffer(buf, url); return buf; });
      };
    }
  } catch (e) {}

  // XMLHttpRequest (responseType 'arraybuffer'): recorded when the page reads xhr.response, which may be before
  // any 'load' listener added here runs
  try {
    const desc = window.XMLHttpRequest && Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    if (desc && typeof desc.get === 'function' && desc.configurable) {
      Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          const value = desc.get.call(this);
          try { if (value instanceof ArrayBuffer && this.readyState === 4) rememberBuffer(value, this.responseURL); } catch (e) {}
          return value;
        }
      });
    }
  } catch (e) {}

  try {
    if (window.MediaSource && MediaSource.prototype && typeof MediaSource.prototype.addSourceBuffer === 'function') {
      const previousAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const sb = previousAdd.apply(this, arguments);
        try { if (sb) streamOf(sb, mime); } catch (e) {}
        return sb;
      };
    }
    if (window.SourceBuffer && SourceBuffer.prototype && typeof SourceBuffer.prototype.appendBuffer === 'function') {
      const previousAppend = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data) {
        try { noteAppend(this, data); } catch (e) {}
        return previousAppend.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
