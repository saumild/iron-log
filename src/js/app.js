/* js/app.js */
/* ---------- storage ----------
   Tiers, each verified with a real write→read→delete probe at boot:
     1. Claude artifact storage (running inside Claude)
     2. localStorage           (served over http(s):// or a local file on Android)
     3. IndexedDB              (works in some contexts where localStorage is blocked)
     4. in-memory              (NOT persistent — the app warns loudly)              */
const KEY='ironlog-v1';          /* NEVER change: this is where the user's data lives */
const RESCUE_KEY='ironlog-rescue'; /* pre-migration snapshot, auto-kept */
/* per-user in Claude: a device-wide copy could hand one person's history to another */
const rescueKey=()=>HOSTED?'':RESCUE_KEY;   // in Claude: no plaintext copy on the device; the account keeps an encrypted backup
const SCHEMA=2;
const PROBE=KEY+'__probe';
let storageMode='memory';
const _mem={};

/* minimal IndexedDB key/value wrapper */
function idbOpen(){
  return new Promise((res,rej)=>{
    if(!window.indexedDB || typeof window.indexedDB.open!=='function') return rej(new Error('no idb'));
    const rq=indexedDB.open('ironlog',1);
    rq.onupgradeneeded=()=>{ rq.result.createObjectStore('kv'); };
    rq.onsuccess=()=>res(rq.result);
    rq.onerror=()=>rej(rq.error||new Error('idb open failed'));
  });
}
function idbReq(mode,fn){
  return idbOpen().then(db=>new Promise((res,rej)=>{
    const tx=db.transaction('kv',mode); const st=tx.objectStore('kv'); const r=fn(st);
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
  }));
}
const idb={
  get:k=>idbReq('readonly',st=>st.get(k)),
  set:(k,v)=>idbReq('readwrite',st=>st.put(v,k)),
  del:k=>idbReq('readwrite',st=>st.delete(k)),
};

async function probeClaude(){
  if(!window.storage) throw new Error('no claude storage');
  await window.storage.set(PROBE,'1',false);
  const r=await window.storage.get(PROBE,false);
  if(!r||r.value!=='1') throw new Error('claude storage unverified');
  try{ await window.storage.delete(PROBE,false); }catch(e){}
}
async function probeLocal(){
  window.localStorage.setItem(PROBE,'1');
  if(window.localStorage.getItem(PROBE)!=='1') throw new Error('ls unverified');
  window.localStorage.removeItem(PROBE);
}
async function probeIdb(){
  await idb.set(PROBE,'1');
  const v=await idb.get(PROBE);
  if(v!=='1') throw new Error('idb unverified');
  await idb.del(PROBE);
}
/* ===== SINGLE-PRIMARY STORAGE =====
   Exactly ONE tier is the source of truth (best durable available).
   Other tiers are read once at boot only to ADOPT legacy data, never written again.
   Two hard safety gates:
     1. bootLoaded — nothing may write before load() has finished reading.
     2. non-destructive writes — an empty state can never overwrite real data
        (only an explicit user restore may, via forceWrite). */
let primaryTier=null;      // 'local' | 'idb' | 'claude' | null
let legacyTiers=[];        // readable tiers that are not primary (adoption only)
let bootLoaded=false;      // gate: no writes until load() completes
/* Running as a Claude artifact (claude.ai viewer): browser storage there can come back empty,
   so the durable copy lives in the viewer's own private `db` subtree, chunked under the
   256 KiB document limit. Everywhere else (the Netlify site, local dev) this tier never probes. */
const HOSTED=typeof window!=='undefined'&&!!(window.claude&&typeof window.claude.use==='function');
const CDB_CHUNK=100000;                 // chars per document; JSON escaping + UTF-8 stay under 256 KiB
let cdb=null, cuid=null, cdbChain=Promise.resolve();
async function probeCdb(){
  if(!HOSTED) throw new Error('not hosted');
  const [db,user]=await Promise.all([window.claude.use('db'),window.claude.use('user')]);
  if(!db||!user) throw new Error('db unavailable');
  const id=await user.id(); if(!id) throw new Error('signed out');
  cdb=db; cuid=id;
}
const cdbDoc=name=>cdb.collection('data/users/'+cuid).doc(name);
async function cdbRead(){
  const m=await cdbDoc('state').get(); if(!m.exists) return null;
  const n=+(m.data().chunks)||0; let out='';
  for(let i=0;i<n;i++){ const c=await cdbDoc('state-'+i).get(); if(!c.exists) return null; out+=String(c.data().s||''); }
  return out;
}
function cdbWrite(v){
  // one write at a time per document: queue saves; chunks first, then the manifest that names them
  const run=cdbChain.then(async()=>{
    const parts=[]; for(let i=0;i<v.length;i+=CDB_CHUNK) parts.push(v.slice(i,i+CDB_CHUNK));
    for(let i=0;i<parts.length;i++) await cdbDoc('state-'+i).set({s:parts[i]});
    await cdbDoc('state').set({chunks:parts.length,savedAt:new Date().toISOString()});
  });
  cdbChain=run.catch(()=>{});
  return run;
}
let deviceTiers=[];   // HOSTED: device stores found, offered for import only with the user's say-so
async function initStore(){
  primaryTier=null; legacyTiers=[]; deviceTiers=[];
  if(HOSTED){
    /* History belongs to the signed-in Claude user and lives only under data/users/<their id>.
       Device storage is shared by everyone who opens Iron Log in this browser, so it is never
       read as history, never used as a fallback and never copied into an account automatically. */
    if(window.IronAuth&&IronAuth.acct) primaryTier='ila';   // the signed-in Iron Log account, encrypted
    try{ await probeCdb(); }catch(e){}                        // the Claude account's own copy: offered for import only
    for(const [mode,probe] of [['local',probeLocal],['idb',probeIdb],['claude',probeClaude]]){ try{ await probe(); deviceTiers.push(mode); }catch(e){} }
    storageMode=primaryTier||'memory';
    return storageMode;
  }
  for(const [mode,probe] of [['cdb',probeCdb],['local',probeLocal],['idb',probeIdb],['claude',probeClaude]]){
    try{ await probe(); if(!primaryTier) primaryTier=mode; else legacyTiers.push(mode); }catch(e){}
  }
  storageMode=primaryTier||'memory';
  return storageMode;
}
async function readTier(mode){
  try{
    if(mode==='ila')    return await IronAuth.readState();
    if(mode==='cdb')    return await cdbRead();
    if(mode==='local')  return window.localStorage.getItem(KEY);
    if(mode==='idb')    { const v=await idb.get(KEY); return v==null?null:v; }
    if(mode==='claude') { const r=await window.storage.get(KEY,false); return r?r.value:null; }
  }catch(e){}
  return null;
}
async function writeTier(mode,v){
  if(mode==='ila')    { await IronAuth.writeState(v); return; }
  if(mode==='cdb')    { await cdbWrite(v); return; }
  if(mode==='local')  { window.localStorage.setItem(KEY,v); return; }
  if(mode==='idb')    { await idb.set(KEY,v); return; }
  if(mode==='claude') { await window.storage.set(KEY,v,false); return; }
  throw new Error('no storage tier');
}
function snapInfo(raw){
  try{ const p=JSON.parse(raw); if(!p||typeof p!=='object') return null;
       return {data:p, n:(p.logs||[]).length, at:+new Date(p.savedAt||0)||0, raw}; }
  catch(e){ return null; }
}
/* Read the primary. If it's missing or EMPTY, do a one-time adoption scan of
   legacy tiers and take the best snapshot: real data always beats empty,
   then newest, then most sessions. Adopted data is written to primary once. */
async function readRaw(){
  if(!primaryTier) return (KEY in _mem)?_mem[KEY]:null;
  const prim=snapInfo(await readTier(primaryTier));
  let best=prim;
  if(!prim || prim.n===0){
    for(const m of legacyTiers){
      const s=snapInfo(await readTier(m));
      if(!s) continue;
      if(!best || (s.n>0&&best.n===0) || (s.n>0===best.n>0 && (s.at>best.at || (s.at===best.at&&s.n>best.n)))) best=s;
    }
    if(best && best!==prim){ try{ await writeTier(primaryTier,best.raw); }catch(e){} }
  }
  return best?best.raw:null;
}
/* Writes go to the PRIMARY only. Destructive-write guard: refuse to replace
   real data with an empty state unless the user explicitly restored. */
let forceWrite=false;
async function writeRaw(v){
  if(!bootLoaded && !forceWrite) return;                 // gate 1: never write before load
  const incoming=snapInfo(v);
  if(!forceWrite && incoming && incoming.n===0 && primaryTier){
    const cur=snapInfo(await readTier(primaryTier));
    if(cur && cur.n>0){ console.warn('blocked destructive write: empty over',cur.n,'sessions'); return; }
  }                                                       // gate 2: no silent wipes
  _mem[KEY]=v;
  if(primaryTier) await writeTier(primaryTier,v);
}
const STORAGE_OK=()=> !!primaryTier;
const FRAGILE=()=> primaryTier==='claude';
const MODE_LABEL={ila:'your Iron Log account (encrypted)',cdb:'your Claude account',claude:'Claude storage',local:'this browser',idb:'IndexedDB',memory:'memory only'};
const TIERS_LABEL=()=> primaryTier? MODE_LABEL[primaryTier] : 'memory only (NOT saved)';

/* ---------- program data ---------- */
const F = q => 'https://www.youtube.com/results?search_query='+q+'+proper+form';
// phases: [sets, minReps, maxReps] for P1, P2, P3
const PROGRAM = {
  phases:[
    {name:'Reintroduction', rpe:'RPE 6–7 · leave reps in the tank'},
    {name:'Build',          rpe:'RPE 7–8 · 2–3 reps in reserve'},
    {name:'Progress',       rpe:'RPE 8–9 · push close to the limit'},
  ],
  days:[
    {id:'ua', name:'Upper A', theme:'Strength bias',
     main:[
      {id:'db_bench', name:'Dumbbell Bench Press', f:F('dumbbell+bench+press'), p:[[3,6,8],[4,5,7],[4,4,6]]},
      {id:'db_row', name:'One-Arm Dumbbell Row', f:F('one+arm+dumbbell+row'), p:[[3,6,8],[4,6,8],[4,5,7]]},
      {id:'db_ohp', name:'Seated Dumbbell Shoulder Press', f:F('seated+dumbbell+shoulder+press'), p:[[2,8,10],[3,6,8],[3,6,8]]},
      {id:'latpd', name:'Lat Pulldown', f:F('lat+pulldown'), p:[[2,10,12],[3,8,10],[3,8,10]]},
      {id:'inc_curl', name:'Incline Dumbbell Curl', f:F('incline+dumbbell+curl'), p:[[2,10,12],[3,10,12],[3,10,12]]},
      {id:'tri_push', name:'Cable Triceps Pushdown', f:F('cable+triceps+pushdown'), p:[[2,10,12],[3,10,12],[3,10,12]]},
     ],
     core:[
      {id:'woodchop', name:'Cable Woodchopper', tag:'Rotation', unit:'/side', f:F('cable+woodchopper'), p:[[2,10,10],[3,10,10],[3,8,8]]},
      {id:'pallof', name:'Half-Kneeling Pallof Press', tag:'Anti-rotation', unit:'/side', f:F('half+kneeling+pallof+press'), p:[[2,10,10],[3,12,12],[3,12,12]]},
      {id:'abwheel', name:'Ab Wheel Rollout', tag:'Anti-extension', f:F('ab+wheel+rollout'), p:[[2,8,8],[3,10,10],[3,12,12]]},
     ]},
    {id:'la', name:'Lower A', theme:'Squat bias',
     main:[
      {id:'goblet', name:'Smith Machine Squat', f:F('smith+machine+squat'), p:[[3,8,10],[4,6,8],[4,5,7]]},
      {id:'db_rdl', name:'Dumbbell Romanian Deadlift', f:F('dumbbell+romanian+deadlift'), p:[[3,8,10],[3,6,8],[4,6,8]]},
      {id:'legpress', name:'Leg Press', f:F('leg+press'), p:[[2,10,12],[3,10,12],[3,8,10]]},
      {id:'legcurl', name:'Seated Leg Curl', f:F('seated+leg+curl'), p:[[2,10,12],[3,10,12],[3,10,12]]},
      {id:'calf_st', name:'Smith Standing Calf Raise', f:F('smith+machine+calf+raise'), p:[[3,12,15],[3,12,15],[4,12,15]]},
     ],
     core:[
      {id:'carry', name:'Suitcase Carry', tag:'Anti-lateral flexion', unit:'m/side', f:F('dumbbell+suitcase+carry'), p:[[2,20,20],[3,20,20],[3,25,25]]},
      {id:'hlr', name:'Hanging Leg Raise', tag:'Flexion', f:F('hanging+leg+raise'), p:[[2,10,12],[3,10,15],[3,12,15]]},
      {id:'deadbug', name:'Dead Bug', tag:'Anti-extension', unit:'/side', f:F('dead+bug+exercise'), p:[[2,8,8],[3,10,10],[3,12,12]]},
     ]},
    {id:'ub', name:'Upper B', theme:'Hypertrophy bias',
     main:[
      {id:'inc_db', name:'Incline Dumbbell Press', f:F('incline+dumbbell+press'), p:[[3,8,10],[4,8,10],[4,8,10]]},
      {id:'cablerow', name:'Seated Cable Row', f:F('seated+cable+row'), p:[[3,8,10],[4,8,10],[4,8,10]]},
      {id:'lat_raise', name:'Dumbbell Lateral Raise', f:F('dumbbell+lateral+raise'), p:[[2,12,15],[3,12,15],[4,12,15]]},
      {id:'pullup', name:'Pull-up (or assisted)', unit:'AMRAP', f:F('pull+up'), p:[[2,6,10],[3,6,10],[3,8,12]]},
      {id:'hammer', name:'Hammer Curl', f:F('hammer+curl'), p:[[2,10,12],[3,10,12],[3,10,12]]},
      {id:'oh_tri', name:'Overhead Dumbbell Triceps Extension', f:F('overhead+dumbbell+triceps+extension'), p:[[2,10,12],[3,10,12],[3,10,12]]},
     ],
     core:[
      {id:'cablerot', name:'Standing Cable Rotation', tag:'Rotation', unit:'/side', f:F('standing+cable+rotation'), p:[[2,10,10],[3,10,10],[3,8,8]]},
      {id:'mbslam', name:'Med Ball Rotational Slam', tag:'Rotational power', unit:'/side', f:F('medicine+ball+rotational+slam'), p:[[3,8,8],[3,10,10],[4,10,10]]},
      {id:'birddog', name:'Bird Dog', tag:'Anti-rotation', unit:'/side', f:F('bird+dog+exercise'), p:[[2,10,10],[3,10,10],[3,12,12]]},
     ]},
    {id:'lb', name:'Lower B', theme:'Hinge bias',
     main:[
      {id:'db_dl', name:'Smith Machine RDL', f:F('smith+machine+romanian+deadlift'), p:[[3,6,8],[3,5,6],[4,5,6]]},
      {id:'bss', name:'Dumbbell Bulgarian Split Squat', tag:'', unit:'/leg', f:F('dumbbell+bulgarian+split+squat'), p:[[2,8,10],[3,8,10],[3,8,10]]},
      {id:'hipthrust', name:'Smith Machine Hip Thrust', f:F('smith+machine+hip+thrust'), p:[[3,10,12],[3,8,10],[4,8,10]]},
      {id:'legext', name:'Leg Extension', f:F('leg+extension'), p:[[2,12,15],[3,12,15],[3,12,15]]},
      {id:'calf_seat', name:'Seated Calf Raise', f:F('seated+calf+raise'), p:[[3,12,15],[3,12,15],[4,12,15]]},
     ],
     core:[
      {id:'cablecrunch', name:'Cable Crunch', tag:'Flexion', f:F('cable+crunch'), p:[[2,12,15],[3,12,15],[3,10,12]]},
      {id:'sideplank', name:'Side Plank', tag:'Anti-lateral flexion', unit:'sec/side', f:F('side+plank'), p:[[2,30,30],[3,40,40],[3,45,60]]},
      {id:'plank', name:'Plank', tag:'Anti-extension', unit:'sec', f:F('plank'), p:[[3,30,45],[3,45,60],[3,60,60]]},
     ]},
  ]
};
const ALLEX = {};
PROGRAM.days.forEach(d=>[...d.main,...d.core].forEach(e=>{ALLEX[e.id]={...e,dayId:d.id,dayName:d.name};}));

