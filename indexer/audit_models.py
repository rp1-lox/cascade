"""Automated orientation / geometry audit for every engine part.

Reuses muparse for .mu geometry and the running server's /api/part endpoint for the
compiled part config (thrustVectorTransformName, node_stack_*, MODEL{} TRS+rescale).

For each engine it assembles the model exactly as model3d.js buildScene does (in Unity
space: root = T(pos)*Euler(rot)*S(scale*rescale); children T*R(quat)*S; the .mu root's
own TRS is discarded and replaced by the cfg), then computes:
  (a) world +Z direction of the engine's thrust transform  (KSP thrusts along +Z);
  (b) mesh bounding box in assembled (part) space vs node_stack_top/bottom.

Invariants flagged:
  * FLIP_THRUST_UP  : thrust +Z points toward +part-Y (dot(dir,-Y) < -TH) for a
                      vertically-stacked engine  -> upside-down / flipped nozzle.
  * NO_THRUST_XF    : the thrustVectorTransformName is absent from the parsed models.
  * BBOX_NODES_OUT  : stack nodes fall well outside the mesh bbox Y-range.
  * SKINNED_ONLY    : part has skinned-mesh geometry (informational; was invisible
                      before the parser fix).

Usage:  python audit_models.py [--out violations.tsv] [--server http://localhost:8151]
"""
import os, sys, json, csv, math, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import muparse

KSP = os.path.dirname(os.path.dirname(HERE))
GAMEDATA = os.path.join(KSP, 'GameData')
DATA = os.path.join(os.path.dirname(HERE), 'data')
SERVER = 'http://localhost:8151'
TH = 0.25   # thrust-direction dot threshold (cos ~76deg) for "clearly wrong way"


# ---- tiny 4x4 (row-major, M @ column-vector) ------------------------------
def mident():
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]

def mmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]

def mtrans(x, y, z):
    m = mident(); m[0][3] = x; m[1][3] = y; m[2][3] = z; return m

def mscale(x, y, z):
    m = mident(); m[0][0] = x; m[1][1] = y; m[2][2] = z; return m

def mquat(x, y, z, w):
    n = math.sqrt(x*x + y*y + z*z + w*w) or 1.0
    x, y, z, w = x/n, y/n, z/n, w/n
    return [
        [1-2*(y*y+z*z), 2*(x*y-w*z),   2*(x*z+w*y),   0],
        [2*(x*y+w*z),   1-2*(x*x+z*z), 2*(y*z-w*x),   0],
        [2*(x*z-w*y),   2*(y*z+w*x),   1-2*(x*x+y*y), 0],
        [0, 0, 0, 1]]

def meuler(rx_deg, ry_deg, rz_deg):
    rx, ry, rz = [d * math.pi / 180 for d in (rx_deg, ry_deg, rz_deg)]
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    Rx = [[1,0,0,0],[0,cx,-sx,0],[0,sx,cx,0],[0,0,0,1]]
    Ry = [[cy,0,sy,0],[0,1,0,0],[-sy,0,cy,0],[0,0,0,1]]
    Rz = [[cz,-sz,0,0],[sz,cz,0,0],[0,0,1,0],[0,0,0,1]]
    return mmul(mmul(Ry, Rx), Rz)   # Unity Quaternion.Euler: R = Ry*Rx*Rz

def apply_pt(m, v):
    return [m[i][0]*v[0] + m[i][1]*v[1] + m[i][2]*v[2] + m[i][3] for i in range(3)]

def apply_dir(m, v):
    return [m[i][0]*v[0] + m[i][1]*v[1] + m[i][2]*v[2] for i in range(3)]


# ---- config helpers -------------------------------------------------------
def keys(node):
    return dict(node['k'])

def children(node, header):
    return [c for c in node['c'] if c['h'].split(':')[0].strip() == header]

def fetch_part(name):
    url = SERVER + '/api/part?name=' + urllib.parse.quote(name)
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)

def parse_vec(s, default):
    if not s:
        return list(default)
    try:
        a = [float(x) for x in str(s).split(',')]
    except ValueError:
        return list(default)
    return a[:3] if len(a) >= 3 else list(default)


