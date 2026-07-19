#!/usr/bin/env python3
"""Waterfall FX asset scraper.

Walks every EFFECTTEMPLATE and every ModuleWaterfallFX (including EFFECT blocks
inlined directly inside a part's MODULE, not just references to a shared
EFFECTTEMPLATE) in the ModuleManager.ConfigCache and inventories every MODEL
`path` (an FX .mu) and every MATERIAL/TEXTURE `texturePath` referenced anywhere
in them. Mods (e.g. Bluedog_DB, Benjee10 add-ons) frequently ship their own FX
assets alongside the bundled Waterfall/FX/* ones, so this surfaces both sets and
flags anything broken (missing file, unparseable .mu).

Streaming ConfigCache parser follows the exact style of indexer/parse_cache.py
(same 'UrlConfig' block-collection loop, same lightweight {'k':[...], 'c':[...]}
node shape) so this script reads naturally next to its sibling indexers.

Output: data/wf_assets.tsv
    path            GameData-relative path as it appears in the cfg (no extension
                     assumed already stripped/added consistently)
    type            model | texture
    referencedBy    count of distinct MODEL/TEXTURE cfg occurrences pointing at it
    exists          y | n  (file found on disk, case-insensitive, trying the
                     extensions the game/viewer actually accept)
    muParses        y | n | n/a   (n/a for textures; muparse.parse_file() success
                     for models)

Usage:  python indexer/scan_wf_assets.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import muparse  # noqa: E402  (.mu binary model parser, for the parses y/n column)

KSP = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.join(KSP, 'GameData', 'ModuleManager.ConfigCache')
GAMEDATA = os.path.join(KSP, 'GameData')
OUT = os.path.join(HERE, '..', 'data')


# ---------------- streaming ConfigNode parser (same shape as parse_cache.py) ----------------
def parse_node(lines, i):
    """lines: list; i points at the '{' line index. Returns (node, next_i).
    node = {'k': [(k,v)...], 'c': [(name, node)...]}"""
    node = {'k': [], 'c': []}
    i += 1  # skip '{'
    n = len(lines)
    while i < n:
        line = lines[i]
        s = line.strip()
        if s == '':
            i += 1
            continue
        if s == '}':
            return node, i + 1
        if s == '{':
            child, i = parse_node(lines, i)
            node['c'].append(('', child))
            continue
        j = i + 1
        while j < n and lines[j].strip() == '':
            j += 1
        if j < n and lines[j].strip() == '{':
            child, ni = parse_node(lines, j)
            node['c'].append((s, child))
            i = ni
            continue
        if '=' in s:
            k, _, v = s.partition('=')
            node['k'].append((k.strip(), v.strip()))
        i += 1
    return node, i


def getval(node, key):
    for k, v in node['k']:
        if k == key:
            return v
    return None


def children(node, name):
    return [c for nm, c in node['c'] if nm == name]


def all_child_nodes(node):
    """Every child node regardless of name (needed since inline EFFECT blocks
    inside ModuleWaterfallFX use the same 'EFFECT' header as EFFECTTEMPLATE's own
    children, but we walk both containers the same way)."""
    return [c for _, c in node['c']]


# ---------------- asset collection ----------------
# path -> {'type': 'model'|'texture', 'count': int}
ASSETS = {}


def record(path, kind):
    if not path:
        return
    path = path.strip().replace('\\', '/').lstrip('/')
    if not path:
        return
    entry = ASSETS.setdefault(path, {'type': kind, 'count': 0})
    entry['count'] += 1


def scan_effect(eff):
    """One EFFECT node: its MODEL/path and every MATERIAL/TEXTURE/texturePath."""
    for model in children(eff, 'MODEL'):
        p = getval(model, 'path')
        if p:
            record(p, 'model')
        for mat in children(model, 'MATERIAL'):
            for tex in children(mat, 'TEXTURE'):
                tp = getval(tex, 'texturePath')
                if tp:
                    record(tp, 'texture')


def scan_effecttemplate(tmpl):
    for eff in children(tmpl, 'EFFECT'):
        scan_effect(eff)


def scan_module_waterfallfx(mod):
    # Templates referenced by name only carry no asset paths of their own (the
    # referenced EFFECTTEMPLATE, wherever it's defined top-level, is scanned via
    # scan_effecttemplate() separately) — but a part's ModuleWaterfallFX can also
    # embed EFFECT blocks directly (inline, no shared EFFECTTEMPLATE), which do
    # carry real MODEL/MATERIAL/TEXTURE data and would otherwise be missed.
    for eff in children(mod, 'EFFECT'):
        scan_effect(eff)
    for tmpl in children(mod, 'TEMPLATE'):
        for eff in children(tmpl, 'EFFECT'):
            scan_effect(eff)


def process_part(part):
    for mod in children(part, 'MODULE'):
        if getval(mod, 'name') == 'ModuleWaterfallFX':
            scan_module_waterfallfx(mod)


def process_urlconfig(block_lines):
    node, _ = parse_node(block_lines, 0)
    for nm, child in node['c']:
        if nm == 'EFFECTTEMPLATE':
            scan_effecttemplate(child)
        elif nm == 'PART':
            process_part(child)


def stream_cache(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        f.readline()  # patchedNodeCount
        collecting = False
        block = []
        depth = 0
        started = False
        for line in f:
            st = line.strip()
            if not collecting:
                if st == 'UrlConfig':
                    collecting = True
                    block = []
                    depth = 0
                    started = False
                continue
            block.append(line.rstrip('\n'))
            if st == '{':
                depth += 1
                started = True
            elif st == '}':
                depth -= 1
                if started and depth == 0:
                    try:
                        process_urlconfig(block)
                    except Exception as e:
                        sys.stderr.write(f"ERR {e}\n")
                    collecting = False


# ---------------- disk resolution ----------------
MODEL_EXT = '.mu'
TEX_EXTS = ('.dds', '.png', '.mbm', '.tga', '.DDS', '.PNG', '.MBM', '.TGA')


def resolve_model(rel):
    rel2 = rel[:-3] if rel.lower().endswith('.mu') else rel
    stem = os.path.normpath(os.path.join(GAMEDATA, *rel2.split('/')))
    if not stem.startswith(os.path.normpath(GAMEDATA)):
        return None
    cand = stem + MODEL_EXT
    if os.path.isfile(cand):
        return cand
    # case-insensitive fallback
    d, bn = os.path.split(stem)
    want = (bn + MODEL_EXT).lower()
    try:
        for fn in os.listdir(d):
            if fn.lower() == want:
                return os.path.join(d, fn)
    except OSError:
        pass
    return None


def resolve_texture(rel):
    root, ext = os.path.splitext(rel)
    if ext.lower() in ('.dds', '.png', '.mbm', '.tga'):
        rel = root
    stem = os.path.normpath(os.path.join(GAMEDATA, *rel.split('/')))
    if not stem.startswith(os.path.normpath(GAMEDATA)):
        return None
    for e in TEX_EXTS:
        cand = stem + e
        if os.path.isfile(cand):
            return cand
    d, bn = os.path.split(stem)
    want = bn.lower()
    try:
        for fn in os.listdir(d):
            r, e = os.path.splitext(fn)
            if r.lower() == want and e.lower() in ('.dds', '.png', '.mbm', '.tga'):
                return os.path.join(d, fn)
    except OSError:
        pass
    return None


def main():
    if not os.path.isfile(CACHE):
        sys.stderr.write(f"ConfigCache not found: {CACHE}\n")
        return 1
    stream_cache(CACHE)

    rows = []
    n_missing = 0
    n_unparseable = 0
    for path in sorted(ASSETS):
        entry = ASSETS[path]
        kind = entry['type']
        if kind == 'model':
            found = resolve_model(path)
            exists = 'y' if found else 'n'
            mu_ok = 'n/a'
            if found:
                try:
                    muparse.parse_file(found)
                    mu_ok = 'y'
                except Exception:
                    mu_ok = 'n'
                    n_unparseable += 1
            else:
                n_missing += 1
        else:
            found = resolve_texture(path)
            exists = 'y' if found else 'n'
            mu_ok = 'n/a'
            if not found:
                n_missing += 1
        rows.append((path, kind, entry['count'], exists, mu_ok))

    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, 'wf_assets.tsv')
    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        f.write('path\ttype\treferencedBy\texists\tmuParses\n')
        for path, kind, count, exists, mu_ok in rows:
            f.write(f"{path}\t{kind}\t{count}\t{exists}\t{mu_ok}\n")

    total = len(rows)
    print(f"total={total} missing={n_missing} unparseable={n_unparseable}")
    if n_missing:
        print("missing assets:")
        for path, kind, count, exists, mu_ok in rows:
            if exists == 'n':
                print(f"  [{kind}] {path}  (referenced {count}x)")
    if n_unparseable:
        print("unparseable .mu models:")
        for path, kind, count, exists, mu_ok in rows:
            if mu_ok == 'n':
                print(f"  {path}  (referenced {count}x)")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
