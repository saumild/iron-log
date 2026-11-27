/* js/auth.js — Iron Log accounts (inside Claude).
   History, XP, streaks, records, check-ins, photos, plans and settings belong to an Iron Log
   account, not to whichever Claude account opens the page.

   The page's shared db is readable by everyone the artifact is shared with, so account data is
   end-to-end encrypted:
     ilusers/<username>        {acct, name, salt, iter, wrap, rsalt, rwrap}   (no secrets: wrapped key only)
     ilacct/<acct>             {name, created}
     ilacct/<acct>/data/m      {chunks, iv, savedAt}     manifest
     ilacct/<acct>/data/c<i>   {s}                        AES-GCM ciphertext, base64, chunked
   A random data key (DEK) encrypts the state. It is stored only wrapped: by a key derived from the
   password (PBKDF2-SHA256) and by one derived from a one-time recovery code.
   Each Claude account that signs in keeps, in its own private space (data/users/<claude id>/):
     (no sign-in is remembered per Claude account: several people can share one Claude account,
      so "stay signed in" lives on the device, one entry per Iron Log account — see devProfiles)
     ilbak-<acct>-m / -c<i>    a private copy of the same ciphertext, in case the shared copy is lost */
(function(){
if(!(typeof window!=='undefined'&&window.claude&&typeof window.claude.use==='function')) return;
const te=new TextEncoder(), td=new TextDecoder();
const ITER=310000, CHUNK=100000;
const b64=buf=>{ const a=buf instanceof Uint8Array?buf:new Uint8Array(buf); let s=''; for(let i=0;i<a.length;i+=0x8000) s+=String.fromCharCode.apply(null,a.subarray(i,i+0x8000)); return btoa(s); };
const unb64=s=>{ const bin=atob(s); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; };
const rnd=n=>crypto.getRandomValues(new Uint8Array(n));
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function kek(secret,salt,iter){
  const base=await crypto.subtle.importKey('raw',te.encode(secret),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function seal(key,bytes){ const iv=rnd(12); const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,bytes); return {iv:b64(iv),ct:b64(ct)}; }
async function unseal(key,box){ return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(box.iv)},key,unb64(box.ct))); }
const dekKey=raw=>crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
const normUser=u=>String(u||'').trim().toLowerCase().replace(/^@/,'');
const USER_RE=/^[a-z0-9_.]{3,20}$/;
const RC_ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRecovery=()=>{ const b=rnd(20); let s=''; for(let i=0;i<20;i++){ s+=RC_ALPHA[b[i]%RC_ALPHA.length]; if(i%5===4&&i<19) s+='-'; } return s; };
const normRecovery=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');

let db=null, cid=null, ready=null;
const A={acct:null, dek:null, dekRaw:null};
function init(){
  return ready||(ready=(async()=>{
    const [d,u]=await Promise.all([window.claude.use('db'),window.claude.use('user')]);
    if(!d||!u) return false;
    const id=await u.id(); if(!id) return false;
    db=d; cid=id; return true;
  })().catch(()=>false));
}
const userRef=u=>db.doc('ilusers/'+u);
const acctRef=a=>db.doc('ilacct/'+a);
const dataDoc=(a,n)=>db.collection('ilacct/'+a+'/data').doc(n);
const mine=n=>db.collection('data/users/'+cid).doc(n);

