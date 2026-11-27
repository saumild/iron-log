/* js/workout.js */
/* ================= Workouts: routines, exercise library, live workout, rest timer, PRs =================
   Saves into state.logs in the same shape the program day view uses
   ({id,date,dayId,week,ex:{id:[{l,r,t?,rpe?}]}}), plus name/order/notes/duration/start,
   so the progression coach, XP, streaks, AI coach and Crew all keep working.
   Uses app.js globals (state, persist, ALLEX, PROGRAM, FINFO, effP, effUnit, currentOpt, swapIdx,
   phaseIdx, weekFromDate, todayStr, computeStats, unlockedSet, ACH, showReview, lineChart, F, toast, $). */
(function(){
const LIVE_KEY='ironlog-live';
/* the unsaved workout belongs to whoever started it — per user in Claude */
const liveKey=()=>HOSTED?LIVE_KEY+':'+((window.IronAuth&&IronAuth.acct&&IronAuth.acct.id)||'nouser'):LIVE_KEY;
const h=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const RESTS=[0,30,45,60,75,90,120,150,180,240,300];
const RPES=['','6','6.5','7','7.5','8','8.5','9','9.5','10'];
const TYPE_CYCLE={n:'w',w:'d',d:'f',f:'n'};
const fmtRest=s=>s?(s>=60?Math.floor(s/60)+':'+String(s%60).padStart(2,'0'):s+'s'):'off';
function clock(sec){ sec=Math.max(0,Math.floor(sec)); const hh=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60;
  return (hh?hh+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0'); }
const newId=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,5);

/* ---------- exercise info ---------- */
function exInfo(id){
  const lib=LIBRARY[id], cus=state.customEx&&state.customEx[id];
  const base=lib||cus||{id,name:id,muscle:'Full body',equip:'Other',type:'wr',secondary:[]};
  return {...base, name:exName(id), custom:!!cus};
}
function unitFor(id){
  if(ALLEX[id]) return effUnit(id);
  const t=exInfo(id).type; return t==='dur'||t==='wd'?'sec':t==='cardio'?'min':'';
}
/* how an exercise is measured: which inputs a set needs and how a logged set reads */
function measure(id){
  const t=exInfo(id).type, u=String(unitFor(id));
  const time=t==='dur'||t==='wd'||u.startsWith('sec'), metres=!time&&u.startsWith('m')&&t!=='cardio';
  return {type:t, load:t==='wr'||t==='wd', canAddLoad:(t==='bw'||t==='dur')&&!isYoga(id),
    rLabel:t==='cardio'?'Min':time?'Sec':metres?'Metres':'Reps', rSuffix:t==='cardio'?' min':time?'s':metres?'m':'',
    timed:time||t==='cardio'};
}
function fmtSet(id,s,noRpe){
  const m=measure(id), pre=s.t==='w'?'W·':s.t==='d'?'D·':s.t==='f'?'F·':'';
  const load=+s.l>0?W(s.l):'';
  return pre+(load?(m.load?load+'×':'+'+load+'×'):'')+(s.r||'–')+(s.r?m.rSuffix:'')+(!noRpe&&s.rpe?'@'+s.rpe:'');
}
function allExercises(){
  const m={...LIBRARY}; Object.values(state.customEx||{}).forEach(c=>{ m[c.id]=c; });
  return Object.values(m).sort((a,b)=>a.name.localeCompare(b.name));
}
function timesLogged(id){ return state.logs.filter(l=>l.ex&&l.ex[id]).length; }

/* ---------- PR engine ---------- */
function bests(sets,id){
  let w=0,e=0,v=0,r=0; const timed=id&&measure(id).timed;   // no 1RM or set volume from seconds/minutes
  working(sets).forEach(s=>{ const l=+s.l||0, rr=+s.r||0; if(rr<=0) return;
    w=Math.max(w,l); r=Math.max(r,rr); if(l>0&&!timed){ e=Math.max(e,l*(1+rr/30)); v=Math.max(v,l*rr); } });
  return {w,e:Math.round(e*10)/10,v,r};
}
const before=(a,b)=>a.date<b.date||(a.date===b.date&&(a.start||0)<(b.start||0)&&a.id!==b.id);
function prsInEntry(entry){
  const out={};
  Object.keys(entry.ex||{}).forEach(id=>{
    const prior=state.logs.filter(l=>l.id!==entry.id&&l.ex&&l.ex[id]&&before(l,entry));
    if(!prior.length) return;                                  // first time is a baseline, not a PR
    const p=prior.reduce((a,l)=>{const b=bests(l.ex[id],id);return{w:Math.max(a.w,b.w),e:Math.max(a.e,b.e),v:Math.max(a.v,b.v),r:Math.max(a.r,b.r)};},{w:0,e:0,v:0,r:0});
    const c=bests(entry.ex[id],id); const list=[]; const m=measure(id);
    if(c.w>0&&m.timed){                                        // loaded carry: heavier, or held longer
      if(c.w>p.w+0.6) list.push({kind:'w',label:`Heaviest ${WL(c.w)}`});
      if(c.r>p.r) list.push({kind:'r',label:`Longest ${c.r}${m.rSuffix}`});
    } else if(c.w>0){
      if(c.w>p.w+0.6) list.push({kind:'w',label:`Heaviest ${WL(c.w)}`});
      if(c.e>p.e+1) list.push({kind:'e',label:`e1RM ${Math.round(+W(c.e))}`});
      if(!list.length&&c.v>p.v+5) list.push({kind:'v',label:`Best set ${VOL(c.v)}`});
    } else if(c.r>p.r) list.push({kind:'r',label:m.timed?`Longest ${c.r}${m.rSuffix}`:`Most reps ${c.r}`});
    if(list.length) out[id]=list;
  });
  return out;
}
function recordsFor(id){
  const logs=state.logs.filter(l=>l.ex&&l.ex[id]&&working(l.ex[id]).length).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:(a.start||0)-(b.start||0));
  const rec={w:[0,''],e:[0,''],v:[0,''],r:[0,''],sv:[0,'']};
  const timed=measure(id).timed;
  const series=logs.map(l=>{ const b=bests(l.ex[id],id); const sv=timed?0:working(l.ex[id]).reduce((n,s)=>n+(+s.l||0)*(+s.r||0),0);
    if(b.w>rec.w[0]) rec.w=[b.w,l.date]; if(b.e>rec.e[0]) rec.e=[b.e,l.date]; if(b.v>rec.v[0]) rec.v=[b.v,l.date];
    if(b.r>rec.r[0]) rec.r=[b.r,l.date]; if(sv>rec.sv[0]) rec.sv=[sv,l.date];
    return {date:l.date,w:b.w,e:b.e,r:b.r,sv,log:l}; });
  return {rec,series};
}

/* ---------- shared sheet ---------- */
let sheetOnClose=null;
function openSheet(html,onClose){
  $('#woSheet').innerHTML='<div class="grab"></div>'+html;
  $('#woScrim').classList.add('show'); sheetOnClose=onClose||null;
}
function closeSheet(){ $('#woScrim').classList.remove('show'); const f=sheetOnClose; sheetOnClose=null; if(f) f(); }

/* ================= exercise library ================= */
let libQuery='', libMuscle='';
/* mode 'browse': tap opens the exercise page. mode 'pick': multi-select, onPick(ids) */
function openLibrary(mode,onPick,keepPicked){
  const picked=new Set(keepPicked||[]);
  const draw=()=>{
    const q=libQuery.toLowerCase();
    // 'Yoga' is its own section; muscle chips show lifting moves only so poses don't crowd them
    const list=allExercises().filter(e=>(libMuscle==='Yoga'?isYoga(e.id):!libMuscle||(!isYoga(e.id)&&(e.muscle===libMuscle||(e.secondary||[]).includes(libMuscle))))&&(!q||e.name.toLowerCase().includes(q)||e.equip.toLowerCase().includes(q)));
    $('#libList').innerHTML=list.map(e=>{ const n=timesLogged(e.id);
      return `<div class="lrow${picked.has(e.id)?' on':''}" data-ex="${h(e.id)}">
        <div class="lnm"><b>${poseHTML(e.name)}</b><small>${isYoga(e.id)?'🧘 Yoga · '+h(e.muscle):h(e.muscle)+' · '+h(e.equip)}${e.custom?' · custom':''}${n?` · ${n}× logged`:''}</small></div>
        ${mode==='pick'?`<span class="lchk">${picked.has(e.id)?'✓':'+'}</span>`:'<span class="lgo">›</span>'}</div>`; }).join('')
      ||'<div class="legend" style="padding:16px 0">No matches. Create it as a custom exercise below.</div>';
    $('#libList').querySelectorAll('[data-ex]').forEach(r=>r.onclick=()=>{
      const id=r.dataset.ex;
      if(mode==='pick'){ picked.has(id)?picked.delete(id):picked.add(id); draw(); }
      else openExercise(id,()=>openLibrary('browse'));
    });
    const go=$('#libGo'); if(go){ go.textContent=picked.size?`Add ${picked.size} exercise${picked.size>1?'s':''}`:'Select exercises'; go.disabled=!picked.size; }
  };
  openSheet(`<div class="rv-head"><div class="ttl">${mode==='pick'?'Add exercises':'Exercises'}</div><div class="dt">${allExercises().length} total</div></div>
    <input class="crew-in" id="libQ" placeholder="Search exercises…" value="${h(libQuery)}" autocomplete="off">
    <div class="mchips">${['','Yoga',...MUSCLES].map(m=>`<button data-m="${h(m)}" class="${m===libMuscle?'on':''}${m==='Yoga'?' yogachip':''}">${m==='Yoga'?'🧘 Yoga':m||'All'}</button>`).join('')}</div>
    <div id="libList" class="llist"></div>
    <button class="dbtn" id="libNew" style="width:100%;margin:8px 0">＋ Create custom ${libMuscle==='Yoga'?'yoga pose':'exercise'}</button>
    ${mode==='pick'?'<button class="crew-btn" id="libGo">Select exercises</button>':''}
    <button class="rv-close" id="libClose" style="margin-top:8px">${mode==='pick'?'Cancel':'Done'}</button>`);
  $('#libQ').oninput=e=>{ libQuery=e.target.value; draw(); };
  $('#woSheet').querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{ libMuscle=b.dataset.m; $('#woSheet').querySelectorAll('[data-m]').forEach(x=>x.classList.toggle('on',x===b)); $('#libNew').textContent='＋ Create custom '+(libMuscle==='Yoga'?'yoga pose':'exercise'); draw(); });
  $('#libNew').onclick=()=>openCustomForm(id=>{ if(mode==='pick'){ picked.add(id); openLibrary('pick',onPick,[...picked]); } else openLibrary('browse'); });
  $('#libClose').onclick=()=>closeSheet();
  const go=$('#libGo'); if(go) go.onclick=()=>{ const ids=[...picked]; $('#woScrim').classList.remove('show'); sheetOnClose=null; onPick(ids); };
  draw();
}
function openCustomForm(done){
  openSheet(`<div class="rv-head"><div class="ttl">Custom exercise</div></div>
    <div class="pfield" style="margin:10px 0 8px"><label>Name</label><input id="cxN" maxlength="60" placeholder="e.g. Landmine Press" value="${h(libQuery)}"></div>
    <div class="pf">
      <div class="pfield"><label>Primary muscle</label><select id="cxM">${MUSCLES.map(m=>`<option>${m}</option>`).join('')}</select></div>
      <div class="pfield"><label>Equipment</label><select id="cxE">${EQUIPMENT.map(m=>`<option>${m}</option>`).join('')}</select></div>
      <div class="pfield full"><label>Logged as</label><select id="cxT"><option value="wr">Weight × reps</option><option value="bw">Bodyweight reps (+ optional load)</option><option value="dur">Duration (seconds)</option><option value="wd">Weight × duration (carries)</option><option value="cardio">Cardio (minutes)</option><option value="yoga"${libMuscle==='Yoga'?' selected':''}>Yoga pose (hold seconds)</option></select></div>
    </div>
    <button class="crew-btn" id="cxSave" style="margin-top:6px">Create exercise</button>
    <button class="rv-close" id="cxCancel" style="margin-top:8px">Cancel</button>`);
  $('#cxCancel').onclick=()=>done&&openLibrary('browse');
  $('#cxSave').onclick=async()=>{
    const name=$('#cxN').value.trim().slice(0,60); if(!name){ toast('Give it a name'); return; }
    if(allExercises().some(e=>e.name.toLowerCase()===name.toLowerCase())){ toast('That exercise already exists'); return; }
    const id='cx_'+newId('');
    const yoga=$('#cxT').value==='yoga';
    state.customEx[id]={id,name,muscle:$('#cxM').value,equip:yoga?'Bodyweight':$('#cxE').value,type:yoga?'dur':$('#cxT').value,secondary:[],custom:true,...(yoga?{yoga:true}:{})};
    await persist(); toast('Created '+name); libQuery=''; done(id);
  };
}

/* ================= exercise detail ================= */
let detailMetric='e';
function openExercise(id,back){
  const info=exInfo(id); const {rec,series}=recordsFor(id); const ms=measure(id), dur=ms.timed;
  const weighted=series.some(p=>p.w>0);
  const metrics=weighted&&dur?[['w','Heaviest'],['r',`Longest (${ms.rSuffix.trim()})`]]:weighted?[['e','Est. 1RM'],['w','Heaviest'],['sv','Session volume'],['r','Best reps']]:[['r',dur?`Longest (${ms.rSuffix.trim()})`:'Best reps']];
  if(!metrics.some(m=>m[0]===detailMetric)) detailMetric=metrics[0][0];
  const card=(k,v,d)=>`<div class="gstat"><div class="v">${v}</div><div class="k">${k}</div>${d?`<div class="legend" style="margin-top:3px">${prettyDate(d)}</div>`:''}</div>`;
  const recHTML=series.length?(weighted&&dur
    ?card('Heaviest',WL(rec.w[0]),rec.w[1])+card('Longest',rec.r[0]+ms.rSuffix,rec.r[1])+card('Sessions',series.length)
    :weighted
    ?card('Heaviest',WL(rec.w[0]),rec.w[1])+card('Est. 1RM',Math.round(+W(rec.e[0]))+' '+unit(),rec.e[1])+card('Best set',VOL(rec.v[0]).toLocaleString(),rec.v[1])
    :card(dur?'Longest':'Most reps',rec.r[0]+ms.rSuffix,rec.r[1])+card('Sessions',series.length)+card('Last',prettyDate(series[series.length-1].date))):'';
  const disp=v=>detailMetric==='r'?v:detailMetric==='sv'?VOL(v):Math.round(+W(v));   // loads shown in the user's unit
  const chart=()=>{ const pts=series.filter(p=>p[detailMetric]>0);
    return pts.length>=2?`<div class="chartbox">${lineChart(pts.map(p=>disp(p[detailMetric])),pts.map(p=>p.date),{color:'#2B4BFF'})}</div>`:'<div class="legend">Log this exercise twice to see a trend.</div>'; };
  const hist=[...series].reverse().slice(0,15).map(p=>{ const sets=p.log.ex[id];
    return `<div class="hrow"><div class="hd"><b>${prettyDate(p.date)}</b><small>${h(entryName(p.log))}</small></div><div class="hs mono">${sets.map(s=>fmtSet(id,s)).join('  ')}</div></div>`; }).join('');
  const slug=info.name.toLowerCase().replace(/[^a-z0-9]+/g,'+');
  const howTo=isYoga(id)?'https://www.youtube.com/results?search_query='+encodeURIComponent(info.name.replace(' · ',' ')+' yoga pose tutorial'):F(slug);
  openSheet(`<div class="rv-head"><div class="ttl" style="font-size:20px">${h(info.name)}</div></div>
    <div class="rv-sub">${h(info.muscle)}${info.secondary&&info.secondary.length?' · '+h(info.secondary.join(', ')):''} · ${h(info.equip)} · <a href="${howTo}" target="_blank" rel="noopener">🎥 how-to${modsOf(id).length?' (standard)':''}</a></div>
    ${modHTML(id,true)}
    ${series.length?`<div class="gstats">${recHTML}</div>
      <div class="seg small" id="exMet">${metrics.map(([k,l])=>`<button data-k="${k}" class="${k===detailMetric?'on':''}">${l}</button>`).join('')}</div>
      <div id="exChart">${chart()}</div>
      <div class="achead" style="margin-top:14px">History</div>${hist}`
    :'<div class="crew-card crew-empty">No sets logged yet.<br>Add it to a workout and your records show up here.</div>'}
    ${['Barbell','Smith'].includes(info.equip)?`<button class="dbtn" id="exPlates" style="width:100%;margin-top:12px">🧮 Plate calculator</button>`:''}
    <button class="dbtn" id="exFc" style="width:100%;margin-top:8px">🎬 AI form check — upload a video of your set</button>
    ${info.custom?'<button class="dbtn" id="exDel" style="width:100%;margin-top:8px">Delete custom exercise</button>':''}
    <button class="rv-close" id="exBack" style="margin-top:10px">${back?'Back':'Done'}</button>`);
  $('#woSheet').querySelectorAll('#exMet [data-k]').forEach(b=>b.onclick=()=>{ detailMetric=b.dataset.k; $('#woSheet').querySelectorAll('#exMet button').forEach(x=>x.classList.toggle('on',x===b)); $('#exChart').innerHTML=chart(); });
  $('#exBack').onclick=()=>back?back():closeSheet();
  $('#exFc').onclick=()=>{ closeSheet(); startFormCheck(id); };
  const pb=$('#exPlates'); if(pb) pb.onclick=()=>openPlates(rec.w[0]||'',info.equip,()=>openExercise(id,back));
  const del=$('#exDel'); if(del) del.onclick=async()=>{
    if(!await ask(`Delete ${info.name}? Logged sets stay in your history.`,'Delete',true)) return;
    delete state.customEx[id]; await persist(); back?back():closeSheet();
  };
}

/* ================= routines ================= */
function renderHome(){
  let el=$('#woHome');
  if(!el){ el=document.createElement('div'); el.id='woHome'; const vt=$('#viewTrain'); vt.insertBefore(el,vt.firstChild); }
  const live=loadLive();
  const card=r=>{ const ids=r.exercises.map(e=>e.id);
    return `<div class="rcard">
      <div class="rc-t"><b>${h(r.name)}</b><small>${ids.length} exercise${ids.length===1?'':'s'}${r.why?' · 🧠 AI':''}</small>
      <div class="rc-x">${h(ids.slice(0,4).map(i=>exName(i)).join(', '))}${ids.length>4?'…':''}</div></div>
      <div class="rc-b"><button class="mini go" data-start="${h(r.id)}">▶ Start</button><button class="mini" data-edit="${h(r.id)}">Edit</button></div></div>`; };
  el.innerHTML=`
    ${live?`<button class="livebar" id="woResume"><span class="dotlive"></span>${h(live.name)} in progress · <span class="mono" data-clock>${clock((Date.now()-live.start)/1000)}</span><b>Resume ›</b></button>`:''}
    <div id="planCard"></div>
    <div class="wo-actions">
      <button class="dbtn" id="woNew">＋ Create your own workout routine</button>
      <button class="dbtn" id="woLib">📚 Exercises</button>
    </div>
    <div class="rhead"><span>Your routines</span></div>
    ${state.routines.length?`<div class="rlist">${state.routines.map(card).join('')}</div>`
      :'<div class="legend" style="text-align:left;margin:0 2px 12px">No routines yet. Create one above, save today’s plan as one, or apply a routine the AI suggests. A routine starts only after it’s saved.</div>'}`;
  el.insertAdjacentHTML('beforeend',historyHTML());
  wireHistory(el);
  if(window.Planner) try{ Planner.render($('#planCard')); }catch(e){ console.error('plan render failed',e); }
  if(live) $('#woResume').onclick=()=>showLive();
  $('#woLib').onclick=()=>openLibrary('browse');
  $('#woNew').onclick=()=>openBuilder(null);
  el.querySelectorAll('[data-start]').forEach(b=>b.onclick=()=>startWorkout(b.dataset.start));
  el.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openBuilder(b.dataset.edit));
}

