// drm-streams.js - Add-on: DRM / encryption detection shared by every part of the extension.
// Loaded by background.js (importScripts), inject.js (MAIN world), content.js and popup.js.
//
// It recognises, on any website (video and music alike):
//   - DRM-protected media URLs that carry no extension / media Content-Type (currently: Spotify's audio CDN)
//   - DRM systems named in streaming manifests (DASH ContentProtection, HLS #EXT-X-KEY, Smooth Streaming)
//   - encrypted MP4 files / init segments (pssh, schm, tenc boxes)
//   - Encrypted Media Extensions (EME) usage: key system, init data (PSSH / key ids)
//   - DRM license-server requests
//
// Also groups the many small requests of a segmented stream (Spotify's player) into one entry.
// Detection / labelling only: nothing in here decrypts, unlocks or requests a license for any media.
(function (root) {
  if (root.__VLE_DRM__) return;

  // ------------------------------------------------------------------ helpers
  const uniq = (arr) => Array.from(new Set(arr));
  const hex = (u8, s, e) => {
    let out = '';
    for (let i = s; i < e; i++) out += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return out;
  };
  const u32 = (u8, i) => ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
  const fourcc = (u8, i) => String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
  const uuidFromHex = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const isZeroKid = (k) => /^0+$/.test(k);
  const normKid = (s) => {
    const k = String(s || '').toLowerCase().replace(/[{}-]/g, '');
    return /^[0-9a-f]{32}$/.test(k) && !isZeroKid(k) ? k : null;
  };
  const b64ToBytes = (str) => {
    const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  // ------------------------------------------------------------------ DRM system registry
  const SYSTEM_IDS = {
    'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
    '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
    '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
    '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'ClearKey',
    'e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey',
    'f239e769-efa3-4850-9c16-a903c6932efb': 'Adobe Primetime',
    '5e629af5-38da-4063-8977-97ffbd9902d4': 'Marlin',
    'adb41c24-2dbf-4a6d-958b-4457c0d27b95': 'Nagra',
    '80a6be7e-1448-4c37-9e70-d5aebe04c8d9': 'Irdeto',
    '9a27dd82-fde2-4725-8cbc-4234aa06ec09': 'Verimatrix',
    '644fe7b5-260f-4fad-949a-0762ffb054b4': 'CMLA'
  };
  const WIDEVINE_HEX = 'edef8ba979d64acea3c827dcd51d21ed';

  // "urn:uuid:EDEF8BA9-…", "{9A04F079-…}" or a bare uuid -> friendly name (unknown ids keep a short id)
  function systemName(uuid) {
    const id = String(uuid || '').toLowerCase().replace(/^urn:uuid:/, '').replace(/[{}]/g, '').trim();
    if (!id) return null;
    return SYSTEM_IDS[id] || `DRM ${id.slice(0, 8)}`;
  }

  // EME key system string ("com.widevine.alpha", "com.apple.fps.1_0", …) -> friendly name
  function systemFromKeySystem(ks) {
    const s = String(ks || '').toLowerCase();
    if (!s) return '';
    if (s.includes('widevine')) return 'Widevine';
    if (s.includes('playready')) return 'PlayReady';
    if (s.includes('fps') || s.includes('fairplay')) return 'FairPlay';
    if (s.includes('clearkey')) return 'ClearKey';
    if (s.includes('primetime')) return 'Adobe Primetime';
    if (s.includes('marlin')) return 'Marlin';
    return String(ks).slice(0, 40);
  }

  // ------------------------------------------------------------------ PSSH / init data
  // Widevine PSSH payload is a protobuf; key ids are field 2 (16-byte strings)
  function widevineKids(d) {
    const out = [];
    let i = 0;
    const varint = () => {
      let v = 0, shift = 0;
      while (i < d.length) {
        const b = d[i++];
        v += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if (!(b & 0x80)) break;
      }
      return v;
    };
    try {
      while (i < d.length) {
        const tag = varint();
        const field = Math.floor(tag / 8), wire = tag & 7;
        if (wire === 0) varint();
        else if (wire === 2) {
          const len = varint();
          if (field === 2 && len === 16 && i + 16 <= d.length) out.push(hex(d, i, i + 16));
          i += len;
        } else if (wire === 1) i += 8;
        else if (wire === 5) i += 4;
        else break;
      }
    } catch (e) { /* malformed payload: keep what we have */ }
    return out;
  }

  // One or more concatenated 'pssh' boxes (EME initDataType "cenc", or the boxes inside a moov)
  function parsePssh(u8) {
    const systems = [], kids = [];
    if (!u8 || !u8.length) return { systems, kids };
    let off = 0;
    while (off + 32 <= u8.length) {
      const size = u32(u8, off);
      if (fourcc(u8, off + 4) !== 'pssh' || size < 32 || off + size > u8.length) break;
      const version = u8[off + 8];
      const sysHex = hex(u8, off + 12, off + 28);
      systems.push(systemName(uuidFromHex(sysHex)));
      let p = off + 28;
      if (version === 1 && p + 4 <= off + size) {
        const n = u32(u8, p);
        p += 4;
        for (let i = 0; i < n && p + 16 <= off + size; i++, p += 16) kids.push(hex(u8, p, p + 16));
      }
      if (p + 4 <= off + size) {
        const dlen = u32(u8, p);
        p += 4;
        if (sysHex === WIDEVINE_HEX && dlen) kids.push(...widevineKids(u8.subarray(p, Math.min(p + dlen, off + size))));
      }
      off += size;
    }
    return { systems: uniq(systems.filter(Boolean)), kids: uniq(kids.map(normKid).filter(Boolean)) };
  }

  // EME generateRequest(initDataType, initData) -> { systems, kids }
  function initDataInfo(initDataType, bytes) {
    try {
      if (!bytes || !bytes.length) return { systems: [], kids: [] };
      if (initDataType === 'cenc') return parsePssh(bytes);
      if (initDataType === 'keyids') {
        const json = JSON.parse(new TextDecoder().decode(bytes));
        const kids = (json.kids || []).map((k) => normKid(hex(b64ToBytes(k), 0, 16))).filter(Boolean);
        return { systems: ['ClearKey'], kids: uniq(kids) };
      }
      if (initDataType === 'webm' && bytes.length === 16) return { systems: [], kids: [normKid(hex(bytes, 0, 16))].filter(Boolean) };
    } catch (e) { /* unparsable init data */ }
    return { systems: [], kids: [] };
  }

  // ------------------------------------------------------------------ result shape + merging
  // { type: 'drm' | 'aes', systems: [], scheme: 'cbcs'|'cenc'|'AES-128'|…, kids: [], license: [], sources: [] }
  const SCHEMES = ['cenc', 'cbcs', 'cens', 'cbc1'];

  function mergeInfo(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return {
      type: a.type === 'drm' || b.type === 'drm' ? 'drm' : (a.type || b.type),
      systems: uniq([...(a.systems || []), ...(b.systems || [])]),
      scheme: a.scheme || b.scheme || null,
      kids: uniq([...(a.kids || []), ...(b.kids || [])]).slice(0, 20),
      license: uniq([...(a.license || []), ...(b.license || [])]).slice(0, 5),
      sources: uniq([...(a.sources || []), ...(b.sources || [])]).slice(0, 6)
    };
  }

  // ------------------------------------------------------------------ MP4 (first bytes of a file / init segment)
  function analyzeMp4Head(u8) {
    if (!u8 || u8.length < 16) return null;
    if (!['ftyp', 'styp', 'moov', 'moof', 'sidx'].includes(fourcc(u8, 4))) return null;
    const systems = [], kids = [];
    let scheme = null, encrypted = false;
    for (let i = 4; i + 8 <= u8.length; i++) {
      const t = fourcc(u8, i);
      if (t === 'pssh' && i + 24 <= u8.length) {
        const sysHex = hex(u8, i + 8, i + 24);
        systems.push(systemName(uuidFromHex(sysHex)));
        encrypted = true;
        if (u8[i + 4] === 1 && i + 28 <= u8.length) {
          const n = u32(u8, i + 24);
          for (let k = 0, p = i + 28; k < n && p + 16 <= u8.length; k++, p += 16) kids.push(hex(u8, p, p + 16));
        }
      } else if (t === 'schm' && i + 12 <= u8.length) {
        const s = fourcc(u8, i + 8);
        if (SCHEMES.includes(s)) { scheme = s; encrypted = true; }
      } else if (t === 'tenc' && i + 28 <= u8.length && u8[i + 10] === 1) {
        kids.push(hex(u8, i + 12, i + 28));
      } else if (t === 'enca' || t === 'encv') {
        encrypted = true;
      }
    }
    if (!encrypted) return null;
    return { type: 'drm', systems: uniq(systems.filter(Boolean)), scheme, kids: uniq(kids.map(normKid).filter(Boolean)).slice(0, 20), license: [], sources: ['init'] };
  }

  // ------------------------------------------------------------------ manifests
  const attrOf = (attrs, name) => {
    const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
  };

  function analyzeDash(text) {
    const systems = [], kids = [], license = [];
    let scheme = null, found = false;
    const re = /<ContentProtection\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      found = true;
      const id = (attrOf(m[1], 'schemeIdUri') || '').toLowerCase();
      if (id.includes('mp4protection')) scheme = (attrOf(m[1], 'value') || '').toLowerCase() || scheme;
      else if (id.startsWith('urn:uuid:')) systems.push(systemName(id));
      const kid = normKid(attrOf(m[1], 'default_KID'));
      if (kid) kids.push(kid);
    }
    if (!found) return null;
    const laText = /<(?:[\w-]+:)?laurl\b[^>]*>\s*(?:<!\[CDATA\[)?\s*(https?:[^<\s\]]+)/gi;
    const laAttr = /\blicenseUrl\s*=\s*["'](https?:[^"']+)["']/gi;
    while ((m = laText.exec(text)) !== null) license.push(m[1]);
    while ((m = laAttr.exec(text)) !== null) license.push(m[1]);
    return { type: 'drm', systems: uniq(systems.filter(Boolean)), scheme: SCHEMES.includes(scheme) ? scheme : null, kids: uniq(kids).slice(0, 20), license: uniq(license).slice(0, 5), sources: ['manifest'] };
  }

  function hlsKeyAttrs(line) {
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(line)) !== null) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function analyzeHls(text) {
    const systems = [], kids = [], license = [];
    let drmMethod = null, aesMethod = null;
    const re = /^#EXT-X-(?:SESSION-)?KEY:(.*)$/gim;
    let m;
    while ((m = re.exec(text)) !== null) {
      const a = hlsKeyAttrs(m[1]);
      const method = (a.METHOD || '').toUpperCase();
      if (!method || method === 'NONE') continue;
      const fmt = (a.KEYFORMAT || 'identity').toLowerCase();
      const uri = a.URI || '';
      let sys = null;
      if (fmt.includes('streamingkeydelivery') || /^skd:/i.test(uri)) sys = 'FairPlay';
      else if (fmt.startsWith('urn:uuid:')) sys = systemName(fmt);
      else if (fmt.includes('playready')) sys = 'PlayReady';
      else if (fmt.includes('widevine')) sys = 'Widevine';
      if (sys) {
        systems.push(sys);
        drmMethod = drmMethod || method;
        const data = /^data:[^,]*;base64,(.+)$/i.exec(uri);
        if (data) {
          try { kids.push(...parsePssh(b64ToBytes(data[1])).kids); } catch (e) { /* not a pssh */ }
        }
        if (/^https?:/i.test(uri)) license.push(uri.split(/[?#]/)[0]);
      } else {
        aesMethod = aesMethod || method;
      }
    }
    if (systems.length) {
      return { type: 'drm', systems: uniq(systems), scheme: drmMethod, kids: uniq(kids).slice(0, 20), license: uniq(license).slice(0, 5), sources: ['manifest'] };
    }
    if (aesMethod) return { type: 'aes', systems: [], scheme: aesMethod, kids: [], license: [], sources: ['manifest'] };
    return null;
  }

  function analyzeSmooth(text) {
    const systems = [];
    const re = /<ProtectionHeader\b[^>]*\bSystemID\s*=\s*["']\{?([0-9a-f-]{36})\}?["']/gi;
    let m;
    while ((m = re.exec(text)) !== null) systems.push(systemName(m[1]));
    return systems.length ? { type: 'drm', systems: uniq(systems), scheme: null, kids: [], license: [], sources: ['manifest'] } : null;
  }

  // Any streaming manifest text -> encryption info, or null when it is not encrypted / not a manifest
  function analyzeManifest(text) {
    if (typeof text !== 'string' || text.length < 8) return null;
    const head = text.slice(0, 8192);
    if (head.includes('<MPD')) return analyzeDash(text);
    if (head.includes('#EXTM3U')) return analyzeHls(text);
    if (head.includes('<SmoothStreamingMedia') || text.includes('<SmoothStreamingMedia')) return analyzeSmooth(text);
    return null;
  }

  // HLS master playlists list their keys in the media playlists: URI of the first variant / rendition to follow
  function firstPlaylistUri(text) {
    if (typeof text !== 'string' || !text.includes('#EXT-X-STREAM-INF')) {
      const media = /^#EXT-X-MEDIA:.*URI="([^"]+)"/m.exec(text || '');
      return media ? media[1] : null;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j].trim();
          if (l && !l.startsWith('#')) return l;
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ license servers
  // Deliberately conservative: only POST-style requests whose host/path names a DRM vendor or a license endpoint
  const LICENSE_RE = /widevine|playready|fairplay|drmtoday|ezdrm|keyos|buydrm|pallycon|axinom|castlabs|vudrm|expressplay|irdeto|verimatrix|conax|nagra|rightsmanager|licen[cs]e|acquire/i;
  function isLicenseRequest(url, method) {
    if (String(method || '').toUpperCase() !== 'POST' || typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      return LICENSE_RE.test(u.hostname + u.pathname);
    } catch (e) {
      return false;
    }
  }
  function stripQuery(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return '';
    }
  }

  // ------------------------------------------------------------------ Spotify audio CDN (extension-less encrypted files)
  //   https://audio4-fa.scdn.co/audio/<file id>?<token>
  //   https://audio4-ak.spotifycdn.com/audio/<file id>?__token__=exp=...~hmac=...
  //   https://audio-ak-spotify-com.akamaized.net/audio/<file id>?...
  // Tolerates JSON-escaped slashes (https:\/\/...) so it can scan raw API responses and inline page data.
  const SPOTIFY_AUDIO_SOURCE = /https?:(?:\\?\/){2}(?:audio[\w.-]*\.(?:scdn\.co|spotifycdn\.com)|audio[\w-]*spotify[\w-]*\.akamaized\.net)(?:\\?\/)audio(?:\\?\/)([0-9a-f]{32,})[^\s"'<>\\]*/.source;
  const SPOTIFY_HOST_HINT = /audio[\w.-]*\.(?:scdn\.co|spotifycdn\.com)|audio[\w-]*spotify[\w-]*\.akamaized\.net/i;
  const spotifyUrlRe = new RegExp('^' + SPOTIFY_AUDIO_SOURCE, 'i');

  // Cheap pre-check before running the full scan over large blobs of text
  function mayContainDrmUrl(text) {
    return typeof text === 'string' && SPOTIFY_HOST_HINT.test(text);
  }

  // All DRM-protected media URLs found inside a piece of text (page data, API JSON, ...)
  function findDrmUrls(text) {
    if (!mayContainDrmUrl(text)) return [];
    const out = [];
    const re = new RegExp(SPOTIFY_AUDIO_SOURCE, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[0]);
    return out;
  }

  // Describes a URL-recognisable DRM-protected media file, or returns null for anything else
  function info(url) {
    if (typeof url !== 'string') return null;
    const m = spotifyUrlRe.exec(url);
    if (!m) return null;
    return { provider: 'Spotify', kind: 'audio', ext: 'm4a', fileId: m[1].toLowerCase() };
  }

  function isDrmUrl(url) {
    return info(url) !== null;
  }

  // ------------------------------------------------------------------ segmented streams (Spotify video / podcast player)
  // The web player streams an episode as an init file plus many small pieces, one request each:
  //   https://video-fa.scdn.co/segments/v1/origins/<o>/sources/<s>/encodings/<e>/profiles/<p>/inits/mp4?fauth=...
  //   https://video-fa.scdn.co/segments/v1/origins/<o>/sources/<s>/encodings/<e>/profiles/<p>/<seconds>.mp4?fauth=...
  // All requests of one (source, encoding, profile) are ONE stream, so they are grouped into a single entry.
  const SPOTIFY_SEGMENT_RE = /^https?:\/\/video[\w.-]*\.(?:scdn\.co|spotifycdn\.com)\/segments\/v1\/origins\/([0-9a-f]+)\/sources\/([0-9a-f]+)\/encodings\/([0-9a-f]+)\/profiles\/(\d+)\/(?:inits\/(\w+)|(\d+)\.(\w+))(?:\?.*)?$/i;

  function segmentInfo(url) {
    if (typeof url !== 'string') return null;
    const m = SPOTIFY_SEGMENT_RE.exec(url);
    if (!m) return null;
    return {
      provider: 'Spotify',
      origin: m[1].toLowerCase(),
      source: m[2].toLowerCase(),
      encoding: m[3].toLowerCase(),
      profile: parseInt(m[4], 10),
      isInit: m[5] !== undefined,
      fileType: (m[5] || m[7] || '').toLowerCase(),
      index: m[6] !== undefined ? parseInt(m[6], 10) : -1
    };
  }

  // The player's stream manifest (JSON, fetched just before playback) -> compact description of the whole
  // stream: how to build every init / segment URL and how long the episode is. null for anything else.
  function parseSegmentManifest(text) {
    try {
      if (typeof text !== 'string' || text.length > 2000000 || !text.includes('"segment_template"') || !text.includes('"base_urls"')) return null;
      const data = JSON.parse(text);
      const c = data && Array.isArray(data.contents) ? data.contents[0] : null;
      if (!c || typeof data.segment_template !== 'string' || typeof data.initialization_template !== 'string') return null;
      const baseUrl = (data.base_urls || []).find((u) => /^https?:\/\//i.test(u));
      if (!baseUrl) return null;
      const profiles = (c.profiles || []).filter((p) => p && p.file_type === 'mp4').map((p) => ({
        id: p.id,
        mime: String(p.mime_type || ''),
        maxBitrate: p.max_bitrate || 0,
        codec: String(p.audio_codec || p.video_codec || ''),
        w: p.video_width || 0,
        h: p.video_height || 0
      }));
      return {
        provider: 'Spotify',
        baseUrl: baseUrl,
        initTemplate: data.initialization_template,
        segmentTemplate: data.segment_template,
        segLen: c.segment_length || 4,
        endMs: c.end_time_millis || data.end_time_millis || 0,
        encrypted: Array.isArray(c.encryption_infos) && c.encryption_infos.length > 0,
        profiles: profiles
      };
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ generic segmented streams (any site)
  // A URL that looks like one numbered piece of a stream: same folder + same name pattern, one number that changes
  //   .../v720/seg_0001.mp4   .../chunk-12.m4a   .../frag12-v1.mp4   .../media/seg7 (no extension)
  // Returns the "family" it belongs to; whether a family really is a stream is decided by the caller from
  // several requests (see background.js), never from one URL.
  const SEGMENT_EXT = /^(?:mp4|m4a|m4v|webm|mp3|aac|ogg|opus|flac|wav|mov|mkv|cmfv|cmfa|ts|m4s|m4f|mp2t|seg)$/i;
  const AUDIO_EXT = /^(?:m4a|aac|mp3|ogg|opus|flac|wav|cmfa)$/i;
  const INIT_RE = /(?:^|[\/._-])(?:inits?|initialization|header)(?:[._\/-]|\d|$)/i;

  function genericSegment(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const slash = u.pathname.lastIndexOf('/');
      const dir = u.pathname.slice(0, slash + 1);
      const name = u.pathname.slice(slash + 1);
      if (!name || name.length > 120) return null;
      const m = /^(.*?)(?:\.([a-z0-9]{2,5}))?$/i.exec(name);
      const stem = m[1];
      const ext = (m[2] || '').toLowerCase();
      if (ext && !SEGMENT_EXT.test(ext)) return null;
      const digits = stem.match(/\d+/g);
      if (!digits || digits.length > 4 || digits.join('').length > 15 || INIT_RE.test('/' + name)) return null;
      const pattern = stem.replace(/\d+/g, '#');
      const paramNames = Array.from(u.searchParams.keys()).sort().join('&');
      return {
        famKey: `${u.origin}${dir}${pattern}.${ext}?${paramNames}`,
        origin: u.origin, dir: dir, stem: stem, ext: ext, digits: digits, search: u.search,
        kind: AUDIO_EXT.test(ext) || /audio/i.test(dir + stem) ? 'audio' : 'video'
      };
    } catch (e) {
      return null;
    }
  }

  // "init.mp4", "inits/mp4", "video_init.mp4", "header.m4s": the file that precedes the pieces of a stream
  function isInitLike(url) {
    try {
      return INIT_RE.test(new URL(url).pathname);
    } catch (e) {
      return false;
    }
  }

  // De-duplication key. Segments of one stream share a key (so ~500 requests become one entry); the same
  // encrypted file served from several hosts with different expiring tokens shares one too; every other
  // URL is its own key.
  function keyFor(url) {
    const s = segmentInfo(url);
    if (s) return `seg:${s.provider.toLowerCase()}:${s.source}:${s.encoding}:${s.profile}`;
    const i = info(url);
    return i ? `drm:${i.provider.toLowerCase()}:${i.fileId}` : url;
  }

  Object.defineProperty(root, '__VLE_DRM__', {
    value: Object.freeze({
      // URL-recognisable DRM files
      mayContainDrmUrl, findDrmUrls, info, isDrmUrl, keyFor, segmentInfo, parseSegmentManifest, genericSegment, isInitLike,
      // generic evidence
      systemName, systemFromKeySystem, parsePssh, initDataInfo, analyzeMp4Head, analyzeManifest, firstPlaylistUri,
      isLicenseRequest, stripQuery, mergeInfo
    }),
    enumerable: false,
    configurable: false
  });
})(globalThis);
