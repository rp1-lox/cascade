'use strict';
/* Plume Library page — lists all Waterfall EFFECTTEMPLATEs, renders the selected
 * one live with PlumeRenderer, exposes a per-effect accordion editor (enable/disable,
 * material params, offsets, modifier list) for custom templates, and exports the
 * (edited) template back to EFFECTTEMPLATE cfg text.
 *
 * No native browser dialogs anywhere (prompt/alert/confirm banned) — all name-entry,
 * pickers and confirmations go through the custom openDialog() component below. */

const $ = s => document.querySelector(s);
const qs = new URLSearchParams(location.search);

let TEMPLATES = [], PARAMS = {}, CUR = null, MOUNTED = false, WEBGL_OK = true, STARTERS = [];
const controllers = { throttle: 0.85, atmosphereDepth: 1, random: 0 };

const kvOf = (n,k) => { const e=(n.k||[]).find(([kk])=>kk===k); return e?e[1]:undefined; };
const setKV = (n,k,v) => { const e=(n.k||[]).find(([kk])=>kk===k); if(e) e[1]=v; else (n.k=n.k||[]).push([k,v]); };
const removeKV = (n,k) => { if(!n.k) return; const i=n.k.findIndex(([kk])=>kk===k); if(i>=0) n.k.splice(i,1); };

// ============================================================================
// Custom dialog component (replaces prompt/alert/confirm entirely).
//   openDialog({kind:'text'|'list'|'confirm'|'alert', title, message, value, list, okText, cancelText})
//   -> Promise resolving to: text value (string) | list item's value | true (confirm) | true (alert) | null (cancelled)
// ============================================================================
function openDialog(opts){
  return new Promise(resolve=>{
    const ov = $('#eeOverlay');
    const box = $('#eeDialog');
    box.innerHTML='';
    const h=document.createElement('h3'); h.textContent=opts.title||''; box.appendChild(h);
    if(opts.message){ const m=document.createElement('div'); m.className='eeMsg'; m.textContent=opts.message; box.appendChild(m); }

    let getValue=()=>true, inp=null;
    if(opts.kind==='text'){
      inp=document.createElement('input'); inp.type='text'; inp.value=opts.value||''; inp.autocomplete='off';
      box.appendChild(inp);
      getValue=()=>inp.value.trim();
      inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); finish(getValue()); } });
    } else if(opts.kind==='list'){
      const listEl=document.createElement('div'); listEl.className='eeList';
      let selected = (opts.list && opts.list[0]) ? opts.list[0].value : null;
      (opts.list||[]).forEach((item,i)=>{
        const d=document.createElement('div'); d.textContent=item.label; if(i===0) d.classList.add('sel');
        d.addEventListener('click',()=>{ selected=item.value; [...listEl.children].forEach(c=>c.classList.remove('sel')); d.classList.add('sel'); });
        d.addEventListener('dblclick',()=>finish(item.value));
        listEl.appendChild(d);
      });
      box.appendChild(listEl);
      getValue=()=>selected;
    }

    const btns=document.createElement('div'); btns.className='eeBtns';
    if(opts.kind!=='alert'){
      const cancel=document.createElement('button'); cancel.className='btn'; cancel.textContent=opts.cancelText||'Cancel';
      cancel.addEventListener('click',()=>finish(null));
      btns.appendChild(cancel);
    }
    const ok=document.createElement('button'); ok.className='btn primary'; ok.textContent=opts.okText||'OK';
    ok.addEventListener('click',()=>finish(getValue()));
    btns.appendChild(ok);
    box.appendChild(btns);

    function finish(v){
      ov.classList.remove('show');
      document.removeEventListener('keydown', keyHandler, true);
      resolve(v);
    }
    function keyHandler(e){
      if(e.key==='Escape'){ e.preventDefault(); finish(null); }
    }
    document.addEventListener('keydown', keyHandler, true);
    ov.classList.add('show');
    setTimeout(()=>{ if(inp){ inp.focus(); inp.select(); } else ok.focus(); }, 0);
  });
}
const dAlert = (message, title) => openDialog({kind:'alert', title:title||'Notice', message});
const dConfirm = (message, title) => openDialog({kind:'confirm', title:title||'Confirm', message, okText:'Delete', cancelText:'Cancel'}).then(v=>v===true);

// ============================================================================
// Boot
// ============================================================================
async function boot(){
  try {
    PARAMS = await (await fetch('/api/shaderparams')).json();
  } catch(e){ PARAMS = {}; }
  try {
    const s = await (await fetch('/api/plume/starters')).json();
    STARTERS = s.templates || [];
  } catch(e){ STARTERS = []; }
  await loadList();
  $('#plSearch').addEventListener('input', renderList);
  $('#plAll').addEventListener('change', loadList);
  $('#plNew').addEventListener('click', newPlumeFlow);
  $('#plRename').addEventListener('click', renamePlume);
  $('#plDelete').addEventListener('click', deletePlume);
  $('#plSave').addEventListener('click', savePlume);
  $('#plCloneEdit').addEventListener('click', cloneCurrentToEdit);
  $('#plAddEffect').addEventListener('click', addEffectFlow);
  $('#plAssign').addEventListener('click', assignToEngineFlow);
  $('#plCompile').addEventListener('click', compileFlow);
  $('#plThrottle').addEventListener('input', e=>{
    controllers.throttle=+e.target.value; $('#plThrottleV').textContent=(+e.target.value).toFixed(2);
    if(MOUNTED) PlumeRenderer.setController('throttle', controllers.throttle);
  });
  $('#plAtmo').addEventListener('input', e=>{
    controllers.atmosphereDepth=+e.target.value; $('#plAtmoV').textContent=(+e.target.value).toFixed(2);
    if(MOUNTED) PlumeRenderer.setController('atmosphereDepth', controllers.atmosphereDepth);
  });
  $('#plExport').addEventListener('click', toggleExport);
  $('#plBloom').addEventListener('input', e=>{
    $('#plBloomV').textContent=(+e.target.value).toFixed(2);
    if(MOUNTED) PlumeRenderer.setBloomStrength(+e.target.value);
  });
  $('#plExposure').addEventListener('input', e=>{
    $('#plExposureV').textContent=(+e.target.value).toFixed(2);
    if(MOUNTED) PlumeRenderer.setExposure(+e.target.value);
  });

  // try mounting the renderer once
  try {
    PlumeRenderer.mount($('#plCanvasWrap'));
    MOUNTED = true;
  } catch(e){
    WEBGL_OK = false;
    const err=$('#plErr'); err.style.display='flex';
    err.textContent='WebGL2 preview unavailable: '+e.message;
  }

  const want = qs.get('template');
  if(want){ const t=TEMPLATES.find(t=>t.name===want); if(t) select(t); }
}

