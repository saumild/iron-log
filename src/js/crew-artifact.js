/* js/crew-artifact.js */
/* ================= Crew inside a Claude artifact =================
   An artifact page can't reach the Iron Log server, so here Crew runs on the artifact's own
   shared `db`. Your crew is everyone the artifact is shared with who tapped "Join crew".
   It answers the same requests as netlify/lib/api-core.mjs, with the same response shapes,
   so social.js renders it unchanged.

   Every member writes ONLY under crew/<their id>; everyone reads (db rules, declared at publish):
     crew/<id>                    member: avatar, nickname, stats summary, workout calendar, inboxClearedAt
     crew/<id>/posts/<postId>     shared workouts
     crew/<id>/likes/<owner>__<postId>   a 💪 this member gave
     crew/<id>/comments/<cid>     a comment this member wrote ({owner, postId, text})
     crew/<id>/nudges/<cid>       a nudge this member sent ({to, msg})
   Likes, comments and nudges live with whoever made them, so notifications are gathered by
   reading the other members' subtrees. Names are never stored: a member's own nickname, else
   their Iron Log account name. Members are Iron Log accounts (ilcrew/<account id>), not Claude users. */
(function(){
if(!HOSTED) return;
const AVATARS=['🏋️','💪','🔥','🦍','🐻','🦁','🐺','🦅','⚡','🚀','🥇','🧠','🐉','🌟','🏃','🧘'];
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/, POST_ID_RE=/^\d{4}-\d{2}-\d{2}_[a-z0-9_-]{1,40}$/;
const NUDGE_GAP_MS=6*3600*1000, FEED_LIMIT=30, KEEP_POSTS=60;
let db=null, user=null, uid=null, ready=null;

function fail(msg){ return new Error(msg); }
const str=(v,max)=>String(v==null?'':v).trim().slice(0,max);
const num=(v,max=1e9)=>{ const n=Number(v); return Number.isFinite(n)?Math.max(0,Math.min(max,n)):0; };
const ts=v=>{ const n=Number(v); return Number.isFinite(n)&&n>0?n:0; };   // epoch ms — never capped like num()
const rid=()=>Date.now().toString(36).padStart(9,'0')+'-'+Math.random().toString(36).slice(2,8);
const avatarOk=a=>AVATARS.includes(a)?a:'🏋️';

function init(){
  return ready||(ready=(async()=>{
    // Crew identity is the signed-in Iron Log account, never the Claude account
    const d=await window.claude.use('db'); const acc=window.IronAuth&&IronAuth.acct;
    if(!d||!acc){ ready=null; return false; }
    db=d; uid=acc.id; return true;
  })().catch(()=>{ ready=null; return false; }));
}
const memberRef=id=>db.doc('ilcrew/'+id);
const sub=(id,name)=>db.collection('ilcrew/'+id+'/'+name);
const docs=snap=>snap.docs.filter(d=>d.exists).map(d=>({id:d.id,...d.data()}));

/* one write at a time to my member document */
let chain=Promise.resolve();
function serial(fn){ const run=chain.then(fn); chain=run.catch(()=>{}); return run; }

async function members(){ return docs(await db.collection('ilcrew').get()); }
async function myDoc(){ const s=await memberRef(uid).get(); return s.exists?s.data():null; }
function personOf(m,ps){ return {username:m.id,name:m.nick||m.name||'Someone',avatar:avatarOk(m.avatar)}; }

/* ---------- the same input checks the server applies ---------- */
function cleanSummary(s){
  s=s&&typeof s==='object'?s:{};
  const prs=Array.isArray(s.prs)?s.prs.slice(0,8).map(p=>({name:str(p&&p.name,60),top:num(p&&p.top,5000)})):[];
  return {level:num(s.level,999),title:str(s.title,30),xp:num(s.xp),sessions:num(s.sessions,1e6),volumeTotal:num(s.volumeTotal),
    weekKey:DATE_RE.test(s.weekKey)?s.weekKey:'',thisWeek:num(s.thisWeek,50),weekVolume:num(s.weekVolume),
    weekTarget:num(s.weekTarget,14)||4,weekStreak:num(s.weekStreak,9999),weekStreakMax:num(s.weekStreakMax,9999),
    lastWorkout:DATE_RE.test(s.lastWorkout)?s.lastWorkout:'',prs};
}
function cleanActivity(a){
  if(!Array.isArray(a)) return [];
  return a.filter(x=>x&&DATE_RE.test(x.d)).slice(-400).map(x=>({d:x.d,t:str(x.t,30),v:num(x.v),s:num(x.s,500),m:!!x.m}));
}
function cleanPost(p,id){
  p=p&&typeof p==='object'?p:{};
  const ex=Array.isArray(p.exercises)?p.exercises.slice(0,20).map(e=>({name:str(e&&e.name,60),
    sets:Array.isArray(e&&e.sets)?e.sets.slice(0,20).map(s=>str(s,16)):[],pr:!!(e&&e.pr)})).filter(e=>e.name):[];
  if(!ex.length) throw fail('A shared workout needs at least one exercise');
  const feels=['easy','right','hard','brutal'];
  return {id,username:uid,date:id.slice(0,10),unit:p.unit==='kg'?'kg':'lb',title:str(p.title,40)||'Workout',note:str(p.note,280),
    feel:feels.includes(p.feel)?p.feel:'',volume:num(p.volume),sets:num(p.sets,1000),week:num(p.week,99),
    exercises:ex,prCount:ex.filter(e=>e.pr).length};
}

/* ---------- requests ---------- */
async function meObj(){ const d=await myDoc(); const ps={}; return d?personOf({id:uid,...d},ps):null; }

async function crewView(){
  const d=await myDoc(); if(!d) throw fail('Join the crew first');
  const all=await members(), ps={};
  const others=all.filter(m=>m.id!==uid);
  const friends=others.map(m=>({...personOf(m,ps),since:m.joined||0,summary:m.summary||null,activity:Array.isArray(m.activity)?m.activity:[],updatedAt:m.updatedAt||0}))
    .sort((a,b)=>a.name.localeCompare(b.name));
  // notifications: what the others did that involves me, since I last cleared
  const since=ts(d.inboxClearedAt), myPosts={};
  docs(await sub(uid,'posts').get()).forEach(p=>{ myPosts[p.id]=p.title; });
  const inbox=[];
  await Promise.all(others.map(async m=>{
    const from=personOf(m,ps);
    const [likes,comments,nudges]=await Promise.all([
      sub(m.id,'likes').where('owner','==',uid).get().then(docs),
      sub(m.id,'comments').where('owner','==',uid).get().then(docs),
      sub(m.id,'nudges').where('to','==',uid).get().then(docs)]);
    likes.forEach(x=>inbox.push({id:'l'+m.id+x.id,type:'like',from,postId:x.postId,title:myPosts[x.postId]||'workout',at:ts(x.at)}));
    comments.forEach(x=>inbox.push({id:'c'+m.id+x.id,type:'comment',from,postId:x.postId,title:myPosts[x.postId]||'workout',text:str(x.text,80),at:ts(x.at)}));
    nudges.forEach(x=>inbox.push({id:'n'+m.id+x.id,type:'nudge',from,msg:str(x.msg,80),at:ts(x.at)}));
  }));
  return {me:personOf({id:uid,...d},ps),friends,incoming:[],outgoing:[],
    inbox:inbox.filter(i=>i.at>since).sort((a,b)=>b.at-a.at).slice(0,50)};
}

async function feedView(){
  const all=await members(), ps={}, users={};
  all.forEach(m=>{ users[m.id]=personOf(m,ps); });
  const per=await Promise.all(all.map(async m=>({
    posts:docs(await sub(m.id,'posts').orderBy('date','desc').limit(15).get()).map(p=>({...p,username:m.id})),
    likes:docs(await sub(m.id,'likes').get()).map(x=>({...x,by:m.id})),
    comments:docs(await sub(m.id,'comments').orderBy('at','desc').limit(200).get()).map(x=>({...x,by:m.id})),
  })));
  const likes={}, comments={};
  per.forEach(p=>{
    p.likes.forEach(x=>{ (likes[x.owner+'|'+x.postId]=likes[x.owner+'|'+x.postId]||[]).push(x.by); });
    p.comments.forEach(x=>{ const u=users[x.by]||{};
      (comments[x.owner+'|'+x.postId]=comments[x.owner+'|'+x.postId]||[]).push({id:x.id,username:x.by,name:u.name,avatar:u.avatar,text:str(x.text,280),at:ts(x.at)}); });
  });
  const posts=per.flatMap(p=>p.posts)
    .sort((a,b)=>a.date===b.date?ts(b.createdAt)-ts(a.createdAt):a.date<b.date?1:-1).slice(0,FEED_LIMIT)
    .map(p=>{ const k=p.username+'|'+p.id, lk=likes[k]||[];
      return {...p,likes:lk.length,likedByMe:lk.includes(uid),likers:lk.slice(0,12),comments:(comments[k]||[]).sort((a,b)=>a.at-b.at).slice(-20)}; });
  return {posts,users};
}

async function call(method,path,body){
  if(!(await init())) throw fail('Crew needs you signed in to your Iron Log account');
  body=body||{};
  const m=(re)=>path.match(re);
  let r;
  if(method==='GET'&&path==='/me') return {me:await meObj()};
  if(method==='GET'&&path==='/crew') return crewView();
  if(method==='GET'&&path==='/feed') return feedView();

  if(method==='POST'&&path==='/join') return serial(async()=>{
    const cur=await myDoc();
    if(!cur) await memberRef(uid).set({joined:Date.now(),name:str(IronAuth.acct.name,30),nick:str(body.nick,30),avatar:avatarOk(body.avatar),summary:null,activity:[],updatedAt:0,inboxClearedAt:Date.now()});
    return {me:await meObj()};
  });
  if(method==='PUT'&&path==='/profile') return serial(async()=>{
    if(!(await myDoc())) throw fail('Join the crew first');
    const patch={}; if(body.name!=null) patch.nick=str(body.name,30); if(body.avatar!=null) patch.avatar=avatarOk(body.avatar);
    await memberRef(uid).update(patch);
    return {me:await meObj()};
  });
  if(method==='POST'&&path==='/sync') return serial(async()=>{
    if(!(await myDoc())) return {ok:false};
    await memberRef(uid).update({summary:cleanSummary(body.summary),activity:cleanActivity(body.activity),updatedAt:Date.now()});
    return {ok:true};
  });
  if(method==='POST'&&path==='/inbox/clear') return serial(async()=>{ await memberRef(uid).update({inboxClearedAt:Date.now()}); return {ok:true}; });

  if((r=m(/^\/posts\/([^/]+)$/))&&method==='PUT'){
    const id=decodeURIComponent(r[1]); if(!POST_ID_RE.test(id)) throw fail('Bad workout id');
    if(!(await myDoc())) throw fail('Join the crew first');
    const ref=sub(uid,'posts').doc(id), old=await ref.get();
    const post={...cleanPost(body,id),createdAt:old.exists?ts(old.data().createdAt):Date.now(),updatedAt:Date.now()};
    await ref.set(post);
    // keep the store bounded: only the most recent shared workouts stay
    const mine=docs(await sub(uid,'posts').orderBy('date','desc').get());
    for(const extra of mine.slice(KEEP_POSTS)) await sub(uid,'posts').doc(extra.id).delete();
    return {post};
  }
  if((r=m(/^\/posts\/([^/]+)$/))&&method==='DELETE'){
    await sub(uid,'posts').doc(decodeURIComponent(r[1])).delete(); return {ok:true};
  }
  if((r=m(/^\/posts\/([^/]+)\/([^/]+)\/like$/))&&method==='POST'){
    const owner=decodeURIComponent(r[1]), pid=decodeURIComponent(r[2]);
    const post=await sub(owner,'posts').doc(pid).get(); if(!post.exists) throw fail('That workout was removed');
    const ref=sub(uid,'likes').doc(owner+'__'+pid), cur=await ref.get();
    if(cur.exists){ await ref.delete(); return {liked:false}; }
    await ref.set({owner,postId:pid,at:Date.now()}); return {liked:true};
  }
  if((r=m(/^\/posts\/([^/]+)\/([^/]+)\/comment$/))&&method==='POST'){
    const owner=decodeURIComponent(r[1]), pid=decodeURIComponent(r[2]);
    const text=str(body.text,280); if(!text) throw fail('Write something first');
    const post=await sub(owner,'posts').doc(pid).get(); if(!post.exists) throw fail('That workout was removed');
    const cid=rid(), at=Date.now();
    await sub(uid,'comments').doc(cid).set({owner,postId:pid,text,at});
    const me=await meObj();
    return {comment:{id:cid,username:uid,name:me.name,avatar:me.avatar,text,at}};
  }
  if((r=m(/^\/posts\/([^/]+)\/([^/]+)\/comment\/([^/]+)$/))&&method==='DELETE'){
    const ref=sub(uid,'comments').doc(decodeURIComponent(r[3]));
    if(!(await ref.get()).exists) throw fail('Only the person who wrote a comment can delete it');
    await ref.delete(); return {ok:true};
  }
  if(method==='POST'&&path==='/nudge'){
    const to=str(body.to,200);
    const sent=docs(await sub(uid,'nudges').where('to','==',to).get());
    if(sent.some(x=>Date.now()-ts(x.at)<NUDGE_GAP_MS)) throw fail('You nudged them recently — give it a few hours');
    for(const old of sent.filter(x=>Date.now()-ts(x.at)>30*86400000)) await sub(uid,'nudges').doc(old.id).delete();
    await sub(uid,'nudges').doc(rid()).set({to,msg:str(body.msg,80),at:Date.now()});
    return {ok:true};
  }
  if(method==='POST'&&path==='/account/delete') return serial(async()=>{
    for(const name of ['posts','likes','comments','nudges']) for(const x of docs(await sub(uid,name).get())) await sub(uid,name).doc(x.id).delete();
    await memberRef(uid).delete();
    return {ok:true};
  });
  throw fail('Not available in this version of Crew');
}

/* 'out' (can't use Crew here), 'new' (not joined yet) or 'in' */
async function status(){ if(!(await init())) return 'out'; return (await myDoc())?'in':'new'; }

window.CrewLocal={call,status,init,AVATARS};
})();