/* same-muscle / same-pattern swaps — [display name, form search slug] */
const ALTS = {
  db_bench:[['Barbell Bench Press','barbell+bench+press'],['Smith Machine Bench Press','smith+machine+bench+press'],['Machine Chest Press','machine+chest+press'],['Weighted Push-up','weighted+push+up']],
  db_row:[['Barbell Bent-Over Row','barbell+bent+over+row'],['Chest-Supported DB Row','chest+supported+dumbbell+row'],['Machine Row','machine+row'],['Seated Cable Row','seated+cable+row']],
  db_ohp:[['Barbell Overhead Press','barbell+overhead+press'],['Machine Shoulder Press','machine+shoulder+press'],['Smith Machine Shoulder Press','smith+machine+shoulder+press'],['Arnold Press','arnold+press']],
  latpd:[['Assisted Pull-up','assisted+pull+up'],['Neutral-Grip Pulldown','neutral+grip+lat+pulldown']],
  inc_curl:[['Barbell Curl','barbell+curl'],['Cable Curl','cable+curl'],['Hammer Curl','hammer+curl'],['Preacher Curl','preacher+curl']],
  tri_push:[['Overhead Cable Extension','overhead+cable+triceps+extension'],['DB Skull Crusher','dumbbell+skull+crusher'],['Bench Dip','bench+dip']],
  woodchop:[['Band Woodchopper','band+woodchopper'],['Weighted Russian Twist','weighted+russian+twist']],
  pallof:[['Band Pallof Press','band+pallof+press'],['Plank Shoulder Tap','plank+shoulder+tap','/side',[10,12]]],
  abwheel:[['Stability Ball Rollout','stability+ball+rollout'],['Long-Lever Plank','long+lever+plank','sec',[30,45]]],

  goblet:[['Leg Press (high volume)','leg+press'],['Dumbbell Goblet Squat','dumbbell+goblet+squat'],['Smith Split Squat','smith+machine+split+squat']],
  db_rdl:[['Smith Machine RDL','smith+machine+romanian+deadlift'],['Cable Pull-Through','cable+pull+through'],['Single-Leg DB RDL','single+leg+dumbbell+romanian+deadlift']],
  legpress:[['Smith Machine Squat','smith+machine+squat'],['DB Walking Lunge','dumbbell+walking+lunge']],
  legcurl:[['Lying Leg Curl','lying+leg+curl'],['Nordic Hamstring Curl','nordic+hamstring+curl']],
  calf_st:[['Leg Press Calf Raise','leg+press+calf+raise'],['Dumbbell Standing Calf Raise','dumbbell+standing+calf+raise'],['Seated Calf Raise','seated+calf+raise']],
  carry:[['Side Plank','side+plank','sec/side',[30,45]],['Dumbbell Side Bend','dumbbell+side+bend','/side',[10,12]]],
  hlr:[['Captain\u2019s Chair Knee Raise','captains+chair+knee+raise'],['Lying Leg Raise','lying+leg+raise'],['Reverse Crunch','reverse+crunch']],
  deadbug:[['Hollow Body Hold','hollow+body+hold','sec',[20,40]],['Bird Dog','bird+dog+exercise','/side',[10,12]]],

  inc_db:[['Incline Barbell Press','incline+barbell+press'],['Incline Machine Press','incline+machine+chest+press'],['Incline Cable Fly','incline+cable+fly']],
  cablerow:[['Chest-Supported Row','chest+supported+row'],['Machine Row','machine+row'],['One-Arm DB Row','one+arm+dumbbell+row']],
  lat_raise:[['Cable Lateral Raise','cable+lateral+raise'],['Machine Lateral Raise','machine+lateral+raise']],
  pullup:[['Assisted Pull-up','assisted+pull+up'],['Lat Pulldown','lat+pulldown'],['Inverted Row','inverted+row']],
  hammer:[['Cable Rope Hammer Curl','cable+rope+hammer+curl'],['Dumbbell Curl','dumbbell+biceps+curl']],
  oh_tri:[['Cable Pushdown','cable+triceps+pushdown'],['DB Skull Crusher','dumbbell+skull+crusher']],
  cablerot:[['Band Rotation','band+standing+rotation'],['Weighted Russian Twist','weighted+russian+twist']],
  mbslam:[['Med Ball Side Throw','medicine+ball+side+throw'],['Cable Rotation','standing+cable+rotation']],
  birddog:[['Plank Shoulder Tap','plank+shoulder+tap','/side',[10,12]],['Pallof Press','pallof+press','/side',[10,12]]],

  db_dl:[['Dumbbell Deadlift','dumbbell+deadlift'],['Dumbbell RDL','dumbbell+romanian+deadlift'],['45\u00b0 Back Extension','45+degree+back+extension']],
  bss:[['Smith Split Squat','smith+machine+split+squat'],['DB Reverse Lunge','dumbbell+reverse+lunge'],['Dumbbell Step-Up','dumbbell+step+up']],
  hipthrust:[['Dumbbell Hip Thrust','dumbbell+hip+thrust'],['Single-Leg Hip Thrust','single+leg+hip+thrust'],['Cable Pull-Through','cable+pull+through']],
  legext:[['Sissy Squat','sissy+squat'],['Smith Split Squat','smith+machine+split+squat']],
  calf_seat:[['Standing Calf Raise','standing+calf+raise'],['Leg Press Calf Raise','leg+press+calf+raise']],
  cablecrunch:[['Weighted Decline Sit-up','weighted+decline+sit+up'],['Hanging Leg Raise','hanging+leg+raise']],
  sideplank:[['Dumbbell Side Bend','dumbbell+side+bend','/side',[10,12]],['Suitcase Carry','dumbbell+suitcase+carry','m/side',[20,25]]],
  plank:[['Long-Lever Plank','long+lever+plank','sec',[30,45]],['Dead Bug','dead+bug+exercise','/side',[10,12]]],
};
function optionsFor(id){
  const ex=ALLEX[id];
  const a=(ALTS[id]||[]).map(([n,s,u,rng])=>({name:n,f:F(s),unit:u,range:rng}));
  const custom=((state.settings&&state.settings.customAlts&&state.settings.customAlts[id])||[]).map(c=>({name:c.name,f:c.f||F(c.name.toLowerCase().replace(/[^a-z0-9]+/g,'+')),ai:true}));
  return [{name:ex.name,f:ex.f},...a,...custom];
}
function swapIdx(id){return (state.settings.swaps&&state.settings.swaps[id])||0;}
function currentOpt(id){const o=optionsFor(id);return o[Math.min(swapIdx(id),o.length-1)]||o[0];}
/* Units and targets follow the exercise you're ACTUALLY doing, not the program slot:
   a swap can change how the movement is measured (reps vs seconds vs metres). */
function effUnit(id){ const o=currentOpt(id); return (o&&o.unit!==undefined&&o.unit!==null)?o.unit:(ALLEX[id].unit||''); }
function effP(id,ph){ const base=ALLEX[id].p[ph]; const o=currentOpt(id); return (o&&o.range)?[base[0],o.range[0],o.range[1]]:base; }
function measureLabel(unit){
  const u=String(unit||'');
  if(u.startsWith('sec')) return 'Seconds';
  if(u.startsWith('m'))   return 'Metres';
  return 'Reps';
}

/* compress an image file to a small JPEG dataURL (~50-150KB) */
function compressImage(file,maxDim){
  maxDim=maxDim||720;
  return new Promise((res,rej)=>{
    const img=new Image();
    img.onload=()=>{
      const sc=Math.min(1,maxDim/Math.max(img.width,img.height));
      const c=document.createElement('canvas');
      c.width=Math.round(img.width*sc); c.height=Math.round(img.height*sc);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg',0.7));
    };
    img.onerror=()=>rej(new Error('image load failed'));
    img.src=URL.createObjectURL(file);
  });
}
function fileToDataURL(file){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result); r.onerror=()=>rej(new Error('file read failed'));
    r.readAsDataURL(file);
  });
}
function dataUrlParts(u){ const m=/^data:(image\/[a-z+]+);base64,(.+)$/.exec(u); return m?{media:m[1],b64:m[2]}:null; }

/* superset execution flow per day: [label, [exIds], type] */
const FLOW = {
  ua:[['A',['db_bench','db_row'],'super'],['B',['db_ohp','latpd'],'super'],['C',['inc_curl','tri_push'],'super'],['D',['woodchop','pallof','abwheel'],'circuit']],
  la:[['A',['goblet'],'single'],['B',['db_rdl'],'single'],['C',['legpress','legcurl'],'super'],['D',['calf_st','carry','hlr','deadbug'],'circuit']],
  ub:[['A',['inc_db','cablerow'],'super'],['B',['lat_raise','pullup'],'super'],['C',['hammer','oh_tri'],'super'],['D',['cablerot','mbslam','birddog'],'circuit']],
  lb:[['A',['db_dl'],'single'],['B',['bss'],'single'],['C',['hipthrust','legext'],'super'],['D',['calf_seat','cablecrunch','sideplank','plank'],'circuit']],
};
const FINFO={};
Object.entries(FLOW).forEach(([d,blocks])=>blocks.forEach(([l,ids,t])=>ids.forEach((id,i)=>{FINFO[id]={label:l,type:t,idx:i};})));
function pillText(id){const fi=FINFO[id]; if(!fi) return ''; return fi.type==='super'?fi.label+(fi.idx+1) : fi.type==='circuit'?'core' : fi.label;}

/* ---------- state ---------- */
let state={settings:{week:1,swaps:{},customAlts:{}},profile:{},checkins:[],mobility:{},logs:[],schema:2};
/* LOCAL date as YYYY-MM-DD. Never use toISOString() here: it converts to UTC,
   which rolls the date forward for evening workouts in the Americas. */