async function loadList(){
  const all = $('#plAll').checked ? '?all=1' : '';
  TEMPLATES = await (await fetch('/api/plume/list'+all)).json();
  renderList();
}

function renderList(){
  const q=($('#plSearch').value||'').toLowerCase();
  const ul=$('#plUl'); ul.innerHTML='';
  const matches = t => !q || t.name.toLowerCase().includes(q) || t.providedBy.toLowerCase().includes(q);

  const mine = TEMPLATES.filter(t=>t.source==='custom' && matches(t))
    .sort((a,b)=>a.name.localeCompare(b.name));
  if(mine.length || !q){
    const h=document.createElement('li'); h.className='mod'; h.textContent='My plumes'; ul.appendChild(h);
    for(const t of mine) ul.appendChild(rowEl(t));
    if(!mine.length){ const e=document.createElement('li'); e.style.cssText='padding:5px 14px;font-size:11.5px;color:var(--dim);';
      e.textContent='(none yet — clone a template below)'; ul.appendChild(e); }
  }

  const groups={};
  for(const t of TEMPLATES){
    if(t.source!=='mod' || !matches(t)) continue;
    (groups[t.providedBy]=groups[t.providedBy]||[]).push(t);
  }
  for(const mod of Object.keys(groups).sort()){
    const h=document.createElement('li'); h.className='mod'; h.textContent=mod; ul.appendChild(h);
    for(const t of groups[mod].sort((a,b)=>a.name.localeCompare(b.name))) ul.appendChild(rowEl(t));
  }
}

function rowEl(t){
  const li=document.createElement('li'); li.dataset.name=t.name;
  const nm=document.createElement('span');
  nm.textContent=(t.source==='custom'?'✎ ':'')+t.name;
  const uc=document.createElement('span'); uc.className='uc';
  const usedBy = t.usedByEngines ? t.usedByEngines.length : 0;
  uc.textContent = t.source==='custom' ? '' : (t.usageCount+'× · '+usedBy+' eng');
  if(usedBy) uc.title = t.usedByEngines.slice(0,20).join(', ') + (t.usedByEngines.length>20?', …':'');
  li.appendChild(nm); li.appendChild(uc);
  li.addEventListener('click',()=>select(t));
  if(CUR && CUR.name===t.name) li.classList.add('sel');
  return li;
}

async function select(t){
  const data = await (await fetch('/api/plume/get?name='+encodeURIComponent(t.name))).json();
  if(data.error){ return; }
  CUR = data;
  CUR.name = t.name;
  CUR.providedBy = t.providedBy;
  CUR._openIdx = new Set();
  applyEngineOverrides(CUR.node);
  $('#plTitle').textContent=t.name;
  $('#plMod').textContent=(data.source==='custom'?'My plumes (custom)':(t.providedBy+' · '+(data.parentUrl||'')))
    + (data.source==='custom' && data.base ? '  ·  forked from '+data.base : '');
  $('#plExportBox').style.display='none';
  updateEditUI();
  renderList();
  reloadRender();
  buildEffects();
}

function updateEditUI(){
  const editable = !!(CUR && CUR.source==='custom');
  $('#plRename').style.display = editable ? '' : 'none';
  $('#plDelete').style.display = editable ? '' : 'none';
  $('#plSave').style.display = editable ? '' : 'none';
  $('#plAddEffect').style.display = editable ? '' : 'none';
  $('#plAssign').style.display = editable ? '' : 'none';
  $('#plCloneEdit').style.display = (CUR && !editable) ? '' : 'none';
  $('#plReadonlyNote').style.display = (CUR && !editable) ? '' : 'none';
  renderAssignments();
}

// ---- Assign to engine / Compile (Phase 2, Case A) ----
let ENGINES_CAT = null;
async function loadEngineCatalog(){
  if(ENGINES_CAT) return ENGINES_CAT;
  ENGINES_CAT = await (await fetch('/api/engines')).json();
  return ENGINES_CAT;
}

// Render which engines reference the currently-selected custom template.
async function renderAssignments(){
  const box=$('#plAssignments'), list=$('#plAssignList');
  if(!(CUR && CUR.source==='custom')){ box.style.display='none'; return; }
  box.style.display='';
  const data = await (await fetch('/api/plume/manifest')).json().catch(()=>({engines:{}}));
  const rows=[];
  for(const [part, eng] of Object.entries(data.engines||{})){
    if(eng.case==='B'){
      for(const [sub, p] of Object.entries(eng.editSubtypes||{})){
        if(p.template===CUR.name) rows.push({part, text:'[B] subtype "'+sub+'"', kind:'subtype', key:sub});
      }
      if(eng.editBase && eng.editBase.template===CUR.name)
        rows.push({part, text:'[B] base plume', kind:'base', key:''});
      for(const v of (eng.addVariants||[])){
        if(v.template===CUR.name) rows.push({part, text:'[B] variant "'+v.name+'" (copy of '+v.copyFrom+')', kind:'variant', key:v.name});
      }
    } else {
      for(const v of (eng.variants||[])){
        if(v.name!=='Stock' && v.template===CUR.name) rows.push({part, text:'variant "'+v.name+'"', kind:'A', key:v.name});
      }
    }
  }
  list.innerHTML='';
  if(!rows.length){ list.textContent='(not assigned to any engine yet)'; return; }
  for(const r of rows){
    const div=document.createElement('div'); div.style.cssText='display:flex;gap:8px;align-items:center;padding:2px 0;';
    const label=document.createElement('span'); label.style.flex='1'; label.textContent=r.part+'  ·  '+r.text;
    const rm=document.createElement('button'); rm.className='btn'; rm.style.cssText='font-size:11px;padding:2px 8px;'; rm.textContent='Remove';
    rm.addEventListener('click', async ()=>{
      if(r.kind==='A'){
        await fetch('/api/plume/remove-variant',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({part:r.part, variant:r.key})});
      } else {
        await fetch('/api/plume/remove-b',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({part:r.part, kind:r.kind, key:r.key})});
      }
      renderAssignments();
    });
    div.appendChild(label); div.appendChild(rm); list.appendChild(div);
  }
}