/* ---------- routine builder ---------- */
let draft=null;
function openBuilder(id){
  const src=id&&state.routines.find(r=>r.id===id);
  draft=src?JSON.parse(JSON.stringify(src)):{id:newId('r'),name:'',exercises:[]};
  drawBuilder(!!src);
}
function drawBuilder(existing){
  const ex=draft.exercises;
  openSheet(`<div class="rv-head"><div class="ttl">${existing?'Edit routine':'New routine'}</div></div>
    <div class="pfield" style="margin:8px 0 12px"><label>Routine name</label><input id="rbN" maxlength="40" placeholder="e.g. Push Day" value="${h(draft.name)}"></div>
    ${ex.map((e,i)=>`<div class="rbx${e.ss?' ss':''}">
      <div class="rbx-h"><b>${h(exName(e.id))}</b>
        <button class="ic" data-up="${i}" ${i?'':'disabled'}>↑</button><button class="ic" data-down="${i}" ${i<ex.length-1?'':'disabled'}>↓</button><button class="ic" data-rm="${i}">✕</button></div>
      <div class="rbx-r">
        <div class="step"><button data-sd="${i}">−</button><span><b>${e.sets}</b> sets</span><button data-si="${i}">＋</button></div>
        <input class="crew-in rbreps" data-reps="${i}" value="${h(e.reps||'')}" placeholder="${unitFor(e.id).startsWith('sec')?'secs':'reps'} e.g. 8-10" maxlength="12">
        <select class="crew-in rbrest" data-rest="${i}">${RESTS.map(s=>`<option value="${s}"${s===(e.rest??90)?' selected':''}>rest ${fmtRest(s)}</option>`).join('')}</select>
      </div>
      <input class="crew-in rbnote" data-note="${i}" value="${h(e.note||'')}" placeholder="Note (seat height, grip, cues…)" maxlength="140">
      ${i<ex.length-1?`<label class="sstog"><input type="checkbox" data-ss="${i}" ${e.ss?'checked':''}> Superset with next</label>`:''}
    </div>`).join('')||'<div class="legend" style="padding:8px 0 12px">No exercises yet.</div>'}
    <button class="dbtn" id="rbAdd" style="width:100%;margin-bottom:10px">＋ Add exercises</button>
    <div class="dbtns"><button class="dbtn" id="rbSave">Save routine</button><button class="dbtn go" id="rbSaveStart">Save &amp; start ▶</button></div>
    ${existing?`<div class="dbtns" style="margin-top:10px"><button class="dbtn" id="rbDup">Duplicate</button><button class="dbtn" id="rbDel">Delete</button></div>`:''}
    <button class="rv-close" id="rbCancel" style="margin-top:10px">Cancel</button>`);
  const S=$('#woSheet');
  const sync=()=>{ draft.name=$('#rbN').value;
    S.querySelectorAll('[data-reps]').forEach(x=>ex[+x.dataset.reps].reps=x.value.trim());
    S.querySelectorAll('[data-rest]').forEach(x=>ex[+x.dataset.rest].rest=+x.value);
    S.querySelectorAll('[data-note]').forEach(x=>ex[+x.dataset.note].note=x.value.trim());
    S.querySelectorAll('[data-ss]').forEach(x=>ex[+x.dataset.ss].ss=x.checked); };
  const redraw=()=>{ sync(); drawBuilder(existing); };
  S.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>{ sync(); const i=+b.dataset.up; [ex[i-1],ex[i]]=[ex[i],ex[i-1]]; drawBuilder(existing); });
  S.querySelectorAll('[data-down]').forEach(b=>b.onclick=()=>{ sync(); const i=+b.dataset.down; [ex[i+1],ex[i]]=[ex[i],ex[i+1]]; drawBuilder(existing); });
  S.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{ sync(); ex.splice(+b.dataset.rm,1); drawBuilder(existing); });
  S.querySelectorAll('[data-sd]').forEach(b=>b.onclick=()=>{ sync(); const e=ex[+b.dataset.sd]; e.sets=Math.max(1,e.sets-1); drawBuilder(existing); });
  S.querySelectorAll('[data-si]').forEach(b=>b.onclick=()=>{ sync(); const e=ex[+b.dataset.si]; e.sets=Math.min(12,e.sets+1); drawBuilder(existing); });
  S.querySelectorAll('[data-ss]').forEach(b=>b.onchange=redraw);
  $('#rbAdd').onclick=()=>{ sync(); openLibrary('pick',ids=>{ ids.forEach(id=>ex.push(isYoga(id)?{id,sets:1,reps:'45',rest:0,note:'',ss:false}:{id,sets:3,reps:'',rest:90,note:'',ss:false})); drawBuilder(existing); }); };
  $('#rbCancel').onclick=()=>{ draft=null; closeSheet(); };
  const save=async start=>{
    sync();
    if(!draft.name.trim()){ toast('Name your routine'); return; }
    if(!ex.length){ toast('Add at least one exercise'); return; }
    draft.name=draft.name.trim().slice(0,40);
    const i=state.routines.findIndex(r=>r.id===draft.id);
    if(i>=0) state.routines[i]=draft; else state.routines.push(draft);
    const id=draft.id;
    await persist(); toast('Routine saved'); draft=null; closeSheet(); renderHome();
    if(start) startWorkout(id);
  };
  $('#rbSave').onclick=()=>save(false);
  $('#rbSaveStart').onclick=()=>save(true);
  const dup=$('#rbDup'); if(dup) dup.onclick=async()=>{ sync(); const c=JSON.parse(JSON.stringify(draft)); c.id=newId('r'); c.name=(c.name+' copy').slice(0,40); state.routines.push(c); await persist(); toast('Duplicated'); closeSheet(); renderHome(); };
  const del=$('#rbDel'); if(del) del.onclick=async()=>{ if(!await ask(`Delete routine “${draft.name}”? Logged workouts are kept.`,'Delete',true)) return; state.routines=state.routines.filter(r=>r.id!==draft.id); await persist(); closeSheet(); renderHome(); };
}

