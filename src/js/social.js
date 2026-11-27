/* js/social.js */
/* ================= Crew: friends, shared workouts, shared streak calendar =================
   Talks to the /api/* Netlify Function. Accounts are app-only (username + password).
   Uses app.js globals: state, computeStats, WEEK_TARGET, PROGRAM, ALLEX, historyTopSets,
   sessionVolumeSafe, weekStartTs, todayStr, ymd, parseYMD, addDays, MON, DAY_ABBR, toast, $, showView.
   Session token lives under its own key so app backups never carry it. */
(function(){
const SKEY='ironlog-social';
const AVATARS=['🏋️','💪','🔥','🦍','🐻','🦁','🐺','🦅','⚡','🚀','🥇','🧠','🐉','🌟','🏃','🧘'];
const COLORS=['#2E9BD6','#D97E45','#5FB56E','#9B6BD9','#D9487A','#C9A227','#3FA7A0'];
const FEEL_IC={easy:'😴',right:'💪',hard:'🥵',brutal:'🆘'};
const BUDDY_MIN=2;            // both log >= this many sessions in a week to keep a buddy streak alive

let S={token:'',me:null,autoShare:true,shared:{},pendingAdd:''};
let crew=null;                // last /crew response
let feed=null;                // last /feed response
let tab='feed';
let board='sessions';
let calMonth='';              // YYYY-MM
let calHidden={};             // username -> true when toggled off
let authMode='signup';
let busy=false;

const skey=()=>HOSTED?SKEY+':'+((window.IronAuth&&IronAuth.acct&&IronAuth.acct.id)||'nouser'):SKEY;
function loadS(){ try{ const r=localStorage.getItem(skey()); if(r) S={...S,...JSON.parse(r)}; }catch(e){} if(!S.shared||typeof S.shared!=='object') S.shared={}; }
function saveS(){ try{ localStorage.setItem(skey(),JSON.stringify(S)); }catch(e){} }
const signedIn=()=>!!(S.token&&S.me);

const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function ago(ts){
  const s=Math.max(0,(Date.now()-ts)/1000);
  if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago'; if(s<86400*7) return Math.floor(s/86400)+'d ago';
  const d=new Date(ts); return d.getDate()+' '+MON[d.getMonth()];
}
const kfmt=v=>v>=10000?Math.round(v/1000)+'k':v>=1000?(v/1000).toFixed(1)+'k':String(Math.round(v));

async function api(method,path,body){
  if(HOSTED) return CrewLocal.call(method,path,body);   // standalone: crew lives in private groups in the account database (js/crew-artifact.js)
  let r;
  try{
    r=await fetch('/api'+path,{method,headers:{'content-type':'application/json',...(S.token?{authorization:'Bearer '+S.token}:{})},body:body?JSON.stringify(body):undefined});
  }catch(e){ throw new Error(navigator.onLine===false?'You’re offline — Crew needs a connection':'Can’t reach the Crew server'); }
  let d={}; try{ d=await r.json(); }catch(e){}
  if(r.status===401&&S.token&&path!=='/login'&&path!=='/account/delete'){ signOutLocal(); render(); }
  if(!r.ok) throw new Error(d.error||('Crew server error '+r.status));
  return d;
}
function signOutLocal(){ S.token=''; S.me=null; crew=null; feed=null; saveS(); badge(); }

/* ---------- what we share: summary + calendar, built from local logs ---------- */
function buildActivity(){
  const by={};
  state.logs.forEach(l=>{
    const a=by[l.date]||(by[l.date]={d:l.date,t:'',v:0,s:0,m:false});
    a.t=a.t?a.t+' + '+entryName(l):entryName(l);
    a.v+=sessionVolumeSafe(l.ex);
    a.s+=Object.values(l.ex).reduce((n,x)=>n+x.length,0);
  });
  Object.keys(state.mobility||{}).forEach(d=>{ (by[d]||(by[d]={d,t:'',v:0,s:0,m:false})).m=true; });
  return Object.values(by).sort((a,b)=>a.d<b.d?-1:1).slice(-400);
}
function buildSummary(){
  const s=computeStats();
  const wk=ymd(new Date(weekStartTs(todayStr())));
  const weekVolume=state.logs.filter(l=>weekStartTs(l.date)===weekStartTs(todayStr())).reduce((a,l)=>a+sessionVolumeSafe(l.ex),0);
  const prs=Object.keys(ALLEX).map(id=>{const h=historyTopSets(id);return{name:currentOpt(id).name,top:h.length?Math.max(...h.map(p=>p.top)):0};})
    .filter(p=>p.top>0).sort((a,b)=>b.top-a.top).slice(0,5);
  const last=state.logs.reduce((a,l)=>l.date>a?l.date:a,'');
  return {level:s.li.level,title:s.li.title,xp:s.xp,sessions:s.sessions,volumeTotal:s.volumeTotal,weekKey:wk,thisWeek:s.thisWeek,
    weekVolume,weekTarget:WEEK_TARGET,weekStreak:s.weekStreakCur,weekStreakMax:s.weekStreakMax,lastWorkout:last,prs};
}
let syncTimer=null;
function sync(){
  if(!signedIn()) return;
  clearTimeout(syncTimer);
  syncTimer=setTimeout(()=>{ api('POST','/sync',{summary:buildSummary(),activity:buildActivity()}).catch(e=>console.warn('crew sync',e.message)); },400);
}

function buildPost(entry){
  const day=PROGRAM.days.find(d=>d.id===entry.dayId);
  const order=(entry.order&&entry.order.length?entry.order:day?[...day.main,...day.core].map(e=>e.id):Object.keys(entry.ex)).filter(id=>entry.ex[id]);
  const prs=window.Workout?Workout.prsInEntry(entry):{};
  const exercises=order.map(id=>({
    name:exName(id,entry),
    sets:entry.ex[id].map(s=>Workout.fmtSet(id,s,true)),
    pr:!!(prs[id]&&prs[id].length),
  }));
  return {unit:unit(),title:entryName(entry),note:entry.shareNote||'',feel:entry.feel||'',volume:sessionVolumeSafe(entry.ex),
    sets:Object.values(entry.ex).reduce((n,x)=>n+x.length,0),week:entry.week||1,exercises};
}
async function sharePost(entry,quiet){
  if(!signedIn()||!entry||!entry.id) return false;
  try{
    await api('PUT','/posts/'+encodeURIComponent(entry.id),buildPost(entry));
    S.shared[entry.id]=true; saveS(); feed=null;
    if(!quiet) toast('Shared with your crew 📣');
    return true;
  }catch(e){ if(!quiet) toast(e.message); return false; }
}

/* ---------- hooks called from app.js ---------- */
function afterSave(entry){
  sync();
  if(!signedIn()) return;
  if(S.shared[entry.id]) sharePost(entry,true);           // keep an already-shared workout current
  else if(S.autoShare) sharePost(entry,true).then(ok=>{ if(ok) renderShare(entry); });
}
let reviewEntry=null;
function renderShare(entry){
  reviewEntry=entry;
  const el=$('#rvShare'); if(!el) return;
  if(!signedIn()){
    el.innerHTML=`<button class="crew-link" id="rvCrewJoin">👥 Train with friends — set up Crew</button>`;
    $('#rvCrewJoin').onclick=()=>{ $('#scrim').classList.remove('show'); showView('crew'); };
    return;
  }
  const done=!!S.shared[entry.id];
  el.innerHTML=`<div class="achead">Share with your crew</div>
    <textarea class="crew-in crew-note" id="rvNote" maxlength="280" placeholder="Say something to your crew… (optional)">${esc(entry.shareNote||'')}</textarea>
    <button class="crew-btn${done?' ghost':''}" id="rvShareBtn">${done?'✓ Shared · update post':'📣 Share with crew'}</button>`;
  $('#rvShareBtn').onclick=async()=>{
    entry.shareNote=$('#rvNote').value.trim().slice(0,280);
    await persist();
    if(await sharePost(entry)) renderShare(entry);
  };
}
async function removePost(id){
  if(!signedIn()||!S.shared[id]) return;
  try{ await api('DELETE','/posts/'+encodeURIComponent(id)); }catch(e){ console.warn('crew delete',e.message); }
  delete S.shared[id]; saveS(); feed=null;
}
async function afterEdit(oldId,entry){
  sync();
  if(!signedIn()||!S.shared[oldId]) return;
  if(oldId!==entry.id){ await removePost(oldId); await sharePost(entry,true); }
  else sharePost(entry,true);
}
function afterDelete(id){ sync(); removePost(id); }
function onReviewClose(){
  const e=reviewEntry; reviewEntry=null;
  if(!e||!signedIn()) return;
  const n=$('#rvNote'); if(n){ const v=n.value.trim().slice(0,280); if(v!==(e.shareNote||'')){ e.shareNote=v; persist(); } }
  if(S.shared[e.id]) sharePost(e,true);                    // picks up the feel rating / note
}

/* ---------- data loading ---------- */
async function loadCrew(){ crew=await api('GET','/crew'); if(crew.me){ S.me=crew.me; saveS(); } badge(); return crew; }
async function loadFeed(){ feed=await api('GET','/feed'); return feed; }
function badge(){
  const b=$('#crewBadge'); if(!b) return;
  const n=crew?(crew.inbox||[]).length+(crew.incoming||[]).length:0;
  b.textContent=n>9?'9+':n?String(n):''; b.classList.toggle('on',n>0);
}

/* ---------- streak / calendar math (uses activity rows: {d,t,v,s,m}) ---------- */
const trained=a=>(a||[]).filter(x=>x.s>0||x.t);
function weekCounts(act){ const m={}; trained(act).forEach(x=>{const w=weekStartTs(x.d); m[w]=(m[w]||0)+1;}); return m; }
function buddyStreak(actA,actB){
  const a=weekCounts(actA), b=weekCounts(actB);
  const ok=w=>(a[w]||0)>=BUDDY_MIN&&(b[w]||0)>=BUDDY_MIN;
  let w=weekStartTs(todayStr()), n=0;
  if(!ok(w)) w-=7*864e5;                                   // the current week can still be won
  while(ok(w)){ n++; w-=7*864e5; }
  return n;
}
function sameDays(actA,actB){ const s=new Set(trained(actA).map(x=>x.d)); return trained(actB).filter(x=>s.has(x.d)).length; }
function weekStats(act){
  const w=weekStartTs(todayStr()); const rows=trained(act).filter(x=>weekStartTs(x.d)===w);
  return {sessions:rows.length,volume:rows.reduce((n,x)=>n+x.v,0)};
}
function people(){
  const meRow={...S.me,isMe:true,activity:buildActivity(),summary:buildSummary(),color:COLORS[0]};
  const fr=(crew&&crew.friends||[]).map((f,i)=>({...f,color:COLORS[(i%(COLORS.length-1))+1]}));
  return [meRow,...fr];
}

/* ================= rendering ================= */
let hostedState='';           // artifact mode: 'out' | 'new' | 'in'
function render(){
  const el=$('#crewBody'); if(!el) return;
  if(HOSTED&&hostedState!=='in'){
    if(!hostedState){ el.innerHTML='<div class="empty" style="text-align:center;padding:24px 0"><span class="spin"></span></div>'; hostedBoot(); return; }
    if(hostedState==='out'){ el.innerHTML=`<div class="crew-card crew-empty">👥<br><b>Crew isn’t available here</b><br>Crew needs an online Iron Log account. This copy of Iron Log keeps everything on this device only.</div>`; return; }
    renderJoin(el); return;
  }
  if(!signedIn()){ renderAuth(el); return; }
  renderMain(el);
  if(!busy){
    busy=true;
    Promise.all([loadCrew(), tab==='feed'?loadFeed():null])
      .then(()=>{ busy=false; if(activeView==='crew') renderMain(el); maybeAddPending(); })
      .catch(e=>{ busy=false; if(!signedIn()) return; const er=$('#crewErr'); if(er) er.innerHTML=`<div class="warn">${esc(e.message)}</div>`; });
  }
}

/* join or start a crew; the signed-in Iron Log account is who you are */
function renderJoin(el){
  const inv=CrewLocal.invitedTo();
  el.innerHTML=`${inv?`<div class="crew-card crew-invite">🎟 You’ve been invited to a crew.${inv==='switch'?' Joining it leaves your current crew.':''}</div>`:''}<div class="crew-card crew-hero">
      <div class="crew-hero-ic">👥</div>
      <div class="crew-hero-t">Train with your friends</div>
      <div class="vsub" style="margin:4px 0 0">Your crew is a private group of friends you invite with a link. Share workouts, cheer each other on and keep a buddy streak alive. Your training log stays private — the crew sees your stats summary, your workout calendar and the workouts you choose to post.</div>
    </div>
    <div class="crew-card">
      <div class="pfield" style="margin-bottom:8px"><label>Crew nickname (optional)</label><input id="jnN" maxlength="30" placeholder="Leave empty to use your Iron Log name"></div>
      <div class="pfield"><label>Avatar</label><div class="avpick" id="jnA">${AVATARS.map((a,i)=>`<button data-av="${a}" class="${i===0?'on':''}">${a}</button>`).join('')}</div></div>
      <button class="crew-btn" id="jnGo" style="margin-top:12px">${inv?'Join this crew':'Start my crew'}</button>
      <div id="jnErr"></div>
    </div>
    <div class="gnote">${inv?'Only members can see a crew.':'Once your crew exists, tap <b>＋ invite</b> to send friends its private link.'}</div>`;
  el.querySelectorAll('#jnA [data-av]').forEach(b=>b.onclick=()=>{ el.querySelectorAll('#jnA button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); });
  $('#jnGo').onclick=async()=>{
    const btn=$('#jnGo'); btn.disabled=true;
    try{
      const av=el.querySelector('#jnA .on');
      const d=await api('POST','/join',{nick:$('#jnN').value.trim(),avatar:av?av.dataset.av:AVATARS[0]});
      S.token='artifact'; S.me=d.me; hostedState='in'; saveS();
      toast(CrewLocal.invitedTo()?'You joined the crew':'You’re in — invite friends with ＋ invite'); sync(); render();
    }catch(e){ $('#jnErr').innerHTML=`<div class="warn" style="margin-top:10px">${esc(e.message)}</div>`; btn.disabled=false; }
  };
}
let hostedBooting=null;
function hostedBoot(){
  return hostedBooting||(hostedBooting=(async()=>{
    hostedState=await CrewLocal.status();
    if(hostedState==='in'){ const d=await api('GET','/me'); S.token='artifact'; S.me=d.me; saveS(); sync(); }
    else { S.token=''; S.me=null; }
    if(activeView==='crew') render();
    if(hostedState==='in') loadCrew().catch(()=>{});
  })().catch(()=>{ hostedState='out'; if(activeView==='crew') render(); }));
}
function renderAuth(el){
  const invite=S.pendingAdd?`<div class="crew-card crew-invite">🎟 You’ve been invited to a crew. Create an account (or log in) and you’ll be connected.</div>`:'';
  el.innerHTML=`${invite}
    <div class="crew-card crew-hero">
      <div class="crew-hero-ic">👥</div>
      <div class="crew-hero-t">Train with your friends</div>
      <div class="vsub" style="margin:4px 0 0">Share workouts, cheer each other on, and keep a buddy streak alive on a shared calendar. No email or social accounts — just a username and password for Iron Log.</div>
    </div>
    <div class="seg" id="authSeg"><button data-m="signup" class="${authMode==='signup'?'on':''}">Create account</button><button data-m="login" class="${authMode==='login'?'on':''}">Log in</button></div>
    <div class="crew-card">
      <div class="pfield" style="margin-bottom:8px"><label>Username</label><input id="auU" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="e.g. iron_sam" maxlength="20"></div>
      <div class="pfield" style="margin-bottom:8px"><label>Password</label><input id="auP" type="password" autocomplete="${authMode==='signup'?'new-password':'current-password'}" placeholder="at least 6 characters"></div>
      ${authMode==='signup'?`
      <div class="pfield" style="margin-bottom:8px"><label>Display name</label><input id="auN" maxlength="30" placeholder="what friends see"></div>
      <div class="pfield"><label>Avatar</label><div class="avpick" id="auA">${AVATARS.map((a,i)=>`<button data-av="${a}" class="${i===0?'on':''}">${a}</button>`).join('')}</div></div>`:''}
      <button class="crew-btn" id="auGo" style="margin-top:12px">${authMode==='signup'?'Create account':'Log in'}</button>
      <div id="auErr"></div>
    </div>
    <div class="gnote">Your training log stays on this device. Crew only shares your stats summary, your workout calendar, and the workouts you choose to post — with friends you accept.</div>`;
  el.querySelectorAll('#authSeg [data-m]').forEach(b=>b.onclick=()=>{ authMode=b.dataset.m; renderAuth(el); });
  el.querySelectorAll('#auA [data-av]').forEach(b=>b.onclick=()=>{ el.querySelectorAll('#auA button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); });
  $('#auGo').onclick=async()=>{
    const btn=$('#auGo'); btn.disabled=true;
    const body={username:$('#auU').value.trim(),password:$('#auP').value};
    if(authMode==='signup'){ body.name=$('#auN').value.trim(); const av=el.querySelector('#auA .on'); body.avatar=av?av.dataset.av:AVATARS[0]; }
    try{
      const d=await api('POST',authMode==='signup'?'/signup':'/login',body);
      S.token=d.token; S.me=d.me; saveS();
      toast(authMode==='signup'?'Welcome to Crew, '+d.me.name+'!':'Signed in');
      sync(); render();
    }catch(e){ $('#auErr').innerHTML=`<div class="warn" style="margin-top:10px">${esc(e.message)}</div>`; btn.disabled=false; }
  };
}

function renderMain(el){
  const me=S.me;
  const inbox=(crew&&crew.inbox)||[], incoming=(crew&&crew.incoming)||[];
  el.innerHTML=`
    <div class="crew-card crew-me">
      <span class="av lg">${esc(me.avatar)}</span>
      <div class="crew-me-t"><b>${esc(me.name)}</b><small>${HOSTED?'Crew member':'@'+esc(me.username)}</small></div>
      <button class="crew-code" id="crewInvite" title="Invite friends">${HOSTED?'＋ invite':`code <b>${esc(me.code||'······')}</b> · invite`}</button>
      <button class="hbtn" id="crewGear" aria-label="Crew settings">⚙️</button>
    </div>
    <div id="crewErr"></div>
    ${incoming.length?`<div class="crew-card"><div class="achead" style="margin-bottom:8px">Friend requests</div>${incoming.map(u=>`
      <div class="frow"><span class="av">${esc(u.avatar)}</span><div class="fn"><b>${esc(u.name)}</b><small>@${esc(u.username)} wants to join your crew</small></div>
      <button class="mini go" data-acc="${esc(u.username)}">Accept</button><button class="mini" data-dec="${esc(u.username)}">✕</button></div>`).join('')}</div>`:''}
    ${inbox.length?`<div class="crew-card"><div class="achead" style="display:flex;justify-content:space-between;margin-bottom:6px">Activity<button class="linkbtn" id="inboxClear">clear</button></div>${inbox.slice(0,8).map(inboxRow).join('')}</div>`:''}
    <div class="seg" id="crewSeg">${[['feed','Feed'],['friends','Friends'],['cal','Calendar'],['board','Board']].map(([k,l])=>`<button data-t="${k}" class="${tab===k?'on':''}">${l}</button>`).join('')}</div>
    <div id="crewTab"></div>`;
  $('#crewInvite').onclick=invite;
  $('#crewGear').onclick=openSettings;
  el.querySelectorAll('[data-acc]').forEach(b=>b.onclick=()=>act(()=>api('POST','/friends/accept',{username:b.dataset.acc}),'You’re now training together 🤝'));
  el.querySelectorAll('[data-dec]').forEach(b=>b.onclick=()=>act(()=>api('POST','/friends/remove',{username:b.dataset.dec}),'Request declined'));
  const ic=$('#inboxClear'); if(ic) ic.onclick=()=>act(()=>api('POST','/inbox/clear'));
  el.querySelectorAll('#crewSeg [data-t]').forEach(b=>b.onclick=()=>{ tab=b.dataset.t; render(); });
  const t=$('#crewTab');
  if(tab==='feed') renderFeed(t);
  else if(tab==='friends') renderFriends(t);
  else if(tab==='cal') renderCal(t);
  else renderBoard(t);
}
function inboxRow(i){
  const f=i.from||{}; const who=`<b>${esc(f.name||f.username||'Someone')}</b>`;
  const txt=i.type==='nudge'?`${who} nudged you 👋${i.msg?` “${esc(i.msg)}”`:''}`
    :i.type==='like'?`${who} gave your ${esc(i.title||'workout')} a 💪`
    :i.type==='comment'?`${who} commented on your ${esc(i.title||'workout')}: “${esc(i.text||'')}”`
    :i.type==='accepted'?`${who} joined your crew 🤝`:who;
  return `<div class="irow"><span class="av sm">${esc(f.avatar||'👤')}</span><div class="it">${txt}<small>${ago(i.at)}</small></div></div>`;
}
async function act(fn,msg){
  try{ await fn(); if(msg) toast(msg); await loadCrew(); feed=null; render(); }
  catch(e){ toast(e.message); }
}

/* ---------- feed ---------- */
function renderFeed(t){
  if(!feed){ t.innerHTML='<div class="empty" style="text-align:center;padding:24px 0"><span class="spin"></span></div>'; return; }
  const myDays=new Set(trained(buildActivity()).map(x=>x.d));
  if(!feed.posts.length){
    t.innerHTML=`<div class="crew-card crew-empty">📣<br><b>No shared workouts yet</b><br>Save a session and tap <b>Share with crew</b> on the review screen${(crew&&crew.friends||[]).length?'':', then invite a friend from the Friends tab'}.</div>`;
    return;
  }
  t.innerHTML=feed.posts.map(p=>postCard(p,feed.users[p.username]||{username:p.username,name:p.username,avatar:'👤'},myDays)).join('');
  t.querySelectorAll('[data-like]').forEach(b=>b.onclick=async()=>{
    const [o,id]=b.dataset.like.split('|'); const p=feed.posts.find(x=>x.username===o&&x.id===id); if(!p) return;
    p.likedByMe=!p.likedByMe; p.likes+=p.likedByMe?1:-1; p.likers=p.likedByMe?[S.me.username,...(p.likers||[])]:(p.likers||[]).filter(n=>n!==S.me.username); renderFeed(t);   // optimistic
    try{ await api('POST',`/posts/${encodeURIComponent(o)}/${encodeURIComponent(id)}/like`); }
    catch(e){ p.likedByMe=!p.likedByMe; p.likes+=p.likedByMe?1:-1; renderFeed(t); toast(e.message); }
  });
  t.querySelectorAll('[data-more]').forEach(b=>b.onclick=()=>{ b.parentElement.classList.add('open'); b.remove(); });
  t.querySelectorAll('[data-cform]').forEach(f=>f.onsubmit=async ev=>{
    ev.preventDefault();
    const [o,id]=f.dataset.cform.split('|'); const inp=f.querySelector('input'); const text=inp.value.trim(); if(!text) return;
    inp.disabled=true;
    try{
      const d=await api('POST',`/posts/${encodeURIComponent(o)}/${encodeURIComponent(id)}/comment`,{text});
      const p=feed.posts.find(x=>x.username===o&&x.id===id); if(p) p.comments.push(d.comment);
      renderFeed(t);
    }catch(e){ toast(e.message); inp.disabled=false; }
  });
  t.querySelectorAll('[data-cdel]').forEach(b=>b.onclick=async()=>{
    const [o,id,cid]=b.dataset.cdel.split('|');
    try{ await api('DELETE',`/posts/${encodeURIComponent(o)}/${encodeURIComponent(id)}/comment/${encodeURIComponent(cid)}`);
      const p=feed.posts.find(x=>x.username===o&&x.id===id); if(p) p.comments=p.comments.filter(c=>c.id!==cid); renderFeed(t);
    }catch(e){ toast(e.message); }
  });
  t.querySelectorAll('[data-pdel]').forEach(b=>b.onclick=async()=>{
    if(!await ask('Remove this workout from your crew’s feed? Your log stays on this device.','Remove',true)) return;
    const id=b.dataset.pdel;
    try{ await api('DELETE','/posts/'+encodeURIComponent(id)); delete S.shared[id]; saveS(); feed.posts=feed.posts.filter(p=>!(p.username===S.me.username&&p.id===id)); renderFeed(t); }
    catch(e){ toast(e.message); }
  });
}
function postCard(p,u,myDays){
  const mine=p.username===S.me.username;
  const k=esc(p.username)+'|'+esc(p.id);
  const together=!mine&&myDays.has(p.date);
  const shown=p.exercises.slice(0,4), rest=p.exercises.slice(4);
  const exRow=e=>`<div class="pex"><span class="pexn">${esc(e.name)}${e.pr?' <span class="prtag">🏅 PR</span>':''}</span><span class="pexs mono">${e.sets.map(esc).join('  ')}</span></div>`;
  return `<div class="post">
    <div class="post-h"><span class="av">${esc(u.avatar)}</span>
      <div class="pn"><b>${esc(u.name)}</b><small>${prettyDate(p.date)} · wk ${p.week||1} · ${ago(p.createdAt||Date.now())}</small></div>
      ${mine?`<button class="linkbtn" data-pdel="${esc(p.id)}" aria-label="Remove post">remove</button>`:''}
    </div>
    <div class="post-t">${esc(p.title)} ${p.feel?`<span title="${esc(p.feel)}">${FEEL_IC[p.feel]||''}</span>`:''}
      ${p.prCount?`<span class="prchip">🏅 ${p.prCount} PR${p.prCount>1?'s':''}</span>`:''}
      ${together?'<span class="tgchip">🤝 same day as you</span>':''}</div>
    ${p.note?`<div class="post-note">${esc(p.note)}</div>`:''}
    <div class="post-stats"><span><b>${p.exercises.length}</b> exercise${p.exercises.length===1?'':'s'}</span><span><b>${p.sets}</b> set${p.sets===1?'':'s'}</span><span><b>${kfmt(VOL(p.volume))}</b> ${unit()}</span></div>
    <div class="post-ex">${(p.unit||'lb')!==unit()?`<div class="legend" style="text-align:left;margin:2px 0">weights in ${p.unit||'lb'}</div>`:''}${shown.map(exRow).join('')}${rest.length?`<div class="post-rest">${rest.map(exRow).join('')}</div><button class="linkbtn" data-more>+${rest.length} more</button>`:''}</div>
    <div class="post-a">
      <button class="likebtn${p.likedByMe?' on':''}" data-like="${k}">💪 ${p.likes||''}</button>
      <span class="likers">${p.likes?esc((p.likers||[]).slice(0,3).map(n=>n===S.me.username?'you':((feed.users[n]||{}).name||n)).join(', '))+(p.likes>3?' +'+(p.likes-3):''):''}</span>
    </div>
    <div class="cmts">${(p.comments||[]).map(c=>`<div class="cmt"><span class="av sm">${esc(c.avatar)}</span><div class="ct"><b>${esc(c.name)}</b> ${esc(c.text)}<small>${ago(c.at)}</small></div>${(c.username===S.me.username||(mine&&!HOSTED))?`<button class="linkbtn" data-cdel="${k}|${esc(c.id)}">✕</button>`:''}</div>`).join('')}
      <form class="cform" data-cform="${k}"><input class="crew-in" maxlength="280" placeholder="Cheer them on…"><button class="mini go">Send</button></form>
    </div>
  </div>`;
}

/* ---------- friends ---------- */
function renderFriends(t){
  const fr=(crew&&crew.friends)||[], out=(crew&&crew.outgoing)||[];
  const mine=buildActivity();
  t.innerHTML=`
    ${HOSTED?`<button class="crew-card crew-invite-card" id="addInvite">＋ Invite friends — send them your crew link</button>`:`<form class="crew-card addrow" id="addForm"><input class="crew-in" id="addIn" autocapitalize="none" spellcheck="false" placeholder="Friend’s username or 6-letter code"><button class="mini go">Add</button></form>`}
    ${out.length?`<div class="legend" style="text-align:left;margin:-4px 2px 10px">Waiting on: ${out.map(u=>`${esc(u.name)} <button class="linkbtn" data-cancel="${esc(u.username)}">cancel</button>`).join(' · ')}</div>`:''}
    ${fr.length?fr.map(f=>{
      const w=weekStats(f.activity), bs=buddyStreak(mine,f.activity);
      const last=trained(f.activity).slice(-1)[0];
      return `<div class="frow card" data-open="${esc(f.username)}">
        <span class="av">${esc(f.avatar)}</span>
        <div class="fn"><b>${esc(f.name)}</b><small>${f.summary?`LV ${f.summary.level} · `:''}${last?'last trained '+(last.d===todayStr()?'today':prettyDate(last.d)):'no workouts yet'}</small></div>
        <span class="gpill${w.sessions>=WEEK_TARGET?' done':''}">${w.sessions}/${WEEK_TARGET}</span>
        ${bs?`<span class="gpill flame" title="buddy streak">🤝 ${bs}</span>`:''}
      </div>`;}).join('')
    :HOSTED?`<div class="crew-card crew-empty">🤝<br><b>Your crew is empty</b><br>Tap ＋ invite and send friends your crew’s private link. They show up here once they join.</div>`
    :`<div class="crew-card crew-empty">🤝<br><b>Your crew is empty</b><br>Share your code <b>${esc(S.me.code||'')}</b> or tap invite at the top. Friends who add you show up here after you accept.</div>`}`;
  const ai=$('#addInvite'); if(ai) ai.onclick=invite;
  const af=$('#addForm'); if(af) af.onsubmit=async ev=>{
    ev.preventDefault(); const v=$('#addIn').value.trim(); if(!v) return;
    try{ const d=await api('POST','/friends/request',{target:v}); toast(d.status==='friends'?'You’re now training together 🤝':'Request sent to @'+d.username); $('#addIn').value=''; await loadCrew(); render(); }
    catch(e){ toast(e.message); }
  };
  t.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>act(()=>api('POST','/friends/remove',{username:b.dataset.cancel}),'Request cancelled'));
  t.querySelectorAll('[data-open]').forEach(r=>r.onclick=()=>openFriend(r.dataset.open));
}
function openFriend(username){
  const f=(crew&&crew.friends||[]).find(x=>x.username===username); if(!f) return;
  const meAct=buildActivity(), ms=buildSummary(), fs=f.summary||{};
  const mw=weekStats(meAct), fw=weekStats(f.activity);
  const row=(k,a,b,fmt)=>{ fmt=fmt||(x=>x); const A=+a||0,B=+b||0;
    return `<div class="vsrow"><span class="${A>B?'win':''}">${fmt(A)}</span><span class="vk">${k}</span><span class="${B>A?'win':''}">${fmt(B)}</span></div>`; };
  const prs=(fs.prs||[]).map(p=>`<div class="prrow"><span class="pn">${esc(p.name)}</span><span class="pv">${WL(p.top)}</span></div>`).join('')||'<div class="legend">No loaded lifts yet.</div>';
  $('#crewSheet').innerHTML=`<div class="grab"></div>
    <div class="vshead"><div><span class="av lg">${esc(S.me.avatar)}</span><b>You</b></div><div class="vsvs">VS</div><div><span class="av lg">${esc(f.avatar)}</span><b>${esc(f.name)}</b></div></div>
    <div class="buddy"><b>🤝 ${buddyStreak(meAct,f.activity)}-week buddy streak</b><small>weeks you both logged ${BUDDY_MIN}+ sessions · ${sameDays(meAct,f.activity)} days you trained on the same day</small></div>
    <div class="vs">
      ${row('This week',mw.sessions,fw.sessions)}
      ${row('Week volume',mw.volume,fw.volume,v=>kfmt(VOL(v)))}
      ${row('Week streak',ms.weekStreak,fs.weekStreak)}
      ${row('Level',ms.level,fs.level)}
      ${row('Sessions',ms.sessions,fs.sessions)}
      ${row('Total '+unit(),ms.volumeTotal,fs.volumeTotal,v=>kfmt(VOL(v)))}
    </div>
    <div class="achead" style="margin-top:14px">Last 5 weeks together</div>
    ${miniCal([{...S.me,activity:meAct,color:COLORS[0]},{...f,activity:f.activity,color:COLORS[1]}])}
    <div class="achead" style="margin-top:14px">${esc(f.name)}’s top lifts</div>${prs}
    <div class="dbtns" style="margin-top:14px"><button class="dbtn" id="fNudge"${HOSTED?' style="grid-column:1/-1"':''}>👋 Nudge</button>${HOSTED?'':'<button class="dbtn" id="fRemove">Remove</button>'}</div>
    <button class="rv-close" id="fClose" style="margin-top:10px">Done</button>`;
  $('#crewScrim').classList.add('show');
  $('#fClose').onclick=closeSheet;
  $('#fNudge').onclick=async()=>{
    const msg=await askText('Nudge '+f.name+' — add a message (optional)','Gym today? 💪'); if(msg===null) return;
    try{ await api('POST','/nudge',{to:f.username,msg}); toast('Nudge sent 👋'); }catch(e){ toast(e.message); }
  };
  if($('#fRemove')) $('#fRemove').onclick=async()=>{
    if(!await ask(`Remove ${f.name} from your crew?`,'Remove',true)) return;
    closeSheet(); act(()=>api('POST','/friends/remove',{username:f.username}),'Removed');
  };
}
function closeSheet(){ $('#crewScrim').classList.remove('show'); }

/* ---------- calendar ---------- */
function cellDots(dt,ps){
  const hit=ps.filter(p=>trained(p.activity).some(x=>x.d===dt));
  return {hit,dots:hit.map(p=>`<i style="background:${p.color}"></i>`).join('')};
}
function miniCal(ps){
  const start=weekStartTs(todayStr())-4*7*864e5; let h='<div class="cal mini">';
  DAY_ABBR.slice(1).concat(DAY_ABBR[0]).forEach(d=>h+=`<div class="cdow">${d}</div>`);
  for(let i=0;i<35;i++){
    const dt=ymd(new Date(start+i*864e5)); const {hit,dots}=cellDots(dt,ps);
    h+=`<div class="ccell${dt===todayStr()?' today':''}${dt>todayStr()?' fut':''}${hit.length>1?' both':''}"><span>${parseYMD(dt).getDate()}</span><div class="cdots">${dots}</div></div>`;
  }
  return h+'</div>';
}
function renderCal(t){
  if(!calMonth) calMonth=todayStr().slice(0,7);
  const all=people(); const ps=all.filter(p=>!calHidden[p.username]);
  const [y,m]=calMonth.split('-').map(Number);
  const first=new Date(y,m-1,1); const lead=(first.getDay()+6)%7; const days=new Date(y,m,0).getDate();
  let grid='<div class="cal">'+DAY_ABBR.slice(1).concat(DAY_ABBR[0]).map(d=>`<div class="cdow">${d}</div>`).join('');
  for(let i=0;i<lead;i++) grid+='<div class="ccell empty"></div>';
  for(let d=1;d<=days;d++){
    const dt=ymd(new Date(y,m-1,d)); const {hit,dots}=cellDots(dt,ps);
    const meIn=hit.some(p=>p.isMe);
    grid+=`<div class="ccell${dt===todayStr()?' today':''}${dt>todayStr()?' fut':''}${meIn&&hit.length>1?' both':''}"><span>${d}</span><div class="cdots">${dots}</div></div>`;
  }
  grid+='</div>';
  const meAct=all[0].activity;
  const streaks=all.slice(1).map(f=>({f,n:buddyStreak(meAct,f.activity),same:sameDays(meAct,f.activity)})).sort((a,b)=>b.n-a.n||b.same-a.same);
  t.innerHTML=`
    <div class="calnav"><button class="mini" id="calPrev">‹</button><b>${MON[m-1]} ${y}</b><button class="mini" id="calNext">›</button></div>
    <div class="chips">${all.map(p=>`<button class="pchip${calHidden[p.username]?' off':''}" data-hide="${esc(p.username)}"><i style="background:${p.color}"></i>${p.isMe?'You':esc(p.name)}</button>`).join('')}</div>
    <div class="crew-card" style="padding:10px">${grid}<div class="legend">dots = who trained · 🤝 highlight = you trained the same day as a friend</div></div>
    <div class="achead" style="margin-top:14px">Buddy streaks</div>
    ${streaks.length?streaks.map(s=>`<div class="frow card" data-open="${esc(s.f.username)}"><span class="av">${esc(s.f.avatar)}</span><div class="fn"><b>${esc(s.f.name)}</b><small>${s.same} same-day sessions</small></div><span class="gpill flame">🤝 ${s.n} wk${s.n===1?'':'s'}</span></div>`).join('')
      :'<div class="legend">Add friends to start a buddy streak — every week you both log '+BUDDY_MIN+'+ sessions keeps it alive.</div>'}`;
  const shift=n=>{ const d=new Date(y,m-1+n,1); calMonth=ymd(d).slice(0,7); renderCal(t); };
  $('#calPrev').onclick=()=>shift(-1); $('#calNext').onclick=()=>shift(1);
  t.querySelectorAll('[data-hide]').forEach(b=>b.onclick=()=>{ const u=b.dataset.hide; calHidden[u]=!calHidden[u]; renderCal(t); });
  t.querySelectorAll('[data-open]').forEach(r=>r.onclick=()=>openFriend(r.dataset.open));
}

/* ---------- leaderboard ---------- */
function renderBoard(t){
  const ps=people().map(p=>{ const w=weekStats(p.activity); const s=p.summary||{};
    return {...p,sessions:w.sessions,volume:w.volume,streak:s.weekStreak||0,xp:s.xp||0,level:s.level||1}; });
  const M={sessions:['Sessions','sessions',v=>v],volume:['Volume','volume',v=>kfmt(VOL(v))+' '+unit()],streak:['Streak','streak',v=>'🔥 '+v],xp:['XP','xp',v=>kfmt(v)+' XP']};
  const [,key,fmt]=M[board];
  const ranked=[...ps].sort((a,b)=>b[key]-a[key]||b.volume-a.volume);
  const crewDone=ps.reduce((n,p)=>n+Math.min(p.sessions,WEEK_TARGET),0), crewGoal=ps.length*WEEK_TARGET;
  const pct=crewGoal?Math.round(crewDone/crewGoal*100):0;
  t.innerHTML=`
    <div class="crew-card"><div class="achead" style="margin-bottom:4px">Crew goal this week</div>
      <div class="cgoal"><b class="mono">${crewDone}/${crewGoal}</b> sessions${pct>=100?' — crew week complete 🎉':''}</div>
      <div class="xpbar" style="height:9px;margin-top:8px"><i style="width:${pct}%"></i></div>
      <div class="legend" style="text-align:left">everyone’s sessions count toward the group goal (up to ${WEEK_TARGET} each)</div></div>
    <div class="seg small" id="boardSeg">${Object.entries(M).map(([k,[l]])=>`<button data-b="${k}" class="${board===k?'on':''}">${l}</button>`).join('')}</div>
    ${ranked.map((p,i)=>`<div class="frow card${p.isMe?' me':''}"${p.isMe?'':` data-open="${esc(p.username)}"`}><span class="rank">${['🥇','🥈','🥉'][i]||i+1}</span><span class="av">${esc(p.avatar)}</span><div class="fn"><b>${p.isMe?'You':esc(p.name)}</b><small>LV ${p.level}</small></div><span class="lbv mono">${fmt(p[key])}</span></div>`).join('')}
    <div class="legend">${board==='sessions'||board==='volume'?'this week · resets Monday':'all time'}</div>`;
  t.querySelectorAll('[data-b]').forEach(b=>b.onclick=()=>{ board=b.dataset.b; renderBoard(t); });
  t.querySelectorAll('[data-open]').forEach(r=>r.onclick=()=>openFriend(r.dataset.open));
}

/* ---------- invite + settings ---------- */
async function invite(){
  if(HOSTED){
    // a crew's invite link carries its private group id: whoever has it can join
    const url=CrewLocal.inviteUrl();
    $('#crewSheet').innerHTML=`<div class="grab"></div><div class="rv-head"><div class="ttl">Invite friends</div></div>
      <div class="ask-msg" style="margin:10px 2px">1 · Send a friend your crew’s private link<br>2 · They open it and sign in or create an Iron Log account<br>3 · They tap <b>Join this crew</b></div>
      <div class="legend" style="text-align:left;margin:0 2px 10px">Anyone with this link can join and see the crew’s shared workouts and stats, so send it only to people you train with. Your full training log always stays private.</div>
      <div class="pfield"><label>Crew link</label><input id="invUrl" readonly value="${esc(url)}"></div>
      <div class="dbtns" style="margin-top:12px"><button class="dbtn" id="invCopy">${navigator.share?'Share link':'Copy link'}</button><button class="dbtn go" id="invDone">Done</button></div>`;
    $('#crewScrim').classList.add('show');
    $('#invDone').onclick=closeSheet;
    $('#invCopy').onclick=async()=>{
      try{ if(navigator.share){ await navigator.share({title:'Join my Iron Log crew',text:'Train with me on Iron Log 💪',url}); return; } }catch(e){ if(e&&e.name==='AbortError') return; }
      try{ await navigator.clipboard.writeText(url); toast('Link copied'); }catch(e){ const i=$('#invUrl'); i.focus(); i.select(); toast('Select the link and copy it'); } };
    return;
  }
  const url=location.origin+location.pathname+'?add='+encodeURIComponent(S.me.code);
  const text=`Train with me on Iron Log 💪 Add me: ${S.me.code} (@${S.me.username})`;
  try{ if(navigator.share){ await navigator.share({title:'Iron Log crew',text,url}); return; } }catch(e){ if(e&&e.name==='AbortError') return; }
  try{ await navigator.clipboard.writeText(text+'\n'+url); toast('Invite link copied'); }
  catch(e){ await askText('Copy this invite link',url); }
}
function openSettings(){
  $('#crewSheet').innerHTML=`<div class="grab"></div>
    <div class="rv-head"><div class="ttl">Crew settings</div></div>
    <div class="pfield" style="margin:10px 0 8px"><label>${HOSTED?'Crew nickname':'Display name'}</label><input id="stN" maxlength="30" value="${HOSTED?'':esc(S.me.name)}" placeholder="${HOSTED?'Leave empty to use your Iron Log name':''}"></div>
    <div class="pfield"><label>Avatar</label><div class="avpick" id="stA">${AVATARS.map(a=>`<button data-av="${a}" class="${a===S.me.avatar?'on':''}">${a}</button>`).join('')}</div></div>
    <label class="toggle"><input type="checkbox" id="stAuto" ${S.autoShare?'checked':''}> Share every saved workout with my crew automatically</label>
    <button class="crew-btn" id="stSave" style="margin-top:12px">Save</button>
    ${HOSTED?'<button class="dbtn" id="stDel" style="width:100%;margin-top:12px">Leave crew</button>':'<div class="dbtns" style="margin-top:12px"><button class="dbtn" id="stOut">Log out</button><button class="dbtn" id="stDel">Delete account</button></div>'}
    <button class="rv-close" id="stClose" style="margin-top:10px">Close</button>`;
  $('#crewScrim').classList.add('show');
  $('#crewSheet').querySelectorAll('#stA [data-av]').forEach(b=>b.onclick=()=>{ $('#crewSheet').querySelectorAll('#stA button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); });
  $('#stClose').onclick=closeSheet;
  $('#stSave').onclick=async()=>{
    S.autoShare=$('#stAuto').checked; saveS();
    const av=$('#crewSheet').querySelector('#stA .on');
    try{ const d=await api('PUT','/profile',{name:$('#stN').value.trim(),avatar:av?av.dataset.av:S.me.avatar}); S.me=d.me; saveS(); toast('Saved'); closeSheet(); render(); }
    catch(e){ toast(e.message); }
  };
  if($('#stOut')) $('#stOut').onclick=async()=>{ try{ await api('POST','/logout'); }catch(e){} signOutLocal(); closeSheet(); render(); toast('Logged out of Crew'); };
  $('#stDel').onclick=async()=>{
    if(HOSTED){
      if(!await ask('Leave the crew? Your shared workouts, likes, comments and nudges are removed. Your training log stays in your account.','Leave crew',true)) return;
      try{ await api('POST','/account/delete'); signOutLocal(); S.shared={}; saveS(); hostedState='new'; closeSheet(); render(); toast('You left the crew'); }
      catch(e){ toast(e.message); }
      return;
    }
    const pw=await askText('This permanently deletes your Crew account, shared workouts, likes and comments. Your training log on this device is kept.\n\nEnter your password to confirm:','',{type:'password'});
    if(!pw) return;
    try{ await api('POST','/account/delete',{password:pw}); signOutLocal(); S.shared={}; saveS(); closeSheet(); render(); toast('Crew account deleted'); }
    catch(e){ toast(e.message); }
  };
}
$('#crewScrim').addEventListener('click',e=>{ if(e.target.id==='crewScrim') closeSheet(); });

/* ---------- invite links: ?add=CODE ---------- */
function readInviteParam(){
  try{
    const u=new URL(location.href); const c=u.searchParams.get('add');
    if(c){ S.pendingAdd=c.trim().slice(0,20); saveS(); u.searchParams.delete('add'); history.replaceState(null,'',u.pathname+u.search+u.hash); return true; }
  }catch(e){}
  return false;
}
async function maybeAddPending(){
  if(!S.pendingAdd||!signedIn()) return;
  const c=S.pendingAdd; S.pendingAdd=''; saveS();
  if(c.toUpperCase()===(S.me.code||'')) return;
  try{ const d=await api('POST','/friends/request',{target:c}); toast(d.status==='friends'?'You’re now training together 🤝':'Friend request sent to @'+d.username); await loadCrew(); if(activeView==='crew') render(); }
  catch(e){ toast(e.message); }
}

/* ---------- boot ---------- */
loadS();
const invited=HOSTED?false:readInviteParam();
window.Social={afterSave,afterEdit,afterDelete,renderShare,onReviewClose,sync,render};
if(HOSTED){ S.token=''; S.me=null; }    // artifact mode: membership comes from the crew store, never a saved token
Promise.resolve(window.appReady).catch(()=>{}).then(()=>{
  if(HOSTED){ S.shared={}; loadS(); S.token=''; S.me=null; hostedBoot(); if(window.CrewLocal&&CrewLocal.invitedTo()) showView('crew'); return; }
  if(invited&&!signedIn()){ showView('crew'); return; }
  if(signedIn()){
    sync();
    loadCrew().then(()=>{ if(invited) showView('crew'); maybeAddPending(); }).catch(()=>{});
  }
});
addEventListener('ironlog-crew-invite',()=>{ if(!HOSTED) return; hostedState=''; hostedBooting=null; S.token=''; S.me=null; showView('crew'); });
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&signedIn()) loadCrew().then(()=>{ if(activeView==='crew') render(); }).catch(()=>{}); });
})();

