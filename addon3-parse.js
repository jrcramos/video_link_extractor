// addon3-parse.js - Shared by the third set of add-on modules (addon3-worker.js in the background worker,
// addon3-popup.js in the popup). Reads what the existing manifest analysis (drm-streams.js) does not:
//   - module 15: Smooth Streaming and HDS manifests (qualities, length)
//   - module 16: ad breaks marked inside a stream (SCTE-35, HLS interstitials / cue tags, DASH events and periods)
//   - module 18: codec, HDR and audio format of each quality (HLS, DASH, Smooth, MP4 / WebM file headers)
//   - module 19: HLS extras (I-frame / image playlists, session data, content steering, low latency)
//   - module 20: the address of each DASH track (a file, or its list of segments)
// Pure functions: nothing in here touches the page, the network or the stored links.
(function (root) {
  if (root.__VLE_X3_PARSE__) return;

  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const int = (v) => Math.round(num(v));
  const resolveUrl = (u, base) => {
    try {
      const abs = new URL(String(u), base || undefined).toString();
      return /^https?:\/\//i.test(abs) && abs.length <= 4000 ? abs : '';
    } catch (e) {
      return '';
    }
  };

  // ------------------------------------------------------------------ codec / HDR / audio format tags (module 18)
  const VIDEO_CODECS = [
    [/^(?:dvh1|dvhe|dva1|dvav)/i, 'Dolby Vision'], [/^(?:hvc1|hev1|hevc)/i, 'HEVC'], [/^(?:avc[1-4]|h264)/i, 'H.264'],
    [/^av01/i, 'AV1'], [/^(?:vp09|vp9)/i, 'VP9'], [/^(?:vp08|vp8)/i, 'VP8'], [/^(?:vvc1|vvi1)/i, 'VVC'],
    [/^(?:mp4v|xvid|divx)/i, 'MPEG-4'], [/^(?:vc-?1|wvc1)/i, 'VC-1'], [/^theora/i, 'Theora']
  ];
  const AUDIO_CODECS = [
    [/^mp4a\.40\.(?:5|29)\b/i, 'HE-AAC'], [/^(?:mp4a\.(?:69|6b)|mp3|\.mp3)/i, 'MP3'], [/^(?:mp4a|aac)/i, 'AAC'],
    [/^ec[-+]3/i, 'E-AC-3'], [/^ac-3/i, 'AC-3'], [/^ac-4/i, 'AC-4'], [/^opus/i, 'Opus'], [/^(?:flac)/i, 'FLAC'],
    [/^vorbis/i, 'Vorbis'], [/^alac/i, 'ALAC'], [/^dts/i, 'DTS'], [/^(?:mhm[12]|mha[12])/i, 'MPEG-H']
  ];
  const TAG_ORDER = ['Dolby Vision', 'HEVC', 'H.264', 'AV1', 'VP9', 'VP8', 'VVC', 'MPEG-4', 'VC-1', 'Theora',
    'HDR10', 'HLG', 'Atmos', 'E-AC-3', 'AC-3', 'AC-4', 'DTS', 'MPEG-H', 'AAC', 'HE-AAC', 'MP3', 'Opus', 'FLAC', 'Vorbis', 'ALAC'];
  const sortTags = (tags) => Array.from(new Set(tags)).sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b)).slice(0, 8);

  // "hvc1.2.4.L150.B0,ec-3" (+ a video range: PQ / HLG) -> ['HEVC', 'HDR10', 'E-AC-3']
  function techTags(codecs, range) {
    const out = [];
    String(codecs || '').split(/[,\s/]+/).forEach((raw) => {
      const c = raw.trim();
      if (!c) return;
      const v = VIDEO_CODECS.find(([re]) => re.test(c));
      if (v) { out.push(v[1]); return; }
      const a = AUDIO_CODECS.find(([re]) => re.test(c));
      if (a) out.push(a[1]);
      if (/^ec\+3/i.test(c)) out.push('Atmos');
    });
    const r = String(range || '').toUpperCase();
    if (r === 'PQ') out.push('HDR10');
    else if (r === 'HLG') out.push('HLG');
    return sortTags(out);
  }

  // ------------------------------------------------------------------ HLS (modules 16, 18, 19)
  function hlsAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s)) !== null) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2].trim();
    return out;
  }

  // -> null when the text is not an HLS playlist, else
  // { master, first, tech: [tag], vt: { variant url: 'HDR10' }, iframes: [{ url, height, bandwidth, codecs }],
  //   images: [{ url, resolution }], session: [{ id, value, uri }], steering: { uri, pathways: [id] } | null,
  //   pathways: [id], ll, ad: { n, kind } | null }
  function hls(text, baseUrl) {
    if (typeof text !== 'string' || !text.slice(0, 8192).includes('#EXTM3U')) return null;
    const lines = text.split(/\r?\n/);
    const info = {
      master: false, first: '', tech: [], vt: {}, iframes: [], images: [], session: [], steering: null, pathways: [], ll: false, ad: null
    };
    const tags = [];
    let cueOut = 0, scte = 0, interstitial = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT')) continue;
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        info.master = true;
        const a = hlsAttrs(line.slice(18));
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (!next) continue;
          if (next.startsWith('#EXT-X-STREAM-INF')) break;
          if (next.startsWith('#')) continue;
          uri = next;
          break;
        }
        const url = resolveUrl(uri, baseUrl);
        if (url && !info.first) info.first = url;
        const t = techTags(`${a.CODECS || ''},${a['SUPPLEMENTAL-CODECS'] || ''}`, a['VIDEO-RANGE']);
        tags.push(...t);
        const note = t.filter((x) => x === 'HDR10' || x === 'HLG' || x === 'Dolby Vision').join(' · ');
        if (url && note && Object.keys(info.vt).length < 60) info.vt[url] = note;
        const pathway = a['PATHWAY-ID'];
        if (pathway && !info.pathways.includes(pathway) && info.pathways.length < 10) info.pathways.push(pathway.slice(0, 40));
      } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
        const a = hlsAttrs(line.slice(26));
        const url = resolveUrl(a.URI || '', baseUrl);
        const res = /^(\d+)x(\d+)$/i.exec(a.RESOLUTION || '');
        if (url && info.iframes.length < 20 && !info.iframes.some((x) => x.url === url)) {
          info.iframes.push({ url: url, height: res ? int(res[2]) : 0, bandwidth: int(a.BANDWIDTH), codecs: String(a.CODECS || '').slice(0, 60) });
        }
      } else if (line.startsWith('#EXT-X-IMAGE-STREAM-INF:')) {
        const a = hlsAttrs(line.slice(24));
        const url = resolveUrl(a.URI || '', baseUrl);
        if (url && info.images.length < 10 && !info.images.some((x) => x.url === url)) info.images.push({ url: url, resolution: String(a.RESOLUTION || '').slice(0, 20) });
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = hlsAttrs(line.slice(13));
        if (String(a.TYPE || '').toUpperCase() === 'AUDIO' && /JOC/i.test(a.CHANNELS || '')) tags.push('Atmos');
      } else if (line.startsWith('#EXT-X-SESSION-DATA:')) {
        const a = hlsAttrs(line.slice(20));
        if (a['DATA-ID'] && info.session.length < 20) {
          info.session.push({ id: a['DATA-ID'].slice(0, 100), value: String(a.VALUE || '').slice(0, 300), uri: a.URI ? resolveUrl(a.URI, baseUrl) : '' });
        }
      } else if (line.startsWith('#EXT-X-CONTENT-STEERING:')) {
        const a = hlsAttrs(line.slice(24));
        const uri = resolveUrl(a['SERVER-URI'] || '', baseUrl);
        if (uri) info.steering = { uri: uri, pathway: String(a['PATHWAY-ID'] || '').slice(0, 40) };
      } else if (line.startsWith('#EXT-X-PART:') || line.startsWith('#EXT-X-PART-INF') || line.startsWith('#EXT-X-PRELOAD-HINT') || (line.startsWith('#EXT-X-SERVER-CONTROL') && /PART-HOLD-BACK/.test(line))) {
        info.ll = true;
      } else if (line.startsWith('#EXT-X-CUE-OUT') && !line.startsWith('#EXT-X-CUE-OUT-CONT')) {
        cueOut++;
      } else if (line.startsWith('#EXT-X-DATERANGE:')) {
        if (/CLASS="com\.apple\.hls\.interstitial"|X-ASSET-(?:URI|LIST)=/.test(line)) interstitial++;
        else if (/SCTE35-OUT=/.test(line)) scte++;
      } else if (line.startsWith('#EXT-OATCLS-SCTE35') || line.startsWith('#EXT-X-SCTE35') || line.startsWith('#EXT-X-SPLICEPOINT-SCTE35')) {
        scte++;
      }
    }
    info.tech = sortTags(tags);
    if (interstitial) info.ad = { n: interstitial, kind: 'interstitial' };
    else if (cueOut) info.ad = { n: cueOut, kind: 'cue' };
    else if (scte) info.ad = { n: scte, kind: 'scte35' };
    return info;
  }

  // ------------------------------------------------------------------ a small XML reader (the worker has no DOMParser)
  // -> { name (without prefix), attrs, kids, text }. Tolerates a document cut short.
  function parseXml(text) {
    const rootNode = { name: '#root', attrs: {}, kids: [], text: '' };
    const stack = [rootNode];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const unesc = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
    let m;
    let nodes = 0;
    while ((m = re.exec(text)) !== null) {
      const top = stack[stack.length - 1];
      if (m[3]) {
        if (++nodes > 200000) break;
        const node = { name: m[3].replace(/^[\w.-]+:/, ''), attrs: {}, kids: [], text: '' };
        if (m[4]) {
          attrRe.lastIndex = 0;
          let a;
          while ((a = attrRe.exec(m[4])) !== null) node.attrs[a[1].replace(/^[\w.-]+:/, '')] = unesc(a[2] !== undefined ? a[2] : a[3]);
        }
        top.kids.push(node);
        if (!m[5]) stack.push(node);
      } else if (m[2]) {
        const name = m[2].replace(/^[\w.-]+:/, '');
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === name) { stack.length = i; break; }
        }
      } else if (m[1] !== undefined) {
        top.text += m[1];
      } else if (m[6]) {
        if (top.text.length < 4000) top.text += unesc(m[6]);
      }
    }
    return rootNode;
  }
  const kidsOf = (node, name) => (node ? node.kids.filter((k) => k.name === name) : []);
  const kidOf = (node, name) => (node ? node.kids.find((k) => k.name === name) || null : null);

  // "PT1H2M3.5S" -> 3723.5
  function isoSeconds(s) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(String(s || '').trim());
    if (!m) return 0;
    return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600 + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
  }

  // ------------------------------------------------------------------ DASH (modules 16, 18, 20)
  const MAX_TRACKS = 60;
  const MAX_TIMELINE = 4000;
  const fpsOf = (v) => {
    const frac = /^(\d+)\/(\d+)$/.exec(String(v || ''));
    const n = frac ? Number(frac[1]) / Number(frac[2]) : parseFloat(v);
    return Number.isFinite(n) && n > 0 && n < 1000 ? Math.round(n * 100) / 100 : 0;
  };
  const fillIds = (tpl, rep) => String(tpl || '')
    .replace(/\$RepresentationID\$/g, rep.attrs.id || '')
    .replace(/\$Bandwidth(?:%0(\d+)d)?\$/g, (x, w) => String(rep.attrs.bandwidth || '').padStart(Number(w) || 0, '0'));

  // -> null when the text is not a DASH manifest, else
  // { live, periods, tech: [tag], ad: { n, kind } | null, thumbs: [{ url, w, h }],
  //   tracks: [{ kind, id, width, height, bandwidth, fps, codecs, language, tags, url, parts }] }
  // A track is either one file (url) or a list of parts, one per period: { init, media, start, ts, dur, n, tl:
  // [[t, d, r]], urls } (media keeps its $Number$ / $Time$ placeholder; see dashSegments).
  function dash(text, baseUrl) {
    if (typeof text !== 'string' || !/<(?:[\w-]+:)?MPD[\s>]/.test(text.slice(0, 8192))) return null;
    const mpd = kidOf(parseXml(text), 'MPD');
    if (!mpd) return null;
    const live = String(mpd.attrs.type || '').toLowerCase() === 'dynamic';
    const baseOf = (node, parent) => {
      const b = kidOf(node, 'BaseURL');
      return b && b.text.trim() ? (resolveUrl(b.text.trim(), parent) || parent) : parent;
    };
    const mpdBase = baseOf(mpd, baseUrl || '');
    const periods = kidsOf(mpd, 'Period');
    const total = isoSeconds(mpd.attrs.mediaPresentationDuration);
    const info = { live: live, periods: periods.length, tech: [], ad: null, thumbs: [], tracks: [] };
    const byKey = new Map();
    const tags = [];
    let events = 0;

    periods.forEach((period, pi) => {
      const pBase = baseOf(period, mpdBase);
      const start = isoSeconds(period.attrs.start);
      let pdur = isoSeconds(period.attrs.duration);
      if (!pdur && periods[pi + 1] && periods[pi + 1].attrs.start !== undefined) pdur = Math.max(0, isoSeconds(periods[pi + 1].attrs.start) - start);
      if (!pdur && pi === periods.length - 1 && total) pdur = Math.max(0, total - start); // the last period: to the end
      kidsOf(period, 'EventStream').forEach((es) => {
        if (/scte.?35/i.test(es.attrs.schemeIdUri || '')) events += Math.max(1, kidsOf(es, 'Event').length);
      });
      kidsOf(period, 'AdaptationSet').forEach((set) => {
        const sBase = baseOf(set, pBase);
        const setType = String(set.attrs.contentType || set.attrs.mimeType || '').toLowerCase();
        const props = (node) => [...kidsOf(node, 'EssentialProperty'), ...kidsOf(node, 'SupplementalProperty')];
        kidsOf(set, 'Representation').forEach((rep) => {
          const type = String(rep.attrs.mimeType || setType).toLowerCase();
          const rBase = baseOf(rep, sBase);
          // nearest SegmentTemplate / SegmentList / SegmentBase, attributes inherited from the levels above
          const levels = [period, set, rep];
          const tpl = {};
          let timeline = null;
          let list = null;
          levels.forEach((lvl) => {
            const t = kidOf(lvl, 'SegmentTemplate');
            if (t) {
              Object.assign(tpl, t.attrs);
              const tl = kidOf(t, 'SegmentTimeline');
              if (tl) timeline = tl;
            }
            const l = kidOf(lvl, 'SegmentList');
            if (l) list = l;
          });

          if (type.includes('image')) {
            if (tpl.media && info.thumbs.length < 6) {
              const url = resolveUrl(fillIds(tpl.media, rep), rBase);
              if (url) info.thumbs.push({ url: url, w: int(rep.attrs.width), h: int(rep.attrs.height) });
            }
            return;
          }
          const kind = type.includes('audio') ? 'audio' : (type.includes('text') || type.includes('ttml') || type.includes('vtt') ? 'subtitle' : 'video');
          const codecs = String(rep.attrs.codecs || set.attrs.codecs || '').slice(0, 60);
          let range = '';
          [...props(set), ...props(rep)].forEach((p) => {
            const scheme = String(p.attrs.schemeIdUri || '');
            if (/TransferCharacteristics/i.test(scheme)) range = p.attrs.value === '16' ? 'PQ' : (p.attrs.value === '18' ? 'HLG' : range);
            if (/EC3_ExtensionType/i.test(scheme) && /JOC/i.test(p.attrs.value || '')) tags.push('Atmos');
          });
          const t = techTags(codecs, range);
          tags.push(...t);

          const key = `${kind}|${rep.attrs.id || ''}|${rep.attrs.bandwidth || ''}|${set.attrs.lang || ''}`;
          let track = byKey.get(key);
          if (!track) {
            if (info.tracks.length >= MAX_TRACKS) return;
            track = {
              kind: kind, id: String(rep.attrs.id || '').slice(0, 60),
              width: int(rep.attrs.width || set.attrs.width), height: int(rep.attrs.height || set.attrs.height),
              bandwidth: int(rep.attrs.bandwidth), fps: fpsOf(rep.attrs.frameRate || set.attrs.frameRate),
              codecs: codecs, language: String(set.attrs.lang || '').slice(0, 20), tags: t, url: '', parts: []
            };
            byKey.set(key, track);
            info.tracks.push(track);
          }

          if (tpl.media) {
            const part = {
              init: tpl.initialization ? resolveUrl(fillIds(tpl.initialization, rep), rBase) : '',
              media: resolveUrl(fillIds(tpl.media, rep), rBase),
              start: tpl.startNumber !== undefined ? Math.max(0, parseInt(tpl.startNumber, 10) || 0) : 1,
              ts: num(tpl.timescale) || 1, dur: num(tpl.duration), n: 0, tl: null
            };
            if (!part.media) return;
            if (timeline) {
              const rows = kidsOf(timeline, 'S');
              if (rows.length > MAX_TIMELINE) return; // too long to keep: this track stays without an address
              // t is kept as text: times in 100 ns units since 1970 do not fit a JavaScript number
              part.tl = rows.map((s) => [/^\d+$/.test(s.attrs.t || '') ? s.attrs.t : '', int(s.attrs.d), Math.max(-1, parseInt(s.attrs.r, 10) || 0)]);
            } else if (part.dur && pdur && !live) {
              part.n = Math.ceil((pdur * part.ts) / part.dur - 1e-6);
            } else {
              return; // a live stream numbered from the clock: nothing to list
            }
            if (track.parts.length < 30) track.parts.push(part);
          } else if (list) {
            const init = kidOf(list, 'Initialization');
            const urls = kidsOf(list, 'SegmentURL').map((s) => resolveUrl(s.attrs.media || '', rBase)).filter(Boolean).slice(0, 5000);
            const ts = num(list.attrs.timescale) || 1;
            if (urls.length && track.parts.length < 30) {
              track.parts.push({ init: init && init.attrs.sourceURL ? resolveUrl(init.attrs.sourceURL, rBase) : '', urls: urls, dur: num(list.attrs.duration), ts: ts });
            }
          } else if (kidOf(rep, 'BaseURL') && rBase && periods.length === 1 && !track.url) {
            track.url = rBase; // one file per track (SegmentBase, or nothing at all)
          }
        });
      });
    });
    info.tech = sortTags(tags);
    if (events) info.ad = { n: events, kind: 'scte35' };
    return info;
  }

  // The parts of a DASH track written out -> [{ init, segments: [{ url, dur }] }], at most max segments in all
  function dashSegments(track, max) {
    const limit = max || 20000;
    const out = [];
    let count = 0;
    const fill = (tpl, number, time) => tpl
      .replace(/\$Number(?:%0(\d+)d)?\$/g, (x, w) => String(number).padStart(Number(w) || 0, '0'))
      .replace(/\$Time(?:%0(\d+)d)?\$/g, (x, w) => String(time).padStart(Number(w) || 0, '0'))
      .replace(/\$\$/g, '$');
    (track && Array.isArray(track.parts) ? track.parts : []).forEach((part) => {
      const segments = [];
      if (Array.isArray(part.urls)) {
        part.urls.forEach((u) => { if (count++ < limit) segments.push({ url: u, dur: part.dur ? part.dur / part.ts : 0 }); });
      } else if (Array.isArray(part.tl)) {
        let time = 0n;
        let number = part.start;
        part.tl.forEach(([t, d, r]) => {
          if (t !== '') { try { time = BigInt(t); } catch (e) {} }
          const repeat = r < 0 ? 0 : r; // "until the end" needs the period's length: only the first is listed
          for (let i = 0; i <= repeat; i++) {
            if (count++ < limit) segments.push({ url: fill(part.media, number, time), dur: d / part.ts });
            time += BigInt(d);
            number++;
          }
        });
      } else {
        for (let i = 0; i < part.n; i++) {
          if (count++ < limit) segments.push({ url: fill(part.media, part.start + i, BigInt(i) * BigInt(Math.round(part.dur))), dur: part.dur / part.ts });
        }
      }
      if (segments.length) out.push({ init: part.init || '', segments: segments });
    });
    return out;
  }

  // A DASH track as an HLS VOD playlist ffmpeg can join (init segment + every piece, in order)
  function dashPlaylist(track, comment) {
    const parts = dashSegments(track);
    if (!parts.length) return '';
    let longest = 1;
    parts.forEach((p) => p.segments.forEach((s) => { if (s.dur > longest) longest = s.dur; }));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(longest)}`, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
    if (comment) String(comment).split('\n').forEach((l) => lines.push(`# ${l.replace(/[\r\n]/g, ' ')}`));
    parts.forEach((p, i) => {
      if (i) lines.push('#EXT-X-DISCONTINUITY');
      if (p.init) lines.push(`#EXT-X-MAP:URI="${p.init}"`);
      p.segments.forEach((s) => {
        lines.push(`#EXTINF:${(s.dur > 0 ? s.dur : 4).toFixed(3)},`);
        lines.push(s.url);
      });
    });
    lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
  }

  // ------------------------------------------------------------------ Smooth Streaming / HDS (module 15)
  const FOURCC = { H264: 'avc1', AVC1: 'avc1', HVC1: 'hvc1', HEV1: 'hev1', HEVC: 'hvc1', AACL: 'mp4a.40.2', AACH: 'mp4a.40.5', AAC: 'mp4a.40.2', 'EC-3': 'ec-3', WVC1: 'vc-1', WMAP: 'wma', TTML: '', DFXP: '' };
  const roundSec = (s) => (s > 0 && s < 7 * 86400 ? Math.round(s * 10) / 10 : 0);

  // -> null, or { variants: { type: 'mss', items }, duration, live, tech, protected }
  function smooth(text) {
    if (typeof text !== 'string' || !/<SmoothStreamingMedia[\s>]/.test(text.slice(0, 8192))) return null;
    const media = kidOf(parseXml(text), 'SmoothStreamingMedia');
    if (!media) return null;
    const scale = num(media.attrs.TimeScale) || 10000000;
    const live = /^true$/i.test(media.attrs.IsLive || '');
    const items = [];
    const tags = [];
    kidsOf(media, 'StreamIndex').forEach((si) => {
      const type = String(si.attrs.Type || '').toLowerCase();
      const kind = type === 'audio' ? 'audio' : (type === 'text' ? 'subtitle' : (type === 'video' ? 'video' : ''));
      if (!kind) return;
      kidsOf(si, 'QualityLevel').forEach((q) => {
        if (items.length >= 40) return;
        const four = String(q.attrs.FourCC || '').toUpperCase();
        const codecs = FOURCC[four] !== undefined ? FOURCC[four] : four.toLowerCase();
        tags.push(...techTags(codecs));
        items.push({
          kind: kind, url: '',
          width: int(q.attrs.MaxWidth || q.attrs.Width), height: int(q.attrs.MaxHeight || q.attrs.Height),
          bandwidth: int(q.attrs.Bitrate), fps: 0, codecs: codecs.slice(0, 60),
          name: String(si.attrs.Name || '').slice(0, 80), language: String(si.attrs.Language || '').slice(0, 20)
        });
      });
    });
    if (!items.some((it) => it.kind === 'video' || it.kind === 'audio')) return null;
    return {
      variants: { type: 'mss', items: items }, duration: live ? 0 : roundSec(num(media.attrs.Duration) / scale), live: live,
      tech: sortTags(tags), protected: !!kidOf(media, 'Protection')
    };
  }

  // -> null, or { variants: { type: 'hds', items }, duration, live }
  function hds(text) {
    if (typeof text !== 'string' || !/<manifest\b[^>]*ns\.adobe\.com\/f4m/i.test(text.slice(0, 8192))) return null;
    const man = kidOf(parseXml(text), 'manifest');
    if (!man) return null;
    const items = kidsOf(man, 'media').slice(0, 40).map((m) => ({
      kind: 'video', url: '', width: int(m.attrs.width), height: int(m.attrs.height), bandwidth: int(m.attrs.bitrate) * 1000,
      fps: 0, codecs: '', name: '', language: ''
    }));
    if (!items.length) return null;
    const d = kidOf(man, 'duration');
    const type = kidOf(man, 'streamType');
    const live = !!type && /live/i.test(type.text);
    return { variants: { type: 'hds', items: items }, duration: live ? 0 : roundSec(parseFloat(d ? d.text : '') || 0), live: live };
  }

  // ------------------------------------------------------------------ media file headers (module 18)
  const fourccAt = (u8, i) => String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
  const MP4_FORMATS = {
    avc1: 'avc1', avc3: 'avc1', hvc1: 'hvc1', hev1: 'hvc1', dvh1: 'dvh1', dvhe: 'dvh1', dva1: 'dvh1', dvav: 'dvh1', av01: 'av01', vp09: 'vp09',
    vp08: 'vp08', vvc1: 'vvc1', mp4v: 'mp4v', mp4a: 'mp4a', 'ac-3': 'ac-3', 'ec-3': 'ec-3', 'ac-4': 'ac-4', Opus: 'opus', fLaC: 'flac',
    alac: 'alac', dtsc: 'dts', dtse: 'dts', dtsh: 'dts', dtsx: 'dts', mhm1: 'mhm1', mha1: 'mha1', '.mp3': 'mp3'
  };
  // First bytes of an MP4 / WebM file -> ['HEVC', 'HDR10', 'AAC'] ([] when they do not say)
  function fileTech(u8) {
    try {
      if (!u8 || u8.length < 32) return [];
      const codecs = [];
      let range = '';
      const extra = [];
      if (['ftyp', 'moov', 'styp'].includes(fourccAt(u8, 4))) {
        for (let i = 4; i + 20 <= u8.length; i++) {
          if (u8[i] !== 0x73 && u8[i] !== 0x66 && u8[i] !== 0x63 && u8[i] !== 0x64) continue; // s, f, c, d
          const t = fourccAt(u8, i);
          if (t === 'stsd') {
            const fmt = fourccAt(u8, i + 16);
            if (MP4_FORMATS[fmt]) codecs.push(MP4_FORMATS[fmt]);
          } else if (t === 'frma') { // the real format of an encrypted track
            const fmt = fourccAt(u8, i + 4);
            if (MP4_FORMATS[fmt]) codecs.push(MP4_FORMATS[fmt]);
          } else if (t === 'colr' && fourccAt(u8, i + 4) === 'nclx') {
            const transfer = (u8[i + 10] << 8) | u8[i + 11];
            if (transfer === 16) range = 'PQ';
            else if (transfer === 18) range = 'HLG';
          } else if (t === 'dvcC' || t === 'dvvC') {
            extra.push('Dolby Vision');
          }
        }
      } else if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) { // EBML (WebM / Matroska)
        let head = '';
        for (let i = 0; i < Math.min(u8.length, 8192); i++) head += String.fromCharCode(u8[i]);
        const ids = { V_VP9: 'vp09', V_VP8: 'vp08', V_AV1: 'av01', 'V_MPEG4/ISO/AVC': 'avc1', 'V_MPEGH/ISO/HEVC': 'hvc1', A_OPUS: 'opus', A_VORBIS: 'vorbis', A_AAC: 'mp4a', A_FLAC: 'flac', A_AC3: 'ac-3', A_EAC3: 'ec-3' };
        Object.keys(ids).forEach((id) => { if (head.includes(id)) codecs.push(ids[id]); });
      }
      return sortTags([...techTags(codecs.join(','), range), ...extra]);
    } catch (e) {
      return [];
    }
  }

  Object.defineProperty(root, '__VLE_X3_PARSE__', {
    value: Object.freeze({ techTags, hls, dash, dashSegments, dashPlaylist, smooth, hds, fileTech, parseXml }),
    enumerable: false,
    configurable: false
  });
})(globalThis);
