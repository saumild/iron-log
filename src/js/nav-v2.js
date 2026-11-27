/* js/nav-v2.js — swipe between tabs, animated tab changes, large titles, compact top bar.
   Wraps app.js showView(); all view rendering stays in the original code. */
(function(){
const ORDER=['train','coach','stats','crew','you'];
const TITLES={train:'Today',coach:'Coach',stats:'Progress',crew:'Crew',you:'You'};
const RM=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const viewEl=v=>document.getElementById('view'+v[0].toUpperCase()+v.slice(1));
const nav=document.querySelector('.bnav');
const hTitle=document.getElementById('hTitle'), topbar=document.getElementById('topbar'), topT=document.getElementById('topT');
let touched=false; addEventListener('pointerdown',()=>{touched=true;},{once:true,capture:true});
const buzz=p=>{ if(!touched) return; try{ navigator.vibrate&&navigator.vibrate(p); }catch(e){} };

/* date eyebrow */
try{ const d=new Date(); document.getElementById('hEyebrow').textContent=
  d.toLocaleDateString('en-US',{weekday:'short'})+' · '+d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }catch(e){}

/* sliding indicator */
const ind=document.createElement('i'); ind.className='nind'; nav.prepend(ind);
const btnW=()=>{ const b=nav.querySelector('.nbtn'); return b?b.offsetWidth:62; };
function placeInd(f,instant){
  if(instant) ind.style.transition='none';
  ind.style.transform=`translateX(${f*btnW()}px)`;
  if(instant){ ind.offsetWidth; ind.style.transition=''; }
}
const idx=v=>Math.max(0,ORDER.indexOf(v));
addEventListener('resize',()=>placeInd(idx(activeView),true));
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>placeInd(idx(activeView),true));

/* compact top bar on scroll */
const updTop=()=>topbar.classList.toggle('on',window.scrollY>96);
addEventListener('scroll',updTop,{passive:true});

/* animate one view in */
function animIn(v,dir){
  if(RM) return;
  const el=viewEl(v); if(!el) return;
  el.classList.remove('il-in-r','il-in-l'); void el.offsetWidth;
  el.classList.add(dir>0?'il-in-r':'il-in-l');
  setTimeout(()=>el.classList.remove('il-in-r','il-in-l'),500);
  const box=v==='train'?(document.getElementById('woHome')||el):el;
  [...box.children].filter(c=>c.offsetHeight&&!c.classList.contains('vtitle')).slice(0,7).forEach((c,i)=>{
    c.classList.remove('il-rise'); void c.offsetWidth; c.style.animationDelay=(60+i*45)+'ms'; c.classList.add('il-rise');
    setTimeout(()=>{ c.classList.remove('il-rise'); c.style.animationDelay=''; },700+i*45);
  });
  hTitle.classList.remove('il-swap'); void hTitle.offsetWidth; hTitle.classList.add('il-swap');
}

/* wrap the app's view switcher */
const baseShow=window.showView;
let swipeDir=0;
window.showView=function(v){
  const prev=activeView;
  baseShow(v);
  hTitle.textContent=TITLES[v]||''; topT.textContent=TITLES[v]||'';
  placeInd(idx(v));
  if(prev!==v){ animIn(v, swipeDir || (idx(v)>idx(prev)?1:-1)); buzz(6); }
  swipeDir=0; updTop();
};

/* finger-following swipe between tabs */
const BLOCK='input,textarea,select,button.stype,.rlist,.calstrip,.mchips,.flavors,.plan-adj,.chips,.pviz,.chartbox,.chart,svg,.avpick,.seg,.kindseg,.llist,.cal,.step';
function scrollsX(t){
  for(let n=t;n&&n!==document.body&&n.nodeType===1;n=n.parentElement){
    if(n.scrollWidth>n.clientWidth+2){ const ox=getComputedStyle(n).overflowX; if(ox==='auto'||ox==='scroll') return true; }
  }
  return false;
}
let g=null;
document.addEventListener('touchstart',e=>{
  g=null;
  if(e.touches.length!==1) return;
  if(document.body.classList.contains('live-on')||document.querySelector('.scrim.show')) return;
  const t=e.target; if(!(t instanceof Element)||t.closest(BLOCK)||scrollsX(t)) return;
  const el=viewEl(activeView); if(!el) return;
  g={x:e.touches[0].clientX,y:e.touches[0].clientY,t:performance.now(),lock:null,el,w:window.innerWidth,i:idx(activeView),dx:0};
},{passive:true});
document.addEventListener('touchmove',e=>{
  if(!g) return;
  const dx=e.touches[0].clientX-g.x, dy=e.touches[0].clientY-g.y;
  if(g.lock===null){
    if(Math.abs(dx)<9&&Math.abs(dy)<9) return;
    g.lock=Math.abs(dx)>Math.abs(dy)*1.25?'x':'y';
    if(g.lock==='x'){ g.el.style.transition='none'; ind.style.transition='none'; }
  }
  if(g.lock!=='x') return;
  e.preventDefault();
  let x=dx; if((g.i===0&&dx>0)||(g.i===ORDER.length-1&&dx<0)) x=dx*0.22;
  g.dx=dx;
  g.el.style.transform=`translateX(${x}px)`;
  g.el.style.opacity=String(1-Math.min(.55,Math.abs(x)/g.w*.7));
  const f=Math.max(0,Math.min(ORDER.length-1,g.i-x/g.w*1.15));
  ind.style.transform=`translateX(${f*btnW()}px)`;
},{passive:false});
function endSwipe(cancel){
  if(!g||g.lock!=='x'){ g=null; return; }
  const {el,i,w,dx,t}=g; g=null; ind.style.transition='';
  const v=Math.abs(dx)/Math.max(1,performance.now()-t);
  let n=i; if(!cancel&&(Math.abs(dx)>w*0.2||(v>0.45&&Math.abs(dx)>34))) n=i+(dx<0?1:-1);
  if(n<0||n>=ORDER.length) n=i;
  if(n===i){
    el.style.transition='transform .5s var(--spring), opacity .3s'; el.style.transform=''; el.style.opacity='';
    setTimeout(()=>{ el.style.transition=''; },520); placeInd(i); return;
  }
  const d=dx<0?1:-1;
  el.style.transition='transform .2s cubic-bezier(.4,0,1,1), opacity .2s';
  el.style.transform=`translateX(${-d*w*0.45}px)`; el.style.opacity='0';
  setTimeout(()=>{ el.style.transition=''; el.style.transform=''; el.style.opacity=''; swipeDir=d; showView(ORDER[n]); },190);
}
document.addEventListener('touchend',()=>endSwipe(false),{passive:true});
document.addEventListener('touchcancel',()=>endSwipe(true),{passive:true});

/* keyboard (desktop) */
addEventListener('keydown',e=>{
  if(document.body.classList.contains('live-on')||document.querySelector('.scrim.show')) return;
  if(e.target.closest&&e.target.closest('input,textarea,select')) return;
  const i=idx(activeView);
  if(e.key==='ArrowRight'&&i<ORDER.length-1) showView(ORDER[i+1]);
  if(e.key==='ArrowLeft'&&i>0) showView(ORDER[i-1]);
});

/* sync once the app has booted */
Promise.resolve(window.appReady).then(()=>{ hTitle.textContent=TITLES[activeView]||''; topT.textContent=hTitle.textContent; placeInd(idx(activeView),true); });
})();
