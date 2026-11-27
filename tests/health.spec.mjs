// Apple Health: hands-free import from the Shortcut via the URL #fragment, and "Save to Apple Health"
// (runs the Iron Log Workout shortcut with the session). Shortcuts itself can't run here: we check the
// exact link Iron Log produces and what it imports.
import { makeChecker, startServer, launch, device, signUp, waitApp, IPHONE_UA } from './harness.mjs';

const { check, info, report } = makeChecker();
const srv = await startServer();
const browser = await launch();
const { pg } = await device(browser, srv, { ua: IPHONE_UA });
await pg.open();
await signUp(pg, 'hkuser', 'hk-pass-123');

// a Shortcut-style export for the last few days
const sample = await pg.evaluate(() => {
  const d = i => addDays(todayStr(), -i);
  return [`weight,${d(1)}T07:10:00-08:00,151.2,lb`, `steps,${d(1)},9120`, `rhr,${d(1)},58`,
          `sleep,${d(2)}T23:10:00-08:00,${d(1)}T06:40:00-08:00,Core`, `exercise,${d(1)},42`].join('\n');
});
check('sample export parses', await pg.evaluate(t => HealthSync.parse(t).n > 0, sample));

/* ---- setup sheet ---- */
await pg.evaluate(() => HealthSync.openSetup()); await pg.waitForTimeout(200);
const setup = await pg.evaluate(() => document.querySelector('#woSheet').innerText);
const prefix = await pg.evaluate(() => HealthSync._t.linkPrefix());
check('setup shows the link that opens Iron Log', setup.includes(prefix.slice(0, 30)) && /#k=[a-z2-9]{12}&health=$/.test(prefix), prefix.replace(/k=[a-z0-9]+/, 'k=…'));
check('setup no longer asks you to paste', !/Copy to Clipboard/.test(setup) && /no pasting/.test(setup));
const key = await pg.evaluate(() => state.settings.healthKey);
check('import key is stored in the (synced, encrypted) account data', /^[a-z2-9]{12}$/.test(key || ''));
await pg.evaluate(() => document.querySelector('#hsX').click());

/* ---- link with the right key: imports straight away ---- */
const link = prefix + encodeURIComponent(sample);
await pg.goto(srv.url + 'index.html' + link.slice(link.indexOf('#')), { waitUntil: 'load' });
await waitApp(pg); await pg.waitForTimeout(800);
const h1 = await pg.evaluate(() => ({ w: Object.keys(state.health.weight || {}).length, s: Object.keys(state.health.steps || {}).length, sl: Object.keys(state.health.sleep || {}).length, ask: !!(document.querySelector('#askScrim.show')), hash: location.hash, toast: document.querySelector('#toast').textContent }));
check('right key: imported without asking', h1.w === 1 && h1.s === 1 && h1.sl >= 1 && !h1.ask, JSON.stringify(h1));
check('data removed from the address bar', h1.hash === '');
check('user sees what was imported', /Imported/.test(h1.toast), h1.toast);

/* ---- link without the key: asks first; declining imports nothing ---- */
const evil = encodeURIComponent(`weight,${await pg.evaluate(() => addDays(todayStr(), -3))}T07:00:00-08:00,999,lb`);
await pg.goto(srv.url + 'index.html#health=' + evil, { waitUntil: 'load' });
await waitApp(pg); await pg.waitForSelector('#askScrim.show', { timeout: 5000 }).catch(() => {});
const asked = await pg.evaluate(() => (document.querySelector('#askScrim.show .ask-msg') || {}).textContent || '');
check('unknown link: asks before importing', /your own Iron Log Health shortcut/.test(asked), asked.slice(0, 60));
await pg.evaluate(() => document.querySelector('#askNo').click()); await pg.waitForTimeout(400);
check('declining imports nothing', await pg.evaluate(() => !Object.values(state.health.weight).includes(999)));

/* ---- link opened in an already-running tab (hash change only) ---- */
const sample2 = encodeURIComponent(`steps,${await pg.evaluate(() => addDays(todayStr(), -4))},12345`);
await pg.evaluate(u => { location.hash = u; }, prefix.slice(prefix.indexOf('#') + 1) + sample2);
await pg.waitForTimeout(900);
check('open tab: link import still works', await pg.evaluate(() => Object.values(state.health.steps).includes(12345)));

/* ---- Save to Apple Health ---- */
const opened = [];
await pg.exposeFunction('__capture', u => opened.push(u));
await pg.evaluate(() => { HealthSync._open = u => window.__capture(u); });
const strengthId = await pg.evaluate(() => Object.keys(ALLEX).find(i => !/^yg_/.test(i)));
const mk = (id, exIds, extra) => pg.evaluate(([id, exIds, extra]) => {
  const ex = {}; exIds.forEach(i => ex[i] = [{ w: 50, r: 8 }, { w: 50, r: 8 }, { w: 50, r: 8 }]);
  const e = { id, date: todayStr(), dayId: 'smoke', ex, order: exIds, start: Date.now() - 46 * 60000, duration: 46 * 60, name: 'Upper A', ...extra };
  state.logs.push(e); showReview(e, { xp: 0, levelUp: null, newAch: [] }); return true;
}, [id, exIds, extra]);
await mk('t_str', [strengthId], {});
await pg.waitForTimeout(300);
check('iPhone: review sheet offers “Save to Apple Health”', await pg.evaluate(() => /Save to Apple Health/.test((document.querySelector('#rvHk') || {}).textContent || '')));
await pg.evaluate(() => document.querySelector('#rvHk').click()); await pg.waitForTimeout(300);
const u1 = opened.pop() || '';
check('runs the “Iron Log Workout” shortcut with text input', u1.startsWith('shortcuts://run-shortcut?name=Iron%20Log%20Workout&input=text&text='), u1.slice(0, 70));
const p1 = JSON.parse(decodeURIComponent(u1.split('&text=')[1] || '%7B%7D'));
check('strength payload: type, 46 min, local start time with offset', p1.type === 'strength' && p1.minutes === 46 && /T\d\d:\d\d:00[+-]\d\d:\d\d$/.test(p1.start), JSON.stringify(p1));
check('calories estimated from latest weight (151.2 lb)', p1.kcal === Math.round(5 * 151.2 * 0.4536 * 46 / 60), String(p1.kcal));
check('button shows it was sent', await pg.evaluate(() => /Sent to Apple Health/.test(document.querySelector('#rvHk').textContent)));
check('sent flag saved on the workout', await pg.evaluate(() => !!state.logs.find(l => l.id === 't_str').hk));

const yogaIds = await pg.evaluate(() => Object.keys(LIBRARY).filter(i => /^yg_/.test(i)).slice(0, 3));
await mk('t_yoga', yogaIds, { duration: 0, start: 0, name: 'Flow' });
await pg.evaluate(() => document.querySelector('#rvHk').click()); await pg.waitForTimeout(200);
const p2 = JSON.parse(decodeURIComponent((opened.pop() || '').split('&text=')[1] || '%7B%7D'));
check('yoga payload: type yoga; no timer → minutes estimated from sets', p2.type === 'yoga' && p2.minutes >= 15 && p2.minutes <= 90, JSON.stringify(p2));
const homeOK = await pg.evaluate(() => !!window.IronHomeIds);
if (homeOK) {
  await mk('t_home', await pg.evaluate(() => [...IronHomeIds].slice(0, 3)), {});
  await pg.evaluate(() => document.querySelector('#rvHk').click()); await pg.waitForTimeout(200);
  const p3 = JSON.parse(decodeURIComponent((opened.pop() || '').split('&text=')[1] || '%7B%7D'));
  check('home (bodyweight) payload: type home', p3.type === 'home', JSON.stringify(p3));
} else check('home exercise list is visible to the Health module', false);
await pg.evaluate(() => document.querySelector('#rvHkHow').click()); await pg.waitForTimeout(200);
const how = await pg.evaluate(() => document.querySelector('#woSheet').innerText);
check('how-to explains the shortcut and Health permission', /Iron Log Workout/.test(how) && /Log Workout/.test(how) && /Workouts/.test(how));

/* ---- not an Apple device: no button ---- */
{
  const { pg: P } = await device(browser, srv, { ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' });
  await P.open(); await signUp(P, 'droid', 'droid-pass-1');
  await P.evaluate(id => { const e = { id: 'a1', date: todayStr(), dayId: 'smoke', ex: { [id]: [{ w: 1, r: 1 }] }, order: [id] }; state.logs.push(e); showReview(e, { xp: 0, levelUp: null, newAch: [] }); }, strengthId);
  await P.waitForTimeout(200);
  check('Android: no Apple Health button', await P.evaluate(() => !document.querySelector('#rvHk')));
}

check('no uncaught JS errors', pg.errors.length === 0, pg.errors.slice(0, 3).join(' | '));
await browser.close(); srv.close();
process.exit(report() ? 1 : 0);
