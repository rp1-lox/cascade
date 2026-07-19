"""Field-level provenance: for every engine part, compute the ordered chain of patch
touches per config path and determine the FINAL WRITER of each path.

Outputs:
  part_provenance.tsv  — part, path, chain length, final writer file/pass/op, full chain
  part_warnings.tsv    — paths whose base-file value is dead (deleted/replaced later),
                         i.e. "don't edit this in the base cfg, it gets overwritten"

NEEDS[] is evaluated against the actual install (GameData dirs, DLLs, :FOR names),
so patches that never ran are excluded — matching what the ConfigCache actually contains.
"""
from __future__ import annotations
import csv, os, re, sys
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
KSP = os.path.dirname(os.path.dirname(_HERE))
GAMEDATA = os.path.join(KSP, 'GameData')
OUT = os.path.join(os.path.dirname(_HERE), 'data')

PASS_RANK = {'FIRST': 0, 'LEGACY': 1, 'BEFORE': 2, 'FOR': 2, 'AFTER': 2, 'LAST': 3, 'FINAL': 4}
SUB_RANK = {'BEFORE': 0, 'FOR': 1, 'AFTER': 2}


def build_mod_names():
    names = set()
    for entry in os.listdir(GAMEDATA):
        p = os.path.join(GAMEDATA, entry)
        if os.path.isdir(p):
            names.add(entry.replace(' ', '').lower())
    for dirpath, _d, files in os.walk(GAMEDATA):
        for fn in files:
            if fn.lower().endswith('.dll'):
                names.add(os.path.splitext(fn)[0].lower())
    return names


def collect_for_names(patch_rows):
    return {r['passMod'].replace(' ', '').lower() for r in patch_rows if r['passMod']}


def needs_ok(expr, mods):
    if not expr:
        return True
    def term_ok(t):
        t = t.strip()
        neg = t.startswith('!')
        if neg:
            t = t[1:]
        t = t.split('/', 1)[0]  # directory tests: check top dir only
        present = t.replace(' ', '').lower() in mods
        return (not present) if neg else present
    # '&' and ',' are AND; '|' is OR; AND binds looser (MM quirk): split by &/, then each group by |
    for group in re.split(r'[&,]', expr):
        if not any(term_ok(alt) for alt in group.split('|') if alt.strip()):
            return False
    return True


def selector_regex(sel):
    alts = [a.strip() for a in re.split(r'[|]', sel) if a.strip()]
    if not alts:
        return None
    pats = [re.escape(a).replace(r'\*', '.*').replace(r'\?', '.') for a in alts]
    return re.compile('^(?:' + '|'.join(pats) + ')$', re.I)


def load_tsv(path):
    with open(path, encoding='utf-8') as f:
        return list(csv.DictReader(f, delimiter='\t'))


def patch_sort_key(row):
    order = row['passOrder']
    rank = PASS_RANK.get(order, 1)
    mod = row['passMod'].replace(' ', '').lower() if rank in (2, 3) else ''
    sub = SUB_RANK.get(order, 0) if rank == 2 else 0
    return (rank, mod, sub, row['file'].lower())


def split_top(expr, seps):
    """Split expr on separator chars at bracket depth 0."""
    parts, depth, cur = [], 0, ''
    for ch in expr:
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
        if ch in seps and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    parts.append(cur)
    return [p for p in parts if p.strip()]


def has_ok(expr, node):
    """Evaluate a :HAS[...] condition list against a parsed node (approximate: uses the
    BASE part state, not mid-patch state). Unknown constructs return True (no false skip)."""
    if not expr or node is None:
        return True
    for cond in split_top(expr, '&,'):
        cond = cond.strip()
        m = re.match(r'^([@!\-#~])([\w*?]+)(?:\[(.*)\])?$', cond, re.S)
        if not m:
            return True  # unparseable — don't filter
        op, ident, arg = m.groups()
        arg = arg or ''
        # nested HAS inside arg: NAME]:HAS[...]  — split it out
        nested = ''
        nm = re.match(r'^(.*?)\]:HAS\[(.*)$', arg, re.S) if ':HAS[' in arg else None
        if nm:
            arg, nested = nm.group(1), nm.group(2)
        if op in ('@', '!', '-'):
            found = False
            for child in node['children']:
                if child['header'].split(':')[0].strip() != ident:
                    continue
                if arg:
                    cname = next((v for k, v in child['keys'] if k == 'name'), '')
                    rx = selector_regex(arg)
                    if not (rx and rx.match(cname)):
                        continue
                if nested and not has_ok(nested, child):
                    continue
                found = True
                break
            if op == '@' and not found:
                return False
            if op in ('!', '-') and found:
                return False
        elif op in ('#', '~'):
            val = next((v for k, v in node['keys'] if k == ident), None)
            if op == '#':
                if val is None:
                    return False
                if arg and not value_match(arg, val):
                    return False
            else:  # ~ absent or mismatched
                if val is not None and (not arg or value_match(arg, val)):
                    return False
    return True


def value_match(pattern, val):
    p = pattern.strip()
    if p and p[0] in '<>':
        try:
            return float(val) < float(p[1:]) if p[0] == '<' else float(val) > float(p[1:])
        except ValueError:
            return False
    rx = selector_regex(p)
    return bool(rx and rx.match(val))


_base_cache = {}


