'use strict';
/* Shared Waterfall plume EFFECT editor — used by BOTH the Plume Library page
 * (plumelib.js) and the Engine Editor drawer (app.js). It renders the per-effect
 * accordion (enable/disable, material params, offsets, modifier-curve tables) and
 * the add-effect palette, operating on a plain {h,k,c} EFFECTTEMPLATE tree.
 *
 * It owns NO canvas, NO template list, NO save — the host provides those. All the
 * host wiring goes through a ctx object:
 *
 *   ctx = {
 *     tree,        // the EFFECTTEMPLATE {h,k,c} node to edit (mutated in place)
 *     editable,    // bool — custom template (editable) vs mod (read-only preview)
 *     params,      // shader-param ranges (name -> {min,max}) for FLOAT sliders
 *     openIdx,     // Set<int> — which accordion rows are open (persisted by host)
 *     openDialog,  // async ({kind,title,message,list,value,okText}) -> value|null
 *     onChange,    // () => host re-renders its live preview
 *   }
 *
 * Public API (global `PlumeEdit`):
 *   PlumeEdit.mount(containerEl, ctx)  -> renders the editor into containerEl
 *   PlumeEdit.addEffect(ctx)           -> async; opens the palette, scaffolds an effect
 *   PlumeEdit.ensurePalette()          -> shared one-time /api/plume/palette fetch
 */