async function assignToEngineFlow(){
  if(!(CUR && CUR.source==='custom')){ await dAlert('Select a custom plume first.'); return; }
  const engs = await loadEngineCatalog();
  const list = engs.map(e=>({label:(e.title||e.part)+'  ['+e.part+']', value:e.part}))
    .sort((a,b)=>a.label.localeCompare(b.label));
  const part = await openDialog({kind:'list', title:'Assign "'+CUR.name+'" — pick an engine', list, okText:'Next'});
  if(!part) return;
  const info = await (await fetch('/api/plume/engine-info?part='+encodeURIComponent(part))).json();
  if(info.error){ await dAlert('Engine info failed: '+info.error); return; }
  if(info.case==='B'){
    await caseBFlow(part, info);
    return;
  }
  if(info.case==='none'){
    await dAlert('This engine has no ModuleWaterfallFX plume to switch.', 'No Waterfall plume');
    return;
  }
  const wf = info.wfModules[0] || {moduleID:'', attach:{}};
  const at = wf.attach || {};
  const label = await openDialog({kind:'text', title:'Variant label (shown in the VAB switcher)',
    value:CUR.name, okText:'Assign'});
  if(!label) return;
  const variant = {name: label, template: CUR.name,
    overrideParentTransform: at.overrideParentTransform||'',
    position: at.position||'0,0,0', rotation: at.rotation||'0,0,0', scale: at.scale||'1,1,1'};
  const res = await fetch('/api/plume/assign',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({part, wfModuleID: wf.moduleID, variant})});
  const data = await res.json();
  if(data.error){ await dAlert('Assign failed: '+data.error); return; }
  await dAlert('Assigned to '+part+' (Case A, WF module "'+wf.moduleID+'"). Click "Compile / Apply to GameData" when ready. Nothing is written to GameData until you compile.', 'Assigned');
  renderAssignments();
}

// Case B: engine already switches its plume. Edit inside the existing switcher — no
// parallel B9PS. Three operations (docs §5f): set a plume on an existing subtype, edit the
// base/default plume, or add a new variant by copying a subtype. Custom dialogs only.
async function caseBFlow(part, info){
  const cb = info.caseB || {};
  const subs = cb.subtypes || [];
  const op = await openDialog({kind:'list',
    title:'"'+part+'" already switches its plume (Case B) — pick an operation',
    list:[
      {label:'Set "'+CUR.name+'" on an existing subtype', value:'subtype'},
      {label:'Edit the base / default plume (subtypes with no override)', value:'base'},
      {label:'＋ Add a new variant (copy a subtype, apply "'+CUR.name+'")', value:'variant'},
    ], okText:'Next'});
  if(!op) return;

  if(op==='subtype'){
    if(!subs.length){ await dAlert('This switcher exposes no subtypes.'); return; }
    const list = subs.map(s=>({label:s.name+(s.hasOverride?'  · has plume override ('+(s.template||'?')+')':'  · inherits base ('+(s.template||'?')+')'), value:s.name}));
    const sub = await openDialog({kind:'list', title:'Which subtype gets "'+CUR.name+'"?', list, okText:'Assign'});
    if(!sub) return;
    const det = subs.find(s=>s.name===sub) || {};
    const at = det.attach || {};
    await postAssignB(part, cb, 'subtype', {subtype:sub, template:CUR.name,
      overrideParentTransform:at.overrideParentTransform||'',
      position:at.position||'0,0,0', rotation:at.rotation||'0,0,0', scale:at.scale||'1,1,1'},
      'Set "'+CUR.name+'" on subtype "'+sub+'" of '+part+'.');
  } else if(op==='base'){
    const at = (cb.baseWF||{}).attach || {};
    const ok = await openDialog({kind:'confirm', title:'Edit base plume',
      message:'Replace the base/default ModuleWaterfallFX plume (moduleID "'+(cb.wfModuleID||'?')+'") with "'+CUR.name+'"? Subtypes with no override use this.',
      okText:'Assign', cancelText:'Cancel'});
    if(ok!==true) return;
    await postAssignB(part, cb, 'base', {template:CUR.name,
      overrideParentTransform:at.overrideParentTransform||'',
      position:at.position||'0,0,0', rotation:at.rotation||'0,0,0', scale:at.scale||'1,1,1'},
      'Set "'+CUR.name+'" as the base plume of '+part+'.');
  } else { // variant
    if(!subs.length){ await dAlert('No subtypes to copy from.'); return; }
    const list = subs.map(s=>({label:'Copy '+s.name+(s.hasOverride?' (has override)':' (inherits base)'), value:s.name}));
    const copyFrom = await openDialog({kind:'list', title:'Add variant — copy which subtype?', list, okText:'Next'});
    if(!copyFrom) return;
    const name = await openDialog({kind:'text', title:'Name for the new variant', value:CUR.name, okText:'Add'});
    if(!name) return;
    const det = subs.find(s=>s.name===copyFrom) || {};
    const at = det.attach || {};
    await postAssignB(part, cb, 'variant', {name, copyFrom, template:CUR.name,
      overrideParentTransform:at.overrideParentTransform||'',
      position:at.position||'0,0,0', rotation:at.rotation||'0,0,0', scale:at.scale||'1,1,1'},
      'Added variant "'+name+'" (copy of "'+copyFrom+'") on '+part+' using "'+CUR.name+'".');
  }
}

