"""Engine Editor local server.

    python server.py   ->  http://localhost:8151

Endpoints:
  /api/engines            catalog (engines.tsv joined with warning counts)
  /api/part?name=X        full final PART tree from ConfigCache + provenance + warnings
  /api/template?name=X    EFFECTTEMPLATE tree from ConfigCache
  /                       static UI from ./web/
No dependencies; index built in-memory at startup (~5 s).
"""
import csv, io, json, os, sys, hashlib, urllib.parse
import socket
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'indexer'))
from cfgtree import parse_text  # noqa: E402
import muparse  # noqa: E402  (.mu binary model parser)
import plume_manifest  # noqa: E402
import plume_compile  # noqa: E402

KSP = os.path.dirname(HERE)
GAMEDATA = os.path.join(KSP, 'GameData')
CACHE = os.path.join(GAMEDATA, 'ModuleManager.ConfigCache')
DATA = os.path.join(HERE, 'data')
MODELCACHE = os.path.join(DATA, 'modelcache')
PORT = 8151

# ---------------- startup indexing ----------------

part_span = {}       # part name -> (byte offset, byte length) of UrlConfig block
template_span = {}   # templateName -> (offset, length)
part_title = {}      # part name -> raw title (may be #LOC_ tag)
LOC = {}             # '#LOC_x' -> localized en-us string


def build_cache_index():
    """One streaming pass over the cache recording byte spans of PART / EFFECTTEMPLATE blocks,
    part titles, and en-us localization strings."""
    with open(CACHE, 'rb') as f:
        offset = 0
        block_start = None
        depth = 0
        kind = None       # b'PART' | b'EFFECTTEMPLATE' | b'Localization' | None
        name = None
        title = None
        lang = None
        for line in f:
            s = line.strip()
            if block_start is None:
                if s == b'UrlConfig':
                    block_start = offset
                    depth = 0
                    kind = None
                    name = None
                    title = None
                    lang = None
            else:
                if s == b'{':
                    depth += 1
                elif s == b'}':
                    depth -= 1
                    if depth == 0:
                        end = offset + len(line)
                        if kind == b'PART' and name:
                            pn = name.decode('utf-8', 'replace')
                            part_span[pn] = (block_start, end - block_start)
                            if title:
                                part_title[pn] = title.decode('utf-8', 'replace')
                        elif kind == b'EFFECTTEMPLATE' and name:
                            template_span[name.decode('utf-8', 'replace')] = (block_start, end - block_start)
                        block_start = None
                elif depth == 1 and kind is None and s in (b'PART', b'EFFECTTEMPLATE', b'Localization'):
                    kind = s
                elif kind == b'PART' and depth == 2:
                    if name is None and s.startswith(b'name = '):
                        name = s[7:]
                    elif title is None and s.startswith(b'title = '):
                        title = s[8:]
                elif kind == b'EFFECTTEMPLATE' and depth == 2 and name is None:
                    if s.startswith(b'templateName = '):
                        name = s[15:]
                elif kind == b'Localization':
                    if depth == 2 and b'=' not in s and s not in (b'{', b'}', b''):
                        lang = s
                    elif depth == 3 and lang == b'en-us' and s.startswith(b'#LOC'):
                        k, _, v = s.partition(b' = ')
                        LOC[k.decode('utf-8', 'replace')] = v.decode('utf-8', 'replace')
            offset += len(line)


def loc(text):
    """Resolve a #LOC_ tag to its en-us string (falls back to the tag)."""
    return LOC.get(text, text) if text.startswith('#LOC') else text


def build_tsv_offsets(path, key_col):
    """part name -> (offset, nrows) into a TSV sorted/grouped by part (ours are)."""
    index = {}
    with open(path, 'rb') as f:
        header = f.readline()
        cols = header.decode('utf-8').rstrip('\r\n').split('\t')
        ki = cols.index(key_col)
        offset = f.tell()
        cur, start, count = None, 0, 0
        for line in f:
            key = line.split(b'\t', ki + 1)[ki].decode('utf-8', 'replace')
            if key != cur:
                if cur is not None:
                    index[cur] = (start, count)
                cur, start, count = key, offset, 0
            count += 1
            offset += len(line)
        if cur is not None:
            index[cur] = (start, count)
    return cols, index


def read_tsv_rows(path, cols, span):
    start, count = span
    rows = []
    with open(path, 'rb') as f:
        f.seek(start)
        for _ in range(count):
            vals = f.readline().decode('utf-8', 'replace').rstrip('\r\n').split('\t')
            rows.append(dict(zip(cols, vals)))
    return rows


def collect_loc(n, out):
    for _k, v in n['keys']:
        if v.startswith('#LOC') and v in LOC:
            out[v] = LOC[v]
    for c in n['children']:
        collect_loc(c, out)


def node_to_json(n):
    return {'h': n['header'], 'k': n['keys'],
            'c': [node_to_json(c) for c in n['children']]}


def extract_block(span):
    with open(CACHE, 'rb') as f:
        f.seek(span[0])
        text = f.read(span[1]).decode('utf-8', 'replace')
    tops = parse_text('UrlConfig\n' + text if not text.startswith('UrlConfig') else text)
    # tops[0] = UrlConfig { parentUrl, <NODE> }
    uc = tops[0]
    parent = next((v for k, v in uc['keys'] if k == 'parentUrl'), '')
    inner = uc['children'][0] if uc['children'] else None
    return parent, inner


def _node_children(node, header):
    return [c for c in node['children'] if c['header'].split(':')[0].strip() == header]


def _node_key(node, key, default=None):
    for k, v in node['keys']:
        if k == key:
            return v
    return default


