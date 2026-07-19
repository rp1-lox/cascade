'use strict';
/* KSP Engine Editor — catalog + B9PS-aware editing + MM patch generation.
 * Edit model: EDITS maps a config path (slash-joined node selectors ending in a key)
 * to {orig, val, kind:'value'} or {kind:'curve', lines, origLines} for curve nodes.
 * Paths always point at the TRUE owner: a value shown because a B9PS subtype overlays
 * it is edited at its SUBTYPE .../DATA/<key> path, not at the base module.        */

let ENGINES = [], SELECTED = null, PART = null, EDITS = new Map(), SUBSEL = {};
// 3D model viewer state (persists across detail re-renders so the GL context survives).
// The viewer now lives in the always-present #viewer column (see renderViewer()), not a
// collapsible section in the scrolling config flow.
let MODEL_BOX = null, MODEL_BOX_PART = null, MODEL_SHOW_SHROUD = false;
let MODEL_GLOW = 0;
let MODEL_GRID_ON = true, MODEL_LOCK_ZOOM = false;
let MODEL_DEPLOYED = true;   // deployable-nozzle pose: default ON (firing state)
// Waterfall plume-in-viewer state
let WF_CTRL = { throttle: 1, atmo: 0, gizmo: false, show: true, allNozzles: true, eventT: 0 };
let WF_OVERLAYS = [];      // [{ov, t, baseMatrix, cb, isPrimaryGizmo}]
let WF_UPDATE_SEQ = 0;
// TEMPLATE position field's <input> DOM element, keyed by its editPath (t.editBase +
// '/position') — populated by renderWaterfall(), read by the gizmo drag (wfSetTemplatePosition)
// so a drag and the text box/steppers stay in sync through the SAME input element (one
// dispatched 'change' event drives EDITS, the changes bar, the steppers display, and the
// live overlay transform — see fieldInput()/wfVecSteppers()'s existing 'change' listeners).
let WF_POS_INPUTS = new Map();
// Active gizmo drag state, or null. Set by the ModelViewer pick handler registered in
// wfSetupGizmoDrag(); consumed by the window-level mousemove/mouseup below.
let WF_GIZMO_DRAG = null;
// Which ENGINEEVENTCONTROLLER eventNames ('ignition'/'flameout') any currently-built
// overlay actually references, so the Ignite/Flameout control-bar buttons can be
// enabled/disabled and their max eventDuration known for the scrub slider.
let WF_EVENT_INFO = { ignition: null, flameout: null };   // eventName -> {maxDuration}
// Cache of /api/model -> (lowercased transform name -> [Unity-space world matrix, ...]),
// independent of ModelViewer.getTransformMatrix() which only remembers the FIRST node
// with a given name. Waterfall (WaterfallEffect.cs) instantiates once per transform that
// matches parentName/overrideParentTransform, so multi-nozzle engines (and any part with
// more than one same-named attach transform, e.g. paired ullage/separation motors) need
// every match, not just the first.
let MODEL_TREE_CACHE = null, MODEL_TREE_PART = null;
// Mirrors the value last pushed to ModelViewer.setRescaleOverride(), so the plume
// attach-matrix computation below (a separate /api/model fetch, not routed through
// model3d.js's mount()) reflects the same live rescaleFactor edit/preview.
let RESCALE_OVERRIDE = null;

async function ensureModelTransforms() {
  if (MODEL_TREE_PART === SELECTED && MODEL_TREE_CACHE) return MODEL_TREE_CACHE;
  try {
    const data = await (await fetch('/api/model?part=' + encodeURIComponent(SELECTED))).json();
    if (RESCALE_OVERRIDE != null && isFinite(RESCALE_OVERRIDE))
      for (const m of (data.models || [])) m.rescaleFactor = RESCALE_OVERRIDE;
    MODEL_TREE_CACHE = (window.PlumeRenderer && PlumeRenderer.computeAllTransforms)
      ? PlumeRenderer.computeAllTransforms(data) : new Map();
  } catch (e) { MODEL_TREE_CACHE = new Map(); }
  MODEL_TREE_PART = SELECTED;
  return MODEL_TREE_CACHE;
}

// Push a rescaleFactor override (or null to clear) to both the mesh viewer and the
// plume attach-transform cache, then force both to rebuild from it.
function setLiveRescaleOverride(v) {
  RESCALE_OVERRIDE = (v != null && isFinite(v)) ? +v : null;
  if (window.ModelViewer && ModelViewer.setRescaleOverride) ModelViewer.setRescaleOverride(RESCALE_OVERRIDE);
  MODEL_TREE_CACHE = null; MODEL_TREE_PART = null;   // invalidate plume transform cache
}

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const modOf = e => (e.parentUrl || '').replace(/^\//, '').split('/')[0] || '(root)';
const locv = v => (PART && PART.loc && PART.loc[v]) || v;
const keyOf = (n, k) => (n.k.find(([kk]) => kk === k) || [])[1];

function isDeprecated(str) {
  if (str == null) return false;
  return String(str).toLowerCase().includes('deprecated');
}
window.isDeprecated = isDeprecated;

/* ---------------- catalog ---------------- */

async function init() {
  ENGINES = await (await fetch('/api/engines')).json();
  ENGINES.sort((a, b) => (a.title || a.part).localeCompare(b.title || b.part));
  const mods = [...new Set(ENGINES.map(modOf))].sort();
  for (const m of mods) {
    const o = el('option', null, m); o.value = m; $('#modFilter').appendChild(o);
  }
  for (const id of ['#search', '#modFilter', '#fWaterfall', '#fSwitch', '#fWarn'])
    $(id).addEventListener('input', renderList);
  $('#fShowDeprecated').addEventListener('change', () => { renderList(); refresh(); });
  $('#btnPreview').addEventListener('click', showPatch);
  $('#btnDiscard').addEventListener('click', () => {
    EDITS.clear();
    setLiveRescaleOverride(null);
    remountModelForce();
    refresh();
  });
  $('#btnClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#btnSave').addEventListener('click', savePatch);
  initSplitter();
  renderList();
}

// Draggable vertical gutter between the config column (#detail) and the 3D viewer
// column (#viewer). Resizes #viewer's width (flex-basis), clamps to sensible min
// widths for both sides, persists the chosen viewer width in localStorage, and
// re-triggers the WebGL canvas resize each frame (throttled via rAF) so the model
// viewer fills its new size live while dragging.
const VIEWER_WIDTH_KEY = 'ee.viewerWidth';
function initSplitter() {
  const splitter = $('#splitter'), viewer = $('#viewer'), app = $('#app'), sidebar = $('#sidebar');
  if (!splitter || !viewer) return;
  const MIN_VIEWER = 320, MIN_CONFIG = 360, SPLITTER_W = 7;
  const saved = parseInt(localStorage.getItem(VIEWER_WIDTH_KEY), 10);
  if (isFinite(saved) && saved > 0) viewer.style.width = saved + 'px';

  let dragging = false, rafId = 0;
  const requestCanvasResize = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (window.ModelViewer && ModelViewer.redraw) ModelViewer.redraw();
    });
  };

  splitter.addEventListener('pointerdown', e => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const appRect = app.getBoundingClientRect();
    const sidebarW = sidebar ? sidebar.getBoundingClientRect().width : 0;
    let w = appRect.right - e.clientX;
    const maxViewer = Math.max(MIN_VIEWER, appRect.width - sidebarW - MIN_CONFIG - SPLITTER_W);
    w = Math.max(MIN_VIEWER, Math.min(w, maxViewer));
    viewer.style.width = w + 'px';
    requestCanvasResize();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    const w = parseInt(viewer.style.width, 10);
    if (isFinite(w)) localStorage.setItem(VIEWER_WIDTH_KEY, String(w));
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', requestCanvasResize);
}

function renderList() {
  const q = $('#search').value.toLowerCase();
  const mod = $('#modFilter').value;
  const list = $('#partList');
  list.textContent = '';
  const showDeprecated = $('#fShowDeprecated').checked;
  for (const e of ENGINES) {
    if (!showDeprecated && (isDeprecated(e.part) || isDeprecated(e.title) || isDeprecated(e.parentUrl))) continue;
    if (mod && modOf(e) !== mod) continue;
    if ($('#fWaterfall').checked && +e.wfCount === 0) continue;
    if ($('#fSwitch').checked && +e.b9Count === 0) continue;
    if ($('#fWarn').checked && +e.warningCount === 0) continue;
    const hay = (e.title + ' ' + e.part + ' ' + modOf(e)).toLowerCase();
    if (q && !hay.includes(q)) continue;
    const li = el('li');
    li.appendChild(el('div', 'pt', e.title || e.part));
    const meta = el('div', 'pm');
    meta.appendChild(el('span', 'pn', e.part));
    li.appendChild(meta);
    const meta2 = el('div', 'pm');
    meta2.appendChild(el('span', null, modOf(e)));
    if (+e.wfCount) meta2.appendChild(el('span', 'chip wf', 'WF'));
    if (+e.b9Count) meta2.appendChild(el('span', 'chip b9', 'B9×' + e.b9Count));
    if (+e.warningCount) meta2.appendChild(el('span', 'chip warn', '⚠' + e.warningCount));
    li.appendChild(meta2);
    li.addEventListener('click', () => select(e.part, li));
    if (e.part === SELECTED) li.classList.add('sel');
    list.appendChild(li);
  }
}

async function select(name, li) {
  if (EDITS.size && name !== SELECTED &&
      !confirm('Discard unsaved edits?')) return;
  EDITS.clear(); SUBSEL = {};
  setLiveRescaleOverride(null);
  SELECTED = name;
  document.querySelectorAll('#partList li.sel').forEach(x => x.classList.remove('sel'));
  if (li) li.classList.add('sel');
  PART = await (await fetch('/api/part?name=' + encodeURIComponent(name))).json();
  refresh();
}

/* ---------------- tree helpers ---------------- */

function children(n, name) { return n.c.filter(c => c.h.split(':')[0].trim() === name); }

function nodePathSeg(node, siblings) {
  const h = node.h.split(':')[0].trim();
  const nm = keyOf(node, 'name');
  const same = siblings.filter(s => s.h.split(':')[0].trim() === h &&
                                    keyOf(s, 'name') === nm);
  let seg = nm ? `${h}[${nm}]` : h;
  if (same.length > 1) seg += ',' + same.indexOf(node);
  return seg;
}

function pathOf(node, parents) {
  // parents: array of ancestor nodes root-first (root PART excluded from path)
  let path = '', container = PART.node;
  for (const p of [...parents.slice(1), node]) {
    const seg = nodePathSeg(p, container.c);
    path = path ? path + '/' + seg : seg;
    container = p;
  }
  return path;
}

/* ---------------- B9PS effective computation ---------------- */

function b9Modules() {
  return children(PART.node, 'MODULE').filter(m => keyOf(m, 'name') === 'ModuleB9PartSwitch');
}

function moduleMatches(mod, ident) {
  // IDENTIFIER: name (class) required; extra keys must match module fields
  for (const [k, v] of ident.k) {
    const mv = keyOf(mod, k);
    if (k === 'name') { if (mv !== v) return false; }
    else if (mv !== undefined && mv !== v) return false;
  }
  return true;
}

/* For a target module, collect overlay entries from currently selected subtypes:
   returns [{key, val, editPath}] for values and [{nodeName, node, editPath}] for child nodes. */
function subtypeOverlays(targetMod, targetModParents) {
  const out = { values: [], nodes: [] };
  for (const b9 of b9Modules()) {
    const b9id = keyOf(b9, 'moduleID') || '';
    const subs = children(b9, 'SUBTYPE');
    const selIdx = SUBSEL[b9id] ?? 0;
    const st = subs[selIdx];
    if (!st) continue;
    for (const smod of children(st, 'MODULE')) {
      const ident = children(smod, 'IDENTIFIER')[0];
      const data = children(smod, 'DATA')[0];
      if (!ident || !data) continue;
      if (!moduleMatches(targetMod, ident)) continue;
      // check this is the unique match among part modules
      const matches = children(PART.node, 'MODULE').filter(m => moduleMatches(m, ident));
      if (matches.length !== 1 || matches[0] !== targetMod) continue;
      const dataPath = pathOf(data, [PART.node, b9, st, smod]);
      for (const [k, v] of data.k)
        out.values.push({ key: k, val: v, editPath: dataPath + '/' + k, from: keyOf(st, 'title') || keyOf(st, 'name') });
      for (const c of data.c)
        out.nodes.push({ nodeName: c.h.trim(), node: c, editPath: pathOf(c, [PART.node, b9, st, smod, data]), from: keyOf(st, 'title') || keyOf(st, 'name') });
    }
  }
  return out;
}

/* ---------------- rendering ---------------- */

// updatePlumes() runs after updateModelVisibility() so its hidden-ancestor filtering
// (see updatePlumes' ModelViewer.getHiddenSet() use) sees the freshly-recomputed
// visibility — needed so switching a B9PartSwitch subtype (e.g. bluedog_CentaurD_RL10's
// engineSwitch RL10-A3/B2/A4N) re-attaches the plume to the newly-active variant's
// thrustTransform instead of leaving it on the previous selection's.
function refresh() { renderDetail(PART); renderViewer(); updateChangesBar(); updateModelVisibility(); updatePlumes(); }

