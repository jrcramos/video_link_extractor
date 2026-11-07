// addon2-page.js - The newer add-on detection modules that run in the page (MAIN world), loaded after
// addon2-decode.js. Like addon-page.js, they only ADD links: inject.js, addon-page.js and everything else keep
// detecting exactly as before. Every hook calls straight through to the function it wraps (which may itself be
// one of the existing hooks) and returns its result untouched; any error in here is swallowed.
//   Module 6:  media URLs in fetch / XHR responses that inject.js cannot read (escaped, encoded, relative, formats)
//   Module 7:  the playlist / sources of the players on the page (JW Player, video.js / Brightcove), on request
//   Module 8:  whole files a player downloads and plays from memory (blob: URLs), and sounds decoded by Web Audio
//   Module 10: media URLs named in messages the page receives (WebSocket, frames, workers, server events)
//   Module 11: the name a music / podcast player gives what it is playing (Media Session), for + Name
(function () {
  if (window.__VLE_ADDON2_PAGE__) return;
  window.__VLE_ADDON2_PAGE__ = true;
  const dec = window.__VLE_DECODE__;
  if (!dec) return;

  // ---- channel to addon2-content.js (document_idle): findings wait in a queue until it says it is ready
  let ready = false;
  const queue = [];
  const post = (payload) => window.postMessage({ type: '__VLE_ADDON2__', payload: payload }, '*');
  const emit = (payload) => {
    try {
      if (ready) post(payload);
      else if (queue.length < 500) queue.push(payload);
    } catch (e) {}
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === '__VLE_ADDON2_READY__' && !ready) {
      ready = true;
      queue.splice(0).forEach((p) => { try { post(p); } catch (e) {} });
    } else if (event.data.type === '__VLE_ADDON2_PROBE__') {
      try { probePlayers(); } catch (e) {}
    }
  });

  const baseUrl = () => { try { return document.baseURI || location.href; } catch (e) { return ''; } };
  const httpOnly = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');

  // =============================================================================================
  // Module 6: what inject.js cannot read in a response
  // inject.js reads the same responses with its own patterns; this reads a copy of the text again and keeps only
  // what those patterns do not find in it (escaped / percent-encoded / base64 URLs, URLs without a scheme or
  // relative to the page under a player-settings key, and formats inject.js does not list).
  // =============================================================================================
  const HIDDEN_MAX = 200; // per frame
  const hiddenSent = new Set();
  const MAX_BODY = 2000000;
  const TEXT_TYPE = (ct) => {
    const t = String(ct || '').toLowerCase();
    if (t.includes('mpegurl') || t.includes('dash+xml') || t.includes('svg')) return false; // playlists: owned by the existing analysis
    return t.includes('json') || t.includes('text') || t.includes('javascript') || t.includes('xml');
  };
  const PLAYLIST_URL = /\.(?:mpd|m3u8|m3u)(?:[?#]|$)/i;

  function reportHidden(text, how) {
    if (hiddenSent.size >= HIDDEN_MAX || typeof text !== 'string' || text.length > MAX_BODY || !dec.mayHaveMedia(text)) return;
    const found = dec.extract(text, baseUrl(), { exclude: true }).filter((f) => !hiddenSent.has(f.url));
    if (!found.length) return;
    found.slice(0, HIDDEN_MAX - hiddenSent.size).forEach((f) => hiddenSent.add(f.url));
    emit({ module: 'hidden', how: how, urls: found.slice(0, 60) });
  }

  if (typeof window.fetch === 'function') {
    const previousFetch = window.fetch;
    window.fetch = function (...args) {
      return previousFetch.apply(this, args).then((res) => {
        try {
          if (res && res.type !== 'opaque' && typeof res.clone === 'function' && res.headers && !res.bodyUsed && !PLAYLIST_URL.test(res.url || '')) {
            const type = res.headers.get('content-type');
            if (TEXT_TYPE(type) && Number(res.headers.get('content-length') || 0) <= MAX_BODY) {
              res.clone().text().then((t) => reportHidden(t, 'fetch')).catch(() => {});
            }
          }
        } catch (e) {}
        return res;
      });
    };
  }

  if (window.XMLHttpRequest && XMLHttpRequest.prototype && typeof XMLHttpRequest.prototype.send === 'function') {
    const previousSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      try {
        this.addEventListener('load', function () {
          try {
            if (PLAYLIST_URL.test(this.responseURL || '')) return;
            const type = this.getResponseHeader('content-type');
            if (type && !TEXT_TYPE(type)) return;
            const rt = this.responseType;
            if (rt === '' || rt === 'text') reportHidden(this.responseText, 'xhr');
            else if (rt === 'json' && this.response) reportHidden(typeof this.response === 'string' ? this.response : JSON.stringify(this.response), 'xhr');
          } catch (e) {}
        });
      } catch (e) {}
      return previousSend.apply(this, args);
    };
  }

  // =============================================================================================
  // Module 7: the players on the page, asked what they hold (only when the popup opens)
  // JW Player's playlist and video.js's sources (Brightcove's catalogue entry, the videojs-playlist plugin) list
  // every item and every quality, including the ones the player has not loaded. Only reads: nothing is set up,
  // loaded or changed. hls.js, dash.js and Shaka load what they are given at once, so the existing detection
  // already sees it.
  // =============================================================================================
  const PLAYER_MAX = 150;
  const playerSent = new Set();
  const kindOfType = (type, url) => {
    const t = String(type || '').toLowerCase();
    if (/mpegurl|^hls$|^m3u8$/.test(t)) return 'hls';
    if (/dash\+xml|^dash$|^mpd$/.test(t)) return 'dash';
    if (/^(?:video|audio)\/|^(?:mp4|webm|aac|mp3|m4a|ogg|oga|flac|opus|wav|mov|m4v)$/.test(t)) return 'media';
    if (/^(?:captions|subtitles)$|^text\/vtt/.test(t)) return 'subtitle';
    return dec.extract(`"${url}"`, baseUrl(), { exclude: false }).length ? 'media' : '';
  };

  function probePlayers() {
    const items = [];
    const add = (raw, type) => {
      if (typeof raw !== 'string' || !raw || items.length >= 300) return;
      let url = '';
      try { url = new URL(raw, baseUrl()).href; } catch (e) { return; }
      if (!httpOnly(url) || playerSent.has(url) || playerSent.size >= PLAYER_MAX) return;
      const kind = kindOfType(type, url);
      if (!kind) return;
      playerSent.add(url);
      items.push({ url: url.slice(0, 4000), kind: kind });
    };

    // JW Player 7 / 8: only containers it has already set up (they carry its jw-reset class)
    try {
      const jw = window.jwplayer;
      if (typeof jw === 'function') {
        const seen = new Set();
        document.querySelectorAll('.jwplayer.jw-reset[id]').forEach((el) => {
          let p = null;
          try { p = jw(el.id); } catch (e) {}
          if (!p || seen.has(p) || typeof p.getPlaylist !== 'function') return;
          seen.add(p);
          let list = [];
          try { list = p.getPlaylist() || []; } catch (e) {}
          (Array.isArray(list) ? list : []).slice(0, 200).forEach((item) => {
            if (!item) return;
            add(item.file, '');
            (Array.isArray(item.sources) ? item.sources : []).forEach((s) => s && add(s.file, s.type));
            (Array.isArray(item.tracks) ? item.tracks : []).forEach((t) => t && /captions|subtitles/i.test(t.kind || '') && add(t.file, 'subtitles'));
          });
        });
      }
    } catch (e) {}

    // video.js (and Brightcove, which is built on it)
    try {
      const vjs = window.videojs;
      if (vjs) {
        let players = [];
        try {
          const all = typeof vjs.getPlayers === 'function' ? vjs.getPlayers() : vjs.players;
          players = Object.values(all || {});
        } catch (e) {}
        players.slice(0, 30).forEach((p) => {
          if (!p || typeof p !== 'object') return;
          try { if (typeof p.isDisposed === 'function' && p.isDisposed()) return; } catch (e) { return; }
          try { if (typeof p.currentSources === 'function') (p.currentSources() || []).forEach((s) => s && add(s.src, s.type)); } catch (e) {}
          try {
            const mi = p.mediainfo;
            if (mi && typeof mi === 'object') {
              (Array.isArray(mi.sources) ? mi.sources : []).forEach((s) => s && add(s.src, s.type));
              (Array.isArray(mi.text_tracks) ? mi.text_tracks : []).forEach((t) => t && add(t.src, 'subtitles'));
            }
          } catch (e) {}
          try {
            if (typeof p.playlist === 'function') {
              const pl = p.playlist();
              (Array.isArray(pl) ? pl : []).slice(0, 200).forEach((item) => {
                if (!item) return;
                (Array.isArray(item.sources) ? item.sources : []).forEach((s) => s && add(s.src, s.type));
                (Array.isArray(item.textTracks) ? item.textTracks : []).forEach((t) => t && add(t.src, 'subtitles'));
              });
            }
          } catch (e) {}
        });
      }
    } catch (e) {}

    if (items.length) emit({ module: 'player', items: items });
  }

  // =============================================================================================
  // Module 8: files played from memory, and sounds decoded by Web Audio
  // A player can download a whole file (fetch / XHR, often typed application/octet-stream at an address without an
  // extension), then play it from a blob: URL, or hand it to the Web Audio API. Remembering which response each
  // Blob / ArrayBuffer came from gives that address back. A file the page builds itself (new Blob([...]),
  // decrypted, ...) cannot be traced and is simply not reported.
  // =============================================================================================
  const bufferOrigin = new WeakMap(); // ArrayBuffer -> URL of the response it came from
  const blobOrigin = new WeakMap(); // Blob -> URL of the response it came from
  const blobUrls = new Map(); // 'blob:...' -> { url, type }
  const MEDIA_MAX = 100;
  const mediaSent = new Set();

  const remember = (map, value, url) => { try { if (value && httpOnly(url)) map.set(value, url); } catch (e) {} };
  try {
    if (window.Response && Response.prototype) {
      if (typeof Response.prototype.arrayBuffer === 'function') {
        const previousArrayBuffer = Response.prototype.arrayBuffer;
        Response.prototype.arrayBuffer = function (...args) {
          const pending = previousArrayBuffer.apply(this, args);
          let url = '';
          try { url = this.url; } catch (e) {}
          return pending.then((buf) => { remember(bufferOrigin, buf, url); return buf; });
        };
      }
      if (typeof Response.prototype.blob === 'function') {
        const previousBlob = Response.prototype.blob;
        Response.prototype.blob = function (...args) {
          const pending = previousBlob.apply(this, args);
          let url = '';
          try { url = this.url; } catch (e) {}
          return pending.then((b) => { remember(blobOrigin, b, url); return b; });
        };
      }
    }
  } catch (e) {}
  try {
    const desc = window.XMLHttpRequest && Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    if (desc && typeof desc.get === 'function' && desc.configurable) {
      Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          const value = desc.get.call(this);
          try {
            if (value && this.readyState === 4) {
              if (value instanceof ArrayBuffer) remember(bufferOrigin, value, this.responseURL);
              else if (typeof Blob === 'function' && value instanceof Blob) remember(blobOrigin, value, this.responseURL);
            }
          } catch (e) {}
          return value;
        }
      });
    }
  } catch (e) {}

  function reportMedia(module, url, extra) {
    if (!httpOnly(url) || mediaSent.has(`${module}|${url}`) || mediaSent.size >= MEDIA_MAX) return;
    mediaSent.add(`${module}|${url}`);
    emit({ module: module, url: url.slice(0, 4000), ...extra });
  }
  const blobKind = (type) => (/^audio\//i.test(type || '') ? 'audio' : (/^video\//i.test(type || '') ? 'video' : ''));

  try {
    if (window.URL && typeof URL.createObjectURL === 'function') {
      const previousCreate = URL.createObjectURL;
      URL.createObjectURL = function (obj) {
        const out = previousCreate.apply(this, arguments);
        try {
          const origin = obj && typeof Blob === 'function' && obj instanceof Blob ? blobOrigin.get(obj) : '';
          if (origin && typeof out === 'string') {
            if (blobUrls.size > 300) blobUrls.delete(blobUrls.keys().next().value);
            blobUrls.set(out, { url: origin, type: String(obj.type || '').slice(0, 100) });
            // typed as audio / video: a media file whatever it is used for
            if (blobKind(obj.type)) reportMedia('blob', origin, { kind: blobKind(obj.type) });
          }
        } catch (e) {}
        return out;
      };
    }
  } catch (e) {}

  // a blob: URL a <video> / <audio> starts loading, in the page or kept outside it (new Audio())
  const checkElement = (el) => {
    try {
      const src = el && (el.currentSrc || el.src);
      const known = src && blobUrls.get(src);
      if (known) reportMedia('blob', known.url, { kind: blobKind(known.type) || (el.tagName === 'AUDIO' ? 'audio' : '') });
    } catch (e) {}
  };
  try { document.addEventListener('loadstart', (e) => checkElement(e.target), true); } catch (e) {}

  try {
    const AC = window.BaseAudioContext || window.AudioContext;
    if (AC && AC.prototype && typeof AC.prototype.decodeAudioData === 'function') {
      const previousDecode = AC.prototype.decodeAudioData;
      AC.prototype.decodeAudioData = function (buf) {
        let url = '';
        try { url = buf instanceof ArrayBuffer ? (bufferOrigin.get(buf) || '') : ''; } catch (e) {} // read before decoding detaches it
        const out = previousDecode.apply(this, arguments);
        try {
          if (url && out && typeof out.then === 'function') {
            out.then((audio) => {
              const d = audio && audio.duration > 0 && isFinite(audio.duration) ? Math.round(audio.duration * 10) / 10 : 0;
              reportMedia('webaudio', url, { duration: d });
            }, () => {});
          }
        } catch (e) {}
        return out;
      };
    }
  } catch (e) {}

  // =============================================================================================
  // Module 10: media URLs named in messages the page receives
  // Reading event.data of a WebSocket message, a message from a frame / window, a worker, a MessageChannel or a
  // server-sent event: once per message, the text (or the strings of a small object) is looked through like a
  // response. The extension's own messages (type __VLE_...) are skipped.
  // =============================================================================================
  const MESSAGE_MAX = 150;
  const messageSent = new Set();
  const seenEvents = new WeakSet();
  const stringsOf = (v) => {
    const out = [];
    const stack = [[v, 0]];
    const visited = new WeakSet();
    let nodes = 0;
    while (stack.length && nodes < 400) {
      const [x, depth] = stack.pop();
      nodes++;
      if (typeof x === 'string') { if (x.length >= 10 && x.length < 200000) out.push(x); continue; }
      if (!x || typeof x !== 'object' || depth > 6 || visited.has(x)) continue;
      if (x instanceof ArrayBuffer || ArrayBuffer.isView(x) || (typeof Blob === 'function' && x instanceof Blob)) continue;
      visited.add(x);
      try { Object.keys(x).slice(0, 200).forEach((k) => stack.push([x[k], depth + 1])); } catch (e) {}
    }
    return out.join('\n');
  };
  const channelOf = (ev) => {
    try {
      const t = ev.target;
      if (typeof WebSocket === 'function' && t instanceof WebSocket) return 'websocket';
      if (typeof EventSource === 'function' && t instanceof EventSource) return 'eventsource';
      if (typeof Worker === 'function' && t instanceof Worker) return 'worker';
      if (ev.source) return 'window';
    } catch (e) {}
    return 'other';
  };
  function inspectMessage(ev, value) {
    if (seenEvents.has(ev) || messageSent.size >= MESSAGE_MAX) return;
    seenEvents.add(ev);
    let text = '';
    if (typeof value === 'string') {
      if (value.length < 12 || value.length > 1000000 || !dec.mayHaveMedia(value)) return;
      text = value;
    } else if (value && typeof value === 'object') {
      if (typeof value.type === 'string' && value.type.startsWith('__VLE_')) return; // this extension's own channel
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
      text = stringsOf(value);
      if (!dec.mayHaveMedia(text)) return;
    } else {
      return;
    }
    const found = dec.extract(text, baseUrl(), { exclude: false, via: 'message' }).filter((f) => !messageSent.has(f.url));
    if (!found.length) return;
    found.forEach((f) => messageSent.add(f.url));
    emit({ module: 'message', channel: channelOf(ev), urls: found.slice(0, 60) });
  }
  try {
    const desc = window.MessageEvent && Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    if (desc && typeof desc.get === 'function' && desc.configurable) {
      Object.defineProperty(MessageEvent.prototype, 'data', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          const value = desc.get.call(this);
          try { inspectMessage(this, value); } catch (e) {}
          return value;
        }
      });
    }
  } catch (e) {}

  // =============================================================================================
  // Module 11: what a music / podcast player says it is playing (Media Session)
  // While a <video> / <audio> plays (in the page or not), the title and artist the page gives the system media
  // controls are read every 2 s; a name seen twice in a row for the same file is that file's name. Only a file
  // with a web address (or a blob: one traced by module 8) is named. The popup uses these names only for files
  // the page names nothing else, and only when the page names several of them (see popup.js).
  // =============================================================================================
  const played = [];
  const sessionLast = new Map(); // url -> name seen at the last sample
  const sessionSent = new Map(); // url -> name reported
  let sampler = null;
  let idleSamples = 0;
  const notePlayed = (el) => {
    try {
      if (!el || played.some((r) => r.deref() === el)) return;
      played.push(new WeakRef(el));
      if (played.length > 12) played.shift();
      if (!sampler) { idleSamples = 0; sampler = setInterval(sampleSession, 2000); }
    } catch (e) {}
  };
  const fileOf = (el) => {
    const src = el.currentSrc || el.src || '';
    if (httpOnly(src)) return src;
    const known = blobUrls.get(src);
    return known ? known.url : '';
  };
  function sampleSession() {
    try {
      const playing = played.map((r) => r.deref()).filter((el) => el && !el.paused && !el.ended && el.currentTime > 0.3);
      if (!playing.length) {
        if (++idleSamples > 30) { clearInterval(sampler); sampler = null; }
        return;
      }
      idleSamples = 0;
      const files = Array.from(new Set(playing.map(fileOf).filter(Boolean)));
      if (files.length !== 1) return; // nothing to name, or two players at once: whose name it is is unclear
      const meta = navigator.mediaSession && navigator.mediaSession.metadata;
      const title = meta && typeof meta.title === 'string' ? meta.title.trim() : '';
      if (!title) return;
      const artist = typeof meta.artist === 'string' ? meta.artist.trim() : '';
      const name = (artist && !title.toLowerCase().includes(artist.toLowerCase()) ? `${artist} - ${title}` : title).slice(0, 200);
      const url = files[0].slice(0, 4000);
      if (sessionLast.get(url) === name && sessionSent.get(url) !== name && sessionSent.size < 300) {
        sessionSent.set(url, name);
        emit({ module: 'session', url: url, name: name });
      }
      sessionLast.set(url, name);
    } catch (e) {}
  }
  try {
    if (window.HTMLMediaElement && typeof HTMLMediaElement.prototype.play === 'function') {
      const previousPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        try { notePlayed(this); checkElement(this); } catch (e) {}
        return previousPlay.apply(this, arguments);
      };
    }
    document.addEventListener('playing', (e) => notePlayed(e.target), true);
  } catch (e) {}
})();
