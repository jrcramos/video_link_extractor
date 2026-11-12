// addon3-popup.js - Shows in the popup what the third set of add-on modules (addon3-*.js, modules 12-22) found.
// Loaded before popup.js, which calls in at a few marked places (all optional: without this file the popup works as
// before). It only adds: badges, panels that open on request, a banner for live transports, a HAR export and extra
// JSON export fields. The card's own buttons and the Copy / + Ref / + Name / yt-dlp outputs are not changed.
(function () {
  const P = window.__VLE_X3_PARSE__ || null;
  let A = null; // popup.js's functions, given to init()
  const info = new Map(); // link url -> what the background worker knows about it (see addon3-worker.js x3Info)
  let page = null; // page-level findings (WebRTC, WebSocket, WebTransport, WebCodecs, oEmbed)
  let lastJson = '';
  const openPanels = new Set(); // `${url}|${panel}`

  const SMOOTH = /\.isml?\/manifest(?:\((?![^)]*(?:m3u8|mpd))[^)\/]*\))?(?:[?#]|$)/i;
  const HDS = /\.f4m(?:[?#]|$)/i;
  const LIST = /\.(pls|asx|xspf)(?:[?#]|$)/i;
  const SECRET = /cookie|authorization|token|auth|session|secret|api-?key|signature|csrf|xsrf|password/i;
  const RESOLVABLE = [
    /^https?:\/\/player\.vimeo\.com\/video\/\d+/i,
    /^https?:\/\/(?:cdn\.jwplayer\.com|content\.jwplatform\.com)\/(?:players|previews|manifests)\/[a-z0-9]{8}(?:[-.]|$)/i,
    /^https?:\/\/(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/[a-z0-9]+/i,
    /^https?:\/\/(?:(?:www\.)?dailymotion\.com\/embed\/video\/[a-z0-9]+|geo\.dailymotion\.com\/player(?:\/[\w-]+)?\.html\?(?:[^#]*&)?video=[a-z0-9]+)/i,
    /^https?:\/\/(?:www\.)?streamable\.com\/[eos]\/[\w-]+/i,
    /^https?:\/\/(?:[\w-]+\.)*kaltura\.com(?=.*?(?:\/p\/|partner_id[\/=])\d+)(?=.*?entry_?id[\/=][\w-]+)/i,
    /^https?:\/\/players\.brightcove\.net\/\d+\/[\w-]+?_[\w-]+\/index\.html\?(?:[^#]*&)?videoId=/i
  ];

  // How the modules found a link (their badge, like the other add-on modules' badges)
  const BADGES = {
    stream: ['🧭 By address', 'A Smooth Streaming / HDS / Azure manifest, recognised by its address'],
    radio: ['📻 Radio', 'An Icecast / SHOUTcast radio stream, recognised by its icy- headers'],
    playlist: ['📃 Playlist', 'A .pls / .asx / .xspf playlist, or a stream such a playlist lists'],
    feed: ['🎙 Feed', 'An item of an RSS / Atom feed (podcast) the page loaded'],
    resolved: ['🔍 Resolved', 'Asked from the embedded player\'s own service (🔍 Resolve)']
  };
  const NOTABLE = (t) => !['H.264', 'AAC', 'MP3'].includes(t);

  const el = (tag, cls, text, title) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (title) e.title = title;
    e.dataset.x3 = '1'; // everything this file adds is marked (tests/run.js compares the popup without it)
    return e;
  };
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
  const kbps = (bps) => (bps > 0 ? (bps >= 1000000 ? `${(bps / 1000000).toFixed(1)} Mb/s` : `${Math.round(bps / 1000)} kb/s`) : '');
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  // ---- the kind of link (popup.js getMediaType asks first): only for the formats these modules add
  function mediaType(url, addon) {
    if (typeof url !== 'string') return null;
    if ((addon && addon.manifest === 'mss') || SMOOTH.test(url)) {
      return { category: 'stream', label: 'Smooth Stream', tagClass: 'tag-stream', isStream: true, isSmooth: true, noPlay: true, ext: 'ismc', icon: '🎬' };
    }
    if ((addon && addon.manifest === 'hds') || HDS.test(url)) {
      return { category: 'stream', label: 'HDS Stream', tagClass: 'tag-stream', isStream: true, isHds: true, noPlay: true, ext: 'f4m', icon: '🎬' };
    }
    const m = LIST.exec(url.split('#')[0]);
    const kind = (addon && typeof addon.playlist === 'string' && /^(?:pls|asx|xspf)$/.test(addon.playlist) && addon.playlist) || (m && m[1].toLowerCase()) || '';
    if (kind) return { category: 'stream', label: `Playlist (.${kind})`, tagClass: 'tag-stream', isStream: true, isPlaylist: true, noPlay: true, ext: kind, icon: '📃' };
    return null;
  }

  // ---- what the worker knows, asked when cards are built and whenever it learns something new
  let requestTimer = null;
  function scheduleRequest(delay = 250) {
    if (!A || requestTimer) return;
    requestTimer = setTimeout(request, delay);
  }
  function request() {
    requestTimer = null;
    const tabId = safe(() => A.tabId(), undefined);
    if (tabId === undefined) return;
    const urls = safe(() => A.links().map((l) => l && l.url).filter((u) => typeof u === 'string'), []);
    try {
      chrome.runtime.sendMessage({ action: 'x3Info', tabId: tabId, urls: urls }, (res) => {
        if (chrome.runtime.lastError || !res || tabId !== safe(() => A.tabId(), undefined)) return;
        const json = JSON.stringify(res);
        if (json === lastJson) return;
        lastJson = json;
        info.clear();
        Object.entries(res.items || {}).forEach(([u, v]) => info.set(u, v));
        page = res.page || null;
        renderBanner();
        safe(() => A.relayout());
      });
    } catch (e) {}
  }

  // =============================================================================================
  // Per card: badges, panels (opened on request), the 🔍 Resolve button of embeds
  // =============================================================================================
  function card(ctx) {
    const url = ctx.url;
    scheduleRequest();
    const boxes = {};
    const isOpen = (name) => openPanels.has(`${url}|${name}`);
    const data = () => info.get(url) || {};

    const toggle = (name, text, title) => {
      const b = el('button', 'variants-toggle', '', title);
      b.type = 'button';
      const label = () => { b.textContent = `${text} ${isOpen(name) ? '▴' : '▾'}`; };
      label();
      b.addEventListener('click', () => {
        const key = `${url}|${name}`;
        if (openPanels.has(key)) openPanels.delete(key); else openPanels.add(key);
        label();
        panels();
      });
      return b;
    };
    const badge = (cls, text, title) => el('span', `type-tag ${cls}`, text, title);

    function tags(tagRow, cur) {
      const d = data();
      const probe = d.probe || {};
      const source = cur && cur.addon && cur.addon.source;
      if (BADGES[source] && !(source === 'radio' && d.radio)) tagRow.appendChild(badge('tag-addon', BADGES[source][0], source === 'resolved' && cur.addon.resolvedFrom ? `Asked from ${cur.addon.resolvedFrom}'s own service (🔍 Resolve)` : BADGES[source][1]));
      if (d.ad) tagRow.appendChild(badge('x3-ad', '📢 Ad', d.ad === 'vast' ? 'Listed as an ad file in a VAST ad answer the page loaded' : `Served by an ad server (${hostOf(url)})`));
      if (probe.ad) {
        const n = probe.ad.n || 1;
        if (probe.ad.kind === 'period') {
          tagRow.appendChild(badge('x3-tag', `⏸ ${n + 1} periods`, `The DASH manifest is split into ${n + 1} periods: usually ad breaks stitched into the programme, or a programme in parts`));
        } else {
          const how = { cue: 'cue tags (#EXT-X-CUE-OUT)', scte35: 'SCTE-35 markers', interstitial: 'HLS interstitials' }[probe.ad.kind] || 'markers';
          tagRow.appendChild(badge('x3-ad', `📢 ${n} ad break${n === 1 ? '' : 's'}`, `The stream marks ad breaks with ${how}: ads are stitched into it (server-side ad insertion), and a download includes them`));
        }
      }
      if (d.radio) {
        const r = d.radio;
        tagRow.appendChild(badge('x3-tag', `📻 Live radio${r.br ? ` · ${r.br} kb/s` : ''}`, [r.name && `Station: ${r.name}`, r.genre && `Genre: ${r.genre}`, r.desc, r.site].filter(Boolean).join('\n') || 'Icecast / SHOUTcast radio stream: it never ends'));
      }
      const tech = Array.isArray(probe.tech) ? probe.tech : [];
      if (tech.length) tagRow.appendChild(badge('x3-tag', `🎞 ${tech.join(' · ')}`, 'Video / audio formats of this stream or file (codec, HDR, audio format), read from its manifest or header'));
      if (probe.ll) tagRow.appendChild(badge('x3-tag', '⚡ Low latency', 'Low-latency HLS: the playlist announces partial segments'));
      if (probe.steering) tagRow.appendChild(badge('x3-tag', `🔀 Steering${probe.pathways && probe.pathways.length > 1 ? ` · ${probe.pathways.length} CDNs` : ''}`, `Content steering: the player picks between CDNs as ${hostOf(probe.steering.uri)} tells it`));
      const mss = probe.mss;
      if (mss && mss.live) tagRow.appendChild(badge('tag-live', '🔴 Live', 'Live stream'));
      else if (mss && mss.duration > 0 && !(cur && cur.duration) && A.formatDuration) tagRow.appendChild(badge('tag-duration', `🕒 ${A.formatDuration(mss.duration * 1000)}`, 'Length'));

      if (d.h && d.h.length) tagRow.appendChild(toggle('headers', `🔐 ${d.h.length} header${d.h.length === 1 ? '' : 's'}`, 'Request headers the page sent for this link (Origin, Cookie, Authorization, tokens, ...), with commands that send them too'));
      const dash = probe.dash;
      if (dash && dash.tracks && dash.tracks.some((t) => t.url || t.segs > 0)) tagRow.appendChild(toggle('dash', `🎚 ${dash.tracks.length} DASH track${dash.tracks.length === 1 ? '' : 's'}`, 'Each DASH track with its own address: its file, or an .m3u8 of its segments for ffmpeg'));
      if (mss && mss.variants && mss.variants.items && mss.variants.items.length) tagRow.appendChild(toggle('mss', `📶 ${mss.variants.items.length} tracks`, 'Qualities and tracks this manifest lists'));
      if (hasMore(d)) tagRow.appendChild(toggle('more', '🧰 More', 'How this link was requested, and what its playlist offers besides the video (trick-play, thumbnails, session data, CDN steering)'));
    }

    // ---- panels (under the tags, above the buttons), rebuilt from the latest data whenever the card is drawn
    function panels() {
      const builders = { headers: headersPanel, dash: dashPanel, mss: mssPanel, more: morePanel };
      Object.keys(builders).forEach((name) => {
        const rows = isOpen(name) ? safe(() => builders[name](), []) : [];
        if (!rows.length) {
          if (boxes[name]) { boxes[name].remove(); delete boxes[name]; }
          return;
        }
        if (!boxes[name]) boxes[name] = el('div', 'variants-box x3-box');
        boxes[name].replaceChildren(...rows);
        if (!boxes[name].isConnected) ctx.actionsBar.before(boxes[name]);
      });
    }

    const row = (label, meta, metaTitle, ...buttons) => {
      const r = el('div', 'variant-row');
      r.append(el('span', 'variant-label', label), el('span', 'variant-meta', meta || '', metaTitle || meta || ''), ...buttons.filter(Boolean));
      return r;
    };
    const button = (cls, text, title, onClick) => {
      const b = el('button', `action-btn ${cls}`, text, title);
      b.addEventListener('click', () => onClick(b));
      return b;
    };
    const copy = (text, title, value) => button(text === 'Copy' ? 'btn-copy' : 'btn-piped', text, title, (b) => {
      navigator.clipboard.writeText(value()).then(() => A.triggerCopied(b, text === 'Copy' ? '✓ URL' : '✓ Copied'));
    });
    // Copy / + Ref / + Name for another address of this card (same formats, this card's Referer and name)
    const linkButtons = (u) => [
      copy('Copy', 'Copy this URL', () => u),
      copy('+ Ref', 'Copy this URL and Referer (URL|Ref)', () => { const r = ctx.refererOf(); return r ? `${u}|${r}` : u; }),
      copy('+ Name', 'Copy this URL, Referer and video name (URL|Ref|Name)', () => `${u}|${ctx.refererOf() || ''}|${A.getVideoName(url)}`)
    ];

    // Module 12: the request headers, and commands that send them
    function headersPanel() {
      const h = data().h || [];
      if (!h.length) return [];
      const rows = h.map(([n, v]) => {
        const secret = SECRET.test(n);
        const shown = secret ? `${String(v).slice(0, 10)}… (${String(v).length} characters)` : String(v);
        return row(n, shown.length > 160 ? `${shown.slice(0, 160)}…` : shown, secret ? 'Hidden here; the commands below include it' : shown);
      });
      const list = () => {
        const out = [];
        const referer = ctx.refererOf();
        if (referer) out.push(['Referer', referer]);
        h.forEach((x) => out.push(x));
        return out;
      };
      const q = (s) => A.shellSafeUrl(s);
      const fileName = () => A.shellSafeName(A.getCleanFilename(url, ctx.typeInfo.ext || 'mp4'));
      rows.push(row('Copy with headers', '', '',
        button('btn-ytdlp', 'yt-dlp', 'Copy a yt-dlp command that sends these headers (and the Referer)', (b) => {
          const cmd = `yt-dlp ${list().map(([n, v]) => `--add-header "${q(n)}: ${q(v)}"`).join(' ')} "${q(url)}"`;
          navigator.clipboard.writeText(cmd).then(() => A.triggerCopied(b, '✓ Cmd'));
        }),
        button('btn-piped', 'curl', 'Copy a curl command that sends these headers (and the Referer)', (b) => {
          const cmd = `curl -L ${list().map(([n, v]) => `-H "${q(n)}: ${q(v)}"`).join(' ')} -o "${fileName()}" "${q(url)}"`;
          navigator.clipboard.writeText(cmd).then(() => A.triggerCopied(b, '✓ Cmd'));
        }),
        copy('Headers', 'Copy the headers as "Name: value" lines', () => list().map(([n, v]) => `${n}: ${v}`).join('\n'))
      ));
      if (h.some(([n]) => SECRET.test(n))) rows.push(el('div', 'x3-note', 'The copied commands carry the page\'s cookies / tokens: keep them private. They usually expire with your login session.'));
      return rows;
    }

    // Module 20: DASH tracks with their own address
    const trackLabel = (t) => {
      const tags = (t.tags || []).filter(NOTABLE).join(' ');
      let parts;
      if (t.kind === 'audio') parts = ['Audio', t.language, kbps(t.bandwidth)];
      else if (t.kind === 'subtitle') parts = ['Subtitles', t.language || t.id];
      else parts = [t.height ? `${t.height}p` : (t.width ? `${t.width} wide` : 'Video'), t.fps ? `${t.fps} fps` : '', kbps(t.bandwidth)];
      return [...parts, tags].filter(Boolean).join(' · ');
    };
    function dashPanel() {
      const dash = (data().probe || {}).dash;
      if (!dash || !dash.tracks) return [];
      if (dash.live) return [el('div', 'x3-note', 'Live DASH stream: its segments are numbered by the clock, so there is no fixed list to export. Use yt-dlp / ffmpeg on the manifest itself.')];
      const cur = ctx.latest();
      const rows = [];
      const order = { video: 0, audio: 1, subtitle: 2 };
      dash.tracks.map((t, i) => ({ t, i })).sort((a, b) => (order[a.t.kind] - order[b.t.kind]) || (b.t.height - a.t.height) || (b.t.bandwidth - a.t.bandwidth)).forEach(({ t, i }) => {
        if (t.url) { rows.push(row(trackLabel(t), t.codecs || t.language, t.url, ...linkButtons(t.url))); return; }
        if (!(t.segs > 0)) { rows.push(row(trackLabel(t), t.codecs || t.language, 'This track\'s segments could not be listed')); return; }
        const base = A.getCleanFilename(url, 'm3u8').replace(/\.[a-z0-9]{1,5}$/i, '');
        const suffix = t.kind === 'video' ? `${t.height || t.width || 'video'}p` : (t.kind === 'audio' ? `audio${t.language ? `-${t.language}` : ''}${t.bandwidth ? `-${Math.round(t.bandwidth / 1000)}k` : ''}` : `subs-${t.language || t.id}`);
        const name = A.shellSafeName(`${base}-${suffix}`.replace(/[\\/:*?"<>|]+/g, '_')) + '.m3u8';
        const out = name.replace(/\.m3u8$/i, '') + (t.kind === 'audio' ? '.m4a' : '.mp4');
        const ffmpeg = `ffmpeg -protocol_whitelist file,http,https,tcp,tls,crypto -allowed_extensions ALL -i "${name}" -c copy "${out}"`;
        rows.push(row(trackLabel(t), `${t.segs} segments${t.codecs ? ` · ${t.codecs}` : ''}`, '',
          button('btn-download', '⬇ .m3u8', 'Export an .m3u8 listing this track\'s init segment and every piece, in order (open it with ffmpeg)', (b) => {
            chrome.runtime.sendMessage({ action: 'x3DashTrack', tabId: A.tabId(), url: url, index: i, comment: `${t.kind} track ${trackLabel(t)}\n${ffmpeg}` }, (res) => {
              if (chrome.runtime.lastError || !res || !res.text) { A.triggerCopied(b, `⚠️ ${(res && res.error) || 'Failed'}`); return; }
              A.downloadBlob(res.text, name, 'application/vnd.apple.mpegurl');
              A.triggerCopied(b, '✓ Playlist');
            });
          }),
          button('btn-ytdlp', 'ffmpeg', 'Copy the ffmpeg command that joins the exported .m3u8 into one file', (b) => {
            navigator.clipboard.writeText(ffmpeg).then(() => A.triggerCopied(b, '✓ Cmd'));
          })
        ));
      });
      if (cur && cur.drm && cur.drm.type === 'drm') rows.push(el('div', 'x3-note', '🔒 These tracks are encrypted (DRM): the joined file stays encrypted.'));
      return rows;
    }

    // Module 15: qualities of a Smooth Streaming / HDS manifest
    function mssPanel() {
      const mss = (data().probe || {}).mss;
      const items = mss && mss.variants && mss.variants.items;
      if (!items || !items.length) return [];
      const order = { video: 0, audio: 1, subtitle: 2 };
      return items.slice().sort((a, b) => ((order[a.kind] || 0) - (order[b.kind] || 0)) || (b.height - a.height) || (b.bandwidth - a.bandwidth)).map((v) => {
        const tags = P ? P.techTags(v.codecs).filter(NOTABLE).join(' ') : '';
        const name = v.language || (/^(?:audio|video|text|subtitles?)$/i.test(v.name || '') ? '' : v.name); // not the stream's internal name
        const label = v.kind === 'audio' ? ['Audio', name, kbps(v.bandwidth)] : (v.kind === 'subtitle' ? ['Subtitles', name] : [v.height ? `${v.height}p` : 'Video', kbps(v.bandwidth)]);
        return row([...label, tags].filter(Boolean).join(' · '), v.codecs || v.language);
      });
    }

    // Modules 19 + 22: request details, trick-play / thumbnail playlists, session data, steering, ad breaks
    function hasMore(d) {
      const p = d.probe || {};
      return !!(d.r || (p.iframes && p.iframes.length) || (p.images && p.images.length) || (p.session && p.session.length) || p.steering || (p.dash && p.dash.thumbs && p.dash.thumbs.length));
    }
    function morePanel() {
      const d = data();
      const p = d.probe || {};
      const rows = [];
      const r = d.r;
      if (r) {
        const when = r.at ? new Date(r.at).toLocaleTimeString() : '';
        rows.push(row('First request', [when, r.type, r.method, r.status ? `HTTP ${r.status}` : '', r.ip, r.ctype, r.clen > 0 ? `${r.clen} bytes` : ''].filter(Boolean).join(' · ')));
        if (r.frameId > 0 && r.frameUrl) rows.push(row('In frame', r.frameUrl, r.frameUrl));
        if (r.initiator) rows.push(row('Requested by', r.initiator, r.initiator));
      }
      (p.iframes || []).forEach((f) => rows.push(row(`I-frames ${f.height ? `${f.height}p` : ''}${f.bandwidth ? ` · ${kbps(f.bandwidth)}` : ''}`.trim(), f.codecs, f.url, ...linkButtons(f.url))));
      (p.images || []).forEach((f) => rows.push(row(`Thumbnails ${f.resolution || ''}`.trim(), f.url, f.url, copy('Copy', 'Copy this URL', () => f.url))));
      ((p.dash && p.dash.thumbs) || []).forEach((f) => rows.push(row(`Thumbnails ${f.w && f.h ? `${f.w}x${f.h}` : ''}`.trim(), f.url, 'Image tiles; $Number$ in the address counts them', copy('Copy', 'Copy this URL template', () => f.url))));
      (p.session || []).forEach((s) => rows.push(row(`Session data`, `${s.id}${s.value ? ` = ${s.value}` : ''}${s.uri ? ` → ${s.uri}` : ''}`, '', s.uri ? copy('Copy', 'Copy this URL', () => s.uri) : null)));
      if (p.steering) {
        rows.push(row('Content steering', p.steering.uri, p.steering.uri, copy('Copy', 'Copy the steering server URL', () => p.steering.uri)));
        if (p.pathways && p.pathways.length) rows.push(row('CDN pathways', p.pathways.join(', ')));
      }
      return rows;
    }

    // Module 18: formats of each quality in the 📶 list (display only)
    function variantRow(labelEl, v) {
      const p = data().probe || {};
      const notes = [];
      if (P && v && v.codecs) P.techTags(v.codecs).filter(NOTABLE).forEach((t) => notes.push(t));
      const vt = p.vt && v && p.vt[v.url];
      if (vt) vt.split(' · ').forEach((t) => { if (!notes.includes(t)) notes.push(t); });
      if (notes.length) {
        const suffix = ` · ${Array.from(new Set(notes)).join(' ')}`;
        labelEl.textContent += suffix;
        labelEl.dataset.x3suffix = suffix;
      }
    }

    // Module 21: 🔍 Resolve on the cards of embedded players whose service can be asked
    if (ctx.typeInfo && ctx.typeInfo.isEmbed && RESOLVABLE.some((re) => re.test(url))) {
      ctx.actionsBar.appendChild(button('btn-piped', '🔍 Resolve', 'Ask the player\'s own service for its streams (one request, with this page as Referer); they are listed as new links', (b) => {
        b.disabled = true;
        chrome.runtime.sendMessage({ action: 'x3Resolve', tabId: A.tabId(), url: url }, (res) => {
          b.disabled = false;
          if (chrome.runtime.lastError || !res) { A.triggerCopied(b, '⚠️ Failed'); return; }
          if (res.error) { b.title = res.error; A.triggerCopied(b, '⚠️ No answer'); return; }
          A.triggerCopied(b, res.added ? `✓ ${res.added} new` : (res.found ? '✓ Listed already' : '⚠️ None found'));
        });
      }));
    }

    return { tags, panels, variantRow };
  }

  // =============================================================================================
  // Modules 13, 14, 21: page-level banner (live transports that are no file, oEmbed)
  // =============================================================================================
  let banner = null;
  function renderBanner() {
    if (!A) return;
    if (!banner) {
      banner = el('div', 'x3-banner');
      const anchor = A.drmBanner || document.getElementById('links-container');
      if (!anchor || !anchor.parentNode) return;
      anchor.parentNode.insertBefore(banner, A.drmBanner ? anchor.nextSibling : anchor);
    }
    const rows = [];
    const p = page || {};
    const line = (text, title, ...extra) => {
      const r = el('div', 'x3-row');
      r.append(el('span', 'x3-what', text, title), ...extra.filter(Boolean));
      return r;
    };
    const urlEl = (u) => el('span', 'x3-url', u, u);
    const copyBtn = (u, ref) => {
      const b = el('button', 'action-btn btn-copy', ref ? '+ Ref' : 'Copy', ref ? 'Copy URL|Referer' : 'Copy URL');
      b.addEventListener('click', () => navigator.clipboard.writeText(ref ? `${u}|${A.pageUrl()}` : u).then(() => A.triggerCopied(b, ref ? '✓ Copied' : '✓ URL')));
      return b;
    };
    (p.rtc || []).forEach((c) => {
      const tracks = [c.video ? `${c.video} video` : '', c.audio ? `${c.audio} audio` : ''].filter(Boolean).join(' + ');
      rows.push(line(`📡 WebRTC live: ${tracks} track${c.video + c.audio === 1 ? '' : 's'}${c.codecs && c.codecs.length ? ` · ${c.codecs.join(', ')}` : ''}${c.ice && c.ice.length ? ` · via ${c.ice.join(', ')}` : ''}${c.state ? ` · ${c.state}` : ''}`,
        'Real-time media over WebRTC: there is no file or playlist to download. Record it with a screen / stream capture tool, or play its WHEP endpoint (if listed) in a WHEP client (OBS, GStreamer whepsrc).'));
    });
    (p.sig || []).forEach((s) => rows.push(line(`${s.kind === 'whip' ? '📤 WHIP' : '📥 WHEP'} endpoint`, s.kind === 'whip' ? 'Where the page publishes its WebRTC stream' : 'Where the page fetches its WebRTC stream: a WHEP client can play it', urlEl(s.url), copyBtn(s.url), copyBtn(s.url, true))));
    (p.ws || []).forEach((w) => rows.push(line(`🔌 ${w.format} over WebSocket`, 'The player receives this stream as WebSocket messages, not as a file / playlist: a WebSocket client can save the messages', urlEl(w.url), copyBtn(w.url))));
    (p.wt || []).forEach((w) => rows.push(line('🚀 WebTransport', 'The page opened a WebTransport (HTTP/3) session: media may arrive there, outside any request the extension can list', urlEl(w.url), copyBtn(w.url))));
    if (p.codecs && p.codecs.length) {
      const text = p.codecs.map((c) => (c.kind === 'video' ? `${c.codec}${c.w && c.h ? ` ${c.w}×${c.h}` : ''}` : `${c.codec}${c.rate ? ` ${Math.round(c.rate / 100) / 10} kHz` : ''}${c.ch ? ` ${c.ch} ch` : ''}`)).join(' · ');
      rows.push(line(`🧮 WebCodecs player: ${text}`, 'The page decodes media itself (WebCodecs) instead of handing a stream to the browser\'s player: its source may be a WebSocket / WebTransport session listed here'));
    }
    (p.oembed || []).forEach((o) => {
      const b = el('button', 'action-btn btn-piped', '🔍 Resolve', 'Ask the page\'s oEmbed description for its player (one request), then that player\'s service for its streams');
      b.addEventListener('click', () => {
        b.disabled = true;
        chrome.runtime.sendMessage({ action: 'x3Oembed', tabId: A.tabId(), url: o.url }, (res) => {
          b.disabled = false;
          if (chrome.runtime.lastError || !res || res.error) { A.triggerCopied(b, '⚠️ No answer'); return; }
          A.triggerCopied(b, res.added ? `✓ ${res.added} new` : (res.player ? '✓ Listed already' : '⚠️ No player'));
        });
      });
      rows.push(line(`🧾 oEmbed${o.title ? `: ${o.title}` : ''}`, 'This page describes its video in an oEmbed document (often while the player is only a picture with a play button)', urlEl(o.url), b));
    });
    banner.replaceChildren(...rows);
    banner.style.display = rows.length ? 'flex' : 'none';
  }

  // =============================================================================================
  // Exports: extra JSON fields, HAR
  // =============================================================================================
  function exportFields(item) {
    const url = typeof item === 'string' ? item : (item && item.url);
    const d = info.get(url);
    const out = {};
    const source = item && item.addon && item.addon.source;
    if (BADGES[source]) out.foundBy = source;
    if (!d) return out;
    const p = d.probe || {};
    if (d.h && d.h.length) {
      out.requestHeaders = Object.fromEntries(d.h.filter(([n]) => !SECRET.test(n)));
      const left = d.h.filter(([n]) => SECRET.test(n)).map(([n]) => n);
      if (left.length) out.secretHeadersLeftOut = left;
    }
    if (d.r) {
      out.firstRequest = {
        at: d.r.at ? new Date(d.r.at).toISOString() : null, type: d.r.type || null, method: d.r.method || null, status: d.r.status || null,
        serverIp: d.r.ip || null, contentType: d.r.ctype || null, frameUrl: d.r.frameId > 0 ? (d.r.frameUrl || null) : null, initiator: d.r.initiator || null
      };
    }
    if (d.ad || p.ad) out.ad = { file: d.ad || null, breaks: p.ad || null };
    if (p.tech && p.tech.length) out.formats = p.tech;
    if (d.radio) out.radio = d.radio;
    if (p.dash && p.dash.tracks) out.dashTracks = p.dash.tracks.map((t) => ({ kind: t.kind, width: t.width, height: t.height, bandwidth: t.bandwidth, codecs: t.codecs, language: t.language, url: t.url || null, segments: t.segs || 0 }));
    return out;
  }

  // HAR 1.2 of the selected links: one entry per link with the request the page made for it (cookies, Authorization
  // and token headers left out, as browsers' "sanitized" HAR exports do)
  function buildHar(selected) {
    const version = safe(() => chrome.runtime.getManifest().version, '');
    const pageUrl = safe(() => A.pageUrl(), '');
    const started = new Date().toISOString();
    const entries = selected.map((item) => {
      const url = typeof item === 'string' ? item : item.url;
      const d = info.get(url) || {};
      const r = d.r || {};
      const referer = (item && item.referer) || pageUrl;
      const headers = [];
      if (referer) headers.push({ name: 'Referer', value: referer });
      (d.h || []).filter(([n]) => !SECRET.test(n)).forEach(([n, v]) => headers.push({ name: n, value: v }));
      let query = [];
      try { query = Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({ name, value })); } catch (e) {}
      const size = safe(() => A.getMediaSize(item), 0) || r.clen || 0;
      const respHeaders = [];
      if (r.ctype) respHeaders.push({ name: 'Content-Type', value: r.ctype });
      if (r.clen) respHeaders.push({ name: 'Content-Length', value: String(r.clen) });
      const entry = {
        pageref: 'page_1',
        startedDateTime: new Date(r.at || (item && item.timestamp) || Date.now()).toISOString(),
        time: 0,
        request: { method: r.method || 'GET', url: url, httpVersion: '', cookies: [], headers: headers, queryString: query, headersSize: -1, bodySize: 0 },
        response: { status: r.status || 0, statusText: '', httpVersion: '', cookies: [], headers: respHeaders, content: { size: size, mimeType: r.ctype || '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 }
      };
      if (r.ip) entry.serverIPAddress = r.ip;
      if (r.type) entry._resourceType = r.type;
      if (r.initiator) entry._initiator = r.initiator;
      const title = safe(() => A.cardTitleFor(url), '');
      if (title) entry.comment = title;
      return entry;
    });
    return {
      log: {
        version: '1.2',
        creator: { name: 'Video Link Extractor Pro', version: version },
        pages: [{ startedDateTime: started, id: 'page_1', title: pageUrl, pageTimings: {} }],
        entries: entries
      }
    };
  }

  function injectExport() {
    const menu = A.exportMenu;
    if (!menu || document.getElementById('exportHar')) return;
    const item = el('a', 'dropdown-item', '🧾 HAR (.har)', 'HAR file of the selected links: the request the page made for each (method, headers, status, server). Cookies and tokens are left out.');
    item.id = 'exportHar';
    item.addEventListener('click', () => {
      const selected = safe(() => A.getSelectedLinks(), []);
      if (!selected.length) { A.triggerCopied(A.exportDropdownBtn, '⚠️ 0 Selected'); return; }
      A.downloadBlob(JSON.stringify(buildHar(selected), null, 2), `media-links-${Date.now()}.har`, 'application/json');
      A.triggerCopied(A.exportDropdownBtn, `✓ Exported (${selected.length})`);
    });
    menu.appendChild(item);
  }

  function injectStyle() {
    if (document.getElementById('x3Style')) return;
    const s = document.createElement('style');
    s.id = 'x3Style';
    s.textContent = `
      .x3-tag { background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.35); color: var(--text-main); text-transform: none; }
      .x3-ad { background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.45); color: #f59e0b; text-transform: none; }
      .x3-note { font-size: 9.5px; color: var(--text-dim); padding: 1px 2px; }
      .x3-box .variant-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .x3-banner { display: none; flex-direction: column; gap: 4px; margin: 0 0 8px; padding: 7px 10px; border-radius: 8px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.35); font-size: 11px; color: var(--text-main); }
      .x3-banner .x3-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .x3-banner .x3-what { white-space: nowrap; font-weight: 600; }
      .x3-banner .x3-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      .x3-banner .action-btn { padding: 1px 6px; font-size: 9.5px; }
    `;
    document.head.appendChild(s);
  }

  function init(api) {
    A = api;
    safe(injectStyle);
    safe(injectExport);
    // the worker learnt something new about this tab's links, or the list changed
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'session') return;
        const tabId = safe(() => A.tabId(), undefined);
        if (tabId === undefined) return;
        if (changes[`x3_tab_${tabId}`] || Object.keys(changes).some((k) => k.startsWith('x3_probe')) || changes[`tab_videos_${tabId}`]) scheduleRequest(400);
      });
    } catch (e) {}
    scheduleRequest(300);
  }

  window.__VLE_X3_POPUP__ = Object.freeze({ init, mediaType, card, exportFields });
})();
