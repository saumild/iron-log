// Smoke test: create an account, then check every tab, plan types, library, saving, reload, backup.
// Usage: node tests/smoke.spec.mjs [path-to-html]   (default dist/index.html)
import { makeChecker, startServer, launch, device, signUp, addLog, tags } from './harness.mjs';

const { check, info, report } = makeChecker();
const srv = await startServer(process.argv[2] || 'dist/index.html');
const browser = await launch();
const { pg } = await device(browser, srv);
await pg.open();

await signUp(pg, 'smoketest', 'correct-horse-1');
check('app boots after sign-up (Train view visible)', await pg.locator('#viewTrain').isVisible());

const tabs = await pg.$$eval('.nbtn', bs => bs.filter(b => b.offsetParent !== null).map(b => b.dataset.view));
info(`visible tabs: ${tabs.join(', ')}`);
for (const v of tabs) {
  await pg.evaluate(v => document.querySelector(`.nbtn[data-view="${v}"]`).click(), v);
  await pg.waitForTimeout(350);
  check(`tab "${v}" opens`, await pg.locator('#view' + v[0].toUpperCase() + v.slice(1)).isVisible().catch(() => false));
}
await pg.evaluate(() => document.querySelector('.nbtn[data-view="train"]').click());
await pg.waitForTimeout(350);

const kinds = await pg.$$eval('[data-kind],[data-ptype],[data-mode]', els => [...new Set(els.map(e => e.dataset.kind || e.dataset.ptype || e.dataset.mode))]);
check('Strength / Yoga / Home plan types present', ['strength', 'yoga', 'home'].every(k => kinds.includes(k)), kinds.join(', '));

const core = await pg.evaluate(() => ({ ex: Object.keys(ALLEX).length + Object.keys(LIBRARY).length }));
check('exercise library loaded', core.ex > 200, `${core.ex} exercises`);

check('persist() saves', (await addLog(pg, 'smoke-1')) === true);
await pg.reload({ waitUntil: 'load' });
await pg.waitForFunction(() => window.IronAuth && IronAuth.acct && typeof state === 'object', null, { timeout: 15000 });
await pg.waitForTimeout(600);
check('stays signed in after reload', await pg.evaluate(() => !document.querySelector('.ilauth')));
check('data survives reload', (await tags(pg)).includes('smoke-1'));

const exp = await pg.evaluate(async () => {
  let copied = null; navigator.clipboard.writeText = async t => { copied = t; };
  document.querySelector('#copyBtn').click(); await new Promise(r => setTimeout(r, 600));
  const txt = copied || document.querySelector('#bkBox').value || '';
  return txt.includes('smoke-1') ? 'ok:' + txt.length : 'missing data (' + txt.length + ')';
});
check('backup copy contains the data', exp.startsWith('ok'), exp);

check('no uncaught JS errors', pg.errors.length === 0, pg.errors.slice(0, 4).join(' | '));
await browser.close(); srv.close();
process.exit(report() ? 1 : 0);
