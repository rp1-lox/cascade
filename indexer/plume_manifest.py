"""Plume Manager manifest — the tool-owned source of truth for custom (EngineEditor-owned)
Waterfall EFFECTTEMPLATEs. Phase 1 only: load/save/mutate data/plume_project.json. Nothing
here ever touches GameData.

Schema (docs/PlumeEditorDesign.md §5c):
{
  "version": 1,
  "templates": { "<customName>": { "base": "<origTemplateName|null>", "tree": {h,k,c} } },
  "engines": {}
}
"""
import json
import os
import re
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'data')
MANIFEST_PATH = os.path.join(DATA, 'plume_project.json')

_NAME_RE = re.compile(r'^[A-Za-z0-9_-]+$')

_EMPTY = {'version': 1, 'templates': {}, 'engines': {}, 'engineVariants': {}}


class PlumeManifestError(Exception):
    pass


def load():
    if not os.path.exists(MANIFEST_PATH):
        return json.loads(json.dumps(_EMPTY))
    with open(MANIFEST_PATH, encoding='utf-8') as f:
        data = json.load(f)
    data.setdefault('version', 1)
    data.setdefault('templates', {})
    data.setdefault('engines', {})
    data.setdefault('engineVariants', {})
    return data


def save(manifest):
    """Atomic pretty-JSON write."""
    os.makedirs(DATA, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix='.plume_project.', suffix='.tmp', dir=DATA)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
            f.write('\n')
        os.replace(tmp_path, MANIFEST_PATH)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    return manifest


def validate_name(name, manifest, mod_template_names, *, allow_existing=None):
    """Raise PlumeManifestError if `name` is not a legal, non-colliding custom template name.
    `allow_existing` may name the current custom template being renamed (skips self-collision)."""
    if not name or not _NAME_RE.match(name):
        raise PlumeManifestError(
            'invalid name %r: use only letters, digits, dashes, underscores' % (name,))
    if name in mod_template_names:
        raise PlumeManifestError('name %r collides with an existing mod template' % (name,))
    if name in manifest['templates'] and name != allow_existing:
        raise PlumeManifestError('name %r collides with an existing custom template' % (name,))


def clone(source_name, new_name, source_tree, mod_template_names):
    """Deep-copy source_tree into manifest.templates[new_name] (base=source_name). Returns manifest."""
    manifest = load()
    validate_name(new_name, manifest, mod_template_names)
    tree = json.loads(json.dumps(source_tree))
    manifest['templates'][new_name] = {'base': source_name, 'tree': tree}
    save(manifest)
    return manifest


def dedupe_name(desired_name, manifest, mod_template_names):
    """Return `desired_name`, or `<desired_name>_2`, `_3`, … — the first that passes
    validate_name (docs/PlumeEditorDesign.md §8.7 fork-endpoint dedupe)."""
    try:
        validate_name(desired_name, manifest, mod_template_names)
        return desired_name
    except PlumeManifestError:
        pass
    n = 2
    while True:
        candidate = '%s_%d' % (desired_name, n)
        try:
            validate_name(candidate, manifest, mod_template_names)
            return candidate
        except PlumeManifestError:
            n += 1


def fork(source_name, desired_name, source_tree, mod_template_names):
    """Like `clone`, but dedupes `desired_name` with a numeric suffix instead of erroring on
    a name collision (docs/PlumeEditorDesign.md §8.7). Returns (actual_name, manifest)."""
    manifest = load()
    actual_name = dedupe_name(desired_name or source_name, manifest, mod_template_names)
    tree = json.loads(json.dumps(source_tree))
    manifest['templates'][actual_name] = {'base': source_name, 'tree': tree}
    save(manifest)
    return actual_name, manifest


def create_blank(new_name, mod_template_names):
    """Create an empty EFFECTTEMPLATE (no EFFECT children) — a from-scratch plume. Returns manifest."""
    manifest = load()
    validate_name(new_name, manifest, mod_template_names)
    tree = {'h': 'EFFECTTEMPLATE', 'k': [['templateName', new_name]], 'c': []}
    manifest['templates'][new_name] = {'base': None, 'tree': tree}
    save(manifest)
    return manifest


def rename(name, new_name, mod_template_names):
    manifest = load()
    if name not in manifest['templates']:
        raise PlumeManifestError('no such custom template %r' % (name,))
    validate_name(new_name, manifest, mod_template_names, allow_existing=name)
    manifest['templates'][new_name] = manifest['templates'].pop(name)
    save(manifest)
    return manifest


