/* js/ai.js — bring-your-own AI. Iron Log is not tied to any one AI.

   Each person picks, on their own device (You tab → AI coach):
     bridge     Copy & paste (default): the app copies a prompt, you paste it into ChatGPT, Claude,
                Gemini or any AI app, then paste the reply back. No key, nothing sent by the app.
     openai     OpenAI API      (your key)  POST api.openai.com/v1/chat/completions
     anthropic  Anthropic API   (your key)  POST api.anthropic.com/v1/messages
     gemini     Google Gemini   (your key)  POST generativelanguage.googleapis.com/v1beta/models/<m>:generateContent

   The key is stored only in this browser (localStorage 'ironlog-ai'), never in the synced account
   or backups, and is sent only to the provider the person chose.

   IronAI.sample() returns fn(text,{images:Blob[]}) -> {text}: the same shape app.js already uses. */
(function(){
const KEY='ironlog-ai';
const PROVIDERS={
  bridge:   {label:'Copy & paste — any AI app', needsKey:false},
  openai:   {label:'OpenAI (ChatGPT)',  needsKey:true, model:'gpt-5.6-terra',         keyHint:'sk-…',     keyUrl:'https://platform.openai.com/api-keys'},
  anthropic:{label:'Anthropic (Claude)', needsKey:true, model:'claude-sonnet-5-5',    keyHint:'sk-ant-…', keyUrl:'https://console.anthropic.com/settings/keys'},
  gemini:   {label:'Google Gemini',      needsKey:true, model:'gemini-3.5-flash-lite', keyHint:'AIza…',    keyUrl:'https://aistudio.google.com/apikey'},
};
function get(){ try{ const v=JSON.parse(localStorage.getItem(KEY)||'null'); if(v&&PROVIDERS[v.provider]) return v; }catch(e){} return {provider:'bridge',key:'',model:''}; }
function put(v){ try{ localStorage.setItem(KEY,JSON.stringify(v)); }catch(e){} }
const ready=c=>c.provider!=='bridge'&&!!c.key;
const modelOf=c=>(c.model||'').trim()||PROVIDERS[c.provider].model;
const blobB64=b=>new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result).split(',')[1]); r.onerror=rej; r.readAsDataURL(b); });