/* ---------- encrypted state ---------- */
let chain=Promise.resolve();
const serial=fn=>{ const run=chain.then(fn); chain=run.catch(()=>{}); return run; };
async function readBlob(docFor){
  const m=await docFor('m').get(); if(!m.exists) return null;
  const md=m.data(), n=+md.chunks||0; let ct='';
  for(let i=0;i<n;i++){ const c=await docFor('c'+i).get(); if(!c.exists) return null; ct+=String(c.data().s||''); }
  return {iv:md.iv,ct,savedAt:md.savedAt||''};
}
async function writeBlob(docFor,box,savedAt){
  const parts=[]; for(let i=0;i<box.ct.length;i+=CHUNK) parts.push(box.ct.slice(i,i+CHUNK));
  for(let i=0;i<parts.length;i++) await docFor('c'+i).set({s:parts[i]});
  await docFor('m').set({chunks:parts.length,iv:box.iv,savedAt});
}
const sharedDocs=()=>n=>dataDoc(A.acct.id,n);
const backupDocs=()=>n=>mine('ilbak-'+A.acct.id+'-'+n);
async function tryOpen(box){ if(!box||!box.ct) return null; try{ return td.decode(await unseal(A.dek,box)); }catch(e){ return null; } }
/* newest readable copy wins; a missing or damaged shared copy is repaired from the private backup */
async function readState(){
  const [sh,bk]=await Promise.all([readBlob(sharedDocs()).catch(()=>null),readBlob(backupDocs()).catch(()=>null)]);
  const s=await tryOpen(sh), b=await tryOpen(bk);
  if(s&&(!b||String(sh.savedAt)>=String(bk.savedAt))) return s;
  if(b){ try{ await serial(()=>writeBlob(sharedDocs(),{iv:bk.iv,ct:bk.ct},bk.savedAt)); }catch(e){} return b; }
  return s;
}
let bakTimer=null, lastBox=null;
function scheduleBackup(){
  clearTimeout(bakTimer);
  bakTimer=setTimeout(()=>{ const x=lastBox; if(x) serial(()=>writeBlob(backupDocs(),x.box,x.at)).catch(()=>{}); },4000);
}
async function writeState(str){
  if(!A.acct) throw new Error('not signed in');
  const box=await seal(A.dek,te.encode(str)), at=new Date().toISOString();
  await serial(()=>writeBlob(sharedDocs(),box,at));
  lastBox={box,at}; scheduleBackup();
}
/* push the pending backup now (sign-out, page hide) */
function flushBackup(){ if(bakTimer&&lastBox){ clearTimeout(bakTimer); bakTimer=null; const x=lastBox; return serial(()=>writeBlob(backupDocs(),x.box,x.at)).catch(()=>{}); } return Promise.resolve(); }
addEventListener('pagehide',()=>{ flushBackup(); });

/* ---------- sessions ----------
   Remembered sign-ins are kept on this device, one per Iron Log account, never per Claude account:
   two people sharing a Claude account each get their own profile. `last` is the profile this
   device opens straight into; with no `last`, the sign-in screen lists the remembered profiles. */
const DEV_KEY='ironlog-profiles';
function devGet(){ try{ const r=JSON.parse(localStorage.getItem(DEV_KEY)||'null'); if(r&&r.list&&typeof r.list==='object') return r; }catch(e){} return {last:null,list:{}}; }
function devPut(v){ try{ localStorage.setItem(DEV_KEY,JSON.stringify(v)); }catch(e){} }
async function setSignedIn(acct,raw,remember){
  A.acct=acct; A.dekRaw=raw; A.dek=await dekKey(raw);
  const dv=devGet();
  if(remember) dv.list[acct.id]={username:acct.username,name:acct.name,dek:b64(raw),at:Date.now()};
  dv.last=dv.list[acct.id]?acct.id:null; devPut(dv);
}
async function openRemembered(id){
  const dv=devGet(), d=dv.list[id]; if(!d) return false;
  try{
    const u=await userRef(d.username).get();
    if(!u.exists||u.data().acct!==id){ delete dv.list[id]; if(dv.last===id) dv.last=null; devPut(dv); return false; }
    await setSignedIn({id,username:d.username,name:u.data().name||d.name||d.username},unb64(d.dek),false);
    return true;
  }catch(e){ return false; }
}
async function restore(){
  // retire the old one-per-Claude-account sign-in: it opened one person's profile for everyone on that Claude account
  try{ const s=await mine('ilsession').get(); if(s.exists) await mine('ilsession').delete(); }catch(e){}
  const dv=devGet();
  return dv.last?openRemembered(dv.last):false;
}

