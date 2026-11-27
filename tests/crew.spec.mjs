// Crew on the Supabase backend (stand-in server with the schema's RLS): private groups by invite link.
//   Alice starts a crew → invites Bob by link → they share workouts, like, comment, nudge.
//   Carol (not invited) sees none of it. Device-only mode shows a clear "needs an online account".
import { makeChecker, startServer, launch, device, fakeSupabase, signUp } from './harness.mjs';

const { check, info, report } = makeChecker();
const browser = await launch();
const sb = fakeSupabase();
const srv = await startServer('dist/index.html', { supabase: sb });

const openCrew = async pg => { await pg.evaluate(() => document.querySelector('.nbtn[data-view="crew"]').click()); await pg.waitForTimeout(900); };
const crewText = pg => pg.evaluate(() => document.querySelector('#crewBody').innerText);
const call = (pg, m, p, b) => pg.evaluate(([m, p, b]) => CrewLocal.call(m, p, b), [m, p, b]);
const join = async (pg, nick) => { await openCrew(pg); await pg.fill('#jnN', nick); await pg.evaluate(() => document.querySelector('#jnGo').click()); await pg.waitForTimeout(1500); };

/* ---- Alice starts a crew ---- */
const A = (await device(browser, srv, { fakeSb: true })).pg; await A.open();
await signUp(A, 'alice', 'alice-pass-1', 'Alice');
await openCrew(A);
const aJoin = await crewText(A);
check('new user sees "Start my crew"', /Start my crew/.test(aJoin) && /private group/.test(aJoin));
await join(A, 'Al');
check('Alice is in her crew', (await A.evaluate(() => CrewLocal.status())) === 'in');
const link = await A.evaluate(() => CrewLocal.inviteUrl());
check('invite link carries a private crew id', /#crew=[a-z0-9]{24}$/.test(link), link.replace(/[a-z0-9]{24}$/, '…'));
await A.evaluate(() => document.querySelector('#crewInvite') && document.querySelector('#crewInvite').click()); await A.waitForTimeout(300);
const sheet = await A.evaluate(() => (document.querySelector('#crewSheet') || {}).innerText || '');
const invVal = await A.evaluate(() => (document.querySelector('#invUrl') || {}).value || '');
check('invite sheet shows the link and who can see what', /crew link/i.test(sheet) && invVal === link && /only to people you train with/.test(sheet) && !/Claude|Editor/.test(sheet));
await A.evaluate(() => document.querySelector('#invDone') && document.querySelector('#invDone').click());

/* ---- Bob opens the invite link on his phone, signs up, joins ---- */
const B = (await device(browser, srv, { fakeSb: true })).pg;
await B.goto(link.replace(/^https?:\/\/[^/]+\//, srv.url), { waitUntil: 'load' }); await B.waitForTimeout(800);
check('invite id is removed from the address bar', !(await B.evaluate(() => location.hash.includes('crew='))));
await signUp(B, 'bob', 'bob-pass-12', 'Bob');
await B.waitForTimeout(800);
check('invited user lands on Crew with the invite', /invited to a crew/.test(await crewText(B)) && /Join this crew/.test(await crewText(B)));
await join(B, 'Bobby');
check('Bob joined', (await B.evaluate(() => CrewLocal.status())) === 'in');
const bView = await call(B, 'GET', '/crew');
check('Bob sees Alice in the crew', bView.friends.some(f => f.name === 'Al'), bView.friends.map(f => f.name).join(','));

/* ---- sharing, likes, comments, nudges ---- */
const post = { title: 'Leg day', unit: 'lb', exercises: [{ name: 'Squat', sets: ['135x5', '155x5'], pr: true }], volume: 1450, sets: 2 };
await call(A, 'PUT', '/posts/2026-11-20_legs', post);
const feedB = await call(B, 'GET', '/feed');
check('Bob sees Alice’s shared workout', feedB.posts.some(p => p.title === 'Leg day'));
const owner = feedB.posts.find(p => p.title === 'Leg day').username;
check('Bob can 💪 it', (await call(B, 'POST', `/posts/${owner}/2026-11-20_legs/like`)).liked === true);
await call(B, 'POST', `/posts/${owner}/2026-11-20_legs/comment`, { text: 'Strong!' });
await call(B, 'POST', '/nudge', { to: owner, msg: 'Gym today?' });
const aView = await call(A, 'GET', '/crew');
const kinds = aView.inbox.map(i => i.type).sort().join(',');
check('Alice’s inbox gets the like, comment and nudge', kinds === 'comment,like,nudge', kinds);
const feedA = await call(A, 'GET', '/feed');
const lp = feedA.posts.find(p => p.title === 'Leg day');
check('feed shows like count and comment', lp && lp.likes === 1 && lp.comments.some(c => c.text === 'Strong!'));
let dup = ''; try { await call(B, 'POST', '/nudge', { to: owner, msg: 'again' }); } catch (e) { dup = e.message; }
check('nudge rate limit still applies', /recently/.test(dup));

// Crew tab renders for both
await openCrew(A); const at = await crewText(A);
check('Alice’s Crew tab lists Bob', /Bobby/.test(at));

/* ---- Carol, not invited ---- */
const C = (await device(browser, srv, { fakeSb: true })).pg; await C.open();
await signUp(C, 'carol', 'carol-pass-1', 'Carol');
await join(C, 'Caz');
const cView = await call(C, 'GET', '/crew'), cFeed = await call(C, 'GET', '/feed');
check('Carol’s own crew has nobody else', cView.friends.length === 0);
check('Carol sees none of Alice’s workouts', !cFeed.posts.some(p => p.title === 'Leg day'));
const leak = JSON.stringify([...sb.docs.values()].filter(d => d.path.startsWith('ilgrp/')).map(d => d.path));
const aliceGid = link.split('#crew=')[1];
const probe = await C.evaluate(async g => { const db = await ironPlatform.use('db'); return (await db.collection('ilgrp/' + g + '/m').get()).docs.length; }, aliceGid);
check('Carol can’t read Alice’s crew even with a direct query', probe === 0);
const forge = await C.evaluate(async ([g, o]) => { const db = await ironPlatform.use('db'); try { await db.doc('ilgrp/' + g + '/m/' + o + '/posts/2026-11-21_x').set({ title: 'fake' }); return 'allowed'; } catch (e) { return 'denied'; } }, [aliceGid, owner]);
check('Carol can’t post into Alice’s crew as Alice', forge === 'denied');

/* ---- Carol switches to Alice's crew via invite; Bob leaves ---- */
await C.goto(link.replace(/^https?:\/\/[^/]+\//, srv.url), { waitUntil: 'load' }); await C.waitForTimeout(1500);
await C.waitForFunction(() => window.IronAuth && IronAuth.acct, null, { timeout: 15000 });
await openCrew(C);
const cSw = await crewText(C);
check('already in a crew: invite warns it will switch', /leaves your current crew/.test(cSw));
await join(C, 'Caz');
const cv2 = await call(C, 'GET', '/crew');
check('Carol is now in Alice’s crew', cv2.friends.some(f => f.name === 'Al'));
check('Carol’s old crew card was removed', ![...sb.docs.values()].some(d => d.path.startsWith('ilgrp/') && !d.path.startsWith('ilgrp/' + aliceGid) && d.path.endsWith('/m/' + d.path.split('/')[3]) && d.data.nick === 'Caz'));
await call(B, 'POST', '/account/delete');
check('after leaving, Bob is out of the crew', (await B.evaluate(() => CrewLocal.status())) === 'new');
const av = await call(A, 'GET', '/crew');
check('Alice no longer sees Bob', !av.friends.some(f => f.name === 'Bobby'));

/* ---- multi-device: Alice's crew follows her account ---- */
const A2 = (await device(browser, srv, { fakeSb: true })).pg; await A2.open();
await A2.waitForSelector('#ilU'); await A2.fill('#ilU', 'alice'); await A2.fill('#ilP', 'alice-pass-1'); await A2.evaluate(() => document.querySelector('#ilGo').click());
await A2.waitForFunction(() => window.IronAuth && IronAuth.acct && !document.querySelector('.ilauth'), null, { timeout: 20000 }); await A2.waitForTimeout(500);
check('Alice’s crew follows her to another phone', (await A2.evaluate(() => CrewLocal.status())) === 'in' && (await A2.evaluate(() => CrewLocal.inviteUrl())).endsWith(aliceGid));

for (const [n, p] of [['A', A], ['B', B], ['C', C], ['A2', A2]]) check(`phone ${n}: no uncaught JS errors`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
srv.close();

/* ---- device-only mode ---- */
{
  const srv2 = await startServer();
  const D = (await device(browser, srv2)).pg; await D.open();
  await signUp(D, 'solo', 'solo-pass-1');
  await openCrew(D);
  check('device-only: Crew explains it needs an online account', /needs an online Iron Log account/.test(await crewText(D)));
  check('device-only: no uncaught JS errors', D.errors.length === 0, D.errors.slice(0, 3).join(' | '));
  srv2.close();
}
await browser.close();
process.exit(report() ? 1 : 0);
