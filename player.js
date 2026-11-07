// player.js - The player tab (player.html), opened by ▶ Play when ⚙ Settings > "▶ Play opens" is "In a new tab".
// It plays the link the way the popup's player does (hls.js for HLS, the browser for files), with the link's
// Referer on its requests (a rule of this tab's own, set up by player-worker.js).
//   player.html?src=<link>&ref=<Referer>&title=<name>&poster=<image>&kind=hls|dash|audio|video&drm=<provider>
(function () {
  const params = new URLSearchParams(location.search);
  const src = params.get('src') || '';
  const ref = params.get('ref') || '';
  const title = params.get('title') || '';
  const poster = params.get('poster') || '';
  const kind = params.get('kind') || 'video';
  const drm = (params.get('drm') || '').replace(/[^\w .-]/g, '').slice(0, 40); // shown in a note: plain text only

  const stage = document.getElementById('stage');
  const notes = document.getElementById('notes');
  document.getElementById('title').textContent = title || src || 'Player';
  document.getElementById('linkText').textContent = src;
  document.getElementById('refText').textContent = ref || '(none)';
  if (title) document.title = `${title} - Player`;

  try {
    chrome.storage.local.get({ theme: 'midnight' }, (res) => {
      document.body.setAttribute('data-theme', (res && res.theme) || 'midnight');
    });
  } catch (e) {}

  // the same notes the popup player shows
  const note = (html, isError) => {
    if (isError && notes.querySelector('.error')) return;
    const el = document.createElement('div');
    el.className = isError ? 'note error' : 'note';
    el.innerHTML = html;
    notes.appendChild(el);
  };

  if (!/^https?:\/\//i.test(src)) {
    note('⚠️ <strong>No link to play.</strong>', true);
    return;
  }

  const start = () => {
    if (kind === 'audio') {
      const audioEl = document.createElement('audio');
      audioEl.controls = true;
      audioEl.autoplay = true;
      audioEl.src = src;
      stage.appendChild(audioEl);
      // Chrome may not let a tab start sound by itself before you click in it: say so instead of sitting silent
      const p = audioEl.play();
      if (p && typeof p.catch === 'function') p.catch((e) => { if (e && e.name === 'NotAllowedError') note('▶ Press play: Chrome only lets a tab start sound after you click in it.', false); });
      audioEl.addEventListener('error', () => {
        if (drm) note(`🔒 <strong>DRM-protected</strong>: this player can't decrypt this ${drm} stream.<br>Play it in a DRM-capable player instead.`, true);
        else note('⚠️ <strong>Media Error</strong>: Server rejected direct playback.<br>Use <strong>[⬇ Save]</strong> or copy with <strong>[+ Ref]</strong> / <strong>[yt-dlp]</strong> in the popup.', true);
      });
      return;
    }

    const videoEl = document.createElement('video');
    videoEl.controls = true;
    videoEl.playsInline = true;
    if (/^https?:\/\//i.test(poster)) videoEl.poster = poster;
    const attemptPlay = () => {
      const p = videoEl.play();
      if (p && typeof p.then === 'function') {
        p.catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => note('▶ Press play: Chrome did not let this tab start the video by itself.', false));
        });
      }
    };

    if (kind === 'hls' && window.Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false, lowLatencyMode: false, backBufferLength: 90 });
      hls.loadSource(src);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, attemptPlay);
      let networkRetryCount = 0;
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          networkRetryCount++;
          if (networkRetryCount <= 2) {
            hls.startLoad();
          } else {
            try { hls.destroy(); } catch (e) {}
            note('⚠️ <strong>Stream Playback Blocked</strong>: Server rejected the connection (403/CORS).<br>Use <strong>[⬇ Save]</strong> to download directly, or copy with <strong>[+ Ref]</strong> / <strong>[yt-dlp]</strong> in the popup.', true);
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          try { hls.destroy(); } catch (e) {}
          note('⚠️ <strong>Stream Key Error</strong>: This stream uses protected session keys or tokens.<br>Use <strong>[⬇ Save]</strong> to download directly, or copy with <strong>[+ Ref]</strong> / <strong>[yt-dlp]</strong> in the popup.', true);
        }
      });
      window.addEventListener('pagehide', () => { try { hls.destroy(); } catch (e) {} });
    } else {
      videoEl.src = src;
      videoEl.addEventListener('canplay', attemptPlay, { once: true });
      videoEl.addEventListener('error', () => {
        note('⚠️ <strong>Media Error</strong>: Server rejected direct playback.<br>Use <strong>[⬇ Save]</strong> or copy with <strong>[+ Ref]</strong> / <strong>[yt-dlp]</strong> in the popup.', true);
      });
    }
    stage.appendChild(videoEl);
    if (kind === 'dash') note('DASH Stream (.mpd): For best quality &amp; multi-track audio, use [yt-dlp] or [⬇ Save].', false);
  };

  // the link's Referer on this tab's requests first, then play (play anyway if that fails)
  try {
    chrome.runtime.sendMessage({ action: 'preparePlayerTab', mediaUrl: src, refererUrl: ref }, () => {
      void chrome.runtime.lastError;
      start();
    });
  } catch (e) {
    start();
  }
})();
