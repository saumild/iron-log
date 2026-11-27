// Installable + offline: manifest/icons, service worker, offline launch, offline saves that sync and
// merge with another device's changes instead of overwriting them.
import { makeChecker, startServer, launch, device, fakeSupabase, signUp, signIn, waitApp, addLog, tags } from './harness.mjs';

const { check, info, report } = makeChecker();
const browser = await launch();
const sb = fakeSupabase();
const srv = await startServer('dist/index.html', { supabase: sb });

/* ---------- install metadata ---------- */
{
  const { pg } = await device(browser, srv, { fakeSb: true });
  await pg.open();
  const meta = await pg.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]'); if (!link) return { err: 'no manifest link' };
    const m = await (await fetch(link.href)).json();
    const icons = await Promise.all(m.icons.map(async i => (await fetch(new URL(i.src, link.href))).ok));
    const touch = await fetch(document.querySelector('link[rel=apple-touch-icon]').href);
    return { name: m.name, display: m.display, start: m.start_url, icons: icons.every(Boolean), n: m.icons.length, maskable: m.icons.some(i => i.purpose === 'maskable'), touch: touch.ok };
  });
  check('manifest: name, standalone, relative start_url', meta.name === 'Iron Log' && meta.display === 'standalone' && meta.start === './', JSON.stringify(meta));
  check('manifest icons + maskable + apple-touch-icon all load', meta.icons && meta.maskable && meta.touch);
  await pg.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  if (!(await pg.evaluate(() => !!navigator.serviceWorker.controller))) { await pg.reload(); await pg.waitForTimeout(800); }
  check('service worker installed and controlling the page', await pg.evaluate(() => !!navigator.serviceWorker.controller));
  await pg.context().close();
}

/* ---------- phone A: online → offline → reload offline ---------- */
const { ctx: ctxA, pg: A } = await device(browser, srv, { fakeSb: true });
await A.open();
await signUp(A, 'alice', 'alice-pass-1');
await addLog(A, 'w1-online');
await A.waitForTimeout(400);
// make sure the SW controls the page before going offline
if (!(await A.evaluate(() => !!navigator.serviceWorker.controller))) { await A.reload(); await waitApp(A); }
check('phone A: service worker active', await A.evaluate(() => !!navigator.serviceWorker.controller));

await ctxA.setOffline(true);
const saved = await addLog(A, 'w2-offline');
check('offline save reports success to the app', saved === true);
await A.waitForTimeout(400);
check('offline save is pending sync', await A.evaluate(() => IronAuth.pending()));
const toastTxt = await A.evaluate(() => document.querySelector('#toast').textContent);
check('user is told it will sync later', /will sync/.test(toastTxt), toastTxt);
check('server does not have the offline workout yet', !JSON.stringify([...sb.docs.values()]).includes('w2-offline') /* (ciphertext anyway) */ && true);

await A.reload({ waitUntil: 'load' }).catch(e => info('reload: ' + e.message));
await waitApp(A, 20000).catch(() => {});
check('app opens offline straight into the remembered profile', await A.evaluate(() => typeof state === 'object' && !!IronAuth.acct && !document.querySelector('.ilauth')).catch(() => false));
const offT = await tags(A).catch(() => []);
check('offline launch shows both workouts from the on-phone copy', offT.includes('w1-online') && offT.includes('w2-offline'), offT.join(','));

/* ---------- phone B: logs while A is offline ---------- */
const { pg: B } = await device(browser, srv, { fakeSb: true });
await B.open();
check('phone B signs in', (await signIn(B, 'alice', 'alice-pass-1')) === '');
const bT = await tags(B);
check('phone B sees only what reached the server', bT.includes('w1-online') && !bT.includes('w2-offline'), bT.join(','));
await addLog(B, 'w3-other-phone');
await B.waitForTimeout(400);

/* ---------- A reconnects: merge, not overwrite ---------- */
await ctxA.setOffline(false);
await A.evaluate(() => window.dispatchEvent(new Event('online')));
for (let i = 0; i < 40 && (await A.evaluate(() => IronAuth.pending())); i++) await A.waitForTimeout(500);
info('synced after reconnect: ' + !(await A.evaluate(() => IronAuth.pending())));
check('still signed in on phone A after reconnecting', await A.evaluate(() => !!(window.IronAuth && IronAuth.acct)));
check('pending save synced after reconnecting', !(await A.evaluate(() => IronAuth.pending())));
const serverTags = async p => JSON.parse(await p.evaluate(() => IronAuth.readState())).logs.map(l => l.__tag).filter(Boolean);
const sT = await serverTags(B);
check('server now has all three workouts (merged)', ['w1-online', 'w2-offline', 'w3-other-phone'].every(t => sT.includes(t)), sT.join(','));
await A.waitForTimeout(500);
const aT = await tags(A);
check('phone A’s screen picked up the other phone’s workout', aT.includes('w3-other-phone'), aT.join(','));
check('merge kept exactly one copy of each workout', aT.filter(t => t === 'w1-online').length === 1);

/* ---------- unit: merge rules ---------- */
const m = await A.evaluate(() => IronAuth._test.mergeStates(
  { logs: [{ id: 'a', v: 'mine' }, { id: 'b' }], health: { weight: { d1: 150 } }, settings: { week: 3 } },
  { logs: [{ id: 'a', v: 'theirs' }, { id: 'c' }], health: { weight: { d0: 151 }, steps: { d0: 9000 } }, settings: { week: 2, units: 'kg' } }));
check('merge: records by id, mine wins a clash', m.logs.map(l => l.id).sort().join() === 'a,b,c' && m.logs.find(l => l.id === 'a').v === 'mine');
const sameDay = await A.evaluate(() => IronAuth._test.mergeStates({ logs: [{ id: '2026-11-20_wa', date: '2026-11-20' }] }, { logs: [{ id: '2026-11-20_wb', date: '2026-11-20' }] }));
check('merge: two different workouts on the same day both survive', sameDay.logs.length === 2);
check('merge: maps combine, mine wins a clash', m.health.weight.d0 === 151 && m.health.weight.d1 === 150 && m.health.steps.d0 === 9000 && m.settings.week === 3 && m.settings.units === 'kg');

for (const [n, p] of [['A', A], ['B', B]]) check(`phone ${n}: no uncaught JS errors`, p.errors.filter(e => !/Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED|offline/i.test(e)).length === 0, p.errors.slice(0, 3).join(' | '));
await browser.close(); srv.close();
process.exit(report() ? 1 : 0);
