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
  let activeFilter = 'all';
  let searchQuery = '';
  let currentSortMode = 'quality'; // Default: Highest Quality First
  const selectedUrls = new Set(); // Stores explicitly selected URLs (all selected by default)
  const activeHlsPlayers = new Map(); // cardId -> Hls instance
  let currentTabDrm = null; // page-level DRM evidence from the background worker (EME usage, DRM manifests, ...)
  const drmProbed = new Set(); // link URLs already checked for DRM during this popup session
  const segmentedByUrl = new Map(); // entry url -> segmented-stream description (see background applySegmentedSignal)

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
    try {
      const parsed = new URL(url);
      const itag = parsed.searchParams.get('itag');
      if (itag && ITAG_MAP[itag]) {
        return ITAG_MAP[itag];
      }
      const pathLower = (parsed.pathname + parsed.search).toLowerCase();
      if (pathLower.includes('2160p') || pathLower.includes('4k')) {
        return { label: '4K (2160p)', tagClass: 'quality-tag quality-4k', score: 2160 };
      }
      if (pathLower.includes('1440p') || pathLower.includes('2k')) {
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
    return { category: 'video', label: 'Video', tagClass: 'tag-video', isVideo: true, icon: '🎥' };
  }

  // Infer clean filename for downloads & exports with page title support
  function getCleanFilename(url, fallbackExt = 'mp4') {
    try {
      if (currentPageTitle) {
        const sanitized = currentPageTitle.replace(/ - YouTube$/, '').replace(/[/\\?%*:|"<>]/g, '_').trim();
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

  // A probe finished for a link that is already on screen: patch its card in place (keeps running previews alive)
  function refreshCardDrm(item) {
    const card = Array.from(linksContainer.querySelectorAll('.link-card')).find((c) => c.dataset.url === item.url);
    const tagRow = card && card.querySelector('.tag-row');
    if (tagRow) appendDrmBadges(tagRow, item, getMediaType(item.url));
    updateFilterCounts(currentLinks);
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

  // Ask the background worker to check listed links for DRM (reads a manifest / the first 64 KB of a file).
  // Results are stored per link, so each link is only ever checked once.
  function scheduleDrmProbes() {
    if (currentTabId === undefined) return;
    currentLinks.forEach((item) => {
      const url = item && item.url;
      if (!url || item.drmChecked || drmProbed.has(url)) return;
      if (getMediaType(url).category === 'subtitle' || /\.(?:mp3|wav|aac|flac|ogg|opus)(?:[?#]|$)/i.test(url)) return;
      if (drmProbed.size >= 60) return;
      drmProbed.add(url);
      chrome.runtime.sendMessage({ action: 'probeDrm', tabId: currentTabId, url: url }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const cur = currentLinks.find((i) => i.url === url);
        if (!cur) return;
        if (res.checked) cur.drmChecked = true;
        if (res.drm) {
          cur.drm = res.drm;
          refreshCardDrm(cur);
        }
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

  function ffmpegCommand(playlistName, seg) {
    const out = playlistName.replace(/\.m3u8$/i, '') + (seg.kind === 'audio' ? '.m4a' : '.mp4');
    return `ffmpeg -protocol_whitelist file,http,https,tcp,tls,crypto -allowed_extensions ALL -i "${playlistName}" -c copy "${out}"`;
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
    let drmCount = 0;

    links.forEach(item => {
      const url = typeof item === 'string' ? item : item.url;
      const typeInfo = getMediaType(url);
      if (typeInfo.category === 'stream') streams++;
      else if (typeInfo.category === 'audio') audio++;
      else if (typeInfo.category === 'subtitle') subtitles++;
      else videos++;
      if (isDrmConfirmed(item)) drmCount++;
    });

    filterAllCount.textContent = links.length;
    filterStreamCount.textContent = streams;
    filterVideoCount.textContent = videos;
    filterAudioCount.textContent = audio;
    if (filterSubtitleCount) filterSubtitleCount.textContent = subtitles;
    if (filterDrmCount) filterDrmCount.textContent = drmCount;
  }

  // Filter and sort links (Highest Quality First by default)
  function getFilteredLinks() {
    const list = currentLinks.filter(item => {
      const url = typeof item === 'string' ? item : item.url;
      const referer = (typeof item === 'object' && item.referer) ? item.referer : '';
      const typeInfo = getMediaType(url);

      // 1. Pill Filter ('drm' is a cross-category filter: any link confirmed as DRM-protected)
      if (activeFilter === 'drm') {
        if (!isDrmConfirmed(item)) return false;
      } else if (activeFilter !== 'all' && typeInfo.category !== activeFilter) {
        return false;
      }

      // 2. Search Query Filter
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesUrl = url.toLowerCase().includes(q);
        const matchesRef = referer.toLowerCase().includes(q);
        const matchesTitle = currentPageTitle.toLowerCase().includes(q);
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

  // Render list of links
  function renderLinks(linksData, pageUrl) {
    if (linksData !== undefined) {
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
      segmentedByUrl.clear();
      currentLinks.forEach((item) => { if (item && item.segmented) segmentedByUrl.set(item.url, item.segmented); });

      // Select all by default on first load or when new items arrive
      currentLinks.forEach(item => {
        const u = typeof item === 'string' ? item : item.url;
        selectedUrls.add(u);
      });
    }
    if (pageUrl !== undefined) {
      currentPageUrl = pageUrl || '';
    }

    renderDrmBanner();

    // Clean up active Hls player instances
    activeHlsPlayers.forEach(hls => {
      try { hls.destroy(); } catch (e) {}
    });
    activeHlsPlayers.clear();

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
          <div style="font-size: 12px; margin-top: 6px; opacity: 0.85;">Play a video or use <strong>📱 Mobile Scan</strong> to check for direct streams.</div>
          ${currentTabDrm ? '<div style="font-size: 12px; margin-top: 6px; opacity: 0.85;">🔒 This page uses DRM, but has not exposed a stream URL yet. Start playback and reopen this popup.</div>' : ''}
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
      linksContainer.innerHTML = `
        <div class="no-results">
          🔍 No media found matching "<strong>${searchQuery}</strong>" in ${activeFilter.toUpperCase()}.
        </div>
      `;
      updateSelectionUI();
      return;
    }

    filtered.forEach((item, index) => {
      const url = typeof item === 'string' ? item : item.url;
      const referer = (typeof item === 'object' && item.referer) ? item.referer : currentPageUrl;
      const poster = (typeof item === 'object' && item.poster) ? item.poster : '';
      const isMobile = (typeof item === 'object' && item.isMobile);
      const sizeBytes = getMediaSize(item);
      const typeInfo = getMediaType(url);
      const qualityInfo = getStreamQuality(url);
      const isSelected = selectedUrls.has(url);
      const cardId = `card_${index}_${Date.now()}`;

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

      if (poster) {
        chrome.runtime.sendMessage({
          action: 'preparePreview',
          mediaUrl: poster,
          refererUrl: referer
        }, () => {
          const img = document.createElement('img');
          img.alt = 'Thumbnail';
          img.src = poster;
          img.onerror = () => {
            img.remove();
            thumbBox.innerHTML = `<span class="thumb-placeholder">${typeInfo.icon}</span>`;
          };
          thumbBox.appendChild(img);
        });
      } else {
        thumbBox.innerHTML = `<span class="thumb-placeholder">${typeInfo.icon}</span>`;
      }

      const cardInfo = document.createElement('div');
      cardInfo.className = 'card-info';

      const tagRow = document.createElement('div');
      tagRow.className = 'tag-row';

      const typeBadge = document.createElement('span');
      typeBadge.className = `type-tag ${typeInfo.tagClass}`;
      typeBadge.textContent = typeInfo.label;
      tagRow.appendChild(typeBadge);

      // DRM / encryption badges (from manifest / file-header analysis, or the URL itself)
      appendDrmBadges(tagRow, item, typeInfo);

      if (typeInfo.isSegmented) {
        const segMeta = segmentedByUrl.get(url);
        const segBadge = document.createElement('span');
        segBadge.className = 'type-tag tag-seg';
        segBadge.textContent = segMeta ? `🧩 ${segMeta.count} segments${segMeta.endMs ? ` · ${formatDuration(segMeta.endMs)}` : ''}` : '🧩 Segmented';
        segBadge.title = segMeta && segMeta.generic
          ? `One stream fetched as numbered pieces (${segMeta.observed} seen), listed once. Range and durations are inferred from the requests. Use "⬇ .m3u8" to export.`
          : 'One stream delivered as many small pieces, listed once. Use "⬇ .m3u8" to export the full segment list.';
        tagRow.appendChild(segBadge);
      }

      // Smart Quality/Resolution badge (show only if distinct from type badge)
      if (qualityInfo && qualityInfo.label !== typeInfo.label && qualityInfo.label !== 'Video' && qualityInfo.label !== 'Audio' && qualityInfo.label !== 'Subtitle') {
        const qualityBadge = document.createElement('span');
        qualityBadge.className = qualityInfo.tagClass;
        qualityBadge.textContent = qualityInfo.label;
        tagRow.appendChild(qualityBadge);
      }

      // File Size Badge
      if (sizeBytes > 0) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'size-badge';
        sizeSpan.textContent = `📦 ${formatFileSize(sizeBytes)}`;
        tagRow.appendChild(sizeSpan);
      } else if (!typeInfo.isStream && !typeInfo.isSegmented) {
        // Probe size asynchronously in background for direct media files
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'size-badge';
        chrome.runtime.sendMessage({ action: 'probeMediaSize', mediaUrl: url }, (res) => {
          if (res && res.size > 0) {
            item.size = res.size;
            sizeSpan.textContent = `📦 ${formatFileSize(res.size)}`;
            if (!sizeSpan.parentNode) {
              tagRow.appendChild(sizeSpan);
            }
          }
        });
      }

      if (isMobile) {
        const mobileBadge = document.createElement('span');
        mobileBadge.className = 'type-tag tag-mobile';
        mobileBadge.textContent = '📱 Mobile Direct';
        tagRow.appendChild(mobileBadge);
      }

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

      // Title Display
      let cleanTitle = '';
      if (currentPageTitle) {
        cleanTitle = currentPageTitle.replace(/ - YouTube$/, '').trim();
        const titleEl = document.createElement('div');
        titleEl.className = 'card-title';
        titleEl.textContent = cleanTitle;
        titleEl.title = cleanTitle;
        cardInfo.appendChild(titleEl);
      }

      const urlLink = document.createElement('a');
      urlLink.className = 'link-url';
      urlLink.href = url;
      urlLink.target = '_blank';
      urlLink.title = url;
      urlLink.textContent = url;

      cardInfo.appendChild(tagRow);
      cardInfo.appendChild(urlLink);

      // Card Actions
      // 1. Video Preview Button
      const previewBtn = document.createElement('button');
      previewBtn.className = 'action-btn btn-preview';
      previewBtn.innerHTML = '▶ Play';
      previewBtn.title = 'Test play live stream / media in popup';
      if (typeInfo.isSegmented) previewBtn.style.display = 'none'; // a single piece is not playable on its own

      // 2. Direct Download Button
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'action-btn btn-download';
      downloadBtn.innerHTML = '⬇ Save';
      downloadBtn.title = 'Download file directly to browser';

      if (typeInfo.isSegmented) {
        downloadBtn.innerHTML = '⬇ .m3u8';
        downloadBtn.title = 'Export an .m3u8 playlist with every segment of this stream (open it with ffmpeg / VLC / mpv)';
      }

      downloadBtn.addEventListener('click', () => {
        if (typeInfo.isSegmented) {
          const segMeta = segmentedByUrl.get(url);
          if (!segMeta) { triggerCopied(downloadBtn, '⚠️ Manifest not captured'); return; }
          const name = getCleanFilename(url, 'm3u8');
          downloadBlob(buildSegmentPlaylist(segMeta, name), name, 'application/vnd.apple.mpegurl');
          triggerCopied(downloadBtn, '✓ Playlist');
          return;
        }
        const fallbackExt = typeInfo.ext || (typeInfo.isSubtitle ? 'vtt' : (typeInfo.isAudio ? 'mp3' : (typeInfo.isHls ? 'm3u8' : 'mp4')));
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
          if (qrModalTitle) qrModalTitle.textContent = cleanTitle || 'Stream QR Code';
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
        const payload = referer ? `${url}|${referer}` : url;
        navigator.clipboard.writeText(payload).then(() => {
          triggerCopied(pipedBtn, '✓ Copied');
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
          navigator.clipboard.writeText(ffmpegCommand(getCleanFilename(url, 'm3u8'), segMeta)).then(() => triggerCopied(ytdlpBtn, '✓ Cmd'));
          return;
        }
        let cmd = `yt-dlp`;
        if (referer) {
          try {
            const origin = new URL(referer).origin;
            cmd += ` --add-header "Referer: ${referer}" --add-header "Origin: ${origin}"`;
          } catch (e) {
            cmd += ` --add-header "Referer: ${referer}"`;
          }
        }
        cmd += ` "${url}"`;

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
            refererUrl: referer
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

      // 2. Action bar: Play, Save, QR, Copy, +Ref, yt-dlp
      const actionsBar = document.createElement('div');
      actionsBar.className = 'card-actions-bar';
      actionsBar.appendChild(previewBtn);
      actionsBar.appendChild(downloadBtn);
      actionsBar.appendChild(qrBtn);
      actionsBar.appendChild(copyBtn);
      actionsBar.appendChild(pipedBtn);
      actionsBar.appendChild(ytdlpBtn);
      card.appendChild(actionsBar);

      linksContainer.appendChild(card);
    });

    updateSelectionUI();
    if (linksData !== undefined) scheduleDrmProbes();
  }

  // Request links for active tab
  function requestLinks() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      currentTabId = tabs[0].id;
      currentPageUrl = tabs[0].url || '';
      currentPageTitle = tabs[0].title || '';

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
              renderLinks(res.links || [], res.pageUrl || currentPageUrl);
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
      content += `# Usage: yt-dlp -a yt-dlp-batch.txt\n\n`;

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
        if (referer) {
          try {
            const origin = new URL(referer).origin;
            content += `--add-header "Referer: ${referer}" --add-header "Origin: ${origin}"\n`;
          } catch (e) {
            content += `--add-header "Referer: ${referer}"\n`;
          }
        }
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
          title: currentPageTitle,
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
          renderLinks([], currentPageUrl);
        }
      });
    }
  });

  // Initialize
  initTheme();
  requestLinks();
});