def _node_key_all(node, key):
    """All values of a repeated value-key on `node`, in file order."""
    return [v for k, v in node['keys'] if k == key]


def parse_mu_cached(mu_path):
    """Parse a .mu file, caching the resulting JSON keyed by path+mtime."""
    st = os.stat(mu_path)
    tag = hashlib.sha1(f'{os.path.abspath(mu_path)}|{st.st_mtime_ns}|{st.st_size}'
                       .encode('utf-8')).hexdigest()[:16]
    os.makedirs(MODELCACHE, exist_ok=True)
    cache_path = os.path.join(MODELCACHE, tag + '.json')
    if os.path.exists(cache_path):
        with open(cache_path, encoding='utf-8') as f:
            return json.load(f)
    res = muparse.parse_file(mu_path)
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(res, f)
    return res


def get_model_data(part_name):
    """Return {models:[{cfg, dir, tree, materials, textures}]} for a part's MODEL{} nodes.
    Any model that cannot be found/parsed is reported with an 'error' entry so the
    GUI can degrade gracefully instead of failing the whole part."""
    _parent, node = extract_block(part_span[part_name])
    model_nodes = _node_children(node, 'MODEL')
    # KSP PartLoader default rescaleFactor is 1.25 when the key is absent.
    try:
        rescale = float(_node_key(node, 'rescaleFactor', '1.25'))
    except ValueError:
        rescale = 1.25
    if not model_nodes:
        # legacy parts: implicit mesh named 'model.mu' beside the part.cfg — we cannot
        # locate it from the compiled cache, so just report none.
        return {'models': []}
    models = []
    for mn in model_nodes:
        rel = (_node_key(mn, 'model', '') or '').replace('\\', '/').strip()
        cfg = {'position': _node_key(mn, 'position', '0,0,0'),
               'rotation': _node_key(mn, 'rotation', '0,0,0'),
               'scale': _node_key(mn, 'scale', '1,1,1')}
        # texture = <oldName>,<GameData-relative-newpath> replacement directives.
        # Key by the old texture's basename (no extension), lowercased, for robust
        # matching against the texture names embedded in the .mu.
        tex_replace = {}
        for k, v in mn['keys']:
            if k != 'texture' or ',' not in v:
                continue
            old, new = v.split(',', 1)
            old = old.strip().replace('\\', '/').rsplit('/', 1)[-1]
            old = os.path.splitext(old)[0].lower()
            new = new.strip().replace('\\', '/')
            new = os.path.splitext(new)[0]
            if old:
                tex_replace[old] = new
        if not rel:
            continue
        mu_path = os.path.join(GAMEDATA, *rel.split('/')) + '.mu'
        entry = {'cfg': cfg, 'model': rel, 'dir': rel.rsplit('/', 1)[0] if '/' in rel else '',
                 'rescaleFactor': rescale, 'textureReplace': tex_replace}
        if not os.path.isfile(mu_path):
            entry['error'] = 'model file not found: ' + rel + '.mu'
            models.append(entry)
            continue
        try:
            res = parse_mu_cached(mu_path)
            entry['tree'] = res['tree']
            entry['materials'] = res['materials']
            entry['textures'] = res['textures']
        except Exception as ex:
            entry['error'] = 'parse failed: ' + repr(ex)
        models.append(entry)
    return {'models': models}


_DEFAULT_ATTACH = {'overrideParentTransform': '', 'position': '0,0,0',
                   'rotation': '0,0,0', 'scale': '1,1,1'}


def _template_and_attach(container):
    """Find the first TEMPLATE node under `container` (either directly, or nested in a DATA
    node — B9PS subtype overrides wrap it in DATA). Returns (templateName|None, attach)."""
    tnodes = []
    for d in _node_children(container, 'DATA'):
        tnodes += _node_children(d, 'TEMPLATE')
    tnodes += _node_children(container, 'TEMPLATE')
    if not tnodes:
        return None, dict(_DEFAULT_ATTACH)
    t = tnodes[0]
    return (_node_key(t, 'templateName', '') or ''), {
        'overrideParentTransform': _node_key(t, 'overrideParentTransform', '') or '',
        'position': _node_key(t, 'position', '0,0,0') or '0,0,0',
        'rotation': _node_key(t, 'rotation', '0,0,0') or '0,0,0',
        'scale': _node_key(t, 'scale', '1,1,1') or '1,1,1'}


def _subtype_module_overrides(sub, mod_name):
    """Return the list of MODULE children of a SUBTYPE that override the module named
    `mod_name` (i.e. carry an IDENTIFIER{ name = <mod_name> })."""
    out = []
    for subm in _node_children(sub, 'MODULE'):
        if any(_node_key(i, 'name') == mod_name
               for i in _node_children(subm, 'IDENTIFIER')):
            out.append(subm)
    return out


def _subtype_wf_override_modules(sub):
    """Return the list of MODULE children of a SUBTYPE that override a ModuleWaterfallFX
    (i.e. carry an IDENTIFIER{ name = ModuleWaterfallFX })."""
    return _subtype_module_overrides(sub, 'ModuleWaterfallFX')