/* ================= live workout ================= */
let live=null, tick=null, rest=null, wakeLock=null, audio=null;
function loadLive(){ if(live) return live; try{ const r=localStorage.getItem(liveKey()); if(r){ const p=JSON.parse(r); if(p&&Array.isArray(p.exercises)) live=p; } }catch(e){} return live; }
function saveLive(){ try{ if(live) localStorage.setItem(liveKey(),JSON.stringify(live)); else localStorage.removeItem(liveKey()); }catch(e){} }

function prevSetsFor(id){
  const lg=state.logs.filter(l=>l.ex&&l.ex[id]&&l.ex[id].length).sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:(b.start||0)-(a.start||0))[0];
  return lg?lg.ex[id]:[];
}
function liveEx(id,{sets,reps,rest,note,ss}){
  const prev=prevSetsFor(id); const n=Math.max(1,sets||prev.filter(s=>s.t!=='w').length||3);
  return {id,rest:rest??90,note:note||'',ss:!!ss,target:reps||'',sets:Array.from({length:n},()=>({t:'n',l:'',r:'',rpe:'',done:false}))};
}
/* Put an in-progress workout aside without asking: completed sets are saved to history under
   its own date, anything with no completed sets is dropped, and an unsaved edit is discarded
   (the logged original stays as it was). Returns a message for the toast, or ''. */
