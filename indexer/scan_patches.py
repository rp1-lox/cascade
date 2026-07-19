#!/usr/bin/env python3
import os, re, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
KSP = os.path.dirname(os.path.dirname(_HERE))
ROOT = os.path.join(KSP, 'GameData')
OUT = os.path.join(os.path.dirname(_HERE), 'data')

# selector line: ^\s*[@+$%!-]PART[...]  (top-level only => leading whitespace ignore, but we want
# selectors that target PART. We'll capture any op PART, including within :HAS.
sel_re = re.compile(r'^\s*([@+\$%!\-])PART\b(.*)$')
# pass qualifiers
pass_re = re.compile(r':(FIRST|BEFORE|FOR|AFTER|LAST|FINAL|NEEDS)\[([^\]]*)\]', re.I)
firstfinal_re = re.compile(r':(FIRST|FINAL|LAST)\b', re.I)

rows = []
files = 0
for dirpath, dirnames, filenames in os.walk(ROOT):
    for fn in filenames:
        if not fn.lower().endswith('.cfg'):
            continue
        fp = os.path.join(dirpath, fn)
        rel = os.path.relpath(fp, ROOT).replace('\\','/')
        # skip cache-adjacent
        if 'ModuleManager.ConfigCache' in rel:
            continue
        files += 1
        try:
            with open(fp,'r',encoding='utf-8',errors='replace') as f:
                for lineno, line in enumerate(f, 1):
                    m = sel_re.match(line)
                    if not m:
                        continue
                    op = m.group(1)
                    rest = m.group(2)
                    # the selector name part is between [ ] right after PART, e.g. [name?]
                    # Extract the bracket immediately following PART
                    sel_name = ''
                    if rest.startswith('['):
                        # find matching ]
                        depth=0; end=-1
                        for idx,ch in enumerate(rest):
                            if ch=='[': depth+=1
                            elif ch==']':
                                depth-=1
                                if depth==0:
                                    end=idx; break
                        if end>0:
                            sel_name = rest[1:end]
                    # passes
                    needs = ''
                    forp=beforep=afterp=firstp=lastp=finalp=''
                    for pm in pass_re.finditer(rest):
                        kind=pm.group(1).upper(); val=pm.group(2)
                        if kind=='NEEDS': needs=val
                        elif kind=='FOR': forp=val
                        elif kind=='BEFORE': beforep=val
                        elif kind=='AFTER': afterp=val
                    ff = firstfinal_re.findall(rest)
                    order='LEGACY'
                    up=[x.upper() for x in ff]
                    if 'FIRST' in up: order='FIRST'
                    elif 'FINAL' in up: order='FINAL'
                    elif 'LAST' in up: order='LAST'
                    elif beforep: order='BEFORE'
                    elif forp: order='FOR'
                    elif afterp: order='AFTER'
                    # HAS clause
                    has=''
                    hm=re.search(r':HAS\[(.*?)\](?::|$|\s)', rest)
                    # mod = top folder
                    mod = rel.split('/',1)[0]
                    rows.append((rel, mod, str(lineno), op, sel_name, order, needs, forp, beforep, afterp, rest.strip()))
        except Exception as e:
            sys.stderr.write(f"ERR {fp}: {e}\n")

with open(OUT+'/patches.tsv','w',encoding='utf-8') as f:
    f.write('file\tmod\tline\top\tselector\tpassOrder\tneeds\tfor\tbefore\tafter\trawSelector\n')
    for r in rows:
        f.write('\t'.join(x.replace('\t',' ') for x in r)+'\n')
sys.stderr.write(f"files={files} patch_selectors={len(rows)}\n")
