/* js/planner.js */
/* ================= Planner: today's workout =================
   Two sources for the same plan shape:
     • auto   — built here from recovery, history, goal and progression rules (instant, offline)
     • ai     — an AI writes it: the app hands over a prompt with all the context and the user pastes the
                AI's JSON reply back, or, with an AI provider set up, it calls askAI directly
   Plan: {title, focus, why, durationMin, warmup, rest?, exercises:[{id, sets:[{t,reps,load,rpe}], rest, ss, note}], routineUpdates:[...]}
   Stored as state.aiPlan = {date, source, plan, adjust, done, applied:[]} */
(function(){
const h=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAY=86400000;
const ADJUST={short:'⚡ Shorter',easy:'😮‍💨 Low energy',hard:'💪 Feeling strong',other:'🔀 Different focus'};
const GROUPS={
  push:{name:'Push',muscles:['Chest','Shoulders','Triceps']},
  pull:{name:'Pull',muscles:['Back','Biceps']},
  legs:{name:'Legs',muscles:['Quads','Hamstrings','Glutes','Calves']},
  upper:{name:'Upper body',muscles:['Chest','Back','Shoulders','Biceps','Triceps']},
  lower:{name:'Lower body',muscles:['Quads','Hamstrings','Glutes','Calves']},
  full:{name:'Full body',muscles:['Quads','Chest','Back','Hamstrings','Shoulders']},
};
const BIG=new Set(['Chest','Back','Quads']);
const SMALL=new Set(['Biceps','Triceps','Forearms','Calves','Core']);
const isCompound=e=>(e.secondary||[]).length>0&&!SMALL.has(e.muscle);
/* the offline planner's injury guard: keywords in the profile → movements it won't pick (the AI reasons about injuries itself) */
const INJURY_AVOID={
  shoulder:['db_ohp','bb_ohp','sm_ohp','mc_ohp','arnold','upright','dip','dip_chest','bench_dip','front_raise','skull_ez'],
  knee:['sissy','bss','walk_lunge','rev_lunge','stepup','sm_split','legext','front_squat','hack','pend_squat','burpee','jump_rope'],
  back:['bb_dl','good_morning','bb_row','pendlay','bb_squat','sumo_dl','tbar','clean','bb_rdl','kb_swing'],
  elbow:['skull_db','skull_ez','oh_tri','oh_cable','cg_bench','dip','bench_dip'],
  wrist:['front_squat','clean','pushup','wrist_curl','rev_curl'],
};
function injuryAvoid(){
  const t=String((state.profile&&state.profile.injuries)||'').toLowerCase(), out=new Set(), hit=[];
  Object.entries(INJURY_AVOID).forEach(([k,ids])=>{ if(t.includes(k)||(k==='back'&&/lower back|spine|disc/.test(t))){ hit.push(k); ids.forEach(i=>out.add(i)); } });
  return {ids:out,hit};
}

/* ---------- settings ---------- */
function settings(){
  const p=state.settings.plan||{};
  return {
    minutes:+p.minutes>0&&+p.minutes<=SESSION_MIN?SESSION_MIN:SESSION_MAX,   // sessions are 30 or 45 min — older 60–90 settings become 45
    daysPerWeek:Math.min(6,Math.max(2,+p.daysPerWeek||4)),
    equipment:Array.isArray(p.equipment)&&p.equipment.length?p.equipment.filter(e=>EQUIPMENT.includes(e)):[...EQUIPMENT],
  };
}
function goalKind(){
  const g=String((state.profile&&state.profile.goal)||'').toLowerCase();
  return g.includes('strength')?'strength':g.includes('fat')?'cut':g.includes('general')?'general':'muscle';
}

/* ---------- history helpers ---------- */
const sortedLogs=()=>[...state.logs].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:(a.start||0)-(b.start||0));
function muscleLastTrained(){
  const m={};
  sortedLogs().forEach(l=>Object.entries(l.ex).forEach(([id,sets])=>{
    if(!working(sets).length||isYoga(id)) return;   // yoga doesn't use up lifting recovery
    m[Workout.exInfo(id).muscle]=l.date;      // recovery follows the primary muscle only
  }));
  return m;
}
function weeklySets(){
  const cut=addDays(todayStr(),-6), m={};
  state.logs.filter(l=>l.date>=cut).forEach(l=>Object.entries(l.ex).forEach(([id,sets])=>{
    if(isYoga(id)) return;
    const info=Workout.exInfo(id), n=working(sets).length;
    m[info.muscle]=(m[info.muscle]||0)+n; (info.secondary||[]).forEach(k=>{ m[k]=(m[k]||0)+n*0.5; });
  }));
  return m;
}
const daysSince=d=>d?Math.max(0,daysBetween(d,todayStr())):99;
function lastWorking(id){
  const l=sortedLogs().reverse().find(x=>x.ex[id]&&working(x.ex[id]).length);
  return l?{date:l.date,sets:working(l.ex[id]),feel:l.feel}:null;
}

/* ---------- adaptive auto plan ---------- */
function repScheme(compound){
  return {strength:compound?[4,4,6]:[3,8,10], muscle:compound?[3,6,10]:[3,10,15], cut:compound?[3,8,12]:[3,12,15], general:compound?[3,8,12]:[3,10,12]}[goalKind()];
}
/* progression in the user's unit (so jumps are real plate/dumbbell steps), returned in stored lb */
function nextLoad(id,lo,hi){
  const last=lastWorking(id); if(!last) return {load:null,note:''};
  const topLb=Math.max(0,...last.sets.map(s=>+s.l||0)); if(!topLb) return {load:null,note:''};
  const reps=last.sets.map(s=>+s.r||0);
  const kg=unit()==='kg', top=+W(topLb), info=Workout.exInfo(id);
  const inc=kg?(info.equip==='Dumbbell'?2:top>=45?5:2.5):(info.equip==='Dumbbell'?5:top>=100?10:5);
  const step=kg?1.25:5;
  if(reps.length&&reps.every(r=>r>=hi)) return {load:+toLb(top+inc),note:`+${inc} ${unit()} — you hit ${hi}+ on every set last time`};
  if(reps.some(r=>r<lo)&&(last.feel==='brutal'||last.feel==='hard')) return {load:+toLb(Math.round(top*0.9/step)*step),note:'−10% to rebuild clean reps'};
  return {load:topLb,note:''};
}
/* lifts whose last session earned more weight — the Coach panel lists these */
function readyList(){
  if(!window.Workout) return [];
  const cut=addDays(todayStr(),-28);
  const ids=[...new Set(state.logs.filter(l=>l.date>=cut).flatMap(l=>Object.keys(l.ex)))];
  return ids.map(id=>{
    const info=Workout.exInfo(id); if(!['wr','bw'].includes(info.type)) return null;   // timed/cardio progress by time, not load
    const [,lo,hi]=repScheme(isCompound(info));
    const last=lastWorking(id); if(!last) return null;
    const from=Math.max(0,...last.sets.map(s=>+s.l||0));
    if(!from||!last.sets.every(s=>(+s.r||0)>=hi)) return null;
    return {id,date:last.date,from,to:nextLoad(id,lo,hi).load};
  }).filter(Boolean).sort((a,b)=>a.date<b.date?1:-1);
}
function dateSeed(){ return todayStr().split('-').reduce((a,b)=>a*31+(+b),7); }
function pickExercises(muscle,count,usedIds,lastGroupIds,eq){
  const seed=dateSeed(), avoid=injuryAvoid().ids;
  return Workout.allExercises()
    .filter(e=>e.muscle===muscle&&!isYoga(e.id)&&!usedIds.has(e.id)&&!avoid.has(e.id)&&(planKind()==='home'?homeOk(e):(eq.includes(e.equip)||e.equip==='Bodyweight'))&&e.type!=='cardio'&&(!['dur','wd'].includes(e.type)||muscle==='Core'))
    .map(e=>{ const n=Math.min(10,state.logs.filter(l=>l.ex[e.id]).length);
      const compound=isCompound(e);
      const score=n*2+(compound?3:0)-(lastGroupIds.has(e.id)?3:0)+((seed+e.id.length*7)%5)/10;
      return {e,score,compound}; })
    .sort((a,b)=>b.score-a.score).slice(0,count);
}
function chooseGroup(adjust){
  const st=settings(), last=muscleLastTrained(), wk=weeklySets();
  const keys=st.daysPerWeek<=3?['full']:st.daysPerWeek===4?['upper','lower']:['push','pull','legs'];
  const ranked=keys.map(k=>{ const ms=GROUPS[k].muscles;
    const rec=ms.reduce((a,m)=>a+Math.min(7,daysSince(last[m])),0)/ms.length;
    const deficit=ms.reduce((a,m)=>a+Math.max(0,10-(wk[m]||0)),0)/ms.length/10;
    return {k,score:rec+deficit,rec}; }).sort((a,b)=>b.score-a.score);
  return adjust==='other'&&ranked[1]?ranked[1]:ranked[0];
}
function autoPlan(adjust){
  const st=settings(), last=muscleLastTrained();
  const recent=sortedLogs().slice(-2);
  const tired=adjust==='easy'||(recent.length===2&&recent.every(l=>l.feel==='hard'||l.feel==='brutal'));
  const strong=adjust==='hard';
  const minutes=adjust==='short'?Math.min(30,st.minutes):st.minutes;
  const g=chooseGroup(adjust), grp=GROUPS[g.k];
  const nEx=minutes>=SESSION_MAX?4:3;   // + a core move; supersets keep it inside 30–45 min
  const lastSameGroup=sortedLogs().reverse().find(l=>l.plan&&l.plan.group===g.k);
  const lastIds=new Set(lastSameGroup?Object.keys(lastSameGroup.ex):[]);
  const used=new Set(), picks=[];
  // first pass: one per muscle (compounds first for big muscles), second pass: extra for big muscles
  grp.muscles.forEach(m=>pickExercises(m,1,used,lastIds,st.equipment).forEach(p=>{ used.add(p.e.id); picks.push({...p,m}); }));
  grp.muscles.filter(m=>BIG.has(m)).forEach(m=>{ if(picks.length<nEx) pickExercises(m,1,used,lastIds,st.equipment).forEach(p=>{ used.add(p.e.id); picks.push({...p,m}); }); });
  if(picks.length<nEx+1) pickExercises('Core',1,used,lastIds,st.equipment).forEach(p=>{ used.add(p.e.id); picks.push({...p,m:'Core'}); });
  const ordered=picks.slice(0,nEx+1).sort((a,b)=>(a.m==='Core')-(b.m==='Core')||(b.compound-a.compound));
  const notes=[];
  const exercises=ordered.map((p,i)=>{
    const [S0,lo,hi]=repScheme(p.compound&&p.m!=='Core');
    const dur=p.e.type==='dur'||p.e.type==='wd';
    let S=S0+(strong&&p.compound?1:0)-(tired?1:0); S=Math.max(2,S);
    // carries progress load once every hold reaches 45s; plain holds have no load
    const nl=p.e.type==='dur'?{load:null,note:''}:p.e.type==='wd'?nextLoad(p.e.id,30,45):nextLoad(p.e.id,lo,hi);
    if(nl.note) notes.push(`${p.e.name} ${nl.note}`);
    const rpe=tired?7:strong?9:p.compound?8:8.5;
    const reps=dur?'30-45':`${lo}-${hi}`;
    const sets=[];
    if(i===0&&nl.load&&nl.load>=40&&!dur){ const st=unit()==='kg'?1.25:5; sets.push({t:'w',reps:'10',load:+toLb(Math.round(+W(nl.load)*0.5/st)*st),rpe:null}); }
    for(let k=0;k<S;k++) sets.push({t:'n',reps,load:nl.load,rpe});
    const rest=p.m==='Core'?45:p.compound?(goalKind()==='strength'?180:120):75;
    return {id:p.e.id,sets,rest,ss:false,note:nl.note};
  });
  // short sessions: superset trailing isolation pairs to save time
  if(minutes<=45) for(let i=1;i+1<exercises.length;i+=2){ const a=Workout.exInfo(exercises[i].id), b=Workout.exInfo(exercises[i+1].id);
    if(!isCompound(a)&&!isCompound(b)) exercises[i].ss=true; }
  const recTxt=grp.muscles.map(m=>`${m.toLowerCase()} ${daysSince(last[m])>=99?'not trained yet':daysSince(last[m])+'d ago'}`).slice(0,3).join(', ');
  const thisWeek=state.logs.filter(l=>weekStartTs(l.date)===weekStartTs(todayStr())).length;
  const rest=thisWeek>=st.daysPerWeek||consecutiveDays()>=3;
  const inj=injuryAvoid().hit;
  const why=[`${grp.name} is the most recovered (${recTxt}).`,
    inj.length?`Skipping movements that load your ${inj.join(' & ')}.`:'',
    tired?'Recent sessions felt hard, so volume and effort are dialed back.':strong?'You’re feeling strong — an extra set on the big lifts.':'',
    notes.slice(0,2).join('. ')+(notes.length?'.':'')].filter(Boolean).join(' ');
  const sets=exercises.reduce((n,e)=>n+e.sets.length,0);
  return fitTime({kind:'strength',title:grp.name+(tired?' · recovery':''),focus:grp.name,group:g.k,why,durationMin:minutes,
    warmup:'5 min easy cardio, then dynamic stretches for '+grp.muscles.slice(0,2).join(' & ').toLowerCase()+'.',
    restSuggested:rest,exercises,routineUpdates:[],setsTotal:sets},minutes);
}
/* ---------- session length guard: every plan lands in 30–45 min ---------- */
function estMinutes(p){
  if(p.kind==='yoga') return Math.round(p.exercises.reduce((t,e)=>t+e.sets.reduce((a,s)=>a+(parseInt(s.reps)||30)+YOGA_TRANSITION,0),0)/60);
  let sec=5*60;   // warm-up
  p.exercises.forEach((e,i)=>{ const paired=e.ss||(i>0&&p.exercises[i-1].ss);
    e.sets.forEach(s=>{ const work=Workout.measure(e.id).timed?(parseInt(String(s.reps).split('-').pop())||40):45;
      sec+=work+(s.t==='w'?45:paired?e.rest/2:e.rest); }); });
  return Math.round(sec/60);
}
function fitTime(p,target){
  const cap=Math.min(SESSION_MAX,Math.max(SESSION_MIN,target||SESSION_MAX));
  if(p.kind==='yoga'){
    // stretch or shrink the holds together so the flow lands on the target; sun salutations keep their pace, savasana ≤ 5 min
    const FIX=new Set(['yg_sunA','yg_sunB','yg_savasana']), goal=cap*60;
    p.exercises.forEach(e=>{ if(e.id==='yg_savasana') e.sets.forEach(s=>{ s.reps=String(Math.min(300,parseInt(s.reps)||180)); }); });
    const sum=fn=>p.exercises.reduce((t,e)=>t+e.sets.reduce((a,s)=>a+fn(e,s),0),0);
    const flex=sum((e,s)=>FIX.has(e.id)?0:(parseInt(s.reps)||30)), fixed=sum((e,s)=>YOGA_TRANSITION+(FIX.has(e.id)?(parseInt(s.reps)||30):0));
    if(flex>0){
      const f=Math.max(0.4,Math.min(1.6,(goal-fixed)/flex));
      if(Math.abs(f-1)>0.03) p.exercises.forEach(e=>{ if(!FIX.has(e.id)) e.sets.forEach(s=>{ s.reps=String(Math.max(15,Math.min(300,Math.round((parseInt(s.reps)||30)*f/5)*5))); }); });
    }
    while(estMinutes(p)>SESSION_MAX&&p.exercises.length>4) p.exercises.splice(p.exercises.length-2,1);   // keep savasana last
    const sv=p.exercises.find(e=>e.id==='yg_savasana');
    if(sv&&estMinutes(p)<SESSION_MIN) sv.sets[0].reps=String(Math.min(420,(parseInt(sv.sets[0].reps)||180)+(SESSION_MIN*60-estMinutes(p)*60)));
  } else {
    // too long → trim extra working sets (last exercises first), then drop trailing exercises
    for(let guard=0;guard<40&&estMinutes(p)>cap;guard++){
      const e=[...p.exercises].reverse().find(x=>x.sets.filter(s=>s.t!=='w').length>2);
      if(e){ const i=e.sets.map(s=>s.t).lastIndexOf('n'); e.sets.splice(i>=0?i:e.sets.length-1,1); }
      else if(p.exercises.length>3) p.exercises.pop(); else break;
    }
    // too short → add a working set where there are fewest, so it still earns its 30 min
    for(let guard=0;guard<12&&estMinutes(p)<SESSION_MIN;guard++){
      const e=[...p.exercises].sort((a,b)=>a.sets.filter(s=>s.t!=='w').length-b.sets.filter(s=>s.t!=='w').length)[0];
      if(!e||e.sets.filter(s=>s.t!=='w').length>=5) break;
      const last=e.sets.filter(s=>s.t!=='w').pop()||e.sets[e.sets.length-1]; e.sets.push({...last});
    }
  }
  p.setsTotal=p.exercises.reduce((n,e)=>n+e.sets.length,0);
  p.durationMin=Math.min(SESSION_MAX,Math.max(SESSION_MIN,estMinutes(p)));
  return p;
}

/* ================= Yoga: AI-generated flows =================
   The AI writes the sequence from your profile, injuries and what you lifted lately;
   a rule-based flow stands in until you ask (and works offline). Holds are logged as seconds. */
const YOGA_TRANSITION=12;   // seconds to move between poses / switch sides
const YOGA_FLOWS={
  hips:{title:'Hips & hamstrings flow',why:'Your legs worked hard recently — this opens hips, hamstrings and hip flexors so squats and deadlifts move better.',
    main:[['yg_sunA',60,1,2],['yg_lowlunge',45,2],['yg_lizard',45,2],['yg_war2',40,2],['yg_triangle',40,2],['yg_pyramid',40,2],['yg_malasana',60,1],['yg_goddess',40,1],['yg_pigeon',75,2],['yg_frog',60,1],['yg_bridge',40,1,2],['yg_seatfold',75,1],['yg_happybaby',60,1],['yg_supinetwist',45,2],['yg_dd',60,1],['yg_butterfly',75,1],['yg_fig4',60,2]]},
  upper:{title:'Shoulders & spine flow',why:'Upper body took the load lately — this restores shoulder range and thoracic rotation for pressing and pulling.',
    main:[['yg_sunA',60,1,2],['yg_dolphin',40,1,2],['yg_thread',45,2],['yg_puppy',60,1],['yg_eagle',30,2],['yg_war1',40,2],['yg_revwar',30,2],['yg_cobra',30,1,2],['yg_sphinx',60,1],['yg_locust',30,1,2],['yg_camel',30,1],['yg_seattwist',45,2],['yg_supinetwist',45,2],['yg_dd',60,1],['yg_plank',40,1],['yg_child',60,1],['yg_bridge',40,1,2]]},
  power:{title:'Power vinyasa',why:'You’re feeling strong — an athletic flow with long standing holds and core work that builds balance and body control.',
    main:[['yg_sunA',60,1,2],['yg_sunB',75,1,2],['yg_chair',45,1],['yg_crescent',40,2],['yg_war3',30,2],['yg_halfmoon',30,2],['yg_extside',40,2],['yg_plank',45,1],['yg_chaturanga',15,1,2],['yg_sideplank',30,2],['yg_boat',30,1,3],['yg_crow',20,1,3],['yg_wheel',20,1,2],['yg_pigeon',60,2],['yg_seatfold',60,1]]},
  yin:{title:'Recovery yin',why:'Recent sessions felt hard — long, passive holds and slow breathing to bring recovery forward instead of adding fatigue.',
    main:[['yg_catcow',60,1],['yg_puppy',90,1],['yg_dragon',120,2],['yg_butterfly',180,1],['yg_shoelace',120,2],['yg_sphinx',150,1],['yg_supinetwist',90,2],['yg_happybaby',90,1],['yg_legswall',180,1]]},
  strength:{title:'Strength yoga',why:'Long, loaded holds — chair, warriors, planks, arm balances — to build leg, core and shoulder strength and body control that carries over to lifting.',
    main:[['yg_sunA',60,1,2],['yg_sunB',75,1,2],['yg_chair',60,1,2],['yg_crescent',45,2],['yg_war2',45,2],['yg_war3',35,2],['yg_goddess',45,1,2],['yg_plank',60,1],['yg_chaturanga',20,1,3],['yg_sideplank',35,2],['yg_dolphin',45,1,2],['yg_boat',40,1,3],['yg_crow',25,1,3],['yg_locust',35,1,2],['yg_bridge',45,1,2],['yg_wheel',25,1,2],['yg_pigeon',60,2],['yg_seatfold',60,1]]},
  flex:{title:'Deep flexibility',why:'Slow flow and long passive holds to lengthen hamstrings, hips, hip flexors and shoulders — the range that makes squats deeper and overhead work cleaner.',
    main:[['yg_sunA',60,1,2],['yg_dd',75,1],['yg_ffold',75,1],['yg_pyramid',60,2],['yg_lowlunge',60,2],['yg_lizard',75,2],['yg_triangle',50,2],['yg_puppy',75,1],['yg_camel',40,1],['yg_pigeon',120,2],['yg_frog',90,1],['yg_seatfold',120,1],['yg_butterfly',90,1],['yg_happybaby',75,1],['yg_fig4',75,2],['yg_supinetwist',60,2]]},
  muscle:{title:'Muscle-building flow',why:'Time under tension: slow, controlled holds and repeated rounds in chair, lunges, plank, reverse plank and backbends load legs, glutes, shoulders and core — yoga that builds muscle, not just range.',
    main:[['yg_sunB',75,1,2],['yg_chair',60,1,3],['yg_revchair',40,2],['yg_crescent',50,2],['yg_war2',50,2],['yg_goddess',50,1,3],['yg_plank',60,1,2],['yg_chaturanga',20,1,4],['yg_dolphin',45,1,3],['yg_sideplank',40,2],['yg_purvott',30,1,3],['yg_locust',35,1,3],['yg_bow',30,1,2],['yg_bridge',50,1,3],['yg_boat',40,1,3],['yg_seatfold',60,1]]},
  fatloss:{title:'Fat-burn vinyasa',why:'A continuous flow — many salutation rounds, short holds, little stillness — keeps your heart rate up for conditioning without eating into lifting recovery.',
    main:[['yg_sunA',60,1,4],['yg_sunB',75,1,3],['yg_moonsal',90,1,2],['yg_chair',30,1,3],['yg_crescent',30,2,2],['yg_war2',30,2],['yg_revwar',20,2],['yg_extside',30,2],['yg_war3',25,2],['yg_plank',40,1,2],['yg_sideplank',25,2],['yg_boat',30,1,3],['yg_bridge',30,1,2],['yg_seatfold',45,1]]},
  prenatal:{title:'Prenatal flow',why:'Gentle strength, hip mobility and breathing with pregnancy-safe modifications: wide stances, open twists, no belly-down poses, no lying flat on your back. Check with your doctor or midwife first, and stop if anything feels off.',
    main:[['yg_child',60,1],['yg_goddess',40,1,2],['yg_war2',40,2],['yg_triangle',40,2],['yg_extside',35,2],['yg_tree',30,2],['yg_malasana',45,1],['yg_butterfly',90,1],['yg_wideseat',75,1],['yg_seattwist',30,2],['yg_thread',40,2],['yg_suptabaddha',120,1],['yg_bhramari',120,1],['yg_nadi',120,1]]},
  period:{title:'Period care flow',why:'Gentle, supported poses to ease cramps and lower-back tension — no inversions, no deep twists, no strong core or belly-down work. Go by how you feel and skip anything uncomfortable.',
    main:[['yg_catcow',60,1,2],['yg_supchild',120,1],['yg_suptabaddha',180,1],['yg_janusirsa',75,2],['yg_wideseat',90,1],['yg_butterfly',120,1],['yg_suppbridge',120,1],['yg_fig4',75,2],['yg_happybaby',75,1],['yg_bhramari',120,1],['yg_nadi',180,1]]},
  balance:{title:'Balance & core',why:'Single-leg standing poses, arm balances and anti-rotation core work for stability, coordination and athletic control.',
    main:[['yg_sunA',60,1,2],['yg_chair',45,1],['yg_tree',45,2],['yg_eagle',40,2],['yg_war3',40,2],['yg_halfmoon',40,2],['yg_crescent',40,2],['yg_plank',45,1],['yg_sideplank',35,2],['yg_boat',40,1,3],['yg_crow',25,1,3],['yg_locust',35,1,2],['yg_bridge',40,1,2],['yg_seattwist',45,2],['yg_seatfold',60,1]]},
  full:{title:'Full-body vinyasa',why:'A balanced flow — mobility for hips, hamstrings and shoulders plus balance and core control, without taking from your lifting.',
    main:[['yg_sunA',60,1,3],['yg_war1',40,2],['yg_war2',40,2],['yg_triangle',40,2],['yg_tree',30,2],['yg_lowlunge',45,2],['yg_plank',40,1],['yg_sideplank',25,2],['yg_cobra',30,1,2],['yg_pigeon',60,2],['yg_bridge',40,1,2],['yg_seattwist',40,2],['yg_seatfold',60,1],['yg_dd',60,1],['yg_extside',40,2],['yg_boat',30,1,2],['yg_supinetwist',45,2],['yg_happybaby',60,1]]},
};
/* flavors the user can pick; 'auto' lets recovery decide, 'mobility' picks hips or shoulders from what you lifted */
const YOGA_FLAVORS={auto:['✨','Auto'],muscle:['🏋️','Muscle building'],fatloss:['🔥','Fat loss'],period:['🌸','Period care'],prenatal:['🤰','Prenatal'],strength:['💪','Strength'],flex:['🤸','Flexibility'],balance:['⚖️','Balance'],mobility:['🦴','Mobility'],recovery:['🌙','Recovery']};
const FLAVOR_BRIEF={
  auto:'Pick the focus from my recovery: legs trained in the last 2 days → hips/hamstrings/hip flexors; upper body → shoulders and thoracic spine; recent sessions hard or brutal → yin/restorative.',
  strength:'STRENGTH FOCUS: build strength and muscular endurance with long, active holds — chair, warrior II/III, crescent, goddess, plank, chaturanga, side plank, dolphin, boat, crow, locust, bridge/wheel. Fewer, longer holds (30–60 s), repeated rounds; keep a short cool-down.',
  flex:'FLEXIBILITY FOCUS: lengthen hamstrings, hips, hip flexors, adductors, quads and shoulders. Gentle warm-up flow, then long holds (60–120 s, longer on the floor) like pyramid, lizard, pigeon, frog, seated fold, butterfly, puppy, camel. Breathe into each hold; nothing forced.',
  balance:'BALANCE FOCUS: stability and control — tree, eagle, warrior III, half moon, crescent, crow, side plank, boat, plus core anti-rotation. Build from easier to harder balances; include a calm cool-down.',
  mobility:'MOBILITY FOCUS for lifting: active range in the joints I just trained (legs → hips, ankles, hamstrings, hip flexors; upper → shoulders, thoracic rotation and extension). Mix moving flows with 30–60 s holds.',
  muscle:'MUSCLE-BUILDING FOCUS: time under tension for hypertrophy — slow, controlled holds of 40–60 s and repeated rounds (3–4) in chair, revolved chair, crescent, warrior II, goddess, plank, chaturanga, dolphin, side plank, reverse plank (purvottanasana), locust, bow, bridge and boat. Work each hold close to fatigue, keep transitions short, finish with a brief cool-down.',
  fatloss:'FAT-LOSS FOCUS: keep my heart rate up — a continuous vinyasa with many sun/moon salutation rounds, short holds (20–30 s), linked standing sequences and core, minimal stillness until the cool-down. Conditioning that complements my lifting without adding heavy leg fatigue.',
  prenatal:'PRENATAL: I am pregnant. Pregnancy-safe poses only — no belly-down poses, no deep or closed twists (open twists only), no inversions or deep backbends, no strong core work or jumping, nothing lying flat on my back (recline on an incline instead), wide stances to make room for the belly, balance poses next to a wall, and no overstretching. Every pose that needs a pregnancy modification MUST include it in "modification" (e.g. Child’s Pose → wide-knee Child’s Pose; Savasana → side-lying Savasana).',
  period:'PERIOD CARE FOCUS: I am menstruating. Gentle and restorative — supported, floor-based poses that ease cramps and lower-back tension (supported child, reclined bound angle, head-to-knee fold, wide-legged seated fold, butterfly, supported bridge, cat-cow), with calming pranayama (bhramari, nadi shodhana). Long comfortable holds, props welcome.',
  recovery:'RECOVERY FOCUS: yin/restorative — very few poses, long passive holds (2–4 min), slow breathing, no strength work. Aim to bring recovery forward, not add fatigue.'};
function yogaFlavor(){ const f=state.settings.yogaFlavor; return YOGA_FLAVORS[f]?f:'auto'; }
function yogaFocus(adjust){
  const fl=yogaFlavor();
  if(fl==='strength') return 'strength';
  if(fl==='muscle') return 'muscle';
  if(fl==='fatloss') return 'fatloss';
  if(fl==='period') return 'period';
  if(fl==='prenatal') return 'prenatal';
  if(fl==='flex') return 'flex';
  if(fl==='balance') return 'balance';
  if(fl==='recovery') return 'yin';
  if(fl==='mobility'){ const last=muscleLastTrained(), d=m=>daysSince(last[m]);
    const legs=Math.min(d('Quads'),d('Hamstrings'),d('Glutes')), upper=Math.min(d('Chest'),d('Back'),d('Shoulders'));
    const k=legs<=upper?'hips':'upper'; return adjust==='other'?(k==='hips'?'upper':'hips'):k; }
  const recent=sortedLogs().slice(-2);
  if(adjust==='easy'||(recent.length===2&&recent.every(l=>l.feel==='hard'||l.feel==='brutal'))) return 'yin';
  if(adjust==='hard') return 'power';
  const last=muscleLastTrained(), d=m=>daysSince(last[m]);
  const legs=Math.min(d('Quads'),d('Hamstrings'),d('Glutes')), upper=Math.min(d('Chest'),d('Back'),d('Shoulders'));
  let k=legs<=2&&legs<=upper?'hips':upper<=2?'upper':'full';
  if(adjust==='other') k=k==='hips'?'upper':k==='upper'?'full':'hips';
  return k;
}
const yogaEx=(id,hold,sides,rounds)=>{ sides=sides===2?2:1; rounds=Math.max(1,rounds||1);
  const n=sides*rounds;
  return {id,sets:Array.from({length:n},()=>({t:'n',reps:String(hold),load:null,rpe:null})),rest:0,ss:false,side:sides===2,rounds,
    note:sides===2?(rounds>1?`${rounds} rounds each side`:'Left side, then right'):''}; };
/* class order for the starter flows: warm-up → standing → core & balances → backbends → hips → cool-down */
const YOGA_PHASE={sunA:1,sunB:1,catcow:1,child:1,dd:1,puppy:1,dolphin:1,thread:1,
  chair:2,crescent:2,lowlunge:2,war1:2,war2:2,war3:2,revwar:2,triangle:2,extside:2,halfmoon:2,pyramid:2,goddess:2,tree:2,eagle:2,malasana:2,
  moonsal:1,supchild:1,revchair:2,purvott:3,bow:4,suptabaddha:6,janusirsa:6,wideseat:6,suppbridge:6,bhramari:6,nadi:6,
  plank:3,chaturanga:3,sideplank:3,boat:3,crow:3,
  cobra:4,updog:4,sphinx:4,locust:4,bridge:4,camel:4,wheel:4,
  lizard:5,dragon:5,pigeon:5,frog:5,shoelace:5,
  butterfly:6,fig4:6,seatfold:6,seattwist:6,happybaby:6,supinetwist:6,legswall:6};
function autoYoga(adjust){
  const st=settings(), minutes=adjust==='short'?SESSION_MIN:st.minutes;
  const k=yogaFocus(adjust), F=YOGA_FLOWS[k], avoid=yogaAvoid();
  const open=[yogaEx('yg_breath',60),yogaEx(k==='yin'||k==='period'?'yg_child':'yg_catcow',60)];   // prenatal: cat-cow opens, child's pose (wide-knee) follows
  const close=yogaEx('yg_savasana',minutes>=SESSION_MAX?300:180);
  const budget=minutes*60-[...open,close].reduce((t,e)=>t+e.sets.length*(+e.sets[0].reps+YOGA_TRANSITION),0);
  const main=[]; let used=0;
  for(const [id,hold,sides,rounds] of F.main){
    if(avoid.has(id)) continue;
    const e=yogaEx(id,hold,sides,rounds), cost=e.sets.length*(hold+YOGA_TRANSITION);
    if(used+cost>budget*1.05) continue;
    main.push(e); used+=cost;
  }
  main.sort((a,b)=>(YOGA_PHASE[a.id.slice(3)]||5)-(YOGA_PHASE[b.id.slice(3)]||5));   // stable: keeps each flow's order inside a phase
  const inj=injuryAvoid().hit;
  return fitTime({kind:'yoga',title:F.title,focus:F.title,group:'yoga',style:k,flavor:yogaFlavor(),
    why:F.why+(inj.length?` Skipping poses that load your ${inj.join(' & ')}.`:''),
    durationMin:minutes,warmup:'',exercises:[...open,...main,close],routineUpdates:[],setsTotal:0},minutes);
}
const YOGA_AVOID={shoulder:['yg_chaturanga','yg_crow','yg_wheel','yg_dolphin','yg_updog'],knee:['yg_pigeon','yg_malasana','yg_frog','yg_shoelace','yg_lizard','yg_dragon','yg_camel'],
  back:['yg_wheel','yg_camel','yg_locust','yg_boat'],wrist:['yg_crow','yg_chaturanga','yg_plank','yg_sideplank','yg_updog'],elbow:['yg_chaturanga','yg_crow']};
/* menstruation: no inversions, deep twists, strong core / belly-down work or high-intensity jumping flows */
const PERIOD_AVOID=['yg_wheel','yg_crow','yg_boat','yg_chaturanga','yg_camel','yg_locust','yg_bow','yg_purvott','yg_legswall','yg_seattwist','yg_revchair','yg_sunB','yg_updog','yg_dolphin'];
const periodOn=()=>yogaFlavor()==='period';
const PRENATAL_AVOID=['yg_wheel','yg_camel','yg_crow','yg_boat','yg_chaturanga','yg_cobra','yg_updog','yg_sphinx','yg_locust','yg_bow','yg_revchair','yg_sunB','yg_legswall',
  'yg_happybaby','yg_supinetwist','yg_fig4','yg_bridge','yg_suppbridge','yg_purvott','yg_frog','yg_dragon','yg_halfmoon','yg_war3','yg_plank','yg_sideplank','yg_dolphin','yg_eagle'];
const prenatalOn=()=>yogaFlavor()==='prenatal';
function yogaAvoid(){ const out=new Set(); injuryAvoid().hit.forEach(k=>(YOGA_AVOID[k]||[]).forEach(i=>out.add(i)));
  if(periodOn()) PERIOD_AVOID.forEach(i=>out.add(i)); if(prenatalOn()) PRENATAL_AVOID.forEach(i=>out.add(i)); return out; }
/* ---------- modifications: shown on the plan, in a pop-up before you start, on each pose in the
   live workout and in the exercise sheet, with a video search for the modified version ---------- */
const MOD_LABEL={prenatal:'pregnancy',period:'period',knee:'knee',shoulder:'shoulder',wrist:'wrist',back:'back',elbow:'elbow'};
const M=(t,how,v)=>({t,how,v});
const MODS={
 prenatal:{
  yg_child:M('Wide-knee Child’s Pose','Knees wide and big toes together so your belly rests between your thighs. Forehead on a block or stacked fists.','wide knee child\'s pose prenatal yoga'),
  yg_savasana:M('Side-lying Savasana','Lie on your left side with a pillow between your knees and one under your head instead of flat on your back.','side lying savasana prenatal yoga'),
  yg_catcow:M('Gentle Cat-Cow','Move slowly; in Cow keep your spine long rather than letting the belly sag.','prenatal cat cow'),
  yg_sunA:M('Prenatal Sun Salutation','Step, never jump. Replace Chaturanga and Cobra with lowering your knees and a round of Cat-Cow.','prenatal sun salutation'),
  yg_dd:M('Wide Downward Dog','Feet and hands wider than usual, short holds, and come down if you feel dizzy.','prenatal downward dog modification'),
  yg_goddess:M('Supported Goddess','Keep the squat shallow and hold a chair or wall if balance feels off.','prenatal goddess pose chair'),
  yg_war2:M('Short-stance Warrior II','Shorten your stance a little and keep the front knee right over the ankle.','prenatal warrior 2 modification'),
  yg_triangle:M('Triangle with a block','Bottom hand on a block or your shin; open the chest instead of reaching down.','prenatal triangle pose block'),
  yg_extside:M('Forearm-on-thigh Side Angle','Rest your forearm on your front thigh instead of the hand on the floor.','prenatal extended side angle forearm thigh'),
  yg_tree:M('Tree at the wall','Stand beside a wall with a hand on it; foot on the calf or ankle, never on the knee.','prenatal tree pose wall'),
  yg_malasana:M('Supported Garland on a block','Sit on one or two blocks, feet wider than hips.','prenatal malasana block'),
  yg_butterfly:M('Butterfly on a blanket','Sit on a folded blanket and let the knees fall naturally — don’t press them down.','prenatal bound angle pose'),
  yg_wideseat:M('Supported Wide-Legged Fold','Sit on a blanket and lean forward only as far as your belly allows, hands on blocks.','prenatal wide legged seated forward bend'),
  yg_seattwist:M('Open twist','Twist away from the bent knee (open twist) and keep it gentle — never squeeze the belly.','prenatal open twist seated'),
  yg_suptabaddha:M('Inclined Reclined Bound Angle','Lie back on a bolster propped at an incline — don’t lie flat.','prenatal supported reclined bound angle bolster'),
  yg_lowlunge:M('Supported Low Lunge','Pad the back knee and put your hands on blocks.','prenatal low lunge blocks'),
  yg_pigeon:M('Upright Pigeon','Prop the hip on a blanket and stay up on your hands instead of folding forward.','prenatal pigeon pose modification'),
  yg_seatfold:M('Wide-legged fold with a strap','Legs apart to make room for the belly, strap around the feet, long spine.','prenatal seated forward fold modification'),
  yg_thread:M('Gentle Thread the Needle','Keep the twist light and rest the shoulder on a blanket.','prenatal thread the needle'),
  yg_war1:M('Short-stance Warrior I','Shorter, wider stance for balance; hands on hips if raising the arms feels like too much.','prenatal warrior 1 modification'),
  yg_crescent:M('Kneeling Crescent','Lower the back knee to the mat with padding.','prenatal crescent lunge knee down')},
 period:{
  yg_child:M('Supported Child’s Pose','Knees wide with a bolster or pillows under your chest and belly.','supported child\'s pose bolster'),
  yg_seatfold:M('Bent-knee Forward Fold','Bend your knees and rest your chest on a pillow on your thighs.','supported seated forward fold pillow'),
  yg_dd:M('Puppy instead of Down Dog','Keep your hips over your knees and chest towards the floor, or keep Down Dog very short.','puppy pose yoga'),
  yg_janusirsa:M('Supported Head-to-Knee','Fold gently and rest your forehead on a bolster.','supported janu sirsasana bolster'),
  yg_suppbridge:M('Low Supported Bridge','Block at its lowest height under your sacrum.','supported bridge pose block'),
  yg_butterfly:M('Reclined Butterfly','Lie back on a bolster if folding forward feels uncomfortable.','supported reclined bound angle')},
 knee:{
  yg_child:M('Padded Child’s Pose','Folded blanket behind the knees or under the shins — or swap for Puppy Pose.','child\'s pose knee pain modification'),
  yg_lowlunge:M('Padded Low Lunge','Folded blanket under the back knee; front knee stays over the ankle.','low lunge knee pain modification'),
  yg_crescent:M('Shorter Crescent','Bend the front knee less and keep it tracking over the toes.','crescent lunge knee friendly'),
  yg_chair:M('High Chair','Bend the knees less and sit the hips back.','chair pose knee pain modification'),
  yg_war2:M('Softer Warrior II','Bend the front knee less; it should never pass the toes.','warrior 2 knee pain modification'),
  yg_catcow:M('Cat-Cow with knee padding','Fold the mat or a blanket under your knees.','cat cow knee pain'),
  yg_goddess:M('Shallow Goddess','Squat only as low as the knees feel fine.','goddess pose knee modification')},
 shoulder:{
  yg_dd:M('Down Dog with hands on blocks','Hands on blocks and a little wider — or Puppy Pose.','downward dog shoulder modification blocks'),
  yg_plank:M('Knees-down Plank','Lower the knees to take load off the shoulders.','plank knees down modification'),
  yg_sideplank:M('Kneeling Side Plank','Bottom knee down.','side plank modification knee down'),
  yg_eagle:M('Eagle legs, hug the shoulders','Skip the arm wrap — give yourself a hug instead.','eagle pose arm modification'),
  yg_sunA:M('Sun Salutation without Chaturanga','Lower knees-chest-chin or skip straight to Cobra.','sun salutation without chaturanga')},
 wrist:{
  yg_plank:M('Forearm Plank','Forearms down instead of hands.','forearm plank yoga'),
  yg_dd:M('Dolphin or fists','Come onto forearms (Dolphin) or make fists to keep the wrists straight.','downward dog wrist pain modification'),
  yg_catcow:M('Cat-Cow on fists','Make fists or come onto your forearms.','cat cow wrist pain'),
  yg_sideplank:M('Forearm Side Plank','Bottom forearm on the mat.','forearm side plank'),
  yg_sunA:M('Wrist-friendly Sun Salutation','Use fists or forearms whenever your hands would bear weight.','sun salutation wrist pain modification')},
 back:{
  yg_seatfold:M('Bent-knee Seated Fold','Bend your knees and hinge from the hips with a long spine.','seated forward fold lower back pain modification'),
  yg_ffold:M('Ragdoll with bent knees','Knees soft, hands on blocks or holding opposite elbows.','forward fold lower back modification'),
  yg_cobra:M('Sphinx instead of Cobra','Stay low on your forearms.','sphinx pose yoga'),
  yg_bridge:M('Low Bridge','Lift only a little, or rest your sacrum on a block.','supported bridge lower back'),
  yg_triangle:M('Short-stance Triangle','Shorter stance with your bottom hand on a block.','triangle pose block modification'),
  yg_seattwist:M('Gentle upper-back twist','Twist from the upper back only; keep the low back neutral.','gentle seated twist lower back')}
};
function modsFor(id){
  id=String(id||''); const out=[], ctx=[];
  if(planKind()==='yoga'&&['prenatal','period'].includes(yogaFlavor())) ctx.push(yogaFlavor());
  try{ injuryAvoid().hit.forEach(k=>{ if(!ctx.includes(k)) ctx.push(k); }); }catch(e){}
  // The AI's own modifications show only when there's a reason: pregnancy, period, a profile injury, or today's request
  try{ const p=state.aiPlan&&state.aiPlan.date===todayStr()&&state.aiPlan.plan; const e=p&&p.exercises.find(x=>x.id===id&&x.mod&&x.mod.t);
    const why=ctx.length?MOD_LABEL[ctx[0]]:(aiNote(planKind())?'your request':'');
    const builtIn=ctx.some(c=>(MODS[c]||{})[id]);
    if(e&&why&&e.mod.k===2&&!builtIn) out.push({t:e.mod.t,how:e.mod.how||'',v:e.mod.v||'',why}); }catch(e){}
  for(const c of ctx){ const m=(MODS[c]||{})[id]; if(m){ out.push({...m,why:MOD_LABEL[c]}); break; } }   // one per pose, most specific first
  return out;
}
function modReason(){
  const parts=[]; if(planKind()==='yoga'&&yogaFlavor()==='prenatal') parts.push('Prenatal');
  if(planKind()==='yoga'&&yogaFlavor()==='period') parts.push('Period care');
  let inj=[]; try{ inj=injuryAvoid().hit; }catch(e){}
  if(inj.length) parts.push('your '+inj.join(' & ')+' (from your profile)');
  if(!parts.length&&aiNote(planKind())) parts.push('your request to the AI');
  return 'Because of '+parts.join(' and ');
}
const modVideo=(m,id)=>'https://www.youtube.com/results?search_query='+encodeURIComponent(m.v||((m.t||exName(id).split(' · ')[0])+' yoga modification'));
function planMods(p){ return (p.exercises||[]).map(e=>({id:e.id,ms:modsFor(e.id)})).filter(x=>x.ms.length); }
function openModsSheet(p,onStart){
  const list=planMods(p);
  $('#woSheet').innerHTML=`<div class="grab"></div><div class="rv-head"><div class="ttl">Modifications</div><div class="dt">${list.length} pose${list.length===1?'':'s'}</div></div>
    <div class="rv-sub">${prenatalOn()?'Pregnancy-safe versions of today’s poses. Check with your doctor or midwife before starting, and stop if anything feels off.':'Today’s flow changes these poses. Do the modified version — each has a video.'}</div>
    ${list.map(x=>`<div class="modrow"><div class="modrow-n">${poseHTML(exName(x.id))}</div>${x.ms.map(m=>`<div class="modbox"><div class="modh"><span class="modic">⚠︎</span><b>${h(m.t)}</b></div><div class="modhow">${h(m.how)}</div><a class="modvid" href="${h(modVideo(m,x.id))}" target="_blank" rel="noopener">▶ Watch the modified version</a></div>`).join('')}</div>`).join('')}
    ${onStart?'<button class="crew-btn" id="mdGo" style="margin-top:14px">Got it — start</button>':''}
    <button class="rv-close" id="mdClose" style="margin-top:8px">${onStart?'Not now':'Done'}</button>`;
  $('#woScrim').classList.add('show');
  $('#mdClose').onclick=()=>$('#woScrim').classList.remove('show');
  const g=$('#mdGo'); if(g) g.onclick=()=>{ $('#woScrim').classList.remove('show'); onStart(); };
}
const aiNote=kind=>String(((state.settings.aiNotes||{})[kind])||'').trim().slice(0,400);

function buildYogaPrompt(adjust){
  const st=settings(), last=muscleLastTrained();
  const minutes=adjust==='short'?SESSION_MIN:st.minutes;
  const recent=sortedLogs().filter(l=>l.date>=addDays(todayStr(),-10)).map(l=>({d:l.date,name:entryName(l),feel:l.feel||null,
    yoga:Object.keys(l.ex).some(isYoga),muscles:[...new Set(Object.keys(l.ex).filter(id=>!isYoga(id)).map(id=>Workout.exInfo(id).muscle))]}));
  const lastYoga=sortedLogs().reverse().find(l=>Object.keys(l.ex).some(isYoga));
  const adj=adjust?{short:`Keep it to ${SESSION_MIN} minutes.`,easy:'Low energy today — make it gentle and restorative.',hard:'I feel strong — make it an athletic power flow.',other:'Give me a different focus than last time.'}[adjust]:'';
  const lib=Workout.allExercises().filter(e=>isYoga(e.id)).map(e=>`${e.id}|${e.name}|${e.muscle}`);
  const data={today:todayStr(),flavor:YOGA_FLAVORS[yogaFlavor()][1],profile:state.profile||{},goal:goalKind(),sessionMinutes:minutes,appleHealth:window.HealthSync?HealthSync.summary():null,
    muscleDaysSinceTrained:Object.fromEntries(MUSCLES.map(m=>[m,last[m]?daysSince(last[m]):null])),
    recentSessions:recent,lastYogaSession:lastYoga?{d:lastYoga.date,name:entryName(lastYoga),poses:Object.keys(lastYoga.ex).map(id=>exName(id))}:null,
    library:lib};
  const note=aiNote('yoga'), period=periodOn();
  return `You are my yoga teacher. I lift weights to get stronger, more athletic and leaner — not to be a bodybuilder — and I use yoga for mobility, balance, core control and recovery. Design today's yoga session (${data.today}).${adj?' '+adj:''}
${note?`
MY REQUEST FOR TODAY — follow it unless it's unsafe; it overrides the defaults below where they conflict (the session length rule still holds): "${note.replace(/"/g,"'")}"
`:''}${period?`
I'M ON MY PERIOD: no inversions (including legs-up-the-wall, shoulderstand, headstand, wheel), no deep or closed twists, no strong core work, no belly-down backbends or pressure on the abdomen, no jumping or very intense flows. Favour supported, restorative, hip-opening and forward-folding poses and calming pranayama. Never use these ids: ${PERIOD_AVOID.join(', ')}.
`:''}
SESSION LENGTH IS A HARD RULE: the whole session must take ${SESSION_MIN}–${SESSION_MAX} minutes (target ${minutes}), counting every hold, every side, every round and ~${YOGA_TRANSITION} s to move between poses. Add it up before you answer.

TODAY'S FLAVOR — ${YOGA_FLAVORS[yogaFlavor()][1]}: ${FLAVOR_BRIEF[yogaFlavor()]}

If "appleHealth" is present, lean gentler when sleep was short or resting heart rate is above my baseline.

Build a real sequence that serves that flavor: centering/breath → warm-up (sun salutations or cat-cow) → main block for the flavor → floor and cool-down → savasana (3–5 min; shorter is fine for strength). Respect any injuries in my profile and avoid repeating last session's exact flow.

Use poses ONLY from "library" (exact id). If you truly need one that isn't there, set "id" to "" and give "name" as "English name · Sanskrit name" (e.g. "Reclined Hero · Supta Virasana") and "muscle" (one of ${MUSCLES.join(', ')}).
Modifications are the exception, not the rule. ONLY when a specific pose must change because of pregnancy, my period, an injury listed in my profile, or something I asked for today, add "modification": {"title":"short name of the modified version","how":"one or two sentences on exactly what to change","video":"youtube search words for that modified version"} to that pose. Never add one for general tips, beginner options or alignment cues — those go in "note". Most poses should have no "modification" field at all.
For each pose: "holdSec" = seconds per hold, "sides" = 2 if it's done on each side (else 1), "rounds" = how many times (sun salutations, repeated holds), "note" = one short alignment or breath cue.

DATA: ${JSON.stringify(data)}

Reply with ONLY valid JSON (no markdown fences, no commentary):
{"title":"short name e.g. Strength Flow: Legs & Core","focus":"main focus","why":"2-3 sentences: why this flow today and how it helps my lifting","durationMin":${minutes},
"poses":[{"id":"library id","name":"","muscle":"","holdSec":45,"sides":1,"rounds":1,"note":"cue"}]}`;
}
function parseYogaJSON(text,target){
  let t=String(text).replace(/```json|```/g,'').trim();
  const a=t.indexOf('{'), b=t.lastIndexOf('}'); if(a>=0&&b>a) t=t.slice(a,b+1);
  const r=JSON.parse(t), list=Array.isArray(r.poses)?r.poses:Array.isArray(r.exercises)?r.exercises:null;
  if(!list) throw new Error('no poses');
  const exercises=list.slice(0,30).map(x=>{
    x=x||{}; const name=String(x.name||'').trim().slice(0,60); let id=String(x.id||'').trim();
    if(!(id&&(LIBRARY[id]||state.customEx[id]))){
      const byName=name&&Workout.allExercises().find(e=>isYoga(e.id)&&e.name.toLowerCase()===name.toLowerCase());
      if(byName) id=byName.id;
      else if(name){ id='cx_'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
        state.customEx[id]={id,name,muscle:MUSCLES.includes(x.muscle)?x.muscle:'Full body',equip:'Bodyweight',type:'dur',secondary:[],custom:true,yoga:true}; }
      else return null;
    }
    const hold=Math.max(10,Math.min(600,Math.round(+x.holdSec||+x.hold||30)));
    const e=yogaEx(id,hold,+x.sides===2?2:1,Math.min(6,Math.max(1,+x.rounds||1)));
    if(x.note) e.note=String(x.note).slice(0,140)+(e.note?' · '+e.note:'');
    const md=x.modification||x.mod; if(md&&typeof md==='object'&&String(md.title||md.t||'').trim())
      e.mod={t:String(md.title||md.t).slice(0,60),how:String(md.how||'').slice(0,240),v:String(md.video||md.v||'').slice(0,100),why:'AI',k:2};   // k:2 = written under the selective-modification prompt
    return e;
  }).filter(Boolean);
  if(periodOn()||prenatalOn()) for(let i=exercises.length-1;i>=0;i--) if((periodOn()?PERIOD_AVOID:PRENATAL_AVOID).includes(exercises[i].id)) exercises.splice(i,1);
  if(exercises.length<3) throw new Error('too few poses');
  return fitTime({kind:'yoga',flavor:yogaFlavor(),title:String(r.title||'Yoga flow').slice(0,40),focus:String(r.focus||'').slice(0,40),group:'yoga',
    why:String(r.why||'').slice(0,600),durationMin:SESSION_MAX,warmup:'',exercises,routineUpdates:[],setsTotal:0},
    Math.max(SESSION_MIN,Math.min(SESSION_MAX,+r.durationMin||target||SESSION_MAX)));
}
function consecutiveDays(){ let n=0, d=addDays(todayStr(),-1); while(state.logs.some(l=>l.date===d)){ n++; d=addDays(d,-1); } return n; }

/* plans written by an AI are saved with source 'ai'; plans saved by the first version used 'claude' */
const fromAI=src=>src==='ai'||src==='claude';
/* ---------- AI prompt ---------- */
function buildContext(){
  const st=settings(), last=muscleLastTrained(), wk=weeklySets();
  const recent=sortedLogs().filter(l=>l.date>=addDays(todayStr(),-21)).map(l=>({d:l.date,name:entryName(l),feel:l.feel||null,min:l.duration?Math.round(l.duration/60):null,
    ex:Object.fromEntries(Object.entries(l.ex).map(([id,s])=>[id,s.map(x=>(x.t&&x.t!=='n'?x.t.toUpperCase()+':':'')+(x.l?x.l+'x':'')+x.r+(x.rpe?'@'+x.rpe:'')).join(',')]))}));
  const best={}; Object.keys(Object.assign({},...state.logs.map(l=>l.ex))).forEach(id=>{ const r=Workout.recordsFor(id).rec; if(r.e[0]) best[id]={e1rm:Math.round(r.e[0]),heaviest:r.w[0]}; });
  const lib=Workout.allExercises().filter(e=>!isYoga(e.id)&&(planKind()==='home'?homeOk(e):(st.equipment.includes(e.equip)||e.equip==='Bodyweight'))).map(e=>`${e.id}|${e.name}|${e.muscle}|${e.equip}|${e.type}`);
  const ms=[...state.measurements].sort((a,b)=>a.date<b.date?-1:1).slice(-1)[0]||null;
  const ci=[...state.checkins].filter(c=>c.weight).sort((a,b)=>a.date<b.date?-1:1).slice(-3).map(c=>({d:c.date,wt:c.weight}));
  return {
    today:todayStr(), weekday:DAY_ABBR[new Date().getDay()],
    profile:state.profile||{}, goal:goalKind(), sessionMinutes:st.minutes, targetDaysPerWeek:st.daysPerWeek, equipment:planKind()==='home'?['none — bodyweight only, at home']:st.equipment, units:'lb (all loads in this data and in your reply are in lb)', userDisplayUnit:unit(),
    sessionsThisWeek:state.logs.filter(l=>weekStartTs(l.date)===weekStartTs(todayStr())).length,
    consecutiveTrainingDays:consecutiveDays(),
    muscleDaysSinceTrained:Object.fromEntries(MUSCLES.map(m=>[m,last[m]?daysSince(last[m]):null])),
    muscleSetsLast7Days:Object.fromEntries(MUSCLES.map(m=>[m,Math.round((wk[m]||0)*10)/10])),
    recentWorkouts:recent, bestLifts:best, bodyweight:ci, measurements:ms,
    appleHealth:window.HealthSync?HealthSync.summary():null,
    routines:state.routines.map(r=>({id:r.id,name:r.name,exercises:r.exercises.map(e=>({id:e.id,sets:e.sets,reps:e.reps,rest:e.rest}))})),
    library:lib,
  };
}
function buildPrompt(adjust){
  const ctx=buildContext(); const base=autoPlan(adjust);
  const adj=adjust?{short:'Keep it to ~30 minutes.',easy:'I have low energy today — lighter session.',hard:'I feel strong today — push harder.',other:'I want a different focus than the obvious choice.'}[adjust]:'';
  const note=aiNote(planKind()), home=planKind()==='home';
  return `You are my strength coach. Plan my exact ${home?'HOME ':''}workout for today (${ctx.today}, ${ctx.weekday}).${adj?' '+adj:''}
${home?`
HOME WORKOUT — NO EQUIPMENT AT ALL: bodyweight only. No weights, bands, pull-up bar, bench, chair, table or wall-mounted anything — only moves done on the floor or standing. Every exercise must come from "library" (it only contains no-equipment moves). Keep it hard with tempo (3-second lowers), pauses, single-leg and harder variations, higher reps and short rests; "load" is always null; skip barbell-style warm-up sets.
`:''}
${note?`
MY REQUEST FOR TODAY — follow it unless it's unsafe; it overrides the defaults below where they conflict (the session length rule still holds): "${note.replace(/"/g,"'")}"
`:''}
SESSION LENGTH IS A HARD RULE: the whole session, warm-up and rests included, must take ${SESSION_MIN}–${SESSION_MAX} minutes (target ${ctx.sessionMinutes}). Count it: ~45 s per set plus the rest you prescribe. Use supersets for accessories rather than going over. Any routine you suggest must also fit ${SESSION_MIN}–${SESSION_MAX} minutes.

Use the data below: recovery per muscle (days since trained, sets in the last 7 days), my recent workouts (sets are "loadxreps@RPE", W: = warm-up), best lifts, goal, injuries/notes in my profile, available equipment, and session length. Progress loads sensibly from my last sets (add weight only when I hit the top of the rep range on all working sets; deload ~10% if I'm grinding). Respect injuries. If I need a rest day, still give a light session but say so in "why".

Also review my saved routines against how I'm actually training. If a routine should change (exercise swaps, sets/reps, order) or a new routine would help, include it in "routineUpdates" with the reason. Leave it empty if nothing should change.

If "appleHealth" is present, use it for recovery: sleep well under my 30-day baseline or resting heart rate 5+ bpm above it → make today lighter and say so in "why"; count its otherWorkouts (runs, sports) as fatigue.

Library rows are "id|name|muscle|equipment|type". type: wr = weight × reps, bw = bodyweight reps (load only if added weight, else null), dur = seconds (reps = seconds, load null), wd = loaded carry (load + seconds), cardio = minutes (reps = minutes, load null).

Pick exercises ONLY from "library" (use the exact id). If you truly need one that isn't there, set "id" to "" and give "name", "muscle" (one of ${MUSCLES.join(', ')}) and "equip".

A rule-based baseline for today is included as "baseline" — improve on it freely.

DATA: ${JSON.stringify({...ctx,baseline:{title:base.title,exercises:base.exercises.map(e=>({id:e.id,sets:e.sets.length,reps:e.sets[e.sets.length-1].reps,load:e.sets[e.sets.length-1].load}))}})}

Reply with ONLY valid JSON (no markdown fences, no commentary):
{"title":"short name e.g. Pull + Hamstrings","focus":"main focus","why":"2-4 sentences: why this session today, what to push, what to hold back","durationMin":45,"warmup":"one line",
"exercises":[{"id":"library id","name":"","muscle":"","equip":"","rest":120,"superset":false,"note":"one short cue or reason","sets":[{"type":"warmup|normal|drop|failure","reps":"8-10","load":95,"rpe":8}]}],
"routineUpdates":[{"action":"create|update","routineId":"existing id for update","name":"routine name","reason":"why","exercises":[{"id":"library id","sets":3,"reps":"8-10","rest":90,"note":""}]}]}`;
}

/* ---------- parse + validate the AI's reply ---------- */
function resolveEx(raw){
  const id=String(raw.id||'').trim(), name=String(raw.name||'').trim().slice(0,60);
  if(id&&(LIBRARY[id]||state.customEx[id])) return id;
  const byName=name&&Workout.allExercises().find(e=>e.name.toLowerCase()===name.toLowerCase());
  if(byName) return byName.id;
  if(!name) return null;
  const nid='cx_'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  state.customEx[nid]={id:nid,name,muscle:MUSCLES.includes(raw.muscle)?raw.muscle:'Full body',equip:EQUIPMENT.includes(raw.equip)?raw.equip:'Other',type:'wr',secondary:[],custom:true};
  return nid;
}
const TYPE={warmup:'w',w:'w',normal:'n',n:'n',drop:'d',d:'d',failure:'f',f:'f'};
function parsePlanJSON(text){
  let t=String(text).replace(/```json|```/g,'').trim();
  const a=t.indexOf('{'), b=t.lastIndexOf('}'); if(a>=0&&b>a) t=t.slice(a,b+1);
  const r=JSON.parse(t);
  if(!r||!Array.isArray(r.exercises)) throw new Error('no exercises');
  const exercises=r.exercises.slice(0,12).map(e=>{
    const id=resolveEx(e||{}); if(!id) return null;
    const sets=(Array.isArray(e.sets)?e.sets:[]).slice(0,10).map(s=>({
      t:TYPE[String(s&&s.type||'normal').toLowerCase()]||'n',
      reps:String(s&&s.reps!=null?s.reps:'').slice(0,10),
      load:s&&Number.isFinite(+s.load)&&+s.load>0?Math.round(+s.load*2)/2:null,
      rpe:s&&+s.rpe>=5&&+s.rpe<=10?+s.rpe:null }));
    if(!sets.length) return null;
    return {id,sets,rest:Math.max(0,Math.min(600,+e.rest||90)),ss:!!e.superset,note:String(e.note||'').slice(0,160)};
  }).filter(Boolean);
  if(!exercises.length) throw new Error('no usable exercises');
  const routineUpdates=(Array.isArray(r.routineUpdates)?r.routineUpdates:[]).slice(0,3).map(u=>{
    const action=u&&u.action==='update'&&state.routines.some(x=>x.id===u.routineId)?'update':'create';
    const ex=(Array.isArray(u&&u.exercises)?u.exercises:[]).slice(0,15).map(e=>{ const id=resolveEx(e||{}); return id?{id,sets:Math.max(1,Math.min(10,+e.sets||3)),reps:String(e.reps||'').slice(0,12),rest:Math.max(0,Math.min(600,+e.rest||90)),note:String(e.note||'').slice(0,140),ss:false}:null; }).filter(Boolean);
    if(!ex.length) return null;
    return {action,routineId:action==='update'?u.routineId:'',name:String(u.name||'AI routine').slice(0,40),reason:String(u.reason||'').slice(0,300),exercises:ex};
  }).filter(Boolean);
  return fitTime({kind:'strength',title:String(r.title||'Today’s workout').slice(0,40),focus:String(r.focus||'').slice(0,40),why:String(r.why||'').slice(0,700),
    durationMin:SESSION_MAX,warmup:String(r.warmup||'').slice(0,200),exercises,routineUpdates,
    setsTotal:exercises.reduce((n,e)=>n+e.sets.length,0)},Math.max(SESSION_MIN,Math.min(SESSION_MAX,+r.durationMin||settings().minutes)));
}

/* ---------- state ---------- */
const planKind=()=>['yoga','home'].includes(state.settings.planKind)?state.settings.planKind:'strength';
/* Home = bodyweight only: no weights, bands, bar, bench or chair — only moves that need the floor */
const HOME_IDS=new Set(['pushup','wide_push','diamond_push','pike_push','superman','snow_angel','ytw','bw_squat','bw_lunge','bw_split','jump_squat','lat_lunge','skater',
  'sl_bridge','glute_bridge','sl_rdl_bw','calf_bw','sissy','burpee','plank','sideplank','deadbug','birddog','crunch','rev_crunch','hollow','mtn_climber','shoulder_tap']);
const homeOk=e=>HOME_IDS.has(e.id);
window.IronHomeIds=HOME_IDS;   // read by health.js to label bodyweight sessions for Apple Health
function homePlan(p){
  p.kind='home'; p.title=('Home · '+String(p.title||'Workout').replace(/^Home · /,'')).slice(0,40);
  p.warmup=p.warmup||'3 min: jumping jacks, arm circles, bodyweight squats';
  p.exercises.forEach(e=>{ const first=(e.sets.find(x=>x.t!=='w')||e.sets[0]||{}).reps||'';
    const dur=/^\d+-\d+$/.test(first)&&Workout.measure(e.id).timed;
    e.sets=e.sets.filter(x=>x.t!=='w').map(x=>({...x,load:null,reps:dur?x.reps:(e.id==='burpee'||e.id==='jump_squat'||e.id==='skater'?'8-12':/push|pike|diamond|sl_|split|lunge|sissy/.test(e.id)?'8-15':'12-20')}));
    e.rest=/push|pike|diamond|squat|lunge|split|sl_|sissy|burpee|skater/.test(e.id)?60:45;
    e.note=''; });
  return fitTime(p,p.durationMin||settings().minutes);
}
const autoFor=(kind,adjust)=>kind==='yoga'?autoYoga(adjust):kind==='home'?homePlan(autoPlan(adjust)):autoPlan(adjust);
function current(){
  const p=state.aiPlan, kind=planKind();
  if(p&&p.date===todayStr()&&p.plan&&Array.isArray(p.plan.exercises)&&(p.plan.kind||'strength')===kind&&(kind!=='yoga'||(p.plan.flavor||'auto')===yogaFlavor())){
    // plans saved before the 30–45 min rule get re-fitted once
    if(!p.fitted){ fitTime(p.plan,settings().minutes); p.fitted=true; }
    return p;
  }
  state.aiPlan={date:todayStr(),source:'auto',plan:autoFor(kind,''),adjust:'',done:false,applied:[],fitted:true};
  return state.aiPlan;
}
async function setPlan(plan,source,adjust){
  state.aiPlan={date:todayStr(),source,plan,adjust:adjust||'',done:false,applied:[],fitted:true};
  await persist(); renderAll();
}
async function switchFlavor(f){
  if(!YOGA_FLAVORS[f]||yogaFlavor()===f) return;
  state.settings.yogaFlavor=f;
  await setPlan(autoYoga(''),'auto','');
  toast(YOGA_FLAVORS[f].join(' ')+' yoga');
  if(API_AVAILABLE) planWithAI('');
}
async function switchKind(kind){
  if(planKind()===kind) return;
  state.settings.planKind=kind;
  await setPlan(autoFor(kind,''),'auto','');
  // yoga flows are written by the AI — generate one right away when an AI provider is set up in-app
  if(kind==='yoga'&&API_AVAILABLE) planWithAI('');
}

/* ---------- UI ---------- */
function yogaSummary(e){
  const hold=e.sets[0]?e.sets[0].reps:'', rounds=e.rounds||1;
  return `${e.side?`${h(hold)}s / side`:`${h(hold)}s`}${rounds>1?` × ${rounds}`:''}`;
}
function setsSummary(e){
  if(isYoga(e.id)) return yogaSummary(e);
  const w=e.sets.filter(s=>s.t!=='w'), wu=e.sets.length-w.length;
  const reps=[...new Set(w.map(s=>s.reps))].join('/'), load=w.find(s=>s.load)?.load, rpe=w.find(s=>s.rpe)?.rpe;
  const m=Workout.measure(e.id);
  return `${w.length} × ${h(reps||'—')}${m.rSuffix}${load?` @ ${m.load?'':'+'}${WL(load)}`:''}${rpe?` · RPE ${rpe}`:''}${wu?` · +${wu} warm-up`:''}`;
}
function render(el){
  const cur=current(), p=cur.plan, yoga=p.kind==='yoga';
  const src=fromAI(cur.source)?'<span class="psrc ai">🧠 AI</span>':`<span class="psrc">${yoga?'⚙︎ Starter flow':'⚙︎ Auto-planned'}</span>`;
  const items=yoga?'poses':'exercises';
  el.innerHTML=`<div class="plan${cur.done?' done':''}">
    <div class="kindseg" role="tablist"><button data-kind="strength" class="${p.kind==='strength'||!p.kind?'on':''}">Strength</button><button data-kind="home" class="${p.kind==='home'?'on':''}">Home</button><button data-kind="yoga" class="${yoga?'on':''}">Yoga</button></div>
    ${yoga?`<div class="flavors" role="tablist" aria-label="Yoga flavor">${Object.entries(YOGA_FLAVORS).map(([k,[ic,l]])=>`<button data-flavor="${k}" class="${yogaFlavor()===k?'on':''}">${ic} ${l}</button>`).join('')}</div>
`:''}
    <div class="plan-h"><div><small>${cur.done?'✓ Done today':'Today · '+prettyDate(todayStr())}${yoga?' · '+h(YOGA_FLAVORS[p.flavor||'auto'][1])+' yoga':''}</small><b>${h(p.title)}</b></div>${src}</div>
    ${p.restSuggested&&!cur.done?'<div class="plan-rest">🛌 You’ve trained a lot lately — a rest day is a good call. If you train, keep it easy.</div>':''}
    ${p.why?`<div class="plan-why">${h(p.why)}</div>`:''}
    ${p.kind==='home'?'<div class="plan-rest yoga">🏠 No equipment — just you and the floor. Make it harder with slow 3-second lowers, pauses at the bottom and fewer rests.</div>':''}
    ${(()=>{ const n=planMods(p).length; return n?`<button class="modbanner" data-mods="1"><span class="modic">⚠︎</span><span><b>${n} pose${n===1?' needs':'s need'} a modification</b><small>${h(modReason())} · tap to see how, with videos</small></span><span class="chev">›</span></button>`:''; })()}
    <div class="plan-ex">${p.exercises.map(e=>`<div class="pxr"><button class="pxn" data-pex="${h(e.id)}">${poseHTML(exName(e.id))}${e.ss?' <span class="sstag">SS</span>':''}</button><span class="pxs">${setsSummary(e)}</span>${modsFor(e.id).map(m=>`<button class="modtag" data-mods="1">⚠︎ ${m.why?h(m.why[0].toUpperCase()+m.why.slice(1))+': ':''}${h(m.t)}</button>`).join('')}${e.note?`<small>${h(e.note)}</small>`:''}</div>`).join('')}</div>
    <div class="plan-meta">~${p.durationMin} min · ${p.exercises.length} ${items}${yoga?'':` · ${p.setsTotal||p.exercises.reduce((n,e)=>n+e.sets.length,0)} sets`}${p.warmup?` · warm-up: ${h(p.warmup)}`:''}</div>
    ${yoga&&!fromAI(cur.source)&&!cur.done?'<div class="plan-rest yoga">🧠 This is a starter flow. Tap <b>Generate my yoga flow</b> and the AI writes one around your recent lifting, recovery and injuries.</div>':''}
    ${cur.done?'<button class="dbtn" id="plAgain" style="width:100%">Plan another session</button>':`<button class="crew-btn cta" id="plStart"><span>Start today’s ${yoga?'yoga':p.kind==='home'?'home workout':'workout'} <small>~${p.durationMin} min</small></span><span class="arr"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></button>`}
    <div class="plan-adj">${Object.entries(ADJUST).map(([k,l])=>`<button data-adj="${k}" class="${cur.adjust===k?'on':''}">${l}</button>`).join('')}<button id="plSet">⚙ Settings</button></div>
    <div class="plask${yoga?' yoga':''}">
      <div class="plask-h"><b>${yoga?'Let AI write your flow':p.kind==='home'?'Let AI plan your home workout':'Let AI plan your workout'}</b><small>optional</small></div>
      <textarea id="plNote" rows="2" maxlength="400" placeholder="${yoga?'e.g. tight hips after squats, 30 min, no wrist-heavy poses, extra hamstring work':p.kind==='home'?'e.g. small room, no jumping (neighbours), focus on legs and core':'e.g. sore lower back, only dumbbells today, focus on arms, 35 min max'}">${h(aiNote(planKind()))}</textarea>
      <button class="aibtn${yoga?' primary':''}" id="plAI">✨ ${yoga?(fromAI(cur.source)?'Generate a different flow':'Generate my yoga flow'):(fromAI(cur.source)?'Re-plan with AI':'Ask AI to plan today')}</button>
    </div>
    ${(p.routineUpdates||[]).map((u,i)=>{ const done=(cur.applied||[]).includes(i);
      return `<div class="ru"><div class="ru-h"><b>${u.action==='update'?'Update routine':'New routine'}: ${h(u.name)}</b>${done?'<span class="chip on">applied</span>':''}</div>
        <div class="ru-r">${h(u.reason)}</div><div class="ru-x">${u.exercises.map(e=>h(exName(e.id))+' '+e.sets+'×'+h(e.reps||'')).join(' · ')}</div>
        ${done?'':`<button class="applybtn" data-ru="${i}">Apply</button>`}</div>`; }).join('')}
    <button class="linkbtn" id="plSave" style="margin-top:6px">＋ Save this plan as a routine</button>
  </div>`;
  el.querySelectorAll('[data-pex]').forEach(b=>b.onclick=()=>Workout.openExercise(b.dataset.pex));
  const st=el.querySelector('#plStart'); if(st) st.onclick=()=>{ if(planMods(p).length&&!(loadLiveSafe())) openModsSheet(p,()=>Workout.startPlan(p)); else Workout.startPlan(p); };
  el.querySelectorAll('[data-mods]').forEach(b=>b.onclick=ev=>{ ev.stopPropagation(); openModsSheet(p); });
  const ag=el.querySelector('#plAgain'); if(ag) ag.onclick=()=>setPlan(autoFor(p.kind,'other'),'auto','other');
  el.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>switchKind(b.dataset.kind));
  el.querySelectorAll('[data-flavor]').forEach(b=>b.onclick=()=>switchFlavor(b.dataset.flavor));
  el.querySelectorAll('[data-adj]').forEach(b=>b.onclick=()=>{ const k=cur.adjust===b.dataset.adj?'':b.dataset.adj; setPlan(autoFor(p.kind,k),'auto',k); toast(k?ADJUST[k]+' — plan adjusted':'Plan reset'); });
  el.querySelector('#plSet').onclick=openSettings;
  const nt=el.querySelector('#plNote'), saveNote=async()=>{ const k=planKind(), v=nt.value.trim().slice(0,400);
    if(!state.settings.aiNotes||typeof state.settings.aiNotes!=='object') state.settings.aiNotes={};
    if((state.settings.aiNotes[k]||'')!==v){ state.settings.aiNotes[k]=v; await persist(); } };
  nt.addEventListener('change',saveNote);
  el.querySelector('#plAI').onclick=async()=>{ await saveNote(); planWithAI(cur.adjust); };

  el.querySelectorAll('[data-ru]').forEach(b=>b.onclick=()=>applyRoutineUpdate(+b.dataset.ru));
  el.querySelector('#plSave').onclick=saveAsRoutine;
}
function renderAll(){ if(window.Workout) Workout.renderHome(); }
function loadLiveSafe(){ try{ const l=JSON.parse(localStorage.getItem(HOSTED?'ironlog-live:'+((window.IronAuth&&IronAuth.acct&&IronAuth.acct.id)||'nouser'):'ironlog-live')||'null'); return !!(l&&l.dayId==='ai'&&l.date===todayStr()); }catch(e){ return false; } }

