/* js/platform.js — Iron Log platform layer (standalone build).
   Gives the app the small set of services it used inside a Claude artifact, without Claude:

     ironPlatform.use('db')        document store: doc()/collection() get/set/update/delete,
                                   where('f','==',v) / orderBy / limit / add
     ironPlatform.use('user')      { id() } — the backend identity of whoever is signed in
     ironPlatform.use('auth')      { authAs(username, dekBytes, create), signOut(), remote }
     ironPlatform.use('downloads') { save({filename,data}) } — plain browser download
     ironPlatform.use('sample')    AI call, provided by js/ai.js (null when no provider is set)

   Backends:
     Supabase   when IRONLOG_CONFIG.supabaseUrl + supabaseAnonKey are set (js/config.js).
                Rows live in public.docs (see supabase/schema.sql); row-level security
                limits reads/writes. Account data stays end-to-end encrypted by js/auth.js.
     Device     otherwise: IndexedDB on this device (localStorage fallback). Same API, no network.

   Backend sign-in: Iron Log keeps username + password. The Supabase password is NOT the user's
   password — it is derived from the account's data key (HMAC-SHA256), so both the password and the
   recovery code (each of which unwraps the data key) can sign in, and changing the password needs no
   backend change. Supabase never sees the user's password. */
(function(){
const CFG=Object.assign({supabaseUrl:'',supabaseAnonKey:'',emailDomain:'users.ironlog.app'},window.IRONLOG_CONFIG||{});
const te=new TextEncoder();
const hex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
const rid=()=>{ const a=crypto.getRandomValues(new Uint8Array(12)); return [...a].map(b=>'abcdefghijklmnopqrstuvwxyz0123456789'[b%36]).join(''); };
const parentOf=p=>p.split('/').slice(0,-1).join('/');
const leaf=p=>p.split('/').pop();
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));

/* ---------- shared document-API front end over a tiny row store ----------
   store: get(path) -> data|null, put(path,data), del(path), list(parent, {where,order,limit}) -> [{path,data}] */
function makeDb(store){
  const snap=(path,data)=>({exists:data!=null,id:leaf(path),data:()=>clone(data)});
  function doc(path){
    return {id:leaf(path),path,
      get:async()=>snap(path,await store.get(path)),
      set:async(obj)=>{ await store.put(path,clone(obj)); },
      update:async(patch)=>{ const cur=await store.get(path); if(cur==null) throw new Error('not-found'); await store.put(path,Object.assign(cur,clone(patch))); },
      delete:async()=>{ await store.del(path); }};
  }
  function query(parent,q){
    return {
      where:(f,op,v)=>{ if(op!=='==') throw new Error('only == supported'); return query(parent,{...q,where:[...(q.where||[]),[f,v]]}); },
      orderBy:(f,dir)=>query(parent,{...q,order:[f,dir==='desc'?'desc':'asc']}),
      limit:n=>query(parent,{...q,limit:n}),
      get:async()=>({docs:(await store.list(parent,q)).map(r=>snap(r.path,r.data))}),
    };
  }
  function collection(path){
    const q=query(path,{});
    return {...q, path,
      doc:id=>doc(path+'/'+(id==null?rid():id)),
      add:async(obj)=>{ const d=doc(path+'/'+rid()); await d.set(obj); return d; }};
  }
  return {doc,collection};
}
/* in-memory filtering shared by the device store */
function applyQuery(rows,q){
  let out=rows;
  for(const [f,v] of (q.where||[])) out=out.filter(r=>r.data&&r.data[f]===v);
  if(q.order){ const [f,d]=q.order, s=d==='desc'?-1:1; out=[...out].sort((a,b)=>{ const x=a.data[f], y=b.data[f]; return x===y?0:(x>y?s:-s); }); }
  if(q.limit) out=out.slice(0,q.limit);
  return out;
}