async function postAssignB(part, cb, op, payload, okMsg){
  const res = await fetch('/api/plume/assign-b',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({part, b9ModuleID:cb.b9ModuleID, wfModuleID:cb.wfModuleID, op, payload})});
  const data = await res.json();
  if(data.error){ await dAlert('Assign failed: '+data.error); return; }
  await dAlert(okMsg+'\n\nClick "Compile / Apply to GameData" when ready. Nothing is written until you compile.', 'Assigned (Case B)');
  renderAssignments();
}

async function compileFlow(){
  const ok = await openDialog({kind:'confirm', title:'Compile / Apply to GameData',
    message:'This writes GameData/zzzz_EngineEditor/ from the manifest (templates + Case-A switchers). Takes effect next KSP launch; the indexer will confirm it landed on reindex. Proceed?',
    okText:'Compile', cancelText:'Cancel'});
  if(ok!==true) return;
  const res = await fetch('/api/plume/compile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const data = await res.json();
  if(data.ok===false || data.error){
    const errs = data.errors ? data.errors.join('\n• ') : (data.error||'unknown error');
    await dAlert('Compile refused (nothing written):\n• '+errs, 'Compile failed');
    return;
  }
  const files = (data.written||[]).join('\n• ');
  await dAlert('Compiled. Files written:\n• '+(files||'(none)')+
    '\n\nTakes effect next KSP launch; the indexer will confirm it landed on reindex.', 'Compile complete');
}

// ---- New / Clone / Rename / Delete / Save (all via custom dialogs) ----
function slugify(s){ return (s||'').trim().replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,''); }

// Waterfall model/shader palette for the blank-slate builder — fetched once.
let PALETTE = null;
async function ensurePalette(){
  if(PALETTE) return PALETTE;
  try { PALETTE = await (await fetch('/api/plume/palette')).json(); }
  catch(e){ PALETTE = {models:[], extraModels:[], shaders:[], shaderParams:{}}; }
  return PALETTE;
}

async function newPlumeFlow(){
  const source = CUR ? CUR.name : null;
  const list=[];
  list.push({label:'✧ Blank — build from scratch (empty, add your own effects)', value:{type:'blank'}});
  if(source) list.push({label:'Clone currently-selected: '+source, value:{type:'clone', name:source}});
  for(const s of STARTERS) list.push({label:'Starter — '+s.key+': '+s.templateName+(s.role?' ('+s.role+')':''), value:{type:'starter', name:s.templateName}});
  const pick = await openDialog({kind:'list', title:'New plume — choose a base', list, okText:'Next'});
  if(!pick) return;
  const suggested = pick.type==='blank' ? 'my-plume' : slugify(pick.name)+'-custom';
  const name = await openDialog({kind:'text', title:'Name for the new custom plume', value:suggested, okText:'Create'});
  if(!name) return;
  let data;
  if(pick.type==='blank'){
    data = await (await fetch('/api/plume/new-blank', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name: slugify(name)})})).json();
  } else {
    data = await (await fetch('/api/plume/clone', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({source: pick.name, newName: slugify(name)})})).json();
  }
  if(data.error){ await dAlert('Create failed: '+data.error); return; }
  await loadList();
  const t = TEMPLATES.find(t=>t.name===slugify(name) && t.source==='custom');
  if(t) select(t);
}

async function cloneCurrentToEdit(){
  if(!CUR) return;
  const suggested = slugify(CUR.name)+'-custom';
  const name = await openDialog({kind:'text', title:'Name for the editable copy', value:suggested, okText:'Clone'});
  if(!name) return;
  const res = await fetch('/api/plume/clone', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({source: CUR.name, newName: slugify(name)})});
  const data = await res.json();
  if(data.error){ await dAlert('Clone failed: '+data.error); return; }
  await loadList();
  const t = TEMPLATES.find(t=>t.name===slugify(name) && t.source==='custom');
  if(t) select(t);
}

async function renamePlume(){
  if(!CUR || CUR.source!=='custom') return;
  const name = await openDialog({kind:'text', title:'Rename plume', value:CUR.name, okText:'Rename'});
  if(!name || slugify(name)===CUR.name) return;
  const res = await fetch('/api/plume/rename', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: CUR.name, newName: slugify(name)})});
  const data = await res.json();
  if(data.error){ await dAlert('Rename failed: '+data.error); return; }
  await loadList();
  const t = TEMPLATES.find(t=>t.name===slugify(name) && t.source==='custom');
  if(t) select(t);
}

async function deletePlume(){
  if(!CUR || CUR.source!=='custom') return;
  const ok = await dConfirm('Delete custom plume "'+CUR.name+'"? This cannot be undone.', 'Delete plume');
  if(!ok) return;
  const res = await fetch('/api/plume/delete', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: CUR.name})});
  const data = await res.json();
  if(data.error){ await dAlert('Delete failed: '+data.error); return; }
  CUR = null;
  $('#plTitle').textContent='Select a template'; $('#plMod').textContent='';
  $('#plEffects').innerHTML='';
  updateEditUI();
  await loadList();
}

async function savePlume(){
  if(!CUR || CUR.source!=='custom') return;
  const res = await fetch('/api/plume/save', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: CUR.name, tree: CUR.node})});
  const data = await res.json();
  if(data.error){ await dAlert('Save failed: '+data.error); return; }
  const btn=$('#plSave'); const old=btn.textContent; btn.textContent='Saved ✓';
  setTimeout(()=>btn.textContent=old, 1200);
}

