#!/usr/bin/env python3
import sys, re, io, os

# Portable: derive from this file's location. indexer/ -> tool root -> KSP root.
_HERE = os.path.dirname(os.path.abspath(__file__))
KSP = os.path.dirname(os.path.dirname(_HERE))
CACHE = os.path.join(KSP, 'GameData', 'ModuleManager.ConfigCache')
OUT = os.path.join(os.path.dirname(_HERE), 'data')

# Streaming ConfigNode parser. We build nested dict-ish structure only for UrlConfig top nodes,
# but that could be big. Instead parse one UrlConfig (top-level) at a time into a lightweight tree.

def parse_node(lines, i):
    """lines: list; i points at the '{' line index. Returns (node, next_i).
    node = {'_keys': [(k,v)...], '_children': [(name, node)...]}"""
    node = {'k': [], 'c': []}
    i += 1  # skip '{'
    n = len(lines)
    while i < n:
        line = lines[i]
        s = line.strip()
        if s == '':
            i += 1; continue
        if s == '}':
            return node, i+1
        # is next non-blank line a '{'? then this is a child node name
        if s == '{':
            # anonymous? shouldn't happen at this level
            child, i = parse_node(lines, i)
            node['c'].append(('', child))
            continue
        # peek ahead for '{'
        j = i+1
        while j < n and lines[j].strip() == '':
            j += 1
        if j < n and lines[j].strip() == '{':
            child, ni = parse_node(lines, j)
            node['c'].append((s, child))
            i = ni
            continue
        # key = value
        if '=' in s:
            k, _, v = s.partition('=')
            node['k'].append((k.strip(), v.strip()))
        i += 1
    return node, i

def getval(node, key):
    for k,v in node['k']:
        if k == key:
            return v
    return None

def getvals(node, key):
    return [v for k,v in node['k'] if k == key]

def children(node, name):
    return [c for nm,c in node['c'] if nm == name]

def all_children(node):
    return node['c']

# We'll stream the file, accumulate lines for each top-level UrlConfig block.
import csv

engines = []   # rows
templates_provided = {}  # templateName -> parentUrl (EFFECTTEMPLATE)
template_usage = {}  # templateName -> count

def esc(x):
    if x is None: return ''
    return str(x).replace('\t',' ').replace('\n',' ').replace('\r',' ')

def process_urlconfig(block_lines):
    # block_lines starts at line after 'UrlConfig' i.e. '{' ... matching '}'
    node, _ = parse_node(block_lines, 0)
    parentUrl = getval(node, 'parentUrl')
    # find the single child (the actual node: PART, EFFECTTEMPLATE, etc.)
    for nm, child in node['c']:
        if nm == 'EFFECTTEMPLATE':
            tn = getval(child, 'templateName') or getval(child, 'name')
            # EFFECTTEMPLATE name
            en = getval(child, 'name')
            templates_provided[en or tn or parentUrl] = parentUrl
        if nm == 'PART':
            process_part(child, parentUrl)

