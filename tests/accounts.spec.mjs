// Accounts + data isolation, in both backends.
//   device mode:   one phone, two profiles
//   supabase mode: stand-in Supabase server with the schema's RLS, two separate phones
import { makeChecker, startServer, launch, device, fakeSupabase, signUp, signIn, waitGate, waitApp, addLog, tags } from './harness.mjs';

const { check, info, report } = makeChecker();
const browser = await launch();

const toSignIn = async pg => { // "Switch profile" → back to the sign-in screen
  await pg.evaluate(() => IronAuth.switchProfile()); await pg.waitForLoadState('load'); await waitGate(pg);
};
const signOut = async pg => { await pg.evaluate(() => IronAuth.signOut()); await pg.waitForLoadState('load'); await waitGate(pg); };
const forgot = async (pg, user, code, pw) => {
  await waitGate(pg); await pg.evaluate(() => document.querySelector('#ilForgot').click());
  await pg.fill('#ilU', user); await pg.fill('#ilRc2', code); await pg.fill('#ilP', pw);
  await pg.evaluate(() => document.querySelector('#ilGo').click());
  await pg.waitForFunction(() => !document.querySelector('.ilauth') || document.querySelector('#ilErr').textContent.trim(), null, { timeout: 20000 });
  const err = await pg.evaluate(() => { const e = document.querySelector('#ilErr'); return e ? e.textContent.trim() : ''; });
  if (!err) await waitApp(pg); return err;
};

/* ======================= device mode ======================= */
{
  info('--- device mode ---');
  const srv = await startServer();
  const { pg } = await device(browser, srv);
  await pg.open();
  check('[device] backend is device', (await pg.evaluate(() => ironPlatform.backend)) === 'device');
  // regression: the sign-in screen's delayed auto-focus must not pull focus out of a field being filled
  await waitGate(pg);
  const focusRace = await pg.evaluate(async () => {
    document.querySelector('.ilauth [data-m="up"]').click();            // re-renders; schedules auto-focus in 60 ms
    const pw = document.querySelector('#ilP'); pw.focus(); pw.value = 'typed-fast';   // a field is in use right away
    await new Promise(r => setTimeout(r, 200));
    return { stillInPassword: document.activeElement === document.querySelector('#ilP'), user: document.querySelector('#ilU').value };
  });
  check('[device] sign-in screen doesn’t steal focus from a field in use', focusRace.stillInPassword && focusRace.user === '', JSON.stringify(focusRace));
  await pg.reload(); await waitGate(pg);
  const rcA = await signUp(pg, 'alice', 'alice-pass-1', 'Alice');
  check('[device] recovery code issued', /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(rcA), rcA);
  await addLog(pg, 'a-1');
  await toSignIn(pg);
  await signUp(pg, 'bob', 'bob-pass-12', 'Bob');
  check('[device] new profile starts empty (no Alice data)', !(await tags(pg)).includes('a-1'));
  await addLog(pg, 'b-1');
  await toSignIn(pg);
  const picker = await pg.$$eval('[data-pid]', bs => bs.map(b => b.textContent));
  check('[device] both profiles listed on this device', picker.length === 2, picker.join(' / '));
  await pg.evaluate(() => [...document.querySelectorAll('[data-pid]')].find(b => /alice/.test(b.textContent)).click());
  await waitApp(pg);
  const at = await tags(pg);
  check('[device] Alice sees only her data', at.includes('a-1') && !at.includes('b-1'), at.join(','));
  await signOut(pg);
  check('[device] wrong password rejected', /wrong/i.test(await signIn(pg, 'alice', 'nope-nope-1')));
  await pg.reload(); await waitGate(pg);
  check('[device] recovery code resets password', (await forgot(pg, 'alice', rcA, 'alice-new-pass')) === '');
  check('[device] data intact after recovery', (await tags(pg)).includes('a-1'));
  await signOut(pg);
  check('[device] old password no longer works', /wrong/i.test(await signIn(pg, 'alice', 'alice-pass-1')));
  await pg.reload(); await waitGate(pg);
  check('[device] new password works', (await signIn(pg, 'alice', 'alice-new-pass')) === '');
  check('[device] no uncaught JS errors', pg.errors.length === 0, pg.errors.slice(0, 3).join(' | '));
  srv.close();
}