// engine's TEMPLATE overrides passed from the editor (scale/position) applied as
// extra offsets to each EFFECT's MODEL — Waterfall applies template offsets to the
// whole effect subtree; multiplying per-model scale approximates that.
function applyEngineOverrides(node){
  const sc = qs.get('scale'), po = qs.get('position');
  if(!sc && !po) return;
  const s = sc ? sc.split(',').map(parseFloat) : [1,1,1];
  const p = po ? po.split(',').map(parseFloat) : [0,0,0];
  for(const eff of (node.c||[]).filter(c=>c.h==='EFFECT')){
    for(const model of (eff.c||[]).filter(c=>c.h==='MODEL')){
      if(sc){ const cur=(kvOf(model,'scaleOffset')||'1,1,1').split(',').map(parseFloat);
        setKV(model,'scaleOffset', cur.map((v,i)=>v*(s[i]||s[0]||1)).join(',')); }
      if(po){ const cur=(kvOf(model,'positionOffset')||'0,0,0').split(',').map(parseFloat);
        setKV(model,'positionOffset', cur.map((v,i)=>v+(p[i]||0)).join(',')); }
    }
  }
}

// ---- disabled-effect soft flag ----
const isDisabled = eff => kvOf(eff,'_eeDisabled')==='true';
function setDisabled(eff, val){ if(val) setKV(eff,'_eeDisabled','true'); else removeKV(eff,'_eeDisabled'); }

function reloadRender(){
  if(!MOUNTED || !CUR) return;
  try {
    // filter out disabled effects for both live preview AND keep the flag in CUR.node for save
    const filtered = {h:CUR.node.h, k:CUR.node.k, c:(CUR.node.c||[]).filter(c=>c.h!=='EFFECT' || !isDisabled(c))};
    PlumeRenderer.loadEffects(filtered, controllers);
  } catch(e){ console.error(e); }
}

// ============================================================================
// Per-effect accordion editor
// ============================================================================
function effSummary(eff){
  const models=(eff.c||[]).filter(c=>c.h==='MODEL');
  let shader='';
  for(const m of models){ const mat=(m.c||[]).find(c=>c.h==='MATERIAL'); if(mat){ shader=kvOf(mat,'shader')||''; break; } }
  const shortShader = shader.split('/').pop();
  const parent = kvOf(eff,'parentName')||'';
  return [shortShader, parent].filter(Boolean).join(' → ');
}

// Shared-editor context for the currently-selected template (used by the PlumeEdit module,
// which is also mounted in the Engine Editor drawer — one editor implementation, two hosts).
function curCtx(){
  if(!CUR) return null;
  CUR._openIdx = CUR._openIdx || new Set();
  // memoize per selected template so buildEffects() (which mounts + sets _container) and
  // addEffectFlow() share ONE ctx object — otherwise addEffect can't find the container.
  if(!CUR._ctx){
    CUR._ctx = { tree: CUR.node, editable: CUR.source==='custom', params: PARAMS,
      openIdx: CUR._openIdx, openDialog: openDialog, onChange: reloadRender };
  }
  return CUR._ctx;
}
function buildEffects(){
  const box=$('#plEffects');
  const ctx=curCtx();
  if(!ctx){ box.innerHTML=''; return; }
  window.PlumeEdit.mount(box, ctx);
}
function _deadBuildEffects(){
  const box=$('#plEffects'); box.innerHTML='';
  if(!CUR){ return; }
  const editable = !!(CUR.source==='custom');
  const effects=(CUR.node.c||[]).filter(c=>c.h==='EFFECT');
  if(!effects.length){ box.innerHTML='<div style="padding:8px;color:var(--dim);font-size:12px;">No EFFECT nodes in this template.</div>'; return; }

  effects.forEach((eff,idx)=>{
    const row=document.createElement('div'); row.className='effRow';
    if(isDisabled(eff)) row.classList.add('disabled');
    if(CUR._openIdx.has(idx)) row.classList.add('open');

    const head=document.createElement('div'); head.className='effHead';

    const toggle=document.createElement('div'); toggle.className='effToggle'+(isDisabled(eff)?'':' on');
    toggle.title = isDisabled(eff) ? 'Disabled — click to enable' : 'Enabled — click to disable';
    // Enable/disable is a PREVIEW control — works on ANY template (mod or custom).
    // On custom templates the state persists via Save; on read-only mod templates it's
    // an ephemeral solo/mute for previewing (resets when the template is reloaded).
    toggle.addEventListener('click', e=>{
      e.stopPropagation();
      setDisabled(eff, !isDisabled(eff));
      reloadRender();
      buildEffects();
    });

    const nm=document.createElement('span'); nm.className='effName'; nm.textContent = kvOf(eff,'name') || ('effect '+idx);
    const sm=document.createElement('span'); sm.className='effSummary'; sm.textContent = effSummary(eff);

    const actions=document.createElement('div'); actions.className='effActions';
    if(editable){
      const dup=document.createElement('button'); dup.className='btn'; dup.textContent='Duplicate'; dup.title='Duplicate this effect';
      dup.addEventListener('click', e=>{ e.stopPropagation(); duplicateEffect(idx); });
      const del=document.createElement('button'); del.className='btn'; del.textContent='Delete'; del.title='Delete this effect';
      del.addEventListener('click', async e=>{ e.stopPropagation(); await deleteEffect(idx); });
      actions.appendChild(dup); actions.appendChild(del);
    }

    head.appendChild(toggle); head.appendChild(nm); head.appendChild(sm); head.appendChild(actions);
    head.addEventListener('click', ()=>{
      row.classList.toggle('open');
      if(row.classList.contains('open')) CUR._openIdx.add(idx); else CUR._openIdx.delete(idx);
    });

    const body=document.createElement('div'); body.className='effBody';
    body.appendChild(buildEffectBody(eff, editable));

    row.appendChild(head); row.appendChild(body);
    box.appendChild(row);
  });
}

