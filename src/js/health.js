/* js/health.js — Apple Health sync.
   Web pages (Safari, home-screen apps) can't read HealthKit; only native iOS apps can.
   So a Shortcuts personal automation on the iPhone runs every morning ("the cron job"), reads
   Health, and copies a small text export (and saves it to iCloud Drive). "Import from Apple Health"
   merges it here. Also accepts JSON from the Health Auto Export app.
   state.health = {weight:{ymd:lb}, steps:{ymd:n}, rhr:{ymd:bpm}, sleep:{ymd:hours}, workouts:[{d,name,min}], lastImport} */
(function(){
const KEEP_DAYS=400;
/* ---------- hands-free import: the Shortcut opens  <app>#k=<device key>&health=<url-encoded export>
   The #fragment never leaves the phone (browsers don't send it to the server). The key lives in the
   (encrypted, synced) account, so it matches in Safari and in the Home Screen app — iOS keeps their storage
   apart, and a shortcut's Open URLs lands in Safari. With the key the import runs straight away; without it
   (or from an unknown link) Iron Log asks first. */
function deviceKey(){
  const st=state.settings||(state.settings={});
  if(!st.healthKey){ const a=crypto.getRandomValues(new Uint8Array(12)); st.healthKey=[...a].map(b=>'abcdefghijkmnpqrstuvwxyz23456789'[b%32]).join(''); try{ persist(); }catch(e){} }
  return st.healthKey;
}
let fromLink=null;
function grabLink(){
  const h=String(location.hash||''); if(!/(^#|&)health=/.test(h)) return false;
  const kv={}; h.slice(1).split('&').forEach(p=>{ const i=p.indexOf('='); if(i>0){ try{ kv[p.slice(0,i)]=decodeURIComponent(p.slice(i+1).replace(/\+/g,'%20')); }catch(e){ kv[p.slice(0,i)]=''; } } });
  try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){}
  if(!kv.health) return false;
  fromLink={text:kv.health,key:kv.k||''}; return true;
}
grabLink();
async function runLinkImport(){
  if(!fromLink) return;
  if(!(window.IronAuth&&IronAuth.acct)&&typeof state!=='object') return;
  const {text,key}=fromLink; fromLink=null;
  const mine=(state.settings&&state.settings.healthKey)||'';
  if(!(mine&&key===mine)){
    const ok=typeof ask==='function'?await ask('Import Apple Health data from this link? Only do this if it came from your own Iron Log Health shortcut.','Import'):true;
    if(!ok) return;
  }
  try{ await importText(text); }catch(e){ toast('Couldn’t read the Apple Health data — '+e.message); }
}
addEventListener('hashchange',()=>{ if(grabLink()) Promise.resolve(window.appReady).then(runLinkImport); });
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad=n=>String(n).padStart(2,'0');
const ymdOf=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
function H(){ const s=state; if(!s.health||typeof s.health!=='object'||Array.isArray(s.health)) s.health={};
  const h=s.health; ['weight','steps','rhr','sleep','exercise'].forEach(k=>{ if(!h[k]||typeof h[k]!=='object'||Array.isArray(h[k])) h[k]={}; });
  if(!Array.isArray(h.workouts)) h.workouts=[]; return h; }

/* ---------- parsing ---------- */
function parseDate(v){
  if(v==null||v==='') return null;
  if(typeof v==='number') return new Date(v>1e12?v:v*1000);
  let t=String(v).trim().replace(/\s+at\s+/i,' ').replace(/ /g,' ');
  let d=new Date(t); if(!isNaN(d)) return d;
  // "2026-10-31 07:12:00 -0700" (Health Auto Export)
  const m=t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}):?(\d{2})?$/);
  if(m){ d=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}${m[7]}:${m[8]||'00'}`); if(!isNaN(d)) return d; }
  const m2=t.match(/(\d{4})-(\d{2})-(\d{2})/); if(m2) return new Date(+m2[1],+m2[2]-1,+m2[3],12);
  return null;
}
const num=v=>{ const m=String(v==null?'':v).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/); return m?+m[0]:NaN; };
/* seconds from "2700", "45 min", "1 hr 5 min", "1:05:00", "7h 12m" (a bare number ≥ 1000 or with s = seconds; < 1000 = minutes) */
function durSec(v){
  if(v&&typeof v==='object') return durSec((v.qty||0)+' '+(v.units||'s'));
  const t=String(v==null?'':v).toLowerCase().trim(); if(!t) return NaN;
  if(/^\d+:\d{2}(:\d{2})?$/.test(t)){ const p=t.split(':').map(Number); return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+p[1]; }
  let s=0, hit=false;
  t.replace(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m(?!s)|seconds?|secs?|s)\b/g,(_,n,u)=>{ hit=true; n=+n; s+=u[0]==='h'?n*3600:u[0]==='m'?n*60:n; return _; });
  if(hit) return s;
  const n=num(t); if(!Number.isFinite(n)) return NaN;
  return n>=1000?n:n*60;
}
const ASLEEP=/asleep|core|deep|rem|sleep(?!.*(in ?bed|awake))/i;
function addSleep(acc,start,end,value,secs){
  if(value&&/in ?bed|awake/i.test(value)&&!/asleep/i.test(value)) return;
  if(value&&!ASLEEP.test(value)) return;
  const e=parseDate(end)||parseDate(start); if(!e) return;
  let sec=secs; if(!Number.isFinite(sec)){ const s=parseDate(start); if(s&&parseDate(end)) sec=(parseDate(end)-s)/1000; }
  if(!Number.isFinite(sec)||sec<=0||sec>20*3600) return;
  const k=ymdOf(e); acc[k]=(acc[k]||0)+sec/3600;
}
/* simple line export from the Shortcut: kind,date,value[,unit|end|type] */
function parseLines(text){
  const out={weight:{},steps:{},rhr:{},sleep:{},exercise:{},workouts:[]}; let n=0;
  String(text).split(/\r?\n/).forEach(line=>{
    const raw=line.trim(); if(!raw) return;
    const p=raw.split(/\s*[|,;\t]\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x=>x.replace(/^"|"$/g,''));
    // "Oct 30, 2026 at 6:00 PM" (Shortcuts' default date format) contains a comma: glue it back together
    for(let i=1;i<p.length-1;i++) if(/^[A-Za-z]{3,9}\.? \d{1,2}$/.test(p[i])&&/^\d{4}\b/.test(p[i+1])) p.splice(i,2,p[i]+', '+p[i+1]);
    const kind=(p[0]||'').toLowerCase();
    if(kind.startsWith('weight')||kind.startsWith('body')){ const d=parseDate(p[1]), v=num(p[2]); if(!d||!(v>0)) return;
      const unit=((p[3]||'')+' '+p[2]).toLowerCase(); out.weight[ymdOf(d)]=Math.round((/kg/.test(unit)?v*2.20462:v)*10)/10; n++; }
    else if(kind.startsWith('step')){ const d=parseDate(p[1]), v=num(p[2]); if(!d||!(v>=0)) return; const k=ymdOf(d); out.steps[k]=(out.steps[k]||0)+Math.round(v); n++; }
    else if(kind.startsWith('exercise')){ const d=parseDate(p[1]), v=num(p[2]); if(!d||!(v>=0&&v<1440)) return; const k=ymdOf(d); out.exercise[k]=(out.exercise[k]||0)+Math.round(v); n++; }
    else if(kind.startsWith('rhr')||kind.startsWith('resting')){ const d=parseDate(p[1]), v=num(p[2]); if(!d||!(v>20&&v<220)) return; out.rhr[ymdOf(d)]=Math.round(v); n++; }
    else if(kind.startsWith('sleep')){ // sleep,start,end,value   or   sleep,date,hours
      if(p.length>=4&&parseDate(p[2])){ addSleep(out.sleep,p[1],p[2],p[3]); n++; }
      else { const d=parseDate(p[1]); let hrs=num(p[2]); if(/min|hr|h\b|:/.test(String(p[2]))) hrs=durSec(p[2])/3600; if(d&&hrs>0&&hrs<20){ const k=ymdOf(d); out.sleep[k]=(out.sleep[k]||0)+hrs; n++; } } }
    else if(kind.startsWith('workout')){ const d=parseDate(p[1]); const sec=durSec(p[2]); const name=(p.slice(3).join(' ')||'Workout').trim().slice(0,40);
      if(d&&sec>0) { out.workouts.push({d:ymdOf(d),name,min:Math.round(sec/60)}); n++; } }
  });
  return {out,n};
}
/* Health Auto Export (iOS app) JSON */
function parseHAE(j){
  const out={weight:{},steps:{},rhr:{},sleep:{},exercise:{},workouts:[]}; let n=0;
  const root=j.data||j, metrics=Array.isArray(root.metrics)?root.metrics:[];
  metrics.forEach(m=>{ const name=String(m.name||'').toLowerCase(), units=String(m.units||'').toLowerCase(), data=Array.isArray(m.data)?m.data:[];
    data.forEach(x=>{ const d=parseDate(x.date||x.startDate||x.sleepEnd||x.inBedEnd); if(!d) return; const k=ymdOf(d);
      if(/weight|body_mass/.test(name)){ const v=+x.qty; if(v>0){ out.weight[k]=Math.round((/kg/.test(units)?v*2.20462:v)*10)/10; n++; } }
      else if(/step_count|^steps$/.test(name)){ const v=+x.qty; if(v>=0){ out.steps[k]=(out.steps[k]||0)+Math.round(v); n++; } }
      else if(/apple_exercise_time|exercise_time/.test(name)){ const v=+x.qty; if(v>=0){ out.exercise[k]=(out.exercise[k]||0)+Math.round(v); n++; } }
      else if(/resting_heart_rate/.test(name)){ const v=+x.qty||+x.Avg; if(v>20){ out.rhr[k]=Math.round(v); n++; } }
      else if(/sleep/.test(name)){ let hrs=+x.totalSleep||+x.asleep||((+x.core||0)+(+x.deep||0)+(+x.rem||0))||+x.qty; if(/min/.test(units)&&hrs>20) hrs/=60; if(hrs>0&&hrs<20){ out.sleep[k]=hrs; n++; } }
    }); });
  (Array.isArray(root.workouts)?root.workouts:[]).forEach(w=>{ const d=parseDate(w.start||w.startDate); const sec=durSec(w.duration); if(d&&sec>0){ out.workouts.push({d:ymdOf(d),name:String(w.name||'Workout').slice(0,40),min:Math.round(sec/60)}); n++; } });
  return {out,n};
}
function parse(text){
  const t=String(text||'').trim(); if(!t) throw new Error('Nothing to import');
  if(t[0]==='{'||t[0]==='['){ let j; try{ j=JSON.parse(t); }catch(e){ throw new Error('That file isn’t valid JSON'); }
    const r=parseHAE(Array.isArray(j)?{metrics:j}:j); if(!r.n) throw new Error('No Apple Health data found in that file'); return r; }
  const r=parseLines(t); if(!r.n) throw new Error('No Apple Health lines found — run the Iron Log Health shortcut, then paste'); return r;
}
function merge(r){
  const h=H(), cut=addDays(todayStr(),-KEEP_DAYS), today=todayStr(), cnt={weight:0,steps:0,rhr:0,sleep:0,exercise:0,workouts:0};
  ['weight','steps','rhr','sleep','exercise'].forEach(k=>Object.entries(r.out[k]||{}).forEach(([d,v])=>{ if(d<cut||d>today) return;
    h[k][d]=k==='sleep'?Math.round(v*10)/10:v; cnt[k]++; }));
  const seen=new Set(h.workouts.map(w=>w.d+'|'+w.name+'|'+w.min));
  r.out.workouts.forEach(w=>{ if(w.d<cut||w.d>today) return; const key=w.d+'|'+w.name+'|'+w.min; if(!seen.has(key)){ seen.add(key); h.workouts.push(w); cnt.workouts++; } });
  ['weight','steps','rhr','sleep','exercise'].forEach(k=>Object.keys(h[k]).forEach(d=>{ if(d<cut) delete h[k][d]; }));
  h.workouts=h.workouts.filter(w=>w.d>=cut).sort((a,b)=>a.d<b.d?-1:1).slice(-300);
  h.lastImport=new Date().toISOString();
  return cnt;
}
async function importText(text){
  const r=parse(text); const cnt=merge(r); await persist();
  try{ renderYou(); }catch(e){} try{ if(activeView==='stats') renderStats(); }catch(e){}
  const parts=[cnt.weight&&cnt.weight+' weigh-ins',cnt.sleep&&cnt.sleep+' nights of sleep',cnt.rhr&&cnt.rhr+' resting HR',cnt.steps&&cnt.steps+' days of steps',cnt.exercise&&cnt.exercise+' days of exercise minutes',cnt.workouts&&cnt.workouts+' workouts'].filter(Boolean);
  toast(parts.length?'Imported '+parts.join(', '):'Already up to date');
  return cnt;
}

/* ---------- summaries for the coach, planner and Stats ---------- */
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const lastN=(obj,n)=>{ const out=[]; for(let i=0;i<n;i++){ const d=addDays(todayStr(),-i); if(obj[d]!=null) out.push(obj[d]); } return out; };
function summary(){
  const h=H(); if(!h.lastImport) return null;
  const days=[]; for(let i=6;i>=0;i--){ const d=addDays(todayStr(),-i); const row={d};
    if(h.sleep[d]!=null) row.sleepH=h.sleep[d]; if(h.rhr[d]!=null) row.rhr=h.rhr[d]; if(h.steps[d]!=null) row.steps=h.steps[d]; if(h.weight[d]!=null) row.weightLb=h.weight[d]; if(h.exercise[d]!=null) row.exerciseMin=h.exercise[d];
    if(Object.keys(row).length>1) days.push(row); }
  const rhr30=avg(lastN(h.rhr,30)), sl30=avg(lastN(h.sleep,30));
  return {source:'Apple Health',lastSync:h.lastImport.slice(0,10),last7Days:days,
    baseline30d:{restingHR:rhr30&&Math.round(rhr30),sleepH:sl30&&Math.round(sl30*10)/10},
    otherWorkouts:h.workouts.filter(w=>w.d>=addDays(todayStr(),-10)&&!/strength|functional|yoga|core/i.test(w.name)).slice(-10)};
}
function weights(){ return Object.entries(H().weight).map(([date,weight])=>({date,weight})); }
const ago=iso=>{ const d=Math.floor((Date.now()-new Date(iso))/86400000); return d<=0?'today':d===1?'yesterday':d+' days ago'; };
function renderCard(){
  const el=document.getElementById('healthCard'); if(!el) return;
  const h=H(), s=summary();
  const sl=s&&avg(lastN(h.sleep,7)), rh=s&&avg(lastN(h.rhr,7)), st=s&&avg(lastN(h.steps,7));
  const wk=s?Object.keys(h.weight).sort().pop():null;
  el.innerHTML=`<div class="achead">Apple Health</div>
    <div class="hcard">
      <div class="hc-top"><span class="hc-ic">♥</span><div><b>${s?'Synced '+ago(h.lastImport):'Not connected yet'}</b>
        <small>${s?'Your coach and planner use this for recovery':'Bring in weight, sleep, resting heart rate, steps and exercise minutes'}</small></div></div>
      ${s?`<div class="hc-grid">
        <div><span class="k">Sleep</span><b>${sl?sl.toFixed(1)+' h':'—'}</b></div>
        <div><span class="k">Resting HR</span><b>${rh?Math.round(rh):'—'}</b></div>
        <div><span class="k">Steps</span><b>${st?(st>=1000?(st/1000).toFixed(1)+'k':Math.round(st)):'—'}</b></div>
        <div><span class="k">Weight</span><b>${wk?WL(h.weight[wk]):'—'}</b></div></div><div class="legend" style="text-align:left;margin:-2px 2px 10px">7-day averages</div>`:''}
      <div class="dbtns"><button class="dbtn go" id="hcImp">Import from Apple Health</button><button class="dbtn" id="hcSetup">${s?'Daily sync setup':'Set up daily sync'}</button></div>
    </div>`;
  el.querySelector('#hcImp').onclick=openImport;
  el.querySelector('#hcSetup').onclick=openSetup;
}
function sheet(html){ const s=document.getElementById('woSheet'), sc=document.getElementById('woScrim'); s.innerHTML='<div class="grab"></div>'+html; sc.classList.add('show'); return s; }
const closeSheet=()=>document.getElementById('woScrim').classList.remove('show');
function openImport(){
  const s=sheet(`<div class="rv-head"><div class="ttl">Import from Apple Health</div></div>
    <div class="rv-sub">Run your <b>Iron Log Health</b> shortcut (or let the morning automation run it), then paste here — or pick the file it saved to iCloud Drive.</div>
    <textarea class="brbox" id="hiTxt" placeholder="Paste the shortcut’s output here" style="min-height:120px"></textarea>
    <div class="ila-err" id="hiErr"></div>
    <button class="crew-btn" id="hiGo">Import</button>
    <button class="dbtn" id="hiFile" style="width:100%;margin-top:8px">Choose file (Iron Log Health.txt or Health Auto Export .json)</button>
    <input type="file" id="hiF" accept=".txt,.json,.csv,text/plain,application/json" style="display:none">
    <button class="linkbtn" id="hiSetup" style="display:block;margin:12px auto 0">Haven’t set up the shortcut yet?</button>
    <button class="rv-close" id="hiX" style="margin-top:10px">Cancel</button>`);
  const err=s.querySelector('#hiErr');
  const run=async txt=>{ err.textContent=''; try{ await importText(txt); closeSheet(); }catch(e){ err.textContent=e.message; } };
  s.querySelector('#hiGo').onclick=()=>run(s.querySelector('#hiTxt').value);
  s.querySelector('#hiFile').onclick=()=>s.querySelector('#hiF').click();
  s.querySelector('#hiF').onchange=e=>{ const f=e.target.files[0]; if(!f) return; if(f.size>25*1024*1024){ err.textContent='That file is too big — use the shortcut or Health Auto Export instead of the full Health export'; return; }
    const rd=new FileReader(); rd.onload=()=>run(String(rd.result)); rd.readAsText(f); };
  s.querySelector('#hiSetup').onclick=openSetup;
  s.querySelector('#hiX').onclick=closeSheet;
}
const LINE=(kind,parts)=>`<code>${kind},</code>${parts.map(x=>`<span class="tok">${x}</span>`).join('<code>,</code>')}`;
function openSetup(){
  const s=sheet(`<div class="rv-head"><div class="ttl">Daily Apple Health sync</div></div>
    <div class="rv-sub">Apple only lets native iPhone apps read Health — no web app can, even from the Home Screen. So your iPhone does the reading: a shortcut gathers your data, and an automation runs it every morning. One-time setup, about 10 minutes.</div>
    <div class="hs-step"><b>1 · Create the shortcut</b><p>Shortcuts app → <b>＋</b> → name it <b>Iron Log Health</b>. Add these blocks for each data type:</p>
      <ol>
        <li><b>Find Health Samples</b> where <i>Type</i> is <b>Weight</b> and <i>Start Date</i> is in the last <b>14 days</b>.</li>
        <li><b>Repeat with Each</b> item in Health Samples → inside it add <b>Text</b>:<div class="hs-line">${LINE('weight',['Start Date','Value','Unit'])}</div>
          <small>Tap <i>Repeat Item</i> to pick each property. For Start Date choose Date Format → <b>ISO 8601</b>.</small></li>
        <li>After <b>End Repeat</b>, add <b>Combine Text</b> (Repeat Results, New Lines) and rename it <b>Weight Lines</b>.</li>
      </ol>
      <p>Repeat those three blocks for:</p>
      <ul class="hs-types">
        <li><b>Steps</b>, with <i>Group By</i> <b>Day</b>:<div class="hs-line">${LINE('steps',['Start Date','Value'])}</div></li>
        <li><b>Resting Heart Rate</b>:<div class="hs-line">${LINE('rhr',['Start Date','Value'])}</div></li>
        <li><b>Sleep Analysis</b>:<div class="hs-line">${LINE('sleep',['Start Date','End Date','Value'])}</div></li>
        <li><b>Exercise Minutes</b>, with <i>Group By</i> <b>Day</b>:<div class="hs-line">${LINE('exercise',['Start Date','Value'])}</div></li>
      </ul></div>
    <div class="hs-step"><b>2 · Finish the shortcut — send it to Iron Log</b><p>Add a <b>Text</b> block containing your five combined variables, one per line. Then add <b>URL Encode</b> (Encode the Text), then <b>Text</b> with this link followed by the <i>URL Encoded Text</i> variable, then <b>Open URLs</b>:</p>
      <div class="hs-line mono" id="hsLink" style="word-break:break-all">${esc(linkPrefix())}<span class="tok">URL Encoded Text</span></div>
      <button class="dbtn" id="hsCopy" style="width:100%;margin-top:6px">Copy link start</button>
      <small>The link carries your account’s private import key, so Iron Log imports without asking. It opens in Safari — sign in to Iron Log there once${window.ironPlatform&&ironPlatform.backend==='supabase'?'; your data then syncs to the Home Screen app too':'. This copy keeps data on the device only, so use Iron Log in Safari for this'}. (Optional: also add <b>Save File</b> → iCloud Drive / Shortcuts / <b>Iron Log Health.txt</b> as a backup you can import by hand.)</small></div>
    <div class="hs-step"><b>3 · Make it run every morning</b><p>Shortcuts → <b>Automation</b> → <b>＋</b> → <b>Time of Day</b> → 7:00 AM, Daily → <b>Run Immediately</b> → choose <b>Iron Log Health</b>. If it says “authorization not determined”: Health app → your profile picture → Apps → Shortcuts → Turn On All, then run it again.</p></div>
    <div class="hs-step"><b>4 · That’s it</b><p>Each morning the shortcut opens Iron Log and your data comes straight in — no pasting. You can still use <b>Import from Apple Health</b> to paste or pick a file.</p></div>
    <div class="hs-alt"><b>Prefer fully hands-off?</b> The <b>Health Auto Export</b> app (App Store, paid) can save a JSON file to iCloud Drive on a schedule with no shortcut building — Iron Log imports its JSON files too.</div>
    <button class="rv-close" id="hsX" style="margin-top:12px">Done</button>`);
  s.querySelector('#hsX').onclick=closeSheet;
  s.querySelector('#hsCopy').onclick=async()=>{ try{ await navigator.clipboard.writeText(linkPrefix()); toast('Copied — paste it into the Text block'); }catch(e){ toast('Select the link above and copy it'); } };
}
const linkPrefix=()=>location.origin+location.pathname+'#k='+deviceKey()+'&health=';
/* ---------- Save to Apple Health ----------
   Web pages can't write HealthKit, but a shortcut can: Iron Log runs the "Iron Log Workout" shortcut
   (shortcuts://run-shortcut) with the session as JSON {type, start, minutes, kcal, title}; the shortcut's
   Log Workout action records it in Health, where it counts toward Activity rings. */
const WO_SHORTCUT='Iron Log Workout';
const isApple=()=>/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent||'');
function workoutKind(entry){
  const ids=Object.keys(entry.ex||{}); if(!ids.length) return 'strength';
  if(ids.filter(i=>/^yg_/.test(i)).length*2>=ids.length) return 'yoga';
  if(window.IronHomeIds&&ids.every(i=>IronHomeIds.has(i))) return 'home';
  return 'strength';
}
function latestWeightLb(){
  const all=[...weights(),...((state.checkins||[]).filter(c=>c&&+c.weight>0).map(c=>({date:c.date,weight:+c.weight})))].filter(x=>x.date&&+x.weight>0).sort((a,b)=>a.date<b.date?1:-1);
  return all.length?+all[0].weight:null;
}
function healthPayload(entry){
  const kind=workoutKind(entry);
  const sets=Object.values(entry.ex||{}).reduce((n,a)=>n+(Array.isArray(a)?a.length:0),0);
  const minutes=entry.duration>0?Math.max(1,Math.round(entry.duration/60)):Math.max(15,Math.min(90,Math.round(sets*2.5)));
  const startMs=+entry.start>0?+entry.start:new Date(entry.date+'T12:00:00').getTime();
  const d=new Date(startMs), off=-d.getTimezoneOffset(), pad2=n=>String(Math.abs(n)).padStart(2,'0');
  const iso=`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00${off>=0?'+':'-'}${pad2(Math.trunc(off/60))}:${pad2(off%60)}`;
  const lb=latestWeightLb(), met={strength:5,home:4,yoga:2.5}[kind];
  const kcal=lb?Math.round(met*(lb*0.4536)*(minutes/60)):0;
  return {type:kind,start:iso,minutes,kcal,title:String(entry.name||'Iron Log workout').slice(0,40)};
}
function openShortcut(url){ location.href=url; }
function sendWorkout(entry){
  const p=healthPayload(entry);
  HealthSync._open('shortcuts://run-shortcut?name='+encodeURIComponent(WO_SHORTCUT)+'&input=text&text='+encodeURIComponent(JSON.stringify(p)));
  const l=(state.logs||[]).find(x=>x.id===entry.id); if(l){ l.hk=Date.now(); persist(); }
  return p;
}
function renderSave(entry){
  const el=document.getElementById('rvHealth'); if(!el) return;
  if(!isApple()||!entry||!entry.id){ el.innerHTML=''; return; }
  const l=(state.logs||[]).find(x=>x.id===entry.id)||entry;
  el.innerHTML=`<button class="dbtn" id="rvHk" style="width:100%;margin-top:8px">${l.hk?'✓ Sent to Apple Health · send again':'♥ Save to Apple Health'}</button>
    <button class="linkbtn" id="rvHkHow" style="display:block;margin:6px auto 0">How this works</button>`;
  el.querySelector('#rvHk').onclick=()=>{ sendWorkout(l); renderSave(l); };
  el.querySelector('#rvHkHow').onclick=openWorkoutSetup;
}
function openWorkoutSetup(){
  const s=sheet(`<div class="rv-head"><div class="ttl">Save workouts to Apple Health</div></div>
    <div class="rv-sub">Web apps can’t write to Health directly, so a small shortcut does it. Build it once (about 3 minutes); after that, <b>Save to Apple Health</b> on the workout summary logs the session — it counts toward your Activity rings.</div>
    <div class="hs-step"><b>1 · Create the shortcut</b><p>Shortcuts app → <b>＋</b> → name it exactly <b>${WO_SHORTCUT}</b>.</p></div>
    <div class="hs-step"><b>2 · Read what Iron Log sends</b><p>Add <b>Get Dictionary from Input</b> (input: <i>Shortcut Input</i>). Then add four <b>Get Dictionary Value</b> blocks for the keys <code>type</code>, <code>start</code>, <code>minutes</code> and <code>kcal</code>. Add <b>Get Dates from Input</b> on the <i>start</i> value.</p></div>
    <div class="hs-step"><b>3 · Log the workout</b><p>Add <b>If</b> <i>type</i> is <code>yoga</code> → <b>Log Workout</b> type <b>Yoga</b>. <b>Otherwise</b> → <b>If</b> <i>type</i> is <code>home</code> → <b>Log Workout</b> type <b>Functional Strength Training</b>, <b>Otherwise</b> → <b>Log Workout</b> type <b>Traditional Strength Training</b>.</p>
      <p>In each Log Workout set <b>Date</b> to the <i>Dates</i> variable, <b>Duration</b> to <i>minutes</i> with the unit <b>min</b>, and <b>Calories</b> to <i>kcal</i>. Leave Distance empty.</p></div>
    <div class="hs-step"><b>4 · Allow Shortcuts to write to Health</b><p>Health app → your profile → <b>Apps</b> (under Privacy) → <b>Shortcuts</b> → turn on <b>Workouts</b> and <b>Active Energy</b>. Run the shortcut once by hand to grant permission.</p></div>
    <div class="hs-alt"><b>Calories</b> are an estimate from the session length and your latest weight (from Apple Health or check-ins); they’re 0 until Iron Log knows your weight.</div>
    <button class="rv-close" id="hwX" style="margin-top:12px">Done</button>`);
  s.querySelector('#hwX').onclick=closeSheet;
}
/* Stats: recovery section */
function statsHTML(){
  const h=H(); if(!h.lastImport) return '';
  const series=(obj,n)=>{ const d=[],v=[]; for(let i=n-1;i>=0;i--){ const k=addDays(todayStr(),-i); if(obj[k]!=null){ d.push(k); v.push(obj[k]); } } return {d,v}; };
  const sl=series(h.sleep,21), rh=series(h.rhr,21);
  const chart=(s,col,lab)=>s.v.length>=2?`<div class="chartbox" style="margin-bottom:10px">${lineChart(s.v,s.d,{color:col})}<div class="legend">${lab} · last 3 weeks</div></div>`:'';
  const body=chart(sl,'#2B4BFF','Sleep (hours)')+chart(rh,'#111111','Resting heart rate (bpm)');
  return body?`<div class="ana-sec"><div class="ana-h">Recovery · Apple Health</div>${body}</div>`:'';
}

window.HealthSync={parse,merge,importText,summary,weights,renderCard,statsHTML,openImport,openSetup,renderSave,openWorkoutSetup,healthPayload,
  _open:openShortcut,_t:{parseDate,durSec,deviceKey,linkPrefix}};
/* show the card whenever the You tab renders */
if(typeof renderYou==='function'){ const base=renderYou; renderYou=function(){ const r=base.apply(this,arguments); try{ renderCard(); }catch(e){} return r; }; }
Promise.resolve(window.appReady).then(()=>{ try{ renderCard(); }catch(e){} runLinkImport(); });
})();