function ymdLocal(d){
  const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
}
const todayStr=()=>ymdLocal(new Date());
const phaseIdx=w=> w<=2?0 : w<=5?1 : 2;
function curWeek(){ return weekFromDate(selDate); }
const PHASE_NAMES=['Reintroduction','Build','Progress'];
const DAY_ABBR=['Su','Mo','Tu','We','Th','Fr','Sa'];
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function ymd(d){ return ymdLocal(d); }
function parseYMD(s){ const d=new Date(s+'T00:00:00'); d.setHours(0,0,0,0); return d; }
function daysBetween(a,b){ return Math.round((parseYMD(b)-parseYMD(a))/86400000); }
function weekFromDate(dateStr){
  const start=(state.settings&&state.settings.startDate)||todayStr();
  const diff=daysBetween(start,dateStr);
  if(diff<0) return 1;
  return Math.min(8, Math.floor(diff/7)+1); // program is 8 weeks; caps there
}
function addDays(dateStr,n){ const d=parseYMD(dateStr); d.setDate(d.getDate()+n); return ymd(d); }
/* ---------- units ----------
   Loads are always STORED in lb (history and PRs stay comparable); everything shown or typed uses the chosen unit. */
const LB_PER_KG=2.20462;
function unit(){ return state.settings&&state.settings.units==='kg'?'kg':'lb'; }
function W(lb){ if(lb===''||lb==null||!isFinite(+lb)) return ''; const v=+lb;
  return unit()==='lb'?String(Math.round(v*10)/10):String(Math.round(v/LB_PER_KG*4)/4); }
function WL(lb){ const w=W(lb); return w===''?'':w+' '+unit(); }
function toLb(v){ if(v===''||v==null||!isFinite(+v)) return ''; const n=+v; return unit()==='lb'?String(n):String(Math.round(n*LB_PER_KG*100)/100); }
function VOL(lbVolume){ return Math.round(unit()==='lb'?lbVolume:lbVolume/LB_PER_KG); }
function prettyDate(dateStr){ const d=parseYMD(dateStr); return DAY_ABBR[d.getDay()]+' '+d.getDate()+' '+MON[d.getMonth()]; }
/* which program day (if any) was logged on a given date */
function dayLoggedOn(dateStr){ const l=state.logs.find(x=>x.date===dateStr&&isProgramDay(x.dayId)); return l?l.dayId:null; }
function anyLogOn(dateStr){ return state.logs.some(x=>x.date===dateStr); }

/* Bring older saved data up to the current schema. Additive only — never drops fields. */
function migrate(s){
  if(!s||typeof s!=='object') return {migrated:false,from:SCHEMA};
  const from=(typeof s.schema==='number')?s.schema:1;
  if(from>=SCHEMA){ s.schema=SCHEMA; return {migrated:false,from}; }
  // v1 -> v2: dates were written with UTC conversion; entries logged in the evening
  // (Americas) landed on the following day. Shift those back to the local date.
  const tzShiftHrs=new Date().getTimezoneOffset()/60; // >0 for the Americas
  if(tzShiftHrs>0 && Array.isArray(s.logs)){
    // only correct entries that look UTC-shifted: a log dated in the future
    const today=todayStr();
    s.logs.forEach(l=>{
      if(l&&typeof l.date==='string'&&l.date>today){
        const d=new Date(l.date+'T00:00:00'); d.setDate(d.getDate()-1);
        l.date=ymdLocal(d); if(l.id) l.id=l.date+'_'+l.dayId;
      }
    });
  }
  s.schema=SCHEMA;
  return {migrated:true,from};
}
function blankState(){
  return {settings:{week:1,swaps:{},customAlts:{},startDate:todayStr()},
          profile:{},checkins:[],mobility:{},logs:[],schema:SCHEMA};
}
/* A saved snapshot is only usable if it is a real object with a logs ARRAY.
   Note: typeof null === 'object' and arrays are objects too, so both must be excluded. */
function validState(p){
  return !!p && typeof p==='object' && !Array.isArray(p) && Array.isArray(p.logs);
}
/* Force any state into a shape the rest of the app can rely on. */
function sanitize(s){
  if(!s || typeof s!=='object' || Array.isArray(s)) s=blankState();
  if(!s.settings || typeof s.settings!=='object' || Array.isArray(s.settings)) s.settings={};
  if(!s.settings.swaps || typeof s.settings.swaps!=='object' || Array.isArray(s.settings.swaps)) s.settings.swaps={};
  if(!s.settings.customAlts || typeof s.settings.customAlts!=='object' || Array.isArray(s.settings.customAlts)) s.settings.customAlts={};
  if(typeof s.settings.startDate!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.settings.startDate)) s.settings.startDate=todayStr();
  if(!s.profile || typeof s.profile!=='object' || Array.isArray(s.profile)) s.profile={};
  if(!Array.isArray(s.checkins)) s.checkins=[];
  if(!s.mobility || typeof s.mobility!=='object' || Array.isArray(s.mobility)) s.mobility={};
  if(!Array.isArray(s.logs)) s.logs=[];
  // drop entries that would crash the renderer
  s.logs=s.logs.filter(l=> l && typeof l==='object' && typeof l.date==='string' && l.ex && typeof l.ex==='object');
  s.logs.forEach(l=>{
    Object.keys(l.ex).forEach(k=>{
      if(!Array.isArray(l.ex[k])){ delete l.ex[k]; return; }
      // individual sets must be objects with string-ish load/rep fields
      l.ex[k]=l.ex[k].filter(x=>x&&typeof x==='object'&&!Array.isArray(x))
                     .map(x=>{ const o={l:x.l==null?'':String(x.l), r:x.r==null?'':String(x.r)};
                       if(x.t==='w'||x.t==='d'||x.t==='f') o.t=x.t;          // warm-up / drop / failure
                       if(x.rpe!=null&&x.rpe!=='') o.rpe=String(x.rpe);
                       return o; });
      if(!l.ex[k].length) delete l.ex[k];
    });
    if(!Object.keys(l.ex).length) l.__empty=true;
  });
  s.logs=s.logs.filter(l=>!l.__empty);
  s.checkins=s.checkins.filter(c=> c && typeof c==='object' && typeof c.date==='string');
  if(!Array.isArray(s.routines)) s.routines=[];
  s.routines=s.routines.filter(r=>r&&typeof r==='object'&&typeof r.id==='string'&&Array.isArray(r.exercises));
  if(!s.customEx||typeof s.customEx!=='object'||Array.isArray(s.customEx)) s.customEx={};
  if(s.settings.units!=='kg') s.settings.units='lb';
  if(!Array.isArray(s.measurements)) s.measurements=[];
  if(!s.health||typeof s.health!=='object'||Array.isArray(s.health)) s.health={};   // Apple Health imports (js/health.js)
  s.measurements=s.measurements.filter(m=>m&&typeof m==='object'&&typeof m.date==='string');
  if(typeof s.schema!=='number') s.schema=1;
  return s;
}
async function load(){
  await initStore();
  let raw=null, loaded=false;
  try{
    raw=await readRaw();
    if(raw){ const parsed=JSON.parse(raw); if(validState(parsed)){ state=parsed; loaded=true; } }
  }catch(e){
    console.warn('load failed',e);
    // corrupt data: try the rescue snapshot rather than starting empty
    try{
      let r=null; const rk=rescueKey(); if(rk){ try{ r=localStorage.getItem(rk); }catch(e){} if(!r){ try{ r=await idb.get(rk); }catch(e){} } }
      if(r){ const p=JSON.parse(r); if(validState(p)){ state=p; loaded=true; console.warn('recovered from rescue snapshot'); } }
    }catch(e2){}
  }
  // every tier unreadable/corrupt -> fall back to the pre-migration rescue snapshot
  if(!loaded){
    let r=null;
    const rk=rescueKey();
    if(rk){ try{ r=localStorage.getItem(rk); }catch(e){}
      if(!r){ try{ r=await idb.get(rk); }catch(e){} } }
    if(r){ try{ const p=JSON.parse(r); if(validState(p)){ state=p; raw=r; loaded=true; console.warn('recovered from rescue snapshot'); } }catch(e){} }
  }
  // keep a rescue copy of the last good data before any migration touches it
  const rkw=rescueKey(); if(raw&&rkw){ try{ localStorage.setItem(rkw,raw); }catch(e){} try{ Promise.resolve(idb.set(rkw,raw)).catch(()=>{}); }catch(e){} }
  bootLoaded=true;
  state=sanitize(state);                       // guarantees a shape migrate/render can trust
  try{
    const mig=migrate(state);
    if(mig.migrated) console.info('Iron Log: data migrated from schema',mig.from,'to',SCHEMA);
  }catch(e){ console.error('migration skipped',e); state.schema=SCHEMA; }
  state=sanitize(state);
  // keep the week number in sync with the real calendar on every load
  const wk=weekFromDate(todayStr());
  state.settings.week=(Number.isFinite(wk)&&wk>0)?wk:1;
}
let saveTimer=null;
let persistBroken=false;
let autoBackupText='';
async function persist(){
  try{
    state.savedAt=new Date().toISOString();
    autoBackupText=JSON.stringify(state);
    await writeRaw(JSON.stringify(state));
    if(persistBroken){ persistBroken=false; renderStorageBanner(); }
    return true;
  }catch(e){
    console.error('persist failed',e);
    // one retry via a different tier before declaring failure
    try{ await initStore(); forceWrite=false; await writeRaw(JSON.stringify(state)); renderStorageBanner(); return true; }catch(e2){}
    persistBroken=true; renderStorageBanner();
    toast('⚠ Could not save — tap 🏆 to back up');
    return false;
  }
}
/* flush on close/background so nothing is lost mid-session */
function flush(){
  if(!bootLoaded) return;                       // BUG-1 fix: never flush the boot state
  try{
    if((state.logs||[]).length===0) return;     // BUG-2 fix: an empty flush has nothing worth risking a wipe for
    state.savedAt=new Date().toISOString();
    const v=JSON.stringify(state);
    try{ if(primaryTier==='local') window.localStorage.setItem(KEY,v); }catch(e){}
    writeRaw(v).catch(()=>{});
  }catch(e){}
}
window.addEventListener('pagehide',flush);
window.addEventListener('beforeunload',flush);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden') flush(); });

/* ---------- helpers ---------- */
/* working sets = everything except warm-ups */
function working(sets){ return (sets||[]).filter(s=>s.t!=='w'); }
const isProgramDay=id=>PROGRAM.days.some(d=>d.id===id);
/* display name for any exercise id: program slot (with swap), library, or custom */
function exName(id,entry){
  if(entry&&entry.variants&&entry.variants[id]) return entry.variants[id];
  if(ALLEX[id]) return currentOpt(id).name;
  if(typeof LIBRARY!=='undefined'&&LIBRARY[id]) return LIBRARY[id].name;
  if(state.customEx&&state.customEx[id]) return state.customEx[id].name;
  return id;
}
function entryName(entry){
  if(entry.name) return entry.name;
  const d=PROGRAM.days.find(x=>x.id===entry.dayId); return d?d.name:'Workout';
}
function historyTopSets(exId){ // [{date, topLoad}]
  return state.logs.filter(l=>l.ex&&l.ex[exId]&&working(l.ex[exId]).length)
    .sort((a,b)=>a.date<b.date?-1:1)
    .map(l=>({date:l.date, top:Math.max(...working(l.ex[exId]).map(s=>+s.l||0))}));
}
/* ---------- rendering ---------- */
const $=s=>document.querySelector(s);
let selDate=todayStr();   // progression math reads the week relative to this date
/* ---------- coach panel ---------- */
/* ---------- coach panel ---------- */
function renderCoach(){
  const c=$('#coach'); if(!c) return;
  const ready=window.Planner?Planner.readyList():[];
  if(ready.length){
    c.className='coach hot';
    c.innerHTML=`<h2><span class="dot"></span>Ready to add load · ${ready.length}</h2>
      <p class="lead">You hit the top of the rep range on every working set last time. Today’s plan already uses the heavier weight.</p>
      <ul class="readylist">${ready.map(r=>`<li>
        <span class="arrow">↑</span>
        <span class="nm">${exName(r.id)}<small>last ${prettyDate(r.date)}</small></span>
        <span class="ld">${W(r.from)} → ${WL(r.to)}</span>
      </li>`).join('')}</ul>`;
  }else{
    c.className='coach';
    c.innerHTML=`<h2><span class="dot"></span>Progression coach</h2>
      <p class="lead">${state.logs.length? 'Nothing flagged yet — keep logging. When you hit the top of the rep range on every working set of a lift, it shows up here and the next plan adds weight.' : 'Log your first workout and this panel starts tracking which lifts have earned more weight.'}</p>`;
  }
}

/* In-app confirm / prompt sheet. The browser's own dialogs are silently blocked in some
   embedded viewers and installed-app modes (they just answer "no"), which froze flows. */