function buildEffectBody(eff, editable){
  const frag=document.createDocumentFragment();
  const models=(eff.c||[]).filter(c=>c.h==='MODEL');

  models.forEach((model, mi)=>{
    if(models.length>1){ const s=document.createElement('div'); s.className='effSection'; s.textContent='Model '+(mi+1)+(kvOf(model,'path')?(' · '+kvOf(model,'path')):''); frag.appendChild(s); }

    const off=document.createElement('div'); off.className='effSection'; off.textContent='Offsets'; frag.appendChild(off);
    frag.appendChild(vec3Row(model, 'positionOffset', 'Position', '0,0,0', editable));
    frag.appendChild(vec3Row(model, 'rotationOffset', 'Rotation', '0,0,0', editable));
    frag.appendChild(vec3Row(model, 'scaleOffset', 'Scale', '1,1,1', editable));

    for(const mat of (model.c||[]).filter(c=>c.h==='MATERIAL')){
      const s=document.createElement('div'); s.className='effSection'; s.textContent='Material';
      frag.appendChild(s);

      const shaderRow=document.createElement('div'); shaderRow.className='effOffsetRow';
      const shLab=document.createElement('label'); shLab.textContent='shader'; shaderRow.appendChild(shLab);
      const shVal=document.createElement('span'); shVal.className='modList'; shVal.style.width='auto'; shVal.textContent=kvOf(mat,'shader')||'—';
      shaderRow.appendChild(shVal);
      frag.appendChild(shaderRow);

      const texs=(mat.c||[]).filter(c=>c.h==='TEXTURE');
      if(texs.length){
        const texRow=document.createElement('div'); texRow.className='effOffsetRow';
        const texLab=document.createElement('label'); texLab.textContent='texture slot(s)'; texRow.appendChild(texLab);
        const texVal=document.createElement('span'); texVal.className='modList'; texVal.style.width='auto';
        texVal.textContent = texs.map(t=>kvOf(t,'textureSlotName')).filter(Boolean).join(', ') || '—';
        texRow.appendChild(texVal);
        frag.appendChild(texRow);
      }

      for(const f of (mat.c||[]).filter(c=>c.h==='FLOAT')) frag.appendChild(floatRow(f,editable));
      for(const c of (mat.c||[]).filter(c=>c.h==='COLOR')) frag.appendChild(colorRow(c,editable));
    }
  });

  const MT={FLOATMODIFIER:'float',COLORMODIFIER:'color',SCALEMODIFIER:'scale',
            POSITIONMODIFIER:'position',ROTATIONMODIFIER:'rotation',UVOFFSETMODIFIER:'uv'};
  const mods=(eff.c||[]).filter(c=>MT[c.h]);
  if(mods.length){
    const det=document.createElement('details'); det.className='eeModDetails';
    const sum=document.createElement('summary'); sum.textContent='Modifiers ('+mods.length+')';
    det.appendChild(sum);
    for(const m of mods) det.appendChild(modBlock(m, editable));
    frag.appendChild(det);
  }

  return frag;
}

// ---- MODIFIER editing (FLOATMODIFIER / COLORMODIFIER / SCALEMODIFIER /
// POSITIONMODIFIER / ROTATIONMODIFIER / UVOFFSETMODIFIER): header fields
// (controllerName, combinationType, floatName/colorName/textureName) +
// editable curve tables. Mutates CUR.node in place, live-updates the preview
// via reloadRender(); gated by `editable` the same way material FLOAT/COLOR
// rows are (custom templates only — matches buildEffectBody's existing rule).
const MOD_LABEL={FLOATMODIFIER:'FLOAT',COLORMODIFIER:'COLOR',SCALEMODIFIER:'SCALE',
  POSITIONMODIFIER:'POSITION',ROTATIONMODIFIER:'ROTATION',UVOFFSETMODIFIER:'UVOFFSET'};
const MOD_NAME_FIELD={FLOATMODIFIER:'floatName',COLORMODIFIER:'colorName',UVOFFSETMODIFIER:'textureName'};
const MOD_CURVES={
  FLOATMODIFIER:[['floatCurve','Float curve']],
  COLORMODIFIER:[['rCurve','R'],['gCurve','G'],['bCurve','B'],['aCurve','A']],
  SCALEMODIFIER:[['xCurve','X'],['yCurve','Y'],['zCurve','Z']],
  POSITIONMODIFIER:[['xCurve','X'],['yCurve','Y'],['zCurve','Z']],
  ROTATIONMODIFIER:[['xCurve','X'],['yCurve','Y'],['zCurve','Z']],
  UVOFFSETMODIFIER:[['scrollCurveX','Scroll X'],['scrollCurveY','Scroll Y']],
};

function modBlock(mod, editable){
  const block=document.createElement('div'); block.className='eeModBlock';

  const head=document.createElement('div'); head.className='eeModBlockHead';
  const nm=document.createElement('span'); nm.className='eeModName';
  nm.textContent = kvOf(mod,'name') || MOD_LABEL[mod.h] || mod.h;
  const badge=document.createElement('span'); badge.className='eeModBadge';
  badge.textContent = MOD_LABEL[mod.h] || mod.h;
  head.appendChild(nm); head.appendChild(badge);
  const tn=kvOf(mod,'transformName');
  if(tn){ const t=document.createElement('span'); t.className='eeModTn'; t.textContent=tn; head.appendChild(t); }
  block.appendChild(head);

  const ctrlRow=document.createElement('div'); ctrlRow.className='effOffsetRow';
  const ctrlLab=document.createElement('label'); ctrlLab.textContent='controller'; ctrlRow.appendChild(ctrlLab);
  const ctrlInp=document.createElement('input'); ctrlInp.type='text'; ctrlInp.setAttribute('list','eeControllerList');
  ctrlInp.value = kvOf(mod,'controllerName')||'';
  if(!editable) ctrlInp.disabled=true;
  ctrlInp.addEventListener('input', ()=>{ setKV(mod,'controllerName',ctrlInp.value); reloadRender(); });
  ctrlRow.appendChild(ctrlInp); block.appendChild(ctrlRow);

  const combRow=document.createElement('div'); combRow.className='effOffsetRow';
  const combLab=document.createElement('label'); combLab.textContent='combination'; combRow.appendChild(combLab);
  const combSel=document.createElement('select');
  for(const o of ['REPLACE','ADD','SUBTRACT','MULTIPLY']){
    const op=document.createElement('option'); op.value=o; op.textContent=o; combSel.appendChild(op);
  }
  combSel.value = kvOf(mod,'combinationType')||'REPLACE';
  if(!editable) combSel.disabled=true;
  combSel.addEventListener('change', ()=>{ setKV(mod,'combinationType',combSel.value); reloadRender(); });
  combRow.appendChild(combSel); block.appendChild(combRow);

  const nfKey = MOD_NAME_FIELD[mod.h];
  if(nfKey){
    const row=document.createElement('div'); row.className='effOffsetRow';
    const lab=document.createElement('label'); lab.textContent=nfKey; row.appendChild(lab);
    const inp=document.createElement('input'); inp.type='text'; inp.value=kvOf(mod,nfKey)||'';
    if(!editable) inp.disabled=true;
    inp.addEventListener('input', ()=>{ setKV(mod,nfKey,inp.value); reloadRender(); });
    row.appendChild(inp); block.appendChild(row);
  }

  for(const [key,label] of (MOD_CURVES[mod.h]||[])) block.appendChild(curveTable(mod, key, label, editable));

  return block;
}