# ---- assembly (mirrors model3d.js buildScene, Unity space) ----------------
def assemble(tree, root_mat, out):
    """Walk parsed .mu tree; record per-transform world matrix and gather mesh verts."""
    def walk(obj, parent, is_root):
        if is_root:
            world = parent
        else:
            T = mtrans(*obj['pos'])
            R = mquat(*obj['rotQuat'])
            S = mscale(*obj['scale'])
            world = mmul(parent, mmul(mmul(T, R), S))
        nm = (obj.get('name') or '').lower()
        if nm and nm not in out['xf']:
            out['xf'][nm] = world
        mesh = obj.get('mesh')
        if mesh and mesh.get('verts'):
            v = mesh['verts']
            for i in range(0, len(v), 3):
                p = apply_pt(world, (v[i], v[i+1], v[i+2]))
                b = out['bbox']
                for k in range(3):
                    if p[k] < b[0][k]: b[0][k] = p[k]
                    if p[k] > b[1][k]: b[1][k] = p[k]
            if obj.get('skinned'):
                out['skinned'] = True
        for c in obj['children']:
            walk(c, world, False)
    walk(tree, root_mat, True)


def audit_part(name, mod):
    part = fetch_part(name)
    node = part['node']
    kv = keys(node)
    try:
        rescale = float(kv.get('rescaleFactor', '1.25'))
    except ValueError:
        rescale = 1.25

    # thrust transform name (first engine module)
    thrust_name = 'thrustTransform'
    for m in children(node, 'MODULE'):
        mn = keys(m).get('name', '')
        if mn in ('ModuleEngines', 'ModuleEnginesFX', 'ModuleEnginesRF'):
            thrust_name = keys(m).get('thrustVectorTransformName', 'thrustTransform') or 'thrustTransform'
            break

    # stack node Y (part space; KSP scales node positions by rescaleFactor)
    stack_y = []
    for kk in ('node_stack_top', 'node_stack_bottom'):
        if kk in kv:
            a = parse_vec(kv[kk], None)
            if a:
                stack_y.append(a[1] * rescale)

    out = {'xf': {}, 'bbox': [[math.inf]*3, [-math.inf]*3], 'skinned': False}
    n_models = 0
    for mn in children(node, 'MODEL'):
        mk = keys(mn)
        rel = (mk.get('model', '') or '').replace('\\', '/').strip()
        if not rel:
            continue
        mu_path = os.path.join(GAMEDATA, *rel.split('/')) + '.mu'
        if not os.path.isfile(mu_path):
            continue
        try:
            res = muparse.parse_file(mu_path)
        except Exception:
            continue
        n_models += 1
        p = parse_vec(mk.get('position', '0,0,0'), [0, 0, 0])
        r = parse_vec(mk.get('rotation', '0,0,0'), [0, 0, 0])
        sc = parse_vec(mk.get('scale', '1,1,1'), [1, 1, 1])
        root = mmul(mmul(mtrans(*p), meuler(*r)),
                    mscale(sc[0]*rescale, sc[1]*rescale, sc[2]*rescale))
        assemble(res['tree'], root, out)

    flags = []
    thrust_dir = None
    tn = thrust_name.lower()
    xf = out['xf'].get(tn)
    # try suffix/partial match if exact absent
    if xf is None:
        for k in out['xf']:
            if k == tn or k.endswith(tn) or tn.endswith(k):
                xf = out['xf'][k]; break
    if xf is not None:
        d = apply_dir(xf, (0, 0, 1))
        ln = math.sqrt(sum(c*c for c in d)) or 1.0
        thrust_dir = [c/ln for c in d]
    elif n_models:
        flags.append('NO_THRUST_XF')

    bbox = out['bbox']
    has_geo = bbox[0][1] != math.inf
    vertically_stacked = len(stack_y) >= 2 and abs(stack_y[0] - stack_y[1]) > 0.05

    if thrust_dir is not None:
        # dot(thrustDir, -Y) should be > 0 (points down). Flip when it points up.
        down = -thrust_dir[1]
        if vertically_stacked and down < -TH:
            flags.append('FLIP_THRUST_UP')

    if has_geo and len(stack_y) >= 2:
        by0, by1 = bbox[0][1], bbox[1][1]
        span = by1 - by0
        margin = 0.5 * span + 1e-6
        lo, hi = min(stack_y), max(stack_y)
        if lo > by1 + margin or hi < by0 - margin:
            flags.append('BBOX_NODES_OUT')
        # GEOM_INVERTED: the true "whole model rendered upside down" signal.
        # node_stack_top is the +Y (upper) attach point, node_stack_bottom the lower.
        # In a correctly assembled model the top node sits in the upper half of the
        # mesh bbox and the bottom node in the lower half. If they are swapped, the
        # geometry itself is flipped relative to the part frame -> genuine bug.
        top_y, bot_y = stack_y[0], stack_y[1]
        mid = 0.5 * (by0 + by1)
        if span > 0.1 and (top_y - bot_y) > 0.1:
            if top_y < mid - 0.15 * span and bot_y > mid + 0.15 * span:
                flags.append('GEOM_INVERTED')

    if out['skinned']:
        flags.append('SKINNED_ONLY')

    return {
        'part': name, 'mod': mod, 'models': n_models,
        'thrust_xf': thrust_name,
        'thrust_dir': None if thrust_dir is None else ','.join('%.3f' % c for c in thrust_dir),
        'bbox_y': '%.2f..%.2f' % (bbox[0][1], bbox[1][1]) if has_geo else '',
        'stack_y': ','.join('%.2f' % y for y in stack_y),
        'flags': '|'.join(flags),
    }