function askSheet(msg,{ok='OK',cancel='Cancel',danger=false,input=null}={}){
  return new Promise(res=>{
    let sc=document.getElementById('askScrim');
    if(!sc){ sc=document.createElement('div'); sc.id='askScrim'; sc.className='scrim ask'; document.body.appendChild(sc); }
    const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    sc.innerHTML=`<div class="sheet"><div class="ask-msg">${esc(msg).replace(/\n/g,'<br>')}</div>
      ${input!==null?`<input class="crew-in" id="askIn" value="${esc(input.value||'')}" placeholder="${esc(input.placeholder||'')}" ${input.type?`type="${esc(input.type)}"`:''}>`:''}
      <div class="dbtns" style="margin-top:14px"><button class="dbtn" id="askNo">${esc(cancel)}</button><button class="dbtn ${danger?'danger':'go'}" id="askYes">${esc(ok)}</button></div></div>`;
    const done=v=>{ sc.classList.remove('show'); res(v); };
    sc.querySelector('#askNo').onclick=()=>done(input!==null?null:false);
    sc.querySelector('#askYes').onclick=()=>done(input!==null?sc.querySelector('#askIn').value:true);
    sc.onclick=e=>{ if(e.target===sc) done(input!==null?null:false); };
    requestAnimationFrame(()=>sc.classList.add('show'));
    const inp=sc.querySelector('#askIn'); if(inp) setTimeout(()=>inp.focus(),50);
  });
}
const ask=(msg,ok,danger)=>askSheet(msg,{ok:ok||'OK',danger:!!danger});
const askText=(msg,value,opts)=>askSheet(msg,{ok:'OK',input:{value,...(opts||{})}});

function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(saveTimer);saveTimer=setTimeout(()=>t.classList.remove('show'),1900);}

/* ---------- session review ---------- */
function classifyEx(exId,sets){
  const [tS,mn,mx]=effP(exId,phaseIdx(curWeek()));
  const reps=working(sets).filter(s=>s.r!==''&&s.r!=null).map(s=>+s.r).filter(n=>!isNaN(n));
  if(!reps.length) return 'hold';
  if(reps.length>=tS && reps.every(x=>x>=mx)) return 'add';
  if(reps.every(x=>x>=mn)) return 'on';
  return 'hold';
}
/* timed moves (holds, carries, cardio) log seconds/minutes in "r", so load × r isn't volume */
function isTimedEx(id){
  const t=(typeof LIBRARY!=='undefined'&&LIBRARY[id]&&LIBRARY[id].type)||(state.customEx&&state.customEx[id]&&state.customEx[id].type)||'';
  return t==='dur'||t==='wd'||t==='cardio';
}
function sessionVolume(exMap){ return sessionVolumeSafe(exMap); }
function showReview(entry, gain){
  const day=PROGRAM.days.find(d=>d.id===entry.dayId);
  const order=(entry.order&&entry.order.length?entry.order:day?[...day.main,...day.core].map(e=>e.id):Object.keys(entry.ex)).filter(id=>entry.ex[id]);
  const prs=(window.Workout&&Workout.prsInEntry)?Workout.prsInEntry(entry):{};
  let addN=0,onN=0,holdN=0;
  const rows=order.map(id=>{
    const sets=entry.ex[id];
    const summ=sets.map(s=>window.Workout?Workout.fmtSet(id,s):`${W(s.l)||'–'}×${s.r||'–'}`).join('  ');
    const nm=exName(id,entry);
    const hasPr=!!(prs[id]&&prs[id].length);
    const prLine=hasPr?`<span class="rvpr">🏅 ${prs[id].map(p=>p.label).join(' · ')}</span>`:'';
    if(!ALLEX[id]||!isProgramDay(entry.dayId)){
      return `<div class="rv-row"><div class="rn">${nm}<small>${summ}</small>${prLine}</div>${hasPr?'<span class="chip pr">PR</span>':'<span class="chip on">logged</span>'}</div>`;
    }
    const cls=classifyEx(id,sets);
    if(cls==='add')addN++; else if(cls==='on')onN++; else holdN++;
    const label=cls==='add'?'↑ add load':cls==='on'?'on target':'hold';
    return `<div class="rv-row"><div class="rn">${nm}<small>${summ}</small>${prLine}</div><span class="chip ${cls}">${label}</span></div>`;
  }).join('');
  const prTotal=Object.values(prs).reduce((n,a)=>n+a.length,0);

  // stats
  const exCount=order.length;
  const setCount=order.reduce((a,id)=>a+entry.ex[id].length,0);
  const vol=sessionVolume(entry.ex);
  const prev=state.logs.filter(l=>l.dayId===entry.dayId && l.date<entry.date).sort((a,b)=>a.date<b.date?1:-1)[0];
  let trend='<div class="trend flat">first time</div>';
  if(prev){
    const pv=sessionVolume(prev.ex);
    if(pv>0){const d=Math.round((vol-pv)/pv*100);
      trend = d>2?`<div class="trend up">▲ ${d}% vol</div>` : d<-2?`<div class="trend down">▼ ${Math.abs(d)}% vol</div>` : `<div class="trend flat">≈ same vol</div>`;
    }
  }

  // verdict
  const ph=phaseIdx(curWeek());
  const base=!day?'Workout logged — every session counts toward your streak.':[
    'Reintroduction week — clean, controlled reps matter more than heavy ones.',
    'Build phase — nudge the load up wherever it felt easy.',
    'Progress phase — the hard sets near your limit are where the gains live.'
  ][ph];
  let v2=prTotal?` <b>🏅 ${prTotal} new personal record${prTotal>1?'s':''}!</b>`:'';
  if(addN>0) v2+=` <b>${addN} lift${addN>1?'s':''} ready to load heavier</b> next time.`;
  if(holdN>0) v2+=` ${holdN} to repeat at the same weight until the reps come.`;
  if(addN===0 && holdN===0 && day) v2+=' Everything landed in range — hold here and it should turn green soon.';

  $('#rvTtl').textContent=entryName(entry)+' · done';
  $('#rvDt').textContent=`Wk ${entry.week} · ${entry.date}${entry.duration>=60?' · '+Math.round(entry.duration/60)+' min':''}`;
  $('#rvVerdict').innerHTML=base+v2;
  const xpEl=$('#rvXp');
  if(gain){
    let h=`<span class="g">+${gain.xp} XP</span>`;
    if(gain.levelUp) h+=`<span class="lvup">▲ Level ${gain.levelUp.level} — ${gain.levelUp.title}</span>`;
    if(gain.newAch&&gain.newAch.length) h+=gain.newAch.map(a=>`<span class="ach">${a.ic} Unlocked: ${a.n}</span>`).join('');
    xpEl.className='rv-xp'; xpEl.innerHTML=h;
  } else { xpEl.className=''; xpEl.innerHTML=''; }
  $('#rvStats').innerHTML=`
    <div class="stat"><div class="v">${exCount}</div><div class="k">Exercises</div></div>
    <div class="stat"><div class="v">${setCount}</div><div class="k">Sets logged</div></div>
    <div class="stat"><div class="v">${VOL(vol).toLocaleString()}<small> ${unit()}</small></div><div class="k">Volume</div>${trend}</div>`;
  $('#rvList').innerHTML=rows;
  renderFeelRow(entry);
  if(window.Social) Social.renderShare(entry);
  $('#scrim').classList.add('show');
}
function closeReview(){$('#scrim').classList.remove('show'); if(window.Social) Social.onReviewClose();}