function renderDetail(d) {
  const root = $('#detail');
  root.textContent = '';
  if (!d) return;
  root.appendChild(el('h2', null, d.title || d.name));
  const src = el('div', 'src');
  src.textContent = d.name + '  ·  ' + d.parentUrl;
  root.appendChild(src);

  renderVariants(root);
  renderPart(root);
  renderEngines(root);
  renderWaterfall(root);
  renderWarnings(root, d);
  renderTree(root, d);
}

// The 3D viewer column: always-present, full-height (not a collapsible section in the
// scroll flow). The canvas box (MODEL_BOX) is kept in a module var and re-parented
// across refreshes so switching a B9PS dropdown (which rebuilds #detail/#viewer)
// doesn't tear down the GL context. Holds the live-view controls (throttle/atmo/heat,
// grid/lock-zoom/gizmo/all-nozzles, Ignite/Flameout, dims) alongside the canvas.
function renderViewer() {
  const root = $('#viewer');
  if (!root) return;
  root.textContent = '';
  if (!window.ModelViewer || !SELECTED || !PART) {
    root.appendChild(el('div', 'viewer-placeholder', 'Select an engine to view its 3D model'));
    return;
  }

  if (MODEL_BOX && MODEL_BOX_PART === SELECTED) {
    root.appendChild(MODEL_BOX);                 // reuse existing (already mounted) viewer
  } else {
    MODEL_BOX = el('div', 'viewer-canvasbox');
    MODEL_BOX_PART = SELECTED;
    MODEL_BOX._mounted = false;
    root.appendChild(MODEL_BOX);
    mountModel();
  }

  const controls = el('div', 'viewer-controls');
  const ctrl = el('div', 'model3d-ctrl');
  const lbl = el('label');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = MODEL_SHOW_SHROUD;
  cb.addEventListener('change', () => { MODEL_SHOW_SHROUD = cb.checked; updateModelVisibility(); });
  lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' Show shroud'));
  ctrl.appendChild(lbl);
  const glbl = el('label', 'glowlbl');
  glbl.appendChild(document.createTextNode('Heat / throttle glow '));
  const gs = el('input'); gs.type = 'range'; gs.min = 0; gs.max = 1; gs.step = 0.01; gs.value = MODEL_GLOW;
  gs.addEventListener('input', () => { MODEL_GLOW = +gs.value; pushGlow(); });
  glbl.appendChild(gs);
  ctrl.appendChild(glbl);

  const gridLbl = el('label');
  const gridCb = el('input'); gridCb.type = 'checkbox'; gridCb.checked = MODEL_GRID_ON;
  gridCb.addEventListener('change', () => {
    MODEL_GRID_ON = gridCb.checked;
    if (window.ModelViewer && ModelViewer.setGridVisible) ModelViewer.setGridVisible(MODEL_GRID_ON);
  });
  gridLbl.appendChild(gridCb); gridLbl.appendChild(document.createTextNode(' Grid'));
  ctrl.appendChild(gridLbl);

  const lockLbl = el('label');
  const lockCb = el('input'); lockCb.type = 'checkbox'; lockCb.checked = MODEL_LOCK_ZOOM;
  lockCb.addEventListener('change', () => {
    MODEL_LOCK_ZOOM = lockCb.checked;
    if (window.ModelViewer && ModelViewer.setLockZoom) ModelViewer.setLockZoom(MODEL_LOCK_ZOOM);
  });
  lockLbl.appendChild(lockCb); lockLbl.appendChild(document.createTextNode(' Lock zoom across parts'));
  ctrl.appendChild(lockLbl);

  // "Deploy nozzle" — only for parts whose .mu carries a deploy animation (extendable/
  // deployable-nozzle engines). Hidden entirely for non-deployable parts so the control
  // bar doesn't grow a no-op checkbox on every other engine.
  const deployInfo = deployAnimInfo();
  if (deployInfo) {
    const deployLbl = el('label');
    const deployCb = el('input'); deployCb.type = 'checkbox'; deployCb.checked = MODEL_DEPLOYED;
    deployCb.addEventListener('change', () => {
      MODEL_DEPLOYED = deployCb.checked;
      if (window.ModelViewer && ModelViewer.setDeployed) {
        ModelViewer.setDeployed(MODEL_DEPLOYED, deployInfo.animNames);
      }
      updatePlumes();   // re-attach plume to the (now retracted/deployed) thrustTransform
    });
    deployLbl.appendChild(deployCb); deployLbl.appendChild(document.createTextNode(' Deploy nozzle'));
    ctrl.appendChild(deployLbl);
  }
  controls.appendChild(ctrl);

  if (waterfallModules().length) controls.appendChild(wfControlBar());
  root.appendChild(controls);
}

// Force the 3D viewer to re-fetch/rebuild from scratch (used after an edit that
// changes the geometry itself — e.g. rescaleFactor — rather than just visibility/
// glow/plume state, which the normal mount()-reuse path already handles live).
function remountModelForce() {
  if (!MODEL_BOX || MODEL_BOX_PART !== SELECTED) return;
  MODEL_BOX._mounted = false;
  mountModel();
}

function renderPart(root) {
  // Part-root fields: keys on PART{} itself (not a MODULE), so editPath is just the
  // bare key name — buildPatch() emits `%key = val` directly under @PART[x]:FINAL{}.
  if (!PART) return;
  const sec = el('div', 'section');
  sec.appendChild(el('h3', null, 'Part'));
  const grid = el('div', 'fieldgrid');
  const orig = keyOf(PART.node, 'rescaleFactor');
  const eff = { val: orig != null ? orig : '1.25', editPath: 'rescaleFactor', from: null };
  const row = fieldInput('Rescale factor', eff);
  const inp = row.querySelector('input');
  inp.addEventListener('change', () => {
    const n = parseFloat(inp.value);
    // Empty EDITS entry (value === disk value) means "back to on-disk" — mirror
    // that onto the live preview by clearing the override in the same case.
    setLiveRescaleOverride(EDITS.has('rescaleFactor') && isFinite(n) ? n : null);
    remountModelForce();
    updatePlumes();
  });
  grid.appendChild(row);
  sec.appendChild(grid);
  root.appendChild(sec);
}

function mountModel() {
  const box = MODEL_BOX;
  if (!box || box._mounted) return;
  box._mounted = true;
  try {
    // NOTE: window.ModelViewer.mount() is an `async` function, so it can never throw
    // synchronously into this try/catch — any internal error is delivered as a
    // rejected Promise instead. Without a .catch() below, that rejection (and any
    // thrown by the .then() callback itself, e.g. from updateModelDims()) becomes an
    // unhandled promise rejection: invisible in the UI and never logged. This was the
    // fallback that was actually swallowing post-mount errors; both failure paths now
    // log the real exception and surface it in the panel.
    Promise.resolve(window.ModelViewer.mount(box, SELECTED))
      .then(() => {
        // per-mount viewer state (STATE.gridOn/deployed pose) resets on each mount();
        // re-push the persisted UI settings. Lock-zoom's persisted radius lives inside
        // model3d.js itself (module-level), so it doesn't need re-pushing here.
        const deployInfo = deployAnimInfo();
        if (deployInfo && window.ModelViewer && ModelViewer.setDeployed) {
          ModelViewer.setDeployed(MODEL_DEPLOYED, deployInfo.animNames);
        }
        updateModelVisibility(); pushGlow(); updatePlumes(); updateModelDims();
        if (window.ModelViewer && ModelViewer.setGridVisible) ModelViewer.setGridVisible(MODEL_GRID_ON);
      })
      .catch((e) => {
        console.error('[app] model3d mount/post-mount failed:', (e && e.message) || e, e && e.stack);
        box.textContent = 'model unavailable';
      });
  } catch (e) {
    console.error('[app] model3d mount threw synchronously:', (e && e.message) || e, e && e.stack);
    box.textContent = 'model unavailable';
  }
}

// Small overlay readout of the visible-mesh world-space bounding box, styled like
// the existing .model3d-status hint. Recomputed whenever mesh visibility changes
// (B9PS subtype switch, shroud toggle) so it always reflects what's on screen.
function updateModelDims() {
  if (!MODEL_BOX || !window.ModelViewer || !ModelViewer.getDimensions) return;
  const dims = ModelViewer.getDimensions();
  let d = MODEL_BOX.querySelector('.model3d-dims');
  if (!dims) { if (d) d.remove(); return; }
  if (!d) { d = el('div', 'model3d-dims'); MODEL_BOX.appendChild(d); }
  d.textContent = 'H ' + dims.height.toFixed(2) + ' m × Ø ' + dims.diameter.toFixed(2) + ' m';
}

/* Parse the part's ModuleColorChanger (_EmissiveColor) into curve config for the
   viewer, then push the current glow value. */
function parseKeys(node) {
  return node ? node.k.filter(([k]) => k === 'key').map(([, v]) => {
    const p = v.trim().split(/[\s,]+/).map(parseFloat);
    return { t: p[0], v: p[1], inT: isNaN(p[2]) ? 0 : p[2], outT: isNaN(p[3]) ? 0 : p[3] };
  }).sort((a, b) => a.t - b.t) : null;
}

function emissiveConfig() {
  if (!PART) return null;
  for (const m of children(PART.node, 'MODULE')) {
    if (keyOf(m, 'name') !== 'ModuleColorChanger') continue;
    if ((keyOf(m, 'shaderProperty') || '') !== '_EmissiveColor') continue;
    const list = key => m.k.filter(([k]) => k === key).map(([, v]) => v.trim().toLowerCase());
    return {
      r: parseKeys(children(m, 'redCurve')[0]),
      g: parseKeys(children(m, 'greenCurve')[0]),
      b: parseKeys(children(m, 'blueCurve')[0]),
      included: list('includedRenderer'),
      excluded: list('excludedRenderer'),
    };
  }
  return null;
}

function pushGlow() {
  if (!window.ModelViewer || MODEL_BOX_PART !== SELECTED) return;
  window.ModelViewer.setEmissiveConfig(emissiveConfig());
  window.ModelViewer.setGlow(MODEL_GLOW);
}

// Compute per-transform visibility from B9PartSwitch selections + disable/jettison
// modules and push it to the viewer. Exported so switch dropdowns can call it.
function updateModelVisibility() {
  if (!window.ModelViewer || !PART || MODEL_BOX_PART !== SELECTED) return;
  const vis = {};
  const mark = (t, on) => { t = t.trim(); if (!t) return; vis[t] = (t in vis) ? (vis[t] && on) : on; };
  const subTransforms = st => st.k.filter(([k]) => k === 'transform').map(([, v]) => v);
  for (const b9 of b9Modules()) {
    const id = keyOf(b9, 'moduleID') || '';
    const subs = children(b9, 'SUBTYPE');
    const st = subs[SUBSEL[id] ?? 0];
    const sel = new Set((st ? subTransforms(st) : []).map(s => s.trim()));
    const all = new Set();
    subs.forEach(s => subTransforms(s).forEach(t => all.add(t.trim())));
    for (const t of all) mark(t, sel.has(t));       // visible iff selected subtype lists it
  }
  for (const m of children(PART.node, 'MODULE').filter(m => keyOf(m, 'name') === 'ModuleB9DisableTransform'))
    m.k.filter(([k]) => k === 'transformName' || k === 'transform').forEach(([, v]) => { vis[v.trim()] = false; });
  const shrouds = [];
  for (const m of children(PART.node, 'MODULE').filter(m => keyOf(m, 'name') === 'ModuleJettison')) {
    const jn = keyOf(m, 'jettisonName');
    if (jn) jn.split(',').forEach(s => shrouds.push(s.trim()));
  }
  for (const s of shrouds) { if (!s) continue; if (!MODEL_SHOW_SHROUD) vis[s] = false; else if (!(s in vis)) vis[s] = true; }
  window.ModelViewer.setTransformVisibility(vis);
  updateModelDims();
}
window.updateModelVisibility = updateModelVisibility;

// Builds compact dropdown rows for B9PartSwitch modules directly into `root`
// (no own header/section wrapper — the caller supplies that). `excludeIds`,
// if given, is a Set of moduleIDs to skip (used to omit the engine-config
// switch once its subtypes are driven live by the variant tab strip — see
// buildVariantCard). Originally a standalone "Part switches" section; now
// folded into the unified "Variants & switches" section (§7.9).
function renderSwitchers(root, excludeIds) {
  const mods = b9Modules().filter(b9 => !excludeIds || !excludeIds.has(keyOf(b9, 'moduleID') || ''));
  if (!mods.length) return;
  for (const b9 of mods) {
    const b9id = keyOf(b9, 'moduleID') || '';
    const row = el('div', 'switchrow');
    row.appendChild(el('label', null, locv(keyOf(b9, 'switcherDescription') || b9id || 'Subtype')));
    const sel = el('select');
    const subs = children(b9, 'SUBTYPE');
    subs.forEach((st, i) => {
      const o = el('option', null, locv(keyOf(st, 'title') || keyOf(st, 'name') || ('#' + i)));
      o.value = i;
      sel.appendChild(o);
    });
    sel.value = SUBSEL[b9id] ?? 0;
    sel.addEventListener('change', () => { SUBSEL[b9id] = +sel.value; refresh(); });
    row.appendChild(sel);
    const st = subs[SUBSEL[b9id] ?? 0];
    if (st) {
      const bits = [];
      if (keyOf(st, 'addedMass')) bits.push('Δmass ' + keyOf(st, 'addedMass') + 't');
      if (keyOf(st, 'addedCost')) bits.push('Δcost ' + keyOf(st, 'addedCost'));
      if (keyOf(st, 'upgradeRequired')) bits.push('needs ' + keyOf(st, 'upgradeRequired'));
      if (keyOf(st, 'tankType')) bits.push('tank ' + keyOf(st, 'tankType'));
      if (bits.length) row.appendChild(el('span', 'subinfo', bits.join(' · ')));
    }
    root.appendChild(row);
  }
}

