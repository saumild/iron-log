// Bring-your-own-AI: OpenAI / Anthropic / Gemini (stand-in endpoints) and copy & paste mode.
import { makeChecker, startServer, launch, device, signUp } from './harness.mjs';

const { check, info, report } = makeChecker();
const srv = await startServer();
const browser = await launch();
const { pg } = await device(browser, srv);
await pg.open();
await signUp(pg, 'aitest', 'ai-pass-123');

// a valid plan reply built from real library ids
const ids = await pg.evaluate(() => Object.keys(ALLEX).slice(0, 3));
const planJSON = JSON.stringify({ title: 'Stand-in plan', focus: 'test', why: 'because', exercises: ids.map(id => ({ id, sets: [{ type: 'normal', reps: '8', load: 20 }, { type: 'normal', reps: '8', load: 20 }], rest: 90 })) });

// stand-in provider servers
const seen = [];
let mode = 'ok';
const reply = {
  openai: () => ({ choices: [{ message: { content: planJSON } }] }),
  anthropic: () => ({ content: [{ type: 'text', text: planJSON }] }),
  gemini: () => ({ candidates: [{ content: { parts: [{ text: planJSON }] } }] }),
};
for (const [prov, re] of [['openai', /api\.openai\.com/], ['anthropic', /api\.anthropic\.com/], ['gemini', /generativelanguage\.googleapis\.com/]]) {
  await pg.route(re, async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    seen.push({ prov, url: req.url(), headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (mode === '401') return route.fulfill({ status: 401, headers: cors, body: JSON.stringify({ error: { message: 'Incorrect API key' } }) });
    route.fulfill({ status: 200, headers: cors, body: JSON.stringify(reply[prov]()) });
  });
}

const setProvider = (provider, key, model = '') => pg.evaluate(async ([provider, key, model]) => { IronAI.set({ provider, key, model }); await new Promise(r => { window.aiProviderChanged(); setTimeout(r, 200); }); return API_AVAILABLE; }, [provider, key, model]);
const askPlan = async () => {
  await pg.evaluate(() => document.querySelector('.nbtn[data-view="train"]').click());
  await pg.waitForTimeout(300);
  await pg.evaluate(() => document.querySelector('#plAI').click());
  await pg.waitForTimeout(1500);
  return pg.evaluate(() => ({ body: document.querySelector('#aiBody').innerText, title: (document.querySelector('.plan-ttl,.plan h2,.plan-title') || {}).innerText || '', planTitle: (typeof Planner !== 'undefined' && Planner.current && Planner.current()) ? '' : '' }));
};
const planIs = () => pg.evaluate(() => { const t = document.body.innerText; return t.includes('Stand-in plan'); });

// default is copy & paste
check('default mode is copy & paste (no key)', (await pg.evaluate(() => IronAI.get().provider)) === 'bridge' && (await pg.evaluate(() => API_AVAILABLE)) === false);

for (const [prov, key, expectModel] of [['openai', 'sk-test-openai', 'gpt-5.6-terra'], ['anthropic', 'sk-ant-test', 'claude-sonnet-5-5'], ['gemini', 'AIza-test', 'gemini-3.5-flash-lite']]) {
  seen.length = 0; mode = 'ok';
  check(`[${prov}] provider enables in-app AI`, (await setProvider(prov, key)) === true);
  await askPlan();
  const r = seen.find(s => s.prov === prov);
  check(`[${prov}] request sent to provider`, !!r);
  if (!r) continue;
  const h = r.headers, b = r.body;
  if (prov === 'openai') {
    check('[openai] bearer key header', h.authorization === 'Bearer ' + key);
    check('[openai] model + prompt', b.model === expectModel && JSON.stringify(b.messages).includes('JSON'), b.model);
  } else if (prov === 'anthropic') {
    check('[anthropic] key + version + browser-access headers', h['x-api-key'] === key && h['anthropic-version'] === '2023-06-01' && h['anthropic-dangerous-direct-browser-access'] === 'true');
    check('[anthropic] model + prompt', b.model === expectModel && JSON.stringify(b.messages).includes('JSON'), b.model);
  } else {
    check('[gemini] key in header, not in URL', h['x-goog-api-key'] === key && !r.url.includes(key));
    check('[gemini] model in path + prompt', r.url.includes('/models/' + expectModel + ':generateContent') && JSON.stringify(b.contents).includes('JSON'));
  }
  check(`[${prov}] AI plan applied to Train screen`, await planIs());
  // reset plan text so the next provider's plan is detectable
  await pg.evaluate(() => { document.querySelector('#aiScrim') && document.querySelector('#aiScrim').classList.remove('show'); });
  await pg.evaluate(() => { for (const k of Object.keys(state.plans || {})) delete state.plans[k]; });
}

// custom model is respected
seen.length = 0;
await setProvider('openai', 'sk-test-openai', 'my-custom-model');
await askPlan();
check('custom model name is used', (seen[0] || {}).body?.model === 'my-custom-model');

// images (form check path) reach each provider in its own format
const imgShapes = await pg.evaluate(async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const out = {};
  for (const p of ['openai', 'anthropic', 'gemini']) {
    IronAI.set({ provider: p, key: 'k-' + p, model: '' }); await initSample();
    try { await askAI([{ type: 'text', text: 'check form' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }], 100); out[p] = 'ok'; } catch (e) { out[p] = e.message; }
  }
  return out;
});
const imgReq = p => seen.filter(s => s.prov === p).pop();
check('[openai] image sent as data URL', imgShapes.openai === 'ok' && JSON.stringify(imgReq('openai').body).includes('data:image/png;base64,'));
check('[anthropic] image sent as base64 block', imgShapes.anthropic === 'ok' && JSON.stringify(imgReq('anthropic').body).includes('"media_type":"image/png"'));
check('[gemini] image sent as inline_data', imgShapes.gemini === 'ok' && JSON.stringify(imgReq('gemini').body).includes('inline_data'));

