// Shared test harness: serves dist/, launches phone-sized pages, and (optionally) runs a
// stand-in Supabase server whose row-level-security mirrors supabase/schema.sql.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function makeChecker() {
  const lines = []; let failed = 0;
  const check = (name, ok, info = '') => { lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); if (!ok) failed++; };
  const info = s => lines.push('INFO  ' + s);
  const report = () => { console.log(lines.join('\n')); console.log(`\n${failed ? failed + ' FAILED' : 'ALL PASSED'}`); return failed; };
  return { check, info, report };
}

/* ---------------- fake Supabase (auth + docs table + RLS) ---------------- */
export function fakeSupabase() {
  const users = new Map();     // email -> {id, password}
  const tokens = new Map();    // token -> uid
  const docs = new Map();      // path -> {path,parent,owner,data}
  const uidOf = t => (t && tokens.get(t)) || null;
  const ownsAcct = (acct, uid) => { const d = docs.get('ilacct/' + acct); return !!d && d.owner === uid; };
  const canRead = (row, uid) => row.parent === 'ilusers' || (uid && (row.parent === 'ilcrew' || row.parent.startsWith('ilcrew/'))) || (uid && row.owner === uid);
  const canInsert = (row, uid) => {
    if (!uid || row.owner !== uid) return false;
    const p = row.parent, seg = row.path.split('/');
    return p === 'ilusers' || p === 'ilacct'
      || (/^ilacct\/[^/]+\/data$/.test(p) && ownsAcct(seg[1], uid))
      || p === 'data/users/' + uid
      || (p === 'ilcrew' && ownsAcct(seg[1], uid))
      || (/^ilcrew\/[^/]+\/posts$/.test(p) && ownsAcct(seg[1], uid))
      || /^ilcrew\/[^/]+\/(likes|comments|nudges)$/.test(p);
  };
  const stats = { denied: 0 };
  function handle(body) {
    const uid = uidOf(body.token);
    if (body.kind === 'signup') {
      if (users.has(body.email)) return { error: { message: 'User already registered' } };
      const id = crypto.randomUUID(); users.set(body.email, { id, password: body.password });
      const t = crypto.randomUUID(); tokens.set(t, id); return { data: { user: { id, email: body.email }, session: { access_token: t, user: { id, email: body.email } } } };
    }
    if (body.kind === 'signin') {
      const u = users.get(body.email);
      if (!u || u.password !== body.password) return { error: { message: 'Invalid login credentials' } };
      const t = crypto.randomUUID(); tokens.set(t, u.id); return { data: { user: { id: u.id, email: body.email }, session: { access_token: t, user: { id: u.id, email: body.email } } } };
    }
    if (body.kind === 'signout') { tokens.delete(body.token); return { data: {} }; }
    // table ops
    const visible = [...docs.values()].filter(r => canRead(r, uid));
    const match = r => (body.filters || []).every(([col, v]) => col.startsWith('data->>') ? String(r.data[col.slice(7)]) === v : String(r[col]) === v);
    if (body.op === 'select') {
      let rows = visible.filter(match);
      if (body.order) { const f = body.order.col.replace(/^data->/, ''), s = body.order.ascending ? 1 : -1; rows.sort((a, b) => a.data[f] === b.data[f] ? 0 : (a.data[f] > b.data[f] ? s : -s)); }
      if (body.limit) rows = rows.slice(0, body.limit);
      return { data: rows.map(r => ({ path: r.path, data: r.data })) };
    }
    if (body.op === 'upsert') {
      const row = { ...body.row, owner: uid };
      const cur = docs.get(row.path);
      if (cur) { if (cur.owner !== uid) { stats.denied++; return { error: { message: 'new row violates row-level security policy', code: '42501' } }; } }
      else if (!canInsert(row, uid)) { stats.denied++; return { error: { message: 'new row violates row-level security policy', code: '42501' } }; }
      docs.set(row.path, { path: row.path, parent: row.parent, owner: uid, data: row.data }); return { data: null };
    }
    if (body.op === 'delete') {
      for (const r of [...docs.values()]) if (match(r) && r.owner === uid) docs.delete(r.path);
      return { data: null };
    }
    return { error: { message: 'bad op' } };
  }
  return { handle, docs, users, stats };
}

