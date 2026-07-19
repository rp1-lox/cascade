#!/usr/bin/env python3
import re, sys, csv, os
from collections import defaultdict, Counter

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(_HERE), 'data')

# load engines
parts = []
with open(OUT+'/engines.tsv',encoding='utf-8') as f:
    r=csv.DictReader(f,delimiter='\t')
    for row in r: parts.append(row)
partnames = [p['part'] for p in parts]
part_mod = {p['part']: p['parentUrl'].split('/',1)[0] for p in parts}

# load patches
patches=[]
with open(OUT+'/patches.tsv',encoding='utf-8') as f:
    r=csv.DictReader(f,delimiter='\t')
    for row in r: patches.append(row)

def alt_to_regex(sel):
    # split on | and ,
    alts = re.split(r'[|,]', sel)
    pats=[]
    for a in alts:
        a=a.strip()
        if not a: continue
        rx = re.escape(a).replace(r'\*','.*').replace(r'\?','.')
        pats.append(rx)
    if not pats: return None
    return re.compile('^(?:'+'|'.join(pats)+')$', re.I)

# pass rank
def pass_rank(p):
    order=p['passOrder']
    mod = (p['for'] or p['before'] or p['after'] or p['mod']).lower()
    if order=='FIRST': return (0,'','')
    if order=='LEGACY': return (1,'','')
    if order=='BEFORE': return (2,mod,'b')
    if order=='FOR': return (2,mod,'f')
    if order=='AFTER': return (2,mod,'a')
    if order=='LAST': return (3,'','')
    if order=='FINAL': return (4,'','')
    return (1,'','')

# match
part_hits = defaultdict(list)  # part -> list of patch idx
global_patches = []  # broad * patches
mod_patch_targets = Counter()  # (patcher_mod, target_mod) targeted only
patcher_counts = Counter()

for i,p in enumerate(patches):
    sel = p['selector']
    if sel=='' :
        continue
    if sel.strip()=='*':
        global_patches.append(p)
        continue
    # if selector contains * but also literal prefix, still match specifically
    rx = alt_to_regex(sel)
    if rx is None: continue
    # to speed: if no wildcard and simple, do set membership per alt
    matched=[]
    for pn in partnames:
        if rx.match(pn):
            matched.append(pn)
    for pn in matched:
        part_hits[pn].append(i)

# write part_patches.tsv
with open(OUT+'/part_patches.tsv','w',encoding='utf-8') as f:
    f.write('part\tpartMod\tpatchFile\tpatcherMod\top\tpassOrder\tfor\tneeds\tselector\n')
    for pn in partnames:
        hits = part_hits.get(pn,[])
        # sort by pass rank
        hits_sorted = sorted(hits, key=lambda i: pass_rank(patches[i]))
        pmod = part_mod[pn]
        for i in hits_sorted:
            p=patches[i]
            f.write('\t'.join([pn, pmod, p['file'], p['mod'], p['op'], p['passOrder'], p['for'], p['needs'], p['selector']])+'\n')
            pmodfam = p['mod']
            if pmodfam != pmod:
                mod_patch_targets[(pmodfam,pmod)]+=1
            patcher_counts[pmodfam]+=1

# global patches summary
with open(OUT+'/global_patches.tsv','w',encoding='utf-8') as f:
    f.write('file\tmod\top\tpassOrder\tfor\tneeds\trawSelector\n')
    for p in global_patches:
        f.write('\t'.join([p['file'],p['mod'],p['op'],p['passOrder'],p['for'],p['needs'],p['rawSelector']])+'\n')

# aggregates
with open(OUT+'/agg_mod_targets.tsv','w',encoding='utf-8') as f:
    f.write('patcherMod\ttargetPartMod\tcount\n')
    for (a,b),c in mod_patch_targets.most_common():
        f.write(f'{a}\t{b}\t{c}\n')

with open(OUT+'/agg_patcher_counts.tsv','w',encoding='utf-8') as f:
    f.write('patcherMod\ttotalTargetedEnginePatchApplications\n')
    for a,c in patcher_counts.most_common():
        f.write(f'{a}\t{c}\n')

# stats
n_with_hits = sum(1 for pn in partnames if part_hits.get(pn))
n_no_hits = len(partnames)-n_with_hits
sys.stderr.write(f"parts={len(partnames)} withTargetedPatch={n_with_hits} noTargetedPatch={n_no_hits} globalStarPatches={len(global_patches)}\n")
print("DONE")