const ENGINE_FIELDS = [
  ['maxThrust', 'Max thrust (kN)'], ['minThrust', 'Min thrust (kN)'],
  ['heatProduction', 'Heat production'], ['engineAccelerationSpeed', 'Spool-up speed'],
  ['engineDecelerationSpeed', 'Spool-down speed'], ['ignitionThreshold', 'Ignition threshold'],
];

function effectiveField(mod, parents, key) {
  const ov = subtypeOverlays(mod, parents);
  const hit = ov.values.find(v => v.key === key);
  if (hit) return { val: hit.val, editPath: hit.editPath, from: hit.from };
  const base = keyOf(mod, key);
  if (base === undefined) return null;
  return { val: base, editPath: pathOf(mod, parents) + '/' + key, from: null };
}

function effectiveCurve(mod, parents, nodeName) {
  const ov = subtypeOverlays(mod, parents);
  const hit = ov.nodes.find(n => n.nodeName === nodeName);
  if (hit) return { node: hit.node, editPath: hit.editPath, from: hit.from };
  const base = children(mod, nodeName)[0];
  if (!base) return null;
  return { node: base, editPath: pathOf(base, [...parents, mod]), from: null };
}

function fieldInput(label, eff) {
  const row = el('div', 'field');
  row.appendChild(el('label', null, label));
  const inp = el('input');
  inp.type = 'text';
  const edited = EDITS.get(eff.editPath);
  inp.value = edited ? edited.val : eff.val;
  if (edited) inp.classList.add('edited');
  inp.addEventListener('change', () => {
    if (inp.value === eff.val) EDITS.delete(eff.editPath);
    else EDITS.set(eff.editPath, { kind: 'value', orig: eff.val, val: inp.value });
    inp.classList.toggle('edited', EDITS.has(eff.editPath));
    updateChangesBar();
  });
  row.appendChild(inp);
  if (eff.from) row.appendChild(el('span', 'fromsub', 'from subtype: ' + locv(eff.from)));
  return row;
}

function curveBox(label, eff) {
  const row = el('div', 'field curve');
  row.appendChild(el('label', null, label));
  const ta = el('textarea');
  const origLines = eff.node.k.filter(([k]) => k === 'key').map(([, v]) => v).join('\n');
  const edited = EDITS.get(eff.editPath);
  ta.value = edited ? edited.lines : origLines;
  ta.rows = Math.min(6, ta.value.split('\n').length + 1);
  if (edited) ta.classList.add('edited');
  ta.addEventListener('change', () => {
    if (ta.value.trim() === origLines.trim()) EDITS.delete(eff.editPath);
    else EDITS.set(eff.editPath, { kind: 'curve', nodeName: eff.node.h.trim(), origLines, lines: ta.value.trim() });
    ta.classList.toggle('edited', EDITS.has(eff.editPath));
    updateChangesBar();
  });
  row.appendChild(ta);
  if (eff.from) row.appendChild(el('span', 'fromsub', 'from subtype: ' + locv(eff.from)));
  return row;
}

function parseIspLine(l) {
  const parts = l.trim().replace(/^key\s*=\s*/, '').split(/\s+/).filter(Boolean);
  return { pressure: parts[0] ?? '', isp: parts[1] ?? '', inTan: parts[2] ?? '', outTan: parts[3] ?? '' };
}

function ispRowsToLines(rows, hasTangents) {
  return rows.map(r => {
    if (hasTangents) return `${r.pressure} ${r.isp} ${r.inTan || 0} ${r.outTan || 0}`;
    return `${r.pressure} ${r.isp}`;
  }).join('\n');
}

function ispCurveTable(label, eff) {
  const row = el('div', 'field curve');
  row.appendChild(el('label', null, label));
  const origLines = eff.node.k.filter(([k]) => k === 'key').map(([, v]) => v).join('\n');
  const edited = EDITS.get(eff.editPath);
  const sourceLines = (edited ? edited.lines : origLines).split('\n').filter(l => l.trim());
  let rows = sourceLines.map(parseIspLine);
  let hasTangents = rows.some(r => r.inTan !== '' || r.outTan !== '');

  const wrap = el('div', 'isptable-wrap');
  const table = el('table', 'isptable');
  const commit = () => {
    const newLines = ispRowsToLines(rows, hasTangents);
    if (newLines.trim() === origLines.trim()) EDITS.delete(eff.editPath);
    else EDITS.set(eff.editPath, { kind: 'curve', nodeName: eff.node.h.trim(), origLines, lines: newLines });
    table.classList.toggle('edited', EDITS.has(eff.editPath));
    updateChangesBar();
  };
  const buildTable = () => {
    table.textContent = '';
    const thead = el('tr');
    thead.appendChild(el('th', null, 'Pressure (atm)'));
    thead.appendChild(el('th', null, 'Isp (s)'));
    if (hasTangents) {
      thead.appendChild(el('th', null, 'in-tan'));
      thead.appendChild(el('th', null, 'out-tan'));
    }
    thead.appendChild(el('th', null, ''));
    table.appendChild(thead);
    rows.forEach((r, i) => {
      const tr = el('tr');
      const mkCell = (field) => {
        const td = el('td');
        const inp = el('input');
        inp.type = 'text';
        inp.value = r[field];
        inp.addEventListener('input', () => { r[field] = inp.value; commit(); });
        td.appendChild(inp);
        return td;
      };
      tr.appendChild(mkCell('pressure'));
      tr.appendChild(mkCell('isp'));
      if (hasTangents) {
        tr.appendChild(mkCell('inTan'));
        tr.appendChild(mkCell('outTan'));
      }
      const tdDel = el('td');
      const del = el('button', 'ghost isprow-del', '×');
      del.type = 'button';
      del.addEventListener('click', () => { rows.splice(i, 1); commit(); buildTable(); });
      tdDel.appendChild(del);
      tr.appendChild(tdDel);
      table.appendChild(tr);
    });
  };
  buildTable();
  wrap.appendChild(table);
  const addBtn = el('button', 'ghost isprow-add', '+ add row');
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    rows.push({ pressure: 0, isp: 0, inTan: hasTangents ? 0 : '', outTan: hasTangents ? 0 : '' });
    commit();
    buildTable();
  });
  wrap.appendChild(addBtn);
  row.appendChild(wrap);
  if (eff.from) row.appendChild(el('span', 'fromsub', 'from subtype: ' + locv(eff.from)));
  return row;
}

function renderEngines(root) {
  const engines = children(PART.node, 'MODULE')
    .filter(m => ['ModuleEngines', 'ModuleEnginesFX'].includes(keyOf(m, 'name')));
  if (!engines.length) return;
  const parents = [PART.node];
  for (const mod of engines) {
    const sec = el('div', 'section card');
    const eid = keyOf(mod, 'engineID');
    sec.appendChild(el('h3', null, 'Engine' + (eid ? ' — ' + eid : '') +
      (engines.length > 1 ? ` (${keyOf(mod, 'name')})` : '')));
    const grid = el('div', 'fieldgrid');
    for (const [key, label] of ENGINE_FIELDS) {
      const eff = effectiveField(mod, parents, key);
      if (eff) grid.appendChild(fieldInput(label, eff));
    }
    sec.appendChild(grid);
    const curve = effectiveCurve(mod, parents, 'atmosphereCurve');
    if (curve) sec.appendChild(ispCurveTable('ISP curve (pressure  isp)', curve));
    // propellants
    for (const prop of children(mod, 'PROPELLANT')) {
      const pn = keyOf(prop, 'name');
      const eff = { val: keyOf(prop, 'ratio'),
                    editPath: pathOf(prop, [...parents, mod]) + '/ratio', from: null };
      const f = fieldInput('Propellant ratio — ' + pn, eff);
      grid.appendChild(f);
    }
    root.appendChild(sec);
  }
}

// B9PartSwitch can add an entirely new PartModule via a subtype, not just overlay fields
// onto an existing one: a SUBTYPE/MODULE block with IDENTIFIER+DATA whose IDENTIFIER
// matches NO module already on the part causes B9PartSwitch to instantiate a brand-new
// module of that class from DATA (moduleID + fields + children) when that subtype is
// selected. Bluedog's UA120/AJ260 SRBs put their whole ModuleWaterfallFX this way — it
// only exists under one meshSwitchType subtype ("Inline"), never at the part root — so
// code that only scans root PART MODULEs (as this file used to) finds wfCount 0 and
// renders no plume at all, even though the part has one in-game for that subtype.
// subtypeOverlays() intentionally can't handle this case (it only overlays fields onto an
// *existing* target module); this is the complementary "module doesn't exist yet" path.
function b9SyntheticModules(className) {
  const out = [];
  for (const b9 of b9Modules()) {
    const b9id = keyOf(b9, 'moduleID') || '';
    const subs = children(b9, 'SUBTYPE');
    const st = subs[SUBSEL[b9id] ?? 0];
    if (!st) continue;
    for (const smod of children(st, 'MODULE')) {
      const ident = children(smod, 'IDENTIFIER')[0];
      const data = children(smod, 'DATA')[0];
      if (!ident || !data) continue;
      if (keyOf(ident, 'name') !== className) continue;
      const matches = children(PART.node, 'MODULE').filter(m => moduleMatches(m, ident));
      if (matches.length) continue;   // overlays an existing module — handled elsewhere
      // Synthesize the added module: name/moduleID etc. from IDENTIFIER, fields/children
      // from DATA. Keep `data` (and its .c array) as the node so edit paths computed via
      // pathOf() land on the real SUBTYPE/.../MODULE/DATA/<key> location, matching this
      // file's edit-path convention (see header comment at the top of the file).
      const node = { h: 'DATA', k: [...ident.k, ...data.k], c: data.c };
      out.push({ wf: node, parents: [PART.node, b9, st, smod] });
    }
  }
  return out;
}

// All effective ModuleWaterfallFX modules for the current part/subtype selection: real
// root-level modules plus any B9PS-synthesized ones (see b9SyntheticModules above).
function waterfallModules() {
  const base = children(PART.node, 'MODULE')
    .filter(m => keyOf(m, 'name') === 'ModuleWaterfallFX')
    .map(wf => ({ wf, parents: [PART.node] }));
  return [...base, ...b9SyntheticModules('ModuleWaterfallFX')];
}

// Detects "deploy" animations for the current part (extendable/deployable nozzles:
// see docs/notes on ModuleDeployableEngine discarding the .mu ANIMATION that moves
// the nozzle mesh out to meet the fixed thrustTransform). Returns { animNames } (a
// deduped, non-empty array) or null when the part has nothing to deploy.
//
// A part can carry MULTIPLE ModuleDeployableEngine modules — e.g. a B9PartSwitch
// engineSwitch whose subtypes include several distinct extendable-nozzle variants,
// each with its own EngineAnimationName/animated mesh. Only ONE variant's nozzle is
// visible at a time (B9PS subtype visibility hides the rest), so applying every
// captured clip's deployed pose is safe: the hidden variants' poses are simply never
// seen, and the visible one always ends up correctly posed regardless of which
// subtype is currently selected.
//
// Matching heuristic (deliberately conservative — see model3d.js applyDeployPose()
// for why over-applying an unrelated clip is dangerous):
//   1. ModuleDeployableEngine.EngineAnimationName — the canonical, unambiguous source;
//      almost every deployable engine (stock-style or Waterfall) declares this.
//      Collected from EVERY ModuleDeployableEngine on the part, not just the first.
//   2. ModuleAnimateGeneric.animationName, but ONLY when its name reads as a nozzle/
//      deploy/extend animation (e.g. "extend", "deploy" — heat-glow, gimbal-cover, and
//      shroud-jettison ModuleAnimateGenerics are common on engines and must NOT match).
function deployAnimInfo() {
  if (!PART) return null;
  const mods = children(PART.node, 'MODULE');
  const names = [];
  for (const dep of mods.filter(m => keyOf(m, 'name') === 'ModuleDeployableEngine')) {
    const name = keyOf(dep, 'EngineAnimationName');
    if (name && name.trim()) names.push(name.trim());
  }
  for (const anim of mods.filter(m => keyOf(m, 'name') === 'ModuleAnimateGeneric' &&
      /deploy|extend|nozzle/i.test(keyOf(m, 'animationName') || ''))) {
    const name = keyOf(anim, 'animationName');
    if (name && name.trim()) names.push(name.trim());
  }
  const uniq = [...new Set(names)];
  return uniq.length ? { animNames: uniq } : null;
}

/* ---------------- Waterfall plume: fork-on-edit ("Customize this plume") ----------------
 * docs/PlumeEditorDesign.md §3, §5e/§5f. Forks the currently-effective template for this
 * module + the current SUBSEL subtype into a new EngineEditor-owned custom template, wires
 * an engine assignment (Case A: fresh B9PS switcher variant; Case B: edits the existing
 * plume-switching B9PS in place — never adds a parallel switcher, that's a fatal B9PS
 * aspect-lock error per the design doc), then opens the full editor on the fork. Status is
 * reported via a plain in-page element — no window.alert/confirm/prompt (see memory). */

function slugifyPlumeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function uniquePlumeName(base) {
  const list = await (await fetch('/api/plume/list')).json();
  const taken = new Set(list.map(t => t.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
}

function wfForkStatus(sec, msg, isError) {
  let box = sec.querySelector('.forkstatus');
  if (!box) {
    box = el('div', 'forkstatus');
    sec.appendChild(box);
  }
  box.classList.toggle('err', !!isError);
  box.textContent = msg;
}

async function customizePlume(sec, wf, t, sourceTemplate) {
  wfForkStatus(sec, 'Forking ' + sourceTemplate + ' …', false);
  try {
    const info = await (await fetch('/api/plume/engine-info?part=' + encodeURIComponent(PART.name))).json();
    if (info.error) throw new Error(info.error);
    if (info.case === 'none') throw new Error('this part has no Waterfall plume to customize');

    const newName = await uniquePlumeName(slugifyPlumeName(sourceTemplate + '-' + PART.name));
    let r = await (await fetch('/api/plume/clone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: sourceTemplate, newName }),
    })).json();
    if (r.error) throw new Error(r.error);

    const attach = {
      overrideParentTransform: wfCurVal(t, 'overrideParentTransform', ''),
      position: wfCurVal(t, 'position', '0,0,0'),
      rotation: wfCurVal(t, 'rotation', '0,0,0'),
      scale: wfCurVal(t, 'scale', '1,1,1'),
    };

    let note = '';
    if (info.case === 'A') {
      const wfModuleID = keyOf(wf, 'moduleID') || (info.wfModules[0] && info.wfModules[0].moduleID) || '';
      r = await (await fetch('/api/plume/assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ part: PART.name, wfModuleID,
          variant: Object.assign({ name: 'Custom', template: newName }, attach) }),
      })).json();
      if (r.error) throw new Error(r.error);
      note = ' (Case A: new "Custom" plume variant)';
    } else if (info.case === 'B') {
      const cb = info.caseB || {};
      const b9id = cb.b9ModuleID || '';
      let subName = null, hasOverride = false;
      const b9 = b9Modules().find(m => (keyOf(m, 'moduleID') || '') === b9id);
      if (b9) {
        const subs = children(b9, 'SUBTYPE');
        const st = subs[SUBSEL[b9id] ?? 0];
        if (st) subName = keyOf(st, 'name') || null;
      }
      if (subName) {
        const detail = (cb.subtypes || []).find(s => s.name === subName);
        hasOverride = !!(detail && detail.hasOverride);
      }
      let op, payload;
      if (subName && hasOverride) {
        op = 'subtype';
        payload = Object.assign({ subtype: subName, template: newName }, attach);
        note = ' (Case B: retextured subtype "' + subName + '")';
      } else {
        // Ambiguous (no override on the current subtype, so it currently falls through to
        // the base plume) or subtype unknown — default to editing the shared base plume, and
        // say so explicitly rather than silently guessing per-subtype.
        op = 'base';
        payload = Object.assign({ template: newName }, attach);
        note = subName
          ? ' (Case B: subtype "' + subName + '" has no override — edited the shared base plume instead; other non-overriding subtypes are affected too)'
          : ' (Case B: edited the shared base plume)';
      }
      r = await (await fetch('/api/plume/assign-b', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ part: PART.name, b9ModuleID: b9id, wfModuleID: cb.wfModuleID || '', op, payload }),
      })).json();
      if (r.error) throw new Error(r.error);
    } else {
      throw new Error('unexpected case ' + info.case);
    }

    wfForkStatus(sec, 'Forked ' + sourceTemplate + ' → ' + newName + ', assigned to this engine' +
      note + '. Opening editor… Remember to Compile in the Manager to apply.', false);
    window.open('plumelib.html?template=' + encodeURIComponent(newName), '_blank');
  } catch (ex) {
    wfForkStatus(sec, 'Customize failed: ' + (ex.message || ex), true);
  }
}

/* ---------------- Waterfall plume: viewer integration ---------------- */

// effective TEMPLATE + inline EFFECT list for one ModuleWaterfallFX. ModuleWaterfallFX.LoadEffects
// (Waterfall source) reads BOTH direct EFFECT children and TEMPLATE children of the module —
// a module can carry inline EFFECTs alongside/instead of TEMPLATEs — so both must render.
// B9PS subtype overlay replaces each node type wholesale, independently: an overlay that only
// carries TEMPLATE nodes replaces the base TEMPLATEs but leaves base inline EFFECTs (if any)
// alone, and vice versa (matches B9PS's per-node-type REPLACE semantics).
function wfEffectiveTemplates(wf, parents) {
  const ov = subtypeOverlays(wf, parents);
  const ovTemplates = ov.nodes.filter(n => n.nodeName === 'TEMPLATE');
  const ovEffects = ov.nodes.filter(n => n.nodeName === 'EFFECT');
  const templates = ovTemplates.length
    ? ovTemplates.map(o => ({ kind: 'template', node: o.node, editBase: o.editPath, from: o.from }))
    : children(wf, 'TEMPLATE').map(t => ({ kind: 'template', node: t, editBase: pathOf(t, [...parents, wf]), from: null }));
  const effects = ovEffects.length
    ? ovEffects.map(o => ({ kind: 'effect', node: o.node, editBase: o.editPath, from: o.from }))
    : children(wf, 'EFFECT').map(t => ({ kind: 'effect', node: t, editBase: pathOf(t, [...parents, wf]), from: null }));
  return [...templates, ...effects];
}

// Per-part throttle-controller smoothing rate (CONTROLLER{linkedTo=throttle}), e.g. the
// SSME patches responseRateUp=0.03/responseRateDown=0.2 (Source/Waterfall/EffectControllers/
// ThrottleController.cs UpdateSingleValue's MoveTowards model) — a deliberately slow ~33s
// spool-up look that a naive instant-throttle preview would miss entirely. Returns null if
// the part doesn't override it (plume.js overlay defaults to Waterfall's own 100/100).
function wfThrottleResponseRate(wf) {
  for (const c of wf.c || []) {
    if (c.h === 'CONTROLLER' && (keyOf(c, 'linkedTo') || '').toLowerCase() === 'throttle') {
      const up = parseFloat(keyOf(c, 'responseRateUp'));
      const down = parseFloat(keyOf(c, 'responseRateDown'));
      return { up: isNaN(up) ? 100 : up, down: isNaN(down) ? 100 : down };
    }
  }
  return null;
}

function wfCurVal(t, key, def) {
  const e = EDITS.get(t.editBase + '/' + key);
  if (e) return e.val;
  const v = keyOf(t.node, key);
  return v !== undefined ? v : def;
}
function parse3(s, def) {
  const a = String(s).split(',').map(parseFloat);
  return a.length >= 3 && a.every(n => !isNaN(n)) ? a.slice(0, 3) : def.slice();
}
function mat4MulTranslate(m, t) {
  const o = m.slice();
  o[12] = m[0]*t[0] + m[4]*t[1] + m[8]*t[2] + m[12];
  o[13] = m[1]*t[0] + m[5]*t[1] + m[9]*t[2] + m[13];
  o[14] = m[2]*t[0] + m[6]*t[1] + m[10]*t[2] + m[14];
  return o;
}

// summed positionOffset of the selected subtypes' TRANSFORM nodes matching `name`
function subtypeTransformOffset(name) {
  const ln = (name || '').toLowerCase();
  let off = null;
  for (const b9 of b9Modules()) {
    const subs = children(b9, 'SUBTYPE');
    const st = subs[SUBSEL[keyOf(b9, 'moduleID') || ''] ?? 0];
    if (!st) continue;
    for (const tr of children(st, 'TRANSFORM')) {
      if ((keyOf(tr, 'name') || '').trim().toLowerCase() !== ln) continue;
      const p = (keyOf(tr, 'positionOffset') || '').split(',').map(parseFloat);
      if (p.length >= 3 && p.every(n => !isNaN(n)))
        off = off ? [off[0]+p[0], off[1]+p[1], off[2]+p[2]] : p;
    }
  }
  return off;
}

function applyPlumeTransform(rec) {
  const t = rec.t;
  // Inline EFFECT nodes attach via their own `parentName` and get NO template offset —
  // WaterfallEffect only applies TemplatePositionOffset/Rotation/Scale when constructed
  // from a WaterfallEffectTemplate (see WaterfallEffect.cs ctor: templateOwner!=null ?
  // parentTemplate.position : Vector3.zero, etc.); a bare EFFECT always gets zero/one.
  const attachName = t.kind === 'effect'
    ? (keyOf(t.node, 'parentName') || 'thrustTransform')
    : (keyOf(t.node, 'overrideParentTransform') || 'thrustTransform');
  // rec.baseMatrix is the SPECIFIC transform occurrence this overlay instance was built
  // for (see updatePlumes' multi-nozzle instancing below); fall back to the model
  // viewer's single-match lookup only when no per-instance matrix was captured.
  let m = rec.baseMatrix
       || (window.ModelViewer.getTransformMatrix && ModelViewer.getTransformMatrix(attachName))
       || (window.ModelViewer.getTransformMatrix && ModelViewer.getTransformMatrix('thrustTransform'));
  if (!m) m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const off = subtypeTransformOffset(attachName);       // B9PS subtype TRANSFORM move
  if (off) m = mat4MulTranslate(m, off);
  rec.ov.setAttach(m);
  rec.ov.setOffsets(t.kind === 'effect'
    ? { pos: [0, 0, 0], rot: [0, 0, 0], sca: [1, 1, 1] }
    : {
        pos: parse3(wfCurVal(t, 'position', '0,0,0'), [0, 0, 0]),
        rot: parse3(wfCurVal(t, 'rotation', '0,0,0'), [0, 0, 0]),
        sca: parse3(wfCurVal(t, 'scale', '1,1,1'), [1, 1, 1]),
      });
}

function updatePlumeOffsets() {
  if (!window.ModelViewer) return;
  for (const r of WF_OVERLAYS) applyPlumeTransform(r);
  if (ModelViewer.redraw) ModelViewer.redraw();
}

function wfCtlChanged() {
  for (const r of WF_OVERLAYS)
    r.ov.setControllers({ throttle: WF_CTRL.throttle, atmosphereDepth: WF_CTRL.atmo });
  if (window.ModelViewer && ModelViewer.redraw) ModelViewer.redraw();
}