async function planWithAI(adjust){
  const yoga=planKind()==='yoga';
  const prompt=yoga?buildYogaPrompt(adjust):buildPrompt(adjust);
  const use=async txt=>{
    let plan; try{ plan=yoga?parseYogaJSON(txt,adjust==='short'?SESSION_MIN:settings().minutes):parsePlanJSON(txt);
      if(planKind()==='home'){ const bad=plan.exercises.filter(e=>!HOME_IDS.has(e.id)); plan.exercises=plan.exercises.filter(e=>HOME_IDS.has(e.id)); if(plan.exercises.length<3) throw new Error('needs equipment'); plan=homePlan(plan); if(bad.length) toast('Left out '+bad.length+' move'+(bad.length>1?'s':'')+' that need equipment'); } }
    catch(e){ toast(yoga?'That didn’t look like a yoga flow — copy the AI’s whole reply':'That didn’t look like a workout plan — copy the AI’s whole reply'); return; }
    await setPlan(plan,'ai',adjust); $('#aiScrim').classList.remove('show'); toast((yoga?'AI wrote today’s flow: ':'AI planned today: ')+plan.title);
  };
  $('#aiTtl').textContent=yoga?'Yoga flow by AI':planKind()==='home'?'Home workout by AI':'Plan today with AI'; $('#aiDt').textContent=prettyDate(todayStr());
  if(API_AVAILABLE){
    $('#aiBody').innerHTML=`<div class="ai-sum"><span class="spin"></span> ${yoga?'The AI is reading your recent lifting and writing a 30–45 min yoga flow…':'The AI is reading your training log and planning today…'}</div>`;
    $('#aiScrim').classList.add('show');
    try{ await use(await askAI([{type:'text',text:prompt}],2500)); }
    catch(e){ console.error('plan failed',e); $('#aiBody').innerHTML=aiUnavailableHTML(); }
    return;
  }
  $('#aiBody').innerHTML=bridgeHTML(prompt,'plan')+`<div class="legend" style="margin-top:6px">${yoga?'The prompt includes your recent lifting, recovery, goal and injuries, so the AI can build a flow that helps your training.':'The prompt includes your recent workouts, recovery, best lifts, goal, injuries, equipment and routines, so the AI can plan around all of it.'}</div>`;
  $('#aiScrim').classList.add('show');
  wireBridge(use);
}