def process_part(part, parentUrl):
    pname = getval(part, 'name')
    # modules
    modules = children(part, 'MODULE')
    eng_modules = []
    wf_modules = []
    b9_modules = []
    gimbal = 0
    other_mods = []
    for m in modules:
        mn = getval(m, 'name')
        if mn in ('ModuleEngines','ModuleEnginesFX'):
            eng_modules.append(m)
        elif mn == 'ModuleWaterfallFX':
            wf_modules.append(m)
        elif mn == 'ModuleB9PartSwitch':
            b9_modules.append(m)
        elif mn and 'Gimbal' in mn:
            gimbal += 1
    if not eng_modules:
        return
    engineIDs = []
    maxthrusts = []
    engtypes = []
    for m in eng_modules:
        eid = getval(m, 'engineID') or ''
        engineIDs.append(eid)
        engtypes.append(getval(m,'name'))
        mt = getval(m, 'maxThrust')
        if mt: maxthrusts.append(mt)
    # waterfall
    wf_ids = []
    wf_engineIDs = []
    wf_templates = []
    for w in wf_modules:
        wf_ids.append(getval(w,'moduleID') or '')
        # effects -> EFFECT -> parentID (engineID)? Actually WaterfallFX has 'engineID' key? and EFFECT/TEMPLATE
        eids = getvals(w, 'engineID') + getvals(w,'parentID')
        # templates
        for tnode in children(w, 'TEMPLATE'):
            tnm = getval(tnode,'templateName')
            if tnm:
                wf_templates.append(tnm)
                template_usage[tnm] = template_usage.get(tnm,0)+1
        # also EFFECT children may have parentName referencing engineID
        for eff in children(w,'EFFECT'):
            pid = getval(eff,'parentName')
            if pid: eids.append(pid)
        wf_engineIDs.extend(eids)
    # B9PS
    b9_ids = []
    b9_desc = []
    b9_subtype_count = 0
    b9_override_targets = []  # module names targeted by subtype DATA
    b9_tanktypes = []
    for b in b9_modules:
        b9_ids.append(getval(b,'moduleID') or '')
        d = getval(b,'switcherDescription')
        if d: b9_desc.append(d)
        subs = children(b,'SUBTYPE')
        b9_subtype_count += len(subs)
        for st in subs:
            tt = getval(st,'tankType')
            if tt: b9_tanktypes.append(tt)
            for smod in children(st,'MODULE'):
                # IDENTIFIER tells target
                idf = children(smod,'IDENTIFIER')
                tgt = None
                if idf:
                    tgt = getval(idf[0],'name')
                if not tgt:
                    tgt = getval(smod,'name')
                if tgt:
                    b9_override_targets.append(tgt)
    row = {
        'part': pname,
        'parentUrl': parentUrl,
        'engModuleCount': len(eng_modules),
        'engineTypes': ';'.join(engtypes),
        'engineIDs': ';'.join([e for e in engineIDs if e]),
        'maxThrusts': ';'.join(maxthrusts),
        'gimbalCount': gimbal,
        'wfCount': len(wf_modules),
        'wfModuleIDs': ';'.join([x for x in wf_ids if x]),
        'wfEngineIDs': ';'.join(sorted(set([x for x in wf_engineIDs if x]))),
        'wfTemplates': ';'.join(wf_templates),
        'b9Count': len(b9_modules),
        'b9ModuleIDs': ';'.join([x for x in b9_ids if x]),
        'b9Desc': ';'.join(b9_desc),
        'b9SubtypeCount': b9_subtype_count,
        'b9OverrideTargets': ';'.join(b9_override_targets),
        'b9TankTypes': ';'.join(sorted(set(b9_tanktypes))),
    }
    engines.append(row)

# Stream
def main():
    with open(CACHE, 'r', encoding='utf-8', errors='replace') as f:
        # skip first line patchedNodeCount
        line = f.readline()
        # Now iterate: look for 'UrlConfig' lines at col0
        buf = None
        depth = 0
        collecting = False
        block = []
        for line in f:
            st = line.strip()
            if not collecting:
                if st == 'UrlConfig':
                    collecting = True
                    block = []
                    depth = 0
                    started = False
                continue
            else:
                block.append(line.rstrip('\n'))
                # track depth
                if st == '{':
                    depth += 1
                    started = True
                elif st == '}':
                    depth -= 1
                    if started and depth == 0:
                        # process
                        try:
                            process_urlconfig(block)
                        except Exception as e:
                            sys.stderr.write(f"ERR {e}\n")
                        collecting = False
                else:
                    # count braces inside (rare for lines like 'x = {' ? not in KSP)
                    pass
    # write engines.tsv
    cols = ['part','parentUrl','engModuleCount','engineTypes','engineIDs','maxThrusts','gimbalCount',
            'wfCount','wfModuleIDs','wfEngineIDs','wfTemplates','b9Count','b9ModuleIDs','b9Desc',
            'b9SubtypeCount','b9OverrideTargets','b9TankTypes']
    with open(OUT+'/engines.tsv','w',encoding='utf-8',newline='') as f:
        f.write('\t'.join(cols)+'\n')
        for r in engines:
            f.write('\t'.join(esc(r[c]) for c in cols)+'\n')
    # templates.tsv
    with open(OUT+'/templates.tsv','w',encoding='utf-8') as f:
        f.write('templateName\tprovidedBy_parentUrl\tusageCount\n')
        allnames = set(templates_provided)|set(template_usage)
        for tn in sorted(allnames):
            f.write(f"{esc(tn)}\t{esc(templates_provided.get(tn,''))}\t{template_usage.get(tn,0)}\n")
    sys.stderr.write(f"engines={len(engines)} templates_provided={len(templates_provided)} templates_used={len(template_usage)}\n")

if __name__=='__main__':
    main()
