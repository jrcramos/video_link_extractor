// Smoke test on real sites (needs the internet): each page in the committed version and in this working copy at the
// same time. Real pages change from one load to the next (ads, A/B tests, tokens), so this checks less than run.js:
//   - every link the old version lists is listed by the new one too (by address)
//   - no script error in the new worker / popup
// and prints what modules 12-22 add. Run: node tests/sites.js [url ...]   (--embeds: only the 🔍 Resolve part)
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, ROOT, BASE, PORT, sleep } = require('./run');
const { start } = require('./server');

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ONLY_EMBEDS = process.argv.includes('--embeds');
const SITES = ONLY_EMBEDS ? [] : ARGS.length ? ARGS : [
  'https://hlsjs.video-dev.org/demo/',
  'https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html',
  'https://vimeo.com/76979871',
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  'https://www.dailymotion.com/video/x8nmq5k',
  'https://www.w3schools.com/html/html5_video.asp'
];

async function visit(b, url) {
  const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
  const s = await b.attach(targetId, `page ${url}`);
  await b.cdp.send('Page.enable', {}, s);
  await b.cdp.send('Page.navigate', { url }, s);
  await sleep(15000);
  // the page may have redirected: find its tab by the target
  const tabId = await b.evalW(`chrome.tabs.query({}).then((ts) => { const t = ts.filter((x) => /^https?:/.test(x.url)).pop(); return t ? t.id : -1; })`);
  await b.evalW(`new Promise((r) => chrome.tabs.sendMessage(${tabId}, { action: 'forceContentScan' }, () => { void chrome.runtime.lastError; r(); }))`);
  await sleep(3000);
  const links = await b.evalW(`getTabLinks(${tabId})`);
  return { targetId, tabId, links };
}

async function popup(b, tabId) {
  const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
  const s = await b.attach(targetId, 'popup');
  await b.cdp.send('Page.enable', {}, s);
  await b.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = (info, cb) => { if (info && info.active) { const p = chrome.tabs.get(${tabId}).then((t) => [t]); if (cb) { p.then(cb); return undefined; } return p; } return q(info, cb); }; })();`
  }, s);
  await b.cdp.send('Page.navigate', { url: `chrome-extension://${b.worker.extId}/popup.html` }, s);
  await sleep(8000);
  const ui = await b.evalIn(s, `({ cards: document.querySelectorAll('.link-card').length, x3: Array.from(document.querySelectorAll('.link-card [data-x3]')).map((e) => e.textContent).filter((t) => t.length < 80), banner: (document.querySelector('.x3-banner') || {}).innerText || '' })`);
  await b.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return ui;
}

(async () => {
  let oldDir = process.env.VLE_OLD;
  let tmpOld = null;
  if (!oldDir) {
    tmpOld = fs.mkdtempSync(path.join(os.tmpdir(), 'vle-old-'));
    execSync(`git archive HEAD | tar -x -C "${tmpOld.replace(/\\/g, '/')}"`, { cwd: ROOT, shell: 'bash' });
    oldDir = tmpOld;
  }
  let problems = 0;
  for (const url of SITES) {
    console.log(`\n== ${url}`);
    const [oldB, newB] = await Promise.all([launch('old', oldDir, 9371), launch('new', ROOT, 9372)]);
    try {
      const [o, n] = await Promise.all([visit(oldB, url), visit(newB, url)]);
      const key = (e) => e.groupKey || e.url;
      const newKeys = new Set(n.links.map(key));
      // a stream's signed address (and its CDN node) differs between the two loads: compare those by path (+ YouTube's
      // format number)
      const loose = (e) => { try { const u = new URL(e.url); return u.pathname + (u.searchParams.get('itag') || ''); } catch (x) { return e.url; } };
      const newLoose = new Set(n.links.map(loose));
      const missing = o.links.filter((e) => !newKeys.has(key(e)) && !newLoose.has(loose(e)) && !(e.groupKey && e.groupKey.startsWith('mse:')));
      console.log(`  old ${o.links.length} links, new ${n.links.length} (${n.links.filter((e) => e.addon && ['stream', 'radio', 'playlist', 'feed', 'resolved'].includes(e.addon.source)).length} from modules 12-22)`);
      if (missing.length) { problems++; console.log(`  CHECK old links not in new (may be page variation):\n${missing.map((e) => `    - ${e.url.slice(0, 160)}`).join('\n')}`); }
      const ui = await popup(newB, n.tabId);
      console.log(`  popup: ${ui.cards} cards; module badges: ${Array.from(new Set(ui.x3)).slice(0, 12).join(' | ') || '-'}`);
      if (ui.banner) console.log(`  banner: ${ui.banner.replace(/\n/g, ' / ').slice(0, 300)}`);
      const errs = newB.errors.filter((e) => e.where === 'worker' || e.where === 'popup');
      if (errs.length) { problems++; console.log(`  FAIL extension errors: ${JSON.stringify(errs).slice(0, 600)}`); }
      const pe = (b) => b.errors.filter((e) => e.where.startsWith('page')).length;
      console.log(`  page errors: old ${pe(oldB)}, new ${pe(newB)}`);
    } catch (e) {
      problems++;
      console.log(`  ERROR ${e.message}`);
    } finally {
      await Promise.all([oldB.close(), newB.close()]);
    }
  }
  if (tmpOld) try { fs.rmSync(tmpOld, { recursive: true, force: true }); } catch (e) {}

  // Module 21: 🔍 Resolve on public sample embeds (tests/pages/embeds.html), new version only
  if (!ARGS.length) {
    console.log('\n== player services (🔍 Resolve)');
    const server = await start(PORT);
    const b = await launch('new', ROOT, 9381);
    try {
      const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
      const s = await b.attach(targetId, 'page embeds');
      await b.cdp.send('Page.enable', {}, s);
      await b.cdp.send('Page.navigate', { url: `${BASE}/pages/embeds.html` }, s);
      await sleep(5000);
      const tabId = await b.evalW(`chrome.tabs.query({}).then((ts) => (ts.find((t) => /embeds\\.html/.test(t.url)) || {}).id)`);
      const embeds = (await b.evalW(`getTabLinks(${tabId})`)).filter((e) => e.addon && e.addon.embed);
      const pop = await b.cdp.send('Target.createTarget', { url: `chrome-extension://${b.worker.extId}/popup.html` });
      const ps = await b.attach(pop.targetId, 'popup');
      await sleep(1500);
      for (const e of embeds) {
        const res = await b.evalIn(ps, `new Promise((r) => chrome.runtime.sendMessage({ action: 'x3Resolve', tabId: ${tabId}, url: ${JSON.stringify(e.url)} }, r))`);
        const okay = res && res.found > 0;
        if (!okay) problems++;
        console.log(`  ${okay ? 'ok  ' : 'CHECK'} ${e.addon.embed.padEnd(12)} ${JSON.stringify(res)}`);
      }
      const resolved = (await b.evalW(`getTabLinks(${tabId})`)).filter((e) => e.addon && e.addon.source === 'resolved');
      resolved.forEach((e) => console.log(`       + [${e.addon.resolvedFrom}] ${e.url.slice(0, 140)}`));
      const errs = b.errors.filter((e) => e.where === 'worker' || e.where === 'popup');
      if (errs.length) { problems++; console.log(`  FAIL extension errors: ${JSON.stringify(errs).slice(0, 600)}`); }
    } finally {
      await b.close();
      server.close();
    }
  }
  console.log(problems ? `\n${problems} thing(s) to look at` : '\nno problem found');
})().catch((e) => { console.error(e); process.exitCode = 2; });