async function parkLive(){
  if(!loadLive()) return '';
  const old=live;
  live=null; saveLive(); stopRest();
  if($('#live')){ $('#live').classList.remove('show'); $('#livePill').classList.remove('show'); }
  document.body.classList.remove('live-on');
  if(old.edit) return 'Unsaved edits discarded';
  const {ex,order,notes,variants}=collectSets(old,true);
  if(!order.length) return '';
  const date=/^\d{4}-\d{2}-\d{2}$/.test(old.date)&&old.date<=todayStr()?old.date:todayStr();
  const entry={id:date+'_w'+Date.now().toString(36),date,dayId:old.dayId,name:(old.name||'Workout').slice(0,40),week:weekFromDate(date),ex,order,variants,start:old.start};
  if(Object.keys(notes).length) entry.notes=notes;
  state.logs.push(entry); await persist();
  try{ renderCoach(); renderGamify(); }catch(e){}
  if(window.Social) Social.sync();
  return `Saved your unfinished “${entry.name}” to history`;
}
async function startWorkout(routineId){
  unlockAudio();
  if(!state.routines.some(x=>x.id===routineId)) return;
  const msg=await parkLive(); if(msg) toast(msg);
  const now=Date.now();
  const r=state.routines.find(x=>x.id===routineId); if(!r) return;
  live={name:r.name,dayId:r.id,start:now,date:todayStr(),exercises:r.exercises.map(e=>liveEx(e.id,e))};
  saveLive(); showLive();
}
/* today's planned workout: planned loads/reps become the suggestions ✓ fills in */
async function startPlan(plan){
  unlockAudio();
  const cur=loadLive();
  // today's plan already running → just reopen it
  if(cur&&cur.dayId==='ai'&&cur.date===todayStr()&&!cur.edit&&!cur.past){ showLive(); return; }
  const msg=await parkLive(); if(msg) toast(msg);
  live={name:plan.title,dayId:'ai',start:Date.now(),date:todayStr(),exercises:plan.exercises.map(e=>{
    const w=e.sets.filter(s=>s.t!=='w');
    return {id:e.id,rest:e.rest??90,note:e.note||'',ss:!!e.ss,target:(w[0]||e.sets[0]).reps||'',rpe:(w.find(s=>s.rpe)||{}).rpe||'',
      sets:e.sets.map(s=>({t:s.t||'n',l:'',r:'',rpe:'',done:false,pl:s.load!=null?String(s.load):'',pr:String(s.reps||'').split('-').pop()}))};
  })};
  saveLive(); showLive();
}

function ensureLiveDom(){
  if($('#live')) return;
  const d=document.createElement('div'); d.id='live'; d.className='live';
  d.innerHTML=`<div class="live-top"><button class="hbtn" id="lvMin" aria-label="Minimize">⌄</button>
      <div class="live-ttl" id="lvTtl"></div>
      <button class="mini go" id="lvFinish">Finish</button></div>
    <div class="live-body"><div class="live-stats" id="lvStats"></div><div id="lvList"></div>
      <button class="dbtn" id="lvAdd" style="width:100%;margin:6px 0 10px">＋ Add exercise</button>
      <button class="linkbtn" id="lvDiscard" style="width:100%;color:#B5452F;padding:10px">Discard workout</button></div>
    <div class="restbar" id="restBar"><div class="rb-fill" id="rbFill"></div>
      <button class="mini" id="rbMinus">−15</button><div class="rb-t"><small>Rest</small><b class="mono" id="rbTime">0:00</b></div><button class="mini" id="rbPlus">+15</button><button class="mini go" id="rbSkip">Skip</button></div>`;
  document.body.appendChild(d);
  d.addEventListener('pointerdown',unlockAudio,{passive:true});
  $('#lvMin').onclick=hideLive;
  $('#lvFinish').onclick=finishWorkout;
  $('#lvAdd').onclick=()=>openLibrary('pick',ids=>{ ids.forEach(id=>live.exercises.push(liveEx(id,isYoga(id)?{sets:1,reps:'45',rest:0}:{}))); saveLive(); drawLive(); });
  $('#lvDiscard').onclick=async()=>{ if(!await ask(live.edit?'Discard your changes? The logged workout stays as it was.':'Discard this workout? Nothing from it will be saved.','Discard',true)) return; const ed=live.edit; endLive(); toast(ed?'Changes discarded':'Workout discarded'); };
  $('#rbMinus').onclick=()=>adjRest(-15); $('#rbPlus').onclick=()=>adjRest(15); $('#rbSkip').onclick=()=>stopRest();
  const p=document.createElement('button'); p.id='livePill'; p.className='livepill';
  p.onclick=showLive; document.body.appendChild(p);
}
function showLive(){
  ensureLiveDom(); if(!loadLive()) return;
  $('#live').classList.add('show'); $('#livePill').classList.remove('show');
  document.body.classList.add('live-on');
  drawLive(); startTick();
  try{ if(navigator.wakeLock&&!wakeLock) navigator.wakeLock.request('screen').then(w=>{wakeLock=w; w.addEventListener('release',()=>{wakeLock=null;});}).catch(()=>{}); }catch(e){}
}
function hideLive(){
  $('#live').classList.remove('show'); document.body.classList.remove('live-on');
  if(live) $('#livePill').classList.add('show');
  renderHome();
}
function endLive(){
  live=null; saveLive(); stopRest();
  if($('#live')){ $('#live').classList.remove('show'); $('#livePill').classList.remove('show'); }
  document.body.classList.remove('live-on');
  clearInterval(tick); tick=null;
  try{ if(wakeLock) wakeLock.release(); }catch(e){}
  renderHome();
}
function startTick(){
  if(tick) return;
  tick=setInterval(()=>{
    if(!live){ clearInterval(tick); tick=null; return; }
    const el=clock((Date.now()-live.start)/1000);
    const c=$('#lvClock'); if(c) c.textContent=el;
    document.querySelectorAll('[data-clock]').forEach(x=>x.textContent=el);
    const p=$('#livePill'); if(p&&p.classList.contains('show')) p.innerHTML=`<span class="dotlive"></span>${live.edit?'Editing ':''}${h(live.name)}${live.edit||live.past?'':' · '+el}${rest?` · rest <b>${clock((rest.end-Date.now())/1000)}</b>`:''}<b> ›</b>`;
    drawRest();
  },250);
}