/* ---------- account actions ---------- */
async function signIn(username,password,remember){
  const u=normUser(username), snap=await userRef(u).get();
  if(!snap.exists) throw new Error('Wrong username or password');
  const d=snap.data();
  let raw; try{ raw=await unseal(await kek(password,unb64(d.salt),d.iter||ITER),d.wrap); }catch(e){ throw new Error('Wrong username or password'); }
  await setSignedIn({id:d.acct,username:u,name:d.name||u},raw,remember);
}
async function signUp(username,name,password,seedState,remember){
  const u=normUser(username);
  if(!USER_RE.test(u)) throw new Error('Username: 3–20 letters, numbers, dots or underscores');
  if((await userRef(u).get()).exists) throw new Error('That username is taken');
  const raw=rnd(32), salt=rnd(16), rsalt=rnd(16), rc=newRecovery(), acct='a'+Date.now().toString(36)+b64(rnd(6)).replace(/[^a-zA-Z0-9]/g,'').slice(0,6).toLowerCase();
  const wrap=await seal(await kek(password,salt,ITER),raw), rwrap=await seal(await kek(normRecovery(rc),rsalt,ITER),raw);
  const nm=String(name||'').trim().slice(0,30)||u;
  await userRef(u).set({acct,name:nm,salt:b64(salt),iter:ITER,wrap,rsalt:b64(rsalt),rwrap,created:Date.now()});
  await acctRef(acct).set({name:nm,username:u,created:Date.now()});
  await setSignedIn({id:acct,username:u,name:nm},raw,remember);
  if(seedState) await writeState(seedState);
  return rc;
}
async function recover(username,code,newPassword,remember){
  const u=normUser(username), snap=await userRef(u).get();
  if(!snap.exists) throw new Error('Wrong username or recovery code');
  const d=snap.data(); let raw;
  try{ raw=await unseal(await kek(normRecovery(code),unb64(d.rsalt),d.iter||ITER),d.rwrap); }catch(e){ throw new Error('Wrong username or recovery code'); }
  const salt=rnd(16); await userRef(u).update({salt:b64(salt),iter:ITER,wrap:await seal(await kek(newPassword,salt,ITER),raw)});
  await setSignedIn({id:d.acct,username:u,name:d.name||u},raw,remember);
}
async function changePassword(oldPw,newPw){
  const snap=await userRef(A.acct.username).get(); const d=snap.data();
  try{ await unseal(await kek(oldPw,unb64(d.salt),d.iter||ITER),d.wrap); }catch(e){ throw new Error('Current password is wrong'); }
  const salt=rnd(16); await userRef(A.acct.username).update({salt:b64(salt),iter:ITER,wrap:await seal(await kek(newPw,salt,ITER),A.dekRaw)});
}
async function signOut(){
  try{ if(typeof persist==='function'&&typeof bootLoaded!=='undefined'&&bootLoaded) await persist(); }catch(e){}
  await flushBackup(); await chain.catch(()=>{});
  const dv=devGet(); if(A.acct) delete dv.list[A.acct.id]; dv.last=null; devPut(dv);
  location.reload();
}
/* back to the profile list, keeping this profile remembered on the device */
async function switchProfile(){
  try{ if(typeof persist==='function'&&typeof bootLoaded!=='undefined'&&bootLoaded) await persist(); }catch(e){}
  await flushBackup(); await chain.catch(()=>{});
  const dv=devGet(); dv.last=null; devPut(dv);
  location.reload();
}
/* history already in this Claude account from before Iron Log accounts (offered at sign-up) */
async function claudeCopy(){
  try{
    const m=await mine('state').get(); if(!m.exists) return null;
    const n=+(m.data().chunks)||0; let out='';
    for(let i=0;i<n;i++){ const c=await mine('state-'+i).get(); if(!c.exists) return null; out+=String(c.data().s||''); }
    const p=JSON.parse(out); return p&&Array.isArray(p.logs)?{raw:out,n:p.logs.length}:null;
  }catch(e){ return null; }
}

