// Performance: the committed version against this working copy on the same page work (tests/pages/perf.html):
// 300 fetch() JSON answers, 300 XHR XML answers, 3000 WebSocket messages, 200 media elements, the page's load.
// The two browsers take turns (never at the same time), 5 rounds each; the medians are compared.
// Run: node tests/perf.js
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, ROOT, BASE, PORT, sleep } = require('./run');
const { start } = require('./server');

const ROUNDS = Number(process.env.VLE_ROUNDS) || 5;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function once(b, url) {
  const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
  const s = await b.attach(targetId, 'perf');
  await b.cdp.send('Page.enable', {}, s);
  await b.cdp.send('Page.navigate', { url }, s);
  let t = null;
  for (let i = 0; i < 120 && !t; i++) {
    await sleep(250);
    t = await b.evalIn(s, 'window.__perf ? window.__perf : null').catch(() => null);
  }
  await b.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return t;
}

(async () => {
  let oldDir = process.env.VLE_OLD;
  let tmpOld = null;
  if (!oldDir) {
    tmpOld = fs.mkdtempSync(path.join(os.tmpdir(), 'vle-old-'));
    execSync(`git archive HEAD | tar -x -C "${tmpOld.replace(/\\/g, '/')}"`, { cwd: ROOT, shell: 'bash' });
    oldDir = tmpOld;
  }
  const server = await start(PORT);
  const oldB = await launch('old', oldDir, 9361);
  const newB = await launch('new', process.env.VLE_NEW || ROOT, 9362); // VLE_NEW: another build to time (default: this folder)
  const res = { old: [], new: [] };
  try {
    for (let r = 0; r < ROUNDS; r++) {
      for (const [name, b] of r % 2 ? [['new', newB], ['old', oldB]] : [['old', oldB], ['new', newB]]) {
        const t = await once(b, `${BASE}/pages/perf.html?round=${r}`);
        if (t) res[name].push(t);
      }
    }
  } finally {
    await oldB.close();
    await newB.close();
    server.close();
    if (tmpOld) try { fs.rmSync(tmpOld, { recursive: true, force: true }); } catch (e) {}
  }
  const keys = Object.keys(res.old[0] || {});
  let worse = 0;
  console.log(`median of ${ROUNDS} rounds (ms)          old       new    change`);
  keys.forEach((k) => {
    const o = median(res.old.map((x) => x[k]));
    const n = median(res.new.map((x) => x[k]));
    const pct = o ? ((n - o) / o) * 100 : 0;
    const flag = n > o * 1.15 + 25 ? '  <- slower' : '';
    if (flag) worse++;
    console.log(`${k.padEnd(30)} ${o.toFixed(1).padStart(9)} ${n.toFixed(1).padStart(9)} ${`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`.padStart(9)}${flag}`);
  });
  console.log(worse ? `\n${worse} measure(s) more than 15% (+25 ms) slower` : '\nno measure more than 15% (+25 ms) slower');
  process.exitCode = worse ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 2; });
