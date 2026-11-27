/* js/progress.js */
/* ================= Progress: extra Stats sections =================
   Workout calendar, recent PRs, muscle distribution, body measurements.
   Appended to the Stats tab by renderStats() via Progress.augment(). */
(function(){
const h=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MEASURES=[['weight','Bodyweight'],['bodyFat','Body fat'],['waist','Waist'],['chest','Chest'],['arms','Arms'],['thighs','Thighs']];
/* stored as lb / inches / %; shown and typed in the chosen unit (kg / cm when metric) */
const CM_PER_IN=2.54;
const mUnit=k=>k==='bodyFat'?'%':k==='weight'?unit():unit()==='kg'?'cm':'in';
const mShow=(k,v)=>v==null||v===''?'':k==='weight'?+W(v):k==='bodyFat'?+v:unit()==='kg'?Math.round(v*CM_PER_IN*10)/10:+v;
const mStore=(k,v)=>k==='weight'?+toLb(v):k==='bodyFat'?v:unit()==='kg'?Math.round(v/CM_PER_IN*100)/100:v;
let calMonth='', calDay='', mMetric='weight', muscleDays=30;

/* every PR in the log, oldest → newest */
function allPRs(){
  const out=[];
  [...state.logs].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:(a.start||0)-(b.start||0)).forEach(l=>{
    const prs=Workout.prsInEntry(l);
    Object.entries(prs).forEach(([id,list])=>list.forEach(p=>out.push({date:l.date,id,label:p.label})));
  });
  return out;
}

function calendarHTML(){
  if(!calMonth) calMonth=todayStr().slice(0,7);
  const [y,m]=calMonth.split('-').map(Number);
  const lead=(new Date(y,m-1,1).getDay()+6)%7, days=new Date(y,m,0).getDate();
  const byDate={}; state.logs.forEach(l=>{ (byDate[l.date]=byDate[l.date]||[]).push(l); });
  let n=0, grid='<div class="cal">'+['Mo','Tu','We','Th','Fr','Sa','Su'].map(d=>`<div class="cdow">${d}</div>`).join('');
  for(let i=0;i<lead;i++) grid+='<div class="ccell empty"></div>';
  for(let d=1;d<=days;d++){
    const dt=ymd(new Date(y,m-1,d)); const logs=byDate[dt]||[]; if(logs.length) n++;
    const mob=state.mobility&&state.mobility[dt];
    grid+=`<div class="ccell tap${dt===todayStr()?' today':''}${dt>todayStr()?' fut':''}${logs.length?' both':''}${dt===calDay?' picked':''}" data-day="${dt}"><span>${d}</span><div class="cdots">${logs.map(()=>'<i style="background:#2B4BFF"></i>').join('')}${mob?'<i style="background:#16A05A"></i>':''}</div></div>`;
  }
  grid+='</div>';
  const sel=calDay&&byDate[calDay]?byDate[calDay].map(l=>{
    const vol=sessionVolumeSafe(l.ex), sets=Object.values(l.ex).reduce((a,x)=>a+x.length,0);
    return `<div class="hrow tap" data-log="${h(l.id)}"><div class="hd"><b>${h(entryName(l))}</b><small>${sets} sets · ${VOL(vol).toLocaleString()} ${unit()}${l.duration>=60?' · '+Math.round(l.duration/60)+' min':''}</small></div>
      <div class="hs">${(l.order&&l.order.length?l.order:Object.keys(l.ex)).filter(id=>l.ex[id]).map(id=>h(exName(id,l))).join(' · ')}</div></div>`; }).join(''):'';
  return `<div class="ana-sec"><div class="ana-h">Workout calendar</div>
    <div class="calnav"><button class="mini" data-cal="-1">‹</button><b>${MON[m-1]} ${y} · ${n} workout${n===1?'':'s'}</b><button class="mini" data-cal="1">›</button></div>
    <div class="chartbox" style="padding:10px">${grid}<div class="legend">blue = workout · green = mobility · tap a day for details</div></div>
    ${sel?`<div style="margin-top:8px">${sel}</div>`:''}</div>`;
}

function prsHTML(){
  const prs=allPRs().reverse().slice(0,10);
  return `<div class="ana-sec"><div class="ana-h">Recent personal records</div>${prs.length?prs.map(p=>
    `<div class="prrow tap" data-ex="${h(p.id)}"><span class="rank">🏅</span><span class="pn">${h(exName(p.id))}<small style="display:block;color:var(--muted);font-size:11px">${prettyDate(p.date)}</small></span><span class="pv">${h(p.label)}</span></div>`).join('')
    :'<div class="legend">Beat a previous best on any lift and it shows up here.</div>'}
    <button class="dbtn" id="pgLib" style="width:100%;margin-top:6px">📚 All exercises &amp; records</button></div>`;
}

function muscleHTML(){
  const cut=addDays(todayStr(),-(muscleDays-1)); const m={};
  state.logs.filter(l=>l.date>=cut).forEach(l=>Object.entries(l.ex).forEach(([id,sets])=>{
    const info=Workout.exInfo(id); const n=working(sets).length;
    m[info.muscle]=(m[info.muscle]||0)+n;
    (info.secondary||[]).forEach(s=>{ m[s]=(m[s]||0)+n*0.5; });   // secondary muscles count half
  }));
  const rows=MUSCLES.map(k=>[k,Math.round((m[k]||0)*10)/10]).filter(r=>r[1]>0).sort((a,b)=>b[1]-a[1]);
  const mx=Math.max(1,...rows.map(r=>r[1]));
  return `<div class="ana-sec"><div class="ana-h" style="display:flex;justify-content:space-between">Muscle distribution
      <span class="seg mini2">${[7,30,90].map(d=>`<button data-md="${d}" class="${d===muscleDays?'on':''}">${d}d</button>`).join('')}</span></div>
    <div class="chartbox">${rows.length?rows.map(([k,v])=>`<div class="mbar"><span class="mk">${k}</span><span class="mt"><i style="width:${v/mx*100}%"></i></span><span class="mv mono">${v}</span></div>`).join('')
      :'<div class="legend">No sets in this window.</div>'}
    <div class="legend">working sets per muscle · secondary muscles count ½</div></div></div>`;
}

function measuresHTML(){
  const ms=[...state.measurements].sort((a,b)=>a.date<b.date?-1:1);
  const ciW0=(state.checkins||[]).filter(c=>c.weight).map(c=>({date:c.date,weight:c.weight}));
  const hw=(window.HealthSync?HealthSync.weights():[]).filter(x=>!ciW0.some(c=>c.date===x.date)&&!ms.some(m=>m.date===x.date&&m.weight));
  const ciW=[...ciW0,...hw];
  const pts=(mMetric==='weight'?[...ms.filter(x=>x.weight),...ciW]:ms.filter(x=>x[mMetric])).sort((a,b)=>a.date<b.date?-1:1);
  const label=MEASURES.find(x=>x[0]===mMetric)[1], mu=mUnit(mMetric);
  const latest=ms[ms.length-1]||{};
  return `${window.HealthSync?HealthSync.statsHTML():''}<div class="ana-sec"><div class="ana-h">Body measurements</div>
    <div class="chartbox">
      <div class="pf">${MEASURES.map(([k,l])=>`<div class="pfield"><label>${l} (${mUnit(k)})</label><input inputmode="decimal" data-ms="${k}" placeholder="${latest[k]!=null?h(mShow(k,latest[k])):'—'}"></div>`).join('')}</div>
      <button class="mobbtn" id="msSave" style="margin:4px 0 12px;height:46px">Log today’s measurements</button>
      <select class="progsel" id="msMetric">${MEASURES.map(([k,l])=>`<option value="${k}"${k===mMetric?' selected':''}>${l}</option>`).join('')}</select>
      ${pts.length>=2?lineChart(pts.map(p=>mShow(mMetric,p[mMetric])),pts.map(p=>p.date),{color:'#111111'})+`<div class="legend">${label} (${mu}) · ${pts.length} entries${mMetric==='weight'?(hw.length?' incl. check-ins & Apple Health':' incl. weekly check-ins'):''}</div>`
        :`<div class="legend">Log ${label.toLowerCase()} twice to see a trend.</div>`}
      ${ms.slice(-4).reverse().map(x=>`<div class="hrow"><div class="hd"><b>${prettyDate(x.date)}</b></div><div class="hs">${MEASURES.filter(([k])=>x[k]!=null).map(([k,l])=>`${l} ${mShow(k,x[k])}${mUnit(k)}`).join(' · ')}</div><button class="linkbtn" data-msdel="${h(x.date)}">✕</button></div>`).join('')}
    </div></div>`;
}

function augment(){
  const body=$('#statsBody'); if(!body||!window.Workout) return;
  const box=document.createElement('div'); box.id='pgBox';
  box.innerHTML=calendarHTML()+prsHTML()+muscleHTML()+measuresHTML();
  // place the new sections right after the headline stat tiles
  const after=body.querySelector('#mobBtn');
  after?after.after(box):body.prepend(box);
  wire(box);
}
function redraw(){ const old=$('#pgBox'); if(!old) return; const box=document.createElement('div'); box.id='pgBox';
  box.innerHTML=calendarHTML()+prsHTML()+muscleHTML()+measuresHTML(); old.replaceWith(box); wire(box); }
function wire(box){
  box.querySelectorAll('[data-cal]').forEach(b=>b.onclick=()=>{ const [y,m]=calMonth.split('-').map(Number); calMonth=ymd(new Date(y,m-1+(+b.dataset.cal),1)).slice(0,7); calDay=''; redraw(); });
  box.querySelectorAll('[data-day]').forEach(c=>c.onclick=()=>{ calDay=calDay===c.dataset.day?'':c.dataset.day; redraw(); });
  box.querySelectorAll('[data-ex]').forEach(r=>r.onclick=()=>Workout.openExercise(r.dataset.ex));
  box.querySelectorAll('[data-log]').forEach(r=>r.onclick=()=>Workout.openLogged(r.dataset.log));
  box.querySelectorAll('[data-md]').forEach(b=>b.onclick=()=>{ muscleDays=+b.dataset.md; redraw(); });
  $('#pgLib').onclick=()=>Workout.openLibrary('browse');
  $('#msMetric').onchange=e=>{ mMetric=e.target.value; redraw(); };
  $('#msSave').onclick=async()=>{
    const rec={date:todayStr()}; let any=false;
    box.querySelectorAll('[data-ms]').forEach(i=>{ const v=parseFloat(i.value); if(Number.isFinite(v)&&v>0){ rec[i.dataset.ms]=mStore(i.dataset.ms,v); any=true; } });
    if(!any){ toast('Enter at least one measurement'); return; }
    const cur=state.measurements.find(x=>x.date===rec.date);
    if(cur) Object.assign(cur,rec); else state.measurements.push(rec);
    await persist(); toast('Measurements logged 📏'); redraw();
  };
  box.querySelectorAll('[data-msdel]').forEach(b=>b.onclick=async()=>{
    if(!await ask('Delete measurements for '+b.dataset.msdel+'?','Delete',true)) return;
    state.measurements=state.measurements.filter(x=>x.date!==b.dataset.msdel); await persist(); redraw();
  });
}
window.Progress={augment};
})();