function setLabel(ex,i){
  const s=ex.sets[i]; if(s.t!=='n') return s.t.toUpperCase();
  return String(ex.sets.slice(0,i+1).filter(x=>x.t!=='w').length);
}
function targetText(e){
  if(ALLEX[e.id]&&isProgramDay(live.dayId)){ const [S,mn,mx]=effP(e.id,phaseIdx(weekFromDate(live.date))); return `target ${S} × ${mn===mx?mn:mn+'–'+mx} ${effUnit(e.id)}`; }
  return e.target?`target ${e.sets.filter(s=>s.t!=='w').length} × ${e.target}${measure(e.id).rSuffix}${e.rpe?' @ RPE '+e.rpe:''}`:'';
}
function liveTotals(){
  let sets=0,vol=0; live.exercises.forEach(e=>{ const timed=measure(e.id).timed; e.sets.forEach(s=>{ if(s.done){ sets++; if(!timed) vol+=(+s.l||0)*(+s.r||0); } }); });
  return {sets,vol};
}
function drawStats(){ const t=liveTotals();
  if(live.exercises.length&&live.exercises.every(e=>isYoga(e.id))){
    const held=live.exercises.reduce((a,e)=>a+e.sets.filter(s=>s.done).reduce((b,s)=>b+(+s.r||0),0),0);
    $('#lvStats').innerHTML=`<span><b>${live.exercises.length}</b> poses</span><span><b>${t.sets}</b> hold${t.sets===1?'':'s'} done</span><span><b>${Math.round(held/60)}</b> min held</span>`; return; }
  $('#lvStats').innerHTML=`<span><b>${live.exercises.length}</b> exercise${live.exercises.length===1?'':'s'}</span><span><b>${t.sets}</b> set${t.sets===1?'':'s'} done</span><span><b>${Math.round(t.vol).toLocaleString()}</b> ${unit()}</span>`; }
/* editing a logged workout or logging a past one: name + date instead of a running clock */
function drawTitle(){
  const t=$('#lvTtl'); if(!t) return;
  if(live.edit||live.past){
    t.innerHTML=`<input class="lv-name" id="lvNameIn" maxlength="40" value="${h(live.name)}" aria-label="Workout name"><input class="lv-date" type="date" id="lvDate" max="${todayStr()}" value="${h(live.date)}" aria-label="Workout date">`;
    $('#lvNameIn').oninput=e=>{ live.name=e.target.value; saveLive(); };
    $('#lvDate').onchange=e=>{ if(e.target.value) { live.date=e.target.value; saveLive(); } };
  } else t.innerHTML=`<b id="lvName">${h(live.name)}</b><span class="mono" id="lvClock">${clock((Date.now()-live.start)/1000)}</span>`;
  $('#lvFinish').textContent=live.edit?'Save':'Finish';
  $('#lvDiscard').textContent=live.edit?'Discard changes':'Discard workout';
}
function drawLive(){
  if(!live||!$('#live')) return;
  drawTitle();
  drawStats();
  $('#lvList').innerHTML=live.exercises.map((e,xi)=>{
    const m=measure(e.id), prev=prevSetsFor(e.id);
    // bodyweight/timed moves only get a weight column when you add weight (vest, belt) — auto-on if you have before
    const showLoad=m.load||!!e.addLoad||(m.canAddLoad&&(e.sets.some(s=>+s.l>0||+s.pl>0)||prev.some(x=>+x.l>0)));
    // match warm-ups to last time's warm-ups and working sets to working sets, by position
    const prevFor=i=>{ const w=e.sets[i].t==='w';
      const k=e.sets.slice(0,i).filter(x=>(x.t==='w')===w).length;
      const p=prev.filter(x=>(x.t==='w')===w)[k];
      return p?{l:W(p.l),raw:p.l,r:p.r}:null; };
    const inSS=e.ss||(xi>0&&live.exercises[xi-1].ss);
    return `<div class="lx${inSS?' ss':''}${showLoad?'':' nl'}" data-x="${xi}">
      <div class="lx-h">${inSS?'<span class="sstag">SS</span>':''}<button class="lx-n" data-detail="${h(e.id)}">${poseHTML(exName(e.id))}</button><button class="ic" data-menu="${xi}" aria-label="Exercise options">⋯</button></div>
      <div class="lx-t">${h(targetText(e))}${targetText(e)?' · ':''}rest ${fmtRest(e.rest)}</div>
      ${e.note?`<div class="lx-note">📝 ${h(e.note)}</div>`:''}
      ${modHTML(e.id)}
      <div class="lset lhead"><span>Set</span><span>Previous</span>${showLoad?`<span>${m.load?'':'+'}${unit()}</span>`:''}<span>${m.rLabel}</span><span>RPE</span><span>✓</span></div>
      ${e.sets.map((s,i)=>{ const p=prevFor(i); return `<div class="lset${s.done?' done':''} t-${s.t}" data-s="${xi}|${i}">
        <button class="stype" data-type>${setLabel(e,i)}</button>
        <span class="lprev mono">${p?fmtSet(e.id,{l:p.raw,r:p.r},true):'—'}</span>
        ${showLoad?`<input inputmode="decimal" data-k="l" value="${h(s.l)}" placeholder="${h(W(s.pl)||(p&&p.l)||'')}" data-lb="${h(s.pl||(p&&p.raw)||'')}">`:''}
        <input inputmode="numeric" data-k="r" value="${h(s.r)}" placeholder="${h(s.pr||(p&&p.r)||String(e.target||'').split('-').pop())}">
        <select data-k="rpe">${RPES.map(v=>`<option value="${v}"${String(s.rpe)===v?' selected':''}>${v||'–'}</option>`).join('')}</select>
        <button class="sdone" data-done>✓</button></div>`; }).join('')}
      <div class="lx-f"><button class="linkbtn" data-addset="${xi}">＋ Add set</button>${e.sets.length>1?`<button class="linkbtn" data-rmset="${xi}">− Remove last</button>`:''}</div>
    </div>`;
  }).join('')||'<div class="crew-card crew-empty">Empty workout.<br>Tap <b>Add exercise</b> to begin.</div>';
  const L=$('#lvList');
  L.querySelectorAll('.lset[data-s]').forEach(row=>{
    const [xi,i]=row.dataset.s.split('|').map(Number); const s=live.exercises[xi].sets[i];
    row.querySelectorAll('input,select').forEach(inp=>{
      const ev=inp.tagName==='SELECT'?'change':'input';
      inp.addEventListener(ev,()=>{ s[inp.dataset.k]=inp.value.trim(); saveLive(); if(s.done) drawStats(); });
    });
    row.querySelector('[data-type]').onclick=()=>{ s.t=TYPE_CYCLE[s.t]||'n'; saveLive(); drawLive(); };
    row.querySelector('[data-done]').onclick=()=>toggleDone(xi,i,row);
  });
  L.querySelectorAll('[data-addset]').forEach(b=>b.onclick=()=>{ const e=live.exercises[+b.dataset.addset]; const last=e.sets[e.sets.length-1]||{};
    e.sets.push({t:'n',l:last.l||'',r:'',rpe:'',done:false}); saveLive(); drawLive(); });
  L.querySelectorAll('[data-rmset]').forEach(b=>b.onclick=()=>{ live.exercises[+b.dataset.rmset].sets.pop(); saveLive(); drawLive(); });
  L.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>openExercise(b.dataset.detail));
  L.querySelectorAll('[data-menu]').forEach(b=>b.onclick=()=>exMenu(+b.dataset.menu));
}
function toggleDone(xi,i,row){
  const e=live.exercises[xi], s=e.sets[i];
  if(!s.done){
    // like Hevy: an empty field takes the greyed-out suggestion
    const li=row.querySelector('[data-k="l"]'), ri=row.querySelector('[data-k="r"]');
    if(li&&s.l===''&&li.placeholder){ s.l=li.placeholder; s.lb=li.dataset.lb||''; }
    if(s.r===''&&ri.placeholder) s.r=ri.placeholder;
    if(s.r===''){ const lb=measure(e.id).rLabel; toast('Enter '+(lb==='Sec'?'seconds':lb==='Min'?'minutes':lb.toLowerCase())+' first'); return; }
    s.done=true;
    unlockAudio();
    const chainNext=e.ss&&live.exercises[xi+1];
    if(isYoga(e.id)&&+s.r>0) startRest(+s.r,'hold');   // yoga: ✓ starts the hold countdown
    else if(!chainNext&&e.rest>0) startRest(e.rest);
  } else s.done=false;
  saveLive(); drawLive();
}
function exMenu(xi){
  const e=live.exercises[xi];
  openSheet(`<div class="rv-head"><div class="ttl" style="font-size:19px">${h(exName(e.id))}</div></div>
    <div class="pfield" style="margin:10px 0"><label>Note</label><input id="emNote" maxlength="140" value="${h(e.note)}" placeholder="Seat height, grip, cues…"></div>
    <div class="pfield" style="margin-bottom:10px"><label>Rest timer</label><select id="emRest">${RESTS.map(s=>`<option value="${s}"${s===e.rest?' selected':''}>${fmtRest(s)}</option>`).join('')}</select></div>
    ${xi<live.exercises.length-1?`<label class="sstog" style="margin-bottom:12px"><input type="checkbox" id="emSS" ${e.ss?'checked':''}> Superset with next exercise (rest starts after the last one)</label>`:''}
    ${measure(e.id).canAddLoad?`<label class="sstog" style="margin-bottom:12px"><input type="checkbox" id="emLoad" ${e.addLoad?'checked':''}> Add weight (vest, belt, plate) — shows a +${unit()} column</label>`:''}
    ${['Barbell','Smith'].includes(exInfo(e.id).equip)?'<button class="dbtn" id="emPlates" style="width:100%;margin-bottom:8px">🧮 Plate calculator</button>':''}
    <div class="dbtns"><button class="dbtn" id="emUp" ${xi?'':'disabled'}>↑ Move up</button><button class="dbtn" id="emDown" ${xi<live.exercises.length-1?'':'disabled'}>↓ Move down</button></div>
    <div class="dbtns" style="margin-top:8px"><button class="dbtn" id="emReplace">⇄ Replace</button><button class="dbtn" id="emRemove">Remove</button></div>
    <button class="crew-btn" id="emSave" style="margin-top:12px">Done</button>`);
  const apply=()=>{ e.note=$('#emNote').value.trim(); e.rest=+$('#emRest').value; const ss=$('#emSS'); if(ss) e.ss=ss.checked; const ld=$('#emLoad'); if(ld) e.addLoad=ld.checked; };
  const fin=()=>{ saveLive(); closeSheet(); drawLive(); };
  $('#emSave').onclick=()=>{ apply(); fin(); };
  const pl=$('#emPlates'); if(pl) pl.onclick=()=>{ apply(); saveLive();
    const next=e.sets.find(s=>!s.done&&s.t!=='w')||e.sets[e.sets.length-1]||{};
    openPlates(toLb(next.l)||next.pl||'',exInfo(e.id).equip,()=>exMenu(xi)); };
  $('#emUp').onclick=()=>{ apply(); const a=live.exercises; [a[xi-1],a[xi]]=[a[xi],a[xi-1]]; fin(); };
  $('#emDown').onclick=()=>{ apply(); const a=live.exercises; [a[xi+1],a[xi]]=[a[xi],a[xi+1]]; fin(); };
  $('#emRemove').onclick=async()=>{ if(e.sets.some(s=>s.done)&&!await ask('Remove this exercise and its completed sets?','Remove',true)) return; live.exercises.splice(xi,1); fin(); };
  $('#emReplace').onclick=()=>{ apply(); openLibrary('pick',ids=>{ if(!ids.length) return; const n=liveEx(ids[0],{rest:e.rest,note:e.note,ss:e.ss,sets:e.sets.length}); live.exercises.splice(xi,1,n,...ids.slice(1).map(id=>liveEx(id,{}))); saveLive(); drawLive(); }); };
}