// (re)build plume overlays inside the model viewer for the selected part
async function updatePlumes() {
  if (!window.ModelViewer || !window.PlumeRenderer || !PlumeRenderer.createOverlay) return;
  if (VARIANT_PREVIEW && VARIANT_PREVIEW.part !== SELECTED) VARIANT_PREVIEW = null;  // stale on engine switch
  const seq = ++WF_UPDATE_SEQ;
  for (const r of WF_OVERLAYS) { try { ModelViewer.removeOverlay(r.cb); r.ov.dispose(); } catch (e) {} }
  WF_OVERLAYS = [];
  const gl = ModelViewer.getGL && ModelViewer.getGL();
  if (!gl || !PART || !WF_CTRL.show || MODEL_BOX_PART !== SELECTED) {
    if (window.ModelViewer && ModelViewer.redraw) ModelViewer.redraw();
    return;
  }
  const transformsByName = await ensureModelTransforms();
  if (seq !== WF_UPDATE_SEQ) return;                       // superseded by a newer update
  WF_EVENT_INFO = { ignition: null, flameout: null };
  for (const { wf, parents } of waterfallModules()) {
    // ENGINE EVENT CONTROLLER: CONTROLLER{linkedTo=engineEvent}/ENGINEEVENTCONTROLLER
    // nodes live directly on the ModuleWaterfallFX module (not inside a TEMPLATE), per
    // docs/WaterfallTemplatePatterns.md sec.5 (Avalanche's one-shot ignition/flameout
    // pattern) and Source/Waterfall/EffectControllers/EngineEventController.cs. Parse
    // once per module and feed every overlay built from it so effects whose modifiers
    // reference that controller name animate off the simulated Ignite/Flameout clock
    // instead of defaulting to a static (and possibly dark) 0.
    const eventDefs = window.PlumeRenderer.parseEventControllers ? PlumeRenderer.parseEventControllers(wf) : {};
    const throttleRate = wfThrottleResponseRate(wf);
    for (const n in eventDefs) {
      const d = eventDefs[n];
      if (d.eventName === 'ignition' || d.eventName === 'flameout')
        WF_EVENT_INFO[d.eventName] = { maxDuration: Math.max((WF_EVENT_INFO[d.eventName] || { maxDuration: 0 }).maxDuration, d.eventDuration) };
    }
    // §9: when previewing an EE-added variant's own plume, render THAT template on the matching
    // ModuleWaterfallFX instead of the live per-subtype plume. Otherwise resolve normally.
    const wfId = keyOf(wf, 'moduleID') || '';
    let effTemplates;
    if (VARIANT_PREVIEW && VARIANT_PREVIEW.part === SELECTED && VARIANT_PREVIEW.template &&
        (wfId === VARIANT_PREVIEW.wfModuleID || !VARIANT_PREVIEW.wfModuleID)) {
      const at = VARIANT_PREVIEW.attach;
      effTemplates = [{ kind: 'template', from: 'variant', editBase: '__variantpreview__',
        node: { h: 'TEMPLATE', k: [
          ['templateName', VARIANT_PREVIEW.template],
          ['overrideParentTransform', at.overrideParentTransform || ''],
          ['position', at.position || '0,0,0'], ['rotation', at.rotation || '0,0,0'],
          ['scale', at.scale || '1,1,1'],
        ], c: [] } }];
    } else {
      effTemplates = wfEffectiveTemplates(wf, parents);
    }
    for (const t of effTemplates) {
      let data = null;
      if (t.kind === 'effect') {
        // inline EFFECT node: no server round-trip needed, the compiled node IS the effect.
        if (isDeprecated(keyOf(t.node, 'name'))) continue;
        data = { node: t.node };
      } else {
        const tn = keyOf(t.node, 'templateName');
        if (!tn || isDeprecated(tn)) continue;
        try { data = await (await fetch('/api/template?name=' + encodeURIComponent(tn))).json(); } catch (e) {}
        if (seq !== WF_UPDATE_SEQ) return;                 // superseded by a newer update
        if (!data || data.error) {
          // custom (EngineEditor-owned) templates aren't in /api/template — fall back to the
          // unified get endpoint so forked/blank custom plumes preview too.
          try { data = await (await fetch('/api/plume/get?name=' + encodeURIComponent(tn))).json(); } catch (e) {}
          if (seq !== WF_UPDATE_SEQ) return;
        }
        if (!data || data.error) continue;
      }
      // MULTI-NOZZLE: Waterfall (WaterfallEffect.cs) instantiates one effect instance per
      // transform matching parentName/overrideParentTransform — not just the first. Collect
      // every matching transform's world matrix (case-insensitive exact name) and build one
      // overlay per match, so e.g. a 4-nozzle RD-170 cluster shows 4 plumes. The "All
      // nozzles" toggle (default on) can restrict this back to first-match-only.
      const attachName = t.kind === 'effect'
        ? (keyOf(t.node, 'parentName') || 'thrustTransform')
        : (keyOf(t.node, 'overrideParentTransform') || 'thrustTransform');
      let matches = transformsByName.get((attachName || '').toLowerCase()) || [];
      // Drop matches whose ancestor path runs through a node hidden by the current
      // B9PartSwitch subtype selection (see setTransformVisibility/getHiddenSet in
      // model3d.js). Transforms sharing a leaf name — e.g. bluedog_CentaurD_RL10's
      // three `thrustTransform`s, one per RL10 variant hierarchy — are distinguished
      // ONLY by which ancestor (RL10B2parent/RL10A4Nparent/Centaur_RL10/RL10) is
      // currently visible, so this is what keeps only the active variant's nozzle lit.
      const hiddenSet = window.ModelViewer.getHiddenSet && ModelViewer.getHiddenSet();
      if (hiddenSet && hiddenSet.size)
        matches = matches.filter(mt => !(mt.path && mt.path.some(n => hiddenSet.has(n))));
      let mats = matches.map(mt => mt.m);
      if (!mats.length) {
        const single = window.ModelViewer.getTransformMatrix && ModelViewer.getTransformMatrix(attachName);
        mats = single ? [single] : [null];
      }
      const instances = WF_CTRL.allNozzles ? mats : mats.slice(0, 1);
      instances.forEach((baseMatrix, idx) => {
        let ov;
        try { ov = PlumeRenderer.createOverlay(gl); } catch (e) { console.error('plume overlay:', e); return; }
        ov.loadEffects(data.node);
        ov.setControllers({ throttle: WF_CTRL.throttle, atmosphereDepth: WF_CTRL.atmo });
        if (ov.setEventControllers) ov.setEventControllers(eventDefs);
        if (throttleRate && ov.setThrottleResponseRate) ov.setThrottleResponseRate(throttleRate.up, throttleRate.down);
        ov.onTexLoaded(() => { if (ModelViewer.redraw) ModelViewer.redraw(); });
        // Multi-nozzle: only the first instance of a template draws (and is draggable
        // via) the gizmo — one handle per template, not one per nozzle.
        const isPrimaryGizmo = idx === 0;
        const rec = { ov, t, baseMatrix, cb: null, isPrimaryGizmo };
        applyPlumeTransform(rec);
        rec.cb = (glc, cam) => { ov.draw(cam); if (WF_CTRL.gizmo && isPrimaryGizmo) ov.drawGizmo(cam, 0.8); };
        ModelViewer.addOverlay(rec.cb);
        WF_OVERLAYS.push(rec);
      });
    }
  }
  if (ModelViewer.redraw) ModelViewer.redraw();
  window.WF_OVERLAYS_DEBUG = WF_OVERLAYS;
  refreshWfEventButtons();
}
window.updatePlumes = updatePlumes;

// Fire (or re-scrub) a simulated engine event ('ignition'|'flameout') across every
// currently-built plume overlay and start a rAF loop repainting the viewer while any
// event clock is still running, so the Ignite/Flameout buttons visibly animate the
// curve over eventDuration (Source/Waterfall/EffectControllers/EngineEventController.cs's
// eventTime ramp) instead of only updating on the next unrelated redraw.
let WF_EVENT_ANIM = 0;
function wfFireEvent(eventName) {
  for (const r of WF_OVERLAYS) if (r.ov.fireEvent) r.ov.fireEvent(eventName);
  const info = WF_EVENT_INFO[eventName];
  const dur = info ? info.maxDuration : 1;
  const start = performance.now();
  if (WF_EVENT_ANIM) cancelAnimationFrame(WF_EVENT_ANIM);
  const step = () => {
    if (window.ModelViewer && ModelViewer.redraw) ModelViewer.redraw();
    if ((performance.now() - start) / 1000 < dur + 0.25) WF_EVENT_ANIM = requestAnimationFrame(step);
    else WF_EVENT_ANIM = 0;
  };
  step();
}
function wfScrubEvent(eventName, t) {
  for (const r of WF_OVERLAYS) if (r.ov.scrubEvent) r.ov.scrubEvent(eventName, t);
  if (window.ModelViewer && ModelViewer.redraw) ModelViewer.redraw();
}
// enable/disable + relabel the Ignite/Flameout buttons based on what the currently
// selected part's templates actually reference (most main engines reference neither —
// see docs/WaterfallTemplatePatterns.md sec.5 — only one-shot solids/Avalanche parts do).
function refreshWfEventButtons() {
  const bar = document.querySelector('.wfctlbar');
  if (!bar) return;
  for (const name of ['ignition', 'flameout']) {
    const btn = bar.querySelector('[data-wf-event="' + name + '"]');
    if (btn) btn.disabled = !WF_EVENT_INFO[name];
  }
}

// Waterfall-editor-style control bar (throttle/atmo + plume/gizmo toggles)
function wfControlBar() {
  const bar = el('div', 'wfctlbar');
  const slider = (label, val, oninput) => {
    const l = el('label');
    l.appendChild(document.createTextNode(label + ' '));
    const s = el('input'); s.type = 'range'; s.min = 0; s.max = 1; s.step = 0.01; s.value = val;
    const v = el('span', 'wfctlval', (+val).toFixed(2));
    s.addEventListener('input', () => { v.textContent = (+s.value).toFixed(2); oninput(+s.value); });
    l.appendChild(s); l.appendChild(v);
    return l;
  };
  bar.appendChild(slider('Throttle', WF_CTRL.throttle, v => { WF_CTRL.throttle = v; wfCtlChanged(); }));
  bar.appendChild(slider('Atmosphere', WF_CTRL.atmo, v => { WF_CTRL.atmo = v; wfCtlChanged(); }));
  const check = (label, val, onchange) => {
    const l = el('label');
    const c = el('input'); c.type = 'checkbox'; c.checked = val;
    c.addEventListener('change', () => onchange(c.checked));
    l.appendChild(c); l.appendChild(document.createTextNode(' ' + label));
    return l;
  };
  bar.appendChild(check('Plume in 3D view', WF_CTRL.show, v => { WF_CTRL.show = v; updatePlumes(); }));
  bar.appendChild(check('All nozzles', WF_CTRL.allNozzles, v => { WF_CTRL.allNozzles = v; updatePlumes(); }));
  bar.appendChild(check('Axis gizmo', WF_CTRL.gizmo, v => { WF_CTRL.gizmo = v; if (window.ModelViewer && ModelViewer.redraw) ModelViewer.redraw(); }));

  // ENGINE EVENT CONTROLLER: one-shot Ignite/Flameout buttons that start a simulated
  // event clock (see wfFireEvent) plus a manual scrub slider, for the
  // ENGINEEVENTCONTROLLER/CONTROLLER{linkedTo=engineEvent} pattern (separation/retro/
  // ullage motors, SRB burnout smoke — docs/WaterfallTemplatePatterns.md sec.5). Disabled
  // when the selected part references neither (most main sustainer/booster engines don't
  // — they fake ignition via the throttle curve instead, see the Throttle slider above).
  const evtWrap = el('div', 'wfevtbar');
  const mkEvtBtn = (name, label) => {
    const b = el('button', 'wfevtbtn', label);
    b.type = 'button';
    b.dataset.wfEvent = name;
    b.disabled = !WF_EVENT_INFO[name];
    b.addEventListener('click', () => wfFireEvent(name));
    return b;
  };
  evtWrap.appendChild(mkEvtBtn('ignition', 'Ignite'));
  evtWrap.appendChild(mkEvtBtn('flameout', 'Flameout'));
  const scrubLbl = el('label');
  scrubLbl.appendChild(document.createTextNode('Event t (s) '));
  const scrub = el('input'); scrub.type = 'range'; scrub.min = 0; scrub.max = 60; scrub.step = 0.1; scrub.value = WF_CTRL.eventT;
  const scrubVal = el('span', 'wfctlval', (+WF_CTRL.eventT).toFixed(1));
  scrub.addEventListener('input', () => {
    WF_CTRL.eventT = +scrub.value; scrubVal.textContent = WF_CTRL.eventT.toFixed(1);
    // scrub applies to whichever event has a definition; harmless no-op for the other.
    wfScrubEvent('ignition', WF_CTRL.eventT); wfScrubEvent('flameout', WF_CTRL.eventT);
  });
  scrubLbl.appendChild(scrub); scrubLbl.appendChild(scrubVal);
  evtWrap.appendChild(scrubLbl);
  bar.appendChild(evtWrap);
  return bar;
}

// X/Y/Z nudge steppers + drag-to-scrub, synced bidirectionally with the text input
function wfVecSteppers(key, textInp, step) {
  const wrap = el('div', 'wfsteppers');
  const def = key === 'scale' ? [1, 1, 1] : [0, 0, 0];
  const nums = [];
  const cur = parse3(textInp.value, def);
  const push = () => {
    textInp.value = nums.map(n => +(+n.value).toFixed(4)).join(',');
    textInp.dispatchEvent(new Event('change'));     // routes through EDITS
    updatePlumeOffsets();
  };
  ['X', 'Y', 'Z'].forEach((ax, i) => {
    const lbl = el('span', 'axlbl', ax);
    lbl.title = 'drag to scrub';
    const n = el('input'); n.type = 'number'; n.step = step; n.value = cur[i];
    lbl.addEventListener('pointerdown', e => {
      e.preventDefault(); lbl.setPointerCapture(e.pointerId);
      let lx = e.clientX;
      const mv = ev => { const d = ev.clientX - lx; lx = ev.clientX;
        n.value = (+n.value + d * step).toFixed(4); push(); };
      const up = ev => { lbl.releasePointerCapture(e.pointerId);
        lbl.removeEventListener('pointermove', mv); lbl.removeEventListener('pointerup', up); };
      lbl.addEventListener('pointermove', mv); lbl.addEventListener('pointerup', up);
    });
    n.addEventListener('input', push);
    nums.push(n); wrap.appendChild(lbl); wrap.appendChild(n);
  });
  if (key === 'scale') {                              // uniform scale nudgers
    const mk = (txt, f) => { const b = el('button', 'ghost wfuni', txt); b.type = 'button';
      b.addEventListener('click', () => { nums.forEach(n => n.value = (+n.value * f).toFixed(4)); push(); });
      return b; };
    wrap.appendChild(mk('U−', 1 / 1.05));
    wrap.appendChild(mk('U+', 1.05));
  }
  textInp.addEventListener('change', () => {          // text edit -> steppers
    const v = parse3(textInp.value, def);
    nums.forEach((n, i) => n.value = v[i]);
  });
  return wrap;
}

// Write a new x/y/z to a TEMPLATE's position input — the ONE place that moves the
// value, so the text box, the X/Y/Z steppers, the changes bar and the live overlay
// transform all stay in sync no matter which of the three input methods (typing,
// stepper drag, gizmo drag) triggered it: dispatching 'change' on the actual <input>
// re-runs fieldInput()'s EDITS/changes-bar listener, wfVecSteppers()'s text->stepper
// sync listener, AND the row's own updatePlumeOffsets listener (see renderWaterfall).
function wfSetTemplatePosition(editBase, xyz) {
  const inp = WF_POS_INPUTS.get(editBase);
  if (!inp) return false;
  inp.value = xyz.map(n => +(+n).toFixed(4)).join(',');
  inp.dispatchEvent(new Event('change'));
  return true;
}

