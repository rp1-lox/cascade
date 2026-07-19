#!/usr/bin/env python3
"""Build the portable Cascade release zip.

    python build_package.py [--out <path>] [--python-dir <embeddable python dir>]

Assembles: tool source (no per-install index, no user manifest) + the bundled Windows
embeddable Python + launchers, then zips it as `Cascade/...`.

Crucially it writes the zip with Python's zipfile so UNIX PERMISSION BITS are stored —
run.sh / Cascade.command get mode 0o755. PowerShell's Compress-Archive drops those, which
is why macOS/Linux users got "Permission denied" on run.sh.
"""
import argparse
import os
import shutil
import stat
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXEC_SUFFIXES = ('.sh', '.command')

# what ships in the release
FILES = ['server.py', 'launch.py', 'run.bat', 'run.sh', 'Cascade.command', 'README.md']
DIRS = ['indexer', 'web']
DATA_KEEP = ['starter_templates.json']
EMPTY_MANIFEST = '{\n  "version": 1,\n  "templates": {},\n  "engines": {},\n  "engineVariants": {}\n}\n'


def assemble(stage, python_dir):
    root = os.path.join(stage, 'Cascade')
    os.makedirs(os.path.join(root, 'data', 'modelcache'), exist_ok=True)
    for f in FILES:
        src = os.path.join(HERE, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(root, f))
    for d in DIRS:
        shutil.copytree(os.path.join(HERE, d), os.path.join(root, d),
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for f in DATA_KEEP:
        src = os.path.join(HERE, 'data', f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(root, 'data', f))
    # ship a clean manifest, never the developer's own plumes/variants
    with open(os.path.join(root, 'data', 'plume_project.json'), 'w', newline='\n') as fh:
        fh.write(EMPTY_MANIFEST)
    if python_dir and os.path.isdir(python_dir):
        shutil.copytree(python_dir, os.path.join(root, 'python'))
        # embeddable python must see the tool root + indexer on sys.path
        for pth in os.listdir(os.path.join(root, 'python')):
            if pth.endswith('._pth'):
                with open(os.path.join(root, 'python', pth), 'w', newline='\n') as fh:
                    fh.write('python313.zip\n.\n..\n..' + os.sep + 'indexer\n')
    return root


def write_zip(root, stage, out):
    if os.path.exists(out):
        os.remove(out)
    count, execs = 0, []
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d != '__pycache__']
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                arc = os.path.relpath(full, stage).replace(os.sep, '/')
                zi = zipfile.ZipInfo.from_file(full, arc)
                zi.compress_type = zipfile.ZIP_DEFLATED
                mode = 0o755 if fn.endswith(EXEC_SUFFIXES) else 0o644
                zi.external_attr = (mode << 16) | (stat.S_IFREG >> 16)
                with open(full, 'rb') as fh:
                    z.writestr(zi, fh.read())
                count += 1
                if fn.endswith(EXEC_SUFFIXES):
                    execs.append(arc)
    return count, execs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(HERE), 'Cascade-portable.zip'))
    ap.add_argument('--python-dir', default=os.path.join(HERE, 'python'),
                    help='embeddable Python folder to bundle (omit if not present)')
    a = ap.parse_args()
    stage = tempfile.mkdtemp(prefix='cascade-build-')
    try:
        root = assemble(stage, a.python_dir)
        n, execs = write_zip(root, stage, a.out)
        size = os.path.getsize(a.out) / (1024 * 1024)
        print('built: %s' % a.out)
        print('files: %d   size: %.1f MB' % (n, size))
        print('executable-marked (0755): %s' % (', '.join(execs) or 'NONE'))
        bundled = os.path.isdir(os.path.join(root, 'python'))
        print('bundled python: %s' % ('yes' if bundled else 'NO (system python3 required)'))
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    main()