def delete(name):
    manifest = load()
    if name not in manifest['templates']:
        raise PlumeManifestError('no such custom template %r' % (name,))
    del manifest['templates'][name]
    save(manifest)
    return manifest


def save_tree(name, tree):
    manifest = load()
    if name not in manifest['templates']:
        raise PlumeManifestError('no such custom template %r' % (name,))
    manifest['templates'][name]['tree'] = tree
    save(manifest)
    return manifest


# ---------------------------------------------------------------------------
# Phase-2: per-engine plume-switch assignments (docs/PlumeEditorDesign.md §5e)
#
#   "engines": {
#     "<partName>": { "case": "A", "wfModuleID": "<the ModuleWaterfallFX moduleID>",
#                     "variants": [ {"name":"Stock"},
#                                   {"name":"<label>", "template":"<customTemplateName>",
#                                    "overrideParentTransform":"thrustTransform",
#                                    "position":"0,0,0", "rotation":"0,0,0", "scale":"1,1,1"} ] }
#   }
# Nothing here touches GameData — that is plume_compile.py, invoked only by an
# explicit /api/plume/compile (the user clicking Compile).
# ---------------------------------------------------------------------------

_VARIANT_NAME_RE = re.compile(r'^[A-Za-z0-9 _-]+$')


def list_engines():
    return load().get('engines', {})


def assign(part, wf_module_id, variant):
    """Add (or replace by name) a plume variant on a Case-A engine.

    `variant` is a dict {name, template, overrideParentTransform, position, rotation, scale}.
    A default "Stock" subtype (no override) is always kept first. Returns the manifest.
    """
    if not part:
        raise PlumeManifestError('missing part name')
    name = (variant or {}).get('name', '').strip()
    if not name or not _VARIANT_NAME_RE.match(name):
        raise PlumeManifestError(
            'invalid variant name %r: use letters, digits, spaces, dashes, underscores' % (name,))
    if name == 'Stock':
        raise PlumeManifestError('"Stock" is the reserved default subtype; pick another label')
    if not (variant or {}).get('template'):
        raise PlumeManifestError('variant is missing a template reference')

    manifest = load()
    eng = manifest['engines'].get(part)
    if not eng:
        eng = {'case': 'A', 'wfModuleID': wf_module_id or '', 'variants': [{'name': 'Stock'}]}
    eng['case'] = 'A'
    eng['wfModuleID'] = wf_module_id or eng.get('wfModuleID', '')
    variants = [v for v in eng.get('variants', []) if v.get('name') != 'Stock']
    # rebuild: Stock first, then existing (minus same-name), then the new one
    kept = [v for v in variants if v.get('name') != name]
    clean_variant = {
        'name': name,
        'template': variant.get('template'),
        'overrideParentTransform': variant.get('overrideParentTransform', '') or '',
        'position': variant.get('position', '0,0,0') or '0,0,0',
        'rotation': variant.get('rotation', '0,0,0') or '0,0,0',
        'scale': variant.get('scale', '1,1,1') or '1,1,1',
    }
    eng['variants'] = [{'name': 'Stock'}] + kept + [clean_variant]
    manifest['engines'][part] = eng
    save(manifest)
    return manifest


def remove_variant(part, variant_name):
    """Remove one variant. If only the Stock default would remain, unassign the engine."""
    manifest = load()
    eng = manifest['engines'].get(part)
    if not eng:
        raise PlumeManifestError('no assignment for part %r' % (part,))
    eng['variants'] = [v for v in eng.get('variants', [])
                       if v.get('name') != variant_name]
    remaining = [v for v in eng['variants'] if v.get('name') != 'Stock']
    if not remaining:
        del manifest['engines'][part]
    else:
        manifest['engines'][part] = eng
    save(manifest)
    return manifest


def unassign(part):
    manifest = load()
    if part in manifest['engines']:
        del manifest['engines'][part]
        save(manifest)
    return manifest


# ---------------------------------------------------------------------------
# Phase-3: Case B — engines that already switch their plume (docs §5f)
#
#   "<part>": { "case":"B", "b9ModuleID":"engineSwitch", "wfModuleID":"F1",
#     "editSubtypes": { "<sub>": { "template":..,"overrideParentTransform":..,
#                                  "position":..,"rotation":..,"scale":.. } },
#     "editBase": { "template":.., ... } | null,
#     "addVariants": [ { "name":"<new>", "copyFrom":"<sub>", "template":.., ...attach } ] }
# ---------------------------------------------------------------------------


