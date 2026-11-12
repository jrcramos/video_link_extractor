// Browser test: the committed version (git HEAD, or VLE_OLD=<folder>) against this working copy, each loaded unpacked in
// its own Playwright Chromium, on the same local test pages. Checks that:
//   - every link the old version stores is stored by the new one with identical fields (only new links are added)
//   - the popup shows every old card the same way (title, badges, buttons), and the JSON export keeps every old field
//   - the add-on modules 12-22 find what the test pages hold
//   - no script error in the extension's worker / popup, and none more in the pages than before
// Run: node tests/run.js            (needs: git, Node 18+, Playwright's Chromium or VLE_CHROME=<chrome.exe>)
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('./server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.VLE_CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
const PORT = Number(process.env.VLE_PORT) || 8765;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const X3_SOURCES = new Set(['stream', 'radio', 'playlist', 'feed', 'resolved']);

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else fail(msg); return !!cond; };

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.calls = new Map();
    this.handlers = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.calls.has(m.id)) {
        const c = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (m.error) c.reject(new Error(`${c.method}: ${m.error.message}`)); else c.resolve(m.result);
      } else {
        this.handlers.forEach((h) => h(m));
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.calls.set(id, { resolve, reject, method }));
  }
  on(fn) { this.handlers.push(fn); }
}

async function launch(name, extDir, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vle-prof-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run',
    '--no-default-browser-check', '--disable-features=DownloadBubble', 'about:blank'
  ], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (e) { await sleep(250); }
  }
  if (!ver) throw new Error(`${name}: browser did not start`);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new Cdp(ws);
  const errors = []; // script errors: { where, text }
  const sessions = new Map(); // sessionId -> label
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push({ where: sessions.get(m.sessionId) || '?', text: (d.exception && d.exception.description) || d.text });
    }
  });
  const evalIn = async (sessionId, expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };
  let worker = null;
  const findWorker = async () => {
    worker = null;
    for (let i = 0; i < 60 && !worker; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const t of targetInfos.filter((x) => x.type === 'service_worker' && x.url.endsWith('/background.js'))) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const name = await evalIn(sessionId, "typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : ''").catch(() => '');
        if (name !== 'Video Link Extractor Pro') { await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); continue; }
        sessions.set(sessionId, 'worker');
        await cdp.send('Runtime.enable', {}, sessionId);
        worker = { sessionId, targetId: t.targetId, extId: new URL(t.url).host };
        break;
      }
      if (!worker) await sleep(250);
    }
    return worker;
  };
  // (a worker just starting may not have its extension context yet, and the browser has workers of its own)
  await findWorker();
  if (!worker) throw new Error(`${name}: extension worker not found`);
  const attach = async (targetId, label) => {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessions.set(sessionId, label);
    await cdp.send('Runtime.enable', {}, sessionId);
    return sessionId;
  };
  return {
    name, cdp, errors, evalIn, attach,
    get worker() { return worker; },
    evalW: (e) => evalIn(worker.sessionId, e),
    // stops the extension's worker as Chrome does after ~30 s idle; it starts again on the next event
    stopWorker: async () => {
      await cdp.send('Target.closeTarget', { targetId: worker.targetId }).catch(() => {});
      await sleep(1500);
    },
    findWorker,
    close: async () => { try { await cdp.send('Browser.close'); } catch (e) {} try { proc.kill(); } catch (e) {} await sleep(500); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
  };
}

// One test page in a new tab: its stored links after the page settled and the popup's scan, then after the popup's
// per-link checks (DRM / qualities / length)
async function runPage(b, url, waitMs) {
  const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await b.attach(targetId, `page ${url}`);
  await b.cdp.send('Page.enable', {}, sessionId);
  await b.cdp.send('Page.navigate', { url }, sessionId);
  await sleep(waitMs);
  const tabId = await b.evalW(`chrome.tabs.query({}).then((ts) => (ts.find((t) => t.url === ${JSON.stringify(url)}) || {}).id)`);
  if (!Number.isInteger(tabId)) throw new Error(`${b.name}: no tab for ${url}`);
  await b.evalW(`new Promise((r) => chrome.tabs.sendMessage(${tabId}, { action: 'forceContentScan' }, () => { void chrome.runtime.lastError; r(); }))`);
  await sleep(2500);
  const scanned = await b.evalW(`getTabLinks(${tabId})`);
  await b.evalW(`Promise.all((videoLinks.get(${tabId}) ? Array.from(videoLinks.get(${tabId}).values()) : []).map((l) => probeLinkDrm(${tabId}, l.url).catch(() => null)))`);
  await sleep(1500);
  const probed = await b.evalW(`getTabLinks(${tabId})`);
  return { targetId, sessionId, tabId, scanned, probed };
}

