// addon3-text.js - Shared by the third set of add-on modules (addon3-page.js in the page, addon3-content.js in the
// content-script world, addon3-worker.js in the background worker). Small readers for the text of documents that
// name media without being media playlists themselves:
//   - VAST ad answers (module 16): the ad files they list
//   - podcast / video feeds, RSS and Atom (module 17): the enclosures of their items
//   - .pls / .asx / .xspf playlists (module 17): the streams they list
// Nothing in here touches the page or the network.
(function (root) {
  if (root.__VLE_X3_TEXT__) return;

  const MEDIA_PATH = /\.(?:m3u8|mpd|mp4|webm|mkv|mov|m4v|ogv|flv|avi|wmv|3gp|mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus)$/i;
  const AUDIO_PATH = /\.(?:mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus)$/i;
  const MAX_TEXT = 2000000;

  const unxml = (s) => String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#0*38;/g, '&').replace(/&amp;/g, '&')
    .trim();

  function absUrl(raw, base) {
    try {
      const u = new URL(unxml(raw), base || undefined);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.href.length <= 4000 ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  // value of one attribute in the text between "<tag" and ">"
  function attrOf(attrs, name) {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs || '');
    return m ? unxml(m[1] !== undefined ? m[1] : m[2]) : '';
  }

  // What a text is, from its first characters: 'vast' | 'vmap' | 'rss' | 'atom' | 'pls' | 'asx' | 'xspf' | ''
  function kindOf(text) {
    if (typeof text !== 'string' || text.length < 12) return '';
    const head = text.slice(0, 3000).replace(/^﻿/, '');
    if (/^\s*\[playlist\]/i.test(head)) return 'pls';
    if (!/^\s*</.test(head)) return '';
    if (/<VAST[\s>]/.test(head)) return 'vast';
    if (/<(?:vmap:)?VMAP[\s>]/.test(head)) return 'vmap';
    if (/<rss[\s>]/i.test(head)) return 'rss';
    if (/<feed[\s>]/i.test(head) && /www\.w3\.org\/2005\/Atom/i.test(head)) return 'atom';
    if (/<asx[\s>]/i.test(head)) return 'asx';
    if (/<playlist\b[^>]*xspf\.org/i.test(head)) return 'xspf';
    return '';
  }

  // VAST: the media files of the ads it describes -> [url]
  function vastMedia(text, base) {
    const out = [];
    if (typeof text !== 'string' || text.length > MAX_TEXT) return out;
    const re = /<(MediaFile|Mezzanine)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(text)) !== null && out.length < 40) {
      const url = absUrl(m[2], base);
      if (url && !out.includes(url)) out.push(url);
    }
    return out;
  }

  const kindOfMedia = (type, url) => {
    const t = String(type || '').toLowerCase();
    if (t.startsWith('audio/')) return 'audio';
    if (t.startsWith('video/')) return 'video';
    let path = '';
    try { path = new URL(url).pathname; } catch (e) {}
    if (MEDIA_PATH.test(path)) return AUDIO_PATH.test(path) ? 'audio' : 'video';
    return /mpegurl|dash\+xml/.test(t) ? 'video' : ''; // anything else (an image, a page) is not media
  };

  // RSS / Atom: the media each item carries -> [{ url, kind: 'audio' | 'video' }], in the feed's order
  function feedMedia(text, base, max) {
    const out = [];
    const limit = max || 60;
    if (typeof text !== 'string' || text.length > MAX_TEXT) return out;
    const seen = new Set();
    const take = (rawUrl, type) => {
      if (out.length >= limit) return;
      const url = absUrl(rawUrl, base);
      const kind = url && !seen.has(url) ? kindOfMedia(type, url) : '';
      if (!kind) return;
      seen.add(url);
      out.push({ url: url, kind: kind });
    };
    const re = /<(enclosure|media:content|link)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(text)) !== null && out.length < limit) {
      const tag = m[1].toLowerCase();
      const a = m[2];
      if (tag === 'link') {
        if (attrOf(a, 'rel').toLowerCase() === 'enclosure') take(attrOf(a, 'href'), attrOf(a, 'type'));
      } else {
        const medium = attrOf(a, 'medium').toLowerCase();
        take(attrOf(a, 'url'), attrOf(a, 'type') || (medium === 'audio' || medium === 'video' ? `${medium}/x` : ''));
      }
    }
    return out;
  }

  // .pls / .asx / .xspf: the streams listed -> [url]
  function playlistUrls(text, base, kind) {
    const out = [];
    if (typeof text !== 'string' || text.length > MAX_TEXT) return out;
    const k = kind || kindOf(text);
    const re = k === 'pls' ? /^\s*File\d+\s*=\s*(\S.*)$/gim
      : k === 'asx' ? /<(?:ref|entryref)\b[^>]*?href\s*=\s*["']([^"']+)["']/gi
      : k === 'xspf' ? /<location>\s*([\s\S]*?)\s*<\/location>/gi
      : null;
    if (!re) return out;
    let m;
    while ((m = re.exec(text)) !== null && out.length < 30) {
      const url = absUrl(m[1], base);
      if (url && !out.includes(url)) out.push(url);
    }
    return out;
  }

  // The browser's own MessageEvent data getter, taken before add-on module 10 (addon2-page.js) wraps it: manifest.json
  // loads this file first. Module 13 reads the first WebSocket messages with it, so that module 10 still looks only
  // at what the page itself reads, as before.
  let messageData = null;
  try {
    const d = typeof MessageEvent === 'function' && Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    if (d && typeof d.get === 'function') messageData = d.get;
  } catch (e) {}

  Object.defineProperty(root, '__VLE_X3_TEXT__', {
    value: Object.freeze({ kindOf, vastMedia, feedMedia, playlistUrls, absUrl, attrOf, MEDIA_PATH, AUDIO_PATH, messageData }),
    enumerable: false,
    configurable: false
  });
})(globalThis);
