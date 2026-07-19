"""Scan all raw GameData cfgs for PART patches and extract, per patch, the set of
config paths it touches (writes, deletes, inserts). Output: patch_bodies.tsv

A "touched path" is a slash-joined trail of node selectors ending in a key or node,
with the operation that hits it:
    op  path                                  example source
    W   MODULE[ModuleEnginesFX]/maxThrust     @MODULE[ModuleEnginesFX] { @maxThrust = 2 }
    D   EFFECTS                               !EFFECTS {}
    I   MODULE[ModuleWaterfallFX]             MODULE { name = ModuleWaterfallFX ... }
    R   MODULE[ModuleEnginesFX]/atmosphereCurve   (node replaced wholesale via delete+insert or % )
Keys inside inserted nodes are not enumerated (the insert covers them).
"""
from __future__ import annotations
import os, re, sys
from cfgtree import parse_file

_HERE = os.path.dirname(os.path.abspath(__file__))
KSP = os.path.dirname(os.path.dirname(_HERE))
ROOT = os.path.join(KSP, 'GameData')
OUT = os.path.join(os.path.dirname(_HERE), 'data')

HDR_RE = re.compile(r'^([@+$%!\-&#|]?)([A-Za-z_][\w]*)(\[[^\]]*\])?(.*)$')
PASS_RE = re.compile(r':(FIRST|FINAL|LAST|BEFORE|FOR|AFTER|NEEDS|HAS)(\[[^\]]*\])?', re.I)


def bracket_arg(s, start):
    """s[start] == '['; return (content, index after closing bracket) honoring nesting."""
    depth = 0
    for i in range(start, len(s)):
        if s[i] == '[':
            depth += 1
        elif s[i] == ']':
            depth -= 1
            if depth == 0:
                return s[start + 1:i], i + 1
    return s[start + 1:], len(s)


def parse_header(header):
    m = HDR_RE.match(header.strip())
    if not m:
        return None
    op, ntype, name, _rest = m.groups()
    name = name[1:-1] if name else ''
    tags = {}
    h = header
    pos = 0
    tag_re = re.compile(r':(FIRST|FINAL|LAST|BEFORE|FOR|AFTER|NEEDS|HAS)', re.I)
    while pos < len(h):
        tm = tag_re.search(h, pos)
        if not tm:
            break
        kind = tm.group(1).upper()
        end = tm.end()
        if end < len(h) and h[end] == '[':
            content, after = bracket_arg(h, end)
            tags.setdefault(kind, content)
            pos = after          # skip past the whole bracket — ignores nested tags
        else:
            tags.setdefault(kind, '')
            pos = end
    return op, ntype, name, tags


def node_selector(ntype, name):
    return f"{ntype}[{name}]" if name else ntype


def effective_name(node, name):
    """For inserted nodes with no [name], use the 'name =' key (e.g. MODULE { name = X })."""
    if name:
        return name
    for k, v in node['keys']:
        if k == 'name':
            return v
    return ''


def walk_patch(node, prefix, out):
    """Emit touched paths for a patch node body."""
    for rawk, v in node['keys']:
        k = rawk.strip()
        if not k:
            continue
        op = k[0]
        if op in '@%&|':
            out.append(('W', prefix + '/' + k.lstrip('@%&|').split(',')[0]))
        elif op in '!-':
            out.append(('D', prefix + '/' + k.lstrip('!-').split(',')[0]))
        else:
            out.append(('W', prefix + '/' + k.split(',')[0]))  # plain insert of a value
    for child in node['children']:
        ph = parse_header(child['header'])
        if not ph:
            continue
        op, ntype, name, tags = ph
        name = name.split(',')[0]  # strip index
        sel = node_selector(ntype, effective_name(child, name) if op in ('', '+', '$') else name)
        path = prefix + '/' + sel if prefix else sel
        if op in ('!', '-'):
            out.append(('D', path))
        elif op in ('', '+', '$'):
            out.append(('I', path))
        elif op == '%':
            out.append(('R', path))
            walk_patch(child, path, out)
        else:  # '@' edit — recurse
            walk_patch(child, path, out)


def main():
    rows = []
    nfiles = 0
    for dirpath, _dirnames, filenames in os.walk(ROOT):
        for fn in filenames:
            if not fn.lower().endswith('.cfg'):
                continue
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, ROOT).replace('\\', '/')
            nfiles += 1
            try:
                for top in parse_file(fp):
                    ph = parse_header(top['header'])
                    if not ph:
                        continue
                    op, ntype, name, tags = ph
                    if ntype != 'PART' or op not in '@+$%!-':
                        continue
                    order = ('FIRST' if 'FIRST' in tags else
                             'FINAL' if 'FINAL' in tags else
                             'LAST' if 'LAST' in tags else
                             'BEFORE' if 'BEFORE' in tags else
                             'FOR' if 'FOR' in tags else
                             'AFTER' if 'AFTER' in tags else 'LEGACY')
                    passmod = tags.get('BEFORE') or tags.get('FOR') or tags.get('AFTER') or ''
                    # +/$ = copy: touches apply to the NEW part named by @name in the body
                    new_name = ''
                    if op in ('+', '$'):
                        for k, v in top['keys']:
                            if k.lstrip('@%').strip() == 'name':
                                new_name = v
                                break
                    touched = []
                    if op in ('!', '-'):
                        touched.append(('D', ''))  # whole part deleted
                    else:
                        walk_patch(top, '', touched)
                    for top_op, path in touched:
                        rows.append((rel, rel.split('/', 1)[0], op, name,
                                     order, passmod, tags.get('NEEDS', ''),
                                     tags.get('HAS', ''), top_op, path.lstrip('/'),
                                     new_name))
            except Exception as e:
                sys.stderr.write(f"ERR {rel}: {e}\n")
    os.makedirs(OUT, exist_ok=True)
    with open(OUT + '/patch_bodies.tsv', 'w', encoding='utf-8') as f:
        f.write('file\tmod\top\tselector\tpassOrder\tpassMod\tneeds\thas\ttouchOp\tpath\tnewName\n')
        for r in rows:
            f.write('\t'.join(x.replace('\t', ' ') for x in r) + '\n')
    sys.stderr.write(f"files={nfiles} touch_rows={len(rows)}\n")


if __name__ == '__main__':
    main()
