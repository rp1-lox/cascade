#!/bin/sh
# Cascade launcher (Linux / macOS).
#   ./run.sh          — if you get "Permission denied", run:  chmod +x run.sh
# macOS users: double-click Cascade.command instead (double-clicking .sh does nothing).

cd "$(dirname "$0")" || exit 1

PY=""
for cand in \
    ./python/bin/python3 \
    python3 \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3 \
    /usr/bin/python3 \
    python3.13 python3.12 python3.11 python3.10 python3.9
do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
    if [ -x "$cand" ]; then PY="$cand"; break; fi
done

if [ -z "$PY" ]; then
    echo "ERROR: Python 3 not found."
    echo "  macOS : run 'xcode-select --install', or install from python.org"
    echo "  Linux : install python3 from your package manager (e.g. sudo apt install python3)"
    exit 1
fi

exec "$PY" launch.py