/* ======================= supabase mode ======================= */
{
  info('--- supabase mode (stand-in server with schema RLS) ---');
  const sb = fakeSupabase();
  const srv = await startServer('dist/index.html', { supabase: sb });
  const A = (await device(browser, srv, { fakeSb: true })).pg;   // phone 1
  const B = (await device(browser, srv, { fakeSb: true })).pg;   // phone 2
  await A.open(); await B.open();
  check('[sb] backend is supabase', (await A.evaluate(() => ironPlatform.backend)) === 'supabase');

  const rc = await signUp(A, 'alice', 'alice-pass-1', 'Alice');
  await addLog(A, 'a-sync');
  await A.waitForTimeout(500);

  const stored = JSON.stringify([...sb.docs.values()]);
  check('[sb] workout data is encrypted at rest (no plaintext in DB)', !stored.includes('a-sync') && stored.includes('ilacct/'));
  const u = [...sb.users.values()][0];
  check('[sb] backend password is not the user password', u && u.password !== 'alice-pass-1' && u.password.startsWith('il1-'));
  check('[sb] login address is synthetic', [...sb.users.keys()][0] === 'alice@users.ironlog.app');

  check('[sb] sign in on a second phone', (await signIn(B, 'alice', 'alice-pass-1')) === '');
  check('[sb] second phone sees synced workout', (await tags(B)).includes('a-sync'));
  await addLog(B, 'a-from-B'); await B.waitForTimeout(400);
  await A.reload(); await waitApp(A);
  check('[sb] first phone sees workout logged on second', (await tags(A)).includes('a-from-B'));

  // multi-device safety: an unchanged phone closing must not wipe the other phone's newer save
  await addLog(B, 'b-newer'); await B.waitForTimeout(300);
  await A.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await A.waitForTimeout(500);
  const dbTags = async p => JSON.parse(await p.evaluate(() => IronAuth.readState())).logs.map(l => l.__tag).filter(Boolean);
  check('[sb] closing an unchanged phone keeps newer data from the other phone', (await dbTags(B)).includes('b-newer'));
  // ...but real unsaved edits are still saved on close
  await B.evaluate(() => { state.logs.push({ id: '2020-02-02_tunsaved', date: '2020-02-02', dayId: 'smoke', ex: { smoke_ex: [{ w: 1, r: 1 }] }, __tag: 'unsaved-edit' }); window.dispatchEvent(new Event('pagehide')); });
  await B.waitForTimeout(600);
  check('[sb] unsaved edits are still saved on close', (await dbTags(B)).includes('unsaved-edit'));
  // coming back to the foreground picks up the other phone's changes
  await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await A.waitForTimeout(1500); await waitApp(A);
  check('[sb] returning to the app shows the other phone’s new workouts', (await tags(A)).includes('unsaved-edit'));

  // second person on phone 2
  await toSignIn(B);
  const dup = await B.evaluate(async () => {
    document.querySelector('.ilauth [data-m="up"]').click(); await new Promise(r => setTimeout(r, 100));
    for (const [id, v] of [['ilU', 'alice'], ['ilN', 'x'], ['ilP', 'whatever-1'], ['ilP2', 'whatever-1']]) document.getElementById(id).value = v;
    document.getElementById('ilGo').click(); await new Promise(r => setTimeout(r, 1500));
    return document.getElementById('ilErr').textContent;
  });
  check('[sb] taken username refused', /taken/i.test(dup), dup);
  await B.reload(); await waitGate(B);
  await signUp(B, 'bob', 'bob-pass-12', 'Bob');
  check('[sb] Bob starts empty', (await tags(B)).length === 0);

  // RLS probes from Bob's session
  const aliceAcct = [...sb.docs.values()].find(d => d.path.startsWith('ilusers/alice')).data.acct;
  const probe = await B.evaluate(async acct => {
    const db = await ironPlatform.use('db'); const out = {};
    out.readAliceData = (await db.doc('ilacct/' + acct + '/data/m').get()).exists;
    try { await db.doc('ilusers/alice').set({ acct: 'hijack' }); out.overwriteUser = 'allowed'; } catch (e) { out.overwriteUser = 'denied'; }
    try { await db.doc('ilacct/' + acct + '/data/m').set({ chunks: 0 }); out.overwriteData = 'allowed'; } catch (e) { out.overwriteData = 'denied'; }
    try { await db.doc('ilgrp/abcdefghijklmnopqrstuvwx/m/' + acct).set({ name: 'fake alice' }); out.impersonateCrew = 'allowed'; } catch (e) { out.impersonateCrew = 'denied'; }
    return out;
  }, aliceAcct);
  check("[sb] Bob can't read Alice's data", probe.readAliceData === false);
  check("[sb] Bob can't overwrite Alice's username entry", probe.overwriteUser === 'denied');
  check("[sb] Bob can't overwrite Alice's data", probe.overwriteData === 'denied');
  check("[sb] Bob can't post to Crew as Alice", probe.impersonateCrew === 'denied');

  // recovery on a phone with no session
  const C = (await device(browser, srv, { fakeSb: true })).pg; await C.open();
  check('[sb] recovery works on a fresh phone', (await forgot(C, 'alice', rc, 'alice-new-pass')) === '');
  check('[sb] data intact after recovery', (await tags(C)).includes('a-sync'));
  await signOut(C);
  check('[sb] new password works', (await signIn(C, 'alice', 'alice-new-pass')) === '');

  for (const [n, p] of [['A', A], ['B', B], ['C', C]]) check(`[sb] phone ${n}: no uncaught JS errors`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  srv.close();
}

await browser.close();
process.exit(report() ? 1 : 0);