// Wire the model viewer's gizmo drag: registered once (setPickHandler persists across
// mount()s). On LMB mousedown, if the "Axis gizmo" toggle is on, hit-test every
// primary-instance overlay's gizmo handles; if one is hit, capture drag-start state and
// return true so model3d.js's camera skips orbiting for this pointer sequence. The drag
// itself is driven by our own window mousemove/mouseup (camera won't touch cam.* since
// orbiting never got set), reusing the SAME view/proj/eye captured at drag-start — the
// camera can't move mid-drag since it isn't orbiting/panning/zooming during a LMB-only drag.
function wfSetupGizmoDrag() {
  if (!window.ModelViewer || !ModelViewer.setPickHandler) return;
  ModelViewer.setPickHandler((ev, ctx) => {
    if (!WF_CTRL.gizmo) return false;
    for (const rec of WF_OVERLAYS) {
      if (!rec.isPrimaryGizmo || rec.t.kind !== 'template') continue;
      if (!WF_POS_INPUTS.has(rec.t.editBase)) continue;   // position not editable here
      const hit = rec.ov.gizmoPickAxis(ctx.ndcX, ctx.ndcY, ctx.view, ctx.proj, ctx.canvasW, ctx.canvasH, 0.8);
      if (!hit) continue;
      const startT = rec.ov.gizmoAxisParam(hit.axisDirWorld, hit.originWorld, ctx.view, ctx.proj, ctx.eye, ctx.ndcX, ctx.ndcY);
      const startPos = parse3(wfCurVal(rec.t, 'position', '0,0,0'), [0, 0, 0]);
      WF_GIZMO_DRAG = {
        rec, axisDirWorld: hit.axisDirWorld, originWorld: hit.originWorld,
        view: ctx.view, proj: ctx.proj, eye: ctx.eye, startT, startPos,
        canvasEl: ev.target,
      };
      document.body.classList.add('wf-gizmo-dragging');
      return true;
    }
    return false;
  });
  window.addEventListener('mousemove', e => {
    const d = WF_GIZMO_DRAG;
    if (!d) return;
    const rect = d.canvasEl.getBoundingClientRect();
    const ndcX = ((e.clientX-rect.left)/rect.width)*2-1;
    const ndcY = -(((e.clientY-rect.top)/rect.height)*2-1);
    const curT = d.rec.ov.gizmoAxisParam(d.axisDirWorld, d.originWorld, d.view, d.proj, d.eye, ndcX, ndcY);
    const deltaT = curT - d.startT;
    const worldDelta = [d.axisDirWorld[0]*deltaT, d.axisDirWorld[1]*deltaT, d.axisDirWorld[2]*deltaT];
    const localDelta = d.rec.ov.gizmoWorldToLocalDelta(worldDelta);
    const newPos = [d.startPos[0]+localDelta[0], d.startPos[1]+localDelta[1], d.startPos[2]+localDelta[2]];
    wfSetTemplatePosition(d.rec.t.editBase, newPos);
  });
  window.addEventListener('mouseup', () => {
    if (WF_GIZMO_DRAG) { WF_GIZMO_DRAG = null; document.body.classList.remove('wf-gizmo-dragging'); }
  });
}
wfSetupGizmoDrag();

function renderWaterfall(root) {
  WF_POS_INPUTS = new Map();     // rebuilt fresh each render; stale entries would point at detached inputs
  const wfEntries = waterfallModules();
  if (!wfEntries.length) {
    // No ModuleWaterfallFX anywhere in the compiled part — neither at the part root nor
    // synthesized by the currently-selected B9PS subtypes (see waterfallModules() /
    // b9SyntheticModules()). If the part still has an engine, it's using legacy/RealPlume-
    // style effects (ModuleEnginesFX's own EFFECTS{} + KSPParticleEmitter,
    // FXModuleThrottleEffects, etc.) instead of Waterfall — say so explicitly rather than
    // silently showing nothing, which reads identically to "this editor is broken" as it
    // does to "this part has no plume".
    const hasEngine = children(PART.node, 'MODULE')
      .some(m => ['ModuleEngines', 'ModuleEnginesFX'].includes(keyOf(m, 'name')));
    if (hasEngine) {
      const sec = el('div', 'section card wfcard');
      sec.appendChild(el('h3', null, 'Waterfall plume'));
      sec.appendChild(el('div', 'wfnote',
        'No Waterfall plume configured (legacy/RealPlume effects) — this engine uses ' +
        'stock-style EFFECTS/KSPParticleEmitter fx instead of ModuleWaterfallFX, so ' +
        'there is nothing for this editor’s plume viewer to render.'));
      root.appendChild(sec);
    }
    return;
  }
  for (const { wf, parents } of wfEntries) {
    const sec = el('div', 'section card wfcard');
    const isSynthetic = wf.h === 'DATA';         // added by a B9PS subtype, not a root MODULE
    sec.appendChild(el('h3', null, 'Waterfall plume — ' + (keyOf(wf, 'moduleID') || '')));
    if (isSynthetic) {
      const st = parents[2];
      sec.appendChild(el('div', 'wfnote',
        'This module only exists when B9PartSwitch subtype "' +
        locv(keyOf(st, 'title') || keyOf(st, 'name') || '?') +
        '" is selected — it is added by that subtype, not present on the base part.'));
    }
    const templates = wfEffectiveTemplates(wf, parents);
    const showDeprecated = $('#fShowDeprecated').checked;
    for (const t of templates) {
      const isEffect = t.kind === 'effect';
      const tn = isEffect ? null : keyOf(t.node, 'templateName');
      const label0 = isEffect ? (keyOf(t.node, 'name') || '(inline effect)') : tn;
      if (!showDeprecated && (isDeprecated(label0) || isDeprecated(t.editBase) || isDeprecated(t.from))) continue;
      const box = el('div', 'template');
      const head = el('div', 'tplhead');
      head.appendChild(el('span', 'tplname', label0 || '(inline)'));
      if (isEffect) head.appendChild(el('span', 'chip wf', 'inline EFFECT'));
      if (t.from) head.appendChild(el('span', 'fromsub', 'from subtype: ' + locv(t.from)));
      box.appendChild(head);
      const grid = el('div', 'fieldgrid');
      if (isEffect) {
        // Inline EFFECT nodes attach via their own parentName and get no template-level
        // position/rotation/scale offset in Waterfall — show parentName only (editable in
        // place), not the TEMPLATE-only offset fields (they'd have no effect in-game).
        const v = keyOf(t.node, 'parentName');
        if (v !== undefined)
          grid.appendChild(fieldInput('Attach to transform (parentName)',
            { val: v, editPath: t.editBase + '/parentName', from: null }));
      } else {
        for (const [key, label] of [['templateName', 'Template'], ['overrideParentTransform', 'Attach to transform'],
                                    ['position', 'Position offset'], ['rotation', 'Rotation'], ['scale', 'Scale']]) {
          const v = keyOf(t.node, key);
          if (v === undefined && key !== 'position' && key !== 'rotation' && key !== 'scale') continue;
          const row = fieldInput(label, { val: v ?? (key === 'scale' ? '1,1,1' : '0,0,0'),
                                          editPath: t.editBase + '/' + key, from: null });
          grid.appendChild(row);
          if (['position', 'rotation', 'scale'].includes(key)) {
            const inp = row.querySelector('input');
            inp.addEventListener('change', updatePlumeOffsets);
            if (key === 'position') WF_POS_INPUTS.set(t.editBase, inp);   // gizmo drag target
            grid.appendChild(wfVecSteppers(key, inp, key === 'rotation' ? 1 : 0.05));
          }
        }
      }
      box.appendChild(grid);
      if (tn) {
        const btn = el('button', 'ghost', 'Preview plume ↗');
        btn.style.marginTop = '6px';
        btn.addEventListener('click', () => {
          const p = new URLSearchParams({ template: tn });
          const sc = wfCurVal(t, 'scale', ''); if (sc) p.set('scale', sc);
          const po = wfCurVal(t, 'position', ''); if (po) p.set('position', po);
          window.open('plumelib.html?' + p.toString(), '_blank');
        });
        box.appendChild(btn);

        const custBtn = el('button', 'ghost', 'Customize this plume →');
        custBtn.style.marginTop = '6px';
        custBtn.style.marginLeft = '6px';
        custBtn.addEventListener('click', () => customizePlume(sec, wf, t, tn));
        box.appendChild(custBtn);
      }
      sec.appendChild(box);
    }
    root.appendChild(sec);
  }
  updatePlumes();       // rebuild overlays for the (possibly new) effective templates
}

/* ---------------- Engine-config variants (docs/PlumeEditorDesign.md §7) ----------------
 * Demo-style tab strip + inline editor form for adding whole new engine-config subtypes
 * (thrust/ISP/heat/fuel + optional plume) via a B9PartSwitch, mirroring the existing
 * "customize plume" fork flow. Custom in-page UI only — no window.alert/confirm/prompt. */

let VARIANT_INFO = null, VARIANT_INFO_PART = null, VARIANT_LIST = null;
let VARIANT_UI = null;   // { mode:'view'|'add', editingName:null|string } — which tab is open
// When previewing an EE-added variant's plume in the viewer (§9): the variant lives in the
// manifest, not the live PART config, so updatePlumes() renders THIS instead of the live
// per-subtype plume. Null = show the live config's plume for the selected subtype.
let VARIANT_PREVIEW = null;   // { part, wfModuleID, template, attach:{overrideParentTransform,position,rotation,scale} }

// Select an EE-added variant for preview: drive the MODEL to its copy-from subtype (so the
// right meshes show) and, if the variant has its OWN plume, preview that plume; otherwise it
// inherits copy-from's plume, which the live renderer already shows for that subtype.
function previewVariant(info, v) {
  const realB9 = info.engineB9
    ? b9Modules().find(m => (keyOf(m, 'moduleID') || '') === info.engineB9.moduleID) : null;
  if (realB9 && v.copyFrom) {
    const idx = children(realB9, 'SUBTYPE').findIndex(st => (keyOf(st, 'name') || '') === v.copyFrom);
    if (idx >= 0) SUBSEL[info.engineB9.moduleID] = idx;
  }
  const p = v.plume;
  VARIANT_PREVIEW = (p && p.template) ? {
    part: info.part, wfModuleID: info.wfModuleID || '',
    template: p.template,
    attach: {
      overrideParentTransform: p.overrideParentTransform || '',
      position: p.position || '0,0,0', rotation: p.rotation || '0,0,0', scale: p.scale || '1,1,1',
    },
  } : null;
  refresh();
}

async function fetchVariantInfo(part) {
  if (VARIANT_INFO_PART === part && VARIANT_INFO) return VARIANT_INFO;
  try {
    VARIANT_INFO = await (await fetch('/api/variant/info?part=' + encodeURIComponent(part))).json();
  } catch (e) { VARIANT_INFO = { error: String(e) }; }
  VARIANT_INFO_PART = part;
  return VARIANT_INFO;
}

async function fetchVariantList() {
  try { VARIANT_LIST = await (await fetch('/api/variant/list')).json(); }
  catch (e) { VARIANT_LIST = {}; }
  return VARIANT_LIST;
}

// All plume template names (custom first, then mod), fetched once for the variant plume picker.
let ALL_TEMPLATE_NAMES = null;
async function ensureTemplateNames() {
  if (ALL_TEMPLATE_NAMES) return ALL_TEMPLATE_NAMES;
  try {
    const rows = await (await fetch('/api/plume/list')).json();
    const custom = rows.filter(r => r.source === 'custom').map(r => r.name).sort();
    const mod = rows.filter(r => r.source !== 'custom').map(r => r.name).sort();
    ALL_TEMPLATE_NAMES = [...custom, ...mod];
  } catch (e) { ALL_TEMPLATE_NAMES = []; }
  return ALL_TEMPLATE_NAMES;
}

// Manifest-stored added variants (from GET /api/variant/list) use the nested
// {fields:{maxThrust,...}} shape from §7.2, unlike info.subtypes' flat resolved-stats
// shape. Normalize to the flat shape buildVariantForm()/prefill expects.
function flattenAddedVariant(v) {
  const f = v.fields || {};
  return {
    name: v.name, title: v.title || '', copyFrom: v.copyFrom || null,
    maxThrust: f.maxThrust ?? '', minThrust: f.minThrust ?? '', heatProduction: f.heatProduction ?? '',
    ispCurve: f.ispCurve || [], propellants: v.propellants || [],
    addedMass: v.addedMass || '', addedCost: v.addedCost || '',
    transforms: Array.isArray(v.transforms) ? v.transforms : null,
    plume: v.plume || null,
  };
}

function variantStatus(box, msg, isError) {
  let s = box.querySelector('.forkstatus');
  if (!s) { s = el('div', 'forkstatus'); box.appendChild(s); }
  s.classList.toggle('err', !!isError);
  s.textContent = msg;
}

function renderVariants(root) {
  if (!PART) return;
  const sec = el('div', 'section');
  const h3 = el('h3', null, 'Variants & switches ');
  h3.appendChild(el('span', 'pill', 'EngineEditor Config'));
  sec.appendChild(h3);
  const card = el('div', 'card pe');
  sec.appendChild(card);
  root.appendChild(sec);

  const loading = el('div', 'wfnote', 'Loading engine-config info…');
  card.appendChild(loading);

  const part = PART.name;
  Promise.all([fetchVariantInfo(part), fetchVariantList()]).then(([info, list]) => {
    if (part !== SELECTED) return;   // superseded by another selection
    card.textContent = '';
    if (info.error) { card.appendChild(el('div', 'forkstatus err', info.error)); return; }
    if (!info.targetModule) {
      card.appendChild(el('div', 'wfnote', 'This part has no ModuleEngines/ModuleEnginesFX to add variants for.'));
      // Still surface any B9PartSwitch switches (e.g. tank type) even when there's
      // no engine module to build engine-config variants for (§7.9).
      renderSwitchers(card, null);
      return;
    }
    buildVariantCard(card, info, (list && list[part] && list[part].subtypes) || []);
  });
}

