document.addEventListener('DOMContentLoaded', () => {
  const linksContainer = document.getElementById('links-container');
  const statusEl = document.getElementById('status');
  const clearButton = document.getElementById('clearButton');
  const copyAllButton = document.getElementById('copyAllButton');
  const countBadge = document.getElementById('countBadge');
  
  let currentTabId;
  let currentLinks = [];
  let currentPageUrl = '';

  // Helper to categorize media type
  function getMediaType(url) {
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    if (cleanUrl.endsWith('.m3u8') || cleanUrl.endsWith('.m3u')) {
      return { label: 'HLS Stream', tagClass: 'tag-stream', isStream: true };
    }
    if (cleanUrl.endsWith('.mpd')) {
      return { label: 'DASH Stream', tagClass: 'tag-stream', isStream: true };
    }
    if (cleanUrl.endsWith('.mp3') || cleanUrl.endsWith('.wav') || cleanUrl.endsWith('.aac') || cleanUrl.endsWith('.flac') || cleanUrl.endsWith('.ogg') || cleanUrl.endsWith('.opus') || cleanUrl.endsWith('.m4a')) {
      return { label: 'Audio', tagClass: 'tag-audio', isAudio: true };
    }
    return { label: 'Video', tagClass: 'tag-video', isVideo: true };
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

  // Render list of links
  function renderLinks(linksData, pageUrl) {
    currentLinks = linksData || [];
    currentPageUrl = pageUrl || '';
    linksContainer.innerHTML = '';
    countBadge.textContent = currentLinks.length;

    if (currentLinks.length === 0) {
      linksContainer.style.display = 'none';
      copyAllButton.style.display = 'none';
      statusEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎬</div>
          <div><strong>No media streams detected yet.</strong></div>
          <div style="font-size: 12px; margin-top: 6px; opacity: 0.8;">Play a video or refresh the page to capture streams.</div>
        </div>
      `;
      return;
    }

    linksContainer.style.display = 'flex';
    copyAllButton.style.display = 'inline-flex';
    statusEl.innerHTML = '';

    currentLinks.forEach((item) => {
      const url = typeof item === 'string' ? item : item.url;
      const referer = (typeof item === 'object' && item.referer) ? item.referer : currentPageUrl;
      const typeInfo = getMediaType(url);

      const card = document.createElement('div');
      card.className = 'link-card';

      // Card Header / Info
      const cardTop = document.createElement('div');
      cardTop.className = 'card-top';

      const cardInfo = document.createElement('div');
      cardInfo.className = 'card-info';

      const tagRow = document.createElement('div');
      tagRow.className = 'tag-row';

      const typeBadge = document.createElement('span');
      typeBadge.className = `type-tag ${typeInfo.tagClass}`;
      typeBadge.textContent = typeInfo.label;
      tagRow.appendChild(typeBadge);

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

      const urlLink = document.createElement('a');
      urlLink.className = 'link-url';
      urlLink.href = url;
      urlLink.target = '_blank';
      urlLink.title = url;
      urlLink.textContent = url;

      cardInfo.appendChild(tagRow);
      cardInfo.appendChild(urlLink);

      // Card Actions
      const cardActions = document.createElement('div');
      cardActions.className = 'card-actions';

      // 1. Preview Button
      const previewBtn = document.createElement('button');
      previewBtn.className = 'action-btn btn-preview';
      previewBtn.innerHTML = '▶ Preview';
      previewBtn.title = 'Test play in popup (with auto-referer bypass)';

      // 2. Copy URL Button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'action-btn btn-copy';
      copyBtn.innerHTML = 'Copy';
      copyBtn.title = 'Copy direct URL only';

      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(url).then(() => {
          triggerCopied(copyBtn, '✓ URL');
        });
      });

      // 3. Copy yt-dlp Command Button
      const ytdlpBtn = document.createElement('button');
      ytdlpBtn.className = 'action-btn btn-ytdlp';
      ytdlpBtn.innerHTML = 'yt-dlp';
      ytdlpBtn.title = 'Copy complete yt-dlp command with headers';

      ytdlpBtn.addEventListener('click', () => {
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

      // 4. Copy Piped (URL|Referer) Button for batch script single paste
      const pipedBtn = document.createElement('button');
      pipedBtn.className = 'action-btn btn-piped';
      pipedBtn.innerHTML = '+ Ref';
      pipedBtn.title = 'Copy URL and Referer (URL|Ref) for 1-paste in downloader.bat';

      pipedBtn.addEventListener('click', () => {
        const payload = referer ? `${url}|${referer}` : url;
        navigator.clipboard.writeText(payload).then(() => {
          triggerCopied(pipedBtn, '✓ Copied');
        });
      });

      let previewBox = null;

      // Preview toggle with declarativeNetRequest referer rewrite
      previewBtn.addEventListener('click', () => {
        if (previewBox) {
          previewBox.remove();
          previewBox = null;
          previewBtn.innerHTML = '▶ Preview';
          previewBtn.classList.remove('active');
        } else {
          // Prepare preview referer rule in background
          chrome.runtime.sendMessage({
            action: 'preparePreview',
            mediaUrl: url,
            refererUrl: referer
          }, () => {
            previewBox = document.createElement('div');
            previewBox.className = 'preview-player-box';

            if (typeInfo.isAudio) {
              const audioEl = document.createElement('audio');
              audioEl.controls = true;
              audioEl.autoplay = true;
              audioEl.src = url;
              previewBox.appendChild(audioEl);
            } else {
              const videoEl = document.createElement('video');
              videoEl.controls = true;
              videoEl.autoplay = true;
              videoEl.playsInline = true;
              videoEl.src = url;
              previewBox.appendChild(videoEl);

              if (typeInfo.isStream) {
                const note = document.createElement('div');
                note.className = 'preview-note';
                note.textContent = 'Note: If preview cannot stream in Chromium, use the [yt-dlp] or [+ Ref] button to download.';
                previewBox.appendChild(note);
              }
            }

            card.appendChild(previewBox);
            previewBtn.innerHTML = '⏹ Close';
            previewBtn.classList.add('active');
          });
        }
      });

      cardActions.appendChild(previewBtn);
      cardActions.appendChild(pipedBtn);
      cardActions.appendChild(ytdlpBtn);
      cardActions.appendChild(copyBtn);

      cardTop.appendChild(cardInfo);
      cardTop.appendChild(cardActions);
      card.appendChild(cardTop);

      linksContainer.appendChild(card);
    });
  }

  // Request links for active tab
  function requestLinks() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      currentTabId = tabs[0].id;
      currentPageUrl = tabs[0].url || '';

      chrome.runtime.sendMessage({ action: 'getLinks', tabId: currentTabId }, (response) => {
        if (chrome.runtime.lastError) {
          renderLinks([], currentPageUrl);
        } else if (response) {
          renderLinks(response.links || [], response.pageUrl || currentPageUrl);
        }
      });

      // Also trigger content scan
      chrome.tabs.sendMessage(currentTabId, { action: 'forceContentScan' }, () => {
        if (!chrome.runtime.lastError) {
          chrome.runtime.sendMessage({ action: 'getLinks', tabId: currentTabId }, (res) => {
            if (res) {
              renderLinks(res.links || [], res.pageUrl || currentPageUrl);
            }
          });
        }
      });
    });
  }

  // Copy All button handler
  copyAllButton.addEventListener('click', () => {
    if (currentLinks.length === 0) return;
    const allUrls = currentLinks.map(item => typeof item === 'string' ? item : item.url);
    navigator.clipboard.writeText(allUrls.join('\n')).then(() => {
      triggerCopied(copyAllButton, '✓ All Copied!');
    });
  });

  // Clear button handler
  clearButton.addEventListener('click', () => {
    if (currentTabId !== undefined) {
      chrome.runtime.sendMessage({ action: 'clearLinks', tabId: currentTabId }, (response) => {
        if (response && response.success) {
          renderLinks([], currentPageUrl);
        }
      });
    }
  });

  // Initialize
  requestLinks();
});