// bad key → readable message
mode = '401';
await setProvider('anthropic', 'sk-ant-bad');
const bad = await askPlan();
check('bad key shows a readable fix', /API key was refused/.test(bad.body), bad.body.slice(0, 120));
mode = 'ok';

// the key never leaves the device: not in app state, backups or the account database
const leak = await pg.evaluate(async () => {
  const st = JSON.stringify(state);
  const enc = (await IronAuth.readState()) || '';
  let copied = ''; navigator.clipboard.writeText = async t => { copied = t; }; document.querySelector('#copyBtn').click(); await new Promise(r => setTimeout(r, 500));
  const db = await ironPlatform.use('db'); const all = JSON.stringify((await db.collection('ilusers').get()).docs.map(d => d.data()));
  return [st, enc, copied, all].some(s => s.includes('sk-ant-bad'));
});
check('API key is not in app data, backups or the account database', leak === false);

// copy & paste mode: prompt goes out, pasted reply comes back in
await setProvider('bridge', '');
await pg.evaluate(() => { for (const k of Object.keys(state.plans || {})) delete state.plans[k]; });
const br = await askPlan();
check('copy & paste: names any AI app', /ChatGPT, Claude, Gemini or any AI app/.test(br.body), br.body.slice(0, 100));
check('copy & paste: no request sent by the app', !seen.some(s => s.headers['x-api-key'] === ''));
const prompt = await pg.evaluate(async () => { let c = ''; navigator.clipboard.writeText = async t => { c = t; }; document.querySelector('#brCopy').click(); await new Promise(r => setTimeout(r, 200)); return c; });
check('copy & paste: prompt copied', prompt.length > 200 && prompt.includes('JSON'));
await pg.evaluate(j => { document.querySelector('#brBox').value = '```json\n' + j + '\n```'; document.querySelector('#brApply').click(); }, planJSON);
await pg.waitForTimeout(800);
check('copy & paste: pasted reply (even in ```json fences) becomes the plan', await planIs());

// settings card renders and switches
await pg.evaluate(() => document.querySelector('.nbtn[data-view="you"]').click()); await pg.waitForTimeout(300);
const card = await pg.evaluate(() => { const el = document.querySelector('#aiCard'); return el ? el.innerText : ''; });
check('You tab has the AI coach card', /AI coach/.test(card) && /ChatGPT, Claude, Gemini/.test(card));
await pg.selectOption('#aiProv', 'gemini'); await pg.waitForTimeout(200);
check('switching provider shows key + model fields', await pg.evaluate(() => !!document.querySelector('#aiKey') && document.querySelector('#aiModel').placeholder === 'gemini-3.5-flash-lite'));

check('no uncaught JS errors', pg.errors.length === 0, pg.errors.slice(0, 3).join(' | '));
await browser.close(); srv.close();
process.exit(report() ? 1 : 0);