async function call(c,text,images,maxTokens){
  const imgs=await Promise.all((images||[]).map(async b=>({type:b.type||'image/jpeg',data:await blobB64(b)})));
  const model=modelOf(c), mt=maxTokens||2500;
  let url, headers={'content-type':'application/json'}, body, pick;
  if(c.provider==='openai'){
    url='https://api.openai.com/v1/chat/completions'; headers.authorization='Bearer '+c.key;
    const content=[{type:'text',text},...imgs.map(i=>({type:'image_url',image_url:{url:`data:${i.type};base64,${i.data}`}}))];
    body={model,max_completion_tokens:mt,messages:[{role:'user',content}]};
    pick=d=>((d.choices||[])[0]||{}).message?.content||'';
  }else if(c.provider==='anthropic'){
    url='https://api.anthropic.com/v1/messages';
    Object.assign(headers,{'x-api-key':c.key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'});
    const content=[...imgs.map(i=>({type:'image',source:{type:'base64',media_type:i.type,data:i.data}})),{type:'text',text}];
    body={model,max_tokens:mt,messages:[{role:'user',content}]};
    pick=d=>(d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  }else if(c.provider==='gemini'){
    url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`; headers['x-goog-api-key']=c.key;
    body={contents:[{role:'user',parts:[{text},...imgs.map(i=>({inline_data:{mime_type:i.type,data:i.data}}))]}],generationConfig:{maxOutputTokens:mt}};
    pick=d=>(((d.candidates||[])[0]||{}).content?.parts||[]).map(p=>p.text||'').join('');
  }else throw new Error('No AI provider set');
  let r; try{ r=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)}); }
  catch(e){ throw new Error(navigator.onLine===false?'You’re offline':'Couldn’t reach '+PROVIDERS[c.provider].label); }
  let d={}; try{ d=await r.json(); }catch(e){}
  if(!r.ok){
    const m=(d.error&&(d.error.message||d.error))||('error '+r.status);
    if(r.status===401||r.status===403) throw new Error('The API key was refused — check it in You → AI coach');
    if(r.status===404||/model/i.test(String(m))) throw new Error('Model “'+model+'” isn’t available — change it in You → AI coach');
    if(r.status===429) throw new Error('Rate limit or quota reached on your '+PROVIDERS[c.provider].label+' account');
    throw new Error(String(m).slice(0,160));
  }
  const out=String(pick(d)||'').trim(); if(!out) throw new Error('The AI returned an empty reply');
  return out;
}

const IronAI={
  PROVIDERS, get, set(v){ put(Object.assign(get(),v)); },
  ready:()=>ready(get()),
  name:()=>{ const c=get(); return c.provider==='bridge'?'your AI app':PROVIDERS[c.provider].label.replace(/ \(.*\)/,''); },
  /* the in-app call, or null in copy & paste mode */
  sample(){ const c=get(); if(!ready(c)) return null; return async(text,opts)=>({text:await call(c,text,(opts&&opts.images)||[],opts&&opts.maxTokens)}); },
  test:async c=>call(c,'Reply with just the word OK.',[],20),
  renderCard(){
    const el=document.getElementById('aiCard'); if(!el) return;
    const c=get(), p=PROVIDERS[c.provider];
    const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
    el.innerHTML=`<div class="sh"><b>AI coach</b><small>Works with ChatGPT, Claude, Gemini or any AI</small></div>
      <div class="pfield"><label>How Iron Log talks to AI</label><select id="aiProv">${Object.entries(PROVIDERS).map(([k,v])=>`<option value="${k}"${k===c.provider?' selected':''}>${esc(v.label)}</option>`).join('')}</select></div>
      ${p.needsKey?`<div class="pfield"><label>API key — stored only on this device</label><input id="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(p.keyHint)}" value="${esc(c.key)}"></div>
      <div class="pfield"><label>Model</label><input id="aiModel" spellcheck="false" autocapitalize="none" placeholder="${esc(p.model)}" value="${esc(c.model)}"></div>
      <div class="legend" style="margin:2px 2px 8px">Get a key at <a href="${p.keyUrl}" target="_blank" rel="noopener">${esc(p.keyUrl.replace('https://',''))}</a>. Usage is billed to your own ${esc(p.label.replace(/ \(.*\)/,''))} account. The key is never synced or included in backups.</div>
      <div class="dbtns"><button class="dbtn" id="aiSave">Save</button><button class="dbtn" id="aiTest">Test</button></div>`
      :`<div class="legend" style="margin:2px 2px 6px">When you ask for a plan, a yoga flow or coaching, Iron Log copies a prompt. Paste it into ChatGPT, Claude, Gemini — any AI app — then paste the reply back. No key needed; the app sends nothing itself.</div>`}
      <div class="ila-err" id="aiMsg" style="margin-top:6px"></div>`;
    const msg=(t,ok)=>{ const m=el.querySelector('#aiMsg'); m.textContent=t; m.style.color=ok?'var(--ok, #2f8f4e)':''; };
    const read=()=>({provider:el.querySelector('#aiProv').value,key:(el.querySelector('#aiKey')||{value:c.key}).value.trim(),model:(el.querySelector('#aiModel')||{value:c.model}).value.trim()});
    el.querySelector('#aiProv').onchange=e=>{ const v=e.target.value; put({...get(),provider:v,model:v===c.provider?c.model:''}); IronAI.renderCard(); IronAI.changed(); };
    const s=el.querySelector('#aiSave'); if(s) s.onclick=()=>{ put(read()); IronAI.changed(); msg('Saved',true); };
    const t=el.querySelector('#aiTest'); if(t) t.onclick=async()=>{ const v=read(); if(!v.key){ msg('Paste your API key first'); return; }
      t.disabled=true; msg('Testing…',true);
      try{ await IronAI.test(v); put(v); IronAI.changed(); msg('✓ Connected — AI features now run in the app',true); }catch(e){ msg(e.message); }
      t.disabled=false; };
  },
  changed(){ try{ if(typeof window.aiProviderChanged==='function') window.aiProviderChanged(); }catch(e){} },
};
window.IronAI=IronAI;
})();