/* ================= gamification ================= */
const WEEK_TARGET=4;
const LEVELS=[[0,'Fresh Start'],[150,'Warming Up'],[400,'Groove Found'],[800,'Consistent'],[1300,'Iron Habit'],[2000,'Forged'],[2900,'Relentless'],[4000,'Iron-Willed'],[5400,'Machine'],[7000,'Unbreakable']];
function levelInfo(xp){
  let i=0; for(let k=0;k<LEVELS.length;k++){ if(xp>=LEVELS[k][0]) i=k; }
  const cur=LEVELS[i][0], title=LEVELS[i][1];
  const next=i<LEVELS.length-1?LEVELS[i+1][0]:null;
  const pct=next?Math.min(100,Math.round((xp-cur)/(next-cur)*100)):100;
  return {level:i+1,title,cur,next,pct,toNext:next?next-xp:0};
}
function weekStartTs(dateStr){ const d=new Date(dateStr+'T00:00:00'); const day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); d.setHours(0,0,0,0); return d.getTime(); }
function completeWeeks(){ // {ts:count} for weeks with >=target sessions
  const m={}; state.logs.forEach(l=>{const w=weekStartTs(l.date); m[w]=(m[w]||0)+1;});
  return Object.keys(m).filter(w=>m[w]>=WEEK_TARGET).map(Number).sort((a,b)=>a-b);
}
function longestRun(sortedTs, stepDays){ // longest consecutive run + current run ending latest
  if(!sortedTs.length) return {max:0,current:0};
  const step=stepDays*86400000; let max=1,run=1;
  for(let i=1;i<sortedTs.length;i++){ if(sortedTs[i]-sortedTs[i-1]===step){run++;} else {run=1;} max=Math.max(max,run); }
  // current run = run ending at the last element
  let cur=1; for(let i=sortedTs.length-1;i>0;i--){ if(sortedTs[i]-sortedTs[i-1]===step) cur++; else break; }
  return {max,current:cur};
}
function mobilityDatesTs(){ return Object.keys(state.mobility||{}).map(d=>{const x=new Date(d+'T00:00:00');x.setHours(0,0,0,0);return x.getTime();}).sort((a,b)=>a-b); }
function mobilityStreakCurrent(){
  const set=new Set(mobilityDatesTs()); if(!set.size) return 0;
  let d=new Date(); d.setHours(0,0,0,0); let ts=d.getTime(); let streak=0;
  // allow streak to count from today or yesterday
  if(!set.has(ts)) ts-=86400000;
  while(set.has(ts)){ streak++; ts-=86400000; }
  return streak;
}
function sessionVolumeSafe(ex){let v=0;Object.entries(ex||{}).forEach(([id,sets])=>{ if(isTimedEx(id)) return; sets.forEach(s=>{const l=+s.l,r=+s.r;if(l>0&&r>0)v+=l*r;}); });return Math.round(v);}
function computeStats(){
  const sessions=state.logs.length;
  let setsTotal=0, volumeTotal=0;
  state.logs.forEach(l=>{ Object.values(l.ex).forEach(a=>setsTotal+=a.length); volumeTotal+=sessionVolumeSafe(l.ex); });
  // xp
  let xp=0;
  state.logs.forEach(l=>{
    let sets=0, prog=0; const ph=phaseIdx(l.week||1);
    Object.entries(l.ex).forEach(([id,arr])=>{ sets+=arr.length; const mx=ALLEX[id]?effP(id,ph)[2]:1e9; working(arr).forEach(s=>{ if(s.r!==''&&+s.r>=mx) prog++; }); });
    xp+=40+sets*2+prog*6;
  });
  const cWeeks=completeWeeks();
  xp+=cWeeks.length*80;
  xp+=Object.keys(state.mobility||{}).length*15;
  const wk=longestRun(cWeeks,7);
  const mobTs=mobilityDatesTs(); const mob=longestRun(mobTs,1);
  // progression: distinct exercises whose top load increased over time
  let progExercises=0; let anyProg=false;
  Object.keys(ALLEX).forEach(id=>{ const h=historyTopSets(id); let up=false; for(let i=1;i<h.length;i++){ if(h[i].top>h[i-1].top){up=true;break;} } if(up){progExercises++;anyProg=true;} });
  const muscleOf=id=>(typeof LIBRARY!=='undefined'&&LIBRARY[id]&&LIBRARY[id].muscle)||(state.customEx[id]&&state.customEx[id].muscle)||'';
  const dayTypes=new Set(state.logs.flatMap(l=>Object.keys(l.ex).map(muscleOf)).filter(Boolean)).size;   // distinct muscle groups trained
  const everSwapped=Object.keys(state.settings.swaps||{}).length>0 || state.logs.some(l=>l.variants&&Object.keys(l.variants).length);
  const maxLoggedWeek=state.logs.reduce((a,l)=>Math.max(a,l.week||1),1);
  const li=levelInfo(xp);
  // this week
  const nowW=weekStartTs(todayStr()); const thisWeek=state.logs.filter(l=>weekStartTs(l.date)===nowW).length;
  return {sessions,setsTotal,volumeTotal,xp,li,cWeeks:cWeeks.length,weekStreakMax:wk.max,weekStreakCur:wk.current,
    mobStreakCur:mobilityStreakCurrent(),mobStreakMax:mob.max,progExercises,anyProg,dayTypes,everSwapped,maxLoggedWeek,thisWeek};
}
const ACH=[
  {id:'first',ic:'🏋️',n:'First Lift',d:'Log a session',t:s=>s.sessions>=1},
  {id:'week',ic:'✅',n:'Full Week',d:'4 sessions in a week',t:s=>s.cWeeks>=1},
  {id:'streak3',ic:'🔥',n:'On a Roll',d:'3-week streak',t:s=>s.weekStreakMax>=3},
  {id:'load',ic:'📈',n:'Load Up',d:'Add weight to a lift',t:s=>s.anyProg},
  {id:'ten',ic:'🔟',n:'Ten Down',d:'10 sessions logged',t:s=>s.sessions>=10},
  {id:'hips',ic:'🧘',n:'Loose Hips',d:'7-day mobility streak',t:s=>s.mobStreakMax>=7},
  {id:'swap',ic:'🔄',n:'Improviser',d:'Swap an exercise',t:s=>s.everSwapped},
  {id:'round',ic:'🧭',n:'All-Rounder',d:'Train 8 muscle groups',t:s=>s.dayTypes>=8},
  {id:'phase',ic:'⛰️',n:'Six Weeks In',d:'Train into week 6',t:s=>s.maxLoggedWeek>=6},
  {id:'ton',ic:'🪨',n:'Ton Mover',d:'Lift 100,000 lb (45 t)',t:s=>s.volumeTotal>=100000},
  {id:'lvl5',ic:'⭐',n:'Seasoned',d:'Reach level 5',t:s=>s.li.level>=5},
  {id:'fifty',ic:'🏆',n:'Half-Century',d:'50 sessions',t:s=>s.sessions>=50},
];
function unlockedSet(s){ return new Set(ACH.filter(a=>a.t(s)).map(a=>a.id)); }
function renderGamify(){
  const s=computeStats();
  $('#lvN').textContent='LV '+s.li.level;
  $('#lvT').textContent=s.li.title;
  $('#xpFill').style.width=s.li.pct+'%';
  const wr=$('#weekRing'); wr.textContent=s.thisWeek+'/'+WEEK_TARGET; wr.classList.toggle('done',s.thisWeek>=WEEK_TARGET);
  $('#strk').textContent='🔥 '+s.weekStreakCur;
}
/* yoga names are "English · Sanskrit": show the Sanskrit on its own quieter line */
function poseHTML(n){ n=String(n==null?'':n); const esc=v=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const i=n.indexOf(' · '); return i<0?esc(n):esc(n.slice(0,i))+'<small class="skt">'+esc(n.slice(i+3))+'</small>'; }
/* ---------- views ---------- */
let activeView='train';
function showView(v){
  activeView=v;
  ['train','coach','stats','crew','you'].forEach(x=>{
    const el=$('#view'+x[0].toUpperCase()+x.slice(1));
    if(el) el.classList.toggle('viewhide',x!==v);
  });
  document.querySelectorAll('.nbtn').forEach(b=>b.classList.toggle('active',b.dataset.view===v));
  if(v==='stats') renderStats();
  if(v==='you') renderYou();
  if(v==='crew' && window.Social) Social.render();
  if(v==='coach'){ renderCoach(); renderAILast();
    const n=$('#bridgeNote');
    if(n) n.innerHTML = API_AVAILABLE ? '' : ' <b style="color:var(--steel)">On your phone this hands the prompt to the Claude app — no key or server needed.</b>';
  }
  window.scrollTo(0,0);
}
function renderStats(){
  const s=computeStats();
  const stat=(v,k)=>`<div class="gstat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  const un=unlockedSet(s);
  const did=!!state.mobility[todayStr()];
  let html=`
    <div class="lvcard">
      <div class="big"><span class="lnum">${s.li.level}</span><span class="lttl">${s.li.title}</span></div>
      <div class="xpbar"><i style="width:${s.li.pct}%"></i></div>
      <div class="xpmeta"><span>${s.xp.toLocaleString()} XP</span><span>${s.li.next?`${s.li.toNext} to LV ${s.li.level+1}`:'max tier'}</span></div>
    </div>
    <div class="gstats">${
      stat(s.sessions,'Sessions')+stat(s.thisWeek+'/'+WEEK_TARGET,'This week')+stat('🔥 '+s.weekStreakCur,'Week streak')+
      stat((VOL(s.volumeTotal)/1000).toFixed(1)+'k','Volume '+unit())+stat(s.progExercises,'Lifts leveled')+stat('🧘 '+s.mobStreakCur,'Mobility streak')
    }</div>
    <button class="mobbtn${did?' done':''}" id="mobBtn">${did?'✓ Hip flow done today':'＋ Log today\u2019s hip flow'}</button>
    ${buildChartsHTML(s)}
    <div class="achead">Achievements</div>
    <div class="badges">${ACH.map(a=>`<div class="badge2${un.has(a.id)?' on':''}"><div class="ic">${un.has(a.id)?a.ic:'🔒'}</div><div class="bn">${a.n}</div><div class="bd">${a.d}</div></div>`).join('')}</div>
    <div class="gnote">Rest days are part of the plan — 4 sessions a week is a full win. Streaks reward showing up, not grinding.</div>`;
  $('#statsBody').innerHTML=html;
  if(window.Progress) Progress.augment();
    const sel=$('#progSel'); if(sel){ sel.onchange=()=>drawProg(sel.value); drawProg(sel.value); }
}
function renderYou(){
  const p=state.profile||{};
  $('#pfUnits').value=unit();
  $('#ciWtLbl').textContent='Bodyweight ('+unit()+')';
  $('#pfAge').value=p.age||''; $('#pfHt').value=p.height||'';
  $('#pfSex').value=p.sex||''; $('#pfGoal').value=p.goal||'';
  $('#pfInj').value=p.injuries||''; $('#pfNotes').value=p.notes||'';
  renderCheckins();
  renderDiag();
  const s=computeStats();
  $('#storeWarn').innerHTML = (STORAGE_OK()&&!persistBroken)
    ? `<div class="okmode">✓ Saved to ${TIERS_LABEL()} · ${s.sessions} sessions${state.savedAt?' · last save '+new Date(state.savedAt).toLocaleString():''}</div>`
    : '<div class="warn">⚠ Storage is blocked, so logs won\u2019t survive closing the app. Back up now, then open the tracker from an <code>http://</code> address instead of a file.</div>';
}
function renderAILast(){
  const el=$('#aiLast'); if(!el) return;
  if(state.aiCoach&&state.aiCoach.result){
    el.innerHTML=`<div class="ai-sum" style="margin-top:12px"><b style="color:var(--steel)">Last analysis (wk ${state.aiCoach.week} · ${state.aiCoach.date}):</b> ${(state.aiCoach.result.summary||'').slice(0,300)}<br><button class="applybtn" id="aiAgain" style="margin-top:8px">View full result</button></div>`;
    const b=$('#aiAgain'); if(b) b.onclick=()=>renderAICoach(state.aiCoach.result);
  } else el.innerHTML='';
}
function renderStorageBanner(){
  const el=$('#storeBanner'); if(!el) return;
  if(HOSTED&&!STORAGE_OK()){
    el.className='';
    el.innerHTML=`<div class="banner"><b>Can’t reach your Iron Log account</b>Your history lives in your Iron Log account only, so nothing is shown or saved until it connects. Check your connection and try again.
      <button id="bnrRetry">Try again</button></div>`;
    const b=$('#bnrRetry'); if(b) b.onclick=()=>location.reload();
    return;
  }
  if(STORAGE_OK()&&!persistBroken&&FRAGILE()){
    el.className='';
    el.innerHTML=`<div class="banner" style="background:#FBF3E4;border-color:#EBD3A6;color:#7A5A1E">
      <b style="color:#5C4212">⚠ Preview mode — data is tied to this preview</b>
      You're running inside the Claude app, where the browser blocks normal on-device storage.
      Your logs are saved, but <b>only to this preview</b> — if a new version is shared, this copy starts empty.<br><br>
      <b>Install the real app</b> (Add to Home Screen from your GitHub Pages link) for permanent storage.
      Until then, tap <b>Back up</b> in the You tab after each session.
      <button id="bnrExp2">Back up now</button>
    </div>`;
    const b=$('#bnrExp2'); if(b) b.onclick=exportData;
    return;
  }
  if(STORAGE_OK()&&!persistBroken){ el.className=''; el.innerHTML=''; return; }
  el.className='';
  el.innerHTML=`<div class="banner">
    <b>⚠ Data will not be saved</b>
    This browser is blocking storage, so your logs disappear when you close the app.
    Usually this means the file was opened directly from Files (a <code>file://</code> address)
    or you're in a Private tab. Serve it over <code>http://</code> or add it to your Home Screen from a URL.
    <button id="bnrExp">Back up now</button>
  </div>`;
  const b=$('#bnrExp'); if(b) b.onclick=exportData;
}
/* Workouts saved on this device before account sync aren't tied to anyone. Offer them once,
   only when this account has no history, and only import if the user says they're theirs. */
async function offerDeviceImport(){
  const acc=window.IronAuth&&IronAuth.acct;
  if(!HOSTED||primaryTier!=='ila'||!acc||(state.logs||[]).length||!deviceTiers.length) return;
  const dk='ironlog-import-asked:'+acc.id;
  try{ if(localStorage.getItem(dk)) return; }catch(e){}
  let best=null;
  for(const m of deviceTiers){ const sn=snapInfo(await readTier(m)); if(sn&&sn.n>0&&validState(sn.data)&&(!best||sn.n>best.n)) best=sn; }
  if(!best) return;
  const el=$('#storeBanner'); if(!el||el.innerHTML) return;
  el.innerHTML=`<div class="banner devimp"><b>Workouts found on this device</b>This browser has ${best.n} workout${best.n===1?'':'s'} saved before account sync. They aren’t in your Iron Log account and may belong to someone else who used Iron Log here. Import them only if they’re yours.
    <div class="bnrrow"><button id="diYes">They’re mine — import</button><button id="diNo" class="ghost">Not mine</button></div></div>`;
  const done=()=>{ try{ localStorage.setItem(dk,'1'); }catch(e){} el.innerHTML=''; };
  $('#diNo').onclick=done;
  $('#diYes').onclick=async()=>{
    try{ state=sanitize(JSON.parse(best.raw)); try{ migrate(state); }catch(e){} state=sanitize(state);
      forceWrite=true; await persist(); forceWrite=false; done();
      renderCoach(); renderGamify(); renderYou(); if(window.Workout) Workout.renderHome();
      toast('Imported '+state.logs.length+' workouts into your account'); if(window.Social) Social.sync();
    }catch(e){ forceWrite=false; toast('Couldn’t import those workouts'); }
  };
}
async function exportData(){
  const json=JSON.stringify(state,null,2), filename='iron-log-backup-'+todayStr()+'.json';
  if(HOSTED){
    const dl=await window.claude.use('downloads').catch(()=>null);
    if(!dl){ toast('Downloads aren’t available here — use Copy backup'); return; }
    try{ const r=await dl.save({filename,data:json}); if(r&&r.status==='saved') toast('Backup saved'); }
    catch(e){ if(e&&e.code!=='cancelled'&&e.code!=='declined') toast('Couldn’t save — use Copy backup'); }
    return;
  }
  const blob=new Blob([json],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast('Backup downloaded');
}
async function copyBackup(){
  const txt=JSON.stringify(state);
  try{ await navigator.clipboard.writeText(txt); toast('Backup copied to clipboard'); }
  catch(e){ const b=$('#bkBox'); if(b){ b.value=txt; b.select(); } toast('Select the text below and copy'); }
}
async function pasteBackup(){
  let txt=($('#bkBox')&&$('#bkBox').value.trim())||'';
  if(!txt){ try{ txt=await navigator.clipboard.readText(); }catch(e){} }
  if(!txt){ toast('Paste a backup into the box first'); return; }
  try{
    const d=JSON.parse(txt);
    if(!d||!Array.isArray(d.logs)) throw new Error('bad');
    if(!await ask(`Restore ${d.logs.length} sessions? This replaces current data.`,'Restore',true)) return;
    state=d; forceWrite=true;
    if(!state.settings) state.settings={week:1};
    if(!state.settings.swaps) state.settings.swaps={};
    if(!state.settings.customAlts) state.settings.customAlts={};
    if(!state.profile) state.profile={};
    if(!state.checkins) state.checkins=[];
    if(!state.mobility) state.mobility={};
    await persist();
    renderCoach(); renderGamify(); renderYou(); if(window.Workout) Workout.renderHome();
    toast('Restored '+state.logs.length+' sessions'); if(window.Social) Social.sync();
  }catch(e){ toast('That doesn\u2019t look like a valid backup'); }
}
function renderDiag(){
  const el=$('#storeDiag'); if(!el) return;
  const probe=[...(HOSTED?[['Claude account',primaryTier==='cdb'?'PRIMARY':false]]:[]),['localStorage',primaryTier==='local'?'PRIMARY':legacyTiers.includes('local')],['IndexedDB',primaryTier==='idb'?'PRIMARY':legacyTiers.includes('idb')],['Claude storage',primaryTier==='claude'?'PRIMARY':legacyTiers.includes('claude')]];
  el.innerHTML=`<div class="legend" style="text-align:left;margin-top:10px;line-height:1.7">
    <b>Storage diagnostics</b><br>
    ${probe.map(([n,st])=>`${st==='PRIMARY'?'★':st?'·':'✗'} ${n}${st==='PRIMARY'?' — primary':''}`).join('<br>')}<br>
    sessions: ${state.logs.length} · last save: ${state.savedAt?new Date(state.savedAt).toLocaleString():'never'}<br>
    ${FRAGILE()?'<b style="color:#B0761E">⚠ preview-only storage — install the PWA for permanence</b>':'<b style="color:#1F9D61">✓ permanent on-device storage</b>'}
  </div>`;
}
function importData(file){
  const r=new FileReader();
  r.onload=async()=>{
    try{
      const d=JSON.parse(r.result);
      if(!d||!Array.isArray(d.logs)) throw new Error('bad file');
      if(!await ask('Replace all current data with this backup? This cannot be undone.','Replace',true)) return;
      state=d; forceWrite=true;
      if(!state.settings) state.settings={week:1};
      if(!state.settings.swaps) state.settings.swaps={};
      if(!state.mobility) state.mobility={};
      await persist();
      renderCoach(); renderGamify(); if(window.Workout) Workout.renderHome();
      showView('train'); toast('Restored '+state.logs.length+' sessions'); if(window.Social) Social.sync();
    }catch(e){ toast('Couldn\u2019t read that backup file'); }
  };
  r.readAsText(file);
}
async function toggleMobility(){
  const d=todayStr();
  if(state.mobility[d]) delete state.mobility[d]; else state.mobility[d]=true;
  await persist(); renderGamify(); renderStats();
  if(window.Social) Social.sync();
  if(state.mobility[d]) toast('Hip flow logged 🧘 · streak '+mobilityStreakCurrent());
}

/* ================= analytics ================= */
function mdLabel(ts){const d=new Date(ts);return (d.getMonth()+1)+'/'+d.getDate();}
function weeklySeries(n){
  const cur=weekStartTs(todayStr()); const out=[];
  for(let i=n-1;i>=0;i--){ out.push({ts:cur-i*7*86400000, sessions:0, volume:0}); }
  const idx={}; out.forEach((w,i)=>idx[w.ts]=i);
  state.logs.forEach(l=>{const w=weekStartTs(l.date); if(w in idx){out[idx[w]].sessions++; out[idx[w]].volume+=sessionVolumeSafe(l.ex);}});
  return out;
}
function barChart(vals, labels, opts){
  opts=opts||{}; const W=320,H=opts.h||150,padB=20,padT=12,padX=8;
  const color=opts.color||'#2B4BFF'; const target=opts.target||0;
  const maxV=Math.max(1,...vals,target); const n=vals.length; const gw=(W-padX*2)/n; const bw=Math.min(gw*0.6,40);
  let s=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  vals.forEach((v,i)=>{
    const bh=(v/maxV)*(H-padB-padT); const x=padX+i*gw+(gw-bw)/2; const y=H-padB-bh;
    s+=`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0,bh).toFixed(1)}" rx="2.5" fill="${color}" opacity="${v?0.92:0.15}"/>`;
    if(opts.showVals&&v) s+=`<text x="${(x+bw/2).toFixed(1)}" y="${(y-3).toFixed(1)}" font-size="9" fill="#1B211C" text-anchor="middle" font-family="monospace">${opts.fmt?opts.fmt(v):v}</text>`;
    if(labels) s+=`<text x="${(x+bw/2).toFixed(1)}" y="${H-6}" font-size="8.5" fill="#96A098" text-anchor="middle">${labels[i]}</text>`;
  });
  if(target){const ty=H-padB-(target/maxV)*(H-padB-padT); s+=`<line x1="${padX}" y1="${ty.toFixed(1)}" x2="${W-padX}" y2="${ty.toFixed(1)}" stroke="#2B4BFF" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/><text x="${W-padX}" y="${(ty-3).toFixed(1)}" font-size="8.5" fill="#2B4BFF" text-anchor="end">goal ${target}</text>`;}
  s+='</svg>'; return s;
}
function lineChart(vals, dates, opts){
  opts=opts||{}; const W=320,H=150,padB=18,padT=14,padL=30,padR=10;
  const color=opts.color||'#2B4BFF'; const n=vals.length;
  let mn=Math.min(...vals), mx=Math.max(...vals); if(mn===mx){mn=Math.max(0,mn-5);mx=mx+5;}
  const X=i=>padL+(n===1?0.5:(i/(n-1)))*(W-padL-padR);
  const Y=v=>H-padB-((v-mn)/(mx-mn))*(H-padB-padT);
  const prIdx=vals.indexOf(Math.max(...vals));
  let s=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  s+=`<text x="2" y="${(Y(mx)+3).toFixed(1)}" font-size="9" fill="#5C665E" font-family="monospace">${mx}</text>`;
  s+=`<text x="2" y="${(Y(mn)+3).toFixed(1)}" font-size="9" fill="#5C665E" font-family="monospace">${mn}</text>`;
  const pts=vals.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  s+=`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  vals.forEach((v,i)=>{const isPR=i===prIdx; s+=`<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${isPR?3.5:2.4}" fill="${isPR?'#EFC04A':color}"/>`;});
  if(dates&&dates.length){s+=`<text x="${padL}" y="${H-4}" font-size="8.5" fill="#96A098">${mdLabel(new Date(dates[0]+'T00:00:00').getTime())}</text>`;
    s+=`<text x="${W-padR}" y="${H-4}" font-size="8.5" fill="#96A098" text-anchor="end">${mdLabel(new Date(dates[dates.length-1]+'T00:00:00').getTime())}</text>`;}
  s+='</svg>'; return s;
}
function drawProg(id){
  const c=$('#progChart'); if(!c) return;
  const h=historyTopSets(id).filter(p=>p.top>0);
  if(h.length<2){c.innerHTML='<div class="legend">Log this lift at least twice to see a trend.</div>';return;}
  const vals=h.map(p=>+W(p.top)), dates=h.map(p=>p.date); const pr=Math.max(...vals);
  c.innerHTML=`<div class="chartbox">${lineChart(vals,dates,{color:'#2B4BFF'})}<div class="legend">top-set load (${unit()}) · ⬤ PR ${pr} ${unit()}</div></div>`;
}
function buildChartsHTML(s){
  if(!state.logs.length) return '<div class="empty" style="padding:18px 0;text-align:center">Log a few sessions and your trends will show up here.</div>';
  const wk=weeklySeries(8);
  const labels=wk.map(w=>mdLabel(w.ts));
  const sessBar=barChart(wk.map(w=>w.sessions),labels,{color:'#111111',target:WEEK_TARGET,h:140,showVals:true});
  const volBar=barChart(wk.map(w=>VOL(w.volume)),labels,{color:'#2B4BFF',h:150,fmt:v=>v>=1000?(v/1000).toFixed(1)+'k':v,showVals:true});
  const dm={ua:'Up A',la:'Lo A',ub:'Up B',lb:'Lo B'};
  const splitIds=['ua','la','ub','lb'];
  const splitVals=splitIds.map(d=>state.logs.filter(l=>l.dayId===d).length);
  const splitBar=barChart(splitVals,splitIds.map(d=>dm[d]),{color:'#EFC04A',h:130,showVals:true});
  const prs=Object.keys(ALLEX).map(id=>{const hh=historyTopSets(id);const top=hh.length?Math.max(...hh.map(p=>p.top)):0;return{id,name:currentOpt(id).name,top};}).filter(p=>p.top>0).sort((a,b)=>b.top-a.top).slice(0,8);
  const prRows=prs.length?prs.map((p,i)=>`<div class="prrow"><span class="rank">${i+1}</span><span class="pn">${p.name}</span><span class="pv">${WL(p.top)}</span></div>`).join(''):'<div class="legend">No loaded lifts recorded yet.</div>';
  const progEx=Object.keys(ALLEX).filter(id=>{const hh=historyTopSets(id);return hh.length>=2&&hh.some(p=>p.top>0);})
    .sort((a,b)=>historyTopSets(b).length-historyTopSets(a).length);
  const progSection= progEx.length?
    `<select class="progsel" id="progSel">${progEx.map(id=>`<option value="${id}">${currentOpt(id).name}</option>`).join('')}</select><div id="progChart"></div>`
    :'<div class="legend">Log any lift on two different days to chart its progression.</div>';
  return `
    <div class="ana-sec" style="margin-top:16px"><div class="ana-h">Sessions / week</div><div class="chartbox">${sessBar}<div class="legend">dashed line = your 4-session goal</div></div></div>
    <div class="ana-sec"><div class="ana-h">Volume / week (${unit()})</div><div class="chartbox">${volBar}<div class="legend">load × reps across all sets</div></div></div>
    <div class="ana-sec"><div class="ana-h">Lift progression</div>${progSection}</div>
    <div class="ana-sec"><div class="ana-h">Personal records (top set)</div>${prRows}</div>
    <div class="ana-sec"><div class="ana-h">Training split</div><div class="chartbox">${splitBar}<div class="legend">sessions logged per day type</div></div></div>`;
}

