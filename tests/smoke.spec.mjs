// Smoke test: boots the built app on an iPhone-sized viewport, served over http
// (like GitHub Pages), and checks every tab plus core logging and backup flows.
// Usage: node tests/smoke.spec.mjs [path-to-html]   (default dist/index.html)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] || 'dist/index.html');
const root = path.dirname(file);
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/' + path.basename(file)));
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }); res.end(buf);
  });
});
await new Promise(r => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const results = []; let failed = 0;
const check = (name, ok, info = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); if (!ok) failed++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });
const pg = await ctx.newPage();
await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
const errors = [];
pg.on('pageerror', e => errors.push('pageerror: ' + e.message));
const SW_PENDING = !fs.existsSync(path.join(root, 'sw.js'));
pg.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::|Failed to load resource/.test(m.text()) && !(SW_PENDING && /fetching the script/.test(m.text()))) errors.push('console: ' + m.text()); });
pg.on('dialog', d => d.dismiss());

await pg.goto(url, { waitUntil: 'load' });
await pg.waitForTimeout(1500);

// 1. Boot
check('app boots (Train view visible)', await pg.locator('#viewTrain').isVisible());

// Sign-in gate, if any: create a local test account
const gate = await pg.evaluate(() => {
  const vis = el => el && el.offsetParent !== null;
  const inputs = [...document.querySelectorAll('input[type=password]')].filter(vis);
  return inputs.length;
});
results.push(`INFO  password fields visible at boot: ${gate}`);

// 2. Each bottom-nav tab
const tabs = await pg.$$eval('.nbtn', bs => bs.map(b => b.dataset.view));
results.push(`INFO  tabs: ${tabs.join(', ')}`);
for (const v of tabs) {
  await pg.evaluate(v => document.querySelector(`.nbtn[data-view="${v}"]`).click(), v);
  await pg.waitForTimeout(400);
  const id = '#view' + v[0].toUpperCase() + v.slice(1);
  const vis = await pg.locator(id).isVisible().catch(() => false);
  check(`tab "${v}" opens`, vis);
}
await pg.evaluate(() => document.querySelector('.nbtn[data-view="train"]').click());
await pg.waitForTimeout(400);

// 3. Plan types render (Strength / Yoga / Home toggles if present)
const planKinds = await pg.$$eval('[data-kind],[data-ptype],[data-mode]', els => [...new Set(els.map(e => (e.dataset.kind || e.dataset.ptype || e.dataset.mode)))]);
results.push(`INFO  plan toggles found: ${planKinds.join(', ') || '(none)'}`);

// 4. Core state object + exercise library present
const core = await pg.evaluate(() => ({
  hasState: typeof state === 'object' && state !== null,
  exCount: (typeof ALLEX !== 'undefined' ? Object.keys(ALLEX).length : 0) + (typeof LIBRARY !== 'undefined' ? Object.keys(LIBRARY).length : 0),
  logs: typeof state === 'object' && state ? (state.logs || []).length : -1,
}));
check('state object exists', core.hasState);
check('exercise library loaded', core.exCount > 50, `${core.exCount} exercises`);

// 5. Persistence: write a marker log through the app's own save, reload, confirm it survived
const saved = await pg.evaluate(async () => {
  try {
    state.logs = state.logs || [];
    state.logs.push({ date: '2020-01-01', dayId: 'smoke', ex: { smoke_ex: [{ w: 10, r: 5 }] }, __smoke: true });
    const ok = await persist(); if (!ok) return 'persist returned false';
    return true;
  } catch (e) { return 'err ' + e.message; }
});
check('persist() runs', saved === true, saved === true ? '' : String(saved));
await pg.waitForTimeout(800);
await pg.reload({ waitUntil: 'load' });
await pg.waitForTimeout(1500);
const survived = await pg.evaluate(() => (state.logs || []).some(l => l.__smoke));
check('data survives reload', survived);

// 6. Backup export produces JSON
const exp = await pg.evaluate(async () => {
  const b = document.querySelector('#copyBtn'); if (!b) return 'no copy button';
  let copied = null;
  try { navigator.clipboard.writeText = async t => { copied = t; }; } catch (e) {}
  b.click(); await new Promise(r => setTimeout(r, 600));
  const box = document.querySelector('#bkBox');
  const txt = copied || (box && box.value) || '';
  return txt.length > 20 ? 'ok:' + txt.length : 'empty';
});
check('backup copy produces data', String(exp).startsWith('ok'), String(exp));

check('no uncaught JS errors', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close(); server.close();
console.log(results.join('\n'));
console.log(`\n${failed ? failed + ' FAILED' : 'ALL PASSED'}`);
process.exit(failed ? 1 : 0);