const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const entryKey = (e) => (e.groupKey && e.groupKey.startsWith('mse:') ? `mse:${e.url}` : (e.groupKey || e.url));
const clean = (e) => {
  const c = { ...e };
  delete c.timestamp;
  if (c.groupKey && c.groupKey.startsWith('mse:')) c.groupKey = 'mse:*';
  return c;
};

// every old entry identical in the new list; returns the entries only the new version has
function compareLinks(label, oldList, newList) {
  const newBy = new Map(newList.map((e) => [entryKey(e), e]));
  let same = 0;
  oldList.forEach((o) => {
    const n = newBy.get(entryKey(o));
    if (!n) { fail(`${label}: old link missing in new: ${o.url}`); return; }
    const a = stable(clean(o));
    const b = stable(clean(n));
    if (a === b) same++;
    else fail(`${label}: link changed: ${o.url}\n      old ${a}\n      new ${b}`);
  });
  const oldKeys = new Set(oldList.map(entryKey));
  const added = newList.filter((e) => !oldKeys.has(entryKey(e)));
  ok(same === oldList.length, `${label}: ${same}/${oldList.length} old links identical`);
  added.forEach((e) => {
    const src = e.addon && e.addon.source;
    if (!X3_SOURCES.has(src)) fail(`${label}: new link not from modules 12-22: ${e.url} (${src})`);
  });
  return added;
}

// The real popup, opened in a tab, pointed at the test tab
async function runPopup(b, tabId) {
  const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await b.attach(targetId, 'popup');
  await b.cdp.send('Page.enable', {}, sessionId);
  await b.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (info, cb) => {
        if (info && info.active) { const p = chrome.tabs.get(${tabId}).then((t) => [t]); if (cb) { p.then(cb); return undefined; } return p; }
        return q(info, cb);
      };
      window.__blobs = [];
      const create = URL.createObjectURL;
      URL.createObjectURL = function (o) { window.__blobs.push(o); return create.call(URL, o); };
      HTMLAnchorElement.prototype.click = function () {}; // downloadBlob's a.click(): keep the file in memory, do not save it
      window.__copied = [];
      try { Object.defineProperty(navigator.clipboard, 'writeText', { value: async (t) => { window.__copied.push(t); } }); } catch (e) {}
    })();`
  }, sessionId);
  await b.cdp.send('Page.navigate', { url: `chrome-extension://${b.worker.extId}/popup.html` }, sessionId);
  await sleep(7000);
  const ui = await b.evalIn(sessionId, `(() => {
    const strip = (node) => {
      const c = node.cloneNode(true);
      c.querySelectorAll('[data-x3]').forEach((x) => x.remove());
      c.querySelectorAll('[data-x3suffix]').forEach((x) => { x.textContent = x.textContent.replace(x.dataset.x3suffix, ''); });
      return c;
    };
    const vis = (e) => e.style.display !== 'none';
    return Array.from(document.querySelectorAll('.link-card')).map((card) => {
      const old = strip(card);
      return {
        url: card.dataset.url,
        title: (old.querySelector('.card-title') || {}).textContent || '',
        tags: Array.from(old.querySelectorAll('.tag-row > *')).map((t) => t.textContent),
        buttons: Array.from(old.querySelectorAll('.card-actions-bar > button')).filter(vis).map((t) => t.textContent),
        x3: Array.from(card.querySelectorAll('[data-x3]')).map((t) => t.textContent)
      };
    });
  })()`);
  const banner = await b.evalIn(sessionId, `(document.querySelector('.x3-banner') || {}).innerText || ''`);
  const exportJson = async () => b.evalIn(sessionId, `(async () => {
    window.__blobs.length = 0;
    document.getElementById('exportJson').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return window.__blobs[0] ? JSON.parse(await window.__blobs[0].text()) : null;
  })()`);
  return { sessionId, targetId, ui, banner, json: await exportJson() };
}