// Parse/serialize one `key = t v [inTan outTan]` line of a Waterfall curve node.
function parseCurveLine(v){
  const p=String(v).trim().split(/\s+/).map(parseFloat);
  return {t:isNaN(p[0])?0:p[0], v:isNaN(p[1])?0:p[1], inT:isNaN(p[2])?'':p[2], outT:isNaN(p[3])?'':p[3]};
}
function curveLineOf(r, hasTangents){
  return hasTangents ? (r.t+' '+r.v+' '+(r.inT===''?0:r.inT)+' '+(r.outT===''?0:r.outT)) : (r.t+' '+r.v);
}
const getCurveChild = (mod, name) => (mod.c||[]).find(c=>c.h===name);

// Editable curve table (Time / Value / in-tan / out-tan) for one curve child
// node (e.g. floatCurve, xCurve, rCurve…) of a MODIFIER node — mirrors app.js's
// ispCurveTable pattern but reads/writes the {h,k,c} tree node format used here.
function curveTable(mod, curveName, label, editable){
  const wrap=document.createElement('div'); wrap.className='eeCurveRow';
  const lab=document.createElement('label'); lab.textContent=label; wrap.appendChild(lab);

  const tblWrap=document.createElement('div'); tblWrap.className='isptable-wrap';
  let cn = getCurveChild(mod, curveName);
  let rows = cn ? (cn.k||[]).filter(([k])=>k==='key').map(([,v])=>parseCurveLine(v)) : [];
  let hasTangents = rows.some(r=>r.inT!==''||r.outT!=='');

  const table=document.createElement('table'); table.className='isptable';

  const commit=()=>{
    const lines = rows.map(r=>curveLineOf(r,hasTangents));
    if(!lines.length){
      if(cn){ const i=(mod.c||[]).indexOf(cn); if(i>=0) mod.c.splice(i,1); cn=null; }
    } else {
      if(!cn){ cn={h:curveName,k:[],c:[]}; (mod.c=mod.c||[]).push(cn); }
      cn.k = lines.map(l=>['key', l]);
    }
    reloadRender();
  };

  const buildTable=()=>{
    table.innerHTML='';
    const thead=document.createElement('tr');
    for(const h of ['Time','Value']){ const th=document.createElement('th'); th.textContent=h; thead.appendChild(th); }
    if(hasTangents){ for(const h of ['in-tan','out-tan']){ const th=document.createElement('th'); th.textContent=h; thead.appendChild(th); } }
    thead.appendChild(document.createElement('th'));
    table.appendChild(thead);
    rows.forEach((r,i)=>{
      const tr=document.createElement('tr');
      const mkCell=(field)=>{
        const td=document.createElement('td');
        const inp=document.createElement('input'); inp.type='text'; inp.value=r[field];
        if(!editable) inp.disabled=true;
        inp.addEventListener('input', ()=>{ r[field] = inp.value===''?'':(+inp.value||0); commit(); });
        td.appendChild(inp); return td;
      };
      tr.appendChild(mkCell('t')); tr.appendChild(mkCell('v'));
      if(hasTangents){ tr.appendChild(mkCell('inT')); tr.appendChild(mkCell('outT')); }
      const tdDel=document.createElement('td');
      if(editable){
        const del=document.createElement('button'); del.className='ghost isprow-del'; del.type='button'; del.textContent='×';
        del.addEventListener('click', ()=>{ rows.splice(i,1); commit(); buildTable(); });
        tdDel.appendChild(del);
      }
      tr.appendChild(tdDel);
      table.appendChild(tr);
    });
  };
  buildTable();
  tblWrap.appendChild(table);

  if(editable){
    const btnRow=document.createElement('div'); btnRow.style.cssText='display:flex;gap:6px;';
    const addBtn=document.createElement('button'); addBtn.className='ghost isprow-add'; addBtn.type='button'; addBtn.textContent='+ add row';
    addBtn.addEventListener('click', ()=>{ rows.push({t:0,v:0,inT:hasTangents?0:'',outT:hasTangents?0:''}); commit(); buildTable(); });
    btnRow.appendChild(addBtn);
    const advBtn=document.createElement('button'); advBtn.className='ghost isprow-add'; advBtn.type='button';
    advBtn.textContent = hasTangents ? 'Hide tangents' : 'Show tangents';
    advBtn.addEventListener('click', ()=>{
      hasTangents=!hasTangents;
      if(hasTangents) rows.forEach(r=>{ if(r.inT==='') r.inT=0; if(r.outT==='') r.outT=0; });
      commit(); buildTable();
      advBtn.textContent = hasTangents ? 'Hide tangents' : 'Show tangents';
    });
    btnRow.appendChild(advBtn);
    tblWrap.appendChild(btnRow);
  }

  wrap.appendChild(tblWrap);
  return wrap;
}