/* ================= AI coach ================= */
/* consecutive recent sessions stuck at the same top load without more reps */
function stallCount(id){
  const hist=state.logs.filter(l=>l.ex&&l.ex[id]&&working(l.ex[id]).length).sort((a,b)=>a.date<b.date?1:-1).slice(0,5)
    .map(l=>{ const w=working(l.ex[id]); const top=Math.max(...w.map(s=>+s.l||0)); return {top,reps:Math.max(...w.filter(s=>(+s.l||0)===top).map(s=>+s.r||0))}; });
  let n=0;
  for(let i=0;i+1<hist.length;i++){ if(hist[i].top>0&&hist[i].top===hist[i+1].top&&hist[i].reps<=hist[i+1].reps) n++; else break; }
  return n;
}
function buildCoachPayload(){
  const recent=[...state.logs].sort((a,b)=>a.date<b.date?-1:1).filter(l=>l.date>=addDays(todayStr(),-42)).slice(-20);
  const hist=recent.map(l=>({d:l.date,name:entryName(l),feel:l.feel||null,
    ex:Object.fromEntries(Object.entries(l.ex).map(([id,sets])=>[id,sets.map(s=>`${s.t==='w'?'W:':''}${s.l||0}x${s.r||0}${s.rpe?'@'+s.rpe:''}`).join(',')]))}));
  const ids=[...new Set(recent.flatMap(l=>Object.keys(l.ex)))];
  const exercises={};
  ids.forEach(id=>{ const info=window.Workout?Workout.exInfo(id):{muscle:''};
    exercises[id]={name:exName(id),muscle:info.muscle,sessions:state.logs.filter(l=>l.ex[id]).length,stall:stallCount(id),
      inRoutines:state.routines.filter(r=>r.exercises.some(e=>e.id===id)).map(r=>r.name)}; });
  const cis=[...state.checkins].sort((a,b)=>a.date<b.date?-1:1).slice(-8)
    .map(c=>({d:c.date,wt:c.weight,note:(c.note||'').slice(0,120),photo:!!c.photo}));
  const plan=state.settings.plan||{};
  return {today:todayStr(), profile:state.profile||{}, units:'lb',
    training:{sessionMinutes:+plan.minutes===SESSION_MIN?SESSION_MIN:SESSION_MAX,sessionLengthRule:'every session must fit 30–45 minutes',targetDaysPerWeek:plan.daysPerWeek||WEEK_TARGET,equipment:plan.equipment||'all',
      sessionsLast28Days:state.logs.filter(l=>l.date>=addDays(todayStr(),-27)).length},
    routines:state.routines.map(r=>({name:r.name,exercises:r.exercises.map(e=>exName(e.id)+' '+e.sets+'x'+(e.reps||''))})),
    mobilityDaysLast14:Object.keys(state.mobility||{}).filter(d=>daysBetween(d,todayStr())<=14).length,
    measurements:[...state.measurements].sort((a,b)=>a.date<b.date?-1:1).slice(-3),
    checkins:cis, exercises, history:hist};
}
async function runAICoach(){
  const btn=$('#aiBtn');
  if(state.logs.length<3){ toast('Log at least 3 sessions first so there\u2019s something to analyze'); return; }
  const payload=buildCoachPayload();
  const prompt=`You are a strength coach reviewing a lifter's training log. Analyze the data and recommend routine changes, personalized to their profile.

DATA: ${JSON.stringify(payload)}

Exercise sets are "loadxreps@RPE" in lb (W: = warm-up). Workouts are planned day by day from recovery, not a fixed program; "routines" are the lifter's saved templates. "stall" = consecutive recent sessions stuck at the same top load without more reps. "feel" is the lifter's session rating (easy/right/hard/brutal). "checkins" show bodyweight trend and weekly notes. If progress photos are attached, the OLDEST is first and the NEWEST is last — read only broad trends from them (posture, visible changes over weeks); never make critical comments about appearance, keep any physique observation brief, functional and encouraging.

Actions you may recommend per exercise:
- "add_load": progressing easily
- "reps": change rep strategy (e.g. add a rep per session) when dumbbell load jumps are too coarse
- "deload": drop ~10% and rebuild when grinding (feel=hard/brutal repeatedly, reps decaying)
- "swap": replace it with a better exercise for the same muscles when it has stalled 2+ sessions or conflicts with the profile (injuries/limitations) or goal. Set "swapTo" to a specific, conventional exercise name that suits the lifter's equipment.

Every session must fit 30–45 minutes — keep any routine change inside that.
Also weigh: injuries/limitations (avoid aggravating patterns), stated goal (hypertrophy vs strength emphasis), bodyweight trend vs goal, session feels (many "easy" = push harder; repeated "brutal" = rein in), training frequency vs target, muscle balance across the history, mobility consistency.

Max 6 recommendations, most important first, only exercises needing a change.

Respond with ONLY valid JSON, no markdown fences, no preamble:
{"summary":"2-3 sentence personalized assessment","recs":[{"id":"exercise_id from the data","action":"add_load|hold|reps|swap|deload","note":"one concise sentence why + what to do","swapTo":"exercise name (swap only)"}],"nextFocus":"one sentence on what to prioritize next week"}`;
  if(!API_AVAILABLE){
    $('#aiTtl').textContent='AI Coach'; $('#aiDt').textContent=prettyDate(todayStr());
    $('#aiBody').innerHTML=bridgeHTML(prompt,'coach');
    $('#aiScrim').classList.add('show');
    wireBridge(async txt=>{
      try{
        const result=parseCoachJSON(txt);
        state.aiCoach={date:todayStr(),result};
        await persist(); renderAICoach(result); renderAILast();
      }catch(e){ toast('That didn\u2019t look like the expected result — copy Claude\u2019s full reply'); }
    });
    return;
  }
  btn.disabled=true; btn.innerHTML='<span class="spin"></span> Analyzing your logs…';
  try{
    const content=[];
    const photos=[...state.checkins].filter(c=>c.photo).sort((a,b)=>a.date<b.date?-1:1);
    const pair=photos.length>1?[photos[0],photos[photos.length-1]]:photos.slice(0,1);
    pair.forEach(c=>{ const p=dataUrlParts(c.photo); if(p) content.push({type:'image',source:{type:'base64',media_type:p.media,data:p.b64}}); });
    content.push({type:'text',text:prompt});
    const text=await askAI(content,1000);
    const clean=text.replace(/```json|```/g,'').trim();
    const result=JSON.parse(clean);
    if(!result||typeof result.summary!=='string'||!Array.isArray(result.recs)) throw new Error('bad shape');
    state.aiCoach={date:todayStr(),result};
    await persist();
    renderAICoach(result);
  }catch(e){
    console.error('AI coach failed',e);
    $('#aiTtl').textContent='AI Coach'; $('#aiDt').textContent='';
    $('#aiBody').innerHTML=aiUnavailableHTML();
    $('#aiScrim').classList.add('show');
  }
  btn.disabled=false; btn.innerHTML='🧠 AI Coach — analyze my progress';
}
function renderAICoach(result){
  const ACTMETA={add_load:['add','↑ add load'],hold:['hold','hold'],reps:['reps','rep change'],swap:['swapc','⇄ swap'],deload:['deload','↓ deload'],new_exercise:['swapc','⇄ swap']};
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  $('#aiTtl').textContent='AI Coach';
  $('#aiDt').textContent=prettyDate(state.aiCoach&&state.aiCoach.date||todayStr());
  const known=id=>!!(ALLEX[id]||(typeof LIBRARY!=='undefined'&&LIBRARY[id])||state.customEx[id]);
  const recs=(result.recs||[]).slice(0,6).filter(r=>r&&known(r.id));
  const rows=recs.map((r,i)=>{
    const [cls,label]=ACTMETA[r.action]||['hold',esc(r.action)];
    const to=r.swapTo||r.newName;
    const inR=state.routines.filter(x=>x.exercises.some(e=>e.id===r.id)).length;
    const apply=(r.action==='swap'||r.action==='new_exercise')&&to&&inR
      ?`<button class="applybtn" data-aswap="${i}">Apply — use ${esc(to)} in ${inR} routine${inR>1?'s':''}</button>`:'';
    return `<div class="ai-rec"><div class="rh"><span class="rn2">${esc(exName(r.id))}</span><span class="chip ${cls}">${label}</span></div><div class="note">${esc((r.note||'').slice(0,220))}</div>${apply}</div>`;
  }).join('');
  $('#aiBody').innerHTML=`<div class="ai-sum">${esc((result.summary||'').slice(0,500))}</div>`+
    (rows||'<div class="legend">No changes needed — keep training the way you are.</div>')+
    (result.nextFocus?`<div class="ai-sum" style="margin-top:12px"><b style="color:var(--steel)">Next week:</b> ${esc((result.nextFocus||'').slice(0,300))}</div>`:'');
  $('#aiBody').querySelectorAll('[data-aswap]').forEach(b=>{
    b.onclick=async()=>{
      const r=recs[+b.dataset.aswap], name=String(r.swapTo||r.newName).trim().slice(0,60);
      const old=window.Workout?Workout.exInfo(r.id):{muscle:'Full body',equip:'Other',type:'wr'};
      let target=window.Workout&&Workout.allExercises().find(e=>e.name.toLowerCase()===name.toLowerCase());
      if(!target){ const id='cx_'+Date.now().toString(36); target=state.customEx[id]={id,name,muscle:old.muscle,equip:old.equip,type:old.type||'wr',secondary:[],custom:true}; }
      state.routines.forEach(x=>x.exercises.forEach(e=>{ if(e.id===r.id) e.id=target.id; }));
      await persist(); if(window.Workout) Workout.renderHome();
      b.disabled=true; b.textContent='✓ Applied to routines';
    };
  });
  $('#aiScrim').classList.add('show');
}
function closeAI(){$('#aiScrim').classList.remove('show');}

