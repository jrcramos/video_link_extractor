// addon2-decode.js - Shared by the newer add-on modules (addon2-page.js in the page, addon2-content.js in the
// content-script world). It finds media URLs in a text that the existing scanners cannot read:
//   - escaped:  https:\/\/cdn\/a.m3u8 (PHP json_encode), https:\u002F\u002Fcdn\u002Fa.mp4 (serialize-javascript)
//   - percent-encoded inside another URL: ?src=https%3A%2F%2Fcdn%2Fmaster.m3u8
//   - base64:   atob("aHR0cHM6Ly9jZG4v...")
//   - written without the scheme (//cdn/a.mp4) or relative to the page under a player-settings key ("file": "/v/a.mp4")
//   - formats inject.js does not list (.flac, .opus, .m4v, .ogv, .avi, .wmv, .3gp, .f4v, .dfxp)
// It only reports what the existing scanner would NOT find in the same text (exclude option), so nothing found
// before is found again by these modules.
(function (root) {
  if (root.__VLE_DECODE__) return;

  const EXT = 'm3u8|mpd|m3u|mp4|webm|mkv|mov|avi|flv|m4v|ogv|wmv|3gp|f4v|mp3|aac|flac|wav|ogg|opus|m4a|vtt|srt|ttml|dfxp';
  const MEDIA_PATH = new RegExp(`\\.(?:${EXT})$`, 'i');
  // quick test before any real work: a media extension, a base64 "http", or one of the query signatures
  const HINT = new RegExp(`\\.(?:${EXT})(?![a-z0-9])|aHR0c|videoplayback|timedtext|mime=(?:video|audio)|(?:format|type|output|stream_type|protocol)=(?:m3u8|mpd|hls|dash)|[\\\\/](?:hls|dash)[\\\\/]`, 'i');
  const CHUNK = /\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i;
  const MAX_TEXT = 2000000;
  const MAX_PER_TEXT = 60;
  const SEGMENT_GROUP = 25; // this many files differing only by a number in one text: pieces of a stream, not videos

  // ---- inject.js's own patterns and normaliser (copied as they are): what the existing scanner already finds
  const OLD_URL_RE = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|m3u|mp4|webm|m4a|mkv|mov|flv|mp3|aac|wav|ogg|vtt|srt|ttml)(?:[\w\d\-._~:/?#\[\]@!$&'()*+,;=%]*)/gi;
  const OLD_SIG_RE = /https?:\/\/[^\s"'<>]+(?:mime=video|mime=audio|mime=text%2Fvtt|format=m3u8|format=mpd|format=hls|format=dash|format=vtt|format=srt|type=m3u8|type=mpd|type=hls|type=dash|type=vtt|type=srt|output=m3u8|stream_type=hls|stream_type=dash|protocol=hls|\/videoplayback\?|\/(?:manifest|playlist|master)\.(?:m3u8|mpd)|\/hls\/|\/dash\/|\/api\/timedtext\?|\/timedtext\?)[^\s"'<>]*/gi;
  const SLICE_PARAMS = ['range', 'rn', 'sq', 'segment', 'seg', 'chunk', 'slice', 'part', 'frag', 'fragment', 'rbuf', 'alr', 'keepalive', 'sgoap', 'cpn', 'cver', 'bypass_hfr'];
  function oldNormalize(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const u = rawUrl.trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (!u.startsWith('http://') && !u.startsWith('https://')) return null;
    if (/\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i.test(u)) return null;
    try {
      const parsed = new URL(u);
      SLICE_PARAMS.forEach((p) => { if (parsed.searchParams.has(p)) parsed.searchParams.delete(p); });
      parsed.hash = '';
      return parsed.toString();
    } catch (e) {
      return u;
    }
  }
  function oldFound(text) {
    const out = new Set();
    [...(text.match(OLD_URL_RE) || []), ...(text.match(OLD_SIG_RE) || [])].forEach((m) => {
      const n = oldNormalize(m);
      if (n) out.add(n);
    });
    return out;
  }

  // ---- new patterns
  const ABS_RE = new RegExp(`https?:\\/\\/[^\\s"'<>\\\\]+?\\.(?:${EXT})(?:[?#][^\\s"'<>\\\\]*)?(?=[\\s"'<>\\\\,;)\\]}]|$)`, 'gi');
  // the existing query signatures, matched in a whole URL / tested on one
  const SIGS = 'mime=video|mime=audio|mime=text%2Fvtt|format=m3u8|format=mpd|format=hls|format=dash|format=vtt|format=srt|type=m3u8|type=mpd|type=hls|type=dash|type=vtt|type=srt|output=m3u8|stream_type=hls|stream_type=dash|protocol=hls|\\/videoplayback\\?|\\/(?:manifest|playlist|master)\\.(?:m3u8|mpd)|\\/hls\\/|\\/dash\\/|\\/api\\/timedtext\\?|\\/timedtext\\?';
  const SIG_RE = new RegExp(`https?:\\/\\/[^\\s"'<>\\\\]+(?:${SIGS})[^\\s"'<>\\\\]*`, 'gi');
  const SIG_TEST = new RegExp(`(?:${SIGS})`, 'i');
  const PCT_RE = /https?%(?:25)?3A%(?:25)?2F%(?:25)?2F[^\s"'<>&]+/gi;
  const B64_RE = /aHR0c[A-Za-z0-9+/_-]{12,}={0,2}/g;
  const NO_SCHEME_RE = new RegExp(`(?:^|["'(=\\s,\\[])(\\/\\/[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}(?::\\d+)?\\/[^\\s"'<>\\\\]*?\\.(?:${EXT})(?:[?#][^\\s"'<>\\\\]*)?)(?=[\\s"'<>\\\\,;)\\]}]|$)`, 'gi');
  const KEYS = 'file|src|source|url|uri|hls|dash|manifest|stream|streamurl|stream_url|video|videourl|video_url|videosrc|audio|audiourl|audio_url|mp4|m3u8|playlist|playbackurl|playback_url|contenturl|content_url|downloadurl|download_url|media|mediaurl|media_url';
  const KEYED_RE = new RegExp(`["']?\\b(?:${KEYS})["']?\\s*[:=]\\s*["']((?:\\.{1,2}\\/|\\/(?!\\/))[^"'\\s<>]+?\\.(?:${EXT})(?:\\?[^"'\\s<>]*)?|[^"'\\s<>:/.][^"'\\s<>:]*\\/[^"'\\s<>:]*?\\.(?:${EXT})(?:\\?[^"'\\s<>]*)?)["']`, 'gi');

  // Plain base64 decoder (the page may have replaced atob)
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_IDX = {};
  for (let i = 0; i < B64.length; i++) B64_IDX[B64[i]] = i;
  function b64decode(s) {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    let out = '';
    let val = 0;
    let bits = 0;
    for (let i = 0; i < t.length; i++) {
      const v = B64_IDX[t[i]];
      if (v === undefined) return '';
      val = ((val << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((val >> bits) & 255);
      }
    }
    return out;
  }

  function unescapeText(text) {
    if (!/\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\/)/.test(text)) return text;
    return text
      .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/');
  }

  // A candidate is kept when it is a web URL whose path ends in a media extension, or that carries one of the
  // existing query signatures (videoplayback, mime=video, format=m3u8, ...)
  function accept(raw, base) {
    try {
      const u = new URL(String(raw).replace(/&amp;/g, '&'), base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      const href = u.href;
      if (CHUNK.test(href)) return '';
      if (!MEDIA_PATH.test(u.pathname) && !SIG_TEST.test(href)) return '';
      return oldNormalize(href) || '';
    } catch (e) {
      return '';
    }
  }

  function absoluteIn(text) {
    const out = [];
    ABS_RE.lastIndex = 0;
    (text.match(ABS_RE) || []).forEach((m) => out.push(m));
    (text.match(SIG_RE) || []).forEach((m) => out.push(m));
    return out;
  }

  // -> [{ url, via }] (via: escaped | percent | base64 | relative | format | text)
  function extract(text, baseUrl, opts) {
    const o = opts || {};
    if (typeof text !== 'string' || text.length < 10 || text.length > MAX_TEXT || !HINT.test(text)) return [];
    const head = text.slice(0, 200).replace(/^\uFEFF/, '').trimStart();
    if (head.startsWith('#EXTM3U') || /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w-]+:)?MPD[\s>]/i.test(head)) return []; // playlists: the existing analysis owns them
    let base = baseUrl;
    try { base = new URL(baseUrl).href; } catch (e) { base = ''; }
    const skip = o.exclude ? oldFound(text) : new Set();
    const found = new Map(); // normalized url -> via
    const add = (raw, via, b) => {
      if (found.size >= 400) return;
      const url = accept(raw, b || base || undefined);
      if (url && !skip.has(url) && !found.has(url)) found.set(url, via);
    };

    const plain = text;
    const unescaped = unescapeText(text);
    // 1. absolute URLs: those already readable in the text (formats the old scanner does not list), then escaped ones
    const inPlain = new Set(absoluteIn(plain).map((m) => accept(m)).filter(Boolean));
    absoluteIn(unescaped).forEach((m) => {
      const n = accept(m);
      if (n) add(m, inPlain.has(n) ? (o.via || 'format') : 'escaped');
    });
    // 2. percent-encoded inside another URL (once or twice)
    (unescaped.match(PCT_RE) || []).slice(0, 200).forEach((m) => {
      let d = m;
      for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(d); i++) {
        try { d = decodeURIComponent(d); } catch (e) { break; }
      }
      absoluteIn(d).forEach((u) => add(u, 'percent'));
    });
    // 3. base64 of a URL
    (unescaped.match(B64_RE) || []).slice(0, 200).forEach((m) => {
      if (m.length > 4000) return;
      const d = b64decode(m);
      if (/^https?:\/\//i.test(d)) absoluteIn(d).forEach((u) => add(u, 'base64'));
    });
    // 4. without the scheme, and relative paths kept under a player-settings key
    if (base) {
      const scheme = /^https?:/i.test(base) ? new URL(base).protocol : 'https:';
      NO_SCHEME_RE.lastIndex = 0;
      let m;
      while ((m = NO_SCHEME_RE.exec(unescaped)) !== null) add(scheme + m[1], 'relative');
      KEYED_RE.lastIndex = 0;
      while ((m = KEYED_RE.exec(unescaped)) !== null) add(m[1], 'relative');
    }

    // numbered pieces of one stream (seg_1.mp4 ... seg_500.mp4) are not listed: the existing grouping owns them
    const groups = new Map();
    found.forEach((via, url) => {
      let key = url;
      try { const u = new URL(url); key = u.origin + u.pathname.replace(/\d+/g, '#'); } catch (e) {}
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(url);
    });
    const out = [];
    groups.forEach((urls) => {
      if (urls.length >= SEGMENT_GROUP) return;
      urls.forEach((url) => { if (out.length < MAX_PER_TEXT) out.push({ url: url, via: found.get(url) }); });
    });
    return out;
  }

  // content.js's own test for whether it hands an inline <script> to inject.js's scanner (copied as it is)
  function contentWouldScan(text, drm) {
    return !!(text && ((drm && drm.mayContainDrmUrl(text)) || text.includes('videoplayback') || text.includes('.m3u8') || text.includes('.mpd') || text.includes('mime=video') || text.includes('mime=audio') || text.includes('streamingData') || text.includes('captionTracks') || text.includes('timedtext')));
  }

  Object.defineProperty(root, '__VLE_DECODE__', {
    value: Object.freeze({ extract, contentWouldScan, mayHaveMedia: (t) => typeof t === 'string' && HINT.test(t), EXT }),
    enumerable: false,
    configurable: false
  });
})(globalThis);