function vec3Row(node, key, label, def, editable){
  const row=document.createElement('div'); row.className='effOffsetRow';
  const lab=document.createElement('label'); lab.textContent=label; row.appendChild(lab);
  const parts=(kvOf(node,key)||def).split(',').map(v=>parseFloat(v)||0);
  const inputs=[];
  for(let i=0;i<3;i++){
    const inp=document.createElement('input'); inp.type='number'; inp.step='0.01'; inp.value=parts[i];
    if(!editable) inp.disabled=true;
    inp.addEventListener('input', ()=>{
      const vals=inputs.map(x=>+x.value||0);
      setKV(node,key,vals.join(','));
      reloadRender();
    });
    inputs.push(inp);
    row.appendChild(inp);
  }
  return row;
}

function floatRow(node, editable){
  const name=kvOf(node,'floatName'); const val=parseFloat(kvOf(node,'value'))||0;
  const rng=PARAMS[name]||{min:0,max:10};
  const row=document.createElement('div'); row.className='prow';
  const lab=document.createElement('label'); lab.textContent=name; row.appendChild(lab);
  const num=document.createElement('input'); num.type='number'; num.step='0.01'; num.value=val;
  const rg=document.createElement('input'); rg.type='range';
  rg.min=rng.min; rg.max=rng.max; rg.step=(rng.max-rng.min)/500||0.01; rg.value=val;
  if(!editable){ num.disabled=true; rg.disabled=true; }
  const commit=v=>{ setKV(node,'value',String(v)); num.value=v; rg.value=v; reloadRender(); };
  num.addEventListener('input',()=>commit(+num.value));
  rg.addEventListener('input',()=>commit(+rg.value));
  row.appendChild(num); row.appendChild(rg);
  return row;
}

function colorRow(node, editable){
  const name=kvOf(node,'colorName'); const parts=(kvOf(node,'colorValue')||'1,1,1,1').split(',').map(parseFloat);
  const row=document.createElement('div'); row.className='prow';
  const lab=document.createElement('label'); lab.textContent=name; row.appendChild(lab);
  const cp=document.createElement('input'); cp.type='color';
  const to255=v=>Math.max(0,Math.min(255,Math.round(v*255)));
  const hex='#'+[0,1,2].map(i=>to255(parts[i]).toString(16).padStart(2,'0')).join('');
  cp.value=hex;
  const mult=document.createElement('input'); mult.type='number'; mult.step='0.1'; mult.title='HDR multiplier';
  const lum=Math.max(parts[0],parts[1],parts[2],1); mult.value=(lum>1?lum:1).toFixed(2);
  if(!editable){ cp.disabled=true; mult.disabled=true; }
  const commit=()=>{
    const h=cp.value; const r=parseInt(h.substr(1,2),16)/255, g=parseInt(h.substr(3,2),16)/255,
          b=parseInt(h.substr(5,2),16)/255; const m=+mult.value||1;
    setKV(node,'colorValue',[r*m,g*m,b*m,parts[3]!=null?parts[3]:1].map(x=>+x.toFixed(4)).join(','));
    reloadRender();
  };
  cp.addEventListener('input',commit); mult.addEventListener('input',commit);
  row.appendChild(cp); row.appendChild(mult);
  return row;
}

// ---- add / duplicate / delete effect ----
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

async function addEffectFlow(){
  const ctx=curCtx();
  if(!ctx || !ctx.editable) return;
  await window.PlumeEdit.addEffect(ctx);
}

// Scaffold a fresh EFFECT from a Waterfall model's harvested example MODEL block, attached to the
// thrustTransform by default. Renders immediately; user then tunes material/modifiers (§8).
function addEffectFromModel(model){
  if(!CUR || CUR.source!=='custom') return;
  const modelNode = deepClone(model.example);
  const base = slugify(model.name).toLowerCase().replace(/-/g,'') || 'effect';
  const name = base + Math.floor(Math.random()*900+100);
  const eff = {h:'EFFECT', k:[['name', name], ['parentName','thrustTransform']], c:[modelNode]};
  if(!CUR.node.c) CUR.node.c=[];
  CUR.node.c.push(eff);
  reloadRender();
  buildEffects();
}

function duplicateEffect(idx){
  if(!CUR || CUR.source!=='custom') return;
  const effects=(CUR.node.c||[]).filter(c=>c.h==='EFFECT');
  const src=effects[idx]; if(!src) return;
  const copy=deepClone(src);
  setKV(copy,'name', (kvOf(src,'name')||'effect')+'_copy'+Math.floor(Math.random()*900+100));
  removeKV(copy,'_eeDisabled');
  const pos = CUR.node.c.indexOf(src);
  CUR.node.c.splice(pos+1, 0, copy);
  reloadRender();
  buildEffects();
}

async function deleteEffect(idx){
  if(!CUR || CUR.source!=='custom') return;
  const effects=(CUR.node.c||[]).filter(c=>c.h==='EFFECT');
  const eff=effects[idx]; if(!eff) return;
  const ok = await dConfirm('Delete effect "'+(kvOf(eff,'name')||'effect '+idx)+'"? This cannot be undone.', 'Delete effect');
  if(!ok) return;
  const pos = CUR.node.c.indexOf(eff);
  if(pos>=0) CUR.node.c.splice(pos,1);
  reloadRender();
  buildEffects();
}

// ---- export ----
function toggleExport(){
  const box=$('#plExportBox');
  if(box.style.display==='block'){ box.style.display='none'; return; }
  $('#plExportText').textContent = CUR ? serialize(CUR.node,0) : '';
  box.style.display='block';
}
function serialize(node, depth){
  const pad='  '.repeat(depth);
  let out=pad+node.h+'\n'+pad+'{\n';
  for(const [k,v] of node.k){ if(k==='_eeDisabled') continue; out+=pad+'  '+k+' = '+v+'\n'; }
  for(const c of (node.c||[])) out+=serialize(c,depth+1);
  out+=pad+'}\n';
  return out;
}

boot();