async function applyRoutineUpdate(i){
  const cur=current(), u=cur.plan.routineUpdates[i]; if(!u) return;
  if(u.action==='update'){
    const r=state.routines.find(x=>x.id===u.routineId); if(!r){ toast('That routine no longer exists'); return; }
    if(!await ask(`Replace the exercises in “${r.name}” with the AI’s version?`,'Replace')) return;
    r.exercises=u.exercises.map(e=>({...e})); if(u.name) r.name=u.name;
  } else {
    state.routines.push({id:'r'+Date.now().toString(36),name:u.name,exercises:u.exercises.map(e=>({...e})),why:u.reason});
  }
  cur.applied=[...(cur.applied||[]),i];
  await persist(); renderAll(); toast(u.action==='update'?'Routine updated':'Routine created');
}
async function saveAsRoutine(){
  const p=current().plan;
  const name=await askText('Name this routine',p.title); if(!name||!name.trim()) return;
  state.routines.push({id:'r'+Date.now().toString(36),name:name.trim().slice(0,40),why:p.why,
    exercises:p.exercises.map(e=>{ const w=e.sets.filter(s=>s.t!=='w'); return {id:e.id,sets:w.length||e.sets.length,rest:e.rest,reps:(w[0]||e.sets[0]).reps||'',rest:e.rest,note:e.note||'',ss:!!e.ss}; })});
  await persist(); renderAll(); toast('Saved as routine');
}

