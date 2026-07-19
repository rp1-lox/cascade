"""One-command indexer for the Engine Editor.

    python run_index.py [--force]

Pipeline (skipped when ModuleManager.ConfigSHA is unchanged since last run):
  1. parse_cache.py        — ConfigCache -> engines.tsv, templates.tsv
  2. scan_patches.py       — raw cfgs -> patches.tsv (selector-level)
  3. match.py              — part x selector matching -> part_patches.tsv + aggregates
  4. scan_patch_bodies.py  — raw cfgs -> patch_bodies.tsv (field-level touches)
  5. provenance.py         — final-writer resolution -> part_provenance.tsv, part_warnings.tsv

The GUI runs this at startup; if ConfigSHA changed (user re-ran KSP after mod changes),
the index rebuilds in ~1-2 minutes.
"""
import hashlib, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLROOT = os.path.dirname(HERE)                 # the EngineEditor folder (whatever it's named)
KSP = os.path.dirname(TOOLROOT)
SHA_FILE = os.path.join(KSP, 'GameData', 'ModuleManager.ConfigSHA')
STAMP = os.path.join(TOOLROOT, 'data', '.index_stamp')

STEPS = ['parse_cache.py', 'scan_patches.py', 'match.py',
         'scan_patch_bodies.py', 'provenance.py']


def current_sha():
    if not os.path.exists(SHA_FILE):
        return 'no-sha-file'
    with open(SHA_FILE, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    force = '--force' in sys.argv
    sha = current_sha()
    if not force and os.path.exists(STAMP):
        with open(STAMP) as f:
            if f.read().strip() == sha:
                print('Index up to date (ConfigSHA unchanged). Use --force to rebuild.')
                return
    os.makedirs(os.path.join(TOOLROOT, 'data'), exist_ok=True)
    for step in STEPS:
        print(f'== {step}')
        r = subprocess.run([sys.executable, os.path.join(HERE, step)], cwd=HERE)
        if r.returncode != 0:
            sys.exit(f'FAILED: {step}')
    with open(STAMP, 'w') as f:
        f.write(sha)
    print('Index rebuilt.')


if __name__ == '__main__':
    main()