function comparePopup(label, oldUi, newUi, expectedTypeChanges) {
  const newBy = new Map(newUi.map((c) => [c.url, c]));
  let same = 0;
  oldUi.forEach((o) => {
    const n = newBy.get(o.url);
    if (!n) { fail(`${label}: card missing in new popup: ${o.url}`); return; }
    const a = stable({ title: o.title, tags: o.tags, buttons: o.buttons });
    const b = stable({ title: n.title, tags: n.tags, buttons: n.buttons });
    if (a === b) same++;
    else if (expectedTypeChanges.some((re) => re.test(o.url))) console.log(`  note ${label}: card relabelled as planned: ${o.url}\n      old ${a}\n      new ${b}`);
    else fail(`${label}: card changed: ${o.url}\n      old ${a}\n      new ${b}`);
  });
  ok(true, `${label}: ${same}/${oldUi.length} old cards identical (planned relabels listed above)`);
}

function compareJson(label, oldJson, newJson) {
  if (!ok(Array.isArray(oldJson) && Array.isArray(newJson), `${label}: JSON export produced`)) return;
  const newBy = new Map(newJson.map((x) => [x.url, x]));
  let same = 0;
  oldJson.forEach((o) => {
    const n = newBy.get(o.url);
    if (!n) { fail(`${label}: JSON export lost ${o.url}`); return; }
    const pick = (x) => { const c = {}; Object.keys(o).forEach((k) => { if (k !== 'extractedAt') c[k] = x[k]; }); return c; };
    if (stable(pick(o)) === stable(pick(n))) same++;
    else if (/\.(?:pls|asx|xspf|f4m)(?:[?#]|$)|\.ism\/manifest/i.test(o.url)) console.log(`  note ${label}: JSON type changed as planned: ${o.url} ${o.type} -> ${n.type}`);
    else fail(`${label}: JSON export changed for ${o.url}\n      old ${stable(pick(o))}\n      new ${stable(pick(n))}`);
  });
  ok(true, `${label}: ${same}/${oldJson.length} old JSON records keep every old field`);
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chromium not found at ${CHROME} (set VLE_CHROME)`);
  let oldDir = process.env.VLE_OLD;
  let tmpOld = null;
  if (!oldDir) {
    tmpOld = fs.mkdtempSync(path.join(os.tmpdir(), 'vle-old-'));
    execSync(`git archive HEAD | tar -x -C "${tmpOld.replace(/\\/g, '/')}"`, { cwd: ROOT, shell: 'bash' });
    oldDir = tmpOld;
  }
  const server = await start(PORT);
  const [oldB, newB] = await Promise.all([launch('old', oldDir, 9341), launch('new', ROOT, 9342)]);
  console.log(`old: ${oldDir}\nnew: ${ROOT}`);
  try {
    const pages = [
      { name: 'legacy', url: `${BASE}/pages/legacy.html`, wait: 6000, relabels: [] },
      { name: 'x3', url: `${BASE}/pages/x3.html`, wait: 7000, relabels: [/\.(?:pls|asx|xspf|f4m)(?:[?#]|$)/i, /\.ism\/manifest/i] }
    ];
    const results = {};
    for (const page of pages) {
      console.log(`\n== ${page.name} page: stored links`);
      const [o, n] = await Promise.all([runPage(oldB, page.url, page.wait), runPage(newB, page.url, page.wait)]);
      compareLinks(`${page.name} (after scan)`, o.scanned, n.scanned);
      const added = compareLinks(`${page.name} (after checks)`, o.probed, n.probed);
      console.log(`  info ${page.name}: ${o.probed.length} old links, ${added.length} added by modules 12-22${added.length ? `:\n${added.map((e) => `       + [${e.addon.source}] ${e.url}`).join('\n')}` : ''}`);
      console.log(`\n== ${page.name} page: popup`);
      const [op, np] = await Promise.all([runPopup(oldB, o.tabId), runPopup(newB, n.tabId)]);
      comparePopup(`${page.name} popup`, op.ui, np.ui, page.relabels);
      compareJson(`${page.name} JSON`, op.json, np.json);
      results[page.name] = { o, n, op, np, added };
    }

    console.log('\n== modules 12-22 (new version, x3 page)');
    const { n, np, added } = results.x3;
    const session = await newB.evalW(`chrome.storage.session.get(null)`);
    const st = session[`x3_tab_${n.tabId}`] || {};
    const probes = session.x3_probe || {};
    const card = (re) => np.ui.find((c) => re.test(c.url)) || { x3: [], tags: [] };
    const x3text = (re) => card(re).x3.join(' | ');
    const hdr = (re) => { const k = Object.keys(st.h || {}).find((u) => re.test(u)); return k ? st.sets[st.h[k]] : null; };
    // 12 + 22
    const auth = hdr(/\/media\/auth\.mp4$/);
    ok(auth && auth.some(([k, v]) => k.toLowerCase() === 'authorization' && v === 'Bearer test-token-123') && auth.some(([k]) => k.toLowerCase() === 'x-video-token'), 'module 12: Authorization / custom token headers kept');
    ok(auth && auth.some(([k, v]) => k.toLowerCase() === 'cookie' && /vle_session=abc123/.test(v)), 'module 12: Cookie kept');
    ok(auth && !auth.some(([k]) => /^(?:user-agent|accept|sec-|referer|range)/i.test(k)), 'module 12: browser headers left out');
    ok(/🔐 \d+ headers/.test(x3text(/\/media\/auth\.mp4$/)), 'module 12: 🔐 headers toggle on the card');
    const rk = Object.keys(st.r || {}).find((u) => /\/media\/auth\.mp4$/.test(u));
    ok(rk && st.r[rk].status === 200 && st.r[rk].ip && st.r[rk].type === 'xmlhttprequest', 'module 22: first request (status, server address, type)');
    // 13
    ok(/WebRTC live: 1 video track/.test(np.banner) && /stun\.example\.test/.test(np.banner) && !/secret|user/.test(np.banner), `module 13: WebRTC connection with media in the banner (ICE host only)\n${np.banner}`);
    ok((np.banner.match(/WebRTC live/g) || []).length === 1, 'module 13: data-only connections not reported');
    ok(/WHEP endpoint/.test(np.banner) && /\/whep/.test(np.banner), 'module 13: WHEP endpoint');
    ok(/FLV over WebSocket/.test(np.banner) && /ws:\/\/127\.0\.0\.1:\d+\/ws/.test(np.banner), 'module 13: FLV over WebSocket');
    // 14
    ok(/WebTransport/.test(np.banner) && /127\.0\.0\.1:4433\/wt/.test(np.banner), 'module 14: WebTransport session');
    ok(/WebCodecs player: avc1\.42001f 640×360 · opus 48 kHz 2 ch/.test(np.banner), 'module 14: WebCodecs decoders');
    // 15
    ok(added.some((e) => /\/smooth\/stream\.ism\/Manifest$/.test(e.url) && e.addon.manifest === 'mss'), 'module 15: Smooth manifest added');
    ok(card(/\/smooth\/stream\.ism\/Manifest$/).tags[0] === 'Smooth Stream', 'module 15: shown as Smooth Stream');
    ok(/📶 3 tracks/.test(x3text(/\/smooth\/stream\.ism\/Manifest$/)) && /🕒 2:01/.test(x3text(/\/smooth\/stream\.ism\/Manifest$/)), 'module 15: Smooth qualities and length');
    ok(card(/\/hds\/clip\.f4m$/).tags[0] === 'HDS Stream' && /📶 2 tracks/.test(x3text(/\/hds\/clip\.f4m$/)), 'module 15: HDS manifest');
    ok(!card(/format=m3u8-aapl/).tags.length || card(/format=m3u8-aapl/).tags[0] !== 'Smooth Stream', 'module 15: Azure HLS (format=m3u8-aapl) not taken for Smooth');
    // 16
    ok(/📢 Ad/.test(x3text(/\/ads\/ad-720\.mp4$/)), 'module 16: VAST ad file labelled');
    ok(/📢 2 ad breaks/.test(x3text(/\/fixtures\/master\.m3u8$/)), 'module 16: ad breaks in the HLS stream');
    ok(/📢 1 ad break/.test(x3text(/\/fixtures\/manifest\.mpd$/)), `module 16: SCTE-35 event in the DASH manifest (${x3text(/\/fixtures\/manifest\.mpd$/)})`);
    // 17
    ok(/📻 Live radio · 128 kb\/s/.test(x3text(/\/radio\/stream$/)), 'module 17: Icecast radio');
    ok(added.some((e) => e.url === 'https://media.example.test/pod/episode-1' && e.addon.source === 'feed'), 'module 17: RSS enclosure without extension added');
    ok(n.probed.some((e) => /\/pod\/episode-2\.mp3\?src=rss$/.test(e.url)), 'module 17: RSS enclosure with extension listed (module 6 lists it first, as before)');
    ok(added.some((e) => /\/music\/track-1\.flac$/.test(e.url)), 'module 17: .xspf entries added');
    ok(added.some((e) => /\/radio\/asx-stream\.mp3$/.test(e.url)), 'module 17: .asx entries added');
    ok(added.some((e) => /\/radio\/station\.ogg$/.test(e.url) && e.addon.source === 'playlist'), 'module 17: .pls contents added (after the popup checked it)');
    ok(card(/\/fixtures\/list\.pls$/).tags[0] === 'Playlist (.pls)', 'module 17: .pls shown as a playlist');
    // 18
    ok(/🎞 HEVC · H\.264 · HDR10 · Atmos · E-AC-3 · AAC/.test(x3text(/\/fixtures\/master\.m3u8$/)), 'module 18: HLS formats');
    ok(/🎞 HEVC · HDR10/.test(x3text(/\/media\/hevc-hdr\.mp4$/)), 'module 18: MP4 header formats');
    // 19
    ok(/⚡ Low latency/.test(x3text(/\/fixtures\/master\.m3u8$/)) && /🔀 Steering · 2 CDNs/.test(x3text(/\/fixtures\/master\.m3u8$/)) && /🧰 More/.test(x3text(/\/fixtures\/master\.m3u8$/)), 'module 19: low latency, steering, More');
    const mk = Object.keys(probes).find((u) => /\/fixtures\/master\.m3u8$/.test(u));
    ok(mk && probes[mk].iframes.length === 1 && probes[mk].images.length === 1 && probes[mk].session.length === 2, 'module 19: I-frame / image playlists, session data');
    // 20
    ok(/🎚 3 DASH tracks/.test(x3text(/\/fixtures\/manifest\.mpd$/)), 'module 20: DASH tracks toggle');
    const dashUrl = card(/\/fixtures\/manifest\.mpd$/).url;
    const pl = await newB.evalIn(np.sessionId, `new Promise((r) => chrome.runtime.sendMessage({ action: 'x3DashTrack', tabId: ${n.tabId}, url: ${JSON.stringify(dashUrl)}, index: 0, comment: 'test' }, r))`);
    ok(pl && /#EXT-X-MAP:URI="http:\/\/127\.0\.0\.1:\d+\/fixtures\/dash\/v1080\/init\.mp4"/.test(pl.text || '') && (pl.text.match(/seg-\d{5}\.m4s/g) || []).length === 15, 'module 20: DASH track .m3u8 export');
    const single = probes[Object.keys(probes).find((u) => /single\.mpd$/.test(u))];
    ok(single && single.dash.tracks[0].url.endsWith('/fixtures/video_720.mp4'), 'module 20: one-file DASH track address');
    // 21 (needs the internet)
    const embedUrl = (n.probed.find((e) => e.addon && e.addon.embed === 'Vimeo') || {}).url;
    ok(embedUrl && /🔍 Resolve/.test(x3text(/player\.vimeo\.com/)), 'module 21: 🔍 Resolve on the Vimeo embed card');
    const res = await newB.evalIn(np.sessionId, `new Promise((r) => chrome.runtime.sendMessage({ action: 'x3Resolve', tabId: ${n.tabId}, url: ${JSON.stringify(embedUrl || '')} }, r))`);
    ok(res && res.added > 0, `module 21: Vimeo embed resolved (${JSON.stringify(res)})`);
    const oe = await newB.evalIn(np.sessionId, `new Promise((r) => chrome.runtime.sendMessage({ action: 'x3Oembed', tabId: ${n.tabId}, url: 'https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F76979871' }, r))`);
    ok(oe && oe.player && /player\.vimeo\.com\/video\/76979871/.test(oe.player), `module 21: oEmbed resolved to its player (${JSON.stringify(oe)})`);
    ok(oe && oe.already && oe.added === 0, 'module 21: the same player is not listed twice (card, then oEmbed)');
    const foreign = await newB.evalIn(np.sessionId, `new Promise((r) => chrome.runtime.sendMessage({ action: 'x3Oembed', tabId: ${n.tabId}, url: 'https://example.com/oembed' }, r))`);
    ok(foreign && foreign.error, 'module 21: refuses an oEmbed address the page did not name');
    // HAR + JSON fields
    const har = await newB.evalIn(np.sessionId, `(async () => {
      window.__blobs.length = 0;
      document.getElementById('exportHar').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return window.__blobs[0] ? JSON.parse(await window.__blobs[0].text()) : null;
    })()`);
    const harAuth = har && har.log.entries.find((e) => /\/media\/auth\.mp4$/.test(e.request.url));
    ok(harAuth && harAuth.response.status === 200 && harAuth.request.headers.some((h) => h.name === 'X-Video-Token' || h.name === 'x-video-token') === false, 'module 22: HAR export (token headers left out)');
    ok(harAuth && !JSON.stringify(har).includes('test-token-123') && !JSON.stringify(har).includes('abc123'), 'module 22: HAR has no cookie / token values');
    const jAuth = np.json.find((x) => /\/media\/auth\.mp4$/.test(x.url));
    ok(jAuth && jAuth.firstRequest && jAuth.secretHeadersLeftOut && !JSON.stringify(np.json).includes('test-token-123'), 'JSON export: new fields, secrets left out');

    // the panels: every toggle opened, their rows and buttons
    const panels = await newB.evalIn(np.sessionId, `(async () => {
      document.querySelectorAll('.link-card .variants-toggle[data-x3]').forEach((b) => b.click());
      await new Promise((r) => setTimeout(r, 400));
      const card = (re) => Array.from(document.querySelectorAll('.link-card')).find((c) => new RegExp(re).test(c.dataset.url));
      const boxText = (c) => (c ? Array.from(c.querySelectorAll('.x3-box')).map((b) => b.innerText).join('\\n') : '');
      const auth = card('/media/auth\\\\.mp4$');
      window.__copied.length = 0;
      const btn = auth && Array.from(auth.querySelectorAll('.x3-box button')).find((b) => b.textContent === 'yt-dlp');
      if (btn) btn.click();
      const curl = auth && Array.from(auth.querySelectorAll('.x3-box button')).find((b) => b.textContent === 'curl');
      if (curl) curl.click();
      await new Promise((r) => setTimeout(r, 200));
      return {
        auth: boxText(auth), master: boxText(card('/fixtures/master\\\\.m3u8$')), mpd: boxText(card('/fixtures/manifest\\\\.mpd$')),
        smooth: boxText(card('stream\\\\.ism/Manifest$')), copied: window.__copied.slice(),
        boxes: document.querySelectorAll('.x3-box').length
      };
    })()`);
    ok(/Authorization/.test(panels.auth) && /characters\)/.test(panels.auth) && !/test-token-123/.test(panels.auth), `🔐 panel lists the headers, secrets masked`);
    ok(panels.copied[0] && /^yt-dlp --add-header "Referer: http:\/\/127\.0\.0\.1:\d+\/pages\/x3\.html" .*--add-header "Authorization: Bearer test-token-123" .*"http:\/\/127\.0\.0\.1:\d+\/media\/auth\.mp4"$/.test(panels.copied[0]), `🔐 yt-dlp command with the headers (${(panels.copied[0] || '').slice(0, 160)})`);
    ok(panels.copied[1] && /^curl -L -H "Referer: .*-H "Cookie: [^"]*vle_session=abc123.* -o ".+\.mp4" "http:\/\/127\.0\.0\.1:\d+\/media\/auth\.mp4"$/.test(panels.copied[1]), '🔐 curl command with the headers');
    ok(/First request/.test(panels.master) && /I-frames 720p/.test(panels.master) && /Session data/.test(panels.master) && /Content steering/.test(panels.master), '🧰 More panel (request details, I-frames, session data, steering)');
    ok(/1080p · 25 fps · 5\.0 Mb\/s · HEVC/.test(panels.mpd) && /⬇ \.m3u8/.test(panels.mpd) && /Audio · en · 768 kb\/s · E-AC-3/.test(panels.mpd), '🎚 DASH tracks panel');
    ok(/720p · 3\.0 Mb\/s/.test(panels.smooth) && /Audio · en · 128 kb\/s/.test(panels.smooth), `📶 Smooth tracks panel (${panels.smooth.replace(/\n/g, ' / ')})`);

    // what modules 12-22 know survives Chrome stopping the idle worker (like the link lists do)
    console.log('\n== worker restart');
    const storedBefore = (await newB.evalW(`getTabLinks(${n.tabId})`)).length; // the resolve checks above added links
    await newB.evalW('self.__vleMarker = 1');
    await newB.stopWorker();
    const again = await runPopup(newB, n.tabId);
    await newB.findWorker();
    ok(await newB.evalW('typeof self.__vleMarker') === 'undefined', 'the worker was restarted');
    const after = again.ui.find((c) => /\/media\/auth\.mp4$/.test(c.url)) || { x3: [] };
    ok(/🔐 \d+ headers/.test(after.x3.join(' | ')), 'module 12: headers kept across the restart');
    ok(/🎞 HEVC · H\.264 · HDR10/.test((again.ui.find((c) => /\/fixtures\/master\.m3u8$/.test(c.url)) || { x3: [] }).x3.join(' | ')), 'module 18: formats kept across the restart');
    ok(/WebRTC live/.test(again.banner) && /WHEP endpoint/.test(again.banner), 'modules 13-14: banner kept across the restart');
    ok(again.ui.length === storedBefore, `every stored link shown after the restart (${again.ui.length} / ${storedBefore})`);

    // a feed opened as a document of its own
    console.log('\n== feed document');
    const [fo, fn] = await Promise.all([runPage(oldB, `${BASE}/fixtures/feed.xml?type=text/xml`, 3000), runPage(newB, `${BASE}/fixtures/feed.xml?type=text/xml`, 3000)]);
    const fAdded = compareLinks('feed document', fo.probed, fn.probed);
    ok(fAdded.length === 3, `module 17: the feed's 3 media items listed (${fAdded.length})`);

    console.log('\n== script errors');
    const relevant = (list) => list.filter((e) => !/rtc test failed/.test(e.text));
    const ext = (b) => relevant(b.errors).filter((e) => e.where === 'worker' || e.where === 'popup');
    ok(ext(newB).length === 0, `no error in the new worker / popup${ext(newB).length ? `: ${JSON.stringify(ext(newB)).slice(0, 800)}` : ''}`);
    const pageErr = (b) => relevant(b.errors).filter((e) => e.where.startsWith('page')).length;
    ok(pageErr(newB) <= pageErr(oldB), `page errors: old ${pageErr(oldB)}, new ${pageErr(newB)}`);
  } finally {
    await Promise.all([oldB.close(), newB.close()]);
    server.close();
    if (tmpOld) try { fs.rmSync(tmpOld, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 2; });
module.exports = { launch, runPage, CHROME, ROOT, BASE, PORT, sleep };