/* ---------- rest timer ---------- */
/* A media-element beep plays even with the iPhone ring/silent switch on (Web Audio is muted by it),
   so the sound is a tiny generated WAV, unlocked on the first tap of a workout. */
let beepEl=null;
function beepURL(){
  const sr=22050, segs=[[0,.16],[.24,.40],[.48,.70]], len=Math.round(sr*.75), buf=new ArrayBuffer(44+len*2), v=new DataView(buf);
  const ws=(o,str)=>{ for(let i=0;i<str.length;i++) v.setUint8(o+i,str.charCodeAt(i)); };
  ws(0,'RIFF'); v.setUint32(4,36+len*2,true); ws(8,'WAVE'); ws(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true); ws(36,'data'); v.setUint32(40,len*2,true);
  for(let i=0;i<len;i++){ const t=i/sr; let a=0;
    segs.forEach(([s0,e0],k)=>{ if(t>=s0&&t<e0){ const env=Math.min(1,(t-s0)/.008,(e0-t)/.02); a=Math.sin(2*Math.PI*(k===2?1175:880)*t)*.7*env; } });
    v.setInt16(44+i*2,Math.max(-1,Math.min(1,a))*32767,true); }
  return URL.createObjectURL(new Blob([buf],{type:'audio/wav'}));
}
function unlockAudio(){
  try{ if(navigator.audioSession) navigator.audioSession.type='playback'; }catch(e){}
  try{ if(!audio){ const C=window.AudioContext||window.webkitAudioContext; if(C) audio=new C(); } if(audio&&audio.state==='suspended') audio.resume(); }catch(e){}
  try{
    if(!beepEl){ beepEl=new Audio(beepURL()); beepEl.preload='auto'; beepEl.setAttribute('playsinline',''); }
    if(!beepEl._ok&&!beepEl._trying){ beepEl._trying=true; beepEl.muted=true;
      const p=beepEl.play(); const done=ok=>{ try{ beepEl.pause(); beepEl.currentTime=0; }catch(e){} beepEl.muted=false; beepEl._ok=ok; beepEl._trying=false; };
      if(p&&p.then) p.then(()=>done(true)).catch(()=>done(false)); else done(true); }
  }catch(e){}
}
function beep(){
  let played=false;
  try{ if(beepEl&&beepEl._ok){ beepEl.currentTime=0; beepEl.volume=1; const p=beepEl.play(); played=true; if(p&&p.catch) p.catch(()=>webBeep()); } }catch(e){ played=false; }
  if(!played) webBeep();
  try{ navigator.vibrate&&navigator.vibrate([200,100,200]); }catch(e){}
}
function webBeep(){
  try{ if(!audio) return; if(audio.state==='suspended') audio.resume();
    [0,0.24,0.48].forEach((t,k)=>{ const o=audio.createOscillator(), g=audio.createGain(); o.frequency.value=k===2?1175:880; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.0001,audio.currentTime+t); g.gain.exponentialRampToValueAtTime(0.35,audio.currentTime+t+0.02); g.gain.exponentialRampToValueAtTime(0.0001,audio.currentTime+t+0.2);
    o.start(audio.currentTime+t); o.stop(audio.currentTime+t+0.22); }); }catch(e){}
}
function startRest(sec,kind){ rest={end:Date.now()+sec*1000,total:sec,kind:kind||'rest'}; drawRest(); }
function adjRest(d){ if(!rest) return; rest.end+=d*1000; rest.total=Math.max(1,rest.total+d); if(rest.end<=Date.now()) stopRest(); else drawRest(); }
function stopRest(){ rest=null; const b=$('#restBar'); if(b) b.classList.remove('show'); }
function drawRest(){
  const b=$('#restBar'); if(!b) return;
  if(!rest){ b.classList.remove('show'); return; }
  const left=(rest.end-Date.now())/1000;
  if(left<=0){ const hold=rest.kind==='hold'; stopRest(); beep(); toast(hold?'Hold done — next pose 🧘':'Rest over — next set 💪'); return; }
  b.classList.add('show');
  const lbl=b.querySelector('.rb-t small'); if(lbl) lbl.textContent=rest.kind==='hold'?'Hold':'Rest';
  $('#rbTime').textContent=clock(Math.ceil(left));
  $('#rbFill').style.width=Math.max(0,Math.min(100,left/rest.total*100))+'%';
}