def _plume_attach(plume):
    return {
        'template': plume.get('template'),
        'overrideParentTransform': plume.get('overrideParentTransform', '') or '',
        'position': plume.get('position', '0,0,0') or '0,0,0',
        'rotation': plume.get('rotation', '0,0,0') or '0,0,0',
        'scale': plume.get('scale', '1,1,1') or '1,1,1',
    }


def assign_b(part, b9_module_id, wf_module_id, op, payload):
    """Case-B mutation. op is one of:
      'subtype' — retexture an existing subtype's plume (payload: subtype, template, attach…)
      'base'    — edit the base/default plume (payload: template, attach…)
      'variant' — add a new plume variant by copying a subtype (payload: name, copyFrom, template, attach…)
    """
    if not part:
        raise PlumeManifestError('missing part name')
    payload = payload or {}
    manifest = load()
    eng = manifest['engines'].get(part)
    if not eng or eng.get('case') != 'B':
        eng = {'case': 'B', 'b9ModuleID': b9_module_id or '', 'wfModuleID': wf_module_id or '',
               'editSubtypes': {}, 'editBase': None, 'addVariants': []}
    eng['case'] = 'B'
    if b9_module_id:
        eng['b9ModuleID'] = b9_module_id
    if wf_module_id:
        eng['wfModuleID'] = wf_module_id
    eng.setdefault('editSubtypes', {})
    eng.setdefault('editBase', None)
    eng.setdefault('addVariants', [])

    if op == 'subtype':
        sub = (payload.get('subtype', '') or '').strip()
        if not sub:
            raise PlumeManifestError('missing subtype name')
        if not payload.get('template'):
            raise PlumeManifestError('subtype edit is missing a template reference')
        eng['editSubtypes'][sub] = _plume_attach(payload)
    elif op == 'base':
        if not payload.get('template'):
            raise PlumeManifestError('base edit is missing a template reference')
        eng['editBase'] = _plume_attach(payload)
    elif op == 'variant':
        name = (payload.get('name', '') or '').strip()
        if not name or not _VARIANT_NAME_RE.match(name):
            raise PlumeManifestError(
                'invalid variant name %r: use letters, digits, spaces, dashes, underscores' % (name,))
        copy_from = (payload.get('copyFrom', '') or '').strip()
        if not copy_from:
            raise PlumeManifestError('add-variant is missing the subtype to copy (copyFrom)')
        if not payload.get('template'):
            raise PlumeManifestError('add-variant is missing a template reference')
        v = _plume_attach(payload)
        v['name'] = name
        v['copyFrom'] = copy_from
        eng['addVariants'] = [x for x in eng['addVariants'] if x.get('name') != name] + [v]
    else:
        raise PlumeManifestError('unknown Case-B op %r' % (op,))

    manifest['engines'][part] = eng
    save(manifest)
    return manifest


def remove_b(part, kind, key):
    """Remove one Case-B edit. kind: 'subtype' (key=subtypeName), 'base', 'variant' (key=name).
    If nothing remains for the engine, drop the whole assignment."""
    manifest = load()
    eng = manifest['engines'].get(part)
    if not eng:
        raise PlumeManifestError('no assignment for part %r' % (part,))
    if kind == 'subtype':
        eng.get('editSubtypes', {}).pop(key, None)
    elif kind == 'base':
        eng['editBase'] = None
    elif kind == 'variant':
        eng['addVariants'] = [x for x in eng.get('addVariants', []) if x.get('name') != key]
    else:
        raise PlumeManifestError('unknown remove kind %r' % (kind,))
    if not eng.get('editSubtypes') and not eng.get('editBase') and not eng.get('addVariants'):
        del manifest['engines'][part]
    else:
        manifest['engines'][part] = eng
    save(manifest)
    return manifest


# ---------------------------------------------------------------------------
# Phase-4: Engine-config VARIANTS — full new B9PS subtypes with editable
# thrust/ISP/heat/fuel + optional plume (docs/PlumeEditorDesign.md §7).
#
#   "engineVariants": {
#     "<part>": {
#       "b9ModuleID": "<existing engine-aspect B9PS moduleID>" | null,   // null => mint eeEngineSwitch
#       "targetModule": "ModuleEnginesFX" | "ModuleEngines",
#       "subtypes": [ { "name":.., "title":.., "copyFrom":<sub>|null,
#                       "fields": {maxThrust,minThrust,heatProduction,ispCurve:[[k,v],...]},
#                       "addedMass":.., "addedCost":..,
#                       "propellants":[{name,ratio,DrawGauge},...]|null,
#                       "plume": {template,...}|null } ]
#     }
#   }
# Name-collision vs REAL subtypes is enforced at compile lint (needs part ctx), not here.
# ---------------------------------------------------------------------------