function buildVariantCard(card, info, added) {
  if (!VARIANT_UI || VARIANT_UI.part !== info.part) VARIANT_UI = { part: info.part, mode: 'view', editingName: null };

  // Case-B-style banner
  if (info.engineB9Count > 1) {
    card.appendChild(el('div', 'caseB',
      'This engine has ' + info.engineB9Count + ' ambiguous engine-config B9PartSwitch modules that ' +
      'override its engine module — saving a variant will be refused until this is resolved.'));
  } else if (info.engineB9) {
    card.appendChild(el('div', 'caseB',
      'This engine already switches configs via B9PartSwitch "' + info.engineB9.moduleID + '" (' +
      (info.engineB9.switcherDescription || '') + '). A new variant is added to its existing switch.'));
  } else {
    card.appendChild(el('div', 'caseB',
      'This engine has no engine-config switch yet — saving a new variant will mint a new ' +
      'B9PartSwitch (moduleID "eeEngineSwitch") with a "Stock" default plus your new variant.'));
  }

  const petabs = el('div', 'petabs');
  card.appendChild(petabs);

  // The other (non-engine-config) B9PS switches for this part render as compact
  // dropdown rows in this same section — reusing renderSwitchers' row markup —
  // right below the tab strip (§7.9). Skip the engine-config B9PS moduleID: its
  // subtypes are now driven live by the tab strip below instead of a dropdown.
  const switchesWrap = el('div', 'variantswitches');
  const excludeIds = info.engineB9 ? new Set([info.engineB9.moduleID]) : null;
  renderSwitchers(switchesWrap, excludeIds);
  if (switchesWrap.children.length) card.appendChild(switchesWrap);

  const formHost = el('div', 'variantform-host');
  card.appendChild(formHost);

  // The real (shipped) engine-config subtypes are now the LIVE selector: clicking
  // one sets SUBSEL[engineB9.moduleID] to its index in the real B9PS module and
  // calls refresh(), which rebuilds #detail (including this card) from scratch —
  // so the active-tab highlight below is derived from SUBSEL at render time
  // rather than toggled by the click handler (a post-click DOM toggle would be
  // wiped out by refresh()'s rebuild anyway).
  const realB9 = info.engineB9
    ? b9Modules().find(m => (keyOf(m, 'moduleID') || '') === info.engineB9.moduleID)
    : null;
  const realB9Subs = realB9 ? children(realB9, 'SUBTYPE') : [];
  const curSubIdx = realB9 ? (SUBSEL[info.engineB9.moduleID] ?? 0) : -1;

  const realSubs = info.subtypes.filter(s => !s.isBase);
  for (const s of realSubs) {
    const t = el('div', 'petab def', s.title || s.name);
    if (realB9) {
      const idx = realB9Subs.findIndex(st => (keyOf(st, 'name') || '') === s.name);
      if (idx >= 0) {
        t.classList.add('live');
        if (idx === curSubIdx) t.classList.add('on');
        t.addEventListener('click', () => {
          VARIANT_PREVIEW = null;            // real subtype: show its live plume
          SUBSEL[info.engineB9.moduleID] = idx;
          refresh();
        });
      }
    }
    petabs.appendChild(t);
  }
  for (const v of added) {
    const t = el('div', 'petab on', v.name);
    t.title = 'EngineEditor-added variant';
    t.appendChild(el('span', 'forkbadge', 'EE'));
    const x = el('span', 'petab-x', ' ×');
    x.addEventListener('click', ev => {
      ev.stopPropagation();
      removeVariant(card, info.part, v.name);
    });
    t.appendChild(x);
    t.addEventListener('click', () => {
      VARIANT_UI = { part: info.part, mode: 'add', editingName: v.name };
      previewVariant(info, flattenAddedVariant(v));   // preview this variant's plume + model, then refresh() reopens the form
    });
    petabs.appendChild(t);
  }
  const addTab = el('div', 'petab add', '+ New variant');
  addTab.addEventListener('click', () => {
    VARIANT_PREVIEW = null;
    VARIANT_UI = { part: info.part, mode: 'add', editingName: null };
    buildVariantForm(formHost, info, null);
    petabs.querySelectorAll('.petab').forEach(p => p.classList.remove('on'));
    addTab.classList.add('on');
  });
  petabs.appendChild(addTab);

  if (VARIANT_UI.mode === 'add') {
    const rawPreset = VARIANT_UI.editingName ? added.find(v => v.name === VARIANT_UI.editingName) : null;
    const preset = rawPreset ? flattenAddedVariant(rawPreset) : null;
    buildVariantForm(formHost, info, preset);
    petabs.querySelectorAll('.petab').forEach(p => {
      if (VARIANT_UI.editingName && p.textContent.trim().startsWith(VARIANT_UI.editingName)) p.classList.add('on');
    });
    if (!VARIANT_UI.editingName) addTab.classList.add('on');
  }
}

async function removeVariant(card, part, name) {
  try {
    const r = await (await fetch('/api/variant/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part, name }),
    })).json();
    if (r.error) throw new Error(r.error);
    if (VARIANT_UI && VARIANT_UI.editingName === name) VARIANT_UI.mode = 'view';
    VARIANT_LIST = null;
    renderDetail(PART);
  } catch (ex) {
    variantStatus(card, 'Remove failed: ' + (ex.message || ex), true);
  }
}

function propRow(tbody, prop) {
  const tr = el('tr');
  const mk = (val, cls) => { const td = el('td'); const inp = el('input'); inp.type = 'text';
    inp.className = cls || ''; inp.value = val; td.appendChild(inp); tr.appendChild(td); return inp; };
  const nameInp = mk(prop.name || '');
  const ratioInp = mk(prop.ratio || '');
  const tdCk = el('td');
  const ck = el('input'); ck.type = 'checkbox'; ck.checked = String(prop.DrawGauge || '').toLowerCase() === 'true';
  tdCk.appendChild(ck); tr.appendChild(tdCk);
  const tdDel = el('td');
  const del = el('button', 'ghost isprow-del', '×'); del.type = 'button';
  del.addEventListener('click', () => tr.remove());
  tdDel.appendChild(del); tr.appendChild(tdDel);
  tbody.appendChild(tr);
  return { tr, nameInp, ratioInp, ck };
}