/* ---------- sign-in screen ---------- */
let gate=null, resolveGate=null;
function showGate(mode,msg){
  if(!gate){ gate=document.createElement('div'); gate.className='ilauth'; document.body.appendChild(gate); document.body.classList.add('auth-on'); }
  const pwField=(id,label,ac)=>`<label class="ilf"><span>${label}</span><input id="${id}" type="password" autocomplete="${ac}" minlength="8"></label>`;
  const head=`<div class="ila-brand">Iron<i>/</i>Log</div>`;
  if(mode==='recovery'){
    gate.innerHTML=`<div class="ila-card">${head}<h1>Save your recovery code</h1>
      <p class="ila-sub">Your workouts are encrypted with your password. If you forget it, this code is the <b>only</b> way back in — nobody can reset it for you.</p>
      <div class="ila-code mono" id="ilRc">${esc(msg)}</div>
      <button class="ila-btn ghost" id="ilCopy">Copy code</button>
      <label class="ila-chk"><input type="checkbox" id="ilSaved"> I’ve saved it somewhere safe</label>
      <button class="ila-btn" id="ilGo" disabled>Continue to Iron Log</button></div>`;
    gate.querySelector('#ilCopy').onclick=async()=>{ try{ await navigator.clipboard.writeText(msg); gate.querySelector('#ilCopy').textContent='Copied ✓'; }catch(e){ gate.querySelector('#ilCopy').textContent='Select the code and copy it'; } };
    gate.querySelector('#ilSaved').onchange=e=>{ gate.querySelector('#ilGo').disabled=!e.target.checked; };
    gate.querySelector('#ilGo').onclick=closeGate;
    return;
  }
  const tabs=`<div class="ila-tabs"><button data-m="in" class="${mode==='in'?'on':''}">Sign in</button><button data-m="up" class="${mode==='up'?'on':''}">Create account</button></div>`;
  let body='';
  const saved=Object.entries(devGet().list);
  const picker=mode==='in'&&saved.length?`<div class="ila-sub" style="margin:4px 0 6px">Profiles on this device</div>`+saved.map(([id,p])=>
    `<button class="ila-btn ghost" data-pid="${esc(id)}" style="margin-bottom:6px">${esc(p.name||p.username)} <small style="opacity:.6">@${esc(p.username)}</small></button>`).join('')+
    `<div class="ila-sub" style="margin:10px 0 4px">Or sign in to another account</div>`:'';
  if(mode==='in') body=picker+`<label class="ilf"><span>Username</span><input id="ilU" autocomplete="username" autocapitalize="none" spellcheck="false"></label>${pwField('ilP','Password','current-password')}
    <label class="ila-chk"><input type="checkbox" id="ilRem" checked> Stay signed in on this device</label>
    <button class="ila-btn" id="ilGo">Sign in</button><button class="ila-link" id="ilForgot">Forgot password?</button>`;
  if(mode==='up') body=`<label class="ilf"><span>Username</span><input id="ilU" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="e.g. saumil"></label>
    <label class="ilf"><span>Your name</span><input id="ilN" autocomplete="name" placeholder="shown to your Crew"></label>
    ${pwField('ilP','Password (8+ characters)','new-password')}${pwField('ilP2','Confirm password','new-password')}
    <div id="ilImp"></div>
    <label class="ila-chk"><input type="checkbox" id="ilRem" checked> Stay signed in on this device</label>
    <button class="ila-btn" id="ilGo">Create account</button>`;
  if(mode==='forgot') body=`<p class="ila-sub">Enter the recovery code you saved when you created your account, then choose a new password.</p>
    <label class="ilf"><span>Username</span><input id="ilU" autocapitalize="none" spellcheck="false"></label>
    <label class="ilf"><span>Recovery code</span><input id="ilRc2" class="mono" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX"></label>
    ${pwField('ilP','New password (8+ characters)','new-password')}
    <button class="ila-btn" id="ilGo">Reset password</button><button class="ila-link" id="ilBack">Back to sign in</button>`;
  gate.innerHTML=`<div class="ila-card">${head}<h1>${mode==='up'?'Create your Iron Log account':mode==='forgot'?'Reset your password':'Welcome back'}</h1>
    ${mode==='forgot'?'':`<p class="ila-sub">Your workouts, records and streaks belong to your Iron Log account and are encrypted with your password.</p>${tabs}`}
    <div class="ila-err" id="ilErr">${msg?esc(msg):''}</div>${body}</div>`;
  gate.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>showGate(b.dataset.m));
  gate.querySelectorAll('[data-pid]').forEach(b=>b.onclick=async()=>{ b.disabled=true;
    if(await openRemembered(b.dataset.pid)) closeGate(); else showGate('in','That profile needs you to sign in again'); });
  const fb=gate.querySelector('#ilForgot'); if(fb) fb.onclick=()=>showGate('forgot');
  const bb=gate.querySelector('#ilBack'); if(bb) bb.onclick=()=>showGate('in');
  if(mode==='up') claudeCopy().then(c=>{ const el=gate&&gate.querySelector('#ilImp'); if(c&&c.n&&el){ gate._seed=c;
    el.innerHTML=`<label class="ila-chk imp"><input type="checkbox" id="ilSeed"> Import ${c.n} older workout${c.n===1?'':'s'} saved in this Claude account. They may belong to someone else who uses this Claude account, so tick only if they’re yours.</label>`; } });
  const go=gate.querySelector('#ilGo'), err=gate.querySelector('#ilErr');
  const val=id=>{ const x=gate.querySelector('#'+id); return x?x.value:''; };
  gate.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',e=>{ if(e.key==='Enter') go.click(); }));
  go.onclick=async()=>{
    err.textContent=''; const rem=!!(gate.querySelector('#ilRem')||{checked:true}).checked;
    try{
      if(mode!=='in'&&val('ilP').length<8) throw new Error('Password needs at least 8 characters');
      if(mode==='up'&&val('ilP')!==val('ilP2')) throw new Error('Passwords don’t match');
      go.disabled=true; go.innerHTML='<span class="spin"></span>';
      if(mode==='in'){ await signIn(val('ilU'),val('ilP'),rem); closeGate(); }
      else if(mode==='forgot'){ await recover(val('ilU'),val('ilRc2'),val('ilP'),rem); closeGate(); }
      else { const seed=gate._seed&&gate.querySelector('#ilSeed')&&gate.querySelector('#ilSeed').checked?gate._seed.raw:null;
        const rc=await signUp(val('ilU'),val('ilN'),val('ilP'),seed,rem); showGate('recovery',rc); }
    }catch(e){ err.textContent=e.message||'Something went wrong — try again'; go.disabled=false; go.textContent=mode==='in'?'Sign in':mode==='up'?'Create account':'Reset password'; }
  };
  const first=gate.querySelector('input'); if(first) setTimeout(()=>{ try{ first.focus({preventScroll:true}); }catch(e){} },60);
}
function closeGate(){ if(gate){ gate.remove(); gate=null; } document.body.classList.remove('auth-on'); const r=resolveGate; resolveGate=null; if(r) r(true); }