def engine_plume_info(part_name):
    """Case detection (docs/PlumeEditorDesign.md §5e) from the compiled PART node.

    Case A = has >=1 ModuleWaterfallFX and NO ModuleB9PartSwitch subtype that overrides a
    ModuleWaterfallFX. Case B = some B9PS subtype already switches the plume. 'none' = no WF.

    Returns {part, case, wfModules:[{moduleID, templates:[...], attach:{...}}],
             b9ModuleIDs:[...], b9PlumeSwitchers:[...], caseB:{...}|None}.

    For Case B, `caseB` (docs/PlumeEditorDesign.md §5f) carries the plume-switching B9PS
    moduleID, the base ModuleWaterfallFX moduleID + template/attach it switches, and per
    subtype: whether it already has a WF override (with its current template/attach + the
    count of matching override MODULEs — for the `@MODULE:HAS[@IDENTIFIER[..]]` lint) or
    inherits the base template.
    """
    _p, node = extract_block(part_span[part_name])
    wf = []
    b9_ids = []
    b9_switchers = []
    b9_nodes = {}
    for m in _node_children(node, 'MODULE'):
        nm = _node_key(m, 'name')
        if nm == 'ModuleWaterfallFX':
            templates = []
            attach = {'overrideParentTransform': '', 'position': '0,0,0',
                      'rotation': '0,0,0', 'scale': '1,1,1'}
            first = True
            for t in _node_children(m, 'TEMPLATE'):
                templates.append(_node_key(t, 'templateName', ''))
                if first:
                    attach = {
                        'overrideParentTransform': _node_key(t, 'overrideParentTransform', '') or '',
                        'position': _node_key(t, 'position', '0,0,0') or '0,0,0',
                        'rotation': _node_key(t, 'rotation', '0,0,0') or '0,0,0',
                        'scale': _node_key(t, 'scale', '1,1,1') or '1,1,1'}
                    first = False
            wf.append({'moduleID': _node_key(m, 'moduleID', '') or '',
                       'templates': templates, 'attach': attach})
        elif nm == 'ModuleB9PartSwitch':
            mid = _node_key(m, 'moduleID', '') or ''
            b9_ids.append(mid)
            b9_nodes[mid] = m
            switches_wf = any(_subtype_wf_override_modules(sub)
                              for sub in _node_children(m, 'SUBTYPE'))
            if switches_wf:
                b9_switchers.append(mid)
    if wf and not b9_switchers:
        case = 'A'
    elif b9_switchers:
        case = 'B'
    else:
        case = 'none'

    caseB = None
    if case == 'B' and b9_switchers:
        b9_id = b9_switchers[0]
        b9node = b9_nodes.get(b9_id)
        switched_wf_id = ''
        subtypes_detail = []
        for sub in _node_children(b9node, 'SUBTYPE'):
            sname = _node_key(sub, 'name', '') or ''
            ovs = _subtype_wf_override_modules(sub)
            if ovs:
                tn, att = _template_and_attach(ovs[0])
                for ident in _node_children(ovs[0], 'IDENTIFIER'):
                    if _node_key(ident, 'name') == 'ModuleWaterfallFX' and not switched_wf_id:
                        switched_wf_id = _node_key(ident, 'moduleID', '') or ''
                subtypes_detail.append({'name': sname, 'hasOverride': True,
                                        'overrideCount': len(ovs),
                                        'template': tn, 'attach': att})
            else:
                subtypes_detail.append({'name': sname, 'hasOverride': False,
                                        'overrideCount': 0, 'template': None, 'attach': None})
        base_wf_id = switched_wf_id or (wf[0]['moduleID'] if wf else '')
        base_tn = ''
        base_att = dict(_DEFAULT_ATTACH)
        for w in wf:
            if w['moduleID'] == base_wf_id:
                base_tn = w['templates'][0] if w['templates'] else ''
                base_att = w['attach']
        # subtypes with no override inherit the base template — surface it for the UI
        for s in subtypes_detail:
            if not s['hasOverride']:
                s['template'] = base_tn
                s['attach'] = base_att
        caseB = {'b9ModuleID': b9_id, 'wfModuleID': base_wf_id,
                 'baseWF': {'moduleID': base_wf_id, 'template': base_tn, 'attach': base_att},
                 'subtypes': subtypes_detail}

    return {'part': part_name, 'case': case, 'wfModules': wf,
            'b9ModuleIDs': b9_ids, 'b9PlumeSwitchers': b9_switchers, 'caseB': caseB}


_ENGINE_MODULE_NAMES = ('ModuleEnginesFX', 'ModuleEngines')


def _isp_curve_from_node(mod_node):
    """Read an `atmosphereCurve { key = t v ... }` child of `mod_node` into [[k,v],...].
    Returns None if there is no atmosphereCurve child at all (caller decides fallback)."""
    curves = _node_children(mod_node, 'atmosphereCurve')
    if not curves:
        return None
    pts = []
    for k, v in curves[0]['keys']:
        if k != 'key':
            continue
        parts = v.split()
        if len(parts) >= 2:
            pts.append([parts[0], parts[1]])
    return pts


def _propellants_from_node(mod_node):
    return [{'name': _node_key(p, 'name', '') or '',
             'ratio': _node_key(p, 'ratio', '') or '',
             'DrawGauge': _node_key(p, 'DrawGauge', '') or ''}
            for p in _node_children(mod_node, 'PROPELLANT')]


def _engine_fields(mod_node, base=None):
    """Read engine stat fields (maxThrust/minThrust/heatProduction/ispCurve/propellants)
    directly from `mod_node`. Any field absent on `mod_node` falls back to the matching
    value in `base` (used when `mod_node` is a partial subtype override); with no `base`,
    absent fields default to '' / [] (used for the part's own top-level engine module)."""
    base = base or {}
    mt = _node_key(mod_node, 'maxThrust')
    mnt = _node_key(mod_node, 'minThrust')
    hp = _node_key(mod_node, 'heatProduction')
    isp = _isp_curve_from_node(mod_node)
    props = _propellants_from_node(mod_node) if _node_children(mod_node, 'PROPELLANT') else None
    return {
        'maxThrust': mt if mt is not None else base.get('maxThrust', ''),
        'minThrust': mnt if mnt is not None else base.get('minThrust', ''),
        'heatProduction': hp if hp is not None else base.get('heatProduction', ''),
        'ispCurve': isp if isp is not None else base.get('ispCurve', []),
        'propellants': props if props is not None else base.get('propellants', []),
    }