// Browser-side stand-in for window.supabase (only the calls js/platform.js makes)
const FAKE_CLIENT = `(() => {
  const call = body => fetch('/__fsb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const SK = 'fsb-session';
  const getS = () => { try { return JSON.parse(localStorage.getItem(SK) || 'null'); } catch (e) { return null; } };
  const tok = () => { const s = getS(); return s && s.access_token; };
  function builder(table) {
    const st = { filters: [] };
    const run = () => call({ ...st, token: tok(), table }).then(r => {
      if (st.single && !r.error) { const d = r.data || []; return { data: d[0] || null, error: null }; }
      return { data: r.data ?? null, error: r.error || null };
    });
    const b = {
      select() { st.op = st.op || 'select'; return b; },
      eq(col, v) { st.filters.push([col, String(v)]); return b; },
      order(col, o) { st.order = { col, ascending: o ? o.ascending !== false : true }; return b; },
      limit(n) { st.limit = n; return b; },
      maybeSingle() { st.single = true; return b; },
      upsert(row) { st.op = 'upsert'; st.row = row; return b; },
      delete() { st.op = 'delete'; return b; },
      then(res, rej) { return run().then(res, rej); },
    };
    return b;
  }
  const client = {
    from: builder,
    auth: {
      async getSession() { return { data: { session: getS() } }; },
      async signUp({ email, password }) { const r = await call({ kind: 'signup', email, password }); if (r.data) localStorage.setItem(SK, JSON.stringify(r.data.session)); return { data: r.data || {}, error: r.error || null }; },
      async signInWithPassword({ email, password }) { const r = await call({ kind: 'signin', email, password }); if (r.data) localStorage.setItem(SK, JSON.stringify(r.data.session)); return { data: r.data || {}, error: r.error || null }; },
      async signOut() { await call({ kind: 'signout', token: tok() }); localStorage.removeItem(SK); return { error: null }; },
    },
  };
  Object.defineProperty(window, 'supabase', { value: { createClient: () => client }, writable: false, configurable: false });
  Object.defineProperty(window, 'IRONLOG_CONFIG', { value: { supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon', emailDomain: 'users.ironlog.app' }, writable: false, configurable: false });
})();`;

export async function startServer(file = 'dist/index.html', { supabase = null } = {}) {
  const abs = path.resolve(file), root = path.dirname(abs);
  const server = http.createServer((req, res) => {
    if (req.url === '/__fsb' && supabase) {
      let b = ''; req.on('data', c => b += c); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(supabase.handle(JSON.parse(b)))); });
      return;
    }
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const p = path.join(root, rel === '/' ? path.basename(abs) : rel);
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') || p.endsWith('.webmanifest') ? 'application/json' : p.endsWith('.png') ? 'image/png' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }); res.end(buf);
    });
  });
  await new Promise(r => server.listen(0, r));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close(), swExists: fs.existsSync(path.join(root, 'sw.js')) };
}

export async function launch() { return chromium.launch(); }

// A "device": its own browser context (separate storage), phone viewport.
export async function device(browser, srv, { fakeSb = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  if (fakeSb) await ctx.addInitScript(FAKE_CLIENT);
  else await ctx.addInitScript(`Object.defineProperty(window, 'IRONLOG_CONFIG', { value: { supabaseUrl: '', supabaseAnonKey: '' }, writable: false, configurable: false });`);
  const pg = await ctx.newPage();
  await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await pg.route(/supabase\.co/, r => r.abort());   // tests never touch the real project
  pg.errors = [];
  pg.on('pageerror', e => pg.errors.push('pageerror: ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::|Failed to load resource|row-level security|persist failed|plan failed|form check failed|coach failed/.test(m.text()) && !(!srv.swExists && /fetching the script/.test(m.text()))) pg.errors.push('console: ' + m.text()); });
  pg.on('dialog', d => d.dismiss());
  pg.open = async () => { await pg.goto(srv.url, { waitUntil: 'load' }); await pg.waitForTimeout(900); };
  return { ctx, pg };
}

/* ---------- sign-in screen helpers ---------- */
export const gateVisible = pg => pg.evaluate(() => !!document.querySelector('.ilauth'));
export async function waitGate(pg, ms = 8000) { await pg.waitForFunction(() => !!document.querySelector('.ilauth #ilGo, .ilauth [data-pid]'), null, { timeout: ms }); }
export async function waitApp(pg, ms = 15000) { await pg.waitForFunction(() => !document.querySelector('.ilauth') && typeof state === 'object' && state && window.IronAuth && IronAuth.acct, null, { timeout: ms }); await pg.waitForTimeout(400); }
export async function signUp(pg, user, pw, name = user) {
  await waitGate(pg);
  await pg.evaluate(() => document.querySelector('.ilauth [data-m="up"]').click());
  await pg.fill('#ilU', user); await pg.fill('#ilN', name); await pg.fill('#ilP', pw); await pg.fill('#ilP2', pw);
  await pg.evaluate(() => document.querySelector('#ilGo').click());
  await pg.waitForSelector('#ilRc', { timeout: 45000 });
  const code = (await pg.textContent('#ilRc')).trim();
  await pg.check('#ilSaved'); await pg.evaluate(() => document.querySelector('#ilGo').click());
  await waitApp(pg);
  return code;
}
export async function signIn(pg, user, pw) {
  await waitGate(pg);
  await pg.fill('#ilU', user); await pg.fill('#ilP', pw);
  await pg.evaluate(() => document.querySelector('#ilGo').click());
  await pg.waitForFunction(() => !document.querySelector('.ilauth') || (document.querySelector('#ilErr') && document.querySelector('#ilErr').textContent.trim()), null, { timeout: 20000 });
  const err = await pg.evaluate(() => { const e = document.querySelector('#ilErr'); return e ? e.textContent.trim() : ''; });
  if (!err) await waitApp(pg);
  return err;
}
export async function addLog(pg, tag) {
  return pg.evaluate(async tag => { state.logs.push({ date: '2020-01-0' + (1 + state.logs.length % 9), dayId: 'smoke', ex: { smoke_ex: [{ w: 10, r: 5 }] }, __tag: tag }); return persist(); }, tag);
}
export const tags = pg => pg.evaluate(() => (state.logs || []).map(l => l.__tag).filter(Boolean));
