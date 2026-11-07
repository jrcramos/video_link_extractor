document.addEventListener('DOMContentLoaded', () => {
  const linksContainer = document.getElementById('links-container');
  const statusEl = document.getElementById('status');
  const clearButton = document.getElementById('clearButton');
  const copyAllButton = document.getElementById('copyAllButton');
  const copyCount = document.getElementById('copyCount');
  const countBadge = document.getElementById('countBadge');
  const mobileScanBtn = document.getElementById('mobileScanBtn');
  const mobileModeSelect = document.getElementById('mobileModeSelect');
  const themeSelect = document.getElementById('themeSelect');

  // Search, Sort & Selection elements
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const sortSelect = document.getElementById('sortSelect');
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const selectAllText = document.getElementById('selectAllText');
  const filterPills = document.querySelectorAll('.filter-pill');
  const filterAllCount = document.getElementById('filterAllCount');
  const filterStreamCount = document.getElementById('filterStreamCount');
  const filterVideoCount = document.getElementById('filterVideoCount');
  const filterAudioCount = document.getElementById('filterAudioCount');
  const filterSubtitleCount = document.getElementById('filterSubtitleCount');
  const filterDrmCount = document.getElementById('filterDrmCount');
  const filterShortCount = document.getElementById('filterShortCount');
  const filterEmbedCount = document.getElementById('filterEmbedCount');
  const bestOnlyToggle = document.getElementById('bestOnlyToggle');
  const drmBanner = document.getElementById('drmBanner');

  // Export elements
  const exportDropdownBtn = document.getElementById('exportDropdownBtn');
  const exportCount = document.getElementById('exportCount');
  const exportMenu = document.getElementById('exportMenu');
  const exportYtdlpTxt = document.getElementById('exportYtdlpTxt');
  const exportM3u = document.getElementById('exportM3u');
  const exportJson = document.getElementById('exportJson');

  // QR Modal elements
  const qrModal = document.getElementById('qrModal');
  const qrModalTitle = document.getElementById('qrModalTitle');
  const qrCanvasContainer = document.getElementById('qrCanvasContainer');
  const qrCloseBtn = document.getElementById('qrCloseBtn');
  
  let currentTabId;
  let currentLinks = [];
  let currentPageUrl = '';
  let currentPageTitle = '';
  let currentVideoName = ''; // name read from the page's metadata (og:title, JSON-LD, ...)
  let activeFilter = 'all';
  let searchQuery = '';
  let currentSortMode = 'quality'; // Default: Highest Quality First
  const selectedUrls = new Set(); // Stores explicitly selected URLs (all selected by default)
  const seenUrls = new Set(); // URLs already listed once in this popup (auto-selected only the first time)
  const activeHlsPlayers = new Map(); // cardId -> Hls instance
  let currentTabDrm = null; // page-level DRM evidence from the background worker (EME usage, DRM manifests, ...)
  const drmProbed = new Set(); // link URLs already checked for DRM during this popup session
  const segmentedByUrl = new Map(); // entry url -> segmented-stream description (see background applySegmentedSignal)
  const itemByUrl = new Map(); // entry url -> its latest data (buttons read it when clicked, so live updates count)
  const addonByUrl = new Map(); // entry url -> what an add-on detection module found out about it (see addon-*.js)
  const variantsByUrl = new Map(); // master playlist / MPD url -> { type, items }: the qualities it lists
  const variantOf = new Map(); // a quality's own playlist url -> { variant, masterUrl }
  const cardRefs = new Map(); // entry url -> { card, refresh(item), destroy() } for the cards on screen
  const expandedVariants = new Set(); // cards whose quality list is open
  const probedSizes = new Map(); // url -> size from the HEAD probe (0 = unknown), so each link is probed once
  let cardSeq = 0;
  let currentSiteName = '';
  // Names the page gives particular videos (structured data, element labels, captions, link text), by URL
  let pageMediaNames = { exact: new Map(), byPath: new Map() };
  let topMediaNames = [];
  let frameMediaNames = [];
  let topSessionNames = []; // add-on (module 11): media-session names, see buildMediaNames
  let frameSessionNames = [];

  // "⭐ Best only" switch, remembered between popups (off by default)
  function initBestOnly() {
    if (!bestOnlyToggle) return;
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ [BEST_ONLY_KEY]: false }, (res) => {
        if (res && res[BEST_ONLY_KEY]) {
          setBestOnly(true);
          if (currentLinks.length) scheduleRelayout();
        }
      });
    }
    bestOnlyToggle.addEventListener('change', () => {
      setBestOnly(bestOnlyToggle.checked);
      if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ [BEST_ONLY_KEY]: bestOnly });
      applyLiveLinks(currentLinks.slice()); // re-ticks / unticks the cards on screen without rebuilding them
    });
  }

  // Theme Management
  function initTheme() {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ theme: 'midnight' }, (res) => {
        const theme = (res && res.theme) ? res.theme : 'midnight';
        document.body.setAttribute('data-theme', theme);
        if (themeSelect) themeSelect.value = theme;
      });
    }
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        const selected = e.target.value || 'midnight';
        document.body.setAttribute('data-theme', selected);
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ theme: selected });
        }
      });
    }
  }

  // Canonical URL Normalizer (strictly real network streams only)
  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let u = rawUrl.trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (!u.startsWith('http://') && !u.startsWith('https://')) return null;

    if (/\.(ts|m4s|mp2t|seg|m4f)(\?|#|$)/i.test(u)) {
      return null;
    }

    try {
      const parsed = new URL(u);
      const sliceParams = [
        'range', 'rn', 'sq', 'segment', 'seg', 'chunk', 'slice', 
        'part', 'frag', 'fragment', 'rbuf', 'alr', 'keepalive', 
        'sgoap', 'cpn', 'cver', 'bypass_hfr'
      ];
      sliceParams.forEach(p => {
        if (parsed.searchParams.has(p)) {
          parsed.searchParams.delete(p);
        }
      });
      parsed.hash = '';
      return parsed.toString();
    } catch (e) {
      return u;
    }
  }

  // Format file size helper
  function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + ' KB';
    } else if (bytes < 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    } else {
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
  }

  // Helper to extract or estimate exact media size in bytes
  function getMediaSize(item) {
    if (typeof item === 'object' && item.size && item.size > 0) {
      return item.size;
    }
    const url = typeof item === 'string' ? item : (item ? item.url : '');
    if (probedSizes.get(url) > 0) return probedSizes.get(url);
    if (!url || !url.startsWith('http')) return 0;
    try {
      const parsed = new URL(url);
      
      // 1. YouTube / GoogleVideo explicit clen (Content-Length)
      if (parsed.searchParams.has('clen')) {
        const clen = parseInt(parsed.searchParams.get('clen'), 10);
        if (clen > 0) return clen;
      }
      
      // 2. YouTube duration (dur in sec) and bitrate (bps)
      const dur = parseFloat(parsed.searchParams.get('dur') || '0');
      const bitrate = parseInt(parsed.searchParams.get('bitrate') || '0', 10);
      if (dur > 0 && bitrate > 0) {
        return Math.round((bitrate / 8) * dur);
      }
    } catch (e) {}
    return 0;
  }

  // Common format itag resolution lookup table with quality scores
  const ITAG_MAP = {
    // 4K & 60fps Formats
    '315': { label: '2160p60 4K', tagClass: 'quality-tag quality-4k', score: 2160 },
    '313': { label: '4K (2160p)', tagClass: 'quality-tag quality-4k', score: 2160 },
    '401': { label: '4K (2160p) AV1', tagClass: 'quality-tag quality-4k', score: 2160 },
    // 1440p / 2K
    '308': { label: '1440p60 WebM', tagClass: 'quality-tag quality-1080p', score: 1440 },
    '271': { label: '1440p (2K)', tagClass: 'quality-tag quality-1080p', score: 1440 },
    '400': { label: '1440p (2K) AV1', tagClass: 'quality-tag quality-1080p', score: 1440 },
    // 1080p Full HD
    '299': { label: '1080p60 MP4', tagClass: 'quality-tag quality-1080p', score: 1080 },
    '303': { label: '1080p60 WebM', tagClass: 'quality-tag quality-1080p', score: 1080 },
    '137': { label: '1080p Full HD MP4', tagClass: 'quality-tag quality-1080p', score: 1080 },
    '248': { label: '1080p WebM', tagClass: 'quality-tag quality-1080p', score: 1080 },
    '399': { label: '1080p AV1', tagClass: 'quality-tag quality-1080p', score: 1080 },
    // 720p HD
    '22':  { label: '720p HD MP4', tagClass: 'quality-tag quality-720p', score: 720 },
    '298': { label: '720p60 MP4', tagClass: 'quality-tag quality-720p', score: 720 },
    '302': { label: '720p60 WebM', tagClass: 'quality-tag quality-720p', score: 720 },
    '136': { label: '720p HD MP4', tagClass: 'quality-tag quality-720p', score: 720 },
    '247': { label: '720p WebM', tagClass: 'quality-tag quality-720p', score: 720 },
    '398': { label: '720p AV1', tagClass: 'quality-tag quality-720p', score: 720 },
    // 480p
    '135': { label: '480p MP4', tagClass: 'quality-tag', score: 480 },
    '244': { label: '480p WebM', tagClass: 'quality-tag', score: 480 },
    '397': { label: '480p AV1', tagClass: 'quality-tag', score: 480 },
    // 360p
    '18':  { label: '360p MP4', tagClass: 'quality-tag', score: 360 },
    '134': { label: '360p MP4', tagClass: 'quality-tag', score: 360 },
    '243': { label: '360p WebM', tagClass: 'quality-tag', score: 360 },
    '396': { label: '360p AV1', tagClass: 'quality-tag', score: 360 },
    // 240p & 144p
    '133': { label: '240p MP4', tagClass: 'quality-tag', score: 240 },
    '242': { label: '240p WebM', tagClass: 'quality-tag', score: 240 },
    '160': { label: '144p MP4', tagClass: 'quality-tag', score: 144 },
    '278': { label: '144p WebM', tagClass: 'quality-tag', score: 144 },
    // Audio Formats
    '251': { label: '160k Opus Audio', tagClass: 'quality-tag quality-audio', score: 16 },
    '140': { label: '128k AAC Audio', tagClass: 'quality-tag quality-audio', score: 14 },
    '250': { label: '70k Opus Audio', tagClass: 'quality-tag quality-audio', score: 7 },
    '249': { label: '50k Opus Audio', tagClass: 'quality-tag quality-audio', score: 5 },
    '139': { label: '48k AAC Audio', tagClass: 'quality-tag quality-audio', score: 4 }
  };

  // Helper to extract specific resolution or quality badge with score
  function getStreamQuality(url) {
    if (!url || typeof url !== 'string') return { label: 'Video', tagClass: 'quality-tag', score: 100 };
    const seg = segmentedByUrl.get(url);
    if (seg) {
      if (!seg.bitrate && !seg.height) return { label: seg.kind === 'audio' ? 'Audio' : 'Video', tagClass: 'quality-tag', score: seg.kind === 'audio' ? 10 : 100 };
      if (seg.kind === 'audio') {
        const codec = /^mp4a/i.test(seg.codec) ? 'AAC' : (seg.codec || 'Audio');
        return { label: `${Math.round((seg.bitrate || 0) / 1000)}k ${codec}`, tagClass: 'quality-tag quality-audio', score: 10 };
      }
      const h = seg.height || 0;
      return { label: h ? `${h}p` : 'Video', tagClass: h >= 2160 ? 'quality-tag quality-4k' : (h >= 1080 ? 'quality-tag quality-1080p' : (h >= 720 ? 'quality-tag quality-720p' : 'quality-tag')), score: h || 100 };
    }
    // Qualities read from the manifest itself: a master playlist / MPD shows its best one, a quality's own
    // playlist shows its resolution
    const fromManifest = qualityFromVariants(url);
    if (fromManifest) return fromManifest;
    try {
      const parsed = new URL(url);
      const itag = parsed.searchParams.get('itag');
      if (itag && ITAG_MAP[itag]) {
        return ITAG_MAP[itag];
      }
      const pathLower = (parsed.pathname + parsed.search).toLowerCase();
      // "4k" / "2k" only as a word of their own ("_4k.mp4", "/4k/", "res=4k", "4k60"): signed tokens and ids
      // ("sig=a94kd...") contain these letters by chance
      if (pathLower.includes('2160p') || /(?:^|[^a-z0-9])4k(?![a-z])/.test(pathLower)) {
        return { label: '4K (2160p)', tagClass: 'quality-tag quality-4k', score: 2160 };
      }
      if (pathLower.includes('1440p') || /(?:^|[^a-z0-9])2k(?![a-z])/.test(pathLower)) {
        return { label: '1440p (2K)', tagClass: 'quality-tag quality-1080p', score: 1440 };
      }
      if (pathLower.includes('1080p')) {
        return { label: '1080p Full HD', tagClass: 'quality-tag quality-1080p', score: 1080 };
      }
      if (pathLower.includes('720p')) {
        return { label: '720p HD', tagClass: 'quality-tag quality-720p', score: 720 };
      }
      if (pathLower.includes('master.m3u8') || pathLower.includes('master.mpd')) {
        return { label: 'Master Stream', tagClass: 'quality-tag quality-720p', score: 900 };
      }
      if (pathLower.includes('480p')) {
        return { label: '480p', tagClass: 'quality-tag', score: 480 };
      }
      if (pathLower.includes('360p')) {
        return { label: '360p', tagClass: 'quality-tag', score: 360 };
      }
      if (pathLower.includes('240p')) {
        return { label: '240p', tagClass: 'quality-tag', score: 240 };
      }
      if (pathLower.includes('144p')) {
        return { label: '144p', tagClass: 'quality-tag', score: 144 };
      }
    } catch (e) {}

    const typeInfo = getMediaType(url);
    if (typeInfo.category === 'stream') return { label: typeInfo.label, tagClass: 'quality-tag quality-720p', score: 700 };
    if (typeInfo.category === 'audio') return { label: typeInfo.label, tagClass: 'quality-tag quality-audio', score: 10 };
    if (typeInfo.category === 'subtitle') return { label: 'Subtitle Track', tagClass: 'quality-tag tag-subtitle', score: 2 };
    return { label: typeInfo.label, tagClass: 'quality-tag', score: 100 };
  }

  // ---- Add-on: qualities listed in HLS / DASH manifests ----------------------------------------
  const heightClass = (h) => (h >= 2160 ? 'quality-tag quality-4k' : (h >= 1080 ? 'quality-tag quality-1080p' : (h >= 720 ? 'quality-tag quality-720p' : 'quality-tag')));
  const heightLabel = (v) => `${v.height}p${v.fps >= 50 ? Math.round(v.fps) : ''}`;

  function bestVideoVariant(items) {
    return (items || []).filter((v) => v && v.kind === 'video' && v.height > 0)
      .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0] || null;
  }

  function qualityFromVariants(url) {
    const listed = variantsByUrl.get(url);
    if (listed) {
      const best = bestVideoVariant(listed.items);
      return best ? { label: heightLabel(best), tagClass: heightClass(best.height), score: best.height } : null;
    }
    const own = variantOf.get(url);
    if (own && own.variant.kind === 'video' && own.variant.height > 0) {
      return { label: heightLabel(own.variant), tagClass: heightClass(own.variant.height), score: own.variant.height };
    }
    return null;
  }

  // The manifest of a link was read: remember its qualities, and which playlist URL belongs to which master
  function registerVariants(item) {
    if (!item || !item.variants || !Array.isArray(item.variants.items)) return;
    variantsByUrl.set(item.url, item.variants);
    item.variants.items.forEach((v) => {
      const own = v && v.url ? (normalizeUrl(v.url) || v.url) : '';
      if (own && !variantOf.has(own)) variantOf.set(own, { variant: v, masterUrl: item.url });
    });
  }

  function formatBitrate(bps) {
    if (!bps || bps <= 0) return '';
    return bps >= 1000000 ? `${(bps / 1000000).toFixed(1)} Mb/s` : `${Math.round(bps / 1000)} kb/s`;
  }

  // "1080p · 30 fps · 4.5 Mb/s", "Audio · English · 128 kb/s", "Subtitles · Deutsch"
  function variantLabel(v) {
    let parts;
    if (v.kind === 'audio') parts = ['Audio', v.name || v.language, formatBitrate(v.bandwidth)];
    else if (v.kind === 'subtitle') parts = ['Subtitles', v.name || v.language];
    else parts = [v.height ? `${v.height}p` : (v.width ? `${v.width} wide` : 'Video'), v.fps ? `${Math.round(v.fps * 100) / 100} fps` : '', formatBitrate(v.bandwidth)];
    return parts.filter(Boolean).join(' · ');
  }

  // Videos first (best first), then audio, then subtitles
  function sortedVariants(items) {
    const rank = { video: 0, audio: 1, subtitle: 2 };
    return (items || []).slice().sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.height - a.height) || (b.bandwidth - a.bandwidth));
  }

  // ---- Add-on: expiry of signed links ------------------------------------------------------------
  // When a signed link stops working, from the expiry most CDNs put in the URL: expire= / Expires= / exp= (also
  // inside Akamai-style tokens "exp=...~acl=...", in the query or the path) as Unix time, or S3's
  // X-Amz-Date + X-Amz-Expires. 0 when the URL carries none.
  function getExpiry(url) {
    let text = '';
    try {
      const u = new URL(url);
      text = u.pathname + u.search;
      try { text = decodeURIComponent(text); } catch (e) {}
    } catch (e) {
      return 0;
    }
    const amzDate = /[?&]x-amz-date=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/i.exec(text);
    const amzExpires = /[?&]x-amz-expires=(\d{1,7})(?!\d)/i.exec(text);
    if (amzDate && amzExpires) {
      return Date.UTC(+amzDate[1], +amzDate[2] - 1, +amzDate[3], +amzDate[4], +amzDate[5], +amzDate[6]) + Number(amzExpires[1]) * 1000;
    }
    const m = /(?:^|[/?&~=;,_-])(?:expires?|exp|expiry|expiration|expires_at|validto)=(\d{10}|\d{13})(?!\d)/i.exec(text);
    if (!m) return 0;
    const ms = m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000;
    return ms > Date.UTC(2015, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : 0;
  }

  function formatTimeLeft(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${Math.max(1, min)} min`;
    const h = Math.round(ms / 3600000);
    if (h < 48) return `${h} h`;
    return `${Math.round(ms / 86400000)} d`;
  }

  // "⏳ 5 h left" (yellow under an hour), "⌛ Expired"; nothing for links valid for more than 30 days
  function buildExpiryBadge(url) {
    const at = getExpiry(url);
    if (!at) return null;
    const left = at - Date.now();
    if (left > 30 * 86400000) return null;
    const el = document.createElement('span');
    el.className = `type-tag tag-expiry${left <= 0 ? ' tag-expired' : (left < 3600000 ? ' tag-expiring' : '')}`;
    el.textContent = left <= 0 ? '⌛ Expired' : `⏳ ${formatTimeLeft(left)} left`;
    el.title = `Signed link: ${left <= 0 ? 'expired' : 'expires'} ${new Date(at).toLocaleString()}. After that the server refuses it, so download it before then, or reload the page for a fresh link.`;
    return el;
  }

  // ---- Add-on detection modules: badge for the links they found -------------------------------
  const ADDON_BADGES = {
    content: ['🔎 By content', 'Recognised as a playlist by its content: neither its URL nor the server said so'],
    page: ['🔗 On page', 'The page points at this file but has not loaded it (yet)'],
    worker: ['⚙ Service worker', 'Requested by the site\'s service worker (Chrome reports those requests without a tab)'],
    mse: ['🧪 Player buffer', 'Traced through the video player: these are the pieces it fed the browser, in order, whatever their URLs look like'],
    // the newer add-on modules (addon2-*.js)
    hidden: ['🔓 Hidden link', 'Found where the other detectors do not look or cannot read it: an escaped, percent-encoded or base64 URL, one relative to the page in the player settings, a script they skip, or a format they do not list'],
    player: ['🎞 Player list', 'Read from the video player on the page (its playlist / sources), including items it has not loaded yet'],
    blob: ['🧪 Blob source', 'The player downloaded this whole file and plays it from memory (a blob: URL): this is the address it came from'],
    webaudio: ['🎚 Web Audio', 'Decoded by the page\'s Web Audio player: this is the address the sound came from'],
    frame: ['🪟 Blank frame', 'Found inside a frame with no address of its own (about:blank, srcdoc, blob:), which the other detectors do not enter'],
    message: ['📡 Message', 'Named in a message the page received (WebSocket, frame or worker message, server event)']
  };
  const PAGE_VIA = {
    link: 'A link on the page points at this file; the page has not loaded it.',
    meta: 'The page names this file in its og:video / og:audio / player tags.',
    attr: 'A player on the page keeps this URL in its settings (data-* attribute), e.g. until you press play.',
    frame: 'A frame or object on the page shows this file.'
  };
  function buildAddonBadge(item) {
    const addon = item && item.addon;
    const spec = addon && addon.source && ADDON_BADGES[addon.source];
    if (!spec) return null;
    const el = document.createElement('span');
    el.className = 'type-tag tag-addon';
    el.textContent = spec[0];
    el.title = (addon.source === 'page' && PAGE_VIA[addon.pageVia]) || spec[1];
    return el;
  }

  // ---- Add-on: duration, short clips ----------------------------------------------------------
  // Length in seconds: read from the manifest / file header by the background worker, a segmented stream's
  // manifest, or YouTube-style dur= in the URL. 0 = unknown.
  function getDurationSec(item) {
    if (!item || typeof item !== 'object') return 0;
    if (item.duration > 0) return item.duration;
    if (item.segmented && item.segmented.endMs > 0) return item.segmented.endMs / 1000;
    try {
      const d = parseFloat(new URL(item.url).searchParams.get('dur') || '0');
      if (d > 0) return d;
    } catch (e) {}
    return 0;
  }

  // Short audio / video (UI sounds, previews, ad clips): up to a minute long, or, when the length is unknown, a
  // file under 500 KB. They get their own filter tab instead of the Videos / Audio ones.
  const SHORT_MAX_SEC = 60;
  const SHORT_MAX_BYTES = 500 * 1024;
  function isShortClip(item) {
    if (!item || typeof item !== 'object' || item.live) return false;
    const t = getMediaType(item.url);
    if (t.category !== 'video' && t.category !== 'audio') return false;
    const d = getDurationSec(item);
    if (d > 0) return d <= SHORT_MAX_SEC;
    const size = getMediaSize(item);
    return !t.isSegmented && size > 0 && size < SHORT_MAX_BYTES;
  }

  // Filter tab of a link: its media category, or 'short'
  function filterCategory(item) {
    const url = typeof item === 'string' ? item : item.url;
    return isShortClip(item) ? 'short' : getMediaType(url).category;
  }

  // ---- Add-on: best quality only -----------------------------------------------------------------
  // Links that are qualities of one video: a master playlist and its quality playlists, YouTube itags of one id
  // (video and audio apart), or files whose names / folders differ only by a quality (clip_720p.mp4,
  // clip_1080p.mp4, /720/clip.mp4). '' = not part of such a group.
  const QUALITY_TOKEN = /(^|[/_.-])(?:\d{3,4}p\d{0,2}|[248]k|uhd|fhd|hd|sd|high|low|mobile)(?=[/_.-]|$)/g;
  const HEIGHT_FOLDER = /\/(?:144|240|360|480|540|576|720|1080|1440|2160|4320)(?=\/)/g;
  function qualityGroupKey(item) {
    const url = item.url;
    const t = getMediaType(url);
    if (t.category === 'subtitle' || t.category === 'embed') return '';
    const own = variantOf.get(url);
    if (own) return `m:${own.masterUrl}`;
    if (variantsByUrl.has(url)) return `m:${url}`;
    let u;
    try { u = new URL(url); } catch (e) { return ''; }
    const kind = t.category === 'audio' ? 'a' : 'v';
    if (/\/videoplayback$/.test(u.pathname) && u.searchParams.get('id')) {
      const mime = (u.searchParams.get('mime') || '').toLowerCase();
      return `yt:${u.host}:${u.searchParams.get('id')}:${mime.startsWith('audio') ? 'a' : kind}`;
    }
    const path = u.pathname.toLowerCase();
    const stripped = path.replace(QUALITY_TOKEN, '$1~').replace(HEIGHT_FOLDER, '/~');
    return stripped === path ? '' : `f:${u.origin}${stripped}:${kind}`;
  }

  // Ranking inside a group: quality score, then size; a master playlist beats its own quality playlists.
  function qualityRank(item) {
    const q = getStreamQuality(item.url);
    let score = q ? q.score : 0;
    if (score === 100 || score === 700) { // no resolution in the URL: a height folder ("/1080/") still tells
      const folder = /\/(144|240|360|480|540|576|720|1080|1440|2160|4320)\//.exec(item.url);
      if (folder) score = Number(folder[1]);
    }
    return { score: score + (variantsByUrl.has(item.url) ? 0.5 : 0), size: getMediaSize(item) };
  }

  // Best only: in each group, unticks everything but the best quality. Only touches links it unticked itself
  // and never a box the user set by hand; turning it off ticks those again. A group whose best cannot be told
  // (same quality, sizes unknown) is left alone.
  const BEST_ONLY_KEY = 'bestOnly';
  let bestOnly = false;
  const autoUnticked = new Set();
  const userTouched = new Set();
  function applyBestOnly() {
    if (!bestOnly) return;
    const groups = new Map();
    currentLinks.forEach((item) => {
      const key = qualityGroupKey(item);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    groups.forEach((members) => {
      if (members.length < 2) return;
      const ranked = members.map((item) => ({ item, r: qualityRank(item) }))
        .sort((a, b) => (b.r.score - a.r.score) || (b.r.size - a.r.size));
      const [first, second] = ranked;
      if (first.r.score === second.r.score && (!first.r.size || !second.r.size || first.r.size === second.r.size)) return;
      ranked.forEach(({ item }, i) => {
        if (userTouched.has(item.url)) return;
        if (i === 0) {
          if (autoUnticked.delete(item.url)) selectedUrls.add(item.url);
        } else if (selectedUrls.has(item.url)) {
          selectedUrls.delete(item.url);
          autoUnticked.add(item.url);
        }
      });
    });
  }

  function setBestOnly(on) {
    bestOnly = !!on;
    if (bestOnlyToggle) bestOnlyToggle.checked = bestOnly;
    if (bestOnly) applyBestOnly();
    else {
      autoUnticked.forEach((u) => selectedUrls.add(u));
      autoUnticked.clear();
    }
  }

  // Helper to categorize media type & identify category key
  function getMediaType(url) {
    // Add-on: DRM-protected files (e.g. Spotify's encrypted podcast audio) have no recognizable extension
    const drmInfo = window.__VLE_DRM__ ? window.__VLE_DRM__.info(url) : null;
    if (drmInfo && drmInfo.kind === 'audio') {
      return { category: 'audio', label: 'Audio', tagClass: 'tag-audio', isAudio: true, isDrm: true, drmProvider: drmInfo.provider, ext: drmInfo.ext, icon: '🎵' };
    }
    // Add-on: one stream delivered as many small requests (Spotify's player), grouped into a single entry
    const segMeta = segmentedByUrl.get(url);
    if (segMeta || (window.__VLE_DRM__ && window.__VLE_DRM__.segmentInfo(url))) {
      const audio = !!segMeta && segMeta.kind === 'audio';
      return { category: audio ? 'audio' : 'video', label: audio ? 'Audio' : 'Video', tagClass: audio ? 'tag-audio' : 'tag-video', isAudio: audio, isVideo: !audio, isSegmented: true, ext: audio ? 'm4a' : 'mp4', icon: audio ? '🎵' : '🎥' };
    }
    // Add-on (module 1): a playlist recognised by its content, at a URL that does not say so
    const addon = addonByUrl.get(url);
    if (addon && addon.manifest === 'hls') return { category: 'stream', label: 'HLS Stream', tagClass: 'tag-stream', isStream: true, isHls: true, icon: '🎬' };
    if (addon && addon.manifest === 'dash') return { category: 'stream', label: 'DASH Stream', tagClass: 'tag-stream', isStream: true, isDash: true, icon: '🎬' };
    // Add-on (module 3): an embedded video platform player: a page for yt-dlp, not a file to play or save here
    if (addon && addon.embed) return { category: 'embed', label: `${addon.embed} embed`, tagClass: 'tag-embed', isEmbed: true, icon: '🧩' };
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    if (cleanUrl.endsWith('.vtt') || cleanUrl.endsWith('.srt') || cleanUrl.endsWith('.ttml') || cleanUrl.endsWith('.dfxp') || cleanUrl.endsWith('.sub') || url.includes('/timedtext') || url.includes('format=vtt') || url.includes('format=srt') || url.includes('type=vtt') || url.includes('type=srt') || url.includes('mime=text%2Fvtt')) {
      return { category: 'subtitle', label: 'Subtitle', tagClass: 'tag-subtitle', isSubtitle: true, icon: '💬' };
    }
    if (cleanUrl.endsWith('.m3u8') || cleanUrl.endsWith('.m3u')) {
      return { category: 'stream', label: 'HLS Stream', tagClass: 'tag-stream', isStream: true, isHls: true, icon: '🎬' };
    }
    if (cleanUrl.endsWith('.mpd')) {
      return { category: 'stream', label: 'DASH Stream', tagClass: 'tag-stream', isStream: true, isDash: true, icon: '🎬' };
    }
    if (cleanUrl.endsWith('.mp3') || cleanUrl.endsWith('.wav') || cleanUrl.endsWith('.aac') || cleanUrl.endsWith('.flac') || cleanUrl.endsWith('.ogg') || cleanUrl.endsWith('.opus') || cleanUrl.endsWith('.m4a') || url.includes('mime=audio')) {
      return { category: 'audio', label: 'Audio', tagClass: 'tag-audio', isAudio: true, icon: '🎵' };
    }
    if (url.includes('mime=video') || url.includes('/videoplayback?') || url.includes('/hls/') || url.includes('/dash/') || url.includes('format=hls') || url.includes('format=dash') || url.includes('format=m3u8') || url.includes('format=mpd')) {
      return { category: 'stream', label: 'Stream', tagClass: 'tag-stream', isStream: true, icon: '🎬' };
    }
    // Add-on (module 8): a sound the page's audio player decoded / played from memory, at an address that does not say what it is
    if (addon && addon.mediaKind === 'audio') return { category: 'audio', label: 'Audio', tagClass: 'tag-audio', isAudio: true, icon: '🎵' };
    return { category: 'video', label: 'Video', tagClass: 'tag-video', isVideo: true, icon: '🎥' };
  }

  // Runs inside the page (top frame, and embedded frames): best guess at the video's real name from page metadata,
  // plus the names the page gives particular videos ({ url, name, strong }: strong = structured data naming that
  // exact file; the rest are element labels, captions and link text)
  function readPageVideoName() {
    const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
    const meta = (sel) => { const el = document.querySelector(sel); return el ? clean(el.getAttribute('content')) : ''; };
    const mediaNames = [];
    const addName = (rawUrl, name, strong) => {
      const n = clean(name);
      if (!n || typeof rawUrl !== 'string' || !rawUrl || mediaNames.length >= 300) return;
      try {
        const u = new URL(rawUrl, location.href);
        if (u.protocol === 'http:' || u.protocol === 'https:') mediaNames.push({ url: u.href, name: n.slice(0, 200), strong: !!strong });
      } catch (e) {}
    };

    // 1. JSON-LD structured data (VideoObject, Episode, Movie, ...)
    const mediaTypes = /^(VideoObject|Movie|TVEpisode|Episode|PodcastEpisode|Clip|AudioObject|MusicRecording)$/;
    let ldName = '';
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const types = [].concat(node['@type'] || []);
      if (types.some(t => mediaTypes.test(t)) && clean(node.name)) {
        if (!ldName) ldName = clean(node.name); // the page's name: the first one, as before
        [].concat(node.contentUrl || [], node.embedUrl || []).forEach((u) => addName(typeof u === 'string' ? u : (u && u['@id']), node.name, true));
      }
      Object.values(node).forEach(walk);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try { walk(JSON.parse(s.textContent)); } catch (e) {}
    });

    // 2. <video> / <audio> with a label of their own, or a <figure> caption
    document.querySelectorAll('video, audio').forEach((el) => {
      const fig = el.closest('figure');
      const cap = fig ? fig.querySelector('figcaption') : null;
      const names = [el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('data-title'), el.getAttribute('data-video-title'), el.getAttribute('data-name'), cap ? cap.textContent : ''];
      const urls = [el.currentSrc, el.getAttribute('src')];
      el.querySelectorAll('source[src]').forEach((s) => urls.push(s.getAttribute('src')));
      names.forEach((n) => urls.forEach((u) => addName(u, n, false)));
    });

    // 3. Links straight to a media file: their download name, title, text, or the alt text of their image
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      let path = '';
      try { path = new URL(href, location.href).pathname; } catch (e) { return; }
      if (!/\.(?:mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd)$/i.test(path)) return;
      const img = a.querySelector('img[alt]');
      [(a.getAttribute('download') || '').replace(/\.[a-z0-9]{2,5}$/i, ''), a.getAttribute('title'), a.textContent, img ? img.getAttribute('alt') : '']
        .forEach((n) => addName(href, n, false));
    });

    const siteName = meta('meta[property="og:site_name"]');
    const h1 = clean((document.querySelector('h1') || {}).textContent);
    const candidates = [
      ldName,
      meta('meta[property="og:title"]'),
      meta('meta[name="twitter:title"]'),
      meta('meta[itemprop="name"]'),
      clean(document.title),
      h1
    ];
    let name = candidates.find(Boolean) || '';
    // "Clip Name : Free Download, ..." -> the page heading, when the title merely starts with it
    if (!ldName && h1 && h1.length >= 3 && name.length > h1.length && name.toLowerCase().startsWith(h1.toLowerCase())) name = h1;
    // Add-on (module 11, addon2-content.js): the names a media session gave the files it played
    const sessionNames = Array.isArray(window.__VLE_SESSION_NAMES__)
      ? window.__VLE_SESSION_NAMES__.slice(0, 300).filter((e) => e && typeof e.url === 'string' && typeof e.name === 'string').map((e) => ({ url: e.url, name: e.name }))
      : [];
    return { name, siteName, mediaNames, sessionNames };
  }

  // A per-video name without the noise around it: "Download Episode 5 (720p)" -> "Episode 5", "clip_01.mp4" ->
  // "clip_01". '' when nothing but noise is left ("Video", "Download MP4", "Video player", "1080p").
  const MEDIA_NAME_NOISE = /\b(?:download|watch|play|stream|open|view|save|now|free|here|click|link|file|files|video|videos|audio|clip|media|player|embedded|untitled|format|quality|hd|sd|uhd|fhd|full\s?hd|high|low|mp4|webm|mkv|mov|m4v|mp3|m4a|flac|wav|ogg|opus|m3u8|\d{3,4}p\d{0,2}|[248]k|\d+(?:\.\d+)?\s?(?:kbps|mbps|kb|mb|gb))\b/gi;
  const TRAILING_NAME_NOISE = /(?:^|[\s([{|·,:–—-]+)(?:\d{3,4}p\d{0,2}|[248]k|hd|sd|uhd|fhd|full\s?hd|mp4|webm|mkv|mov|mp3|m4a|\d+(?:\.\d+)?\s?(?:kbps|mbps|kb|mb|gb))[\s)\]}]*$/i;
  function cleanMediaName(raw) {
    let n = String(raw || '').replace(/\s+/g, ' ').trim();
    n = n.replace(/\.(?:mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd)$/i, '');
    n = n.replace(/^(?:download|watch|play|stream|open|view|save)\b[\s:–—-]*/i, '');
    for (let i = 0; i < 5 && TRAILING_NAME_NOISE.test(n); i++) n = n.replace(TRAILING_NAME_NOISE, '').trim();
    const meaningful = n.replace(MEDIA_NAME_NOISE, '').replace(/[^\p{L}]+/gu, '');
    return meaningful.length >= 2 ? n.slice(0, 150) : '';
  }

  // Per-video names by URL. Structured data that names an exact file always counts. Labels, captions and link
  // text only count when the page names several videos differently (a gallery, a list of episodes): on a page
  // with one video, its page name stays the better name.
  function buildMediaNames(lists, sessionLists = []) {
    const entries = [];
    lists.forEach((list) => (list || []).forEach((e) => { if (e && e.url && e.name) entries.push(e); }));
    const nameOf = (e) => tidyTitle(cleanMediaName(e.name), currentSiteName);
    const distinct = new Set(entries.map((e) => nameOf(e).toLowerCase()).filter(Boolean));
    const useLabels = distinct.size >= 2;
    const exact = new Map();
    const byPath = new Map();
    const conflicts = new Set();
    entries.forEach((e) => {
      if (!e.strong && !useLabels) return;
      const name = nameOf(e);
      const norm = name && normalizeUrl(e.url);
      if (!norm) return;
      if (!exact.has(norm) || (e.strong && !exact.get(norm).strong)) exact.set(norm, { name, strong: !!e.strong });
      // the same file under another token / query: only for paths that name a media file
      try {
        const p = new URL(norm);
        if (!/\.[a-z0-9]{2,5}$/i.test(p.pathname)) return;
        const key = p.origin + p.pathname;
        if (byPath.has(key) && byPath.get(key) !== name) conflicts.add(key);
        else byPath.set(key, name);
      } catch (e2) {}
    });
    conflicts.forEach((k) => byPath.delete(k));
    const names = new Map();
    exact.forEach((v, k) => names.set(k, v.name));

    // Add-on (module 11): the name a music / podcast player gave a file while playing it (Media Session). Only for a
    // file nothing above names, and only when the page names several videos (the rule above) or its player named
    // several files differently: on a page with one video, the page name stays its name.
    const sessionNamed = new Map();
    sessionLists.forEach((list) => (list || []).forEach((e) => {
      if (!e || !e.url || !e.name) return;
      const name = nameOf(e);
      const norm = name && normalizeUrl(e.url);
      if (norm) sessionNamed.set(norm, name);
    }));
    const distinctSession = new Set(Array.from(sessionNamed.values(), (n) => n.toLowerCase()));
    if (useLabels || distinctSession.size >= 2) {
      sessionNamed.forEach((name, norm) => {
        if (names.has(norm)) return;
        try {
          const p = new URL(norm);
          if (byPath.has(p.origin + p.pathname)) return;
        } catch (e) {}
        names.set(norm, name);
      });
    }
    return { exact: names, byPath };
  }

  // The name the page gives this particular video ('' when it gives none). A quality listed in a master
  // playlist takes the master's name.
  function videoNameFor(url) {
    const own = variantOf.get(url);
    const key = own ? own.masterUrl : url;
    const found = pageMediaNames.exact.get(key) || (key !== url ? pageMediaNames.exact.get(url) : '');
    if (found) return found;
    try {
      const p = new URL(key);
      return pageMediaNames.byPath.get(p.origin + p.pathname) || '';
    } catch (e) {
      return '';
    }
  }

  // Title shown on a card: the video's own name, else the page's
  function cardTitleFor(url) {
    return videoNameFor(url) || currentVideoName || tidyTitle(currentPageTitle);
  }

  // Strip site suffixes / notification counters from a title: "(3) My Clip | SiteName" -> "My Clip"
  function tidyTitle(title, siteName = '') {
    let t = (title || '').replace(/^\(\d+\+?\)\s*/, '').replace(/\s+/g, ' ').trim();
    t = t.replace(/\s+[-–—|·•:]\s+YouTube$/i, '');
    if (siteName) {
      const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\s+[-–—|·•:]\\s+${esc}$`, 'i'), '').replace(new RegExp(`^${esc}\\s+[-–—|·•:]\\s+`, 'i'), '');
    }
    return t.trim();
  }

  // Make a name safe to use as a file name (and as the last field of URL|Ref|Name)
  function toSafeName(name) {
    return (name || '').replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '_').replace(/[\s.]+$/, '').trim().slice(0, 150);
  }

  // Video name for a stream: the name the page gives this video, else page metadata, else tab title, else the
  // file name in the URL
  function getVideoName(url) {
    const own = toSafeName(videoNameFor(url));
    if (own) return own;
    const fromPage = toSafeName(currentVideoName) || toSafeName(tidyTitle(currentPageTitle));
    if (fromPage) return fromPage;
    try {
      const path = new URL(url).pathname;
      const last = decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
      return toSafeName(last.replace(/\.[a-z0-9]{2,5}$/i, '')) || 'video';
    } catch (e) {
      return 'video';
    }
  }

  // Real file type of a link for the Save file name: the extension in the URL path, else the mime= parameter
  // (YouTube-style links). '' when the URL does not say.
  const SAVE_EXTS = /^(?:m3u8|mpd|m3u|mp4|webm|mkv|mov|avi|flv|m4v|ogv|wmv|3gp|f4v|mp3|aac|flac|wav|ogg|opus|m4a|vtt|srt|ttml|dfxp|sub)$/;
  function urlMediaExt(url) {
    try {
      const parsed = new URL(url);
      const m = /\.([a-z0-9]{2,5})$/i.exec(parsed.pathname);
      if (m && SAVE_EXTS.test(m[1].toLowerCase())) return m[1].toLowerCase();
      const mime = (parsed.searchParams.get('mime') || '').toLowerCase();
      if (mime === 'video/mp4') return 'mp4';
      if (mime === 'audio/mp4') return 'm4a';
      if (mime === 'video/webm' || mime === 'audio/webm') return 'webm';
    } catch (e) {}
    return '';
  }

  // Infer clean filename for downloads & exports with page title support
  function getCleanFilename(url, fallbackExt = 'mp4') {
    try {
      const ownName = videoNameFor(url);
      if (ownName || currentVideoName || currentPageTitle) {
        const sanitized = toSafeName(ownName) || toSafeName(currentVideoName) || toSafeName(tidyTitle(currentPageTitle));
        if (sanitized) {
          const qual = getStreamQuality(url);
          const qualSuffix = qual ? `_${qual.label.replace(/[^a-zA-Z0-9]/g, '')}` : '';
          return `${sanitized}${qualSuffix}.${fallbackExt}`;
        }
      }
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      const lastSegment = pathname.substring(pathname.lastIndexOf('/') + 1);
      if (lastSegment && lastSegment.includes('.')) {
        return decodeURIComponent(lastSegment.split('?')[0]);
      }
      const host = parsed.hostname ? parsed.hostname.replace(/[^a-zA-Z0-9]/g, '_') : 'video';
      return `media_${host}_${Date.now()}.${fallbackExt}`;
    } catch (e) {
      return `media_download_${Date.now()}.${fallbackExt}`;
    }
  }

  // Helper for copy button visual feedback
  function triggerCopied(btn, text = '✓ Copied!') {
    const originalText = btn.textContent;
    btn.textContent = text;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('copied');
    }, 1500);
  }

  // Download a blob/string as a file in browser
  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- Add-on: DRM / encryption display ------------------------------------------------------
  // Encryption info for a link: what the background worker found (manifest / file header analysis),
  // else what the URL alone gives away (e.g. Spotify's audio CDN). null = no evidence.
  function getDrmInfo(item) {
    if (item && typeof item === 'object' && item.drm) return item.drm;
    const url = typeof item === 'string' ? item : (item ? item.url : '');
    const known = window.__VLE_DRM__ ? window.__VLE_DRM__.info(url) : null;
    return known ? { type: 'drm', systems: [], scheme: null, kids: [], license: [], sources: ['url'] } : null;
  }

  function isDrmConfirmed(item) {
    const d = getDrmInfo(item);
    return !!d && d.type === 'drm';
  }

  const DRM_SOURCE_LABELS = { manifest: 'stream manifest', init: 'file header', url: 'known DRM host', eme: 'browser DRM playback' };

  // Badges for one link: "🔒 DRM", one chip per DRM system, the encryption scheme; or "🔑 AES-128" for plain HLS encryption
  function buildDrmBadges(item, typeInfo) {
    const d = getDrmInfo(item);
    if (!d) return [];
    const out = [];
    const provider = (typeInfo && typeInfo.drmProvider) ? ` (${typeInfo.drmProvider})` : '';
    const how = (d.sources || []).map((s) => DRM_SOURCE_LABELS[s] || s).join(', ');
    if (d.type === 'aes') {
      const aes = document.createElement('span');
      aes.className = 'type-tag tag-aes drm-badge';
      aes.textContent = `🔑 ${d.scheme || 'Encrypted'}`;
      aes.title = 'Standard HLS encryption: the key is served openly, so yt-dlp / ffmpeg can normally download it. Not DRM.';
      out.push(aes);
      return out;
    }
    const badge = document.createElement('span');
    badge.className = 'type-tag tag-drm drm-badge';
    badge.textContent = '🔒 DRM';
    badge.title = `DRM-protected stream${provider}${how ? ` - detected from: ${how}` : ''}. Listed for reference: the extension does not decrypt it, so it needs a DRM-capable player.`;
    out.push(badge);
    (d.systems || []).forEach((s) => {
      const chip = document.createElement('span');
      chip.className = 'type-tag tag-drm-sys drm-badge';
      chip.textContent = s;
      out.push(chip);
    });
    if (d.scheme) {
      const scheme = document.createElement('span');
      scheme.className = 'type-tag tag-drm-sys drm-badge';
      scheme.textContent = d.scheme.toUpperCase();
      scheme.title = 'Encryption scheme';
      out.push(scheme);
    }
    if (d.kids && d.kids.length) {
      badge.title += `\nKey ID${d.kids.length > 1 ? 's' : ''}: ${d.kids.join(', ')}`;
    }
    return out;
  }

  // (Re)place the DRM badges right after the type badge of a card's tag row
  function appendDrmBadges(tagRow, item, typeInfo) {
    tagRow.querySelectorAll('.drm-badge').forEach((el) => el.remove());
    let ref = tagRow.firstElementChild;
    if (!ref) return;
    buildDrmBadges(item, typeInfo).forEach((el) => {
      ref.after(el);
      ref = el;
    });
  }

  // Page-level summary: the page is playing (or offering) DRM content, per the browser's own encrypted-media API
  function renderDrmBanner() {
    if (!drmBanner) return;
    drmBanner.innerHTML = '';
    const d = currentTabDrm;
    if (!d) {
      drmBanner.style.display = 'none';
      return;
    }
    const title = document.createElement('strong');
    title.textContent = '🔒 DRM detected on this page';
    drmBanner.appendChild(title);
    (d.systems || []).forEach((s) => {
      const chip = document.createElement('span');
      chip.className = 'type-tag tag-drm-sys';
      chip.textContent = s;
      drmBanner.appendChild(chip);
    });
    const meta = [];
    if (d.robustness && d.robustness.length) meta.push(d.robustness.join(' / '));
    if (d.kids && d.kids.length) meta.push(`${d.kids.length} key ID${d.kids.length > 1 ? 's' : ''}`);
    (d.license || []).slice(0, 2).forEach((u) => {
      try { meta.push(`license: ${new URL(u).hostname}`); } catch (e) {}
    });
    if (meta.length) {
      const m = document.createElement('span');
      m.className = 'drm-banner-meta';
      m.textContent = meta.join(' · ');
      drmBanner.appendChild(m);
    }
    const details = [];
    if (d.kids && d.kids.length) details.push(`Key IDs:\n${d.kids.join('\n')}`);
    if (d.license && d.license.length) details.push(`License server(s):\n${d.license.join('\n')}`);
    details.push('Encrypted streams need a DRM-capable player. Links the page loads are still listed below; 🔒 marks the ones confirmed as encrypted.');
    drmBanner.title = details.join('\n\n');
    drmBanner.style.display = 'flex';
  }

  // Ask the background worker to check listed links for DRM (reads a manifest / the first 64 KB of a file), and
  // manifests for the qualities they list. Results are stored per link, so each link is only ever checked once.
  const MANIFEST_URL_RE = /\.(?:m3u8|m3u|mpd)(?:[?#]|$)|[?&](?:format|type|output)=(?:m3u8|mpd|hls|dash)\b/i;
  const wantsVariants = (item) => !item.variantsChecked && !item.segmented && (MANIFEST_URL_RE.test(item.url) || !!(item.addon && item.addon.manifest));
  function scheduleDrmProbes() {
    if (currentTabId === undefined) return;
    currentLinks.forEach((item) => {
      const url = item && item.url;
      if (!url || (item.drmChecked && !wantsVariants(item)) || drmProbed.has(url)) return;
      const category = getMediaType(url).category;
      if (category === 'subtitle' || category === 'embed' || /\.(?:mp3|wav|aac|flac|ogg|opus)(?:[?#]|$)/i.test(url)) return;
      if (drmProbed.size >= 60) return;
      drmProbed.add(url);
      chrome.runtime.sendMessage({ action: 'probeDrm', tabId: currentTabId, url: url }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const cur = itemByUrl.get(url);
        if (!cur) return;
        if (res.checked) cur.drmChecked = true;
        if (res.variantsChecked) cur.variantsChecked = true;
        let changed = false;
        if (res.drm) {
          cur.drm = res.drm;
          changed = true;
        }
        if (res.variants && Array.isArray(res.variants.items)) {
          cur.variants = res.variants;
          registerVariants(cur);
          changed = true;
        }
        if (res.duration > 0 && cur.duration !== res.duration) {
          cur.duration = res.duration;
          changed = true;
        }
        if (res.live && !cur.live) {
          cur.live = true;
          changed = true;
        }
        // a master's qualities also label its quality playlists; a length can move a card to the Short tab
        if (changed) scheduleRelayout();
        if (res.drm && res.drm.type === 'drm') {
          // a confirmed DRM stream also means the page has DRM content: refresh the page-level banner
          chrome.runtime.sendMessage({ action: 'getLinks', tabId: currentTabId }, (r) => {
            if (!chrome.runtime.lastError && r) {
              currentTabDrm = r.drm || null;
              renderDrmBanner();
            }
          });
        }
      });
    });
  }

  // ---- Add-on: segmented streams -> .m3u8 ------------------------------------------------------
  function formatDuration(ms) {
    const total = Math.round((ms || 0) / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Copied commands put values inside double quotes, where bash and PowerShell still run `...` / $(...), "\" escapes
  // the closing quote, and PowerShell also closes a string on a curly quote. Such characters come from the page
  // (URL, Referer, title), so neutralise them. Ordinary values contain none of them and are copied unchanged.
  const SHELL_UNSAFE = /[$`\\"“-‟]/g;
  // In a URL the percent-encoded form names the same resource
  function shellSafeUrl(u) {
    return String(u || '').replace(SHELL_UNSAFE, (c) => encodeURIComponent(c));
  }
  function shellSafeName(name) {
    return String(name || '').replace(SHELL_UNSAFE, '_');
  }
  // File name of a segmented stream's playlist: the saved file and the ffmpeg command must use the same one
  function segmentPlaylistName(url) {
    return shellSafeName(getCleanFilename(url, 'm3u8'));
  }

  function ffmpegCommand(playlistName, seg) {
    const name = shellSafeName(playlistName);
    const out = name.replace(/\.m3u8$/i, '') + (seg.kind === 'audio' ? '.m4a' : '.mp4');
    return `ffmpeg -protocol_whitelist file,http,https,tcp,tls,crypto -allowed_extensions ALL -i "${name}" -c copy "${out}"`;
  }

  // HLS VOD playlist listing the init segment and every piece of the stream, in order
  function buildSegmentPlaylist(seg, playlistName) {
    let urls;
    if (Array.isArray(seg.urls)) {
      urls = seg.urls; // pieces with individually signed URLs: exactly the ones that were requested
    } else {
      const first = seg.first || 0, step = seg.step || seg.segLen || 4, pad = seg.pad || 0;
      urls = [];
      for (let i = 0; i < Math.max(1, seg.count || 1); i++) {
        urls.push(seg.segmentUrlTemplate.split('{{segment_timestamp}}').join(String(first + i * step).padStart(pad, '0')));
      }
    }
    const knownLen = seg.segLen && seg.endMs;
    const totalSec = (seg.endMs || 0) / 1000;
    const durOf = (i) => (knownLen ? Math.max(0.001, Math.min(seg.segLen, totalSec - i * seg.segLen)) : (seg.assumedDur || 4));
    const target = Math.ceil(knownLen ? seg.segLen : (seg.assumedDur || 4));
    const lines = [
      '#EXTM3U',
      `# ${seg.provider || 'Segmented'} ${seg.kind} stream, ${urls.length} segments${knownLen ? `, ${formatDuration(seg.endMs)}` : ''}${seg.encrypted ? ' (ENCRYPTED)' : ''}`,
      knownLen ? '# durations from the stream manifest' : `# durations are NOT known for this stream: each segment is assumed to last ${seg.assumedDur || 4} s`,
      Array.isArray(seg.urls) || seg.generic ? `# range inferred from the requests the page made (${seg.observed || urls.length} seen)` : '',
      `# ${ffmpegCommand(playlistName, seg)}`,
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${target}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD'
    ].filter(Boolean);
    if (seg.initUrl) lines.push(`#EXT-X-MAP:URI="${seg.initUrl}"`);
    urls.forEach((u, i) => lines.push(`#EXTINF:${durOf(i).toFixed(3)},`, u));
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  // Update counts on filter pills
  function updateFilterCounts(links) {
    let streams = 0;
    let videos = 0;
    let audio = 0;
    let subtitles = 0;
    let shortClips = 0;
    let embeds = 0;
    let drmCount = 0;

    links.forEach(item => {
      const category = filterCategory(item);
      if (category === 'stream') streams++;
      else if (category === 'audio') audio++;
      else if (category === 'subtitle') subtitles++;
      else if (category === 'short') shortClips++;
      else if (category === 'embed') embeds++;
      else videos++;
      if (isDrmConfirmed(item)) drmCount++;
    });

    filterAllCount.textContent = links.length;
    filterStreamCount.textContent = streams;
    filterVideoCount.textContent = videos;
    filterAudioCount.textContent = audio;
    if (filterSubtitleCount) filterSubtitleCount.textContent = subtitles;
    if (filterShortCount) filterShortCount.textContent = shortClips;
    if (filterEmbedCount) filterEmbedCount.textContent = embeds;
    if (filterDrmCount) filterDrmCount.textContent = drmCount;
  }

  // Filter and sort links (Highest Quality First by default)
  function getFilteredLinks() {
    const list = currentLinks.filter(item => {
      const url = typeof item === 'string' ? item : item.url;
      const referer = (typeof item === 'object' && item.referer) ? item.referer : '';

      // 1. Pill Filter ('drm' is a cross-category filter: any link confirmed as DRM-protected)
      if (activeFilter === 'drm') {
        if (!isDrmConfirmed(item)) return false;
      } else if (activeFilter !== 'all' && filterCategory(item) !== activeFilter) {
        return false;
      }

      // 2. Search Query Filter
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesUrl = url.toLowerCase().includes(q);
        const matchesRef = referer.toLowerCase().includes(q);
        const matchesTitle = currentPageTitle.toLowerCase().includes(q) || cardTitleFor(url).toLowerCase().includes(q);
        if (!matchesUrl && !matchesRef && !matchesTitle) return false;
      }

      return true;
    });

    // Sort order
    if (currentSortMode === 'quality') {
      list.sort((a, b) => {
        const urlA = typeof a === 'string' ? a : a.url;
        const urlB = typeof b === 'string' ? b : b.url;
        const qualA = getStreamQuality(urlA);
        const qualB = getStreamQuality(urlB);
        const scoreA = qualA ? qualA.score : 0;
        const scoreB = qualB ? qualB.score : 0;
        return scoreB - scoreA;
      });
    } else if (currentSortMode === 'newest') {
      list.sort((a, b) => {
        const timeA = (typeof a === 'object' && a.timestamp) ? a.timestamp : 0;
        const timeB = (typeof b === 'object' && b.timestamp) ? b.timestamp : 0;
        return timeB - timeA;
      });
    } else if (currentSortMode === 'oldest') {
      list.sort((a, b) => {
        const timeA = (typeof a === 'object' && a.timestamp) ? a.timestamp : 0;
        const timeB = (typeof b === 'object' && b.timestamp) ? b.timestamp : 0;
        return timeA - timeB;
      });
    }

    return list;
  }

  // Get list of currently selected items among visible filtered items
  function getSelectedLinks() {
    const visible = getFilteredLinks();
    return visible.filter(item => {
      const url = typeof item === 'string' ? item : item.url;
      return selectedUrls.has(url);
    });
  }

  // Update selection UI, master checkbox and dynamic counts on Copy/Export buttons
  function updateSelectionUI() {
    const visible = getFilteredLinks();
    const selected = getSelectedLinks();

    if (copyCount) copyCount.textContent = selected.length;
    if (exportCount) exportCount.textContent = selected.length;

    if (selectAllCheckbox) {
      if (visible.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
      } else if (selected.length === visible.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
      } else if (selected.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
      } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
      }
    }

    if (selectAllText) {
      selectAllText.textContent = `All (${selected.length}/${visible.length})`;
    }
  }

  // Takes a list from the background worker: de-duplicates it, rebuilds the per-URL lookups and selects links
  // seen for the first time (items the user unticked stay unticked)
  function setLinks(linksData) {
    // Strict canonical deduplication
    const uniqueMap = new Map();
    (linksData || []).forEach(item => {
      const rawUrl = typeof item === 'string' ? item : (item ? item.url : '');
      // a grouped stream may be addressed by a .ts / .m4s piece: those are only ever shown as that one group
      const norm = (item && typeof item === 'object' && item.segmented) ? rawUrl : normalizeUrl(rawUrl);
      if (norm && !uniqueMap.has(norm)) {
        uniqueMap.set(norm, typeof item === 'string' ? { url: norm } : { ...item, url: norm });
      }
    });
    currentLinks = Array.from(uniqueMap.values());
    itemByUrl.clear();
    addonByUrl.clear();
    segmentedByUrl.clear();
    variantsByUrl.clear();
    variantOf.clear();
    currentLinks.forEach((item) => {
      itemByUrl.set(item.url, item);
      if (item.addon && typeof item.addon === 'object') addonByUrl.set(item.url, item.addon);
      if (item.segmented) segmentedByUrl.set(item.url, item.segmented);
      registerVariants(item);
    });

    // Select all by default on first load or when new items arrive; items the user unticked stay unticked
    currentLinks.forEach(item => {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        selectedUrls.add(item.url);
      }
    });
    applyBestOnly();
  }

  // Re-sorts the cards into their tabs and ticks with the data known now (a probe found a length, a size, ...)
  let relayoutTimer = null;
  function scheduleRelayout() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => applyLiveLinks(currentLinks.slice()), 150);
  }

  // Render list of links: the whole list (on open, and when the filter, search, sort or selection changes)
  function renderLinks(linksData, pageUrl) {
    if (linksData !== undefined) setLinks(linksData);
    if (pageUrl !== undefined) {
      currentPageUrl = pageUrl || '';
    }

    renderDrmBanner();

    // Clean up active Hls player instances
    activeHlsPlayers.forEach(hls => {
      try { hls.destroy(); } catch (e) {}
    });
    activeHlsPlayers.clear();
    cardRefs.clear();

    updateFilterCounts(currentLinks);
    countBadge.textContent = currentLinks.length;
    linksContainer.innerHTML = '';

    if (currentLinks.length === 0) {
      linksContainer.style.display = 'none';
      copyAllButton.style.display = 'none';
      if (exportDropdownBtn) exportDropdownBtn.style.display = 'none';
      statusEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎬</div>
          <div><strong>No media streams detected yet.</strong></div>
          <div style="font-size: 12px; margin-top: 6px; opacity: 0.85;">Play a video or use <strong>📱 Mobile Scan</strong> to check for direct streams. Links appear here as they are found.</div>
          ${currentTabDrm ? '<div style="font-size: 12px; margin-top: 6px; opacity: 0.85;">🔒 This page uses DRM, but has not exposed a stream URL yet. Start playback: its links appear here as they are found.</div>' : ''}
        </div>
      `;
      updateSelectionUI();
      return;
    }

    linksContainer.style.display = 'flex';
    copyAllButton.style.display = 'inline-flex';
    if (exportDropdownBtn) exportDropdownBtn.style.display = 'inline-flex';
    statusEl.innerHTML = '';

    const filtered = getFilteredLinks();

    if (filtered.length === 0) {
      // Built from text nodes: the search text is user input, not markup
      const noResults = document.createElement('div');
      noResults.className = 'no-results';
      const query = document.createElement('strong');
      query.textContent = searchQuery;
      noResults.append('🔍 No media found matching "', query, `" in ${activeFilter.toUpperCase()}.`);
      linksContainer.replaceChildren(noResults);
      updateSelectionUI();
      return;
    }

    filtered.forEach((item) => linksContainer.appendChild(buildCard(item)));

    updateSelectionUI();
    if (linksData !== undefined) scheduleDrmProbes();
  }

  // A newer list arrived while the popup is open: patch the cards on screen instead of rebuilding them, so a
  // running ▶ Play preview, the scroll position and button feedback stay put. Cards already shown keep their
  // place (moving a playing <video> pauses it); new ones go where the current sort order puts them.
  function applyLiveLinks(linksData, pageUrl) {
    const hadCards = cardRefs.size > 0;
    setLinks(linksData);
    if (pageUrl !== undefined) currentPageUrl = pageUrl || '';
    const filtered = getFilteredLinks();
    if (!hadCards || !filtered.length) {
      renderLinks();
      scheduleDrmProbes();
      return;
    }
    renderDrmBanner();
    updateFilterCounts(currentLinks);
    countBadge.textContent = currentLinks.length;

    const wanted = new Set(filtered.map((item) => item.url));
    Array.from(cardRefs.entries()).forEach(([url, ref]) => {
      if (wanted.has(url)) return;
      ref.destroy();
      ref.card.remove();
      cardRefs.delete(url);
    });
    let next = null; // the card that follows, in sort order
    for (let i = filtered.length - 1; i >= 0; i--) {
      const item = filtered[i];
      const ref = cardRefs.get(item.url);
      if (ref && ref.refresh(item)) {
        next = ref.card;
        continue;
      }
      // new, or its kind changed (e.g. it turned out to be a grouped stream): (re)built
      if (ref) {
        ref.destroy();
        cardRefs.delete(item.url);
      }
      const card = buildCard(item);
      if (ref) ref.card.replaceWith(card);
      else linksContainer.insertBefore(card, next);
      next = card;
    }
    updateSelectionUI();
    scheduleDrmProbes();
  }

  // Re-draws the parts of every card that can change (titles once the page names are read, expiry countdowns)
  function refreshAllCards() {
    cardRefs.forEach((ref, url) => ref.refresh(itemByUrl.get(url) || null));
  }

  // One card. Its buttons read the link's latest data when clicked; refresh() re-draws the parts that change.
  function buildCard(initialItem) {
    const url = initialItem.url;
    const latest = () => itemByUrl.get(url) || initialItem;
    const refererOf = () => { const cur = latest(); return (cur && cur.referer) ? cur.referer : currentPageUrl; };
    const posterOf = () => { const cur = latest(); return (cur && cur.poster) ? cur.poster : ''; };
    const typeInfo = getMediaType(url); // the kind of link is fixed for a card: when it changes, the card is rebuilt
    const isSelected = selectedUrls.has(url);
    const cardId = `card_${++cardSeq}`;

    const card = document.createElement('div');
    card.className = `link-card ${isSelected ? 'is-selected' : 'not-selected'}`;
    card.id = cardId;
    card.dataset.url = url;

    // Card Header / Info
    const cardTop = document.createElement('div');
    cardTop.className = 'card-top';

    // Selection Checkbox
    const cardCheckbox = document.createElement('input');
    cardCheckbox.type = 'checkbox';
    cardCheckbox.className = 'card-checkbox';
    cardCheckbox.checked = isSelected;
    cardCheckbox.title = 'Select / Deselect this stream';

    cardCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      userTouched.add(url); // set by hand: Best only leaves it alone
      autoUnticked.delete(url);
      if (cardCheckbox.checked) {
        selectedUrls.add(url);
        card.classList.add('is-selected');
        card.classList.remove('not-selected');
      } else {
        selectedUrls.delete(url);
        card.classList.remove('is-selected');
        card.classList.add('not-selected');
      }
      updateSelectionUI();
    });

    // Small inline thumbnail preview box
    const thumbBox = document.createElement('div');
    thumbBox.className = 'thumb-box';
    let thumbShown = null; // poster URL on display ('' = placeholder)
    const showThumb = () => {
      const poster = posterOf();
      if (thumbShown === poster || (thumbShown && !poster)) return;
      thumbShown = poster;
      if (!poster) {
        thumbBox.innerHTML = `<span class="thumb-placeholder">${typeInfo.icon}</span>`;
        return;
      }
      chrome.runtime.sendMessage({
        action: 'preparePreview',
        mediaUrl: poster,
        refererUrl: refererOf()
      }, () => {
        const img = document.createElement('img');
        img.alt = 'Thumbnail';
        img.src = poster;
        img.onerror = () => {
          img.remove();
          thumbBox.innerHTML = `<span class="thumb-placeholder">${typeInfo.icon}</span>`;
        };
        thumbBox.replaceChildren(img);
      });
    };

    const cardInfo = document.createElement('div');
    cardInfo.className = 'card-info';

    // Title Display: the video's own name, else the page's
    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    const showTitle = () => {
      const t = cardTitleFor(url);
      titleEl.textContent = t;
      titleEl.title = t;
      titleEl.style.display = t ? '' : 'none';
    };

    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';

    const variantsBox = document.createElement('div');
    variantsBox.className = 'variants-box';

    const fillTags = () => {
      const cur = latest();
      tagRow.replaceChildren();

      const typeBadge = document.createElement('span');
      typeBadge.className = `type-tag ${typeInfo.tagClass}`;
      typeBadge.textContent = typeInfo.label;
      tagRow.appendChild(typeBadge);

      // DRM / encryption badges (from manifest / file-header analysis, or the URL itself)
      appendDrmBadges(tagRow, cur, typeInfo);

      if (typeInfo.isSegmented) {
        const segMeta = segmentedByUrl.get(url);
        const segBadge = document.createElement('span');
        segBadge.className = 'type-tag tag-seg';
        segBadge.textContent = segMeta ? `🧩 ${segMeta.count} segments${segMeta.endMs ? ` · ${formatDuration(segMeta.endMs)}` : ''}` : '🧩 Segmented';
        segBadge.title = cur && cur.addon && cur.addon.source === 'mse'
          ? `One stream: the ${segMeta ? segMeta.count : ''} pieces the page's video player fed the browser after its init segment, in order. Durations are not known. Use "⬇ .m3u8" to export.`
          : segMeta && segMeta.generic
          ? `One stream fetched as numbered pieces (${segMeta.observed} seen), listed once. Range and durations are inferred from the requests. Use "⬇ .m3u8" to export.`
          : 'One stream delivered as many small pieces, listed once. Use "⬇ .m3u8" to export the full segment list.';
        tagRow.appendChild(segBadge);
      }

      // Smart Quality/Resolution badge (show only if distinct from type badge)
      const qualityInfo = getStreamQuality(url);
      if (qualityInfo && qualityInfo.label !== typeInfo.label && qualityInfo.label !== 'Video' && qualityInfo.label !== 'Audio' && qualityInfo.label !== 'Subtitle') {
        const qualityBadge = document.createElement('span');
        qualityBadge.className = qualityInfo.tagClass;
        qualityBadge.textContent = qualityInfo.label;
        tagRow.appendChild(qualityBadge);
      }

      // Qualities the manifest lists: opens the list with a copy row per quality
      const variants = variantsByUrl.get(url);
      if (variants && variants.items.length) {
        const n = variants.items.length;
        const open = expandedVariants.has(url);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'variants-toggle';
        toggle.textContent = `📶 ${n} ${n === 1 ? 'track' : 'tracks'} ${open ? '▴' : '▾'}`;
        toggle.title = variants.type === 'hls'
          ? 'Qualities, audio and subtitle tracks in this playlist, each with its own link to copy'
          : 'Qualities and tracks this DASH manifest lists';
        toggle.addEventListener('click', () => {
          if (expandedVariants.has(url)) expandedVariants.delete(url);
          else expandedVariants.add(url);
          fillTags();
          showVariants();
        });
        tagRow.appendChild(toggle);
      }

      // File Size Badge
      const sizeBytes = getMediaSize(cur);
      if (sizeBytes > 0) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'size-badge';
        sizeSpan.textContent = `📦 ${formatFileSize(sizeBytes)}`;
        tagRow.appendChild(sizeSpan);
      } else if (!typeInfo.isStream && !typeInfo.isSegmented && !typeInfo.isEmbed) {
        requestMediaSize(url);
      }

      // Length (a segmented stream's badge already shows it), or Live for a stream without an end
      if (cur && cur.live) {
        const liveBadge = document.createElement('span');
        liveBadge.className = 'type-tag tag-live';
        liveBadge.textContent = '🔴 Live';
        liveBadge.title = 'Live stream: its playlist has no end yet';
        tagRow.appendChild(liveBadge);
      } else if (!(typeInfo.isSegmented && cur && cur.segmented && cur.segmented.endMs)) {
        const seconds = getDurationSec(cur);
        if (seconds > 0) {
          const durBadge = document.createElement('span');
          durBadge.className = 'type-tag tag-duration';
          durBadge.textContent = `🕒 ${formatDuration(seconds * 1000)}`;
          durBadge.title = 'Length';
          tagRow.appendChild(durBadge);
        }
      }

      const expiry = buildExpiryBadge(url);
      if (expiry) tagRow.appendChild(expiry);

      // How an add-on detection module found this link (links the existing detection found carry no badge)
      const addonBadge = buildAddonBadge(cur);
      if (addonBadge) tagRow.appendChild(addonBadge);

      if (cur && cur.isMobile) {
        const mobileBadge = document.createElement('span');
        mobileBadge.className = 'type-tag tag-mobile';
        mobileBadge.textContent = '📱 Mobile Direct';
        tagRow.appendChild(mobileBadge);
      }

      const referer = refererOf();
      if (referer) {
        try {
          const refHost = new URL(referer).hostname;
          const refBadge = document.createElement('span');
          refBadge.className = 'referer-info';
          refBadge.textContent = `Ref: ${refHost}`;
          refBadge.title = `Referer: ${referer}`;
          tagRow.appendChild(refBadge);
        } catch (e) {}
      }
    };

    // One row per quality / track. HLS rows copy that quality's own playlist in the same formats as the card's
    // buttons (URL, URL|Referer, URL|Referer|Name, with this card's Referer and name). DASH lists them only.
    const copyButton = (label, title, text) => {
      const btn = document.createElement('button');
      btn.className = label === 'Copy' ? 'action-btn btn-copy' : 'action-btn btn-piped';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(text()).then(() => triggerCopied(btn, label === 'Copy' ? '✓ URL' : '✓ Copied'));
      });
      return btn;
    };
    const showVariants = () => {
      const variants = variantsByUrl.get(url);
      if (!variants || !expandedVariants.has(url)) {
        variantsBox.remove();
        return;
      }
      const rows = sortedVariants(variants.items).map((v) => {
        const row = document.createElement('div');
        row.className = 'variant-row';
        const label = document.createElement('span');
        label.className = 'variant-label';
        label.textContent = variantLabel(v);
        const metaEl = document.createElement('span');
        metaEl.className = 'variant-meta';
        metaEl.textContent = v.codecs || v.language || '';
        metaEl.title = v.url || v.codecs || '';
        row.append(label, metaEl);
        if (v.url) {
          row.append(
            copyButton('Copy', 'Copy this quality\'s URL', () => v.url),
            copyButton('+ Ref', 'Copy this quality\'s URL and Referer (URL|Ref)', () => { const r = refererOf(); return r ? `${v.url}|${r}` : v.url; }),
            copyButton('+ Name', 'Copy this quality\'s URL, Referer and video name (URL|Ref|Name)', () => `${v.url}|${refererOf() || ''}|${getVideoName(url)}`)
          );
        }
        return row;
      });
      variantsBox.replaceChildren(...rows);
      if (!variantsBox.isConnected) actionsBar.before(variantsBox);
    };

    const urlLink = document.createElement('a');
    urlLink.className = 'link-url';
    urlLink.href = url;
    urlLink.target = '_blank';
    urlLink.title = url;
    urlLink.textContent = url;

    cardInfo.appendChild(titleEl);
    cardInfo.appendChild(tagRow);
    cardInfo.appendChild(urlLink);

    // Card Actions
    // 1. Video Preview Button
    const previewBtn = document.createElement('button');
    previewBtn.className = 'action-btn btn-preview';
    previewBtn.innerHTML = '▶ Play';
    previewBtn.title = 'Test play live stream / media in popup';
    if (typeInfo.isSegmented) previewBtn.style.display = 'none'; // a single piece is not playable on its own
    if (typeInfo.isEmbed) previewBtn.style.display = 'none'; // a player page, not a media file

    // 2. Direct Download Button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'action-btn btn-download';
    downloadBtn.innerHTML = '⬇ Save';
    downloadBtn.title = 'Download file directly to browser';

    if (typeInfo.isSegmented) {
      downloadBtn.innerHTML = '⬇ .m3u8';
      downloadBtn.title = 'Export an .m3u8 playlist with every segment of this stream (open it with ffmpeg / VLC / mpv)';
    }
    if (typeInfo.isEmbed) downloadBtn.style.display = 'none'; // saving the player page is no use: copy it for yt-dlp

    downloadBtn.addEventListener('click', () => {
      if (typeInfo.isSegmented) {
        const segMeta = segmentedByUrl.get(url);
        if (!segMeta) { triggerCopied(downloadBtn, '⚠️ Manifest not captured'); return; }
        const name = segmentPlaylistName(url);
        downloadBlob(buildSegmentPlaylist(segMeta, name), name, 'application/vnd.apple.mpegurl');
        triggerCopied(downloadBtn, '✓ Playlist');
        return;
      }
      const fallbackExt = typeInfo.ext || urlMediaExt(url) || (typeInfo.isSubtitle ? 'vtt' : (typeInfo.isAudio ? 'mp3' : (typeInfo.isHls ? 'm3u8' : 'mp4')));
      const filename = getCleanFilename(url, fallbackExt);

      if (chrome.downloads && chrome.downloads.download) {
        downloadBtn.textContent = '⏳ Saving...';
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: false
        }, (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.target = '_blank';
            a.click();
            triggerCopied(downloadBtn, '✓ Saved');
          } else {
            triggerCopied(downloadBtn, '✓ Saved');
          }
        });
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.target = '_blank';
        a.click();
        triggerCopied(downloadBtn, '✓ Saved');
      }
    });

    // 3. Mobile QR Code Button
    const qrBtn = document.createElement('button');
    qrBtn.className = 'action-btn btn-qr';
    qrBtn.innerHTML = '📱 QR';
    qrBtn.title = 'Show QR code to stream/open on mobile phone';

    qrBtn.addEventListener('click', () => {
      try {
        if (!window.QRCode) {
          console.error('QRCode generator script not loaded');
          return;
        }
        if (qrModalTitle) qrModalTitle.textContent = cardTitleFor(url) || 'Stream QR Code';
        if (qrCanvasContainer) {
          qrCanvasContainer.innerHTML = '';
          new QRCode(qrCanvasContainer, {
            text: url,
            width: 180,
            height: 180,
            colorDark: '#0f172a',
            colorLight: '#ffffff'
          });
        }
        if (qrModal) qrModal.classList.add('show');
      } catch (err) {
        console.error('Failed to generate QR code:', err);
      }
    });

    // 4. Copy Direct URL Button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn btn-copy';
    copyBtn.innerHTML = 'Copy';
    copyBtn.title = 'Copy direct URL';

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        triggerCopied(copyBtn, '✓ URL');
      });
    });

    // 5. Copy Piped (URL|Referer) Button
    const pipedBtn = document.createElement('button');
    pipedBtn.className = 'action-btn btn-piped';
    pipedBtn.innerHTML = '+ Ref';
    pipedBtn.title = 'Copy URL and Referer (URL|Ref)';

    pipedBtn.addEventListener('click', () => {
      const referer = refererOf();
      const payload = referer ? `${url}|${referer}` : url;
      navigator.clipboard.writeText(payload).then(() => {
        triggerCopied(pipedBtn, '✓ Copied');
      });
    });

    // 5b. Copy URL|Referer|Name Button
    const namedBtn = document.createElement('button');
    namedBtn.className = 'action-btn btn-piped';
    namedBtn.innerHTML = '+ Name';
    namedBtn.title = 'Copy URL, Referer and video name (URL|Ref|Name)';

    namedBtn.addEventListener('click', () => {
      const referer = refererOf();
      const payload = `${url}|${referer || ''}|${getVideoName(url)}`;
      navigator.clipboard.writeText(payload).then(() => {
        triggerCopied(namedBtn, '✓ Copied');
      });
    });

    // 6. Copy yt-dlp Command Button
    const ytdlpBtn = document.createElement('button');
    ytdlpBtn.className = 'action-btn btn-ytdlp';
    ytdlpBtn.innerHTML = 'yt-dlp';
    ytdlpBtn.title = 'Copy yt-dlp command with headers';

    if (typeInfo.isSegmented) {
      ytdlpBtn.innerHTML = 'ffmpeg';
      ytdlpBtn.title = 'Copy the ffmpeg command that assembles the exported .m3u8 into one file';
    }

    ytdlpBtn.addEventListener('click', () => {
      if (typeInfo.isSegmented) {
        const segMeta = segmentedByUrl.get(url);
        if (!segMeta) { triggerCopied(ytdlpBtn, '⚠️ Manifest not captured'); return; }
        navigator.clipboard.writeText(ffmpegCommand(segmentPlaylistName(url), segMeta)).then(() => triggerCopied(ytdlpBtn, '✓ Cmd'));
        return;
      }
      const referer = refererOf();
      let cmd = `yt-dlp`;
      if (referer) {
        try {
          const origin = new URL(referer).origin;
          cmd += ` --add-header "Referer: ${shellSafeUrl(referer)}" --add-header "Origin: ${shellSafeUrl(origin)}"`;
        } catch (e) {
          cmd += ` --add-header "Referer: ${shellSafeUrl(referer)}"`;
        }
      }
      cmd += ` "${shellSafeUrl(url)}"`;

      navigator.clipboard.writeText(cmd).then(() => {
        triggerCopied(ytdlpBtn, '✓ Cmd');
      });
    });

    let previewBox = null;

    // Video Preview Toggle Handler with Hls.js player engine
    previewBtn.addEventListener('click', () => {
      if (previewBox) {
        if (activeHlsPlayers.has(cardId)) {
          const hls = activeHlsPlayers.get(cardId);
          try { hls.destroy(); } catch (e) {}
          activeHlsPlayers.delete(cardId);
        }
        previewBox.remove();
        previewBox = null;
        previewBtn.innerHTML = '▶ Play';
        previewBtn.classList.remove('active');
      } else {
        const poster = posterOf();
        const startPlayback = () => {
          previewBox = document.createElement('div');
          previewBox.className = 'preview-player-box';

          if (typeInfo.isAudio) {
            const audioEl = document.createElement('audio');
            audioEl.controls = true;
            audioEl.autoplay = true;
            audioEl.src = url;
            previewBox.appendChild(audioEl);

            if (typeInfo.isDrm) {
              audioEl.addEventListener('error', () => {
                const note = document.createElement('div');
                note.className = 'preview-note preview-note-error';
                note.style.color = '#fca5a5';
                note.innerHTML = `🔒 <strong>DRM-protected</strong>: the popup player can't decrypt this ${typeInfo.drmProvider} stream.<br>Play it in a DRM-capable player instead.`;
                if (!previewBox.querySelector('.preview-note-error')) {
                  previewBox.appendChild(note);
                }
              });
            }
          } else {
            const videoEl = document.createElement('video');
            videoEl.controls = true;
            videoEl.playsInline = true;
            if (poster) videoEl.poster = poster;

            const attemptPlay = () => {
              const p = videoEl.play();
              if (p && typeof p.then === 'function') {
                p.catch(() => {
                  videoEl.muted = true;
                  videoEl.play().catch(() => {});
                });
              }
            };

            const isHlsStream = url.includes('.m3u8') || url.includes('format=hls') || url.includes('format=m3u8') || url.includes('/hls/') || typeInfo.isHls;

            if (isHlsStream && window.Hls && Hls.isSupported()) {
              const hls = new Hls({
                enableWorker: false,
                lowLatencyMode: false,
                backBufferLength: 90
              });
              activeHlsPlayers.set(cardId, hls);

              hls.loadSource(url);
              hls.attachMedia(videoEl);
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                attemptPlay();
              });
              let networkRetryCount = 0;
              hls.on(Hls.Events.ERROR, (event, data) => {
                console.warn('HLS stream event:', data);
                if (data.fatal) {
                  switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                      networkRetryCount++;
                      if (networkRetryCount <= 2) {
                        console.warn(`HLS Network error (${data.details}), retrying (${networkRetryCount}/2)...`);
                        hls.startLoad();
                      } else {
                        try { hls.destroy(); } catch (e) {}
                        activeHlsPlayers.delete(cardId);
                        const errBox = document.createElement('div');
                        errBox.className = 'preview-note preview-note-error';
                        errBox.style.color = '#fca5a5';
                        errBox.innerHTML = `⚠️ <strong>Stream Playback Blocked</strong>: Server rejected browser popup connection (403/CORS).<br>Use <strong>[⬇ Save]</strong> to download directly, or copy with <strong>[+ Ref]</strong> / <strong>[yt-dlp]</strong>.`;
                        if (!previewBox.querySelector('.preview-note-error')) {
                          previewBox.appendChild(errBox);
                        }
                      }
                      break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                      console.warn('HLS Media error, attempting recovery...');
                      hls.recoverMediaError();
                      break;
                    default:
                      try { hls.destroy(); } catch (e) {}
                      activeHlsPlayers.delete(cardId);
                      const errBox = document.createElement('div');
                      errBox.className = 'preview-note preview-note-error';
                      errBox.style.color = '#fca5a5';
                      errBox.innerHTML = `⚠️ <strong>Stream Key Error</strong>: This stream uses protected session keys or tokens.<br>Use <strong>[⬇ Save]</strong> to download directly, or copy with <strong>[+ Ref]</strong> / <strong>[yt-dlp]</strong>.`;
                      if (!previewBox.querySelector('.preview-note-error')) {
                        previewBox.appendChild(errBox);
                      }
                      break;
                  }
                }
              });
            } else {
              videoEl.src = url;
              videoEl.addEventListener('canplay', () => {
                attemptPlay();
              }, { once: true });
              videoEl.addEventListener('error', (e) => {
                console.warn('Video element error:', e, videoEl.error);
                const errBox = document.createElement('div');
                errBox.className = 'preview-note preview-note-error';
                errBox.style.color = '#fca5a5';
                errBox.innerHTML = `⚠️ <strong>Media Error</strong>: Server rejected direct playback.<br>Use <strong>[⬇ Save]</strong> or copy with <strong>[+ Ref]</strong> / <strong>[yt-dlp]</strong>.`;
                if (!previewBox.querySelector('.preview-note-error')) {
                  previewBox.appendChild(errBox);
                }
              });
            }

            previewBox.appendChild(videoEl);

            if (typeInfo.isDash) {
              const note = document.createElement('div');
              note.className = 'preview-note';
              note.textContent = 'DASH Stream (.mpd): For best quality & multi-track audio, use [yt-dlp] or [⬇ Save].';
              previewBox.appendChild(note);
            }
          }

          card.appendChild(previewBox);
          previewBtn.innerHTML = '⏹ Stop';
          previewBtn.classList.add('active');
        };

        chrome.runtime.sendMessage({
          action: 'preparePreview',
          mediaUrl: url,
          refererUrl: refererOf()
        }, () => {
          startPlayback();
        });
      }
    });

    // 1. Top row: Checkbox + Thumbnail + Info
    cardTop.appendChild(cardCheckbox);
    cardTop.appendChild(thumbBox);
    cardTop.appendChild(cardInfo);
    card.appendChild(cardTop);

    // 2. Action bar: Play, Save, QR, Copy, +Ref, +Name, yt-dlp
    const actionsBar = document.createElement('div');
    actionsBar.className = 'card-actions-bar';
    actionsBar.appendChild(previewBtn);
    actionsBar.appendChild(downloadBtn);
    actionsBar.appendChild(qrBtn);
    actionsBar.appendChild(copyBtn);
    actionsBar.appendChild(pipedBtn);
    actionsBar.appendChild(namedBtn);
    actionsBar.appendChild(ytdlpBtn);
    card.appendChild(actionsBar);

    showThumb();
    showTitle();
    fillTags();
    showVariants();

    // false = the link changed kind (e.g. it is now a grouped stream) and the card must be rebuilt; a card with a
    // running preview is only patched
    const refresh = (item) => {
      if (!item) return true;
      const now = getMediaType(url);
      if (!previewBox && (now.category !== typeInfo.category || !!now.isSegmented !== !!typeInfo.isSegmented)) return false;
      const selected = selectedUrls.has(url); // Best only may have changed it
      cardCheckbox.checked = selected;
      card.classList.toggle('is-selected', selected);
      card.classList.toggle('not-selected', !selected);
      showThumb();
      showTitle();
      fillTags();
      showVariants();
      return true;
    };
    const destroy = () => {
      if (!activeHlsPlayers.has(cardId)) return;
      try { activeHlsPlayers.get(cardId).destroy(); } catch (e) {}
      activeHlsPlayers.delete(cardId);
    };
    cardRefs.set(url, { card, refresh, destroy });
    return card;
  }

  // File size of a direct media link from a HEAD request, once per link; its card is re-drawn when it is known
  const sizeRequests = new Set();
  function requestMediaSize(url) {
    if (probedSizes.has(url) || sizeRequests.has(url)) return;
    sizeRequests.add(url);
    chrome.runtime.sendMessage({ action: 'probeMediaSize', mediaUrl: url }, (res) => {
      sizeRequests.delete(url);
      const size = (!chrome.runtime.lastError && res && res.size > 0) ? res.size : 0;
      probedSizes.set(url, size);
      if (size > 0) scheduleRelayout(); // shows the size; a tiny file moves to the Short tab
    });
  }

  // ---- Names the page gives its videos ----------------------------------------------------------
  // Reads the page's name and its per-video names (top frame, as before), plus per-video names inside embedded
  // frames. Fails silently on chrome:// and store pages.
  function readNames() {
    if (!chrome.scripting || currentTabId === undefined) return;
    const tabId = currentTabId;
    chrome.scripting.executeScript({ target: { tabId: tabId }, func: readPageVideoName }, (results) => {
      if (chrome.runtime.lastError || !results || !results[0] || !results[0].result || tabId !== currentTabId) return;
      const { name, siteName, mediaNames, sessionNames } = results[0].result;
      currentSiteName = siteName || '';
      currentVideoName = tidyTitle(name, siteName);
      topMediaNames = Array.isArray(mediaNames) ? mediaNames : [];
      topSessionNames = Array.isArray(sessionNames) ? sessionNames : [];
      pageMediaNames = buildMediaNames([topMediaNames, frameMediaNames], [topSessionNames, frameSessionNames]);
      refreshAllCards();
    });
    chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, func: readPageVideoName }, (results) => {
      if (chrome.runtime.lastError || !results || tabId !== currentTabId) return;
      frameMediaNames = [];
      frameSessionNames = [];
      results.forEach((r) => {
        if (r && r.frameId !== 0 && r.result && Array.isArray(r.result.mediaNames)) frameMediaNames.push(...r.result.mediaNames);
        if (r && r.frameId !== 0 && r.result && Array.isArray(r.result.sessionNames)) frameSessionNames.push(...r.result.sessionNames);
      });
      pageMediaNames = buildMediaNames([topMediaNames, frameMediaNames], [topSessionNames, frameSessionNames]);
      refreshAllCards();
    });
  }

  let nameScanTimer = null;
  function scheduleNameScan(delay = 600) {
    clearTimeout(nameScanTimer);
    nameScanTimer = setTimeout(readNames, delay);
  }

  // ---- Live list ---------------------------------------------------------------------------------
  // The background worker saves a tab's list whenever it changes: while the popup is open, follow those saves
  let liveTimer = null;
  function scheduleLiveRefresh() {
    if (liveTimer || currentTabId === undefined) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      const tabId = currentTabId;
      chrome.runtime.sendMessage({ action: 'getLinks', tabId: tabId }, (res) => {
        if (chrome.runtime.lastError || !res || tabId !== currentTabId) return;
        const known = new Set(currentLinks.map((item) => item.url));
        currentTabDrm = res.drm || null;
        applyLiveLinks(res.links || [], res.pageUrl || currentPageUrl);
        if (currentLinks.some((item) => !known.has(item.url))) scheduleNameScan(); // new videos may have names of their own
      });
    }, 400);
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (currentTabId === undefined) return;
      if (changes[`tab_videos_${currentTabId}`] || changes[`tab_drm_${currentTabId}`]) scheduleLiveRefresh();
    });
  }

  // The tab moved to another page (or renamed itself) while the popup is open: follow it
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== currentTabId) return;
    if (changeInfo.url !== undefined) {
      currentPageUrl = (tab && tab.url) || changeInfo.url || currentPageUrl;
      currentVideoName = '';
      topMediaNames = [];
      frameMediaNames = [];
      topSessionNames = [];
      frameSessionNames = [];
      pageMediaNames = { exact: new Map(), byPath: new Map() };
    }
    if (changeInfo.title !== undefined) currentPageTitle = changeInfo.title || '';
    if (changeInfo.url !== undefined || changeInfo.title !== undefined) {
      refreshAllCards();
      scheduleNameScan();
      scheduleLiveRefresh();
    }
    if (changeInfo.status === 'complete') scheduleNameScan();
  });

  // Expiry countdowns move on while the popup stays open
  setInterval(refreshAllCards, 60000);

  // Request links for active tab
  function requestLinks() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      currentTabId = tabs[0].id;
      currentPageUrl = tabs[0].url || '';
      currentPageTitle = tabs[0].title || '';

      // Read the video names from the page's metadata
      scheduleNameScan(0);

      chrome.runtime.sendMessage({ action: 'getLinks', tabId: currentTabId }, (response) => {
        if (chrome.runtime.lastError) {
          renderLinks([], currentPageUrl);
        } else if (response) {
          if (response.mobileScanMode && mobileModeSelect) {
            mobileModeSelect.value = response.mobileScanMode;
          }
          currentTabDrm = response.drm || null;
          renderLinks(response.links || [], response.pageUrl || currentPageUrl);
        }
      });

      // Trigger page content scan
      chrome.tabs.sendMessage(currentTabId, { action: 'forceContentScan' }, () => {
        if (!chrome.runtime.lastError) {
          chrome.runtime.sendMessage({ action: 'getLinks', tabId: currentTabId }, (res) => {
            if (res) {
              currentTabDrm = res.drm || null;
              applyLiveLinks(res.links || [], res.pageUrl || currentPageUrl);
            }
          });
        }
      });
    });
  }

  // Search input handler
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      clearSearchBtn.style.display = searchQuery ? 'block' : 'none';
      renderLinks();
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      clearSearchBtn.style.display = 'none';
      renderLinks();
    });
  }

  // Sort select handler
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      currentSortMode = sortSelect.value || 'quality';
      renderLinks();
    });
  }

  // Master Select All / Deselect All checkbox handler
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', () => {
      const visible = getFilteredLinks();
      if (selectAllCheckbox.checked) {
        visible.forEach(item => {
          const u = typeof item === 'string' ? item : item.url;
          selectedUrls.add(u);
        });
      } else {
        visible.forEach(item => {
          const u = typeof item === 'string' ? item : item.url;
          selectedUrls.delete(u);
        });
      }
      // chosen by hand: Best only leaves these alone
      visible.forEach((item) => { userTouched.add(item.url); autoUnticked.delete(item.url); });
      renderLinks();
    });
  }

  // Filter pills click handler
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeFilter = pill.getAttribute('data-filter');
      renderLinks();
    });
  });

  // Export Dropdown menu toggle
  if (exportDropdownBtn && exportMenu) {
    exportDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
      exportMenu.classList.remove('show');
    });
  }

  // QR Modal Close handlers
  if (qrCloseBtn && qrModal) {
    qrCloseBtn.addEventListener('click', () => {
      qrModal.classList.remove('show');
    });
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) {
        qrModal.classList.remove('show');
      }
    });
  }

  // Close QR Modal on ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && qrModal && qrModal.classList.contains('show')) {
      qrModal.classList.remove('show');
    }
  });

  // Export 1: yt-dlp Batch List (.txt) for selected items
  if (exportYtdlpTxt) {
    exportYtdlpTxt.addEventListener('click', () => {
      const selected = getSelectedLinks();
      if (selected.length === 0) {
        triggerCopied(exportDropdownBtn, '⚠️ 0 Selected');
        return;
      }

      let content = `# Video Link Extractor Pro - Batch Download List\n`;
      content += `# Usage: yt-dlp -a yt-dlp-batch.txt\n`;
      // yt-dlp reads every non-comment line of a batch file as a URL, so options cannot go in here
      content += `# yt-dlp only reads the URLs below. A link that needs its Referer: yt-dlp --add-header "Referer: <referer>" "<url>"\n\n`;

      selected.forEach(item => {
        const url = typeof item === 'string' ? item : item.url;
        if (getMediaType(url).isSegmented) {
          content += `# segmented stream (no single URL): use its "⬇ .m3u8" export with ffmpeg\n\n`;
          return;
        }
        const referer = (typeof item === 'object' && item.referer) ? item.referer : currentPageUrl;
        const drmInfo = getDrmInfo(item);
        if (drmInfo && drmInfo.type === 'drm') {
          // batch files ignore '#' lines; flag DRM streams so a failed download is not a mystery
          const systems = (drmInfo.systems || []).join(', ').replace(/[\r\n]/g, ' ');
          content += `# DRM-protected${systems ? ` (${systems})` : ''}: encrypted, yt-dlp cannot download this\n`;
        }
        if (referer) content += `# Referer: ${String(referer).replace(/[\r\n]/g, ' ')}\n`;
        content += `${url}\n\n`;
      });

      downloadBlob(content, `yt-dlp-batch-${Date.now()}.txt`, 'text/plain');
      triggerCopied(exportDropdownBtn, `✓ Exported (${selected.length})`);
    });
  }

  // Export 2: VLC / MPV Playlist (.m3u) for selected items
  if (exportM3u) {
    exportM3u.addEventListener('click', () => {
      const selected = getSelectedLinks();
      if (selected.length === 0) {
        triggerCopied(exportDropdownBtn, '⚠️ 0 Selected');
        return;
      }

      let content = `#EXTM3U\n`;
      selected.forEach((item) => {
        const url = typeof item === 'string' ? item : item.url;
        const typeInfo = getMediaType(url);
        if (typeInfo.isSegmented) return; // a segmented stream has its own playlist export
        const qualInfo = getStreamQuality(url);
        const qualLabel = qualInfo ? qualInfo.label : typeInfo.label;
        const filename = getCleanFilename(url);
        content += `#EXTINF:-1, [${qualLabel}] ${filename}\n${url}\n`;
      });

      downloadBlob(content, `playlist-${Date.now()}.m3u`, 'audio/x-mpegurl');
      triggerCopied(exportDropdownBtn, `✓ Exported (${selected.length})`);
    });
  }

  // Export 3: JSON Data (.json) for selected items
  if (exportJson) {
    exportJson.addEventListener('click', () => {
      const selected = getSelectedLinks();
      if (selected.length === 0) {
        triggerCopied(exportDropdownBtn, '⚠️ 0 Selected');
        return;
      }

      const exportData = selected.map(item => {
        const url = typeof item === 'string' ? item : item.url;
        const referer = (typeof item === 'object' && item.referer) ? item.referer : currentPageUrl;
        const poster = (typeof item === 'object' && item.poster) ? item.poster : '';
        const isMobile = (typeof item === 'object' && item.isMobile);
        const sizeBytes = getMediaSize(item);
        const typeInfo = getMediaType(url);
        const qualInfo = getStreamQuality(url);
        return {
          title: videoNameFor(url) || currentVideoName || currentPageTitle,
          url,
          quality: qualInfo ? qualInfo.label : typeInfo.label,
          sizeBytes: sizeBytes,
          sizeFormatted: formatFileSize(sizeBytes),
          referer,
          poster,
          isMobile,
          drm: getDrmInfo(item),
          segmented: segmentedByUrl.get(url) || null,
          type: typeInfo.label,
          category: typeInfo.category,
          durationSeconds: getDurationSec(item) || null,
          extractedAt: new Date().toISOString()
        };
      });

      downloadBlob(JSON.stringify(exportData, null, 2), `media-links-${Date.now()}.json`, 'application/json');
      triggerCopied(exportDropdownBtn, `✓ Exported (${selected.length})`);
    });
  }

  // Mobile Mode selector change listener
  if (mobileModeSelect) {
    mobileModeSelect.addEventListener('change', () => {
      chrome.runtime.sendMessage({
        action: 'setMobileMode',
        mode: mobileModeSelect.value
      });
    });
  }

  // Mobile Fallback scan button listener
  if (mobileScanBtn) {
    mobileScanBtn.addEventListener('click', () => {
      if (currentTabId === undefined) return;
      mobileScanBtn.classList.add('scanning');
      mobileScanBtn.textContent = '⏳ Scanning...';
      
      chrome.runtime.sendMessage({
        action: 'scanMobileFallback',
        tabId: currentTabId
      }, (response) => {
        mobileScanBtn.classList.remove('scanning');
        mobileScanBtn.textContent = '📱 Mobile';
        if (response && response.links) {
          renderLinks(response.links, currentPageUrl);
          if (response.addedCount > 0) {
            triggerCopied(mobileScanBtn, `✓ +${response.addedCount} Found!`);
          } else {
            triggerCopied(mobileScanBtn, '✓ No New Links');
          }
        }
      });
    });
  }

  // Copy Selected button handler (copies only checked/selected stream URLs)
  copyAllButton.addEventListener('click', () => {
    const selected = getSelectedLinks();
    if (selected.length === 0) {
      triggerCopied(copyAllButton, '⚠️ 0 Selected');
      return;
    }
    const allUrls = selected.map(item => typeof item === 'string' ? item : item.url);
    navigator.clipboard.writeText(allUrls.join('\n')).then(() => {
      triggerCopied(copyAllButton, `✓ ${selected.length} Copied!`);
    });
  });

  // Clear button handler
  clearButton.addEventListener('click', () => {
    if (currentTabId !== undefined) {
      chrome.runtime.sendMessage({ action: 'clearLinks', tabId: currentTabId }, (response) => {
        if (response && response.success) {
          selectedUrls.clear();
          seenUrls.clear();
          userTouched.clear();
          autoUnticked.clear();
          renderLinks([], currentPageUrl);
        }
      });
    }
  });

  // Initialize
  initTheme();
  initBestOnly();
  requestLinks();
});