def _override_data_node(ovmod):
    """B9PS subtype MODULE overrides wrap the actual overridden fields in a DATA child
    (MODULE{ IDENTIFIER{...} DATA{ maxThrust = .. atmosphereCurve{...} } }); fall back to
    the module node itself if there's no DATA wrapper."""
    datas = _node_children(ovmod, 'DATA')
    return datas[0] if datas else ovmod


def engine_variant_info(part_name):
    """Engine-config VARIANTS extraction (docs/PlumeEditorDesign.md §7.4)."""
    _p, node = extract_block(part_span[part_name])
    top_modules = _node_children(node, 'MODULE')

    target_module = None
    engine_mod = None
    for want in ('ModuleEnginesFX', 'ModuleEngines'):
        for m in top_modules:
            if _node_key(m, 'name') == want:
                target_module = want
                engine_mod = m
                break
        if engine_mod is not None:
            break

    base = (_engine_fields(engine_mod) if engine_mod is not None else
            {'maxThrust': '', 'minThrust': '', 'heatProduction': '', 'ispCurve': [], 'propellants': []})

    b9_ids = []
    engine_b9_candidates = []  # [(moduleID, node)]
    wf_module_id = ''
    wf_mod_node = None
    for m in top_modules:
        nm = _node_key(m, 'name')
        if nm == 'ModuleB9PartSwitch':
            mid = _node_key(m, 'moduleID', '') or ''
            b9_ids.append(mid)
            if target_module and any(_subtype_module_overrides(sub, target_module)
                                     for sub in _node_children(m, 'SUBTYPE')):
                engine_b9_candidates.append((mid, m))
        elif nm == 'ModuleWaterfallFX' and not wf_module_id:
            wf_module_id = _node_key(m, 'moduleID', '') or ''
            wf_mod_node = m

    # The part's default/base plume (first ModuleWaterfallFX's first TEMPLATE + attach). §7.10.
    base_plume = None
    if wf_mod_node is not None:
        _btn, _batt = _template_and_attach(wf_mod_node)
        base_plume = {'template': _btn or '', **_batt}

    engine_b9_count = len(engine_b9_candidates)
    engine_b9 = None
    b9node = None
    if engine_b9_count == 1:
        mid, b9node = engine_b9_candidates[0]
        switcher_desc = _node_key(b9node, 'switcherDescription', '') or ''
        engine_b9 = {'moduleID': mid, 'switcherDescription': switcher_desc}

    subtypes = [{'name': '(stock)', 'title': '', 'isBase': True,
                'hasEngineOverride': False, 'overrideCount': 0,
                'maxThrust': base['maxThrust'], 'minThrust': base['minThrust'],
                'heatProduction': base['heatProduction'], 'ispCurve': base['ispCurve'],
                'propellants': base['propellants'], 'addedMass': '', 'addedCost': '',
                'transforms': [],
                'hasWfOverride': False, 'wfOverrideCount': 0,
                'plume': dict(base_plume) if base_plume else None}]

    transform_pool = set()
    if b9node is not None:
        for sub in _node_children(b9node, 'SUBTYPE'):
            sname = _node_key(sub, 'name', '') or ''
            title = _node_key(sub, 'title', '') or ''
            ovs = _subtype_module_overrides(sub, target_module)
            if ovs:
                fields = _engine_fields(_override_data_node(ovs[0]), base)
            else:
                fields = dict(base)
            sub_transforms = _node_key_all(sub, 'transform')
            transform_pool.update(sub_transforms)
            # per-subtype plume: its own ModuleWaterfallFX override if any, else the base plume (§7.10)
            wf_ovs = _subtype_module_overrides(sub, 'ModuleWaterfallFX')
            if wf_ovs:
                _stn, _satt = _template_and_attach(wf_ovs[0])
                sub_plume = {'template': _stn or '', **_satt}
            else:
                sub_plume = dict(base_plume) if base_plume else None
            subtypes.append({'name': sname, 'title': title, 'isBase': False,
                             'hasEngineOverride': bool(ovs), 'overrideCount': len(ovs),
                             'maxThrust': fields['maxThrust'], 'minThrust': fields['minThrust'],
                             'heatProduction': fields['heatProduction'],
                             'ispCurve': fields['ispCurve'], 'propellants': fields['propellants'],
                             'addedMass': _node_key(sub, 'addedMass', '') or '',
                             'addedCost': _node_key(sub, 'addedCost', '') or '',
                             'transforms': sub_transforms,
                             'hasWfOverride': bool(wf_ovs), 'wfOverrideCount': len(wf_ovs),
                             'plume': sub_plume})

    return {'part': part_name, 'targetModule': target_module, 'base': base,
            'engineB9': engine_b9, 'engineB9Count': engine_b9_count,
            'b9ModuleIDs': b9_ids, 'wfModuleID': wf_module_id, 'subtypes': subtypes,
            'transformPool': sorted(transform_pool),
            'basePlume': base_plume}


print('Indexing ConfigCache ...')
build_cache_index()
print(f'  parts: {len(part_span)}  templates: {len(template_span)}')

with open(os.path.join(DATA, 'engines.tsv'), encoding='utf-8') as f:
    ENGINES = list(csv.DictReader(f, delimiter='\t'))