def list_engine_variants():
    return load().get('engineVariants', {})


def _clean_variant_subtype(subtype):
    """Normalize an engine-variant subtype dict, keeping only recognized keys."""
    name = (subtype or {}).get('name', '').strip()
    if not name or not _VARIANT_NAME_RE.match(name):
        raise PlumeManifestError(
            'invalid variant name %r: use letters, digits, spaces, dashes, underscores' % (name,))
    if name == 'Stock':
        raise PlumeManifestError('"Stock" is the reserved default subtype; pick another label')
    fields_in = (subtype.get('fields') or {})
    fields = {}
    for k in ('maxThrust', 'minThrust', 'heatProduction'):
        if fields_in.get(k) not in (None, ''):
            fields[k] = str(fields_in.get(k))
    isp = fields_in.get('ispCurve')
    if isp:
        fields['ispCurve'] = [[str(pair[0]), str(pair[1])] for pair in isp]
    else:
        fields['ispCurve'] = []
    copy_from = subtype.get('copyFrom')
    copy_from = copy_from.strip() if isinstance(copy_from, str) and copy_from.strip() else None
    props = subtype.get('propellants')
    if props is None:
        clean_props = None
    else:
        clean_props = []
        for p in props:
            clean_props.append({
                'name': (p.get('name', '') or '').strip(),
                'ratio': str(p.get('ratio', '') or ''),
                'DrawGauge': str(p.get('DrawGauge', '') or ''),
            })
    plume = subtype.get('plume')
    clean_plume = None
    if plume and plume.get('template'):
        clean_plume = {
            'template': plume.get('template'),
            'overrideParentTransform': plume.get('overrideParentTransform', '') or '',
            'position': plume.get('position', '0,0,0') or '0,0,0',
            'rotation': plume.get('rotation', '0,0,0') or '0,0,0',
            'scale': plume.get('scale', '1,1,1') or '1,1,1',
        }
    transforms_in = subtype.get('transforms')
    if transforms_in is None:
        clean_transforms = None
    else:
        clean_transforms = [t.strip() for t in transforms_in if isinstance(t, str) and t.strip()]
    # modelScale: numeric string or '' (§8.2). Backward compat: absent key => ''.
    model_scale = subtype.get('modelScale', '')
    model_scale = str(model_scale).strip() if model_scale not in (None, '') else ''
    return {
        'name': name,
        'title': subtype.get('title', '') or '',
        'copyFrom': copy_from,
        'fields': fields,
        'addedMass': str(subtype.get('addedMass', '') or ''),
        'addedCost': str(subtype.get('addedCost', '') or ''),
        'propellants': clean_props,
        'plume': clean_plume,
        'transforms': clean_transforms,
        'modelScale': model_scale,
    }


def add_engine_variant(part, b9_module_id, target_module, subtype):
    """Add (or replace by name) a full engine-config variant subtype on a part.

    `b9_module_id` is the existing engine-aspect B9PS moduleID, or None => mint eeEngineSwitch.
    `target_module` is 'ModuleEnginesFX' or 'ModuleEngines'. `subtype` is a dict per §7.2.
    Returns the manifest.
    """
    if not part:
        raise PlumeManifestError('missing part name')
    if not target_module:
        raise PlumeManifestError('missing targetModule (ModuleEnginesFX or ModuleEngines)')
    clean = _clean_variant_subtype(subtype or {})

    manifest = load()
    ev = manifest['engineVariants'].get(part)
    if not ev:
        ev = {'b9ModuleID': b9_module_id or None, 'targetModule': target_module, 'subtypes': []}
    ev['b9ModuleID'] = b9_module_id or None
    ev['targetModule'] = target_module
    ev.setdefault('subtypes', [])
    ev['subtypes'] = [s for s in ev['subtypes'] if s.get('name') != clean['name']] + [clean]
    manifest['engineVariants'][part] = ev
    save(manifest)
    return manifest


def remove_engine_variant(part, name):
    """Remove one engine-config variant subtype. If a part has no subtypes left, drop the part key."""
    manifest = load()
    ev = manifest['engineVariants'].get(part)
    if not ev:
        raise PlumeManifestError('no engine variants for part %r' % (part,))
    ev['subtypes'] = [s for s in ev.get('subtypes', []) if s.get('name') != name]
    if not ev['subtypes']:
        del manifest['engineVariants'][part]
    else:
        manifest['engineVariants'][part] = ev
    save(manifest)
    return manifest