/* ---------- finish ---------- */
/* live sets → log shape. onlyDone: just ticked sets (parking); otherwise ticked or filled-in */
function collectSets(lv,onlyDone){
  const ex={}, notes={}, order=[], variants={};
  lv.exercises.forEach(e=>{
    const sets=e.sets.filter(s=>s.done||(!onlyDone&&s.r!==''&&s.r!=null)).map(s=>{ const o={l:s.lb&&W(s.lb)===String(s.l)?String(s.lb):toLb(s.l),r:String(s.r||'')}; if(s.t!=='n') o.t=s.t; if(s.rpe) o.rpe=String(s.rpe); return o; });
    if(!sets.length) return;
    if(ex[e.id]) ex[e.id].push(...sets); else { ex[e.id]=sets; order.push(e.id); }
    if(e.note) notes[e.id]=e.note;
    if(ALLEX[e.id]&&swapIdx(e.id)>0) variants[e.id]=currentOpt(e.id).name;
  });
  return {ex,notes,order,variants};
}
async function finishWorkout(){
  const {ex,notes,order,variants}=collectSets(live,false);
  if(!order.length){ toast('Complete at least one set first'); return; }
  const editing=live.edit?state.logs.find(l=>l.id===live.edit):null;
  if(live.edit&&!editing){ toast('That workout no longer exists'); endLive(); return; }
  const pending=live.exercises.reduce((n,e)=>n+e.sets.filter(s=>!s.done&&s.r==='').length,0);
  if(!editing&&pending&&!await ask(`Finish workout? ${pending} empty set${pending>1?'s':''} will be skipped.`,'Finish')) return;
  live.name=(live.name||'').trim().slice(0,40)||'Workout';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(live.date)||live.date>todayStr()){ toast('Pick a date up to today'); return; }
  const date=live.date, program=isProgramDay(live.dayId);
  // ids start with the date; an edit that moves the date keeps the rest of the id
  const id=program?date+'_'+live.dayId:editing?date+editing.id.slice(10):date+'_w'+Date.now().toString(36);
  const existing=state.logs.find(l=>l.id===id&&l!==editing);
  if(existing&&!await ask(`${live.name} is already logged on ${date}. Replace it with this workout?`,'Replace',true)) return;
  if(editing){
    const entry={...editing,id,date,week:weekFromDate(date),ex,order};
    if(Object.keys(notes).length) entry.notes=notes; else delete entry.notes;
    if(!program||live.name!==entryName({dayId:live.dayId})) entry.name=live.name;
    const oldId=editing.id;
    state.logs=state.logs.filter(l=>l!==editing&&l.id!==id); state.logs.push(entry);
    await persist();
    endLive();
    try{ renderCoach(); renderGamify(); renderHome(); }catch(e){ console.error(e); }
    toast('Workout updated');
    if(window.Social) Social.afterEdit(oldId,entry);
    return;
  }
  const stBefore=computeStats(), achBefore=unlockedSet(stBefore);
  const entry={id,date,dayId:live.dayId,week:weekFromDate(date),ex,order,variants,start:live.start};
  if(!live.past) entry.duration=Math.round((Date.now()-live.start)/1000);
  if(!program||live.name!==entryName({dayId:live.dayId})) entry.name=live.name;
  if(Object.keys(notes).length) entry.notes=notes;
  state.logs=state.logs.filter(l=>l.id!==id); state.logs.push(entry);
  await persist();
  const stAfter=computeStats(), achAfter=unlockedSet(stAfter);
  const gain={xp:stAfter.xp-stBefore.xp, levelUp:stAfter.li.level>stBefore.li.level?stAfter.li:null, newAch:ACH.filter(a=>achAfter.has(a.id)&&!achBefore.has(a.id))};
  const wasPlan=live.dayId==='ai';
  endLive();
  if(wasPlan&&window.Planner) await Planner.onFinish(entry);
  try{ renderCoach(); renderGamify(); renderHome(); }catch(e){ console.error(e); }
  showReview(entry,gain);
  if(window.Social) Social.afterSave(entry);
}