PROV_COLS, PROV_IDX = build_tsv_offsets(os.path.join(DATA, 'part_provenance.tsv'), 'part')
WARN_COLS, WARN_IDX = build_tsv_offsets(os.path.join(DATA, 'part_warnings.tsv'), 'part')
for e in ENGINES:
    e['warningCount'] = WARN_IDX.get(e['part'], (0, 0))[1]
    e['title'] = loc(part_title.get(e['part'], e['part']))
print(f'  engines: {len(ENGINES)}  provenance parts: {len(PROV_IDX)}  loc strings: {len(LOC)}')

# ---------------- template catalog + shader params (Plume Library) ----------------

TEMPLATES = []   # [{templateName, providedBy(mod), parentUrl, usageCount}]
try:
    with open(os.path.join(DATA, 'templates.tsv'), encoding='utf-8') as f:
        for row in csv.DictReader(f, delimiter='\t'):
            parent = row.get('providedBy_parentUrl', '') or ''
            mod = parent.replace('\\', '/').lstrip('/').split('/')[0] or '(root)'
            TEMPLATES.append({'templateName': row.get('templateName', ''),
                              'providedBy': mod, 'parentUrl': parent,
                              'usageCount': int(row.get('usageCount', '0') or 0)})
except Exception as ex:  # pragma: no cover
    print('  (templates.tsv not loaded:', ex, ')')
print(f'  plume templates: {len(TEMPLATES)}')

# reverse map: templateName -> [part names] that reference it (from engines.tsv wfTemplates,
# semicolon-separated). Cheap and correct: it's the same column the indexer wrote.
TEMPLATE_USED_BY = {}
for _e in ENGINES:
    for _tn in (_e.get('wfTemplates', '') or '').split(';'):
        _tn = _tn.strip()
        if _tn:
            TEMPLATE_USED_BY.setdefault(_tn, []).append(_e['part'])

STARTER_TEMPLATES_PATH = os.path.join(DATA, 'starter_templates.json')

SHADER_PARAMS = {}   # paramName -> {type, min, max}
# The real install keeps the param definitions in Waterfall/WaterfallShaders.cfg
# (Waterfall/Shaders/ holds the compiled *.waterfall assetbundles). Try both.
for _sp in (os.path.join(KSP, 'GameData', 'Waterfall', 'WaterfallShaders.cfg'),
            os.path.join(KSP, 'GameData', 'Waterfall', 'Shaders', 'WaterfallShaders.cfg')):
    if os.path.exists(_sp):
        try:
            with open(_sp, encoding='utf-8') as f:
                for top in parse_text(f.read()):
                    if top['header'] != 'WATERFALL_SHADER_PARAM':
                        continue
                    kv = dict(top['keys'])
                    rng = (kv.get('range', '0,1') or '0,1').split(',')
                    try:
                        lo, hi = float(rng[0]), float(rng[1])
                    except Exception:
                        lo, hi = 0.0, 1.0
                    SHADER_PARAMS[kv.get('name', '')] = {
                        'type': kv.get('type', 'Float'), 'min': lo, 'max': hi}
        except Exception as ex:  # pragma: no cover
            print('  (WaterfallShaders.cfg parse failed:', ex, ')')
        break
print(f'  shader params: {len(SHADER_PARAMS)}')

# ---- Waterfall model + shader catalogs (for the blank-slate plume builder, §8) ----
WF_MODELS = []   # [{name, workflow, path, description}]
WF_SHADERS = []  # [{name, workflow, description}]
for _mf, _bucket, _hdr in (
        (os.path.join(KSP, 'GameData', 'Waterfall', 'WaterfallModels.cfg'), WF_MODELS, 'WATERFALL_MODEL'),
        (os.path.join(KSP, 'GameData', 'Waterfall', 'WaterfallShaders.cfg'), WF_SHADERS, 'WATERFALL_SHADER')):
    if os.path.exists(_mf):
        try:
            with open(_mf, encoding='utf-8') as f:
                for top in parse_text(f.read()):
                    if top['header'] != _hdr:
                        continue
                    kv = dict(top['keys'])
                    row = {'name': kv.get('name', ''), 'workflow': kv.get('workflow', ''),
                           'description': kv.get('description', '')}
                    if _hdr == 'WATERFALL_MODEL':
                        row['path'] = kv.get('path', '')
                    _bucket.append(row)
        except Exception as ex:  # pragma: no cover
            print('  (%s parse failed: %s)' % (os.path.basename(_mf), ex))
print(f'  waterfall models: {len(WF_MODELS)}  shaders: {len(WF_SHADERS)}')

# Lazily harvested representative MODEL node per modelName path, from real template usage — a
# from-scratch effect scaffolds from a KNOWN-GOOD MODEL block so it renders immediately (§8).
_MODEL_EXAMPLES = None  # {modelPath: MODEL node (h,k,c json)}

def model_examples():
    global _MODEL_EXAMPLES
    if _MODEL_EXAMPLES is not None:
        return _MODEL_EXAMPLES
    ex = {}
    for tname in template_span:
        try:
            _parent, node = extract_block(template_span[tname])
        except Exception:
            continue
        for eff in _node_children(node, 'EFFECT'):
            for model in _node_children(eff, 'MODEL'):
                # EFFECTTEMPLATE MODEL blocks key the mesh as `path` (part-level uses `modelName`)
                path = _node_key(model, 'path', '') or _node_key(model, 'modelName', '') or ''
                if path and path not in ex:
                    ex[path] = node_to_json(model)
        if len(ex) >= len(WF_MODELS) + 40:  # plenty harvested; stop early
            break
    _MODEL_EXAMPLES = ex
    return ex