/* ================= profile & weekly check-in ================= */
async function saveProfile(){
  state.settings.units=$('#pfUnits').value==='kg'?'kg':'lb';
  state.profile={age:$('#pfAge').value.trim(),height:$('#pfHt').value.trim(),sex:$('#pfSex').value,
    goal:$('#pfGoal').value,injuries:$('#pfInj').value.trim(),notes:$('#pfNotes').value.trim()};
  if(await persist()){ toast('Profile saved'); renderCoach(); renderYou(); if(window.Workout) Workout.renderHome(); }
}
let pendingCiPhoto=null;
async function pickCiPhoto(f){
  try{ pendingCiPhoto=await compressImage(f,720); $('#ciPhotoBtn').textContent='✓ Photo added'; }
  catch(e){ toast('Couldn\u2019t read that image'); }
}
async function saveCheckin(){
  const wt=$('#ciWt').value.trim(); const note=$('#ciNote').value.trim();
  if(!wt&&!pendingCiPhoto&&!note){ toast('Add a weight, photo, or note first'); return; }
  state.checkins.push({date:todayStr(),weight:wt?+toLb(wt):null,note,photo:pendingCiPhoto});
  // keep photos bounded: strip photos beyond the last 10 check-ins
  const withPhotos=state.checkins.filter(c=>c.photo);
  if(withPhotos.length>10) withPhotos.slice(0,withPhotos.length-10).forEach(c=>{delete c.photo;});
  const ok=await persist();
  if(!ok){ // likely quota: drop oldest photo and retry once
    const oldest=state.checkins.find(c=>c.photo);
    if(oldest){ delete oldest.photo; if(await persist()) toast('Saved — oldest photo removed to fit storage'); }
  } else toast('Check-in logged');
  $('#ciWt').value=''; $('#ciNote').value=''; pendingCiPhoto=null; $('#ciPhotoBtn').textContent='＋ Add photo';
  renderCheckins();
}
function renderCheckins(){
  const list=[...state.checkins].sort((a,b)=>a.date<b.date?1:-1).slice(0,8);
  $('#ciList').innerHTML=list.map(c=>{
    const idx=state.checkins.indexOf(c);
    return `<div class="cirow">${c.photo?`<img src="${c.photo}" alt="">`:''}
      <div class="cim">${c.date}${c.weight?` · <b>${WL(c.weight)}</b>`:''}${c.note?`<br>${c.note.slice(0,80)}`:''}</div>
      <button class="del" data-cidel="${idx}">✕</button></div>`;
  }).join('')||'<div class="legend">No check-ins yet. One per week is plenty.</div>';
  $('#ciList').querySelectorAll('[data-cidel]').forEach(b=>{
    b.onclick=async()=>{ state.checkins.splice(+b.dataset.cidel,1); await persist(); renderCheckins(); };
  });
}

/* ================= feel rating ================= */
const FEELS=[['easy','Easy 😴'],['right','Just right 💪'],['hard','Hard 🥵'],['brutal','Brutal 🆘']];
function renderFeelRow(entry){
  $('#feelRow').innerHTML=FEELS.map(([k,l])=>`<button class="feel${entry.feel===k?' sel':''}" data-feel="${k}">${l}</button>`).join('');
  $('#feelRow').querySelectorAll('[data-feel]').forEach(b=>{
    b.onclick=async()=>{ entry.feel=b.dataset.feel; await persist(); renderFeelRow(entry); };
  });
}

/* ================= shared AI request ================= */
let API_AVAILABLE = (typeof window!=='undefined') && /(^|\.)claude\.(ai|com)$/.test(location.hostname||'');
let claudeSample=null;
async function initSample(){
  if(!HOSTED) return;
  try{ const fn=await window.claude.use('sample'); if(fn){ claudeSample=fn; API_AVAILABLE=true; } }catch(e){}
}
function b64ToBlob(b64,type){ const bin=atob(b64), u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return new Blob([u],{type}); }
async function askAI(content,maxTokens){
  if(claudeSample){
    const text=content.filter(b=>b.type==='text').map(b=>b.text).join('\n\n');
    const images=content.filter(b=>b.type==='image'&&b.source&&b.source.data).map(b=>b64ToBlob(b.source.data,b.source.media_type));
    try{ const r=await claudeSample(text,images.length?{images}:{}); return r.text; }
    catch(e){ throw new Error((e&&e.code)||'sample failed'); }
  }
  const response=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:maxTokens||1000,messages:[{role:'user',content}]})
  });
  const data=await response.json();
  if(data.error) throw new Error(data.error.message||'api error');
  return (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
}
/* ===== Claude bridge: no server, no API key — copy prompt out, paste reply back ===== */
let bridgePrompt='';
function bridgeHTML(promptText,kind){
  bridgePrompt=promptText;
  return `<div class="ai-sum"><b>Analyze in the Claude app</b><br>
    1 · Tap <b>Copy prompt</b> below<br>
    2 · Open Claude, paste, and send<br>
    3 · Copy Claude's whole reply, come back and tap <b>Paste result</b></div>
    <button class="applybtn" id="brCopy" style="width:100%;height:46px;margin-bottom:8px">📋 Copy prompt</button>
    <button class="dbtn" id="brPaste" style="width:100%;height:46px">📥 Paste Claude's result</button>
    <textarea id="brBox" class="brbox" placeholder="…or paste Claude's reply here"></textarea>
    <button class="dbtn" id="brApply" style="width:100%;height:44px;margin-top:8px">Use this result</button>
    <div class="legend" style="margin-top:8px">Nothing is uploaded from this app — you carry the text across yourself.</div>`;
}
function wireBridge(onResult){
  const copy=async()=>{
    try{ await navigator.clipboard.writeText(bridgePrompt); toast('Prompt copied — paste it into Claude'); }
    catch(e){ const b=$('#brBox'); b.value=bridgePrompt; b.select(); toast('Select the text above and copy'); }
  };
  $('#brCopy').onclick=copy;
  $('#brPaste').onclick=async()=>{
    try{ const txt=await navigator.clipboard.readText(); if(txt){ $('#brBox').value=txt; onResult(txt); } else toast('Clipboard is empty'); }
    catch(e){ toast('Paste into the box below, then tap Use this result'); }
  };
  $('#brApply').onclick=()=>{ const v=$('#brBox').value.trim(); if(v) onResult(v); else toast('Paste Claude\u2019s reply first'); };
}
function parseCoachJSON(text){
  let t=String(text).replace(/```json|```/g,'').trim();
  const a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a>=0&&b>a) t=t.slice(a,b+1);
  const r=JSON.parse(t);
  if(!r||typeof r.summary!=='string'||!Array.isArray(r.recs)) throw new Error('bad shape');
  return r;
}
function aiUnavailableHTML(){
  return `<div class="ai-sum">Couldn\u2019t reach the AI coach${navigator.onLine===false?' — you appear to be offline':''}. AI features work when the tracker runs inside Claude; on a self-hosted copy they aren\u2019t available.<br><br>The built-in rule engine still flags load increases automatically.</div>`;
}

/* ================= AI form check (video) ================= */
let fcExId=null;
function startFormCheck(exId){ fcExId=exId; $('#fcFile').click(); }
/* pure helper: sample timestamps across a clip (8%..92%), unit-testable */
function frameTimes(dur,count){
  count=Math.max(1,count|0);
  const out=[];
  for(let i=0;i<count;i++){ out.push(dur*(0.08+0.84*(count===1?0.5:i/(count-1)))); }
  return out;
}
/* sample N JPEG frames evenly across a video file, on-device; nothing is stored.
   iOS Safari needs: element in DOM, preload=auto + load(), a muted play/pause kick,
   and a paint-wait after each seek before drawing to canvas. */