/* ---------- boot ---------- */
const scrim=document.createElement('div'); scrim.className='scrim'; scrim.id='woScrim';
scrim.innerHTML='<div class="sheet" id="woSheet"></div>';
scrim.addEventListener('click',e=>{ if(e.target.id==='woScrim') closeSheet(); });
document.body.appendChild(scrim);
/* ================= history: view, edit, delete, log a past date ================= */
const byNewest=(a,b)=>a.date<b.date?1:a.date>b.date?-1:(b.start||0)-(a.start||0);
function logRow(l){
  const sets=Object.values(l.ex).reduce((n,x)=>n+x.length,0), prs=Object.values(prsInEntry(l)).reduce((n,a)=>n+a.length,0);
  return `<button class="hlog" data-log="${h(l.id)}"><span class="hl-d"><b>${prettyDate(l.date).split(' ').slice(1).join(' ')}</b><small>${DAY_ABBR[parseYMD(l.date).getDay()]}</small></span>
    <span class="hl-t"><b>${h(entryName(l))}</b><small>${Object.keys(l.ex).length} exercise${Object.keys(l.ex).length===1?'':'s'} · ${sets} set${sets===1?'':'s'} · ${VOL(sessionVolumeSafe(l.ex)).toLocaleString()} ${unit()}${l.duration>=60?' · '+Math.round(l.duration/60)+' min':''}</small></span>
    ${prs?`<span class="hl-pr">🏅${prs}</span>`:''}<span class="lgo">›</span></button>`;
}
function historyHTML(){
  const logs=[...state.logs].sort(byNewest);
  return `<div class="rhead" style="margin-top:14px"><span>History</span><span><button class="linkbtn" id="hPast">＋ Log past workout</button>${logs.length>5?' <button class="linkbtn" id="hAll">See all</button>':''}</span></div>
    ${logs.length?`<div class="hlist">${logs.slice(0,5).map(logRow).join('')}</div>`:'<div class="legend" style="text-align:left;margin:0 2px 12px">Finished workouts show up here. Tap one to see, edit or delete it.</div>'}`;
}
function wireHistory(el){
  el.querySelectorAll('[data-log]').forEach(b=>b.onclick=()=>openLogged(b.dataset.log));
  const a=el.querySelector('#hAll'); if(a) a.onclick=openAllHistory;
  el.querySelector('#hPast').onclick=openPastForm;
}
function openAllHistory(){
  const logs=[...state.logs].sort(byNewest); let html='', month='';
  logs.forEach(l=>{ const m=MON[+l.date.slice(5,7)-1]+' '+l.date.slice(0,4); if(m!==month){ month=m; html+=`<div class="achead" style="margin:12px 2px 6px">${m}</div>`; } html+=logRow(l); });
  openSheet(`<div class="rv-head"><div class="ttl">History</div><div class="dt">${logs.length} workouts</div></div><div class="hlist">${html}</div>
    <button class="rv-close" id="haClose" style="margin-top:12px">Done</button>`);
  $('#woSheet').querySelectorAll('[data-log]').forEach(b=>b.onclick=()=>openLogged(b.dataset.log,openAllHistory));
  $('#haClose').onclick=()=>closeSheet();
}
function openLogged(id,back){
  const l=state.logs.find(x=>x.id===id); if(!l){ toast('That workout no longer exists'); return; }
  const prs=prsInEntry(l), order=(l.order&&l.order.length?l.order:Object.keys(l.ex)).filter(x=>l.ex[x]);
  const FEEL={easy:'Easy 😴',right:'Just right 💪',hard:'Hard 🥵',brutal:'Brutal 🆘'};
  openSheet(`<div class="rv-head"><div class="ttl" style="font-size:21px">${h(entryName(l))}</div><div class="dt">${prettyDate(l.date)}</div></div>
    <div class="rv-sub">${[l.duration>=60?Math.round(l.duration/60)+' min':'',Object.values(l.ex).reduce((n,x)=>n+x.length,0)+' sets',VOL(sessionVolumeSafe(l.ex)).toLocaleString()+' '+unit(),l.feel?FEEL[l.feel]:''].filter(Boolean).join(' · ')}</div>
    ${order.map(x=>`<div class="hrow"><div class="hd"><b>${h(exName(x,l))}</b>${prs[x]?`<small style="color:#A87410">🏅 ${h(prs[x].map(p=>p.label).join(' · '))}</small>`:''}${l.notes&&l.notes[x]?`<small>📝 ${h(l.notes[x])}</small>`:''}</div><div class="hs mono">${l.ex[x].map(st=>fmtSet(x,st)).join('  ')}</div></div>`).join('')}
    <div class="dbtns" style="margin-top:14px"><button class="dbtn" id="lgEdit">✎ Edit</button><button class="dbtn" id="lgDel">🗑 Delete</button></div>
    <button class="rv-close" id="lgBack" style="margin-top:10px">${back?'Back':'Done'}</button>`);
  $('#lgBack').onclick=()=>back?back():closeSheet();
  $('#lgEdit').onclick=()=>{ closeSheet(); editWorkout(id); };
  $('#lgDel').onclick=async()=>{
    if(!await ask(`Delete ${entryName(l)} on ${prettyDate(l.date)}? This removes its sets, PRs and XP. It can’t be undone (unless you have a backup).`,'Delete',true)) return;
    state.logs=state.logs.filter(x=>x.id!==id);
    await persist(); closeSheet();
    try{ renderCoach(); renderGamify(); renderHome(); }catch(e){ console.error(e); }
    toast('Workout deleted');
    if(window.Social) Social.afterDelete(id);
  };
}
async function editWorkout(id){
  const l=state.logs.find(x=>x.id===id); if(!l) return;
  const msg=await parkLive(); if(msg) toast(msg);
  const order=(l.order&&l.order.length?l.order:Object.keys(l.ex)).filter(x=>l.ex[x]);
  live={name:entryName(l),dayId:l.dayId,start:l.start||Date.now(),date:l.date,edit:l.id,
    exercises:order.map(x=>({id:x,rest:90,note:(l.notes&&l.notes[x])||'',ss:false,target:'',
      sets:l.ex[x].map(s=>({t:s.t||'n',l:W(s.l),lb:s.l,r:s.r||'',rpe:s.rpe||'',done:true}))}))};
  saveLive(); showLive();
}
function openPastForm(){
  openSheet(`<div class="rv-head"><div class="ttl">Log a past workout</div></div>
    <div class="pfield" style="margin:10px 0 8px"><label>Date</label><input type="date" id="pdDate" max="${todayStr()}" value="${addDays(todayStr(),-1)}"></div>
    <div class="pfield" style="margin-bottom:12px"><label>Start from</label><select id="pdFrom"><option value="">Empty — pick exercises</option>${state.routines.map(r=>`<option value="${h(r.id)}">${h(r.name)}</option>`).join('')}</select></div>
    <button class="crew-btn" id="pdGo">Continue</button>
    <button class="rv-close" id="pdCancel" style="margin-top:8px">Cancel</button>`);
  $('#pdCancel').onclick=()=>closeSheet();
  $('#pdGo').onclick=async()=>{
    const date=$('#pdDate').value, rid=$('#pdFrom').value;
    if(!date||date>todayStr()){ toast('Pick a date up to today'); return; }
    const msg=await parkLive(); if(msg) toast(msg);
    const r=rid&&state.routines.find(x=>x.id===rid);
    live={name:r?r.name:'Workout',dayId:r?r.id:'free',start:Date.now(),date,past:true,exercises:r?r.exercises.map(e=>liveEx(e.id,e)):[]};
    closeSheet(); saveLive(); showLive();
    if(!r) openLibrary('pick',ids=>{ ids.forEach(x=>live.exercises.push(liveEx(x,{}))); saveLive(); drawLive(); });
  };
}

/* ================= plate calculator ================= */
function openPlates(targetLb,equip,back){
  const kg=unit()==='kg';
  const bars=kg?[['20','Olympic bar 20 kg'],['15','Women’s bar 15 kg'],['10','Technique bar 10 kg'],['7','Smith (approx) 7 kg'],['0','No bar']]
               :[['45','Olympic bar 45 lb'],['35','Women’s bar 35 lb'],['25','EZ bar 25 lb'],['15','Smith (approx) 15 lb'],['0','No bar']];
  const plates=kg?[25,20,15,10,5,2.5,1.25]:[45,35,25,10,5,2.5];
  const COL={45:'#D9487A',25:'#D9487A',35:'#C9A227',20:'#2E9BD6',15:'#C9A227',10:'#5FB56E',5:'#697585',2.5:'#9AA6B4',1.25:'#BFC7D1'};
  let bar=equip==='Smith'?bars[3][0]:bars[0][0];
  const draw=()=>{
    const target=+$('#ptW').value||0, b=+bar, per=(target-b)/2;
    let out='';
    if(target&&per<0) out='<div class="legend">That’s lighter than the bar.</div>';
    else if(target){
      let rest=per; const used=[];
      plates.forEach(p=>{ while(rest>=p-1e-9){ used.push(p); rest=Math.round((rest-p)*1000)/1000; } });
      const total=b+2*(per-rest);
      out=`<div class="pviz"><span class="pbar"></span>${used.map(p=>`<span class="pl" style="height:${30+p/(kg?25:45)*70}px;background:${COL[p]||'#697585'}">${p}</span>`).join('')}</div>
        <div class="ptxt">${used.length?'Each side: <b>'+Object.entries(used.reduce((m,p)=>(m[p]=(m[p]||0)+1,m),{})).sort((a,c)=>c[0]-a[0]).map(([p,n])=>n+' × '+p).join(', ')+'</b>':'Just the bar'}</div>
        ${rest>0?`<div class="legend">Closest you can load: <b>${total} ${unit()}</b> (${Math.round(rest*2*100)/100} ${unit()} short)</div>`:''}`;
    }
    $('#ptOut').innerHTML=out;
  };
  openSheet(`<div class="rv-head"><div class="ttl">Plate calculator</div></div>
    <div class="pf" style="margin-top:10px">
      <div class="pfield"><label>Target (${unit()})</label><input id="ptW" inputmode="decimal" value="${h(W(targetLb))}" placeholder="e.g. ${kg?'60':'135'}"></div>
      <div class="pfield"><label>Bar</label><select id="ptB">${bars.map(([v,l])=>`<option value="${v}"${v===bar?' selected':''}>${l}</option>`).join('')}</select></div>
    </div>
    <div id="ptOut" class="ptout"></div>
    <button class="rv-close" id="ptBack" style="margin-top:12px">${back?'Back':'Done'}</button>`);
  $('#ptW').oninput=draw; $('#ptB').onchange=e=>{ bar=e.target.value; draw(); };
  $('#ptBack').onclick=()=>back?back():closeSheet();
  draw();
}

function modsOf(id){ try{ return window.Planner&&Planner.modsFor?Planner.modsFor(id):[]; }catch(e){ return []; } }
function modHTML(id,big){ const ms=modsOf(id); if(!ms.length) return '';
  return ms.map(m=>`<div class="modbox${big?' big':''}"><div class="modh"><span class="modic">⚠︎</span><b>Modify${m.why?' · '+h(m.why):''}: ${h(m.t)}</b></div>
    <div class="modhow">${h(m.how)}</div><a class="modvid" href="${h(Planner.modVideo(m,id))}" target="_blank" rel="noopener">▶ Watch the modified version</a></div>`).join(''); }
window.Workout={fmtSet,measure,renderHome,prsInEntry,recordsFor,bests,openExercise,openLibrary,exInfo,allExercises,startWorkout,startPlan,openLogged,openPlates};
Promise.resolve(window.appReady).catch(()=>{}).then(async()=>{
  const cur=loadLive();
  if(cur&&!cur.edit&&!cur.past&&cur.date<todayStr()){ const msg=await parkLive(); if(msg) toast(msg); }
  renderHome();
  if(loadLive()){ ensureLiveDom(); $('#livePill').classList.add('show'); startTick(); }
});
})();

