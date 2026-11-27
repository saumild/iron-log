// Running as a Claude artifact: the same page, with the host's database, user, downloads and AI.
import { makeChecker, startServer, launch, device, signUp, signIn, waitGate, waitApp, addLog, tags } from './harness.mjs';

const { check, info, report } = makeChecker();
const browser = await launch();
const srv = await startServer();
const net = [];
const { ctx, pg } = await device(browser, srv, { fakeClaude: true });
pg.on('request', r => { if (/supabase|api\.anthropic|openai|generativelanguage/.test(r.url())) net.push(r.url()); });
await pg.open();

check('[artifact] backend is the host database', (await pg.evaluate(() => ironPlatform.backend)) === 'artifact');
check('[artifact] no service worker registered', (await pg.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0);
check('[artifact] AI defaults to Claude on your plan', (await pg.evaluate(() => IronAI.get().provider)) === 'host' && await pg.evaluate(() => IronAI.ready()));
const provs = await pg.evaluate(() => [...document.querySelectorAll('#aiProv option')].map(o => o.value));
info('provider options in artifact: ' + provs.join(','));

const rc = await signUp(pg, 'cloudy', 'cloud-pass-12', 'Cloudy');
check('[artifact] sign-up works and issues a recovery code', /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(rc));
await addLog(pg, 'art-1'); await pg.waitForTimeout(500);
const stored = await pg.evaluate(() => localStorage.getItem('fake-claude-db'));
check('[artifact] data lands in the host database, encrypted', stored.includes('ilacct/') && stored.includes('ilusers/cloudy') && !stored.includes('art-1'));

await pg.reload(); await waitApp(pg);
check('[artifact] reload opens the account and its data', (await tags(pg)).includes('art-1'));
await pg.evaluate(() => IronAuth.signOut()); await pg.waitForLoadState('load'); await waitGate(pg);
check('[artifact] wrong password rejected', /wrong/i.test(await signIn(pg, 'cloudy', 'nope-nope-12')));
await pg.reload(); await waitGate(pg);
check('[artifact] password sign-in works', (await signIn(pg, 'cloudy', 'cloud-pass-12')) === '');
check('[artifact] data intact after sign-in', (await tags(pg)).includes('art-1'));

// AI goes to the host's sample(), not to a provider over the network
await pg.evaluate(() => { window.__sampleReply = 'PLAN FROM CLAUDE'; });
const ai = await pg.evaluate(async () => { const fn = await ironPlatform.use('sample'); const r = await fn('write a plan', {}); return { text: r.text, calls: window.__sampleCalls.length }; });
check('[artifact] AI answers through the host (no key)', ai.text === 'PLAN FROM CLAUDE' && ai.calls === 1, JSON.stringify(ai));
await pg.evaluate(() => { try { document.querySelector('[data-view="you"],#tab-you,[data-v="you"]').click(); } catch (e) {} });
await pg.evaluate(() => { try { IronAI.renderCard(); } catch (e) {} });
const card = await pg.evaluate(() => (document.getElementById('aiCard') || { textContent: '' }).textContent);
check('[artifact] AI card explains Claude on your plan, no key field', /Claude plan/i.test(card) && !(await pg.$('#aiKey')), card.slice(0, 120));

// backup export goes through the host's downloads
const dl = await pg.evaluate(async () => { const d = await ironPlatform.use('downloads'); const r = await d.save({ filename: 't.json', data: '{}' }); return { r, got: window.__downloaded }; });
check('[artifact] downloads go through the host', dl.r.status === 'saved' && dl.got.filename === 't.json');

check('[artifact] nothing sent to Supabase or any AI provider', net.length === 0, net.join(', '));
check('[artifact] no uncaught JS errors', pg.errors.length === 0, pg.errors.slice(0, 3).join(' | '));

// the same page outside an artifact still offers the key providers and copy & paste
const { pg: web } = await device(browser, srv); await web.open();
check('[web] no "Claude plan" provider outside an artifact', (await web.evaluate(() => IronAI.get().provider)) === 'bridge' && !(await web.evaluate(() => [...document.querySelectorAll('#aiProv option')].some(o => o.value === 'host'))));
srv.close(); await browser.close();
process.exit(report() ? 1 : 0);