def main():
    out_path = os.path.join(DATA, 'audit_violations.tsv')
    if '--out' in sys.argv:
        out_path = sys.argv[sys.argv.index('--out') + 1]

    parts = []
    with open(os.path.join(DATA, 'engines.tsv'), encoding='utf-8') as f:
        for row in csv.DictReader(f, delimiter='\t'):
            parent = (row.get('parentUrl', '') or '').replace('\\', '/').lstrip('/')
            mod = parent.split('/')[0] if parent else '(root)'
            parts.append((row['part'], mod))

    results = []
    errors = 0
    for i, (name, mod) in enumerate(parts):
        try:
            results.append(audit_part(name, mod))
        except Exception as ex:
            errors += 1
            results.append({'part': name, 'mod': mod, 'models': 0, 'thrust_xf': '',
                            'thrust_dir': None, 'bbox_y': '', 'stack_y': '',
                            'flags': 'ERROR:' + repr(ex)[:60]})
        if (i + 1) % 100 == 0:
            print('  ...%d/%d' % (i + 1, len(parts)), file=sys.stderr)

    cols = ['part', 'mod', 'models', 'thrust_xf', 'thrust_dir', 'bbox_y', 'stack_y', 'flags']
    viols = [r for r in results if r['flags']]
    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter='\t')
        w.writeheader()
        for r in viols:
            w.writerow(r)

    # breakdown
    from collections import Counter
    flagc = Counter()
    modc = Counter()
    for r in viols:
        for fl in r['flags'].split('|'):
            flagc[fl.split(':')[0]] += 1
        modc[r['mod']] += 1
    print('=== AUDIT SUMMARY ===')
    print('parts audited      :', len(results))
    print('parts with any flag:', len(viols))
    print('errors             :', errors)
    print('--- flag counts ---')
    for k, v in flagc.most_common():
        print('  %-16s %d' % (k, v))
    print('--- by mod (any flag) ---')
    for k, v in modc.most_common(25):
        print('  %-30s %d' % (k, v))
    # focus: the true orientation defects (exclude pure SKINNED_ONLY/BBOX info)
    orient = [r for r in viols if 'FLIP_THRUST_UP' in r['flags'] or 'NO_THRUST_XF' in r['flags']]
    print('--- orientation defects (FLIP/NO_THRUST):', len(orient), '---')
    om = Counter(r['mod'] for r in orient)
    for k, v in om.most_common(25):
        print('  %-30s %d' % (k, v))
    print('violations TSV ->', out_path)


if __name__ == '__main__':
    main()