def base_part_node(parent_url, part_name):
    """Parse the part's source cfg and return its PART node, or None."""
    if parent_url not in _base_cache:
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from cfgtree import parse_file
            _base_cache[parent_url] = parse_file(os.path.join(GAMEDATA, parent_url.lstrip('/')))
        except Exception:
            _base_cache[parent_url] = []
    for top in _base_cache[parent_url]:
        h = top['header']
        if h == 'PART' or h.startswith('PART:'):
            for k, v in top['keys']:
                if k == 'name' and v == part_name:
                    return top
    return None


def path_exists_in(node, path):
    """Does slash path (NODE[name]/NODE/key) exist under this parsed node?"""
    if node is None or not path:
        return node is not None
    seg, _, rest = path.partition('/')
    m = re.match(r'^([\w]+)(?:\[(.*)\])?$', seg)
    if not m:
        return True  # can't judge — assume exists (no false negative)
    ntype, name = m.group(1), m.group(2)
    for child in node['children']:
        h = child['header'].split(':')[0].strip()
        if h != ntype:
            continue
        if name:
            cname = next((v for k, v in child['keys'] if k == 'name'), '')
            rx = selector_regex(name)
            if not (rx and rx.match(cname)):
                continue
        if path_exists_in(child, rest) if rest else True:
            return True
    if not rest:  # last segment may be a key
        return any(k.lstrip('@%&|!-').split(',')[0] == seg for k, _v in node['keys'])
    return False


def main():
    engines = load_tsv(OUT + '/engines.tsv')
    bodies = load_tsv(OUT + '/patch_bodies.tsv')
    mods = build_mod_names() | collect_for_names(bodies)

    live = [r for r in bodies if needs_ok(r['needs'], mods)]
    sys.stderr.write(f"patch touch rows: {len(bodies)} total, {len(live)} pass NEEDS\n")

    # +/$ copy patches: their touches belong to the NEW part they create, not the matched source.
    copy_rows = defaultdict(list)
    edit_rows = []
    for r in live:
        if r['op'] in ('+', '$'):
            if r.get('newName'):
                copy_rows[r['newName']].append(r)
        else:
            edit_rows.append(r)

    # group edit rows by (file, selector-instance): one patch block = rows sharing file+selector+order+has
    # then compile selector regexes once
    by_sel = defaultdict(list)
    for r in edit_rows:
        by_sel[(r['selector'], r['file'], r['passOrder'], r['passMod'], r['has'])].append(r)
    compiled = []
    for (sel, file, order, passmod, has), rows in by_sel.items():
        rx = selector_regex(sel)
        if rx:
            compiled.append((rx, rows))

    partnames = [e['part'] for e in engines]
    part_src = {e['part']: e['parentUrl'] for e in engines}

    prov_f = open(OUT + '/part_provenance.tsv', 'w', encoding='utf-8')
    warn_f = open(OUT + '/part_warnings.tsv', 'w', encoding='utf-8')
    prov_f.write('part\tpath\ttouches\tfinalWriterFile\tfinalPass\tfinalOp\tchain\n')
    warn_f.write('part\tpath\treason\tkiller\tkillerPass\n')
    n_warn = 0

    for pn in partnames:
        # copied parts: their source file holds the ORIGINAL part name, not the copy's
        lookup_name = pn
        if pn in copy_rows:
            src_sel = copy_rows[pn][0]['selector']
            if '*' not in src_sel and '?' not in src_sel and '|' not in src_sel:
                lookup_name = src_sel
        base = base_part_node(part_src.get(pn, ''), lookup_name)
        hits = list(copy_rows.get(pn, []))  # the patch that created this part (if a +PART copy)
        for rx, rows in compiled:
            if rx.match(pn):
                if rows and rows[0]['has'] and not has_ok(rows[0]['has'], base):
                    continue
                hits.extend(rows)
        if not hits:
            continue
        hits.sort(key=patch_sort_key)
        # per path: ordered touch chain
        chains = defaultdict(list)
        for r in hits:
            chains[r['path']].append(r)
        for path, chain in sorted(chains.items()):
            final = chain[-1]
            chain_s = ' > '.join(f"{c['file']}({c['passOrder']}:{c['touchOp']})" for c in chain)
            prov_f.write('\t'.join([pn, path, str(len(chain)), final['file'],
                                    final['passOrder'], final['touchOp'], chain_s]) + '\n')
        # warnings: a node D/R-touched by any patch kills the base value AND any earlier writes
        for path, chain in chains.items():
            for i, c in enumerate(chain):
                if c['touchOp'] in ('D', 'R'):
                    # no-op deletions (path never existed in base file) are not warnings
                    if base is not None and not path_exists_in(base, path):
                        break
                    warn_f.write('\t'.join([pn, path or '(whole part)',
                                            'base value dead: node deleted/replaced by patch',
                                            c['file'], c['passOrder']]) + '\n')
                    n_warn += 1
                    break
        # subtree shadowing: writes under a subtree that a LATER patch deletes wholesale
        deletes = [(patch_sort_key(c), c, p) for p, ch in chains.items() for c in ch
                   if c['touchOp'] == 'D' and p]
        for path, chain in chains.items():
            for c in chain:
                if c['touchOp'] not in ('W', 'I'):
                    continue
                ck = patch_sort_key(c)
                for dk, d, dpath in deletes:
                    if dk > ck and path != dpath and path.startswith(dpath + '/'):
                        warn_f.write('\t'.join([pn, path,
                                                f'write in {c["file"]} shadowed: parent {dpath} later deleted',
                                                d['file'], d['passOrder']]) + '\n')
                        n_warn += 1
                        break
                else:
                    continue
                break

    prov_f.close(); warn_f.close()
    sys.stderr.write(f"warnings: {n_warn}\n")


if __name__ == '__main__':
    main()