/* ---------- device backend: IndexedDB (localStorage fallback) ---------- */
function deviceStore(){
  const DBN='ironlog-docs', ST='docs', LSP='ironlog-doc:';
  let dbp=null;
  const idbOk=()=>typeof indexedDB!=='undefined'&&typeof indexedDB.open==='function';
  const open=()=>dbp||(dbp=new Promise((res,rej)=>{ const r=indexedDB.open(DBN,1); r.onupgradeneeded=()=>{ const s=r.result.createObjectStore(ST,{keyPath:'path'}); s.createIndex('parent','parent'); }; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }));
  const tx=async(mode,fn)=>{ const d=await open(); return new Promise((res,rej)=>{ const t=d.transaction(ST,mode); const out=fn(t.objectStore(ST)); t.oncomplete=()=>res(out&&out.result!==undefined?out.result:out); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error); }); };
  let useLS=!idbOk();
  const ls={
    get:async p=>{ const v=localStorage.getItem(LSP+p); return v==null?null:JSON.parse(v).data; },
    put:async(p,data)=>{ localStorage.setItem(LSP+p,JSON.stringify({parent:parentOf(p),data})); },
    del:async p=>{ localStorage.removeItem(LSP+p); },
    list:async(parent,q)=>{ const rows=[]; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(!k.startsWith(LSP)) continue; const v=JSON.parse(localStorage.getItem(k)); if(v.parent===parent) rows.push({path:k.slice(LSP.length),data:v.data}); } return applyQuery(rows,q); },
  };
  const idb={
    get:async p=>{ const r=await tx('readonly',s=>s.get(p)); return r?r.data:null; },
    put:async(p,data)=>{ await tx('readwrite',s=>s.put({path:p,parent:parentOf(p),data})); },
    del:async p=>{ await tx('readwrite',s=>s.delete(p)); },
    list:async(parent,q)=>{ const rows=await tx('readonly',s=>s.index('parent').getAll(parent)); return applyQuery((rows||[]).map(r=>({path:r.path,data:r.data})),q); },
  };
  const pick=k=>async(...a)=>{ if(!useLS){ try{ return await idb[k](...a); }catch(e){ useLS=true; } } return ls[k](...a); };
  return {get:pick('get'),put:pick('put'),del:pick('del'),list:pick('list')};
}

/* ---------- Supabase backend ---------- */
function supabaseStore(sb){
  const T='docs';
  const fail=e=>{ const x=new Error(e.message||'database error'); x.code=e.code; throw x; };
  return {
    get:async p=>{ const {data,error}=await sb.from(T).select('data').eq('path',p).maybeSingle(); if(error) fail(error); return data?data.data:null; },
    put:async(p,d)=>{ const {error}=await sb.from(T).upsert({path:p,parent:parentOf(p),data:d,updated_at:new Date().toISOString()},{onConflict:'path'}); if(error) fail(error); },
    del:async p=>{ const {error}=await sb.from(T).delete().eq('path',p); if(error) fail(error); },
    list:async(parent,q)=>{
      let r=sb.from(T).select('path,data').eq('parent',parent);
      for(const [f,v] of (q.where||[])) r=r.eq('data->>'+f,String(v));
      if(q.order) r=r.order('data->'+q.order[0],{ascending:q.order[1]!=='desc'});
      if(q.limit) r=r.limit(q.limit);
      const {data,error}=await r; if(error) fail(error);
      // data->>f compares as text: re-check exact type locally so 1 !== '1'
      return applyQuery((data||[]).map(x=>({path:x.path,data:x.data})),{where:q.where});
    },
  };
}

/* ---------- assemble ---------- */
const remote=!!(CFG.supabaseUrl&&CFG.supabaseAnonKey&&window.supabase&&window.supabase.createClient);
let sb=null, store, authSvc, userSvc;
if(remote){
  sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,storageKey:'ironlog-sb-session'}});
  store=supabaseStore(sb);
  const secretFor=async dek=>{ const k=await crypto.subtle.importKey('raw',dek,{name:'HMAC',hash:'SHA-256'},false,['sign']); return 'il1-'+hex(await crypto.subtle.sign('HMAC',k,te.encode('ironlog-backend-auth-v1'))); };
  const emailFor=u=>String(u).toLowerCase()+'@'+CFG.emailDomain;
  authSvc={remote:true,
    async authAs(username,dek,create){
      const email=emailFor(username), password=await secretFor(dek);
      const cur=(await sb.auth.getSession()).data.session;
      if(cur&&cur.user&&cur.user.email===email) return cur.user.id;
      if(create){
        const {data,error}=await sb.auth.signUp({email,password});
        if(error) throw new Error(/registered|exists/i.test(error.message)?'That username is taken':('Couldn’t create the account: '+error.message));
        if(!data.session) throw new Error('Account created but not signed in — turn off “Confirm email” in Supabase Auth settings');
        return data.user.id;
      }
      const {data,error}=await sb.auth.signInWithPassword({email,password});
      if(error) throw new Error(navigator.onLine===false?'You’re offline — sign-in needs a connection':'Couldn’t sign in to the Iron Log server');
      return data.user.id;
    },
    async signOut(){ try{ await sb.auth.signOut({scope:'local'}); }catch(e){} },
  };
  userSvc={async id(){ const s=(await sb.auth.getSession()).data.session; return s?s.user.id:'anon'; }};
}else{
  store=deviceStore();
  authSvc={remote:false, async authAs(){ return 'device'; }, async signOut(){}};
  userSvc={async id(){ return 'device'; }};
}
const db=makeDb(store);
const downloads={async save({filename,data}){
  const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
  const a=Object.assign(document.createElement('a'),{href:url,download:filename}); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000); return {status:'saved'};
}};
const services={db,user:userSvc,auth:authSvc,downloads};
window.ironPlatform={
  backend:remote?'supabase':'device',
  async use(name){ if(name==='sample') return window.IronAI?window.IronAI.sample():null; return services[name]||null; },
  _test:{makeDb,applyQuery,supabaseStore,deviceStore},
};
})();
