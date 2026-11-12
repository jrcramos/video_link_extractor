// addon3-page.js - The third set of add-on modules that run in the page (MAIN world), loaded after addon3-text.js.
// Like the other add-on page files they only watch: every hook calls straight through to what it wraps (which may
// itself be one of the existing hooks) and returns its result untouched; any error in here is swallowed. A wrapped
// constructor is a transparent Proxy (same prototype, statics, name, instanceof, [native code] text).
//   Module 13: WebRTC connections that receive media, WHEP / WHIP endpoints, media streamed over a WebSocket
//   Module 14: WebTransport sessions, WebCodecs decoders (players that bypass Media Source Extensions)
//   Module 16: VAST answers the page loads (the ad files they list)
//   Module 17: RSS / Atom feeds and .pls / .asx / .xspf playlists the page loads (the media they list)
(function () {
  if (window.__VLE_X3_PAGE__) return;
  window.__VLE_X3_PAGE__ = true;
  const T = window.__VLE_X3_TEXT__;

  // ---- channel to addon3-content.js (document_idle): findings wait in a queue until it says it is ready
  let ready = false;
  const queue = [];
  const post = (payload) => window.postMessage({ type: '__VLE_X3__', payload: payload }, '*');
  const emit = (payload) => {
    try {
      if (ready) post(payload);
      else if (queue.length < 300) queue.push(payload);
    } catch (e) {}
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== '__VLE_X3_READY__' || ready) return;
    ready = true;
    queue.splice(0).forEach((p) => { try { post(p); } catch (e) {} });
  });

  const absUrl = (raw) => {
    try {
      const u = new URL(String(raw), document.baseURI || location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:' ? u.href.slice(0, 4000) : '';
    } catch (e) {
      return '';
    }
  };
  // taken before any page script runs, so a page that replaces them changes nothing here
  const TextDecoderOf = window.TextDecoder;
  const XMLSerializerOf = window.XMLSerializer;
  const ProxyOf = window.Proxy;
  const ReflectOf = window.Reflect;

  // A constructor replaced by a Proxy that calls the original and then looks at the new object
  function watchConstructor(name, onCreate) {
    try {
      const Orig = window[name];
      if (typeof Orig !== 'function' || typeof ProxyOf !== 'function') return;
      const desc = Object.getOwnPropertyDescriptor(window, name);
      if (!desc || !('value' in desc) || (!desc.writable && !desc.configurable)) return;
      const wrapped = new ProxyOf(Orig, {
        construct(target, args, newTarget) {
          const obj = ReflectOf.construct(target, args, newTarget);
          try { onCreate(obj, args); } catch (e) {}
          return obj;
        }
      });
      if (desc.writable) window[name] = wrapped;
      else Object.defineProperty(window, name, { ...desc, value: wrapped });
    } catch (e) {}
  }

  // =============================================================================================
  // Module 13: WebRTC
  // Only connections that receive audio / video are reported (sites also open data-only connections, e.g. to learn
  // the local address). ICE servers are named by host only: their user names / credentials are never read.
  // =============================================================================================
  const rtcInfo = new WeakMap(); // RTCPeerConnection -> record
  let rtcSeq = 0;
  const CODEC_SKIP = /^(?:rtx|red|ulpfec|flexfec-03|telephone-event|cn)$/i;
  const reportRtc = (rec) => {
    if (rec.video + rec.audio > 0) emit({ module: 'rtc', id: rec.id, video: rec.video, audio: rec.audio, ice: rec.ice, codecs: rec.codecs, state: rec.state, frame: location.href.slice(0, 300) });
  };
  const iceHosts = (cfg) => {
    const hosts = [];
    try {
      (cfg && Array.isArray(cfg.iceServers) ? cfg.iceServers : []).slice(0, 10).forEach((s) => {
        [].concat((s && (s.urls || s.url)) || []).slice(0, 10).forEach((u) => {
          const m = /^(?:stuns?|turns?):\/?\/?([^:?\/]+)/i.exec(String(u));
          if (m && !hosts.includes(m[1]) && hosts.length < 6) hosts.push(m[1].slice(0, 100));
        });
      });
    } catch (e) {}
    return hosts;
  };
  const onPeerConnection = (pc, args) => {
    if (rtcSeq >= 10) return;
    const rec = { id: ++rtcSeq, video: 0, audio: 0, ice: iceHosts(args[0]), codecs: [], state: '' };
    rtcInfo.set(pc, rec);
    pc.addEventListener('track', (ev) => {
      try {
        const kind = ev && ev.track && ev.track.kind;
        if (kind === 'video' || kind === 'audio') { rec[kind]++; reportRtc(rec); }
      } catch (e) {}
    });
    pc.addEventListener('connectionstatechange', () => {
      try { rec.state = String(pc.connectionState || ''); reportRtc(rec); } catch (e) {}
    });
  };
  watchConstructor('RTCPeerConnection', onPeerConnection);
  if (window.webkitRTCPeerConnection !== window.RTCPeerConnection) watchConstructor('webkitRTCPeerConnection', onPeerConnection);
  try {
    const proto = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
    if (proto && typeof proto.setRemoteDescription === 'function') {
      const previous = proto.setRemoteDescription;
      proto.setRemoteDescription = function () {
        try {
          const desc = arguments[0];
          const rec = rtcInfo.get(this);
          const sdp = desc && desc.sdp;
          if (rec && typeof sdp === 'string' && sdp.length < 200000) {
            const re = /^a=rtpmap:\d+ ([\w.-]+)\//gm;
            let m;
            while ((m = re.exec(sdp)) !== null && rec.codecs.length < 6) {
              const name = m[1].toUpperCase();
              if (!CODEC_SKIP.test(name) && !rec.codecs.includes(name)) rec.codecs.push(name);
            }
          }
        } catch (e) {}
        return previous.apply(this, arguments);
      };
    }
  } catch (e) {}

  // WHEP (play) / WHIP (publish): an SDP offer POSTed to an HTTP endpoint
  const sigSent = new Set();
  const noteSdpPost = (url, body) => {
    if (typeof url !== 'string' || !url || typeof body !== 'string' || !/^v=0\r?\n/.test(body) || sigSent.size >= 10) return;
    const abs = absUrl(url);
    if (!/^https?:/i.test(abs) || sigSent.has(abs)) return;
    sigSent.add(abs);
    const publish = /^a=sendonly/m.test(body) && !/^a=recvonly/m.test(body);
    emit({ module: 'sig', url: abs, kind: publish ? 'whip' : 'whep' });
  };

  // =============================================================================================
  // Module 13: media streamed over a WebSocket (FLV, fragmented MP4, MPEG-TS, ...): the first few binary messages
  // of each socket are looked at, then the listener removes itself
  // =============================================================================================
  const wsSent = new Set();
  let wsWatched = 0;
  const mediaFormat = (u8) => {
    if (!u8 || u8.length < 4) return '';
    const at = (i, s) => s.split('').every((c, k) => u8[i + k] === c.charCodeAt(0));
    if (at(0, 'FLV') && u8[3] === 1) return 'FLV';
    if (u8.length >= 8 && ['ftyp', 'moof', 'styp', 'sidx', 'moov'].some((b) => at(4, b))) return 'fMP4';
    if (u8[0] === 0x47 && u8.length >= 377 && u8[188] === 0x47 && u8[376] === 0x47) return 'MPEG-TS';
    if (at(0, 'OggS')) return 'Ogg';
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'WebM';
    if (at(0, 'ID3')) return 'MP3';
    return '';
  };
  const watchSocket = (ws) => {
    if (wsWatched >= 20) return;
    wsWatched++;
    let seen = 0;
    const stop = () => { try { ws.removeEventListener('message', onMessage); } catch (e) {} };
    const check = (u8) => {
      const format = mediaFormat(u8);
      if (!format) return;
      stop();
      const url = absUrl(ws.url);
      if (!url || wsSent.has(url) || wsSent.size >= 10) return;
      wsSent.add(url);
      emit({ module: 'ws', url: url, format: format });
    };
    function onMessage(ev) {
      try {
        if (++seen > 8) { stop(); return; }
        const d = messageData.call(ev); // the browser's own getter: add-on module 10 does not see this read
        if (d instanceof ArrayBuffer) check(new Uint8Array(d, 0, Math.min(400, d.byteLength)));
        else if (typeof Blob === 'function' && d instanceof Blob) d.slice(0, 400).arrayBuffer().then((b) => check(new Uint8Array(b)), () => {});
      } catch (e) {}
    }
    try { ws.addEventListener('message', onMessage); } catch (e) {}
  };
  const messageData = T && T.messageData;
  if (typeof messageData === 'function') watchConstructor('WebSocket', (ws) => watchSocket(ws));

  // =============================================================================================
  // Module 14: WebTransport sessions and WebCodecs decoders
  // =============================================================================================
  const wtSent = new Set();
  watchConstructor('WebTransport', (wt, args) => {
    const url = absUrl(args[0]);
    if (!url || wtSent.has(url) || wtSent.size >= 10) return;
    wtSent.add(url);
    emit({ module: 'wt', url: url });
  });
  const codecSent = new Set();
  [['VideoDecoder', 'video'], ['AudioDecoder', 'audio']].forEach(([name, kind]) => {
    try {
      const proto = window[name] && window[name].prototype;
      if (!proto || typeof proto.configure !== 'function') return;
      const previous = proto.configure;
      proto.configure = function (cfg) {
        try {
          if (cfg && typeof cfg.codec === 'string' && codecSent.size < 10) {
            const item = {
              module: 'codec', kind: kind, codec: cfg.codec.slice(0, 60),
              w: Number(cfg.codedWidth || cfg.displayWidth) || 0, h: Number(cfg.codedHeight || cfg.displayHeight) || 0,
              rate: Number(cfg.sampleRate) || 0, ch: Number(cfg.numberOfChannels) || 0
            };
            const key = JSON.stringify(item);
            if (!codecSent.has(key)) { codecSent.add(key); emit(item); }
          }
        } catch (e) {}
        return previous.apply(this, arguments);
      };
    } catch (e) {}
  });

  // =============================================================================================
  // Modules 16 + 17: VAST answers, feeds and playlists the page loads
  // Only XML / playlist-typed responses are looked at, and only their first 4 KB unless they turn out to be one of
  // these (then at most 2 MB). The page's own response is untouched.
  // =============================================================================================
  const DOC_MAX = 2000000;
  const DOC_TYPE = /xml|scpls|x-ms-asx/i;
  const DOC_SKIP = /svg|dash\+xml|xhtml|html/i;
  const DOC_URL = /\.(?:pls|asx|xspf|rss|xml)(?:[?#]|$)/i;
  let docsSent = 0;
  const reportDoc = (text, url) => {
    if (!T || docsSent >= 40 || typeof text !== 'string') return;
    const kind = T.kindOf(text);
    if (kind === 'vast') {
      const urls = T.vastMedia(text, url);
      if (urls.length) { docsSent++; emit({ module: 'ad', urls: urls }); }
    } else if (kind === 'rss' || kind === 'atom') {
      const items = T.feedMedia(text, url, 60);
      if (items.length) { docsSent++; emit({ module: 'feed', via: kind, items: items }); }
    } else if (kind === 'pls' || kind === 'asx' || kind === 'xspf') {
      const urls = T.playlistUrls(text, url, kind);
      if (urls.length) { docsSent++; emit({ module: 'feed', via: kind, items: urls.map((u) => ({ url: u, kind: T.AUDIO_PATH.test(u.split('?')[0]) ? 'audio' : '' })) }); }
    }
  };
  const wantsDoc = (type, url) => {
    const t = String(type || '').toLowerCase();
    return (DOC_TYPE.test(t) && !DOC_SKIP.test(t)) || (DOC_URL.test(url || '') && /^(?:|text\/plain|application\/octet-stream)$/.test(t.split(';')[0].trim()));
  };
  // a copy of a fetch() response: its first 4 KB, then the rest only when it is one of the documents above
  const peekResponse = (res) => {
    if (!T || docsSent >= 40 || !res || res.type === 'opaque' || res.bodyUsed || typeof res.clone !== 'function' || !res.headers) return;
    if (!wantsDoc(res.headers.get('content-type'), res.url) || Number(res.headers.get('content-length') || 0) > DOC_MAX) return;
    const body = res.clone().body;
    if (!body || typeof body.getReader !== 'function' || typeof TextDecoderOf !== 'function') return;
    const reader = body.getReader();
    const decoder = new TextDecoderOf();
    let text = '';
    let size = 0;
    let decided = false;
    const step = () => reader.read().then(({ done, value }) => {
      if (value) { size += value.byteLength; text += decoder.decode(value, { stream: !done }); }
      if (!decided && (text.length >= 4096 || done)) {
        decided = true;
        if (!T.kindOf(text)) { reader.cancel().catch(() => {}); return; }
      }
      if (size > DOC_MAX) { reader.cancel().catch(() => {}); return; }
      if (done) { reportDoc(text + decoder.decode(), res.url); return; }
      return step();
    });
    step().catch(() => {});
  };

  if (typeof window.fetch === 'function') {
    const previousFetch = window.fetch;
    window.fetch = function (input) {
      try {
        const init = arguments[1];
        const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
        if (method === 'POST' && init && typeof init.body === 'string') noteSdpPost(typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : (input && typeof input.href === 'string' ? input.href : '')), init.body);
      } catch (e) {}
      const pending = previousFetch.apply(this, arguments);
      try {
        if (T && pending && typeof pending.then === 'function') pending.then((res) => { try { peekResponse(res); } catch (e) {} }, () => {});
      } catch (e) {}
      return pending;
    };
  }

  if (window.XMLHttpRequest && XMLHttpRequest.prototype && typeof XMLHttpRequest.prototype.send === 'function') {
    const previousSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        const body = arguments[0];
        const xhr = this;
        const sdp = typeof body === 'string' && /^v=0\r?\n/.test(body) ? body : '';
        xhr.addEventListener('loadend', function () {
          try {
            if (sdp) noteSdpPost(xhr.responseURL || xhr._vle_url, sdp);
            if (!T || docsSent >= 40 || xhr.status < 200 || xhr.status >= 300) return;
            const type = xhr.getResponseHeader('content-type') || '';
            if (!wantsDoc(type, xhr.responseURL)) return;
            const rt = xhr.responseType;
            if (rt === '' || rt === 'text') {
              const text = xhr.responseText;
              if (typeof text === 'string' && text.length <= DOC_MAX && T.kindOf(text.slice(0, 4096))) reportDoc(text, xhr.responseURL);
            } else if (rt === 'document' && xhr.responseXML && xhr.responseXML.documentElement && typeof XMLSerializerOf === 'function') {
              const root = String(xhr.responseXML.documentElement.nodeName || '').replace(/^[\w-]+:/, '');
              if (/^(?:VAST|VMAP|rss|feed|asx|playlist)$/i.test(root)) reportDoc(new XMLSerializerOf().serializeToString(xhr.responseXML).slice(0, DOC_MAX), xhr.responseURL);
            }
          } catch (e) {}
        });
      } catch (e) {}
      return previousSend.apply(this, arguments);
    };
  }
})();