/* resolves once someone is signed in to an Iron Log account (remembered or new) */
async function ensure(){
  if(A.acct) return true;
  if(!(await init())) return false;
  if(await restore()) return true;
  return new Promise(res=>{ resolveGate=res; showGate('in'); });
}

/* ---------- account card (You tab) ---------- */
function renderCard(){
  const el=document.getElementById('acctCard'); if(!el||!A.acct) return;
  el.innerHTML=`<div class="acct">
    <div class="acct-av">${esc((A.acct.name||A.acct.username)[0].toUpperCase())}</div>
    <div class="acct-t"><b>${esc(A.acct.name)}</b><small>@${esc(A.acct.username)} · Iron Log account · encrypted</small></div></div>
    <div class="dbtns" style="margin-top:10px"><button class="dbtn" id="acSw">Switch profile</button><button class="dbtn" id="acPw">Change password</button><button class="dbtn" id="acOut">Sign out</button></div>`;
  el.querySelector('#acSw').onclick=()=>switchProfile();
  el.querySelector('#acOut').onclick=async()=>{ if(typeof ask==='function'&&!(await ask('Sign out of '+A.acct.username+' on this device? Your workouts stay in your Iron Log account.','Sign out'))) return; signOut(); };
  el.querySelector('#acPw').onclick=()=>{
    const s=document.getElementById('woSheet'), sc=document.getElementById('woScrim'); if(!s||!sc) return;
    s.innerHTML=`<div class="grab"></div><div class="rv-head"><div class="ttl">Change password</div></div>
      <div class="pfield" style="margin:10px 0"><label>Current password</label><input id="cpO" type="password" autocomplete="current-password"></div>
      <div class="pfield" style="margin:10px 0"><label>New password (8+ characters)</label><input id="cpN" type="password" autocomplete="new-password"></div>
      <div class="ila-err" id="cpE"></div>
      <button class="crew-btn" id="cpGo">Change password</button><button class="rv-close" id="cpX" style="margin-top:8px">Cancel</button>`;
    sc.classList.add('show');
    s.querySelector('#cpX').onclick=()=>sc.classList.remove('show');
    s.querySelector('#cpGo').onclick=async()=>{ const e=s.querySelector('#cpE'); e.textContent='';
      const n=s.querySelector('#cpN').value; if(n.length<8){ e.textContent='New password needs at least 8 characters'; return; }
      try{ await changePassword(s.querySelector('#cpO').value,n); sc.classList.remove('show'); if(typeof toast==='function') toast('Password changed'); }
      catch(x){ e.textContent=x.message; } };
  };
}

window.IronAuth={ensure,init,readState,writeState,flushBackup,signOut,switchProfile,renderCard,get acct(){ return A.acct; },
  _test:{normRecovery,USER_RE}};
})();