(function () {
  const kvOf = (n, k) => { const e = (n.k || []).find(([kk]) => kk === k); return e ? e[1] : undefined; };
  const setKV = (n, k, v) => { const e = (n.k || []).find(([kk]) => kk === k); if (e) e[1] = v; else (n.k = n.k || []).push([k, v]); };
  const removeKV = (n, k) => { if (!n.k) return; const i = n.k.findIndex(([kk]) => kk === k); if (i >= 0) n.k.splice(i, 1); };
  const deepClone = o => JSON.parse(JSON.stringify(o));
  const slugify = s => (s || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const isDisabled = eff => kvOf(eff, '_eeDisabled') === 'true';
  const setDisabled = (eff, val) => { if (val) setKV(eff, '_eeDisabled', 'true'); else removeKV(eff, '_eeDisabled'); };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  let PALETTE = null;
  async function ensurePalette() {
    if (PALETTE) return PALETTE;
    try { PALETTE = await (await fetch('/api/plume/palette')).json(); }
    catch (e) { PALETTE = { models: [], extraModels: [], shaders: [], shaderParams: {} }; }
    return PALETTE;
  }

  // ---- render the accordion into container ----
  function mount(container, ctx) {
    ctx._container = container;
    container.innerHTML = '';
    const tree = ctx.tree;
    if (!tree) return;
    const effects = (tree.c || []).filter(c => c.h === 'EFFECT');
    if (!effects.length) {
      container.appendChild(el('div', 'peEmpty', 'No effects yet — use “Add effect” to build this plume.'));
      return;
    }
    ctx.openIdx = ctx.openIdx || new Set();
    effects.forEach((eff, idx) => container.appendChild(effectRow(eff, idx, ctx)));
  }
  const rebuild = ctx => mount(ctx._container, ctx);

  function effSummary(eff) {
    const models = (eff.c || []).filter(c => c.h === 'MODEL');
    let shader = '';
    for (const m of models) { const mat = (m.c || []).find(c => c.h === 'MATERIAL'); if (mat) { shader = kvOf(mat, 'shader') || ''; break; } }
    const parent = kvOf(eff, 'parentName') || '';
    return [shader.split('/').pop(), parent].filter(Boolean).join(' → ');
  }

  function effectRow(eff, idx, ctx) {
    const row = el('div', 'effRow');
    if (isDisabled(eff)) row.classList.add('disabled');
    if (ctx.openIdx.has(idx)) row.classList.add('open');

    const head = el('div', 'effHead');
    const toggle = el('div', 'effToggle' + (isDisabled(eff) ? '' : ' on'));
    toggle.title = isDisabled(eff) ? 'Disabled — click to enable' : 'Enabled — click to disable';
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      setDisabled(eff, !isDisabled(eff));
      ctx.onChange && ctx.onChange();
      rebuild(ctx);
    });
    const nm = el('span', 'effName', kvOf(eff, 'name') || ('effect ' + idx));
    const sm = el('span', 'effSummary', effSummary(eff));
    const actions = el('div', 'effActions');
    if (ctx.editable) {
      const dup = el('button', 'btn', 'Duplicate'); dup.title = 'Duplicate this effect';
      dup.addEventListener('click', e => { e.stopPropagation(); duplicateEffect(eff, ctx); });
      const del = el('button', 'btn', 'Delete'); del.title = 'Delete this effect';
      del.addEventListener('click', async e => { e.stopPropagation(); await deleteEffect(eff, ctx); });
      actions.appendChild(dup); actions.appendChild(del);
    }
    head.appendChild(toggle); head.appendChild(nm); head.appendChild(sm); head.appendChild(actions);
    head.addEventListener('click', () => {
      row.classList.toggle('open');
      if (row.classList.contains('open')) ctx.openIdx.add(idx); else ctx.openIdx.delete(idx);
    });

    const body = el('div', 'effBody');
    body.appendChild(effectBody(eff, ctx));
    row.appendChild(head); row.appendChild(body);
    return row;
  }

  function effectBody(eff, ctx) {
    const editable = ctx.editable;
    const frag = document.createDocumentFragment();
    const models = (eff.c || []).filter(c => c.h === 'MODEL');
    models.forEach((model, mi) => {
      if (models.length > 1) frag.appendChild(el('div', 'effSection', 'Model ' + (mi + 1) + (kvOf(model, 'path') ? (' · ' + kvOf(model, 'path')) : '')));
      frag.appendChild(el('div', 'effSection', 'Offsets'));
      frag.appendChild(vec3Row(model, 'positionOffset', 'Position', '0,0,0', ctx));
      frag.appendChild(vec3Row(model, 'rotationOffset', 'Rotation', '0,0,0', ctx));
      frag.appendChild(vec3Row(model, 'scaleOffset', 'Scale', '1,1,1', ctx));
      for (const mat of (model.c || []).filter(c => c.h === 'MATERIAL')) {
        frag.appendChild(el('div', 'effSection', 'Material'));
        const sr = el('div', 'effOffsetRow'); sr.appendChild(el('label', null, 'shader'));
        const sv = el('span', 'modList'); sv.style.width = 'auto'; sv.textContent = kvOf(mat, 'shader') || '—';
        sr.appendChild(sv); frag.appendChild(sr);
        const texs = (mat.c || []).filter(c => c.h === 'TEXTURE');
        if (texs.length) {
          const tr = el('div', 'effOffsetRow'); tr.appendChild(el('label', null, 'texture slot(s)'));
          const tv = el('span', 'modList'); tv.style.width = 'auto';
          tv.textContent = texs.map(t => kvOf(t, 'textureSlotName')).filter(Boolean).join(', ') || '—';
          tr.appendChild(tv); frag.appendChild(tr);
        }
        for (const f of (mat.c || []).filter(c => c.h === 'FLOAT')) frag.appendChild(floatRow(f, ctx));
        for (const c of (mat.c || []).filter(c => c.h === 'COLOR')) frag.appendChild(colorRow(c, ctx));
      }
    });
    const MT = { FLOATMODIFIER: 1, COLORMODIFIER: 1, SCALEMODIFIER: 1, POSITIONMODIFIER: 1, ROTATIONMODIFIER: 1, UVOFFSETMODIFIER: 1 };
    const mods = (eff.c || []).filter(c => MT[c.h]);
    if (mods.length) {
      const det = el('details', 'eeModDetails'); det.appendChild(el('summary', null, 'Modifiers (' + mods.length + ')'));
      for (const m of mods) det.appendChild(modBlock(m, ctx));
      frag.appendChild(det);
    }
    return frag;
  }

  const MOD_LABEL = { FLOATMODIFIER: 'FLOAT', COLORMODIFIER: 'COLOR', SCALEMODIFIER: 'SCALE', POSITIONMODIFIER: 'POSITION', ROTATIONMODIFIER: 'ROTATION', UVOFFSETMODIFIER: 'UVOFFSET' };
  const MOD_NAME_FIELD = { FLOATMODIFIER: 'floatName', COLORMODIFIER: 'colorName', UVOFFSETMODIFIER: 'textureName' };
  const MOD_CURVES = {
    FLOATMODIFIER: [['floatCurve', 'Float curve']],
    COLORMODIFIER: [['rCurve', 'R'], ['gCurve', 'G'], ['bCurve', 'B'], ['aCurve', 'A']],
    SCALEMODIFIER: [['xCurve', 'X'], ['yCurve', 'Y'], ['zCurve', 'Z']],
    POSITIONMODIFIER: [['xCurve', 'X'], ['yCurve', 'Y'], ['zCurve', 'Z']],
    ROTATIONMODIFIER: [['xCurve', 'X'], ['yCurve', 'Y'], ['zCurve', 'Z']],
    UVOFFSETMODIFIER: [['scrollCurveX', 'Scroll X'], ['scrollCurveY', 'Scroll Y']],
  };

  function modBlock(mod, ctx) {
    const editable = ctx.editable;
    const block = el('div', 'eeModBlock');
    const head = el('div', 'eeModBlockHead');
    head.appendChild(el('span', 'eeModName', kvOf(mod, 'name') || MOD_LABEL[mod.h] || mod.h));
    head.appendChild(el('span', 'eeModBadge', MOD_LABEL[mod.h] || mod.h));
    const tn = kvOf(mod, 'transformName');
    if (tn) head.appendChild(el('span', 'eeModTn', tn));
    block.appendChild(head);

    const ctrlRow = el('div', 'effOffsetRow'); ctrlRow.appendChild(el('label', null, 'controller'));
    const ctrlInp = el('input'); ctrlInp.type = 'text'; ctrlInp.setAttribute('list', 'eeControllerList');
    ctrlInp.value = kvOf(mod, 'controllerName') || ''; if (!editable) ctrlInp.disabled = true;
    ctrlInp.addEventListener('input', () => { setKV(mod, 'controllerName', ctrlInp.value); ctx.onChange && ctx.onChange(); });
    ctrlRow.appendChild(ctrlInp); block.appendChild(ctrlRow);

    const combRow = el('div', 'effOffsetRow'); combRow.appendChild(el('label', null, 'combination'));
    const combSel = el('select');
    for (const o of ['REPLACE', 'ADD', 'SUBTRACT', 'MULTIPLY']) { const op = el('option', null, o); op.value = o; combSel.appendChild(op); }
    combSel.value = kvOf(mod, 'combinationType') || 'REPLACE'; if (!editable) combSel.disabled = true;
    combSel.addEventListener('change', () => { setKV(mod, 'combinationType', combSel.value); ctx.onChange && ctx.onChange(); });
    combRow.appendChild(combSel); block.appendChild(combRow);

    const nfKey = MOD_NAME_FIELD[mod.h];
    if (nfKey) {
      const row = el('div', 'effOffsetRow'); row.appendChild(el('label', null, nfKey));
      const inp = el('input'); inp.type = 'text'; inp.value = kvOf(mod, nfKey) || ''; if (!editable) inp.disabled = true;
      inp.addEventListener('input', () => { setKV(mod, nfKey, inp.value); ctx.onChange && ctx.onChange(); });
      row.appendChild(inp); block.appendChild(row);
    }
    for (const [key, label] of (MOD_CURVES[mod.h] || [])) block.appendChild(curveTable(mod, key, label, ctx));
    return block;
  }

  function parseCurveLine(v) {
    const p = String(v).trim().split(/\s+/).map(parseFloat);
    return { t: isNaN(p[0]) ? 0 : p[0], v: isNaN(p[1]) ? 0 : p[1], inT: isNaN(p[2]) ? '' : p[2], outT: isNaN(p[3]) ? '' : p[3] };
  }
  const curveLineOf = (r, hasT) => hasT ? (r.t + ' ' + r.v + ' ' + (r.inT === '' ? 0 : r.inT) + ' ' + (r.outT === '' ? 0 : r.outT)) : (r.t + ' ' + r.v);
  const getCurveChild = (mod, name) => (mod.c || []).find(c => c.h === name);

  function curveTable(mod, curveName, label, ctx) {
    const editable = ctx.editable;
    const wrap = el('div', 'eeCurveRow'); wrap.appendChild(el('label', null, label));
    const tblWrap = el('div', 'isptable-wrap');
    let cn = getCurveChild(mod, curveName);
    let rows = cn ? (cn.k || []).filter(([k]) => k === 'key').map(([, v]) => parseCurveLine(v)) : [];
    let hasTangents = rows.some(r => r.inT !== '' || r.outT !== '');
    const table = el('table', 'isptable');
    const commit = () => {
      const lines = rows.map(r => curveLineOf(r, hasTangents));
      if (!lines.length) { if (cn) { const i = (mod.c || []).indexOf(cn); if (i >= 0) mod.c.splice(i, 1); cn = null; } }
      else { if (!cn) { cn = { h: curveName, k: [], c: [] }; (mod.c = mod.c || []).push(cn); } cn.k = lines.map(l => ['key', l]); }
      ctx.onChange && ctx.onChange();
    };
    const buildTable = () => {
      table.innerHTML = '';
      const thead = el('tr');
      for (const h of ['Time', 'Value']) thead.appendChild(el('th', null, h));
      if (hasTangents) for (const h of ['in-tan', 'out-tan']) thead.appendChild(el('th', null, h));
      thead.appendChild(el('th')); table.appendChild(thead);
      rows.forEach((r, i) => {
        const tr = el('tr');
        const mkCell = field => {
          const td = el('td'); const inp = el('input'); inp.type = 'text'; inp.value = r[field];
          if (!editable) inp.disabled = true;
          inp.addEventListener('input', () => { r[field] = inp.value === '' ? '' : (+inp.value || 0); commit(); });
          td.appendChild(inp); return td;
        };
        tr.appendChild(mkCell('t')); tr.appendChild(mkCell('v'));
        if (hasTangents) { tr.appendChild(mkCell('inT')); tr.appendChild(mkCell('outT')); }
        const tdDel = el('td');
        if (editable) { const del = el('button', 'ghost isprow-del', '×'); del.type = 'button';
          del.addEventListener('click', () => { rows.splice(i, 1); commit(); buildTable(); }); tdDel.appendChild(del); }
        tr.appendChild(tdDel); table.appendChild(tr);
      });
    };
    buildTable(); tblWrap.appendChild(table);
    if (editable) {
      const btnRow = el('div'); btnRow.style.cssText = 'display:flex;gap:6px;';
      const addBtn = el('button', 'ghost isprow-add', '+ add row'); addBtn.type = 'button';
      addBtn.addEventListener('click', () => { rows.push({ t: 0, v: 0, inT: hasTangents ? 0 : '', outT: hasTangents ? 0 : '' }); commit(); buildTable(); });
      btnRow.appendChild(addBtn);
      const advBtn = el('button', 'ghost isprow-add', hasTangents ? 'Hide tangents' : 'Show tangents'); advBtn.type = 'button';
      advBtn.addEventListener('click', () => {
        hasTangents = !hasTangents;
        if (hasTangents) rows.forEach(r => { if (r.inT === '') r.inT = 0; if (r.outT === '') r.outT = 0; });
        commit(); buildTable(); advBtn.textContent = hasTangents ? 'Hide tangents' : 'Show tangents';
      });
      btnRow.appendChild(advBtn); tblWrap.appendChild(btnRow);
    }
    wrap.appendChild(tblWrap); return wrap;
  }

  function vec3Row(node, key, label, def, ctx) {
    const row = el('div', 'effOffsetRow'); row.appendChild(el('label', null, label));
    const parts = (kvOf(node, key) || def).split(',').map(v => parseFloat(v) || 0);
    const inputs = [];
    for (let i = 0; i < 3; i++) {
      const inp = el('input'); inp.type = 'number'; inp.step = '0.01'; inp.value = parts[i];
      if (!ctx.editable) inp.disabled = true;
      inp.addEventListener('input', () => { setKV(node, key, inputs.map(x => +x.value || 0).join(',')); ctx.onChange && ctx.onChange(); });
      inputs.push(inp); row.appendChild(inp);
    }
    return row;
  }

  function floatRow(node, ctx) {
    const name = kvOf(node, 'floatName'); const val = parseFloat(kvOf(node, 'value')) || 0;
    const rng = (ctx.params || {})[name] || { min: 0, max: 10 };
    const row = el('div', 'prow'); row.appendChild(el('label', null, name));
    const num = el('input'); num.type = 'number'; num.step = '0.01'; num.value = val;
    const rg = el('input'); rg.type = 'range'; rg.min = rng.min; rg.max = rng.max; rg.step = (rng.max - rng.min) / 500 || 0.01; rg.value = val;
    if (!ctx.editable) { num.disabled = true; rg.disabled = true; }
    const commit = v => { setKV(node, 'value', String(v)); num.value = v; rg.value = v; ctx.onChange && ctx.onChange(); };
    num.addEventListener('input', () => commit(+num.value));
    rg.addEventListener('input', () => commit(+rg.value));
    row.appendChild(num); row.appendChild(rg); return row;
  }

  function colorRow(node, ctx) {
    const name = kvOf(node, 'colorName'); const parts = (kvOf(node, 'colorValue') || '1,1,1,1').split(',').map(parseFloat);
    const row = el('div', 'prow'); row.appendChild(el('label', null, name));
    const cp = el('input'); cp.type = 'color';
    const to255 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
    cp.value = '#' + [0, 1, 2].map(i => to255(parts[i]).toString(16).padStart(2, '0')).join('');
    const mult = el('input'); mult.type = 'number'; mult.step = '0.1'; mult.title = 'HDR multiplier';
    const lum = Math.max(parts[0], parts[1], parts[2], 1); mult.value = (lum > 1 ? lum : 1).toFixed(2);
    if (!ctx.editable) { cp.disabled = true; mult.disabled = true; }
    const commit = () => {
      const h = cp.value; const r = parseInt(h.substr(1, 2), 16) / 255, g = parseInt(h.substr(3, 2), 16) / 255, b = parseInt(h.substr(5, 2), 16) / 255;
      const m = +mult.value || 1;
      setKV(node, 'colorValue', [r * m, g * m, b * m, parts[3] == null ? 1 : parts[3]].map(x => +x.toFixed(4)).join(','));
      ctx.onChange && ctx.onChange();
    };
    cp.addEventListener('input', commit); mult.addEventListener('input', commit);
    row.appendChild(cp); row.appendChild(mult); return row;
  }

  // ---- add / duplicate / delete effect ----
  function duplicateEffect(src, ctx) {
    const copy = deepClone(src);
    setKV(copy, 'name', (kvOf(src, 'name') || 'effect') + '_copy' + Math.floor(Math.random() * 900 + 100));
    removeKV(copy, '_eeDisabled');
    const pos = ctx.tree.c.indexOf(src);
    ctx.tree.c.splice(pos + 1, 0, copy);
    ctx.onChange && ctx.onChange(); rebuild(ctx);
  }
  async function deleteEffect(eff, ctx) {
    const ok = await ctx.openDialog({ kind: 'confirm', title: 'Delete effect',
      message: 'Delete effect "' + (kvOf(eff, 'name') || 'effect') + '"? This cannot be undone.', okText: 'Delete', cancelText: 'Cancel' });
    if (ok !== true) return;
    const pos = ctx.tree.c.indexOf(eff);
    if (pos >= 0) ctx.tree.c.splice(pos, 1);
    ctx.onChange && ctx.onChange(); rebuild(ctx);
  }
  async function addEffect(ctx) {
    const pal = await ensurePalette();
    const effects = (ctx.tree.c || []).filter(c => c.h === 'EFFECT');
    const list = [];
    for (const m of (pal.models || [])) if (m.example) list.push({ label: '✧ New: ' + m.name + (m.description ? ' — ' + m.description : ''), value: { kind: 'model', model: m } });
    for (const m of (pal.extraModels || [])) if (m.example) list.push({ label: '✧ New: ' + m.name + ' (in-game mesh)', value: { kind: 'model', model: m } });
    effects.forEach((e, i) => list.push({ label: '⧉ Duplicate: ' + (kvOf(e, 'name') || 'effect ' + i), value: { kind: 'dup', eff: e } }));
    const pick = await ctx.openDialog({ kind: 'list', title: 'Add effect', list, okText: 'Add' });
    if (!pick) return;
    if (pick.kind === 'dup') return duplicateEffect(pick.eff, ctx);
    const modelNode = deepClone(pick.model.example);
    const base = slugify(pick.model.name).toLowerCase().replace(/-/g, '') || 'effect';
    const eff = { h: 'EFFECT', k: [['name', base + Math.floor(Math.random() * 900 + 100)], ['parentName', 'thrustTransform']], c: [modelNode] };
    (ctx.tree.c = ctx.tree.c || []).push(eff);
    ctx.onChange && ctx.onChange(); rebuild(ctx);
  }

  window.PlumeEdit = { mount, addEffect, ensurePalette, isDisabled, setDisabled, kvOf, setKV };
})();