# ---------------- HTTP ----------------


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(HERE, 'web'), **kw)

    def end_headers(self):
        # Dev tool: never let the browser cache HTML/JS — stale scripts have
        # repeatedly masked fixes ("change did nothing" reports).
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        if url.path == '/api/engines':
            return self.send_json(ENGINES)
        if url.path == '/api/part':
            name = q.get('name', [''])[0]
            if name not in part_span:
                return self.send_json({'error': 'unknown part'}, 404)
            parent, node = extract_block(part_span[name])
            prov = read_tsv_rows(os.path.join(DATA, 'part_provenance.tsv'), PROV_COLS,
                                 PROV_IDX[name]) if name in PROV_IDX else []
            warns = read_tsv_rows(os.path.join(DATA, 'part_warnings.tsv'), WARN_COLS,
                                  WARN_IDX[name]) if name in WARN_IDX else []
            locs = {}
            collect_loc(node, locs)
            return self.send_json({'name': name, 'parentUrl': parent,
                                   'title': loc(part_title.get(name, name)),
                                   'node': node_to_json(node), 'loc': locs,
                                   'provenance': prov, 'warnings': warns})
        if url.path == '/api/template':
            name = q.get('name', [''])[0]
            if name not in template_span:
                return self.send_json({'error': 'unknown template'}, 404)
            parent, node = extract_block(template_span[name])
            return self.send_json({'name': name, 'parentUrl': parent,
                                   'node': node_to_json(node)})
        if url.path == '/api/templates':
            show_all = q.get('all', ['0'])[0] in ('1', 'true')
            rows = [t for t in TEMPLATES
                    if show_all or 'deprecated' not in t['templateName'].lower()]
            return self.send_json(rows)
        if url.path == '/api/shaderparams':
            return self.send_json(SHADER_PARAMS)
        if url.path == '/api/plume/palette':
            # Blank-slate builder palette (§8): Waterfall models (annotated with a harvested
            # representative MODEL block so a new effect renders immediately), shaders, params.
            ex = model_examples()
            models = []
            for m in WF_MODELS:
                models.append({**m, 'example': ex.get(m.get('path', ''))})
            # also surface any model paths used in-game that aren't in the 14 canonical defs
            known = {m.get('path', '') for m in WF_MODELS}
            extras = [{'name': p.split('/')[-1], 'workflow': '', 'description': '(used in-game)',
                       'path': p, 'example': ex[p]} for p in sorted(ex) if p not in known]
            return self.send_json({'models': models, 'extraModels': extras,
                                   'shaders': WF_SHADERS, 'shaderParams': SHADER_PARAMS})
        if url.path == '/api/plume/list':
            show_all = q.get('all', ['0'])[0] in ('1', 'true')
            manifest = plume_manifest.load()
            rows = []
            for name, entry in manifest['templates'].items():
                rows.append({'name': name, 'source': 'custom', 'providedBy': 'EngineEditor',
                             'usageCount': 0, 'usedByEngines': [], 'base': entry.get('base')})
            for t in TEMPLATES:
                nm = t['templateName']
                if not show_all and 'deprecated' in nm.lower():
                    continue
                rows.append({'name': nm, 'source': 'mod', 'providedBy': t['providedBy'],
                             'usageCount': t['usageCount'],
                             'usedByEngines': TEMPLATE_USED_BY.get(nm, []), 'base': None})
            return self.send_json(rows)
        if url.path == '/api/plume/get':
            name = q.get('name', [''])[0]
            manifest = plume_manifest.load()
            if name in manifest['templates']:
                entry = manifest['templates'][name]
                return self.send_json({'name': name, 'source': 'custom', 'editable': True,
                                       'base': entry.get('base'), 'node': entry['tree']})
            if name not in template_span:
                return self.send_json({'error': 'unknown template'}, 404)
            parent, node = extract_block(template_span[name])
            return self.send_json({'name': name, 'source': 'mod', 'editable': False,
                                   'parentUrl': parent, 'node': node_to_json(node)})
        if url.path == '/api/plume/manifest':
            return self.send_json(plume_manifest.load())
        if url.path == '/api/plume/engine-info':
            name = q.get('part', [''])[0]
            if name not in part_span:
                return self.send_json({'error': 'unknown part'}, 404)
            info = engine_plume_info(name)
            manifest = plume_manifest.load()
            info['assignment'] = manifest['engines'].get(name)
            info['title'] = loc(part_title.get(name, name))
            return self.send_json(info)
        if url.path == '/api/variant/info':
            name = q.get('part', [''])[0]
            if name not in part_span:
                return self.send_json({'error': 'unknown part'}, 404)
            return self.send_json(engine_variant_info(name))
        if url.path == '/api/variant/list':
            return self.send_json(plume_manifest.list_engine_variants())
        if url.path == '/api/plume/starters':
            try:
                with open(STARTER_TEMPLATES_PATH, encoding='utf-8') as f:
                    return self.send_json(json.load(f))
            except Exception as ex:
                return self.send_json({'error': repr(ex), 'templates': []}, 200)
        if url.path == '/api/fxmodel':
            # Parse any GameData .mu (Waterfall FX meshes) -> object tree + meshes
            # (incl. skin data: boneIndices/boneWeights/bindPoses + bone name lists)
            # + materials + textures. path is GameData-relative, extension optional.
            rel = q.get('path', [''])[0].replace('\\', '/').strip().lstrip('/')
            if rel.lower().endswith('.mu'):
                rel = rel[:-3]
            base = os.path.normpath(GAMEDATA)
            stem = os.path.normpath(os.path.join(base, *rel.split('/')))
            if not stem.startswith(base):
                return self.send_json({'error': 'bad path'}, 400)
            mu_path = stem + '.mu'
            if not os.path.isfile(mu_path):
                return self.send_json({'error': 'not found', 'path': rel}, 404)
            try:
                res = parse_mu_cached(mu_path)
            except Exception as ex:
                return self.send_json({'error': 'parse failed: ' + repr(ex),
                                       'path': rel}, 200)
            return self.send_json({'path': rel, 'name': res.get('name'),
                                   'tree': res['tree'], 'materials': res['materials'],
                                   'textures': res['textures']})
        if url.path == '/api/model':
            name = q.get('part', [''])[0]
            if name not in part_span:
                return self.send_json({'error': 'unknown part'}, 404)
            try:
                return self.send_json(get_model_data(name))
            except Exception as ex:
                return self.send_json({'error': repr(ex), 'models': []}, 200)
        if url.path == '/api/texture':
            # Serve a model texture for a GameData-relative path (extension optional).
            # Tries .dds/.png/.mbm; .mbm is decoded to metadata + raw pixels.
            rel = q.get('path', [''])[0].replace('\\', '/').lstrip('/')
            base = os.path.normpath(GAMEDATA)
            stem = os.path.normpath(os.path.join(base, rel))
            if not stem.startswith(base):
                return self.send_json({'error': 'bad path'}, 400)
            # strip a supplied extension so we can probe the ones that actually ship
            root, ext = os.path.splitext(stem)
            if ext.lower() in ('.dds', '.png', '.mbm', '.tga'):
                stem = root
            cand = None
            for ext in ('.dds', '.png', '.mbm', '.DDS', '.PNG', '.MBM'):
                if os.path.isfile(stem + ext):
                    cand = stem + ext
                    break
            if not cand:
                # case-insensitive fallback: scan the directory for <stem>.<ext>
                d, bn = os.path.split(stem)
                want = bn.lower()
                try:
                    for fn in os.listdir(d):
                        r, e = os.path.splitext(fn)
                        if r.lower() == want and e.lower() in ('.dds', '.png', '.mbm'):
                            cand = os.path.join(d, fn)
                            break
                except OSError:
                    pass
            if not cand:
                return self.send_json({'error': 'not found', 'path': rel}, 404)
            low = cand.lower()
            with open(cand, 'rb') as fh:
                data = fh.read()
            if low.endswith('.png'):
                ctype = 'image/png'
                extra = {}
            elif low.endswith('.mbm'):
                # KSP raw: 20-byte header (5 ints: magic,width,height,format,bpp),
                # then width*height*(bpp/8) raw pixel bytes (RGB for bpp 24, RGBA for 32).
                import struct as _st
                magic, w, h, fmt, bpp = _st.unpack_from('<5i', data, 0)
                data = data[20:]
                ctype = 'application/octet-stream'
                extra = {'X-Width': str(w), 'X-Height': str(h),
                         'X-Format': 'RGBA' if bpp == 32 else 'RGB'}
            else:  # .dds
                ctype = 'application/octet-stream'
                extra = {'X-Format': 'DDS'}
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
            return
        if url.path == '/api/wftex':
            # Serve a raw GameData file (noise .dds etc.). Path is GameData-relative
            # or Waterfall-mod-relative (e.g. Waterfall/FX/fx-noise-2 [.dds implied]).
            rel = q.get('path', [''])[0].replace('\\', '/').lstrip('/')
            base = os.path.normpath(os.path.join(KSP, 'GameData'))
            cand = os.path.normpath(os.path.join(base, rel))
            if not cand.startswith(base):
                return self.send_json({'error': 'bad path'}, 400)
            if not os.path.exists(cand):
                for ext in ('.dds', '.png', '.DDS', '.PNG'):
                    if os.path.exists(cand + ext):
                        cand = cand + ext
                        break
            if not os.path.isfile(cand):
                return self.send_json({'error': 'not found', 'path': rel}, 404)
            with open(cand, 'rb') as fh:
                data = fh.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path in ('/api/plume/clone', '/api/plume/rename', '/api/plume/delete',
                        '/api/plume/save', '/api/plume/new-blank'):
            length = int(self.headers.get('Content-Length', 0))
            try:
                body = json.loads(self.rfile.read(length) or b'{}')
            except Exception as ex:
                return self.send_json({'error': 'bad json body: ' + repr(ex)}, 400)
            mod_names = {t['templateName'] for t in TEMPLATES}
            try:
                if url.path == '/api/plume/new-blank':
                    manifest = plume_manifest.create_blank(body.get('name', ''), mod_names)
                elif url.path == '/api/plume/clone':
                    source = body.get('source', '')
                    new_name = body.get('newName', '')
                    manifest = plume_manifest.load()
                    if source in manifest['templates']:
                        source_tree = manifest['templates'][source]['tree']
                    elif source in template_span:
                        _parent, node = extract_block(template_span[source])
                        source_tree = node_to_json(node)
                    else:
                        return self.send_json({'error': 'unknown source template %r' % (source,)}, 404)
                    manifest = plume_manifest.clone(source, new_name, source_tree, mod_names)
                elif url.path == '/api/plume/rename':
                    manifest = plume_manifest.rename(body.get('name', ''), body.get('newName', ''), mod_names)
                elif url.path == '/api/plume/delete':
                    manifest = plume_manifest.delete(body.get('name', ''))
                else:  # /api/plume/save
                    manifest = plume_manifest.save_tree(body.get('name', ''), body.get('tree'))
            except plume_manifest.PlumeManifestError as ex:
                return self.send_json({'error': str(ex)}, 400)
            return self.send_json(manifest)
        if url.path in ('/api/variant/add', '/api/variant/remove'):
            length = int(self.headers.get('Content-Length', 0))
            try:
                body = json.loads(self.rfile.read(length) or b'{}')
            except Exception as ex:
                return self.send_json({'error': 'bad json body: ' + repr(ex)}, 400)
            try:
                if url.path == '/api/variant/add':
                    manifest = plume_manifest.add_engine_variant(
                        body.get('part', ''), body.get('b9ModuleID'),
                        body.get('targetModule', ''), body.get('subtype', {}))
                else:  # /api/variant/remove
                    manifest = plume_manifest.remove_engine_variant(
                        body.get('part', ''), body.get('name', ''))
            except plume_manifest.PlumeManifestError as ex:
                return self.send_json({'error': str(ex)}, 400)
            return self.send_json(manifest)
        if url.path in ('/api/plume/assign', '/api/plume/unassign',
                        '/api/plume/remove-variant', '/api/plume/compile',
                        '/api/plume/assign-b', '/api/plume/remove-b'):
            length = int(self.headers.get('Content-Length', 0))
            try:
                body = json.loads(self.rfile.read(length) or b'{}')
            except Exception as ex:
                return self.send_json({'error': 'bad json body: ' + repr(ex)}, 400)
            try:
                if url.path == '/api/plume/assign':
                    part = body.get('part', '')
                    if part not in part_span:
                        return self.send_json({'error': 'unknown part %r' % (part,)}, 404)
                    info = engine_plume_info(part)
                    if info['case'] != 'A':
                        msg = ('this engine already switches its plume — Phase 3, not yet supported'
                               if info['case'] == 'B'
                               else 'this engine has no Waterfall plume to switch')
                        return self.send_json({'error': msg, 'case': info['case']}, 400)
                    wf_id = body.get('wfModuleID') or (
                        info['wfModules'][0]['moduleID'] if info['wfModules'] else '')
                    manifest = plume_manifest.assign(part, wf_id, body.get('variant', {}))
                elif url.path == '/api/plume/assign-b':
                    part = body.get('part', '')
                    if part not in part_span:
                        return self.send_json({'error': 'unknown part %r' % (part,)}, 404)
                    info = engine_plume_info(part)
                    if info['case'] != 'B':
                        return self.send_json(
                            {'error': 'this engine is not Case B (it does not already switch '
                                      'its plume)', 'case': info['case']}, 400)
                    cb = info.get('caseB') or {}
                    b9_id = body.get('b9ModuleID') or cb.get('b9ModuleID', '')
                    wf_id = body.get('wfModuleID') or cb.get('wfModuleID', '')
                    manifest = plume_manifest.assign_b(
                        part, b9_id, wf_id, body.get('op', ''), body.get('payload', {}))
                elif url.path == '/api/plume/remove-b':
                    manifest = plume_manifest.remove_b(
                        body.get('part', ''), body.get('kind', ''), body.get('key', ''))
                elif url.path == '/api/plume/remove-variant':
                    manifest = plume_manifest.remove_variant(
                        body.get('part', ''), body.get('variant', ''))
                elif url.path == '/api/plume/unassign':
                    manifest = plume_manifest.unassign(body.get('part', ''))
                else:  # /api/plume/compile
                    manifest = plume_manifest.load()
                    mod_names = {t['templateName'] for t in TEMPLATES}
                    part_ctx = {}
                    for part in manifest.get('engines', {}):
                        if part not in part_span:
                            part_ctx[part] = {'case': 'none', 'wfModuleIDs': [], 'b9ModuleIDs': []}
                            continue
                        info = engine_plume_info(part)
                        part_ctx[part] = {
                            'case': info['case'],
                            'wfModuleIDs': [w['moduleID'] for w in info['wfModules']],
                            'b9ModuleIDs': info['b9ModuleIDs'],
                            'caseB': info.get('caseB')}
                    variant_ctx = {}
                    for part in manifest.get('engineVariants', {}):
                        if part in part_span:
                            variant_ctx[part] = engine_variant_info(part)
                    try:
                        summary = plume_compile.compile_all(
                            manifest, mod_names, part_ctx, variant_ctx=variant_ctx)
                    except plume_compile.CompileError as ce:
                        return self.send_json({'ok': False, 'errors': ce.errors}, 400)
                    return self.send_json(summary)
            except plume_manifest.PlumeManifestError as ex:
                return self.send_json({'error': str(ex)}, 400)
            return self.send_json(manifest)
        if url.path == '/api/save_patch':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            fname = os.path.basename(body.get('filename', 'edit.cfg'))
            if not fname.endswith('.cfg'):
                fname += '.cfg'
            outdir = os.path.join(KSP, 'GameData', 'zzzz_EngineEditor')
            os.makedirs(outdir, exist_ok=True)
            path = os.path.join(outdir, fname)
            with open(path, 'w', encoding='utf-8', newline='\n') as f:
                f.write(body.get('content', ''))
            return self.send_json({'saved': 'GameData/zzzz_EngineEditor/' + fname})
        return self.send_json({'error': 'unknown endpoint'}, 404)

    def log_message(self, fmt, *args):
        pass


class V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


if __name__ == '__main__':
    # Threaded (model parsing must not block page loads) and dual-stack:
    # browsers may resolve localhost to ::1 first, so listen on both loopbacks.
    v4 = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    try:
        v6 = V6Server(('::1', PORT), Handler)
        threading.Thread(target=v6.serve_forever, daemon=True).start()
    except OSError as e:
        print(f'(IPv6 loopback unavailable: {e})')
    print(f'Engine Editor at http://localhost:{PORT}')
    v4.serve_forever()