function openSettings(){
  const st=settings();
  $('#woSheet').innerHTML=`<div class="grab"></div><div class="rv-head"><div class="ttl">Plan settings</div></div>
    <div class="rv-sub">Your goal and injuries come from the You tab.</div>
    <div class="pf">
      <div class="pfield"><label>Session length</label><select id="psMin">${[SESSION_MIN,SESSION_MAX].map(m=>`<option value="${m}"${m===st.minutes?' selected':''}>${m} min</option>`).join('')}</select></div>
      <div class="pfield"><label>Days per week</label><select id="psDays">${[2,3,4,5,6].map(d=>`<option value="${d}"${d===st.daysPerWeek?' selected':''}>${d}</option>`).join('')}</select></div>
    </div>
    <div class="pfield" style="margin-top:6px"><label>Equipment you have</label><div class="eqgrid">${EQUIPMENT.map(e=>`<label><input type="checkbox" value="${e}" ${st.equipment.includes(e)?'checked':''}> ${e}</label>`).join('')}</div></div>
    <div class="legend" style="text-align:left;margin:6px 2px 0">Every session — lifting or yoga — is planned to fit 30–45 min. 2–3 days → full body · 4 → upper/lower · 5–6 → push/pull/legs, always picked by what’s most recovered.</div>
    <button class="crew-btn" id="psSave" style="margin-top:12px">Save &amp; re-plan today</button>
    <button class="rv-close" id="psClose" style="margin-top:8px">Cancel</button>`;
  $('#woScrim').classList.add('show');
  $('#psClose').onclick=()=>$('#woScrim').classList.remove('show');
  $('#psSave').onclick=async()=>{
    const eq=[...$('#woSheet').querySelectorAll('.eqgrid input:checked')].map(i=>i.value);
    if(!eq.length){ toast('Pick at least one'); return; }
    state.settings.plan={minutes:+$('#psMin').value,daysPerWeek:+$('#psDays').value,equipment:eq};
    $('#woScrim').classList.remove('show');
    await setPlan(autoFor(planKind(),''),'auto','');
  };
}

async function onFinish(entry){
  const cur=current(); cur.done=true;
  entry.plan={source:cur.source,group:cur.plan.group||'',focus:cur.plan.focus||''};
  if(cur.plan.kind==='yoga'){ entry.plan.kind='yoga'; state.mobility[entry.date]=true; }
  await persist(); renderAll();
  if(cur.plan.kind==='yoga') try{ renderGamify(); }catch(e){}
}

window.Planner={modsFor,modVideo,openModsSheet,render,switchFlavor,yogaFlavor,onFinish,autoPlan,autoYoga,buildPrompt,buildYogaPrompt,parsePlanJSON,parseYogaJSON,readyList,estMinutes};
// workout.js can render the home before this file loads; draw the plan once the app is ready
Promise.resolve(window.appReady).catch(()=>{}).then(()=>{ renderAll(); try{ renderCoach(); }catch(e){} });
})();