function buildVariantForm(host, info, preset) {
  host.textContent = '';
  const wrap = el('div', 'variantform');

  const namerow = el('div', 'namerow');
  namerow.appendChild(el('span', null, 'Copy from'));
  const copySel = el('select');
  for (const s of info.subtypes) {
    const o = el('option', null, s.isBase ? '(stock) base' : (s.title || s.name));
    o.value = s.name;
    copySel.appendChild(o);
  }
  if (preset && preset.copyFrom) copySel.value = preset.copyFrom;
  namerow.appendChild(copySel);
  wrap.appendChild(namerow);

  const grid = el('div', 'fieldgrid');
  const mkF = (label, value, ro) => {
    const f = el('div', 'f');
    f.appendChild(el('label', null, label));
    const inp = el('input', 'inp'); inp.type = 'text'; inp.value = value == null ? '' : value;
    if (ro) inp.readOnly = true;
    f.appendChild(inp);
    grid.appendChild(f);
    return inp;
  };
  const nameInp = mkF('Name (unique)', preset ? preset.name : '');
  const titleInp = mkF('Title (optional)', preset ? preset.title : '');
  const thrustInp = mkF('Max thrust (kN)', preset ? preset.maxThrust : '');
  const minThrustInp = mkF('Min thrust (kN)', preset ? preset.minThrust : '');
  const heatInp = mkF('Heat production', preset ? preset.heatProduction : '');
  const massInp = mkF('Added mass (t)', preset ? preset.addedMass : '');
  const costInp = mkF('Added cost', preset ? preset.addedCost : '');
  wrap.appendChild(grid);

  // ISP curve — reuse the ispCurveTable widget by faking an {node, editPath} pair
  // that lives entirely in local rows/EDITS-free state (no part-tree path involved).
  let ispRows = (preset ? preset.ispCurve : (info.subtypes[0] || {}).ispCurve || [])
    .map(([p, v]) => ({ pressure: p, isp: v, inTan: '', outTan: '' }));
  const ispWrap = el('div', 'field curve');
  ispWrap.appendChild(el('label', null, 'ISP curve (pressure  isp)'));
  const ispTableWrap = el('div', 'isptable-wrap');
  const ispTable = el('table', 'isptable');
  const buildIsp = () => {
    ispTable.textContent = '';
    const thead = el('tr');
    thead.appendChild(el('th', null, 'Pressure (atm)'));
    thead.appendChild(el('th', null, 'Isp (s)'));
    thead.appendChild(el('th', null, ''));
    ispTable.appendChild(thead);
    ispRows.forEach((r, i) => {
      const tr = el('tr');
      const mkCell = field => { const td = el('td'); const inp = el('input'); inp.type = 'text';
        inp.value = r[field]; inp.addEventListener('input', () => { r[field] = inp.value; }); td.appendChild(inp); return td; };
      tr.appendChild(mkCell('pressure')); tr.appendChild(mkCell('isp'));
      const tdDel = el('td'); const del = el('button', 'ghost isprow-del', '×'); del.type = 'button';
      del.addEventListener('click', () => { ispRows.splice(i, 1); buildIsp(); });
      tdDel.appendChild(del); tr.appendChild(tdDel);
      ispTable.appendChild(tr);
    });
  };
  buildIsp();
  ispTableWrap.appendChild(ispTable);
  const ispAdd = el('button', 'ghost isprow-add', '+ add row'); ispAdd.type = 'button';
  ispAdd.addEventListener('click', () => { ispRows.push({ pressure: 0, isp: 0 }); buildIsp(); });
  ispTableWrap.appendChild(ispAdd);
  ispWrap.appendChild(ispTableWrap);
  wrap.appendChild(ispWrap);

  // Propellants
  const propField = el('div', 'field curve');
  propField.appendChild(el('label', null, 'Propellants'));
  const propWrap = el('div', 'isptable-wrap');
  const propTable = el('table', 'isptable');
  const propThead = el('tr');
  propThead.appendChild(el('th', null, 'Name'));
  propThead.appendChild(el('th', null, 'Ratio'));
  propThead.appendChild(el('th', null, 'DrawGauge'));
  propThead.appendChild(el('th', null, ''));
  propTable.appendChild(propThead);
  const propBody = propTable;
  const propRows = [];
  const initialProps = preset ? (preset.propellants || []) : ((info.subtypes[0] || {}).propellants || []);
  for (const p of initialProps) propRows.push(propRow(propBody, p));
  propWrap.appendChild(propTable);
  const propAdd = el('button', 'ghost isprow-add', '+ add propellant'); propAdd.type = 'button';
  propAdd.addEventListener('click', () => propRows.push(propRow(propBody, { name: '', ratio: '', DrawGauge: '' })));
  propWrap.appendChild(propAdd);
  propField.appendChild(propWrap);
  wrap.appendChild(propField);

  // Model elements (§7.8/§7.9) — one checkbox per transformPool entry, prefilled
  // from the currently-selected copy-from subtype's own `transforms` list.
  // Hidden entirely when the part has no switchable transform pool.
  const transformPool = info.transformPool || [];
  let meChecks = [];
  if (transformPool.length) {
    const meField = el('div', 'field curve');
    meField.appendChild(el('label', null, 'Model elements'));
    const meWrap = el('div', 'checklist');
    meChecks = transformPool.map(name => {
      const lbl = el('label', 'checkitem');
      const cb = el('input'); cb.type = 'checkbox'; cb.value = name;
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + name));
      meWrap.appendChild(lbl);
      return { name, cb };
    });
    meField.appendChild(meWrap);
    wrap.appendChild(meField);
  }
  const prefillTransforms = subName => {
    if (!meChecks.length) return;
    const sub = info.subtypes.find(s => s.name === subName);
    const active = new Set((sub && sub.transforms) || []);
    meChecks.forEach(({ name, cb }) => { cb.checked = active.has(name); });
  };
  prefillTransforms(copySel.value);
  copySel.addEventListener('change', () => prefillTransforms(copySel.value));

  // Copy-from change -> prefill fields from that subtype's resolved stats
  copySel.addEventListener('change', () => {
    const sub = info.subtypes.find(s => s.name === copySel.value);
    if (!sub) return;
    thrustInp.value = sub.maxThrust ?? '';
    minThrustInp.value = sub.minThrust ?? '';
    heatInp.value = sub.heatProduction ?? '';
    massInp.value = '';
    costInp.value = '';
    ispRows = (sub.ispCurve || []).map(([p, v]) => ({ pressure: p, isp: v }));
    buildIsp();
    propTable.querySelectorAll('tr:not(:first-child)').forEach(tr => tr.remove());
    propRows.length = 0;
    for (const p of (sub.propellants || [])) propRows.push(propRow(propBody, p));
  });

  // Plume (optional) — pick a template for THIS variant, or leave blank to inherit copy-from's plume.
  const plumeField = el('div', 'field');
  plumeField.appendChild(el('label', null, 'Plume (optional)'));
  let plumeTplInp = null, plumeOptInp = null, plumePosInp = null, plumeRotInp = null, plumeScaleInp = null;
  if (info.wfModuleID) {
    const inheritNote = el('div', 'wfnote', '');
    plumeField.appendChild(inheritNote);
    // shared datalist of all template names (custom first, then mod)
    const dlId = 'eeVariantTplList';
    let dl = document.getElementById(dlId);
    if (!dl) { dl = el('datalist'); dl.id = dlId; document.body.appendChild(dl); }
    ensureTemplateNames().then(names => {
      if (!dl.children.length) for (const n of names) { const o = el('option'); o.value = n; dl.appendChild(o); }
    });
    const trow = el('div', 'f');
    trow.appendChild(el('label', null, 'Plume template (blank = inherit)'));
    plumeTplInp = el('input', 'inp'); plumeTplInp.type = 'text'; plumeTplInp.setAttribute('list', dlId);
    plumeTplInp.placeholder = '(inherit copy-from plume)';
    trow.appendChild(plumeTplInp);
    plumeField.appendChild(trow);
    // Make a brand-new custom plume for this variant: fork the inherited (or typed) template into a
    // fresh editable custom template, assign it here, and open the Library to tweak it.
    const mkCustomBtn = el('button', 'ok', '＋ New custom plume');
    mkCustomBtn.type = 'button';
    mkCustomBtn.title = 'Fork the inherited plume into a new editable custom template and assign it to this variant';
    mkCustomBtn.addEventListener('click', async () => {
      const selSub = info.subtypes.find(s => s.name === copySel.value) || info.subtypes[0] || {};
      const source = plumeTplInp.value.trim() || (selSub.plume && selSub.plume.template) ||
        (info.basePlume && info.basePlume.template) || '';
      if (!source) { inheritNote.textContent = 'No source plume to fork from.'; return; }
      mkCustomBtn.disabled = true;
      try {
        const newName = await uniquePlumeName(slugifyPlumeName(source + '-' + (nameInp.value.trim() || info.part)));
        const r = await (await fetch('/api/plume/clone', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, newName }),
        })).json();
        if (r.error) throw new Error(r.error);
        ALL_TEMPLATE_NAMES = null;                       // invalidate the datalist cache
        plumeTplInp.value = newName;                      // assign the new custom plume to this variant
        const dl2 = document.getElementById(dlId);
        if (dl2) { const o = el('option'); o.value = newName; dl2.insertBefore(o, dl2.firstChild); }
        inheritNote.textContent = 'Created custom plume "' + newName + '" (forked from ' + source +
          '), assigned to this variant. Save the variant, then Compile. Opening the Library to edit it…';
        window.open('plumelib.html?template=' + encodeURIComponent(newName), '_blank');
      } catch (ex) {
        inheritNote.textContent = 'Create custom plume failed: ' + (ex.message || ex);
      } finally { mkCustomBtn.disabled = false; }
    });
    plumeField.appendChild(mkCustomBtn);
    const ag = el('div', 'fieldgrid');
    const mkA = (lbl, v) => { const f = el('div', 'f'); f.appendChild(el('label', null, lbl));
      const i = el('input', 'inp'); i.type = 'text'; i.value = v; f.appendChild(i); ag.appendChild(f); return i; };
    plumeOptInp = mkA('overrideParentTransform', '');
    plumePosInp = mkA('position (x,y,z)', '0,0,0');
    plumeRotInp = mkA('rotation (x,y,z)', '0,0,0');
    plumeScaleInp = mkA('scale (x,y,z)', '1,1,1');
    plumeField.appendChild(ag);
    const plumeBtn = el('button', 'ghost', 'Fine-tune / make custom in Library →');
    plumeBtn.type = 'button';
    plumeBtn.addEventListener('click', () => window.open('plumelib.html', '_blank'));
    plumeField.appendChild(plumeBtn);
    // prefill inherited-plume note + attach offsets from the copy-from subtype's current plume
    const prefillPlume = () => {
      const sub = info.subtypes.find(s => s.name === copySel.value) || info.subtypes[0] || {};
      const sp = sub.plume || info.basePlume || {};
      inheritNote.textContent = 'Inherits ' + (copySel.value === '(stock)' ? 'stock' : copySel.value) +
        ' plume: ' + (sp.template || '(none)') + '. Leave blank to keep it, or pick another below.';
      plumeOptInp.value = sp.overrideParentTransform || '';
      plumePosInp.value = sp.position || '0,0,0';
      plumeRotInp.value = sp.rotation || '0,0,0';
      plumeScaleInp.value = sp.scale || '1,1,1';
    };
    prefillPlume();
    copySel.addEventListener('change', prefillPlume);
    if (preset && preset.plume) {
      plumeTplInp.value = preset.plume.template || '';
      plumeOptInp.value = preset.plume.overrideParentTransform || '';
      plumePosInp.value = preset.plume.position || '0,0,0';
      plumeRotInp.value = preset.plume.rotation || '0,0,0';
      plumeScaleInp.value = preset.plume.scale || '1,1,1';
    }
  } else {
    plumeField.appendChild(el('div', 'wfnote', 'This part has no Waterfall plume module — plume options disabled.'));
  }
  wrap.appendChild(plumeField);

  const tools = el('div', 'petools');
  const saveBtn = el('button', 'ok', preset ? 'Save changes' : 'Save variant');
  saveBtn.type = 'button';
  tools.appendChild(saveBtn);
  wrap.appendChild(tools);

  saveBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim();
    if (!name) { variantStatus(wrap, 'Name is required.', true); return; }
    if (info.engineB9Count > 1) { variantStatus(wrap, 'Refused: ambiguous engine-config B9PartSwitch (see banner above).', true); return; }
    const fields = {};
    if (thrustInp.value.trim() !== '') fields.maxThrust = thrustInp.value.trim();
    if (minThrustInp.value.trim() !== '') fields.minThrust = minThrustInp.value.trim();
    if (heatInp.value.trim() !== '') fields.heatProduction = heatInp.value.trim();
    const curve = ispRows.filter(r => String(r.pressure).trim() !== '' || String(r.isp).trim() !== '')
      .map(r => [String(r.pressure).trim(), String(r.isp).trim()]);
    if (curve.length) fields.ispCurve = curve;

    const propellants = propRows.map(r => ({
      name: r.nameInp.value.trim(), ratio: r.ratioInp.value.trim(),
      DrawGauge: r.ck.checked ? 'True' : '',
    })).filter(p => p.name);

    const copyFrom = copySel.value === '(stock)' ? null : copySel.value;
    let plume = null;
    if (info.wfModuleID && plumeTplInp && plumeTplInp.value.trim()) {
      plume = {
        template: plumeTplInp.value.trim(),
        overrideParentTransform: plumeOptInp.value.trim(),
        position: plumePosInp.value.trim() || '0,0,0',
        rotation: plumeRotInp.value.trim() || '0,0,0',
        scale: plumeScaleInp.value.trim() || '1,1,1',
      };
    }
    const payload = {
      part: info.part,
      b9ModuleID: info.engineB9 ? info.engineB9.moduleID : null,
      targetModule: info.targetModule,
      subtype: {
        name, title: titleInp.value.trim(), copyFrom, fields,
        addedMass: massInp.value.trim(), addedCost: costInp.value.trim(),
        propellants: propellants.length ? propellants : null,
        plume,
        transforms: transformPool.length ? meChecks.filter(c => c.cb.checked).map(c => c.name) : null,
      },
    };
    variantStatus(wrap, 'Saving…', false);
    try {
      const r = await (await fetch('/api/variant/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })).json();
      if (r.error) throw new Error(r.error);
      VARIANT_LIST = null;
      VARIANT_UI = { part: info.part, mode: 'add', editingName: name };
      const list = await fetchVariantList();
      const card = wrap.closest('.pe');
      if (card) {
        card.textContent = '';
        buildVariantCard(card, info, (list && list[info.part] && list[info.part].subtypes) || []);
        const newWrap = card.querySelector('.variantform');
        variantStatus(newWrap || card, 'Variant saved. Open the Plume Manager and click Compile to apply in-game.', false);
      }
    } catch (ex) {
      variantStatus(wrap, ex.message || String(ex), true);
    }
  });

  host.appendChild(wrap);
}

function renderWarnings(root, d) {
  if (!d.warnings || !d.warnings.length) return;
  const sec = el('div', 'section');
  const det = el('details');
  det.appendChild(el('summary', null, `Overwrite warnings (${d.warnings.length})`));
  for (const w of d.warnings.slice(0, 60)) {
    const box = el('div', 'warnbox');
    box.appendChild(el('div', null, w.path + ' — ' + w.reason));
    box.appendChild(el('div', 'killer', '→ ' + w.killer + ' (' + w.killerPass + ')'));
    det.appendChild(box);
  }
  sec.appendChild(det);
  root.appendChild(sec);
}

function renderTree(root, d) {
  const sec = el('div', 'section');
  const det = el('details');
  det.appendChild(el('summary', null, 'Full compiled config (advanced)'));
  const tree = el('div', 'tree');
  tree.appendChild(renderNode(d.node, [], 0));
  det.appendChild(tree);
  sec.appendChild(det);
  root.appendChild(sec);
}

function renderNode(node, parents, depth) {
  const wrap = el('div', 'tnode' + (depth >= 1 ? ' collapsed' : ''));
  const head = el('div', 'thead');
  head.appendChild(el('span', 'arrow', depth >= 1 ? '▸' : '▾'));
  head.appendChild(el('span', 'nname', node.h));
  const nm = keyOf(node, 'name');
  if (nm) head.appendChild(el('span', null, ' ' + nm));
  wrap.appendChild(head);
  const body = el('div', 'tbody');
  for (const [k, v] of node.k) {
    const kv = el('div', 'tkv');
    kv.appendChild(el('span', 'k', k));
    kv.appendChild(el('span', 'eq', ' = '));
    kv.appendChild(el('span', 'v', v));
    if (v.startsWith('#LOC') && PART.loc[v]) kv.appendChild(el('span', 'locres', '“' + PART.loc[v] + '”'));
    body.appendChild(kv);
  }
  for (const c of node.c) body.appendChild(renderNode(c, [...parents, node], depth + 1));
  wrap.appendChild(body);
  head.addEventListener('click', () => {
    wrap.classList.toggle('collapsed');
    head.querySelector('.arrow').textContent = wrap.classList.contains('collapsed') ? '▸' : '▾';
  });
  return wrap;
}

/* ---------------- patch generation ---------------- */

function updateChangesBar() {
  const bar = $('#changesBar');
  if (!EDITS.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#changeCount').textContent = EDITS.size + ' change' + (EDITS.size > 1 ? 's' : '');
}

function buildPatch() {
  // tree of nested selectors
  const rootObj = { nodes: {}, lines: [] };
  for (const [path, edit] of EDITS) {
    const segs = path.split('/');
    let cur = rootObj;
    const upto = edit.kind === 'curve' ? segs.length : segs.length - 1;
    for (let i = 0; i < upto; i++) {
      const seg = segs[i];
      if (edit.kind === 'curve' && i === upto - 1) {
        // curve node: delete + re-add
        cur.lines.push({ curve: edit, nodeName: seg.split('[')[0].split(',')[0] });
      } else {
        cur.nodes[seg] = cur.nodes[seg] || { nodes: {}, lines: [] };
        cur = cur.nodes[seg];
      }
    }
    if (edit.kind === 'value') cur.lines.push({ key: segs[segs.length - 1], val: edit.val });
  }
  const out = [];
  out.push(`@PART[${PART.name}]:FINAL // generated by Engine Editor`);
  out.push('{');
  emit(rootObj, 1, out);
  out.push('}');
  return out.join('\n') + '\n';
}

function emit(obj, ind, out) {
  const pad = '\t'.repeat(ind);
  for (const line of obj.lines) {
    if (line.curve) {
      out.push(`${pad}!${line.nodeName} {}`);
      out.push(`${pad}${line.nodeName}`);
      out.push(pad + '{');
      for (const l of line.curve.lines.split('\n'))
        if (l.trim()) out.push(`${pad}\tkey = ${l.trim().replace(/^key\s*=\s*/, '')}`);
      out.push(pad + '}');
    } else {
      out.push(`${pad}%${line.key} = ${line.val}`);
    }
  }
  for (const [seg, child] of Object.entries(obj.nodes)) {
    // seg like MODULE[ModuleEnginesFX] or SUBTYPE[F1B] or MODULE[x],1
    const m = seg.match(/^([\w]+)(?:\[(.*?)\])?(?:,(\d+))?$/);
    const sel = '@' + (m ? m[1] + (m[2] ? `[${m[2]}]` : '') + (m[3] ? ',' + m[3] : '') : seg);
    out.push(pad + sel);
    out.push(pad + '{');
    emit(child, ind + 1, out);
    out.push(pad + '}');
  }
}

function showPatch() {
  $('#patchText').textContent = buildPatch();
  $('#patchName').value = PART.name.replace(/[^\w-]+/g, '_') + '-tweaks';
  $('#saveMsg').textContent = '';
  $('#modal').classList.remove('hidden');
}

async function savePatch() {
  const r = await (await fetch('/api/save_patch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: $('#patchName').value, content: buildPatch() }),
  })).json();
  $('#saveMsg').textContent = r.saved
    ? '✔ Saved to ' + r.saved + ' — takes effect next KSP launch.'
    : 'Error: ' + JSON.stringify(r);
}

init();