function extractFrames(file,count){
  // strategy 1: blob URL. strategy 2: base64 data URL (sandboxes sometimes block blob: media)
  return extractFramesFrom(URL.createObjectURL(file),true,count).catch(async e1=>{
    if(file.size>30*1024*1024){ e1.stage=(e1.stage||'load')+' (file >30MB, dataURL retry skipped)'; throw e1; }
    try{ const durl=await fileToDataURL(file); return await extractFramesFrom(durl,false,count); }
    catch(e2){ e2.stage='retry-'+(e2.stage||'load')+' after '+(e1.stage||'load'); throw e2; }
  });
}
function extractFramesFrom(src,isBlob,count){
  count=count||5;
  return new Promise((res,rej)=>{
    const url=src;
    const v=document.createElement('video');
    v.muted=true; v.defaultMuted=true; v.playsInline=true;
    v.setAttribute('muted',''); v.setAttribute('playsinline','');
    v.preload='auto'; v.src=url;
    v.style.cssText='position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(v);
    let done=false;
    const cleanup=()=>{ if(done) return; done=true; try{v.pause();}catch(e){} try{v.remove();}catch(e){} if(isBlob) try{URL.revokeObjectURL(url);}catch(e){} };
    const fail=(e,stage)=>{ const err=e||new Error('video decode failed'); if(stage&&!err.stage) err.stage=stage; cleanup(); rej(err); };
    const timer=setTimeout(()=>fail(new Error('timeout'),'load-timeout'),25000);
    const once=(ev)=>new Promise(r=>{ const f=()=>{v.removeEventListener(ev,f);r();}; v.addEventListener(ev,f); });
    const paintWait=()=>new Promise(r=>{
      if(v.requestVideoFrameCallback){ let fired=false; v.requestVideoFrameCallback(()=>{fired=true;r();}); setTimeout(()=>{if(!fired)r();},300); }
      else setTimeout(r,180);
    });
    const seekTo=async t=>{
      for(let attempt=0;attempt<2;attempt++){
        try{
          await new Promise((r2,j2)=>{
            const to=setTimeout(()=>j2(new Error('seek timeout')),8000);
            const f=()=>{clearTimeout(to);v.removeEventListener('seeked',f);r2();};
            v.addEventListener('seeked',f);
            v.currentTime=Math.max(0.05,t);
          });
          await paintWait();
          return;
        }catch(e){ if(attempt===1) throw e; }
      }
    };
    v.onerror=()=>{clearTimeout(timer);const me=v.error;fail(new Error('mediaError code '+(me?me.code:'?')+(me&&me.message?' '+me.message:'')),'element-error');};
    (async()=>{
      try{
        v.load();
        if(v.readyState<1) await once('loadedmetadata');
        // some recordings report Infinity until forced to the end
        if(!isFinite(v.duration)||v.duration<=0){
          v.currentTime=1e7; await once('seeked').catch(()=>{});
        }
        const dur=isFinite(v.duration)&&v.duration>0 ? v.duration : 10;
        if(v.readyState<2){ await Promise.race([once('canplay'),new Promise(r=>setTimeout(r,4000))]); }
        // kick the decoder (allowed: muted + playsinline, inside the file-pick gesture chain)
        try{ await v.play(); await new Promise(r=>setTimeout(r,120)); v.pause(); }catch(e){}
        const W=v.videoWidth||640, H=v.videoHeight||480;
        const sc=Math.min(1,640/Math.max(W,H));
        const c=document.createElement('canvas');
        c.width=Math.max(2,Math.round(W*sc)); c.height=Math.max(2,Math.round(H*sc));
        const ctx=c.getContext('2d');
        const frames=[];
        for(const t of frameTimes(dur,count)){
          await seekTo(t);
          ctx.drawImage(v,0,0,c.width,c.height);
          frames.push(c.toDataURL('image/jpeg',0.65));
        }
        clearTimeout(timer); cleanup(); res(frames);
      }catch(e){ clearTimeout(timer); fail(e, e&&/seek/i.test(String(e.message))?'seek':'decode'); }
    })();
  });
}
async function runFormCheck(file){
  const exId=fcExId; fcExId=null; if(!exId) return;
  const name=exName(exId);
  if(!API_AVAILABLE){ showFormBridge(name); return; }
  $('#aiTtl').textContent='Form check'; $('#aiDt').textContent=name;
  $('#aiBody').innerHTML='<div class="ai-sum"><span class="spin"></span> Watching your '+name+' set… (sampling frames from your video)</div>';
  $('#aiScrim').classList.add('show');
  try{
    let frames;
    if(file.type.startsWith('video/')){
      frames=await extractFrames(file,5);
    }else{ // graceful fallback if a photo is picked anyway
      frames=[await compressImage(file,900)];
    }
    const content=frames.map(f=>{const p=dataUrlParts(f);return {type:'image',source:{type:'base64',media_type:p.media,data:p.b64}};});
    const inj=(state.profile&&state.profile.injuries)?` Lifter has noted: ${state.profile.injuries}.`:'';
    const multi=frames.length>1;
    content.push({type:'text',text: multi
      ? `These ${frames.length} images are chronological frames sampled evenly from a video of me performing ${name} (first = start of clip, last = end).${inj} As a strength coach, analyze the movement across the sequence: 1) what looks good, 2) the single most important correction and exactly how to fix it, 3) any injury-risk red flags (spine position, joint tracking, bar/dumbbell path, range of motion). Note tempo/position changes you can infer between frames. Be concise (under 200 words) and practical. Mention that sampled frames can miss moments between them. If the frames don't clearly show the exercise, say so instead of guessing.`
      : `This is a single photo of me performing ${name}.${inj} As a strength coach, assess what's visible: what looks good, the most important correction, any injury risk. Under 150 words; note one frame can't show the full movement. If unclear, say so instead of guessing.`});
    const text=await askAI(content,800);
    $('#aiBody').innerHTML=`<div class="ai-sum" style="white-space:pre-wrap">${text.slice(0,1800)}</div><div class="legend" style="margin-top:8px">Analyzed ${frames.length} frame${frames.length>1?'s':''} sampled from your video · nothing was saved</div>`;
  }catch(e){
    console.error('form check failed',e);
    const vidErr = e&&(e.stage||/video|seek|duration|decode|timeout|mediaError/i.test(String(e.message||e)));
    if(vidErr){
      const diag=`${e.stage||'decode'} · ${String(e.message||e).slice(0,90)} · ${file.type||'?'} · ${(file.size/1048576).toFixed(1)}MB`;
      $('#aiBody').innerHTML=`<div class="ai-sum">Couldn\u2019t decode that video in this viewer.<br><br>
        <b>No problem — use photos instead:</b> pick 2\u20134 photos of your set (setup, bottom, lockout) and I\u2019ll analyze those.</div>
        <button class="applybtn" id="fcPhotoFallback" style="width:100%;height:46px">📷 Analyze photos instead</button>
        <div class="legend" style="margin-top:10px">debug: ${diag}</div>`;
      $('#fcPhotoFallback').onclick=()=>{ fcExId=exId; $('#fcImgFile').click(); };
    } else {
      $('#aiBody').innerHTML=aiUnavailableHTML();
    }
  }
}
/* photo fallback: analyze up to 4 stills as a sequence */
function showFormBridge(name){
  const inj=(state.profile&&state.profile.injuries)?` I've noted: ${state.profile.injuries}.` : '';
  const p=`I'm going to share a video (or photos) of my ${name}.${inj} As a strength coach, tell me: 1) what looks good, 2) the single most important correction and exactly how to fix it, 3) any injury-risk red flags (spine position, joint tracking, bar path, range of motion). Keep it under 200 words and practical.`;
  $('#aiTtl').textContent='Form check'; $('#aiDt').textContent=name;
  $('#aiBody').innerHTML=`<div class="ai-sum"><b>Form check in the Claude app</b><br>
    Claude reads video directly, so this works best there:<br>
    1 · Tap <b>Copy prompt</b><br>
    2 · Open Claude, attach your video or photos, paste the prompt, send</div>
    <button class="applybtn" id="brCopy" style="width:100%;height:46px">📋 Copy prompt</button>
    <textarea id="brBox" class="brbox" style="min-height:80px"></textarea>
    <div class="legend" style="margin-top:6px">Your video stays in your camera roll — you attach it in Claude yourself.</div>`;
  bridgePrompt=p;
  $('#brCopy').onclick=async()=>{ try{ await navigator.clipboard.writeText(p); toast('Prompt copied'); }catch(e){ $('#brBox').value=p; toast('Select and copy the text'); } };
  $('#aiScrim').classList.add('show');
}
async function runFormCheckPhotos(files){
  const exId=fcExId; fcExId=null; if(!exId||!files.length) return;
  const name=exName(exId);
  if(!API_AVAILABLE){ showFormBridge(name); return; }
  $('#aiTtl').textContent='Form check'; $('#aiDt').textContent=name;
  $('#aiBody').innerHTML='<div class="ai-sum"><span class="spin"></span> Analyzing your '+name+' photos\u2026</div>';
  $('#aiScrim').classList.add('show');
  try{
    const picks=[...files].slice(0,4);
    const frames=[];
    for(const f of picks) frames.push(await compressImage(f,900));
    const content=frames.map(f=>{const p=dataUrlParts(f);return {type:'image',source:{type:'base64',media_type:p.media,data:p.b64}};});
    const inj=(state.profile&&state.profile.injuries)?` Lifter has noted: ${state.profile.injuries}.`:'';
    content.push({type:'text',text:`These ${frames.length} photos show different moments of me performing ${name}, in the order provided.${inj} As a strength coach: 1) what looks good, 2) the single most important correction and exactly how to fix it, 3) any injury-risk red flags (spine position, joint tracking, bar/dumbbell path, range of motion). Under 200 words, practical. Note that stills can miss moments between them. If the photos don't clearly show the exercise, say so instead of guessing.`});
    const text=await askAI(content,800);
    $('#aiBody').innerHTML=`<div class="ai-sum" style="white-space:pre-wrap">${text.slice(0,1800)}</div><div class="legend" style="margin-top:8px">Analyzed ${frames.length} photo${frames.length>1?'s':''} \u00b7 nothing was saved</div>`;
  }catch(e){ console.error('photo form check failed',e); $('#aiBody').innerHTML=aiUnavailableHTML(); }
}

/* ---------- wire up ---------- */
$('#rvClose').onclick=closeReview;
$('#scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') closeReview(); });
$('#expBtn').onclick=exportData;
$('#impBtn').onclick=()=>$('#impFile').click();
$('#copyBtn').onclick=copyBackup;
$('#pasteBtn').onclick=pasteBackup;
$('#impFile').onchange=e=>{ if(e.target.files[0]) importData(e.target.files[0]); e.target.value=''; };
$('#aiBtn').onclick=runAICoach;
$('#aiClose').onclick=closeAI;
$('#aiScrim').addEventListener('click',e=>{ if(e.target.id==='aiScrim') closeAI(); });
document.querySelectorAll('.nbtn').forEach(b=>{ b.onclick=()=>showView(b.dataset.view); });
/* keep --nav-h equal to the tab bar's real height (safe-area insets, font loading, the viewer's frame) */
(function trackNav(){
  const nav=document.querySelector('.bnav'); if(!nav) return;
  const set=()=>{ const hgt=nav.offsetHeight; if(hgt) document.documentElement.style.setProperty('--nav-h',hgt+'px'); };
  set(); window.addEventListener('resize',set);
  if(window.ResizeObserver) new ResizeObserver(set).observe(nav,{box:'border-box'});   // insets are padding: watch the whole box
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(set);
})();
$('#gstrip').style.cursor='pointer';
$('#gstrip').onclick=()=>showView('stats');
$('#pfSave').onclick=saveProfile;
$('#ciPhotoBtn').onclick=()=>$('#ciFile').click();
$('#ciFile').onchange=e=>{ if(e.target.files[0]) pickCiPhoto(e.target.files[0]); e.target.value=''; };
$('#ciSave').onclick=saveCheckin;
$('#fcFile').onchange=e=>{ if(e.target.files[0]) runFormCheck(e.target.files[0]); e.target.value=''; };
$('#fcImgFile').onchange=e=>{ if(e.target.files.length) runFormCheckPhotos(e.target.files); e.target.value=''; };

/* PWA: register the service worker so the app opens offline */
try{
  if(!HOSTED && location.protocol.startsWith('http') && 'serviceWorker' in navigator){
    window.addEventListener('load',()=>{ try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){} });
  }
}catch(e){}

window.appReady=(async function init(){
  if(HOSTED&&window.IronAuth){ try{ await IronAuth.ensure(); }catch(e){ console.error('sign-in failed',e); } }
  initSample();
  try{ await load(); }
  catch(e){
    console.error('load failed, continuing with a safe state',e);
    try{ state=sanitize(state); }catch(e2){ state=blankState(); }
    bootLoaded=true;
  }
  const safe=(name,fn)=>{ try{ fn(); }catch(e){ console.error('render failed:',name,e); } };
  safe('banner',renderStorageBanner);
  safe('account',()=>window.IronAuth&&IronAuth.renderCard());
  try{ await offerDeviceImport(); }catch(e){ console.warn('device import check failed',e); }
  safe('coach',renderCoach);
  safe('gamify',renderGamify);
  safe('view',()=>showView('train'));
  if(!STORAGE_OK()) console.warn('Iron Log: no persistent storage (mode='+storageMode+')');
})().catch(bootError);

function bootError(e){ console.error("Iron Log boot error", e); }

