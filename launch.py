#!/usr/bin/env python3
"""Portable one-shot launcher for the Engine Editor.

Sits in <KSP>/EngineEditor/ and is started by run.bat (Windows) or run.sh (Linux/macOS).
It (1) checks the user's ModuleManager cache exists, (2) indexes their install if needed
(SHA-gated, so it's cheap after the first run), (3) opens the browser, (4) starts the server.

Pure standard library — runs under a bundled embeddable Python (Windows) or the system
python3 (Linux/macOS) with nothing to install.
"""
import os
import sys
import subprocess
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
KSP = os.path.dirname(HERE)
CACHE = os.path.join(KSP, 'GameData', 'ModuleManager.ConfigCache')
URL = 'http://localhost:8151/index.html'


def _pause_exit(code):
    try:
        input('\n  Press Enter to close...')
    except EOFError:
        pass
    sys.exit(code)


def main():
    print('=' * 60)
    print('  KSP Engine Editor')
    print('  KSP install: ' + KSP)
    print('=' * 60)

    if not os.path.isdir(os.path.join(KSP, 'GameData')):
        print('\n  ERROR: no GameData folder next to this tool.')
        print('  Put the EngineEditor folder directly in your KSP root, i.e.')
        print('    <KSP>/EngineEditor/   (alongside <KSP>/GameData/)')
        return _pause_exit(1)

    if not os.path.exists(CACHE):
        print('\n  ERROR: ModuleManager.ConfigCache not found at:')
        print('    ' + CACHE)
        print('\n  Launch KSP once (with ModuleManager installed) so it builds its')
        print('  config cache, then run this again.')
        return _pause_exit(1)

    # 1-2 min on first run; near-instant afterwards (skips when ConfigSHA is unchanged).
    print('\n  Indexing your install (first run can take a minute or two)...\n')
    r = subprocess.run([sys.executable, os.path.join(HERE, 'indexer', 'run_index.py')], cwd=HERE)
    if r.returncode != 0:
        print('\n  ERROR: indexing failed (see messages above).')
        return _pause_exit(1)

    print('\n  Starting the editor at ' + URL)
    print('  Leave this window open while you use it. Close it to stop the server.\n')
    threading.Timer(2.5, lambda: _open_browser()).start()
    subprocess.run([sys.executable, os.path.join(HERE, 'server.py')], cwd=HERE)


def _open_browser():
    try:
        webbrowser.open(URL)
    except Exception:
        pass


if __name__ == '__main__':
    main()
